"""pipa_check_consent — capability layer per D41.

Verify a recipient's PIPA Article 22/23 consent record before any outbound
commercial message reaches `gmail.send`. Implements the `pipa.check_consent`
capability declared in `gcp-research/specs/tier1/compliance.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic ledger lookup. The canonical consent_test address
    `consent_test@2weeks.com` always returns `consent_granted=True` with a
    fixed source + timestamp; every other email returns `consent_granted=False`
    + `requires_re_consent=True`. This shape lets the compliance agent + the
    sourcing → outreach pipeline exercise both branches deterministically.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real Spanner read against `v2_consent_ledger` (D15 OLTP store, CMEK per
    D20). Wired in W7 deploy phase — currently raises NotImplementedError so
    the runtime surfaces a typed escalation rather than silently passing a
    cold-mail-to-KR send through without consent (PIPA 2026 amendment: 10%
    of revenue max fine — false-clear is extreme-severity).

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern (CAPABILITY_LAYER_MODE).
    D20 — CMEK + DLP automatic redaction across stores (the consent ledger
          rows include the recipient_email at rest → CMEK + per-region KMS).
    D22 — PIPA + Marketplace minimal day-1 (PIPA Article 22/23 is REQUIRED
          for any KR-jurisdiction send; SOC2/GDPR deferred).
    compliance.spec.md §6 — tool table row `pipa.check_consent`.
    INSTAGRAM.md §5 — PIPA Article 22 (2026 amendment) max fine = 10% of
          revenue for high-severity violations; treat absent consent on cold
          outreach as a BLOCK, not a soft-warn.

Per-call cost: $0.0001 (single indexed Spanner read; sub-cent so the
compliance agent's $0.03 cap is untouched even on multi-call retries).
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `pipa_check_consent.usd_cost` for
the runtime's `cost_watch` aggregator (D41). Single indexed Spanner read."""


# ─────────────────────────────────────────────────────────────────────────────
# Canonical demo identities. Pinned so `/goal` evaluator + golden tests have a
# stable surface to assert against in stub mode.
# ─────────────────────────────────────────────────────────────────────────────


_DEMO_CONSENT_EMAIL = "consent_test@2weeks.com"
_DEMO_CONSENT_SOURCE = "tiktok_form_2026-04-01"
_DEMO_CONSENT_DATE = "2026-04-01T00:00:00+00:00"
_DEMO_OPT_OUT_URL = "https://app.2weeks.com/u/consent/manage"


ConsentType = Literal["marketing", "transactional", "analytics"]
"""PIPA Article 22 requires GRANULAR consent — each purpose is its own scope.

  - marketing      → cold outreach, promotional sends, newsletter blasts.
  - transactional  → order receipts, shipment ETAs, mandate confirmations.
  - analytics      → behavioral tracking, cohort analysis, A/B telemetry.
"""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class PipaCheckConsentInput(BaseModel):
    """Capability input. Mirrors compliance.spec.md §6 `pipa.check_consent`.

    Attributes:
        recipient_email: The email address whose consent record to look up.
            Light shape-validated (one `@`, non-empty local + domain with `.`)
            — the live impl does the deep MX validation downstream.
        workspace_id: v2 workspace id. Consent is scoped per-workspace; one
            recipient may have consented to workspace_a but not workspace_b.
        consent_type: Which consent scope to verify (PIPA Article 22 requires
            granular per-purpose consent).
    """

    model_config = ConfigDict(extra="forbid")

    recipient_email: str = Field(
        min_length=3,
        max_length=320,
        alias="recipientEmail",
        description="RFC 5321 caps email at 320 chars.",
    )
    workspace_id: str = Field(
        min_length=1,
        max_length=64,
        alias="workspaceId",
    )
    consent_type: ConsentType = Field(alias="consentType")

    @field_validator("recipient_email")
    @classmethod
    def _email_shape(cls, v: str) -> str:
        """Light regex check — exactly one `@`, non-empty local + domain,
        domain has a `.` separator. Matches the shape `gmail.send` expects."""
        if v.count("@") != 1:
            raise ValueError(f"invalid email shape (need exactly one @): {v!r}")
        local, _, domain = v.partition("@")
        if not local or not domain or "." not in domain:
            raise ValueError(f"invalid email shape: {v!r}")
        return v


class PipaCheckConsentOutput(BaseModel):
    """Capability output. Mirrors compliance.spec.md §6 `pipa.check_consent`.

    `consent_granted=True` means PIPA Article 22/23 obligations are satisfied
    for the requested `consent_type` AS OF THIS CALL. Callers MUST NOT cache
    the result — re-check on every send (compliance.spec.md §8 row 6).
    """

    model_config = ConfigDict(extra="forbid")

    consent_granted: bool = Field(alias="consentGranted")
    """Boolean verdict. False ⇒ outbound BLOCKED for KR jurisdiction."""

    consent_date: str | None = Field(
        default=None,
        alias="consentDate",
        max_length=64,
        description="ISO-8601 when consent was captured. None when granted=False.",
    )

    consent_source: str | None = Field(
        default=None,
        alias="consentSource",
        max_length=240,
        description="Operator-visible provenance (e.g. 'tiktok_form_2026-04-01').",
    )

    opt_out_url: str = Field(
        alias="optOutUrl",
        min_length=1,
        max_length=512,
        description=(
            "Always present — even on consent_granted=False the recipient must "
            "have a working link to manage their preferences (PIPA Article 22 §3)."
        ),
    )

    requires_re_consent: bool = Field(alias="requiresReConsent")
    """True when consent is absent OR expired AND a fresh opt-in flow must be
    triggered before any new send. Mirrors PIPA Article 22's "expiry on
    silence" rule (K-CAN-SPAM voids consent after 2 years of dormancy)."""


# ─────────────────────────────────────────────────────────────────────────────
# Tool entry point — D41 stub/live dispatch.
# ─────────────────────────────────────────────────────────────────────────────


def pipa_check_consent(payload: PipaCheckConsentInput) -> PipaCheckConsentOutput:
    """Verify PIPA Article 22/23 consent for a recipient + purpose.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated check request (recipient_email + workspace_id +
            consent_type).

    Returns:
        Consent verdict + provenance + opt-out URL. `consent_granted=True`
        only when the recipient has a valid, unexpired record for the
        requested consent_type.

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


def _stub(payload: PipaCheckConsentInput) -> PipaCheckConsentOutput:
    """Deterministic two-branch stub.

      - `consent_test@2weeks.com` → granted=True with the canonical demo
        source + date.
      - any other recipient → granted=False + requires_re_consent=True.

    The opt-out URL is ALWAYS present (PIPA Article 22 §3 — recipients have
    a right to manage preferences regardless of current consent state).
    """
    recipient_lower = payload.recipient_email.lower()
    logger.debug(
        "pipa_check_consent_stub",
        extra={
            "workspace_id": payload.workspace_id,
            "consent_type": payload.consent_type,
            "recipient_local": recipient_lower.split("@", 1)[0][:6],  # no PII
        },
    )

    if recipient_lower == _DEMO_CONSENT_EMAIL:
        return PipaCheckConsentOutput(
            consentGranted=True,
            consentDate=_DEMO_CONSENT_DATE,
            consentSource=_DEMO_CONSENT_SOURCE,
            optOutUrl=_DEMO_OPT_OUT_URL,
            requiresReConsent=False,
        )

    return PipaCheckConsentOutput(
        consentGranted=False,
        consentDate=None,
        consentSource=None,
        optOutUrl=_DEMO_OPT_OUT_URL,
        requiresReConsent=True,
    )


def _live(payload: PipaCheckConsentInput) -> PipaCheckConsentOutput:
    """Live Spanner consent-ledger read — wired in W7 deploy phase.

    The live path will:
      1. Read `v2_consent_ledger` for (workspace_id, recipient_email,
         consent_type) — CMEK-encrypted at rest per D20.
      2. Apply the expiry rule (K-CAN-SPAM 2-year dormancy void).
      3. Return granted=True only when a non-expired explicit-opt-in row
         exists for the requested consent_type.
      4. Always populate opt_out_url from the workspace settings (PIPA
         Article 22 §3 right-to-manage).
    """
    raise NotImplementedError(
        "pipa_check_consent live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


# Per-invocation cost attribute (D41 pattern).
pipa_check_consent.usd_cost = USD_COST  # type: ignore[attr-defined]


__all__ = [
    "ConsentType",
    "PipaCheckConsentInput",
    "PipaCheckConsentOutput",
    "USD_COST",
    "pipa_check_consent",
]
