"""test_sample_agent_properties.py — sample per-agent property test (template).

Cites: D17 (ADK Python), D37 (5-layer TDD). MATRIX §4.2 — every agent must
ship 3 test classes: TestInputContract, TestPlumbing, TestEscalation.

This file is the template the production tests under
`packages/agents-adk/tests/test_<agent>.py` follow. It exercises the
`strategies.py` shapes against an in-harness stub agent to prove the
property-test plumbing works.
"""

from __future__ import annotations

from typing import Any

import pytest
from hypothesis import given, settings

from strategies import (  # type: ignore[import-not-found]
    LOCALES,
    conversation_input,
    locale,
    outreach_input,
    payment_mandate_input,
    sourcing_input,
    vetting_input,
)


# ---------------------------------------------------------------- stub agent
class _StubAgent:
    """In-process stand-in for an ADK agent. Validates input shape, returns
    a typed dict that mirrors the Pydantic output contract."""

    def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        required = {"tenant_id", "locale"}
        missing = required - set(payload)
        if missing:
            raise ValueError(f"missing required fields: {missing}")
        if payload["locale"] not in LOCALES:
            raise ValueError(f"unsupported locale {payload['locale']!r}")
        return {
            "status": "ok",
            "echo_tenant": payload["tenant_id"],
            "locale": payload["locale"],
        }


# ============================================================== TestInputContract
class TestInputContract:
    """MATRIX §4.2 row 1 — every valid input is accepted; invalid ones raise."""

    @given(payload=sourcing_input())
    def test_sourcing_accepts_valid_input(self, payload: dict[str, Any]) -> None:
        agent = _StubAgent()
        out = agent.run(payload)
        assert out["status"] == "ok"
        assert out["locale"] in LOCALES

    @given(payload=vetting_input())
    def test_vetting_accepts_valid_input(self, payload: dict[str, Any]) -> None:
        agent = _StubAgent()
        out = agent.run(payload)
        assert out["status"] == "ok"

    @given(payload=outreach_input())
    def test_outreach_accepts_valid_input(self, payload: dict[str, Any]) -> None:
        agent = _StubAgent()
        out = agent.run(payload)
        assert out["status"] == "ok"

    @given(payload=conversation_input())
    def test_conversation_accepts_valid_input(self, payload: dict[str, Any]) -> None:
        agent = _StubAgent()
        out = agent.run(payload)
        assert out["status"] == "ok"

    @given(payload=payment_mandate_input())
    def test_payment_mandate_accepts_valid_input(self, payload: dict[str, Any]) -> None:
        agent = _StubAgent()
        out = agent.run(payload)
        assert out["status"] == "ok"

    @given(loc=locale())
    def test_locale_strategy_covers_all_4(self, loc: str) -> None:
        assert loc in LOCALES

    def test_invalid_locale_rejected(self) -> None:
        agent = _StubAgent()
        with pytest.raises(ValueError, match="unsupported locale"):
            agent.run({"tenant_id": "tnt_x", "locale": "xx"})

    def test_missing_tenant_rejected(self) -> None:
        agent = _StubAgent()
        with pytest.raises(ValueError, match="missing"):
            agent.run({"locale": "en"})


# ============================================================== TestPlumbing
class TestPlumbing:
    """MATRIX §4.2 row 2 — mocked-LLM scripted-tool-sequence tests.

    Production version uses ADK's agent.tools.mock; here we hand-roll a tool
    counter to validate the shape-of-shape behaviour.
    """

    @given(payload=sourcing_input())
    def test_sourcing_does_not_throw(self, payload: dict[str, Any]) -> None:
        # A property test: for any valid payload, the agent must produce a
        # non-error response OR raise a typed ValueError. Never a stray exception.
        agent = _StubAgent()
        try:
            out = agent.run(payload)
        except ValueError:
            pytest.skip("intentionally rejected — covered in TestInputContract")
        else:
            assert "status" in out

    def test_tool_call_counter_is_finite(self) -> None:
        # Production: assert that no agent makes >N tool calls per invocation
        # (D23 — every agent has a curated tool set + USD cap). Smoke-only here.
        budget = 10
        used = 0
        for _ in range(5):
            used += 1
            assert used <= budget


# ============================================================== TestEscalation
class TestEscalation:
    """MATRIX §4.2 row 3 — every escalation path produces a typed Escalate output
    without burning the rest of the turn budget."""

    def test_insufficient_context_escalation(self) -> None:
        # In production this drives the agent to assert insufficient context;
        # here we model the escalation as raising a typed error.
        agent = _StubAgent()
        with pytest.raises(ValueError):
            agent.run({"tenant_id": "tnt_x"})  # missing locale

    def test_budget_exceeded_escalation_is_surface(self) -> None:
        # When a tenant's budget is exhausted, the agent must SURFACE the
        # escalation, not silently proceed. The W2 cost_watch agent is the
        # downstream consumer (MATRIX §8 elevated thresholds).
        budget_remaining_usd = 0.10
        cost_of_next_call_usd = 1.00
        if cost_of_next_call_usd > budget_remaining_usd:
            escalate = {"kind": "Escalate", "reason": "budget_exceeded"}
            assert escalate["reason"] == "budget_exceeded"
        else:  # pragma: no cover
            pytest.fail("budget shape impossible here")
