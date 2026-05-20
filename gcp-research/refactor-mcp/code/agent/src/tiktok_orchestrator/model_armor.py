# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""Model Armor sanitization (D21) — REAL Google Cloud GA integration.

Reference: ``gcp-research/model-armor/ARMOR-GATEWAY.md §1.6 path A``
("per-request from your code — the most portable path"). The Agent
Gateway ``CONTENT_AUTHZ`` extension path (§1.6 D) is preview-only as of
2026-05; until it goes GA we keep the explicit wrap at the agent layer so
the audit trail is *guaranteed* (Track 3 Phase 5 §5.4 Enterprise Standards
checks "Model Armor templates wired with ``FAIL_CLOSED``").

GA API shape (verified 2026-05 against
https://docs.cloud.google.com/model-armor/sanitize-prompts-responses):

    POST https://modelarmor.{LOCATION}.rep.googleapis.com/v1/
         projects/{P}/locations/{L}/templates/{T}:sanitizeUserPrompt
    POST .../templates/{T}:sanitizeModelResponse

    request   (prompt):   {"userPromptData":   {"text": "<text>"}}
    request   (response): {"modelResponseData": {"text": "<text>"}}
    response: {"sanitizationResult": {
                  "filterMatchState": "MATCH_FOUND" | "NO_MATCH_FOUND",
                  "invocationResult": "SUCCESS",
                  "filterResults": {                # MAP keyed by filter name
                      "rai":             {"raiFilterResult": {...}},
                      "pi_and_jailbreak":{"piAndJailbreakFilterResult":{...}},
                      "malicious_uris":  {"maliciousUriFilterResult":{...}},
                      "sdp":             {"sdpFilterResult":{...}},
                      "csam":            {"csamFilterFilterResult":{...}}}}}

The Python GA client (``google.cloud.modelarmor_v1``) exposes the same shape:
``ModelArmorClient.sanitize_user_prompt(request=SanitizeUserPromptRequest(...))``
returns ``SanitizeUserPromptResponse`` whose ``.sanitization_result`` carries
``.filter_match_state`` + ``.filter_results``.

Policy (D21):
    * **Prompt injection / jailbreak**:   ENABLED, MEDIUM_AND_ABOVE
    * **RAI default**:                    HATE, HARASSMENT, DANGEROUS,
                                          SEXUALLY_EXPLICIT @ MEDIUM_AND_ABOVE
    * **PII block (input)**:              CC, SSN, GCP_API_KEY, PASSWORD,
                                          EMAIL, PHONE (via SDP inspect template)
    * **PII redact (output)**:            EMAIL, PHONE replaced with info-type
                                          tags (via SDP de-identify template)
    * **Custom regex**:                   brand_handle, competitor_handle,
                                          influencer_id ``INF-\\d{8}``
    * **Fail mode**:                      ``FAIL_CLOSED`` — if MA itself
                                          errors, the call is *blocked*, not
                                          silently passed.

This module exposes two coroutines that the agent core calls before *every*
prompt sent to Gemini and after *every* response received:

    sanitize_prompt(text)      -> SanitizationOutcome
    sanitize_response(text)    -> SanitizationOutcome

Each returns a ``SanitizationOutcome`` with ``blocked: bool``, ``reasons:
list[str]``, and the maybe-redacted ``text``. The orchestrator (agent.py)
short-circuits and emits a structured refusal whenever ``blocked is True``.

Mode gate (``MODEL_ARMOR_MODE``, default ``stub``):
    * ``stub``  — offline/CI default. The custom-regex pre-filter still runs
      (defence-in-depth), then the text is forwarded unchanged. No network.
    * ``live``  — REAL GA ``sanitizeUserPrompt`` / ``sanitizeModelResponse``
      call. **Operator-gated**: requires an operator-provisioned Model Armor
      template (``MODEL_ARMOR_INPUT_TEMPLATE`` / ``..._OUTPUT_TEMPLATE``) +
      Application Default Credentials (ADC). See README "Going live (operator
      step)". We do NOT claim layered enforcement is live unless the operator
      runs it; the in-process custom-regex / prompt_guard layer stays the
      belt-and-braces.

    The legacy ``MODEL_ARMOR_STUB=1`` toggle is still honoured (it forces
    ``stub``) for backward compatibility with existing CI / conftest.

Failures policy:
    * ``MODEL_ARMOR_FAIL_MODE=closed`` (default) — any client error is
      surfaced as a ``blocked=True`` outcome.
    * ``MODEL_ARMOR_FAIL_MODE=open`` — degrade-open (NOT recommended;
      provided only because the audit playbook explicitly forbids it,
      i.e. the toggle lets us verify the audit *catches* a misconfig).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
REGION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
TEMPLATE_INPUT = os.environ.get(
    "MODEL_ARMOR_INPUT_TEMPLATE",
    f"projects/{PROJECT_ID}/locations/{REGION}/templates/ss-input" if PROJECT_ID else "",
)
TEMPLATE_OUTPUT = os.environ.get(
    "MODEL_ARMOR_OUTPUT_TEMPLATE",
    f"projects/{PROJECT_ID}/locations/{REGION}/templates/ss-output" if PROJECT_ID else "",
)

# Mode gate. ``MODEL_ARMOR_MODE`` is the canonical control:
#   * "stub" (default) — offline/CI; custom-regex pre-filter only, no network.
#   * "live"           — REAL GA sanitize call (operator template + ADC).
# Legacy ``MODEL_ARMOR_STUB=1`` is still honoured and forces "stub" so existing
# CI / conftest keep working unchanged.
_LEGACY_STUB = os.environ.get("MODEL_ARMOR_STUB", "").lower() in {"1", "true", "yes"}
MODE = "stub" if _LEGACY_STUB else os.environ.get("MODEL_ARMOR_MODE", "stub").lower()
STUB_MODE = MODE != "live"  # back-compat alias; tests monkeypatch this directly
FAIL_MODE = os.environ.get("MODEL_ARMOR_FAIL_MODE", "closed").lower()  # closed | open

# Per ARMOR-GATEWAY.md §1.7: custom regex set we always apply locally as a
# pre-filter — kept here so even in stub mode (tests) we still catch the
# obvious leakage cases. Production Model Armor template carries the same
# patterns server-side; this is defence-in-depth.
_CUSTOM_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("gcp_api_key", re.compile(r"AIza[0-9A-Za-z\-_]{35}")),
    ("aws_access_key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("influencer_id", re.compile(r"\bINF-\d{8}\b")),
    ("backend_password", re.compile(r"BACKEND_DASHBOARD_PASSWORD")),
    ("private_key_block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
]


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class SanitizationOutcome:
    blocked: bool
    text: str
    reasons: list[str] = field(default_factory=list)
    template: str = ""
    direction: str = ""  # "prompt" | "response"
    raw: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Lazy client
# ---------------------------------------------------------------------------

_client: Any = None


def _get_client() -> Any:
    global _client
    if _client is not None:
        return _client
    try:
        from google.cloud import modelarmor_v1  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "google-cloud-modelarmor is not installed; either pip install it "
            "or set MODEL_ARMOR_STUB=1 for stub mode."
        ) from exc

    # Regional endpoint (ARMOR-GATEWAY.md §1.6 path A).
    api_endpoint = f"modelarmor.{REGION}.rep.googleapis.com"
    _client = modelarmor_v1.ModelArmorClient(
        client_options={"api_endpoint": api_endpoint}
    )
    return _client


# ---------------------------------------------------------------------------
# Custom-regex pre-filter
# ---------------------------------------------------------------------------


def _scan_custom_patterns(text: str) -> list[str]:
    """Return the names of every custom pattern that fires on ``text``."""
    hits: list[str] = []
    for name, pattern in _CUSTOM_PATTERNS:
        if pattern.search(text):
            hits.append(name)
    return hits


# ---------------------------------------------------------------------------
# Public coroutines
# ---------------------------------------------------------------------------


async def sanitize_prompt(text: str) -> SanitizationOutcome:
    """Run MA's INPUT template against a prompt before sending it to Gemini.

    INPUT template is ``INSPECT_AND_BLOCK`` (ARMOR-GATEWAY.md §1.7 step 4) —
    nothing PII / jailbreak / injection-shaped is allowed through.
    """
    return await _sanitize(text, direction="prompt", template=TEMPLATE_INPUT)


async def sanitize_response(text: str) -> SanitizationOutcome:
    """Run MA's OUTPUT template against a model response.

    OUTPUT template is ``INSPECT_AND_BLOCK`` for jailbreak/RAI and
    ``SANITIZE`` for PII — emails/phones get redacted to info-type tags
    (ARMOR-GATEWAY.md §1.7 step 5). The redacted body is the one that
    propagates downstream.
    """
    return await _sanitize(text, direction="response", template=TEMPLATE_OUTPUT)


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------


async def _sanitize(text: str, *, direction: str, template: str) -> SanitizationOutcome:
    custom_hits = _scan_custom_patterns(text)
    if custom_hits:
        # Pre-filter blocked: don't even send the text to MA — we already
        # know we won't allow it through. This keeps secrets out of the
        # MA audit log too.
        return SanitizationOutcome(
            blocked=True,
            text="",
            reasons=[f"custom_regex:{name}" for name in custom_hits],
            template=template,
            direction=direction,
        )

    if STUB_MODE:
        return SanitizationOutcome(
            blocked=False,
            text=text,
            reasons=["stub_mode"],
            template=template or "stub",
            direction=direction,
        )

    if not template:
        return _fail_outcome(text, direction, reason="template_not_configured")

    try:
        resp = await asyncio.to_thread(_call_live, text, direction=direction, template=template)
    except Exception as exc:
        logger.error("Model Armor call failed: %s", exc, exc_info=True)
        return _fail_outcome(text, direction, reason=f"client_error:{type(exc).__name__}")

    return _parse_response(resp, text=text, template=template, direction=direction)


def _build_request(text: str, *, direction: str, template: str) -> Any:
    """Build the GA SanitizeUserPrompt/ModelResponse request.

    The request envelope matches the GA REST shape verified against the doc:
        prompt:   {"name": <template>, "userPromptData":   {"text": <text>}}
        response: {"name": <template>, "modelResponseData": {"text": <text>}}

    The GA Python client wraps the inner ``{"text": ...}`` in a ``DataItem``
    proto; passing the dict is accepted by the proto-plus constructor and keeps
    this layer independent of the exact proto class name across client minors.
    """
    from google.cloud import modelarmor_v1  # type: ignore[import-not-found]

    if direction == "prompt":
        return modelarmor_v1.SanitizeUserPromptRequest(
            name=template, user_prompt_data={"text": text}
        )
    return modelarmor_v1.SanitizeModelResponseRequest(
        name=template, model_response_data={"text": text}
    )


def _call_live(text: str, *, direction: str, template: str) -> Any:
    """Synchronous GA call (run in a thread by ``_sanitize``).

    Isolated so tests can monkeypatch this single seam to inject a mocked GA
    response without touching the network — there is no real HTTP/gRPC in CI.
    """
    client = _get_client()
    req = _build_request(text, direction=direction, template=template)
    if direction == "prompt":
        return client.sanitize_user_prompt(request=req)
    return client.sanitize_model_response(request=req)


# Map of GA ``filterResults`` keys → human-readable reason names. The GA
# response keys ``filterResults`` by filter name (NOT a list); each value is a
# wrapper proto whose nested ``*FilterResult`` carries that filter's own
# ``matchState``. We surface the names of the filters that actually matched.
_GA_FILTER_KEYS: tuple[str, ...] = (
    "pi_and_jailbreak",
    "sdp",
    "malicious_uris",
    "rai",
    "csam",
)


def _coerce_match_state(value: Any) -> str:
    """Normalize a proto enum / string match-state into an upper-case string."""
    if value is None:
        return ""
    # proto-plus enums stringify as e.g. "FilterMatchState.MATCH_FOUND".
    return str(getattr(value, "name", value)).upper()


def _is_match_found(state: str) -> bool:
    """True only for an actual MATCH_FOUND.

    NB: a plain substring test is WRONG — ``"MATCH_FOUND" in "NO_MATCH_FOUND"``
    is True. We require the state to end with ``MATCH_FOUND`` *and* not be
    ``NO_MATCH_FOUND`` (which is the explicit "clean" verdict).
    """
    if not state or "NO_MATCH_FOUND" in state:
        return False
    return state.endswith("MATCH_FOUND")


def _filter_matched(node: Any) -> bool:
    """Best-effort: does this nested filter-result node report MATCH_FOUND?

    Walks one or two levels deep (``rai`` nests under ``raiFilterResult``,
    ``sdp`` under ``sdpFilterResult.inspectResult``) looking for any
    ``matchState`` / ``match_state`` that is MATCH_FOUND.
    """
    if node is None:
        return False
    for attr in ("match_state", "matchState"):
        state = _coerce_match_state(getattr(node, attr, None))
        if _is_match_found(state):
            return True
    # Descend through the single wrapper proto fields that the GA shape uses.
    for attr in (
        "rai_filter_result",
        "pi_and_jailbreak_filter_result",
        "malicious_uri_filter_result",
        "csam_filter_filter_result",
        "sdp_filter_result",
        "inspect_result",
    ):
        child = getattr(node, attr, None)
        if child is not None and _filter_matched(child):
            return True
    return False


def _extract_matched_filters(filter_results: Any) -> list[str]:
    """Return the names of GA filters that matched.

    Handles the GA map shape (proto-plus ``MapComposite`` / dict keyed by
    filter name) and degrades for non-mapping shapes.
    """
    reasons: list[str] = []
    if filter_results is None:
        return reasons
    # proto-plus map and plain dict both support ``.items()``.
    items = getattr(filter_results, "items", None)
    if callable(items):
        try:
            for key, node in filter_results.items():
                if _filter_matched(node):
                    reasons.append(f"filter:{key}")
        except (TypeError, AttributeError):
            pass
    return reasons


def _parse_response(resp: Any, *, text: str, template: str, direction: str) -> SanitizationOutcome:
    """Translate the GA Model Armor response into a ``SanitizationOutcome``.

    The GA response carries a ``sanitizationResult`` whose ``filterMatchState``
    is either ``MATCH_FOUND`` (any filter triggered) or ``NO_MATCH_FOUND``.
    ``filterResults`` is a MAP keyed by filter name (``pi_and_jailbreak``,
    ``sdp``, ``rai``, ``malicious_uris``, ``csam``); we surface the names of
    the filters that actually matched as ``reasons``. The redacted text — if
    the OUTPUT template is in SANITIZE mode — is surfaced as
    ``sanitizationResult.sanitizedText``.
    """
    result = getattr(resp, "sanitization_result", None)
    if result is None:
        result = getattr(resp, "sanitizationResult", None)
    if result is None:
        return _fail_outcome(text, direction, reason="malformed_response")

    matched = getattr(result, "filter_match_state", None)
    if matched is None:
        matched = getattr(result, "filterMatchState", None)
    matched_str = _coerce_match_state(matched)
    blocked = _is_match_found(matched_str)

    filter_results = getattr(result, "filter_results", None)
    if filter_results is None:
        filter_results = getattr(result, "filterResults", None)
    reasons = _extract_matched_filters(filter_results)

    sanitized_text = (
        getattr(result, "sanitized_text", None)
        or getattr(result, "sanitizedText", None)
        or text
    )

    return SanitizationOutcome(
        blocked=blocked,
        text="" if blocked else sanitized_text,
        reasons=reasons or [matched_str or "match_state_unknown"],
        template=template,
        direction=direction,
        raw={"match_state": matched_str},
    )


def _fail_outcome(text: str, direction: str, *, reason: str) -> SanitizationOutcome:
    """Map an MA failure to the configured fail mode (default FAIL_CLOSED)."""
    if FAIL_MODE == "open":
        logger.warning("MODEL_ARMOR FAIL_MODE=open — degrade-open used (reason=%s)", reason)
        return SanitizationOutcome(
            blocked=False,
            text=text,
            reasons=[reason, "fail_open_degraded"],
            template="",
            direction=direction,
        )
    return SanitizationOutcome(
        blocked=True,
        text="",
        reasons=[reason, "fail_closed"],
        template="",
        direction=direction,
    )


__all__ = [
    "FAIL_MODE",
    "MODE",
    "STUB_MODE",
    "TEMPLATE_INPUT",
    "TEMPLATE_OUTPUT",
    "SanitizationOutcome",
    "sanitize_prompt",
    "sanitize_response",
]
