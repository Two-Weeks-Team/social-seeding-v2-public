"""tests/tools/test_model_armor_query_blocks.py — W2-C1 security_watch.

Coverage matrix:
    1. Default = stub; ws_demo returns 2 blocks (1 PI + 1 PII at "warn").
    2. Pydantic input validation (range, tz-aware, block_kind enum).
    3. Stub determinism + multi-tenant isolation.
    4. block_kind filter parametrize — every kind filters correctly.
    5. Redacted snippets — raw content NEVER appears.
    6. Live mode raises NotImplementedError with W7 message.
    7. `usd_cost` attribute exposed for cost_watch aggregator (D41).
    8. Unknown workspace returns empty list (multi-tenant isolation).

Citations: D41 (capability layer stub/live), D21 (Model Armor MAX),
    D23 (Tier-3 W3), D33 (audit redaction), security_watch.spec.md §6.
"""
from __future__ import annotations

import datetime as dt

import pytest
from pydantic import ValidationError

from ss_agents.tools.model_armor_query_blocks import (
    USD_COST,
    ArmorBlockRecord,
    BlockKind,
    ModelArmorQueryBlocksInput,
    ModelArmorQueryBlocksOutput,
    model_armor_query_blocks,
)


_START = dt.datetime(2026, 5, 19, 11, 0, 0, tzinfo=dt.UTC)
_END = dt.datetime(2026, 5, 19, 12, 0, 0, tzinfo=dt.UTC)


# ─────────────────────────────────────────────────────────────────────────────
# Test 1 — default mode is stub; demo workspace → 2 blocks
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub_demo_returns_2_blocks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = model_armor_query_blocks(
        ModelArmorQueryBlocksInput(
            workspace_id="ws_demo",
            time_range=(_START, _END),
        )
    )
    assert isinstance(out, ModelArmorQueryBlocksOutput)
    assert out.total == 2
    kinds = {b.kind for b in out.blocks}
    assert kinds == {"PI", "PII"}
    assert all(b.severity == "warn" for b in out.blocks)


# ─────────────────────────────────────────────────────────────────────────────
# Test 2 — input validation
# ─────────────────────────────────────────────────────────────────────────────


class TestInputValidation:
    def test_rejects_inverted_range(self) -> None:
        with pytest.raises(ValidationError):
            ModelArmorQueryBlocksInput(
                workspace_id="ws_demo",
                time_range=(_END, _START),
            )

    def test_rejects_naive_datetime(self) -> None:
        naive_start = dt.datetime(2026, 5, 19, 11, 0, 0)
        with pytest.raises(ValidationError):
            ModelArmorQueryBlocksInput(
                workspace_id="ws_demo",
                time_range=(naive_start, _END),
            )

    def test_rejects_unknown_block_kind(self) -> None:
        with pytest.raises(ValidationError):
            ModelArmorQueryBlocksInput.model_validate(
                {
                    "workspace_id": "ws_demo",
                    "time_range": [_START, _END],
                    "block_kind": "TOXIC",  # not in literal
                }
            )

    def test_rejects_unknown_extra_field(self) -> None:
        with pytest.raises(ValidationError):
            ModelArmorQueryBlocksInput.model_validate(
                {
                    "workspace_id": "ws_demo",
                    "time_range": [_START, _END],
                    "limit": 100,  # not in schema
                }
            )

    def test_accepts_block_kind_none(self) -> None:
        payload = ModelArmorQueryBlocksInput(
            workspace_id="ws_demo",
            time_range=(_START, _END),
            block_kind=None,
        )
        assert payload.block_kind is None


# ─────────────────────────────────────────────────────────────────────────────
# Test 3 — determinism + multi-tenant isolation
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = ModelArmorQueryBlocksInput(
        workspace_id="ws_demo",
        time_range=(_START, _END),
    )
    a = model_armor_query_blocks(payload)
    b = model_armor_query_blocks(payload)
    assert a.model_dump_json() == b.model_dump_json()


def test_unknown_workspace_returns_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = model_armor_query_blocks(
        ModelArmorQueryBlocksInput(
            workspace_id="ws_unknown_tenant_xyz",
            time_range=(_START, _END),
        )
    )
    assert out.total == 0
    assert out.blocks == []


# ─────────────────────────────────────────────────────────────────────────────
# Test 4 — block_kind filter parametrize
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "kind,expected_count",
    [
        ("PI", 1),
        ("PII", 1),
        ("JB", 0),  # not in stub fixture
        ("RAI", 0),
        ("custom", 0),
        ("anomaly", 0),
    ],
)
def test_block_kind_filter(
    kind: BlockKind,
    expected_count: int,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = model_armor_query_blocks(
        ModelArmorQueryBlocksInput(
            workspace_id="ws_demo",
            time_range=(_START, _END),
            block_kind=kind,
        )
    )
    assert out.total == expected_count
    assert all(b.kind == kind for b in out.blocks)


# ─────────────────────────────────────────────────────────────────────────────
# Test 5 — redacted snippets never expose raw content
# ─────────────────────────────────────────────────────────────────────────────


def test_redacted_snippets_contain_redacted_marker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Per D33: audit retention must not become a PII honeypot."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = model_armor_query_blocks(
        ModelArmorQueryBlocksInput(
            workspace_id="ws_demo",
            time_range=(_START, _END),
        )
    )
    for block in out.blocks:
        assert "REDACTED" in block.redacted_snippet


def test_blocks_are_armor_block_record_instances(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = model_armor_query_blocks(
        ModelArmorQueryBlocksInput(
            workspace_id="ws_demo",
            time_range=(_START, _END),
        )
    )
    assert all(isinstance(b, ArmorBlockRecord) for b in out.blocks)


# ─────────────────────────────────────────────────────────────────────────────
# Test 6 — live mode raises
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        model_armor_query_blocks(
            ModelArmorQueryBlocksInput(
                workspace_id="ws_demo",
                time_range=(_START, _END),
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# Test 7 — cost attribute (D41)
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(model_armor_query_blocks, "usd_cost")
    assert (
        model_armor_query_blocks.usd_cost == USD_COST  # type: ignore[attr-defined]
    )
    assert 0.0 < USD_COST < 0.01


# ─────────────────────────────────────────────────────────────────────────────
# Test 8 — block timestamps within the input window
# ─────────────────────────────────────────────────────────────────────────────


def test_block_timestamps_within_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = model_armor_query_blocks(
        ModelArmorQueryBlocksInput(
            workspace_id="ws_demo",
            time_range=(_START, _END),
        )
    )
    for block in out.blocks:
        assert _START <= block.timestamp <= _END
