"""Agent Memory Bank wrappers (D15 Firestore-backed).

Phase 2 ships the Firestore client + read/write contracts; Phase 4 wires
Memory Bank into prompt construction. The intake agent does NOT use memory —
each invocation is stateless — but later agents (vetting, outreach_writer,
conversation_responder) will recall creator notes + brand voice.
"""
from __future__ import annotations

from ss_agents.memory.firestore import (
    AgentMemoryBank,
    MemoryEntry,
    MemoryNotFound,
    new_memory_bank,
)
from ss_agents.memory.vertex_memory_bank import (
    RetrievedMemory,
    VertexMemoryBank,
    VertexMemoryBankUnavailable,
    new_vertex_memory_bank,
)

__all__ = [
    "AgentMemoryBank",
    "MemoryEntry",
    "MemoryNotFound",
    "RetrievedMemory",
    "VertexMemoryBank",
    "VertexMemoryBankUnavailable",
    "new_memory_bank",
    "new_vertex_memory_bank",
]
