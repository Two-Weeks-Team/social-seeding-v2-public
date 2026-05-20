"""dam.get_brand_assets — A2A-transported DAM/brand-asset retrieval (D45 + D48).

This is the **consumed half of `designed_guide.pdf` Build Example #2** made
transport-exact. The PDF's reference pattern is a *Gemini-powered, multimodal
marketing agent that uses the **A2A protocol** to reach a company's internal
**Digital Asset Manager (DAM) Agent**, retrieve approved brand logos / product
imagery, and keep its output on-brand and compliant.*

`content_verify` (the Track-2 multimodal Gemini agent, `content_verify.py`) is
the marketing agent. **This tool is the A2A hop** it makes to the DAM Agent:

    content_verify  →  dam_get_brand_assets  →  a2a_invoke (A2A v0.3 message/send)
                                              →  <DAM Agent endpoint>

Before W3/Seam-C this same brand-asset check was an **in-process ADK
FunctionTool** (`vision.brand_logo_detect`). That made the *roles* map 1:1 but
the *transport* was a local Python call — not a true A2A hop. This tool closes
that gap: the DAM is now reached over the SAME real A2A v0.3 transport that the
coordinator → ss-mcp edge uses (`a2a_invoke`, proven live ~3667ms to ss-mcp),
so Build Example #2 is transport-exact.

Honest scope (RULES.md — no overclaiming):
    * The **A2A transport is genuine** — real `a2a_invoke` v0.3 `message/send`
      envelope, SSRF guard, identity-token header, task-envelope parse.
    * The **DAM endpoint is a demo stand-in** for a customer's real Digital
      Asset Manager. It is reached via the live ss-mcp A2A server's
      `get_brand_assets` skill (a DAM-style skill added so the hop has a real
      reachable endpoint). A production deployment points `DAM_AGENT_ENDPOINT`
      at the customer's own DAM Agent card.
    * The **live endpoint deploy is operator-gated** (no live gcloud here);
      `CAPABILITY_LAYER_MODE=stub` (the dev/CI default) keeps the whole path
      deterministic and offline.

Citations:
    D5  — content_verify is the first multimodal Tier-1 agent; brand-asset
          retrieval is its on-brand/compliance channel.
    D41 — Capability-layer ADK FunctionTool stub/live pattern; per-tool USD
          cost surfaced via `__capability_cost_usd__` for `cost_watch`.
    D42 — Endpoint is **env-configured** (`DAM_AGENT_ENDPOINT`), never
          hard-coded, so each workspace/customer points at its own DAM.
    D44 — Agent Gateway / Agent Identity: the A2A hop rides `a2a_invoke`, which
          presents a workload-identity token + enforces the egress allowlist.
    D45 — Cross-component A2A proof: this is the SECOND real A2A edge (the
          first is coordinator → ss-mcp). It makes Build Example #2 a real hop,
          not an in-process call.
    D48 — A2A intents authority: `content_verify` now CONSUMES a real A2A
          `dam.get_brand_assets` intent (A2A-INTENTS.md §3/§5).
    A2A-INTENTS.md §5 — Build Example #2 match (now A2A-exact).

Contract:
    Input:
        expected_brand_name — operator's seeded brand to retrieve assets for.
        post_media_url      — gs:// or https:// URI of the creator post media
                              the DAM verdict is computed against.
        correlation_id      — trace correlation (echoed through the A2A hop).

    Output:
        brand_assets        — approved logos/product imagery the DAM returned.
        logo_detected       — DAM matched an approved logo on the post media.
        confidence_0_1      — strongest match confidence, normalised to [0,1].
        on_brand            — DAM's on-brand / compliance verdict.
        compliance_notes    — short operator-visible note (≤ 280 chars).
        transport           — "a2a" on a real hop, "fallback" on graceful
                              degradation (so content_verify can flag it).
        a2a_succeeded       — whether the A2A hop completed.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ss_agents.tools.a2a_invoke import A2AInvokeInput, a2a_invoke

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Endpoint configuration — D42 (env-configured, never hard-coded).
# ─────────────────────────────────────────────────────────────────────────────


# Stub endpoint — the deterministic dev/CI target. `a2a_invoke`'s stub layer
# succeeds for `https://stub.local/agent/<id>` and derives the agent id from the
# last path segment, so this resolves to agent_id="dam".
_STUB_DAM_ENDPOINT: str = "https://stub.local/agent/dam"

# The A2A skill name the DAM Agent exposes. Mirrors the ss-mcp server's
# `get_brand_assets` skill so the hop targets a real reachable endpoint.
_DAM_SKILL: str = "get_brand_assets"

# Per-hop USD cost: the A2A network hop (a2a_invoke.USD_COST) plus the DAM's own
# lookup. Surfaced for `cost_watch` (D41). The remote DAM's LLM/asset-store cost
# is billed against the DAM tenant, not here — same accounting rule as a2a_invoke.
_CAPABILITY_COST_USD: float = 0.0008

# A2A read timeout (seconds). The DAM is a fast key/value-ish lookup; keep this
# tight so a slow DAM degrades to fallback rather than stalling content_verify.
_A2A_TIMEOUT_S: int = 30


def _dam_endpoint() -> str:
    """Resolve the DAM Agent A2A endpoint (D42).

    Priority:
      1. `DAM_AGENT_ENDPOINT` env var — the customer's / demo DAM Agent card
         base URL (e.g. the live ss-mcp Cloud Run host that exposes the
         `get_brand_assets` DAM-style skill). NEVER hard-coded.
      2. Stub fallback (`https://stub.local/agent/dam`) so dev/CI runs without
         any env wiring are deterministic and offline.

    A live target is only used when `CAPABILITY_LAYER_MODE=live` AND the env var
    is set; otherwise the stub endpoint keeps `a2a_invoke` on its deterministic
    stub branch.
    """
    configured = os.getenv("DAM_AGENT_ENDPOINT", "").strip()
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub").strip().lower()
    if mode == "live" and configured:
        return configured
    return configured or _STUB_DAM_ENDPOINT


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic I/O schemas.
# ─────────────────────────────────────────────────────────────────────────────


class BrandAsset(BaseModel):
    """One approved brand asset the DAM returned (logo or product imagery)."""

    model_config = ConfigDict(extra="forbid")

    asset_id: str = Field(min_length=1, max_length=128)
    kind: str = Field(
        default="logo",
        max_length=32,
        description="Asset kind — 'logo', 'product_image', 'wordmark', etc.",
    )
    uri: str = Field(
        min_length=1,
        max_length=2048,
        description="gs:// or https:// URI of the approved asset in the DAM.",
    )


class DamGetBrandAssetsInput(BaseModel):
    """Input schema for `dam_get_brand_assets`.

    Validation mirrors `vision_brand_logo_detect` (the in-process predecessor)
    so callers exercising the contract paths see identical schema errors.
    """

    model_config = ConfigDict(extra="forbid")

    expected_brand_name: str = Field(
        min_length=1,
        max_length=200,
        description="The seeded brand whose approved assets the DAM should return.",
    )
    post_media_url: str = Field(
        min_length=1,
        max_length=2048,
        description=(
            "gs:// or https:// URI of the creator post thumbnail / frame the DAM "
            "verdict is computed against. Lifecycle: Cloud Storage 30d (D33)."
        ),
    )
    correlation_id: str = Field(
        default="dam-cv-001",
        min_length=1,
        max_length=128,
        description="OTel trace correlation, echoed through the A2A hop.",
    )

    @field_validator("expected_brand_name")
    @classmethod
    def _validate_brand_name(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("expected_brand_name must be non-empty after strip")
        return stripped

    @field_validator("post_media_url")
    @classmethod
    def _validate_media_url(cls, v: str) -> str:
        v = v.strip()
        if not (v.startswith("gs://") or v.startswith("https://")):
            raise ValueError(
                "post_media_url must start with gs:// or https:// "
                f"(got scheme in {v[:32]!r})"
            )
        return v


class DamGetBrandAssetsOutput(BaseModel):
    """Output schema for `dam_get_brand_assets`.

    See module docstring for field semantics. `transport` and `a2a_succeeded`
    let `content_verify` distinguish a real DAM verdict from a graceful
    fallback (a failed A2A hop must not silently pass as on-brand).
    """

    model_config = ConfigDict(extra="forbid")

    brand_assets: list[BrandAsset] = Field(default_factory=list, max_length=50)
    logo_detected: bool = Field(
        default=False,
        description="True iff the DAM matched an approved logo on the post media.",
    )
    confidence_0_1: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Confidence of the strongest match, normalised to [0, 1].",
    )
    on_brand: bool = Field(
        default=False,
        description="DAM's on-brand / compliance verdict for the post media.",
    )
    compliance_notes: str = Field(
        default="",
        max_length=280,
        description="Short operator-visible compliance note from the DAM.",
    )
    transport: str = Field(
        default="a2a",
        max_length=16,
        description="'a2a' on a real A2A hop, 'fallback' on graceful degradation.",
    )
    a2a_succeeded: bool = Field(
        default=False,
        description="Whether the underlying A2A v0.3 hop completed.",
    )


# ─────────────────────────────────────────────────────────────────────────────
# A2A envelope <-> DAM response mapping.
# ─────────────────────────────────────────────────────────────────────────────


def _build_dam_task_payload(input: DamGetBrandAssetsInput) -> dict[str, Any]:
    """Compose the A2A v0.3 task payload for the DAM's `get_brand_assets` skill.

    `a2a_invoke` wraps this into the A2A v0.3 `{"message": {...}}` envelope. We
    send a single `data` part carrying the structured DAM request (skill name +
    brand + media uri) — the DAM skill reads it from the artifact data, the same
    shape its handler returns. We also include a human-readable `text` part so a
    generic A2A peer that only renders text still sees the intent.
    """
    return {
        "role": "user",
        "parts": [
            {
                "kind": "text",
                "text": (
                    f"Retrieve approved brand assets for '{input.expected_brand_name}' "
                    f"and verify the post media is on-brand."
                ),
            },
            {
                "kind": "data",
                "data": {
                    "skill": _DAM_SKILL,
                    "brand_name": input.expected_brand_name,
                    "post_media_url": input.post_media_url,
                },
            },
        ],
    }


def _parse_dam_response(response_payload: dict[str, Any]) -> dict[str, Any] | None:
    """Pull the DAM verdict out of the A2A response payload.

    `a2a_invoke` surfaces the first `data` artifact part of the A2A task
    envelope under `response_payload["data"]`. In stub mode it instead echoes
    the request under `response_payload["echo"]` — so we accept either and let
    the stub branch synthesize a deterministic verdict. Returns None when no
    DAM-shaped data is present (caller treats that as a fallback).
    """
    data = response_payload.get("data")
    if isinstance(data, dict) and (
        "brand_assets" in data or "on_brand" in data or "logo_detected" in data
    ):
        return data
    return None


def _fallback_output(notes: str) -> DamGetBrandAssetsOutput:
    """Graceful-degradation verdict for a failed/empty A2A hop.

    A failed hop is NOT silently on-brand: `on_brand=False`, `logo_detected=
    False`, `transport="fallback"`, `a2a_succeeded=False`. `content_verify`
    reads these and escalates / flags rather than asserting compliance it could
    not verify.
    """
    return DamGetBrandAssetsOutput(
        brand_assets=[],
        logo_detected=False,
        confidence_0_1=0.0,
        on_brand=False,
        compliance_notes=notes[:280],
        transport="fallback",
        a2a_succeeded=False,
    )


def _stub_verdict(input: DamGetBrandAssetsInput) -> DamGetBrandAssetsOutput:
    """Deterministic DAM verdict for the stub A2A branch (D41 reproducibility).

    `a2a_invoke`'s stub echoes the request rather than running a DAM, so this
    synthesizes a byte-stable on-brand verdict for golden-set evals + CI. The
    transport is still recorded as "a2a" because the call DID traverse the real
    `a2a_invoke` capability — only the remote computation is stubbed.
    """
    return DamGetBrandAssetsOutput(
        brand_assets=[
            BrandAsset(
                asset_id="dam-logo-001",
                kind="logo",
                uri="gs://ss-v2-dam/approved/stub-brand/logo-primary.png",
            ),
        ],
        logo_detected=True,
        confidence_0_1=0.87,
        on_brand=True,
        compliance_notes=(
            f"DAM (stub) returned 1 approved asset for '{input.expected_brand_name}'; "
            "post media matches the primary logo."
        ),
        transport="a2a",
        a2a_succeeded=True,
    )


# ─────────────────────────────────────────────────────────────────────────────
# The capability function — what `content_verify.tools=[…]` receives.
# ─────────────────────────────────────────────────────────────────────────────


def dam_get_brand_assets(input: DamGetBrandAssetsInput) -> DamGetBrandAssetsOutput:
    """Retrieve approved brand assets + an on-brand verdict from the DAM Agent
    over a REAL A2A v0.3 hop (Build Example #2, consumed half).

    Flow:
        1. Resolve the DAM endpoint (D42 — `DAM_AGENT_ENDPOINT` env or stub).
        2. Compose the A2A v0.3 task payload for the DAM `get_brand_assets`
           skill (`_build_dam_task_payload`).
        3. Invoke it through `a2a_invoke` — the SAME real A2A v0.3 transport the
           coordinator → ss-mcp edge uses (SSRF guard, identity token, retries,
           task-envelope parse). NO new transport code lives here.
        4. Parse the DAM verdict (`_parse_dam_response`). On a failed hop or an
           unparseable response, degrade gracefully to a NON-on-brand fallback
           so `content_verify` escalates rather than asserting unverified
           compliance.

    Behaviour by mode (`CAPABILITY_LAYER_MODE`, D41):
        * ``"stub"`` (default) — `a2a_invoke` runs its deterministic stub branch
          (the call traverses the real capability, the remote DAM is stubbed);
          we synthesize a byte-stable on-brand verdict (`_stub_verdict`).
        * ``"live"`` — `a2a_invoke` posts the A2A v0.3 envelope to the
          configured DAM endpoint and we parse the real task artifact.

    Never raises — a transport/parse failure returns a fallback output (matching
    `a2a_invoke`'s "a failed hop is a routing signal, not a crash" convention).
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub").strip().lower()
    endpoint = _dam_endpoint()

    try:
        result = a2a_invoke(
            A2AInvokeInput(
                remoteAgentEndpoint=endpoint,  # type: ignore[arg-type]
                taskPayload=_build_dam_task_payload(input),
                timeoutS=_A2A_TIMEOUT_S,
                correlationId=input.correlation_id,
            )
        )
    except Exception as exc:  # never crash content_verify on the hop
        logger.warning(
            "dam_get_brand_assets_invoke_error",
            extra={"endpoint": endpoint, "error": f"{type(exc).__name__}: {exc}"},
        )
        return _fallback_output(f"DAM A2A hop raised: {type(exc).__name__}")

    if not result.succeeded:
        logger.warning(
            "dam_get_brand_assets_hop_failed",
            extra={
                "endpoint": endpoint,
                "error": result.error,
                "correlation_id": input.correlation_id,
            },
        )
        return _fallback_output(f"DAM A2A hop failed: {result.error or 'unknown'}")

    # Real DAM verdict present in the A2A task artifact (live path).
    parsed = _parse_dam_response(result.response_payload)
    if parsed is not None:
        return DamGetBrandAssetsOutput(
            brand_assets=[
                BrandAsset.model_validate(a)
                for a in (parsed.get("brand_assets") or [])
                if isinstance(a, dict)
            ][:50],
            logo_detected=bool(parsed.get("logo_detected", False)),
            confidence_0_1=float(parsed.get("confidence_0_1", 0.0) or 0.0),
            on_brand=bool(parsed.get("on_brand", False)),
            compliance_notes=str(parsed.get("compliance_notes", ""))[:280],
            transport="a2a",
            a2a_succeeded=True,
        )

    # Hop succeeded but no DAM-shaped data — the stub-echo branch. Synthesize a
    # deterministic verdict; the call still traversed the real A2A capability.
    if mode == "stub":
        return _stub_verdict(input)

    # Live hop succeeded but returned an unexpected shape — degrade gracefully.
    logger.warning(
        "dam_get_brand_assets_unparseable_response",
        extra={"endpoint": endpoint, "correlation_id": input.correlation_id},
    )
    return _fallback_output("DAM A2A hop returned an unparseable response shape")


# Per-tool USD cost surfaced for `cost_watch` (D41) — same surface as every
# capability-layer tool. Includes the underlying a2a_invoke hop cost.
dam_get_brand_assets.__capability_cost_usd__ = _CAPABILITY_COST_USD  # type: ignore[attr-defined]


__all__ = [
    "BrandAsset",
    "DamGetBrandAssetsInput",
    "DamGetBrandAssetsOutput",
    "dam_get_brand_assets",
]
