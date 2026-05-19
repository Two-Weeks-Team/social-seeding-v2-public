"""tests/tools/test_prompt_registry_update.py — capability-layer seam tests.

Covers:
  - First-call returns v1 with previous_version_id=None.
  - Second-call returns v2 with previous_version_id="v1".
  - Versions are monotonic per agent_id and independent across agents.
  - Rollback URL on v1 contains `confirm=initial`; on v2+ references previous.
  - Live mode raises NotImplementedError.
  - Pydantic input validation (label length, performance_delta range, etc.).
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.prompt_registry_update import (
    USD_COST,
    PromptRegistryUpdateInput,
    PromptRegistryUpdateOutput,
    _reset_stub_state,
    prompt_registry_update,
)


@pytest.fixture(autouse=True)
def _reset() -> None:
    """Reset stub state so each test starts at v1."""
    _reset_stub_state()


def _payload(agent_id: str = "sourcing", **overrides: object) -> PromptRegistryUpdateInput:
    base = {
        "agentId": agent_id,
        "newPrompt": "You are the sourcing agent. v.next.",
        "versionLabel": "tournament-2026Q2",
        "optimizerJobId": "opt-sourcing-001",
        "performanceDelta01": 0.05,
    }
    base.update(overrides)
    return PromptRegistryUpdateInput.model_validate(base)


# ─────────────────────────────────────────────────────────────────────────────
# 1. First call ⇒ v1, no previous
# ─────────────────────────────────────────────────────────────────────────────


def test_first_call_returns_v1(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = prompt_registry_update(_payload())
    assert isinstance(out, PromptRegistryUpdateOutput)
    assert out.version_id == "v1"
    assert out.previous_version_id is None


def test_first_call_rollback_url_contains_confirm_initial() -> None:
    out = prompt_registry_update(_payload())
    assert "confirm=initial" in out.rollback_url


# ─────────────────────────────────────────────────────────────────────────────
# 2. Second call ⇒ v2 with previous="v1"
# ─────────────────────────────────────────────────────────────────────────────


def test_second_call_returns_v2_with_previous() -> None:
    prompt_registry_update(_payload())
    out2 = prompt_registry_update(_payload())
    assert out2.version_id == "v2"
    assert out2.previous_version_id == "v1"


def test_third_call_returns_v3_with_previous_v2() -> None:
    prompt_registry_update(_payload())
    prompt_registry_update(_payload())
    out3 = prompt_registry_update(_payload())
    assert out3.version_id == "v3"
    assert out3.previous_version_id == "v2"


def test_v2_rollback_url_references_v1() -> None:
    prompt_registry_update(_payload())
    out2 = prompt_registry_update(_payload())
    assert "rollback-to/v1" in out2.rollback_url


# ─────────────────────────────────────────────────────────────────────────────
# 3. Per-agent independence
# ─────────────────────────────────────────────────────────────────────────────


def test_versions_independent_across_agents() -> None:
    a = prompt_registry_update(_payload("sourcing"))
    b = prompt_registry_update(_payload("vetting"))
    assert a.version_id == "v1"
    assert b.version_id == "v1"
    # Bump sourcing only:
    a2 = prompt_registry_update(_payload("sourcing"))
    assert a2.version_id == "v2"
    assert a2.previous_version_id == "v1"
    # vetting still at v1 — bump it once:
    b2 = prompt_registry_update(_payload("vetting"))
    assert b2.version_id == "v2"


# ─────────────────────────────────────────────────────────────────────────────
# 4. Live mode raises with W7 message
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        prompt_registry_update(_payload())


# ─────────────────────────────────────────────────────────────────────────────
# 5. Input validation
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_empty_prompt() -> None:
    with pytest.raises(ValidationError):
        PromptRegistryUpdateInput(
            agentId="sourcing",
            newPrompt="",
            versionLabel="lbl",
            optimizerJobId="opt-1",
            performanceDelta01=0.0,
        )


def test_input_rejects_empty_label() -> None:
    with pytest.raises(ValidationError):
        PromptRegistryUpdateInput(
            agentId="sourcing",
            newPrompt="p",
            versionLabel="",
            optimizerJobId="opt-1",
            performanceDelta01=0.0,
        )


def test_input_rejects_negative_performance_delta() -> None:
    with pytest.raises(ValidationError):
        PromptRegistryUpdateInput(
            agentId="sourcing",
            newPrompt="p",
            versionLabel="lbl",
            optimizerJobId="opt-1",
            performanceDelta01=-0.01,
        )


def test_input_rejects_performance_delta_above_one() -> None:
    with pytest.raises(ValidationError):
        PromptRegistryUpdateInput(
            agentId="sourcing",
            newPrompt="p",
            versionLabel="lbl",
            optimizerJobId="opt-1",
            performanceDelta01=1.5,
        )


def test_input_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        PromptRegistryUpdateInput.model_validate(
            {
                "agentId": "sourcing",
                "newPrompt": "p",
                "versionLabel": "lbl",
                "optimizerJobId": "opt-1",
                "performanceDelta01": 0.0,
                "extra": True,
            }
        )


# ─────────────────────────────────────────────────────────────────────────────
# Cost attribute
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(prompt_registry_update, "usd_cost")
    assert prompt_registry_update.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(prompt_registry_update.usd_cost, float)  # type: ignore[attr-defined]
