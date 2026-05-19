"""tests/tools/test_blacklist_check.py — capability-layer seam tests."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.blacklist_check import (
    USD_COST,
    BlacklistCheckInput,
    BlacklistCheckOutput,
    blacklist_check,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Default = stub (empty hits)
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub_empty_hits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub mode always returns no blacklist hits."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = blacklist_check(
        BlacklistCheckInput(
            workspaceId="ws_demo_blacklist_test",
            creatorIds=["tt_001", "tt_002", "tt_003"],
        )
    )
    assert isinstance(out, BlacklistCheckOutput)
    assert out.hits == []
    assert out.checked_count == 3


def test_stub_echoes_checked_count(monkeypatch: pytest.MonkeyPatch) -> None:
    """`checkedCount` reflects the input length even though `hits` is empty."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    ids = [f"tt_{i:03d}" for i in range(1, 21)]
    out = blacklist_check(
        BlacklistCheckInput(workspaceId="ws_demo_blacklist_test", creatorIds=ids)
    )
    assert out.hits == []
    assert out.checked_count == 20


# ─────────────────────────────────────────────────────────────────────────────
# 2. Determinism
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = BlacklistCheckInput(
        workspaceId="ws_demo_blacklist_test",
        creatorIds=["tt_001", "tt_002"],
    )
    a = blacklist_check(payload)
    b = blacklist_check(payload)
    assert a.model_dump_json() == b.model_dump_json()


# ─────────────────────────────────────────────────────────────────────────────
# 3. Live mode raises with W7 message
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        blacklist_check(
            BlacklistCheckInput(
                workspaceId="ws_demo_blacklist_test", creatorIds=["tt_001"]
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Input validation
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_empty_creator_ids() -> None:
    with pytest.raises(ValidationError):
        BlacklistCheckInput(workspaceId="ws_demo_blacklist_test", creatorIds=[])


def test_input_rejects_missing_workspace_id() -> None:
    with pytest.raises(ValidationError):
        BlacklistCheckInput.model_validate({"creatorIds": ["tt_001"]})


def test_input_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        BlacklistCheckInput.model_validate(
            {
                "workspaceId": "ws_demo_blacklist_test",
                "creatorIds": ["tt_001"],
                "severity": "PERMANENT",
            }
        )


def test_input_caps_creator_id_list() -> None:
    """5001 ids ⇒ validation error (max_length=5000)."""
    with pytest.raises(ValidationError):
        BlacklistCheckInput(
            workspaceId="ws_demo_blacklist_test",
            creatorIds=[f"tt_{i:05d}" for i in range(5_001)],
        )


# ─────────────────────────────────────────────────────────────────────────────
# Cost attribute
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(blacklist_check, "usd_cost")
    assert blacklist_check.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(blacklist_check.usd_cost, float)  # type: ignore[attr-defined]
