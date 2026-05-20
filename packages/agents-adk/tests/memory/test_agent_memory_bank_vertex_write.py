"""tests/memory/test_agent_memory_bank_vertex_write.py — D15 managed write path.

Offline only — no Firestore, no network. Verifies that `AgentMemoryBank.put`:
  * mirrors the write to the managed Vertex Memory Bank when MEMORY_BACKEND=vertex,
  * does NOT touch the managed backend on the default (firestore) backend,
  * never loses the write even when the managed mirror fails (best-effort),
  * keeps the existing in-memory fallback contract intact.
"""
from __future__ import annotations

import json
from typing import Any

import pytest

import ss_agents.memory.firestore as fs
import ss_agents.memory.vertex_memory_bank as vmb
from ss_agents.memory.firestore import AgentMemoryBank, MemoryEntry
from ss_agents.memory.vertex_memory_bank import VertexMemoryBankUnavailable


class _RecordingBank:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def create(self, *, workspace_id: str, fact: str, memory_name: str) -> str:
        self.calls.append(
            {"workspace_id": workspace_id, "fact": fact, "memory_name": memory_name}
        )
        return "projects/p/.../memories/written"


@pytest.fixture
def _bank_no_firestore(monkeypatch: pytest.MonkeyPatch) -> AgentMemoryBank:
    """AgentMemoryBank whose Firestore client is forced to the in-memory path."""
    bank = AgentMemoryBank(project="ss-v2-dev")
    monkeypatch.setattr(type(bank), "client", property(lambda self: None))
    return bank


class TestVertexWriteMirror:
    async def test_put_mirrors_to_vertex_when_gated(
        self, monkeypatch: pytest.MonkeyPatch, _bank_no_firestore: AgentMemoryBank
    ) -> None:
        recorder = _RecordingBank()
        monkeypatch.setattr(vmb, "new_vertex_memory_bank", lambda: recorder)
        monkeypatch.setenv("MEMORY_BACKEND", "vertex")

        entry = await _bank_no_firestore.put(
            tenant_id="t1",
            workspace_id="ws1",
            agent_id="conversation_responder",
            key="reply-42",
            payload={"draft": "hello"},
        )

        # The durable in-memory store still holds the entry (write not lost).
        assert isinstance(entry, MemoryEntry)
        # Managed mirror got the workspace scope + a JSON fact + a traceable name.
        assert len(recorder.calls) == 1
        call = recorder.calls[0]
        assert call["workspace_id"] == "ws1"
        assert call["memory_name"] == "conversation_responder:reply-42"
        decoded = json.loads(call["fact"])
        assert decoded["payload"] == {"draft": "hello"}
        assert decoded["tenant_id"] == "t1"

    async def test_put_does_not_mirror_on_default_backend(
        self, monkeypatch: pytest.MonkeyPatch, _bank_no_firestore: AgentMemoryBank
    ) -> None:
        def _boom() -> Any:  # pragma: no cover — must never be called
            raise AssertionError("vertex backend must not be constructed")

        monkeypatch.setattr(vmb, "new_vertex_memory_bank", _boom)
        monkeypatch.delenv("MEMORY_BACKEND", raising=False)  # default firestore

        entry = await _bank_no_firestore.put(
            tenant_id="t1",
            workspace_id="ws1",
            agent_id="a",
            key="k",
            payload={"x": 1},
        )
        assert entry.payload == {"x": 1}

    async def test_put_survives_managed_mirror_failure(
        self, monkeypatch: pytest.MonkeyPatch, _bank_no_firestore: AgentMemoryBank
    ) -> None:
        def _raise() -> Any:
            raise VertexMemoryBankUnavailable("no engine configured")

        monkeypatch.setattr(vmb, "new_vertex_memory_bank", _raise)
        monkeypatch.setenv("MEMORY_BACKEND", "vertex")

        # Must NOT raise — the durable write still succeeds.
        entry = await _bank_no_firestore.put(
            tenant_id="t1",
            workspace_id="ws1",
            agent_id="a",
            key="k",
            payload={"x": 2},
        )
        assert entry.payload == {"x": 2}
        # And the entry is readable back from the in-memory fallback.
        got = await _bank_no_firestore.get(
            tenant_id="t1", workspace_id="ws1", agent_id="a", key="k"
        )
        assert got.payload == {"x": 2}


class TestDefaultPathUnchanged:
    async def test_get_after_put_roundtrips_in_memory(
        self, monkeypatch: pytest.MonkeyPatch, _bank_no_firestore: AgentMemoryBank
    ) -> None:
        monkeypatch.delenv("MEMORY_BACKEND", raising=False)
        await _bank_no_firestore.put(
            tenant_id="t", workspace_id="w", agent_id="a", key="k",
            payload={"v": "ok"},
        )
        got = await _bank_no_firestore.get(
            tenant_id="t", workspace_id="w", agent_id="a", key="k"
        )
        assert got.payload == {"v": "ok"}

    def test_firestore_module_exports_unchanged(self) -> None:
        # Sanity: the public contract symbols are still importable as before.
        assert hasattr(fs, "AgentMemoryBank")
        assert hasattr(fs, "MemoryEntry")
        assert hasattr(fs, "MemoryNotFound")
        assert hasattr(fs, "new_memory_bank")
