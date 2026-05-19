"""tests/tools/test_agent_optimizer_tune.py — capability-layer seam tests.

Covers:
  - Stub returns deterministic queued receipt:
      job_id="opt-<agent_id>-001", eta_minutes=30, status="queued".
  - Stub determinism (same input ⇒ identical JSON).
  - Live mode raises NotImplementedError.
  - Pydantic input validation (rubric bounds, unknown fields, target_metric).
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.agent_optimizer_tune import (
    USD_COST,
    AgentOptimizerTuneInput,
    AgentOptimizerTuneOutput,
    ObservedFailure,
    agent_optimizer_tune,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub happy path — deterministic queued receipt
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_deterministic_receipt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = agent_optimizer_tune(
        AgentOptimizerTuneInput(
            agentId="sourcing",
            currentPrompt="You are the sourcing agent. Find creators.",
            observedFailures=[
                ObservedFailure(
                    kind="escalation",
                    sampleCount=5,
                    payload={"reason": "low recall"},
                )
            ],
            targetMetric="routing_accuracy",
        )
    )
    assert isinstance(out, AgentOptimizerTuneOutput)
    assert out.job_id == "opt-sourcing-001"
    assert out.eta_minutes == 30
    assert out.status == "queued"


def test_stub_job_id_format_includes_agent_id() -> None:
    """Different agent ⇒ different job id, both with _001 suffix."""
    out = agent_optimizer_tune(
        AgentOptimizerTuneInput(
            agentId="vetting",
            currentPrompt="p",
            observedFailures=[],
            targetMetric="precision",
        )
    )
    assert out.job_id == "opt-vetting-001"


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = AgentOptimizerTuneInput(
        agentId="critic",
        currentPrompt="judge",
        observedFailures=[],
        targetMetric="agreement",
    )
    a = agent_optimizer_tune(payload)
    b = agent_optimizer_tune(payload)
    assert a.model_dump_json() == b.model_dump_json()


def test_stub_handles_empty_failures() -> None:
    """observed_failures can be empty (e.g. proactive tune)."""
    out = agent_optimizer_tune(
        AgentOptimizerTuneInput(
            agentId="analyst",
            currentPrompt="p",
            observedFailures=[],
            targetMetric="quality",
        )
    )
    assert out.status == "queued"


# ─────────────────────────────────────────────────────────────────────────────
# 2. Live mode raises with W7 message
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        agent_optimizer_tune(
            AgentOptimizerTuneInput(
                agentId="sourcing",
                currentPrompt="p",
                observedFailures=[],
                targetMetric="m",
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Input validation
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_empty_prompt() -> None:
    with pytest.raises(ValidationError):
        AgentOptimizerTuneInput(
            agentId="sourcing",
            currentPrompt="",
            observedFailures=[],
            targetMetric="m",
        )


def test_input_rejects_empty_target_metric() -> None:
    with pytest.raises(ValidationError):
        AgentOptimizerTuneInput(
            agentId="sourcing",
            currentPrompt="p",
            observedFailures=[],
            targetMetric="",
        )


def test_input_caps_observed_failures_at_200() -> None:
    with pytest.raises(ValidationError):
        AgentOptimizerTuneInput(
            agentId="sourcing",
            currentPrompt="p",
            observedFailures=[
                ObservedFailure(kind=f"k{i}", sampleCount=1, payload={})
                for i in range(201)
            ],
            targetMetric="m",
        )


def test_input_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        AgentOptimizerTuneInput.model_validate(
            {
                "agentId": "sourcing",
                "currentPrompt": "p",
                "observedFailures": [],
                "targetMetric": "m",
                "extra": True,
            }
        )


def test_observed_failure_rejects_zero_sample_count() -> None:
    with pytest.raises(ValidationError):
        ObservedFailure(kind="x", sampleCount=0, payload={})


def test_observed_failure_rejects_empty_kind() -> None:
    with pytest.raises(ValidationError):
        ObservedFailure(kind="", sampleCount=1, payload={})


# ─────────────────────────────────────────────────────────────────────────────
# Cost attribute
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(agent_optimizer_tune, "usd_cost")
    assert agent_optimizer_tune.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(agent_optimizer_tune.usd_cost, float)  # type: ignore[attr-defined]
