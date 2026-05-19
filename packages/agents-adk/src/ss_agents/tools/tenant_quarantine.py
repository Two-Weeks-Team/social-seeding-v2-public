"""tenant_quarantine — capability layer per D41 + D10 allow-list.

Identity Platform tenant quarantine for the security_watch (W3) watchdog.
Implements the `tenant.quarantine` capability declared in
`gcp-research/specs/tier3/security_watch.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic quarantine-id minting. The stub mirrors the live path
    contract exactly so the security_watch agent's tool-call shape is
    identical between dev/CI and prod. NO Identity Platform call is
    made — the stub is purely for testing the decision flow.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real Identity Platform tenant suspension. Wired in W7 deploy phase.
    Today raises NotImplementedError AFTER the demo-safety guardrail
    checks (so an operator-allowlist violation fails LOUD before the
    "not implemented" message ever fires).

Demo-safety contract (this tool's contribution to D10):
    The `operator_user_id` field must match the D10 operator allow-list
    in LIVE mode — exactly the same allow-list as `gmail_send_reply`.
    A misconfigured demo run that asks an unknown operator to quarantine
    a tenant gets a clear `ValueError`, not a real tenant suspension.

    The stub does NOT enforce the allow-list — quarantine is a NO-OP in
    stub mode, so there is no risk to enforce against. The allow-list
    runs ONLY in live mode, BEFORE any Identity Platform client is
    constructed.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D10 — Operator allow-list ({"app.2weeks@gmail.com"}).
    D19 — Identity Platform is the tenant directory.
    D20 — CMEK + Secret Manager. Quarantine flips tenant KMS key access.
    D23 — Tier-3 W3 security_watch.
    security_watch.spec.md §6 — Tool table row for `tenant.quarantine`.

Per-call cost: $0.0001 (Identity Platform tenant updates are quota-billed,
not per-call billed; the cost is essentially the Pub/Sub round-trip).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `tenant_quarantine.usd_cost` for the
runtime's `cost_watch` aggregator (D41). Identity Platform updates are
essentially free at the volume the demo operates at."""


# ─────────────────────────────────────────────────────────────────────────────
# D10 operator allow-list — single source of truth, mirrored from
# `gmail_send_reply._ALLOWED_RECIPIENTS`. Kept as a frozenset so it cannot
# be mutated at runtime.
# ─────────────────────────────────────────────────────────────────────────────


_ALLOWED_OPERATORS: frozenset[str] = frozenset({"app.2weeks@gmail.com"})
"""D10: only operator-owned accounts may invoke the LIVE quarantine path.
Mirror of CLAUDE.md's `app.2weeks@gmail.com` operator email. Stub mode
does NOT enforce this — quarantine is a no-op in stub mode."""


# ─────────────────────────────────────────────────────────────────────────────
# Severity enum + min/max TTL.
# ─────────────────────────────────────────────────────────────────────────────


QuarantineSeverity = Literal["soft", "hard"]
"""soft: read-only mode — agents can complete in-flight work but cannot
   start new invocations.
hard: full kill-switch — Identity Platform suspends the tenant entirely.
   In-flight work is force-terminated by the Agent Gateway.
"""


_MIN_TTL_HOURS: int = 1
_MAX_TTL_HOURS: int = 168
"""Per the task brief: TTL in [1, 168] hours (max 7 days). The live path's
Identity Platform suspension is reversible — operators can manually
un-quarantine via Mission Control — but the TTL bounds the automatic
expiry so a watchdog mistake doesn't strand a tenant forever."""


# Restriction sets per severity. The live path passes these to Identity
# Platform as feature flags; the stub echoes them on output for audit.
_RESTRICTIONS_BY_SEVERITY: dict[QuarantineSeverity, tuple[str, ...]] = {
    "soft": (
        "block_new_agent_invocations",
        "block_outbound_email_send",
    ),
    "hard": (
        "block_new_agent_invocations",
        "block_outbound_email_send",
        "suspend_identity_platform_tenant",
        "revoke_kms_key_access",
    ),
}


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class TenantQuarantineInput(BaseModel):
    """Capability input. Mirrors security_watch.spec.md §6
    `tenant.quarantine`.

    Attributes:
        tenant_id:         Identity Platform tenant id (`t_…`).
            Required; quarantine without a target is a workflow bug.
        reason:            Operator-readable cause of the quarantine.
            Audited per D33 90d retention. Plain prose, 20-500 chars.
        severity:          `soft` (read-only) or `hard` (kill-switch).
            Live path maps to distinct Identity Platform actions.
        operator_user_id:  Audit identity. Enforced against the D10
            allow-list in LIVE mode. Stub mode accepts any non-empty
            string.
        ttl_hours:         Automatic expiry. [1, 168] hours.
    """

    model_config = ConfigDict(extra="forbid")

    tenant_id: str = Field(min_length=1, max_length=128)
    reason: str = Field(min_length=20, max_length=500)
    severity: QuarantineSeverity
    operator_user_id: str = Field(min_length=1, max_length=200)
    ttl_hours: int = Field(ge=_MIN_TTL_HOURS, le=_MAX_TTL_HOURS)


class TenantQuarantineOutput(BaseModel):
    """Capability output.

    Attributes:
        quarantine_id:    Identity Platform quarantine record id (live)
            OR a deterministic synthetic id (stub).
        applied_at:       UTC timestamp at which the quarantine was
            (logically) applied.
        expires_at:       `applied_at + ttl_hours`. Automatic expiry
            time. Operators may manually shorten via Mission Control.
        restrictions:     Audit list of restrictions applied. Mirrors
            `_RESTRICTIONS_BY_SEVERITY[severity]`.
    """

    model_config = ConfigDict(extra="forbid")

    quarantine_id: str = Field(min_length=1, max_length=200)
    applied_at: dt.datetime
    expires_at: dt.datetime
    restrictions: list[str] = Field(min_length=1, max_length=20)


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def tenant_quarantine(
    payload: TenantQuarantineInput,
) -> TenantQuarantineOutput:
    """Suspend an offending tenant via Identity Platform.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`. The D10 operator allow-list is
    enforced in LIVE mode BEFORE any Identity Platform client is built.

    Args:
        payload: Validated `TenantQuarantineInput`.

    Returns:
        `TenantQuarantineOutput` with the resolved quarantine_id + audit
        fields.

    Raises:
        ValueError: in LIVE mode when `operator_user_id` is not in the
            D10 allow-list. The error message names the violated
            operator so a misconfigured demo run sees the bug, not a
            silent failure.
        NotImplementedError: in LIVE mode when the allow-list clears
            but the W7 deploy-phase Identity Platform client is not yet
            wired. The runtime converts to a typed `EscalateToHuman`.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
tenant_quarantine.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic, NEVER suspends. Allow-list check is SKIPPED here.
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: TenantQuarantineInput) -> TenantQuarantineOutput:
    """Deterministic stub. Same (tenant_id, severity) → same quarantine_id."""
    quarantine_id = _synth_quarantine_id(payload.tenant_id, payload.severity)
    applied_at = dt.datetime.now(tz=dt.UTC)
    expires_at = applied_at + dt.timedelta(hours=payload.ttl_hours)
    restrictions = list(_RESTRICTIONS_BY_SEVERITY[payload.severity])

    logger.info(
        "tenant_quarantine_stub",
        extra={
            "tenant_id": payload.tenant_id,
            "severity": payload.severity,
            "operator_user_id": payload.operator_user_id,
            "quarantine_id": quarantine_id,
            "ttl_hours": payload.ttl_hours,
        },
    )

    return TenantQuarantineOutput(
        quarantine_id=quarantine_id,
        applied_at=applied_at,
        expires_at=expires_at,
        restrictions=restrictions,
    )


def _synth_quarantine_id(tenant_id: str, severity: QuarantineSeverity) -> str:
    """Mint a deterministic synthetic quarantine_id.

    Format: `stub_qtn_<severity>_<8-char-hash>` — the severity prefix
    makes log lines self-describing; the hash captures the tenant_id
    so different tenants get different ids.
    """
    digest = hashlib.sha256(
        f"{tenant_id}|{severity}".encode("utf-8")
    ).hexdigest()[:8]
    return f"stub_qtn_{severity}_{digest}"


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase).
#
# D10 enforcement happens HERE — before any Identity Platform client is
# constructed. A misconfigured demo run with a non-allow-listed operator
# gets a clear ValueError, not a generic NotImplementedError or (much
# worse) a real tenant suspension under the wrong audit identity.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: TenantQuarantineInput) -> TenantQuarantineOutput:
    """Live Identity Platform suspend — wired in W7 deploy phase.

    Raises:
        ValueError: if `operator_user_id` is NOT in the D10 allow-list.
            This check runs FIRST so the demo-safety guarantee holds
            even when the rest of the live path is not yet wired.
        NotImplementedError: if operator IS allow-listed but the
            Identity Platform client is not yet wired (W7).
    """
    if payload.operator_user_id not in _ALLOWED_OPERATORS:
        raise ValueError(
            f"tenant_quarantine live mode: operator_user_id "
            f"{payload.operator_user_id!r} is not in the D10 allow-list "
            f"{sorted(_ALLOWED_OPERATORS)!r}. Quarantine actions are "
            "restricted to operator-owned accounts."
        )
    raise NotImplementedError(
        "tenant_quarantine live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "QuarantineSeverity",
    "TenantQuarantineInput",
    "TenantQuarantineOutput",
    "USD_COST",
    "tenant_quarantine",
]
