"""tests/tools/test_agent_registry_list.py — capability-layer seam tests.

Covers:
  - Stub returns exactly 22 agents per D23 fleet inventory.
  - Tier filter (1, 2, 3) returns the expected slices (16 / 3 / 3).
  - Status filter (healthy / degraded / down) returns expected counts.
  - Stub determinism — same input ⇒ identical JSON bytes.
  - Live mode raises NotImplementedError.
  - Pydantic validation: tier ∉ {1,2,3}, unknown field, status enum.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.agent_registry_list import (
    USD_COST,
    AgentRegistryListInput,
    AgentRegistryListOutput,
    agent_registry_list,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Fleet snapshot — 22 agents (D23)
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_returns_all_22_agents(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default (no filter) ⇒ entire 22-agent fleet per D23."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = agent_registry_list(AgentRegistryListInput())
    assert isinstance(out, AgentRegistryListOutput)
    assert out.total == 22
    assert len(out.agents) == 22


def test_stub_fleet_includes_three_meta_agents() -> None:
    """Tier-2 fleet MUST include coordinator, critic, optimizer (D23)."""
    out = agent_registry_list(AgentRegistryListInput(filterTier=2))
    ids = {a.agent_id for a in out.agents}
    assert ids == {"coordinator", "critic", "optimizer"}
    assert out.total == 3


def test_stub_fleet_includes_three_watchdog_agents() -> None:
    """Tier-3 fleet MUST include anomaly_watch, cost_watch, security_watch."""
    out = agent_registry_list(AgentRegistryListInput(filterTier=3))
    ids = {a.agent_id for a in out.agents}
    assert ids == {"anomaly_watch", "cost_watch", "security_watch"}
    assert out.total == 3


def test_stub_tier_1_count_is_sixteen() -> None:
    """Tier-1 fleet is exactly 16 domain agents (DECISIONS.md §4)."""
    out = agent_registry_list(AgentRegistryListInput(filterTier=1))
    assert out.total == 16
    assert len(out.agents) == 16


# ─────────────────────────────────────────────────────────────────────────────
# 2. Status filter
# ─────────────────────────────────────────────────────────────────────────────


def test_status_filter_degraded() -> None:
    """Compliance is the only degraded agent in the fixture."""
    out = agent_registry_list(AgentRegistryListInput(filterStatus="degraded"))
    ids = {a.agent_id for a in out.agents}
    assert ids == {"compliance"}


def test_status_filter_down() -> None:
    """security_watch is the only down agent in the fixture."""
    out = agent_registry_list(AgentRegistryListInput(filterStatus="down"))
    ids = {a.agent_id for a in out.agents}
    assert ids == {"security_watch"}


def test_status_filter_healthy_count() -> None:
    """20 of 22 agents are healthy in the deterministic fixture."""
    out = agent_registry_list(AgentRegistryListInput(filterStatus="healthy"))
    assert out.total == 20


# ─────────────────────────────────────────────────────────────────────────────
# 3. Combined tier + status filter
# ─────────────────────────────────────────────────────────────────────────────


def test_combined_filter_tier1_degraded() -> None:
    """Tier-1 + degraded ⇒ just compliance."""
    out = agent_registry_list(
        AgentRegistryListInput(filterTier=1, filterStatus="degraded")
    )
    assert out.total == 1
    assert out.agents[0].agent_id == "compliance"


def test_combined_filter_tier2_down_empty() -> None:
    """No Tier-2 agent is down ⇒ empty result."""
    out = agent_registry_list(
        AgentRegistryListInput(filterTier=2, filterStatus="down")
    )
    assert out.total == 0
    assert out.agents == []


# ─────────────────────────────────────────────────────────────────────────────
# 4. Determinism
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same input ⇒ identical JSON bytes across calls."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = AgentRegistryListInput(filterTier=2)
    a = agent_registry_list(payload)
    b = agent_registry_list(payload)
    assert a.model_dump_json() == b.model_dump_json()


# ─────────────────────────────────────────────────────────────────────────────
# 5. Live mode raises with W7 message
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        agent_registry_list(AgentRegistryListInput())


# ─────────────────────────────────────────────────────────────────────────────
# 6. Input validation
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_invalid_tier() -> None:
    with pytest.raises(ValidationError):
        AgentRegistryListInput.model_validate({"filterTier": 4})


def test_input_rejects_invalid_status() -> None:
    with pytest.raises(ValidationError):
        AgentRegistryListInput.model_validate({"filterStatus": "unknown"})


def test_input_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        AgentRegistryListInput.model_validate({"foo": "bar"})


# ─────────────────────────────────────────────────────────────────────────────
# Cost attribute
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(agent_registry_list, "usd_cost")
    assert agent_registry_list.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(agent_registry_list.usd_cost, float)  # type: ignore[attr-defined]
