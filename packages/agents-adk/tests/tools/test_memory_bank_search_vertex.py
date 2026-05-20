"""tests/tools/test_memory_bank_search_vertex.py — MEMORY_BACKEND=vertex seam.

Offline only — the managed Vertex Memory Bank wrapper is replaced with a fake
so the seam is exercised end-to-end with no network and no ADC.

Coverage matrix:
    TestVertexDispatch       — MEMORY_BACKEND=vertex routes through the managed
                               retrieve, maps the response onto the unchanged
                               MemoryBankSearchOutput contract.
    TestVertexFallback       — managed backend unavailable → safe fallback to
                               the existing CAPABILITY_LAYER_MODE dispatch.
    TestDefaultsUnchanged    — without MEMORY_BACKEND=vertex the existing
                               stub/live behavior is byte-for-byte unchanged.
    TestContractPreserved    — vertex output is a valid MemoryBankSearchOutput
                               honoring max_results + descending similarity.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

import pytest

import ss_agents.memory.vertex_memory_bank as vmb
from ss_agents.memory.vertex_memory_bank import (
    RetrievedMemory,
    VertexMemoryBankUnavailable,
)
from ss_agents.tools.memory_bank_search import (
    MemoryBankSearchInput,
    MemoryBankSearchOutput,
    memory_bank_search,
)


def _input(**overrides: object) -> MemoryBankSearchInput:
    defaults: dict[str, object] = {
        "workspace_id": "ws_demo_memory_001",
        "query": "What did the creator say about shipping?",
        "max_results": 3,
        "max_age_days": 7,
    }
    defaults.update(overrides)
    return MemoryBankSearchInput(**defaults)  # type: ignore[arg-type]


class _FakeBank:
    """Stands in for VertexMemoryBank — records the retrieve kwargs."""

    def __init__(self, rows: list[RetrievedMemory]) -> None:
        self._rows = rows
        self.calls: list[dict[str, Any]] = []

    def retrieve(self, *, workspace_id: str, query: str, top_k: int) -> list[RetrievedMemory]:
        self.calls.append({"workspace_id": workspace_id, "query": query, "top_k": top_k})
        return self._rows


# ─────────────────────────────────────────────────────────────────────────────
# TestVertexDispatch.
# ─────────────────────────────────────────────────────────────────────────────


class TestVertexDispatch:
    def test_vertex_mode_maps_managed_response_onto_contract(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        now = dt.datetime(2026, 5, 19, tzinfo=dt.UTC)
        rows = [
            RetrievedMemory("mem-near", "creator shared a Seoul address", now, 0.10),
            RetrievedMemory("mem-far", "brand voice is warm + concise", now, 0.40),
        ]
        fake = _FakeBank(rows)
        monkeypatch.setattr(vmb, "new_vertex_memory_bank", lambda: fake)
        monkeypatch.setenv("MEMORY_BACKEND", "vertex")

        out = memory_bank_search(_input(max_results=5))

        # Managed retrieve received the contract inputs (scope/top_k threaded).
        assert fake.calls == [
            {
                "workspace_id": "ws_demo_memory_001",
                "query": "What did the creator say about shipping?",
                "top_k": 5,
            }
        ]
        # Response mapped onto the UNCHANGED output contract.
        assert isinstance(out, MemoryBankSearchOutput)
        assert out.total_found == 2
        assert [m.memory_id for m in out.memories] == ["mem-near", "mem-far"]
        assert out.memories[0].content_summary == "creator shared a Seoul address"
        # distance 0.10 (near) → higher similarity than distance 0.40 (far).
        assert out.memories[0].similarity_0_1 > out.memories[1].similarity_0_1

    def test_vertex_mode_truncates_long_fact_to_500(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        long_fact = "x" * 1000
        fake = _FakeBank([RetrievedMemory("m1", long_fact, None, 0.2)])
        monkeypatch.setattr(vmb, "new_vertex_memory_bank", lambda: fake)
        monkeypatch.setenv("MEMORY_BACKEND", "vertex")

        out = memory_bank_search(_input())
        assert len(out.memories[0].content_summary) == 500

    def test_vertex_mode_takes_precedence_over_capability_mode(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """MEMORY_BACKEND=vertex must override CAPABILITY_LAYER_MODE=live —
        i.e. it must NOT raise the W7 NotImplementedError."""
        fake = _FakeBank([RetrievedMemory("m1", "fact", None, 0.2)])
        monkeypatch.setattr(vmb, "new_vertex_memory_bank", lambda: fake)
        monkeypatch.setenv("MEMORY_BACKEND", "vertex")
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")

        out = memory_bank_search(_input())
        assert out.total_found == 1


# ─────────────────────────────────────────────────────────────────────────────
# TestVertexFallback — managed backend unreachable degrades safely.
# ─────────────────────────────────────────────────────────────────────────────


class TestVertexFallback:
    def test_unavailable_falls_back_to_stub(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _raise() -> Any:
            raise VertexMemoryBankUnavailable("no VERTEX_AGENT_ENGINE")

        monkeypatch.setattr(vmb, "new_vertex_memory_bank", _raise)
        monkeypatch.setenv("MEMORY_BACKEND", "vertex")
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")

        out = memory_bank_search(_input())
        # Falls back to the deterministic stub (3 memories) — no crash.
        assert out.total_found == 3
        assert len(out.memories) == 3

    def test_unavailable_with_live_mode_raises_via_fallback(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """If vertex is unavailable AND CAPABILITY_LAYER_MODE=live, the fallback
        path is the existing live dispatch — which still raises the W7 error."""
        def _raise() -> Any:
            raise VertexMemoryBankUnavailable("no engine")

        monkeypatch.setattr(vmb, "new_vertex_memory_bank", _raise)
        monkeypatch.setenv("MEMORY_BACKEND", "vertex")
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")

        with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
            memory_bank_search(_input())


# ─────────────────────────────────────────────────────────────────────────────
# TestDefaultsUnchanged — the existing paths must be untouched.
# ─────────────────────────────────────────────────────────────────────────────


class TestDefaultsUnchanged:
    def test_default_backend_uses_stub(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # No MEMORY_BACKEND set (defaults to firestore), CAPABILITY_LAYER_MODE=stub.
        monkeypatch.delenv("MEMORY_BACKEND", raising=False)
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = memory_bank_search(_input())
        assert out.total_found == 3
        assert [m.memory_id for m in out.memories] == [
            "mem_ws_demo_memory_001_001",
            "mem_ws_demo_memory_001_002",
            "mem_ws_demo_memory_001_003",
        ]

    def test_firestore_backend_does_not_route_to_vertex(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """MEMORY_BACKEND=firestore must NOT touch the managed backend at all."""
        def _boom() -> Any:  # pragma: no cover — must never be called
            raise AssertionError("vertex backend must not be constructed")

        monkeypatch.setattr(vmb, "new_vertex_memory_bank", _boom)
        monkeypatch.setenv("MEMORY_BACKEND", "firestore")
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = memory_bank_search(_input())
        assert out.total_found == 3

    def test_live_mode_still_raises_without_vertex(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The original W7 contract is preserved when MEMORY_BACKEND != vertex."""
        monkeypatch.delenv("MEMORY_BACKEND", raising=False)
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
            memory_bank_search(_input())


# ─────────────────────────────────────────────────────────────────────────────
# TestContractPreserved.
# ─────────────────────────────────────────────────────────────────────────────


class TestContractPreserved:
    def test_max_results_trims_vertex_output(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        rows = [
            RetrievedMemory(f"m{i}", f"fact {i}", None, 0.1 * i) for i in range(5)
        ]
        fake = _FakeBank(rows)
        monkeypatch.setattr(vmb, "new_vertex_memory_bank", lambda: fake)
        monkeypatch.setenv("MEMORY_BACKEND", "vertex")

        out = memory_bank_search(_input(max_results=2))
        assert len(out.memories) == 2
        # total_found reports the pre-trim count.
        assert out.total_found == 5

    def test_vertex_output_sorted_descending_similarity(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        rows = [
            RetrievedMemory("a", "fa", None, 0.8),
            RetrievedMemory("b", "fb", None, 0.1),
            RetrievedMemory("c", "fc", None, 0.4),
        ]
        fake = _FakeBank(rows)
        monkeypatch.setattr(vmb, "new_vertex_memory_bank", lambda: fake)
        monkeypatch.setenv("MEMORY_BACKEND", "vertex")

        out = memory_bank_search(_input(max_results=3))
        sims = [m.similarity_0_1 for m in out.memories]
        assert sims == sorted(sims, reverse=True)
