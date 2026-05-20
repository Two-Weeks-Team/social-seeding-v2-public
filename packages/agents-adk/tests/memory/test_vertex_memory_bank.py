"""tests/memory/test_vertex_memory_bank.py — managed Vertex AI Memory Bank (D15).

Offline only — the ``vertexai`` SDK is mocked; no network, no ADC.

Coverage matrix:
    TestEngineResource     — bare id ↔ full reasoningEngines resource path.
    TestRetrieveRequest    — composes the GA `memories.retrieve` similarity req.
    TestRetrieveResponse   — parses RetrieveMemoriesResponseRetrievedMemory rows
                             (typed + dict shapes), distance→similarity, sort.
    TestCreateRequest      — composes the GA `memories.create` write request.
    TestUnavailable        — missing engine / SDK errors raise the typed
                             VertexMemoryBankUnavailable (seam falls back).
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any

import pytest

from ss_agents.memory.vertex_memory_bank import (
    RetrievedMemory,
    VertexMemoryBank,
    VertexMemoryBankUnavailable,
    new_vertex_memory_bank,
)

# ─────────────────────────────────────────────────────────────────────────────
# Fakes — stand in for the vertexai SDK surface so we never touch the network.
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class _FakeMemory:
    """Mirrors the SDK ``types.Memory`` (only the fields we read)."""

    name: str | None = None
    fact: str | None = None
    create_time: dt.datetime | None = None


@dataclass
class _FakeRetrieved:
    """Mirrors ``RetrieveMemoriesResponseRetrievedMemory``."""

    distance: float | None = None
    memory: _FakeMemory | None = None


@dataclass
class _FakeOperationResponse:
    name: str | None = None


@dataclass
class _FakeOperation:
    response: _FakeOperationResponse | None = None


class _FakeMemories:
    """Records the kwargs passed to retrieve/create and returns scripted data."""

    def __init__(
        self,
        *,
        retrieve_return: list[Any] | None = None,
        create_return: Any | None = None,
        retrieve_raises: Exception | None = None,
        create_raises: Exception | None = None,
    ) -> None:
        self._retrieve_return = retrieve_return or []
        self._create_return = create_return
        self._retrieve_raises = retrieve_raises
        self._create_raises = create_raises
        self.retrieve_calls: list[dict[str, Any]] = []
        self.create_calls: list[dict[str, Any]] = []

    def retrieve(self, **kwargs: Any) -> list[Any]:
        self.retrieve_calls.append(kwargs)
        if self._retrieve_raises is not None:
            raise self._retrieve_raises
        return self._retrieve_return

    def create(self, **kwargs: Any) -> Any:
        self.create_calls.append(kwargs)
        if self._create_raises is not None:
            raise self._create_raises
        return self._create_return


class _FakeAgentEngines:
    def __init__(self, memories: _FakeMemories) -> None:
        self.memories = memories


class _FakeClient:
    def __init__(self, memories: _FakeMemories) -> None:
        self.agent_engines = _FakeAgentEngines(memories)


def _bank(memories: _FakeMemories, *, agent_engine: str = "eng-123") -> VertexMemoryBank:
    return VertexMemoryBank(
        project="ss-v2-dev",
        location="us-central1",
        agent_engine=agent_engine,
        client=_FakeClient(memories),
    )


# ─────────────────────────────────────────────────────────────────────────────
# TestEngineResource.
# ─────────────────────────────────────────────────────────────────────────────


class TestEngineResource:
    def test_bare_id_expands_to_full_resource(self) -> None:
        bank = _bank(_FakeMemories(), agent_engine="9876543210")
        assert bank.engine_resource() == (
            "projects/ss-v2-dev/locations/us-central1"
            "/reasoningEngines/9876543210"
        )

    def test_full_resource_passes_through(self) -> None:
        resource = "projects/p/locations/l/reasoningEngines/abc"
        bank = _bank(_FakeMemories(), agent_engine=resource)
        assert bank.engine_resource() == resource


# ─────────────────────────────────────────────────────────────────────────────
# TestRetrieveRequest — assert the composed managed request.
# ─────────────────────────────────────────────────────────────────────────────


class TestRetrieveRequest:
    def test_retrieve_composes_similarity_request(self) -> None:
        mem = _FakeMemories(retrieve_return=[])
        bank = _bank(mem, agent_engine="eng-123")

        bank.retrieve(workspace_id="ws_demo_001", query="shipping?", top_k=5)

        assert len(mem.retrieve_calls) == 1
        call = mem.retrieve_calls[0]
        assert call["name"] == (
            "projects/ss-v2-dev/locations/us-central1/reasoningEngines/eng-123"
        )
        # D26 tenancy — scope partitions on workspace_id.
        assert call["scope"] == {"workspace_id": "ws_demo_001"}
        # GA similarity params: search_query + top_k.
        assert call["similarity_search_params"] == {
            "search_query": "shipping?",
            "top_k": 5,
        }


# ─────────────────────────────────────────────────────────────────────────────
# TestRetrieveResponse — parse the SDK response onto backend-neutral rows.
# ─────────────────────────────────────────────────────────────────────────────


class TestRetrieveResponse:
    def test_parses_typed_retrieved_memories(self) -> None:
        now = dt.datetime(2026, 5, 19, tzinfo=dt.UTC)
        mem = _FakeMemories(
            retrieve_return=[
                _FakeRetrieved(
                    distance=0.25,
                    memory=_FakeMemory(
                        name="projects/p/.../memories/m1",
                        fact="creator shared a Seoul address",
                        create_time=now,
                    ),
                ),
            ]
        )
        rows = _bank(mem).retrieve(workspace_id="ws", query="q", top_k=3)
        assert len(rows) == 1
        row = rows[0]
        assert isinstance(row, RetrievedMemory)
        assert row.memory_id == "projects/p/.../memories/m1"
        assert row.fact == "creator shared a Seoul address"
        assert row.created_at == now
        assert row.distance == 0.25

    def test_parses_dict_retrieved_memories(self) -> None:
        """REST transport / tests may surface plain dicts — must still parse."""
        mem = _FakeMemories(
            retrieve_return=[
                {"distance": 0.1, "memory": {"name": "m2", "fact": "brand voice"}},
            ]
        )
        rows = _bank(mem).retrieve(workspace_id="ws", query="q", top_k=3)
        assert rows[0].memory_id == "m2"
        assert rows[0].fact == "brand voice"
        assert rows[0].distance == 0.1
        assert rows[0].created_at is None

    def test_sorted_closest_first_by_distance(self) -> None:
        mem = _FakeMemories(
            retrieve_return=[
                _FakeRetrieved(distance=0.9, memory=_FakeMemory(name="far")),
                _FakeRetrieved(distance=0.1, memory=_FakeMemory(name="near")),
                _FakeRetrieved(distance=0.5, memory=_FakeMemory(name="mid")),
            ]
        )
        rows = _bank(mem).retrieve(workspace_id="ws", query="q", top_k=3)
        assert [r.memory_id for r in rows] == ["near", "mid", "far"]

    def test_distance_maps_to_bounded_similarity(self) -> None:
        # distance 0 → similarity 1.0 ; larger distance → lower similarity.
        perfect = RetrievedMemory("m", "f", None, 0.0)
        far = RetrievedMemory("m", "f", None, 9.0)
        none = RetrievedMemory("m", "f", None, None)
        assert perfect.similarity_0_1 == 1.0
        assert 0.0 < far.similarity_0_1 < perfect.similarity_0_1
        assert none.similarity_0_1 == 0.5  # neutral when no distance

    def test_missing_memory_fields_default_safely(self) -> None:
        mem = _FakeMemories(retrieve_return=[_FakeRetrieved(distance=0.3, memory=None)])
        rows = _bank(mem).retrieve(workspace_id="ws", query="q", top_k=3)
        assert rows[0].memory_id == "mem_unknown"
        assert rows[0].fact == ""


# ─────────────────────────────────────────────────────────────────────────────
# TestCreateRequest — managed write path.
# ─────────────────────────────────────────────────────────────────────────────


class TestCreateRequest:
    def test_create_composes_request_and_returns_name(self) -> None:
        mem = _FakeMemories(
            create_return=_FakeOperation(
                response=_FakeOperationResponse(name="projects/p/.../memories/new")
            )
        )
        bank = _bank(mem, agent_engine="eng-123")

        result = bank.create(
            workspace_id="ws_demo_001",
            fact="operator approved reply",
            memory_name="conversation:reply-42",
        )

        assert len(mem.create_calls) == 1
        call = mem.create_calls[0]
        assert call["name"] == (
            "projects/ss-v2-dev/locations/us-central1/reasoningEngines/eng-123"
        )
        assert call["fact"] == "operator approved reply"
        assert call["scope"] == {"workspace_id": "ws_demo_001"}
        assert result == "projects/p/.../memories/new"

    def test_create_falls_back_to_memory_name_when_response_empty(self) -> None:
        mem = _FakeMemories(create_return=_FakeOperation(response=None))
        result = _bank(mem).create(
            workspace_id="ws", fact="f", memory_name="agent:key"
        )
        assert result == "agent:key"


# ─────────────────────────────────────────────────────────────────────────────
# TestUnavailable — typed failures the seam catches to fall back.
# ─────────────────────────────────────────────────────────────────────────────


class TestUnavailable:
    def test_retrieve_wraps_sdk_error(self) -> None:
        mem = _FakeMemories(retrieve_raises=ValueError("boom"))
        with pytest.raises(VertexMemoryBankUnavailable):
            _bank(mem).retrieve(workspace_id="ws", query="q", top_k=3)

    def test_create_wraps_sdk_error(self) -> None:
        mem = _FakeMemories(create_raises=ValueError("boom"))
        with pytest.raises(VertexMemoryBankUnavailable):
            _bank(mem).create(workspace_id="ws", fact="f", memory_name="n")

    def test_factory_without_agent_engine_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("VERTEX_AGENT_ENGINE", raising=False)
        from ss_agents.config import reset_settings_cache

        reset_settings_cache()
        with pytest.raises(VertexMemoryBankUnavailable, match="VERTEX_AGENT_ENGINE"):
            new_vertex_memory_bank()

    def test_factory_with_agent_engine_builds_bank(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("VERTEX_AGENT_ENGINE", "eng-xyz")
        from ss_agents.config import reset_settings_cache

        reset_settings_cache()
        bank = new_vertex_memory_bank()
        assert isinstance(bank, VertexMemoryBank)
        assert bank.agent_engine == "eng-xyz"
