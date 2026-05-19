"""gate_escalate — capability layer per D41.

Escalate an agent output to the human-approval queue. Implements the
`approval_queue.escalate` / `gate.escalate` capability that the Tier-2 M2
critic (D23) consumes from `critic.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic escalation id derived from the agent_id + a monotonic
    counter so /goal evaluator can assert on stable ids across re-runs.
    The `expected_resolution_at` SLA is severity-tiered.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real write to the Spanner-backed approval queue + Pub/Sub fanout to the
    operator dashboard (D27 human-checkpoint model). Wired in W7 deploy
    phase — raises `NotImplementedError` until then.

Citations:
    D23 — Tier-2 M2 critic.
    D24 — Phased coordination — escalations honor workspace autonomy level.
    D27 — Human checkpoint model (every irreversible action gated).
    D41 — Capability-layer ADK FunctionTool stub/live pattern.
    critic.spec.md §6 — Tool table row for the escalate capability.
"""
from __future__ import annotations

import logging
import os
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Spanner write + Pub/Sub publish — sub-cent. Surfaced via
`gate_escalate.usd_cost` for `cost_watch` (D41)."""


EscalationSeverity = Literal["info", "warning", "critical"]
"""SLA tiers per D27:
  - info     → 24h response window (informational; e.g. budget warning).
  - warning  → 4h response window (degraded behavior; operator review).
  - critical → 30min response window (irreversible action blocked OR
               security quarantine; pages on-call).
"""


_SLA_BY_SEVERITY: dict[EscalationSeverity, timedelta] = {
    "info": timedelta(hours=24),
    "warning": timedelta(hours=4),
    "critical": timedelta(minutes=30),
}
"""Severity → expected_resolution_at delta. Lifted from D27 §human checkpoint
SLA matrix; live mode reads this from workspace policy + falls back here."""


_STUB_EPOCH: datetime = datetime(2026, 5, 19, 12, 0, 0, tzinfo=UTC)
"""Deterministic anchor for stub-mode `expected_resolution_at` calculation —
same epoch as `agent_registry_list._STUB_EPOCH` so cross-tool integration
tests don't need to mock `datetime.now()`."""


# Per-process monotonic counter so successive stub calls produce distinct ids.
_STUB_COUNTER: dict[str, int] = {}
"""Per-agent escalation counter. `{agent_id: next_id}`. Reset between tests
via `_reset_stub_state` — production code does not call this."""


def _reset_stub_state() -> None:
    """Reset module-level stub state. Used by tests via fixture / `monkeypatch`.

    Production code does not call this — the live mode owns its own state in
    Spanner.
    """
    _STUB_COUNTER.clear()


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class GateEscalateInput(BaseModel):
    """Input contract — `gate.escalate` per critic.spec.md §6.

    Attributes:
        agent_id: The agent whose output is being escalated. Forms part of the
            escalation id so the dashboard can group by source.
        agent_output: The candidate output (free-form dict). Surfaced verbatim
            in the human-review queue.
        escalation_reason: Operator-readable prose explaining the escalation
            (≤ 500 chars). The dashboard displays this as the queue card title.
        severity: One of info/warning/critical (D27 SLA tiers).
    """

    model_config = ConfigDict(extra="forbid")

    agent_id: str = Field(min_length=1, max_length=64, alias="agentId")
    agent_output: dict[str, Any] = Field(alias="agentOutput")
    escalation_reason: str = Field(
        min_length=1,
        max_length=500,
        alias="escalationReason",
    )
    severity: EscalationSeverity


class GateEscalateOutput(BaseModel):
    """Output contract — escalation receipt.

    Attributes:
        escalation_id: Stable id of the queue item. Stub format
            `esc_<agent_id>_<NNN>`; live mode mints a UUIDv7-based id.
        escalation_url: Operator dashboard deep-link to the queue card.
        expected_resolution_at: UTC deadline — `_STUB_EPOCH + SLA[severity]`
            in stub mode. Live mode adds the SLA to `datetime.now(UTC)`.
    """

    model_config = ConfigDict(extra="forbid")

    escalation_id: str = Field(
        min_length=1,
        max_length=80,
        alias="escalationId",
    )
    escalation_url: str = Field(min_length=1, max_length=500, alias="escalationUrl")
    expected_resolution_at: datetime = Field(alias="expectedResolutionAt")


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def gate_escalate(payload: GateEscalateInput) -> GateEscalateOutput:
    """Escalate an agent output to the human-approval queue.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated escalation request.

    Returns:
        `GateEscalateOutput` with the queue id, deep-link URL, and SLA-tiered
        expected resolution time.

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
gate_escalate.usd_cost = USD_COST  # type: ignore[attr-defined]


def _stub(payload: GateEscalateInput) -> GateEscalateOutput:
    """Deterministic escalation receipt.

    Behavior:
      - Escalation id: `esc_<agent_id>_<NNN>` where NNN is a per-agent
        monotonic counter (1, 2, 3, ...).
      - URL: `https://dashboard.stub.local/escalations/<escalation_id>`.
      - expected_resolution_at: `_STUB_EPOCH + SLA[severity]`.
    """
    next_seq = _STUB_COUNTER.get(payload.agent_id, 0) + 1
    _STUB_COUNTER[payload.agent_id] = next_seq

    escalation_id = f"esc_{payload.agent_id}_{next_seq:03d}"
    escalation_url = f"https://dashboard.stub.local/escalations/{escalation_id}"
    expected_resolution = _STUB_EPOCH + _SLA_BY_SEVERITY[payload.severity]

    logger.info(
        "gate_escalate_stub",
        extra={
            "agent_id": payload.agent_id,
            "escalation_id": escalation_id,
            "severity": payload.severity,
        },
    )
    return GateEscalateOutput(
        escalationId=escalation_id,
        escalationUrl=escalation_url,
        expectedResolutionAt=expected_resolution,
    )


def _live(payload: GateEscalateInput) -> GateEscalateOutput:
    """Live escalation write — wired in W7 deploy phase.

    The live impl will:
      1. Mint a UUIDv7-based escalation id (BUILD-NOTES.md replay-resistance).
      2. Write the queue row to Spanner (v2_human_approval_queue).
      3. Publish a `agent.t2.critic.escalated` Pub/Sub event for the dashboard.
      4. Page on-call via Cloud Operations when severity == "critical".
      5. Return the canonical dashboard URL + SLA deadline.
    """
    raise NotImplementedError(
        "gate_escalate live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "EscalationSeverity",
    "GateEscalateInput",
    "GateEscalateOutput",
    "USD_COST",
    "gate_escalate",
]
