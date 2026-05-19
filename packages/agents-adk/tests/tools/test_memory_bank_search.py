"""tests/tools/test_memory_bank_search.py — W2-B7 capability layer test.

Coverage matrix:
    TestInputContract      — Pydantic validation gates (D41).
    TestD33LifecycleCap    — `max_age_days <= 14` enforced at Pydantic (D33).
    TestStubDeterminism    — same workspace_id → byte-identical memories.
    TestMaxResultsCap      — `max_results` trims the output list correctly.
    TestSortByDescendingSimilarity — output is sorted, highest similarity first.
    TestLiveModeRaises     — CAPABILITY_LAYER_MODE=live → NotImplementedError.
    TestCostAttribute      — `memory_bank_search.usd_cost` exposed.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.memory_bank_search import (
    USD_COST,
    Memory,
    MemoryBankSearchInput,
    MemoryBankSearchOutput,
    memory_bank_search,
)


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _force_stub_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default every test to stub mode — live tests opt back into 'live'."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")


def _input(**overrides: object) -> MemoryBankSearchInput:
    """Construct a baseline MemoryBankSearchInput, allowing field overrides."""
    defaults: dict[str, object] = {
        "workspace_id": "ws_demo_memory_001",
        "query": "What did the creator say about shipping?",
        "max_results": 3,
        "max_age_days": 7,
    }
    defaults.update(overrides)
    return MemoryBankSearchInput(**defaults)  # type: ignore[arg-type]


# ─────────────────────────────────────────────────────────────────────────────
# TestInputContract.
# ─────────────────────────────────────────────────────────────────────────────


class TestInputContract:
    def test_minimal_input_validates(self) -> None:
        payload = _input()
        assert payload.workspace_id == "ws_demo_memory_001"
        assert payload.max_results == 3
        assert payload.max_age_days == 7

    def test_empty_workspace_id_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _input(workspace_id="")

    def test_empty_query_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _input(query="")

    def test_max_results_below_one_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _input(max_results=0)

    def test_max_results_above_ten_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _input(max_results=11)

    def test_max_age_days_below_one_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _input(max_age_days=0)

    def test_unknown_field_rejected(self) -> None:
        with pytest.raises(ValidationError):
            MemoryBankSearchInput.model_validate(
                {
                    "workspace_id": "ws_demo_memory_001",
                    "query": "test",
                    "max_results": 3,
                    "max_age_days": 7,
                    "extra_field": "rejected",
                }
            )


# ─────────────────────────────────────────────────────────────────────────────
# TestD33LifecycleCap — the critical retention-window guardrail.
#
# Per D33, Memory Bank TTL is 14 days. Callers cannot ask for older docs.
# ─────────────────────────────────────────────────────────────────────────────


class TestD33LifecycleCap:
    def test_max_age_days_15_rejected(self) -> None:
        """D33: 15 days exceeds the 14-day TTL → ValidationError."""
        with pytest.raises(ValidationError):
            _input(max_age_days=15)

    def test_max_age_days_30_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _input(max_age_days=30)

    def test_max_age_days_exactly_14_allowed(self) -> None:
        """The upper bound is inclusive — exactly 14 days is the boundary."""
        payload = _input(max_age_days=14)
        assert payload.max_age_days == 14

    def test_max_age_days_1_allowed(self) -> None:
        """The lower bound is inclusive — 1 day is the minimum query window."""
        payload = _input(max_age_days=1)
        assert payload.max_age_days == 1


# ─────────────────────────────────────────────────────────────────────────────
# TestStubDeterminism.
# ─────────────────────────────────────────────────────────────────────────────


class TestStubDeterminism:
    def test_same_workspace_yields_same_memories(self) -> None:
        a = memory_bank_search(_input())
        b = memory_bank_search(_input())
        # Memory ids + similarity scores + content are deterministic per
        # workspace. created_at is a wall-clock value so we compare on the
        # stable fields.
        assert [m.memory_id for m in a.memories] == [m.memory_id for m in b.memories]
        assert [m.similarity_0_1 for m in a.memories] == [
            m.similarity_0_1 for m in b.memories
        ]
        assert [m.content_summary for m in a.memories] == [
            m.content_summary for m in b.memories
        ]
        assert a.total_found == b.total_found

    def test_different_workspaces_yield_different_content(self) -> None:
        a = memory_bank_search(_input(workspace_id="ws_demo_memory_001"))
        b = memory_bank_search(_input(workspace_id="ws_demo_memory_999"))
        # Different workspaces should not see identical memory content
        # (the stub permutes the content bank by workspace hash).
        contents_a = [m.content_summary for m in a.memories]
        contents_b = [m.content_summary for m in b.memories]
        assert contents_a != contents_b

    def test_stub_returns_three_memories_total_found(self) -> None:
        out = memory_bank_search(_input(max_results=10))
        # Stub always reports 3 total — caller can re-query with larger cap
        # to retrieve everything.
        assert out.total_found == 3


# ─────────────────────────────────────────────────────────────────────────────
# TestMaxResultsCap.
# ─────────────────────────────────────────────────────────────────────────────


class TestMaxResultsCap:
    def test_max_results_1_trims_to_single_memory(self) -> None:
        out = memory_bank_search(_input(max_results=1))
        assert len(out.memories) == 1
        # total_found reports pre-trim count.
        assert out.total_found == 3

    def test_max_results_3_returns_all_stub_memories(self) -> None:
        out = memory_bank_search(_input(max_results=3))
        assert len(out.memories) == 3

    def test_max_results_above_stub_count_returns_what_exists(self) -> None:
        """max_results=10 still returns only the 3 stub memories — we don't
        synthesise more memories than the stub has."""
        out = memory_bank_search(_input(max_results=10))
        assert len(out.memories) == 3

    def test_returned_memory_ids_are_unique(self) -> None:
        out = memory_bank_search(_input(max_results=3))
        ids = [m.memory_id for m in out.memories]
        assert len(ids) == len(set(ids))


# ─────────────────────────────────────────────────────────────────────────────
# TestSortByDescendingSimilarity.
# ─────────────────────────────────────────────────────────────────────────────


class TestSortByDescendingSimilarity:
    def test_memories_sorted_by_descending_similarity(self) -> None:
        out = memory_bank_search(_input(max_results=3))
        sims = [m.similarity_0_1 for m in out.memories]
        assert sims == sorted(sims, reverse=True)

    def test_top_memory_similarity_is_at_least_0_5(self) -> None:
        """The top memory should be a strong-ish match (the stub seeds
        the top similarity at ~0.95)."""
        out = memory_bank_search(_input(max_results=3))
        assert out.memories[0].similarity_0_1 >= 0.5

    def test_each_memory_is_well_typed(self) -> None:
        out = memory_bank_search(_input(max_results=3))
        for m in out.memories:
            assert isinstance(m, Memory)
            assert 0.0 <= m.similarity_0_1 <= 1.0
            assert m.content_summary  # non-empty


# ─────────────────────────────────────────────────────────────────────────────
# TestLiveModeRaises.
# ─────────────────────────────────────────────────────────────────────────────


class TestLiveModeRaises:
    def test_live_mode_raises_not_implemented(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
            memory_bank_search(_input())


# ─────────────────────────────────────────────────────────────────────────────
# TestCostAttribute.
# ─────────────────────────────────────────────────────────────────────────────


class TestCostAttribute:
    def test_cost_attribute_exposed(self) -> None:
        assert hasattr(memory_bank_search, "usd_cost")
        assert memory_bank_search.usd_cost == USD_COST  # type: ignore[attr-defined]
        assert isinstance(memory_bank_search.usd_cost, float)  # type: ignore[attr-defined]

    def test_output_total_found_is_non_negative(self) -> None:
        out = memory_bank_search(_input())
        assert isinstance(out, MemoryBankSearchOutput)
        assert out.total_found >= 0
