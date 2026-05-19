"""tests/tools/test_gate_escalate.py — capability-layer seam tests.

Covers:
  - Severity matrix: info ⇒ 24h SLA, warning ⇒ 4h, critical ⇒ 30min.
  - Stub mints monotonic escalation ids (esc_<agent_id>_001, _002, ...).
  - Per-agent counters are independent.
  - Stub determinism for a single id (state reset via fixture).
  - Live mode raises NotImplementedError.
  - Pydantic validation: severity enum, reason length, unknown field.
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from pydantic import ValidationError

from ss_agents.tools.gate_escalate import (
    USD_COST,
    GateEscalateInput,
    GateEscalateOutput,
    _reset_stub_state,
    _STUB_EPOCH,
    gate_escalate,
)


@pytest.fixture(autouse=True)
def _reset() -> None:
    """Reset stub state before every test so counters start at 1."""
    _reset_stub_state()


# ─────────────────────────────────────────────────────────────────────────────
# 1. Severity matrix — SLA mapping
# ─────────────────────────────────────────────────────────────────────────────


def test_severity_info_24h(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = gate_escalate(
        GateEscalateInput(
            agentId="sourcing",
            agentOutput={"x": 1},
            escalationReason="info-level review",
            severity="info",
        )
    )
    assert isinstance(out, GateEscalateOutput)
    assert out.expected_resolution_at == _STUB_EPOCH + timedelta(hours=24)


def test_severity_warning_4h() -> None:
    out = gate_escalate(
        GateEscalateInput(
            agentId="vetting",
            agentOutput={},
            escalationReason="warning-level review",
            severity="warning",
        )
    )
    assert out.expected_resolution_at == _STUB_EPOCH + timedelta(hours=4)


def test_severity_critical_30min() -> None:
    out = gate_escalate(
        GateEscalateInput(
            agentId="payment_mandate",
            agentOutput={},
            escalationReason="critical block",
            severity="critical",
        )
    )
    assert out.expected_resolution_at == _STUB_EPOCH + timedelta(minutes=30)


def test_severity_ordering_strict() -> None:
    """critical < warning < info — tighter SLA ⇒ earlier expected resolution."""
    crit = gate_escalate(
        GateEscalateInput(
            agentId="security_watch",
            agentOutput={},
            escalationReason="r",
            severity="critical",
        )
    )
    warn = gate_escalate(
        GateEscalateInput(
            agentId="security_watch",
            agentOutput={},
            escalationReason="r",
            severity="warning",
        )
    )
    info = gate_escalate(
        GateEscalateInput(
            agentId="security_watch",
            agentOutput={},
            escalationReason="r",
            severity="info",
        )
    )
    assert crit.expected_resolution_at < warn.expected_resolution_at < info.expected_resolution_at


# ─────────────────────────────────────────────────────────────────────────────
# 2. Monotonic escalation ids
# ─────────────────────────────────────────────────────────────────────────────


def test_escalation_ids_monotonic_per_agent() -> None:
    a1 = gate_escalate(
        GateEscalateInput(
            agentId="sourcing", agentOutput={}, escalationReason="r", severity="info"
        )
    )
    a2 = gate_escalate(
        GateEscalateInput(
            agentId="sourcing", agentOutput={}, escalationReason="r", severity="info"
        )
    )
    a3 = gate_escalate(
        GateEscalateInput(
            agentId="sourcing", agentOutput={}, escalationReason="r", severity="info"
        )
    )
    assert a1.escalation_id == "esc_sourcing_001"
    assert a2.escalation_id == "esc_sourcing_002"
    assert a3.escalation_id == "esc_sourcing_003"


def test_escalation_ids_independent_across_agents() -> None:
    a = gate_escalate(
        GateEscalateInput(
            agentId="sourcing", agentOutput={}, escalationReason="r", severity="info"
        )
    )
    b = gate_escalate(
        GateEscalateInput(
            agentId="vetting", agentOutput={}, escalationReason="r", severity="info"
        )
    )
    assert a.escalation_id == "esc_sourcing_001"
    assert b.escalation_id == "esc_vetting_001"


# ─────────────────────────────────────────────────────────────────────────────
# 3. Escalation URL points at dashboard
# ─────────────────────────────────────────────────────────────────────────────


def test_escalation_url_contains_id() -> None:
    out = gate_escalate(
        GateEscalateInput(
            agentId="critic",
            agentOutput={},
            escalationReason="r",
            severity="critical",
        )
    )
    assert out.escalation_id in out.escalation_url
    assert out.escalation_url.startswith("https://")


# ─────────────────────────────────────────────────────────────────────────────
# 4. Determinism — first id is always `esc_<agent>_001` post-reset
# ─────────────────────────────────────────────────────────────────────────────


def test_first_call_deterministic_post_reset() -> None:
    """After _reset_stub_state, the first call always produces _001."""
    out = gate_escalate(
        GateEscalateInput(
            agentId="analyst",
            agentOutput={"a": 1},
            escalationReason="r",
            severity="warning",
        )
    )
    assert out.escalation_id == "esc_analyst_001"


# ─────────────────────────────────────────────────────────────────────────────
# 5. Live mode raises with W7 message
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        gate_escalate(
            GateEscalateInput(
                agentId="sourcing",
                agentOutput={},
                escalationReason="r",
                severity="info",
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# 6. Input validation
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_unknown_severity() -> None:
    with pytest.raises(ValidationError):
        GateEscalateInput.model_validate(
            {
                "agentId": "sourcing",
                "agentOutput": {},
                "escalationReason": "r",
                "severity": "panic",
            }
        )


def test_input_rejects_empty_reason() -> None:
    with pytest.raises(ValidationError):
        GateEscalateInput(
            agentId="sourcing",
            agentOutput={},
            escalationReason="",
            severity="info",
        )


def test_input_rejects_reason_too_long() -> None:
    with pytest.raises(ValidationError):
        GateEscalateInput(
            agentId="sourcing",
            agentOutput={},
            escalationReason="x" * 501,
            severity="info",
        )


def test_input_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        GateEscalateInput.model_validate(
            {
                "agentId": "sourcing",
                "agentOutput": {},
                "escalationReason": "r",
                "severity": "info",
                "extra": True,
            }
        )


# ─────────────────────────────────────────────────────────────────────────────
# Cost attribute
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(gate_escalate, "usd_cost")
    assert gate_escalate.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(gate_escalate.usd_cost, float)  # type: ignore[attr-defined]
