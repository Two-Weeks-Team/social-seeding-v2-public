"""ap2_compose_intent_mandate — capability layer per D41.

Compose an AP2 v0.2 **Intent Mandate** draft from an agent's planned action.
Implements the `ap2.compose_intent_mandate` capability declared in
`gcp-research/specs/tier1/payment_mandate.spec.md §6` (ARCHITECTURE.md §3
row 12: `payment_mandate (NEW) | 1 | Gemini 3.1 Flash-Lite |
ap2.compose_intent_mandate, gate.approveOutreachSend | Session |
mandate_validity`).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic in-memory composition. The agent's `replay_token` is the
    primary determinism handle — a known replay_token always yields the same
    `mandate_id` so /goal evaluator + golden tests can pin a stable surface
    across runs (EC-2.29 replay protection is the spec's framing, the stub
    just bakes the same property in at the test-fixture layer).

    Unknown replay_tokens still yield a fresh UUIDv7 keyed by the token's
    SHA-256 timestamp slice — same input → same output forever, no shared
    cross-test state.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real AP2 v0.2 SD-JWT envelope assembly + Cloud KMS signing (wired in W7
    deploy phase per D27 — the KMS key never leaves the operator's WebAuthn
    passkey + Cloud KMS, both of which are out-of-scope for this in-process
    capability). Today raises NotImplementedError; the runtime converts that
    to an `EscalateToHuman` so the workflow routes to the human queue rather
    than silently signing.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern (CAPABILITY_LAYER_MODE).
    D27 — AP2 scope: **Intent Mandate only** — agent plans, human approves payment.
    D40 — `prompt_guard` regex covers particle-rich CJK injection variants per
          BN-9; this tool's `action_payload` would be guarded UPSTREAM by the
          runtime when this capability is invoked from inside an LlmAgent loop.
    payment_mandate.spec.md §6 — Tool table row for `ap2.compose_intent_mandate`.
    BUILD-NOTES.md — UUIDv7 (time-ordered, replay-resistant) is the canonical
        id format for v2 entities; the generator is the one already
        implemented in `ss_agents.agents.payment_mandate.uuidv7`.

Per-call cost: $0.0001 (sub-cent — keeps payment_mandate's $0.01 per-mandate
cap intact even with both tools invoked in a single turn).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ss_agents.agents.payment_mandate import uuidv7

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `ap2_compose_intent_mandate.usd_cost`
for the runtime's `cost_watch` aggregator (D41)."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class Ap2ComposeIntentMandateInput(BaseModel):
    """Capability input. Mirrors payment_mandate.spec.md §6
    (`ap2.compose_intent_mandate`).

    Attributes:
        agent_id:       Stable id of the agent composing the mandate (e.g.
            `payment_mandate`). Carried into the mandate so the audit chain
            shows WHICH agent planned the action (D27 chain-of-custody).
        action_type:    Free-form action token (e.g. `gmail.send`,
            `creator_outreach`). Constrained to lowercase + dots + underscores
            so it round-trips through capability ids cleanly.
        scope:          OAuth-style scope strings (e.g. `["external_send",
            "payment.intent"]`). At least one entry required — empty scope is
            a programming error.
        expires_at:     UTC RFC 3339 timestamp at which the mandate expires.
            Must be tz-aware; tz-naive datetimes are coerced to UTC by the
            validator (defensive — upstream agents sometimes drop tz).
        amount_usd_cap: USD cap the human is being asked to approve. ≥ 0; 0
            allowed for non-spend mandates (e.g. external_send with no cost).
        beneficiary:    Free-text counterparty descriptor — creator handle,
            carrier name, etc. Rendered verbatim in the Mission Control
            approval card (AP2-UX.md §3.2 "Why this Mandate").
        replay_token:   Idempotency token. Same token → same `mandate_id` in
            stub mode (the stub's primary determinism handle). EC-2.29 replay
            protection is a server-side concern in live mode; this field is
            the in-process belt-and-braces.
    """

    model_config = ConfigDict(extra="forbid")

    agent_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_-]*$",
        description="Stable id of the agent composing the mandate.",
    )
    action_type: str = Field(
        min_length=1,
        max_length=128,
        pattern=r"^[a-z][a-z0-9._-]*$",
        description="Lowercase action token (e.g. `gmail.send`).",
    )
    scope: list[str] = Field(
        min_length=1,
        max_length=20,
        description="OAuth-style scope strings; at least one required.",
    )
    expires_at: dt.datetime = Field(
        description="UTC RFC 3339 timestamp at which the mandate expires.",
    )
    amount_usd_cap: float = Field(
        ge=0.0,
        description="USD cap the human is being asked to approve.",
    )
    beneficiary: str = Field(
        min_length=1,
        max_length=200,
        description="Counterparty descriptor.",
    )
    replay_token: str = Field(
        min_length=1,
        max_length=200,
        description="Idempotency token — same value → same mandate_id (stub).",
    )

    @field_validator("expires_at")
    @classmethod
    def _coerce_tz(cls, v: dt.datetime) -> dt.datetime:
        """Coerce tz-naive timestamps to UTC. Defensive — upstream agents
        sometimes hand us naive datetimes despite the schema."""
        if v.tzinfo is None:
            return v.replace(tzinfo=dt.UTC)
        return v

    @field_validator("scope")
    @classmethod
    def _scope_non_empty_strings(cls, v: list[str]) -> list[str]:
        """Each scope entry must be a non-empty trimmed string."""
        cleaned: list[str] = []
        for entry in v:
            if not isinstance(entry, str):
                raise ValueError(f"scope entry must be str, got {type(entry).__name__}")
            stripped = entry.strip()
            if not stripped:
                raise ValueError("scope entries must be non-empty")
            cleaned.append(stripped)
        return cleaned


class Ap2ComposeIntentMandateOutput(BaseModel):
    """Capability output — AP2 v0.2 Intent Mandate dict per the brief.

    Mirrors `payment_mandate.spec.md §2 IntentMandate` (the brief uses a
    flatter shape than the schema's `mandateId`/camelCase; both are valid
    representations of the same AP2 v0.2 surface).
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(default="0.2.0", description="AP2 schema version.")
    mandate_id: str = Field(
        min_length=1,
        max_length=64,
        description="UUIDv7 — time-ordered + replay-resistant (EC-2.29).",
    )
    agent_id: str = Field(min_length=1)
    action_type: str = Field(min_length=1)
    scope: list[str] = Field(min_length=1)
    expires_at: dt.datetime
    amount_usd_cap: float = Field(ge=0.0)
    beneficiary: str = Field(min_length=1)
    replay_token: str = Field(min_length=1)
    created_at: dt.datetime
    signature_placeholder: str = Field(
        min_length=1,
        description=(
            "Stub-mode placeholder — live mode replaces with Cloud KMS-signed "
            "HMAC-SHA256 over the canonicalised payload (D20)."
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Stub state — module-level deterministic ledger, reset between tests via
# the `_reset_stub_state` escape hatch.
# ─────────────────────────────────────────────────────────────────────────────


def _reset_stub_state() -> None:
    """Reset module-level stub state. Used by tests via fixture / `monkeypatch`.

    There is no actual mutable state to clear today (the stub is a pure
    function of its input — `replay_token` is the determinism handle), but
    the symbol is exposed for parity with `forms_upsert._reset_stub_state` so
    test fixtures stay uniform across the capability layer.
    """
    # No-op — the stub is purely a function of its input. Kept for fixture
    # symmetry with `forms_upsert` (D41 canonical pattern).


def _deterministic_uuidv7_for(replay_token: str) -> str:
    """Hash `replay_token` into a stable UUIDv7-ms slice → deterministic id.

    Live mode mints a fresh UUIDv7 per call (EC-2.29). The stub fakes this
    by hashing the replay_token into the 48-bit timestamp slice so the same
    token always produces the same UUIDv7-shaped string. This is NOT a
    secure UUIDv7 — it is a deterministic surrogate for tests + /goal pinning.
    """
    digest = hashlib.sha256(replay_token.encode("utf-8")).digest()
    # Lift 6 bytes (48 bits) from the digest as the synthetic ms slice — this
    # keeps the timestamp prefix stable across calls so the resulting UUIDv7
    # is itself stable for the same token.
    ts_ms = int.from_bytes(digest[:6], byteorder="big")
    # uuidv7 honors `now_ms`; for the same ts the random suffix would still
    # vary, so we synthesize the full UUID directly from the digest bytes to
    # keep determinism end-to-end.
    rand = digest[6:16]  # 10 bytes — same shape as `uuidv7()` random tail.
    b = bytearray(16)
    b[0] = (ts_ms >> 40) & 0xFF
    b[1] = (ts_ms >> 32) & 0xFF
    b[2] = (ts_ms >> 24) & 0xFF
    b[3] = (ts_ms >> 16) & 0xFF
    b[4] = (ts_ms >> 8) & 0xFF
    b[5] = ts_ms & 0xFF
    b[6] = (rand[0] & 0x0F) | 0x70  # version 7
    b[7] = rand[1]
    b[8] = (rand[2] & 0x3F) | 0x80  # variant 0b10
    b[9] = rand[3]
    b[10] = rand[4]
    b[11] = rand[5]
    b[12] = rand[6]
    b[13] = rand[7]
    b[14] = rand[8]
    b[15] = rand[9]
    hexstr = b.hex()
    return f"{hexstr[0:8]}-{hexstr[8:12]}-{hexstr[12:16]}-{hexstr[16:20]}-{hexstr[20:32]}"


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def ap2_compose_intent_mandate(
    payload: Ap2ComposeIntentMandateInput,
) -> Ap2ComposeIntentMandateOutput:
    """Compose an AP2 v0.2 Intent Mandate draft from a planned action.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated `Ap2ComposeIntentMandateInput`.

    Returns:
        `Ap2ComposeIntentMandateOutput` — AP2 v0.2 Intent Mandate dict with
        a deterministic `mandate_id` (in stub mode) keyed by `replay_token`.

    Raises:
        NotImplementedError: If `CAPABILITY_LAYER_MODE=live` — until W7 wires
            the real AP2 SD-JWT envelope + Cloud KMS signer. Caller surfaces
            as `EscalateToHuman`.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
ap2_compose_intent_mandate.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic AP2 mandate composition.
#
# Contract:
#   - Same `replay_token` → SAME `mandate_id` (UUIDv7-shaped, derived from
#     the token's SHA-256 digest).
#   - `created_at` is "now" — the stub does not pretend to freeze time. Tests
#     that need a frozen timestamp use `freezegun` / `monkeypatch` upstream.
#   - `signature_placeholder` is a stable string keyed by mandate_id — never
#     forged to look like a real Cloud KMS signature so audit grep can find
#     stub-origin mandates trivially.
# ─────────────────────────────────────────────────────────────────────────────


_STUB_SIGNATURE_PREFIX: str = "stub-sig://"


def _stub(payload: Ap2ComposeIntentMandateInput) -> Ap2ComposeIntentMandateOutput:
    """Deterministic stub. `replay_token` is the primary determinism handle."""
    mandate_id = _deterministic_uuidv7_for(payload.replay_token)
    created_at = dt.datetime.now(tz=dt.UTC)
    signature = f"{_STUB_SIGNATURE_PREFIX}{mandate_id}"

    logger.info(
        "ap2_compose_intent_mandate_stub",
        extra={
            "mandate_id": mandate_id,
            "agent_id": payload.agent_id,
            "action_type": payload.action_type,
            "replay_token": payload.replay_token,
        },
    )
    return Ap2ComposeIntentMandateOutput(
        schema_version="0.2.0",
        mandate_id=mandate_id,
        agent_id=payload.agent_id,
        action_type=payload.action_type,
        scope=list(payload.scope),
        expires_at=payload.expires_at,
        amount_usd_cap=payload.amount_usd_cap,
        beneficiary=payload.beneficiary,
        replay_token=payload.replay_token,
        created_at=created_at,
        signature_placeholder=signature,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Today raises NotImplementedError; the
# runtime converts that to an `EscalateToHuman` so the workflow routes to the
# human queue rather than crashing.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: Ap2ComposeIntentMandateInput) -> Ap2ComposeIntentMandateOutput:
    """Live AP2 SD-JWT compose + Cloud KMS sign. Wired in W7 deploy phase."""
    # `uuidv7` is imported eagerly so any breakage in the shared generator
    # surfaces at import time rather than at the first live call. We DO NOT
    # invoke it here — `NotImplementedError` is the contract until W7.
    _ = uuidv7  # touch — keeps the import live for static checkers.
    raise NotImplementedError(
        "ap2_compose_intent_mandate live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "Ap2ComposeIntentMandateInput",
    "Ap2ComposeIntentMandateOutput",
    "USD_COST",
    "ap2_compose_intent_mandate",
]
