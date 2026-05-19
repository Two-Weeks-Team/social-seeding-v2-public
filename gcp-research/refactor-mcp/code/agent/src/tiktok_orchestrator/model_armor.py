"""Model Armor sanitization (D21).

Reference: ``gcp-research/model-armor/ARMOR-GATEWAY.md §1.6 path A``
("per-request from your code — the most portable path"). The Agent
Gateway ``CONTENT_AUTHZ`` extension path (§1.6 D) is preview-only as of
2026-05; until it goes GA we keep the explicit wrap at the agent layer so
the audit trail is *guaranteed* (Track 3 Phase 5 §5.4 Enterprise Standards
checks "Model Armor templates wired with ``FAIL_CLOSED``").

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

Stub mode (``MODEL_ARMOR_STUB=1``):
    * Returns ``blocked=False`` and forwards the text unchanged.
    * Tests rely on this; production never sets it.

Failures policy:
    * ``MODEL_ARMOR_FAIL_MODE=closed`` (default) — any client error is
      surfaced as a ``blocked=True`` outcome.
    * ``MODEL_ARMOR_FAIL_MODE=open`` — degrade-open (NOT recommended;
      provided only because the audit playbook explicitly forbids it,
      i.e. the toggle lets us verify the audit *catches* a misconfig).
"""

from __future__ import annotations

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
STUB_MODE = os.environ.get("MODEL_ARMOR_STUB", "").lower() in {"1", "true", "yes"}
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
        client = _get_client()
        from google.cloud import modelarmor_v1  # type: ignore[import-not-found]

        if direction == "prompt":
            req = modelarmor_v1.SanitizeUserPromptRequest(
                name=template, user_prompt_data={"text": text}
            )
            resp = client.sanitize_user_prompt(request=req)
        else:
            req = modelarmor_v1.SanitizeModelResponseRequest(
                name=template, model_response_data={"text": text}
            )
            resp = client.sanitize_model_response(request=req)
    except Exception as exc:  # noqa: BLE001
        logger.error("Model Armor call failed: %s", exc, exc_info=True)
        return _fail_outcome(text, direction, reason=f"client_error:{type(exc).__name__}")

    return _parse_response(resp, text=text, template=template, direction=direction)


def _parse_response(resp: Any, *, text: str, template: str, direction: str) -> SanitizationOutcome:
    """Translate the MA SDK response into a ``SanitizationOutcome``.

    The SDK returns a ``sanitizationResult`` field whose ``filterMatchState``
    is either ``MATCH_FOUND`` (any filter triggered) or ``NO_MATCH_FOUND``.
    The redacted text — if the OUTPUT template is in SANITIZE mode — is
    surfaced as ``sanitizationResult.sanitizedText``.
    """
    result = getattr(resp, "sanitization_result", None) or getattr(resp, "sanitizationResult", None)
    if result is None:
        return _fail_outcome(text, direction, reason="malformed_response")

    matched = getattr(result, "filter_match_state", None) or getattr(
        result, "filterMatchState", None
    )
    matched_str = str(matched) if matched is not None else ""
    blocked = "MATCH_FOUND" in matched_str.upper()

    reasons: list[str] = []
    filter_results = getattr(result, "filter_results", None) or getattr(
        result, "filterResults", []
    )
    try:
        for entry in filter_results or []:
            filter_type = getattr(entry, "filter_type", None) or getattr(
                entry, "filterType", "unknown"
            )
            reasons.append(str(filter_type))
    except TypeError:
        # SDK returned a non-iterable proto map — best-effort summary only.
        reasons.append(matched_str)

    sanitized_text = (
        getattr(result, "sanitized_text", None)
        or getattr(result, "sanitizedText", None)
        or text
    )

    return SanitizationOutcome(
        blocked=blocked,
        text="" if blocked else sanitized_text,
        reasons=reasons or [matched_str],
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
    "SanitizationOutcome",
    "sanitize_prompt",
    "sanitize_response",
    "STUB_MODE",
    "TEMPLATE_INPUT",
    "TEMPLATE_OUTPUT",
    "FAIL_MODE",
]
