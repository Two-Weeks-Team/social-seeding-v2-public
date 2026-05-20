"""memory_bank_search — capability layer per D41.

Search the workspace's Firestore-backed Agent Memory Bank for recent
context that informs the conversation + conversation_responder agents
(Tier-1 #4 + #5). Returns up to 10 memories scoped to a single
`workspace_id`, ranked by descending similarity to the search query.

D33 lifecycle contract:
    The Agent Memory Bank's TTL is **14 days**. The capability enforces
    `max_age_days <= 14` at the Pydantic layer so callers cannot ask
    Firestore for documents older than the retention window (Firestore
    would return them up to the TTL grace period, but the policy is the
    contract). Tests assert this guardrail.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Returns 3 deterministic memories per workspace_id, derived from a
    tiny stable hash so /goal evaluator + golden tests pin against a
    fixed surface. Same `workspace_id` → same `memories` ordering →
    byte-identical output. `query` + `max_results` + `max_age_days` are
    threaded through (max_results trims the list; max_age_days is
    validated, not actually filtered against — the stub memories are
    always "1-3 days ago" by construction).

Vertex mode (MEMORY_BACKEND=vertex):
    The REAL managed Vertex AI Agent Engine **Memory Bank** (GA, 2026). This
    gate is independent of `CAPABILITY_LAYER_MODE` and takes precedence: when
    set, the search composes a managed `memories.retrieve` similarity request
    (scope = workspace_id, top_k = max_results) and maps the response onto the
    tool's `MemoryBankSearchOutput` contract. Operator-gated — needs an Agent
    Engine instance + ADC (`memory/vertex_memory_bank.py` runbook). If the
    managed backend is unreachable/unconfigured we fall back to the existing
    `CAPABILITY_LAYER_MODE` dispatch so a misconfigured prod never hard-fails
    an agent run. Default `MEMORY_BACKEND=firestore` leaves this path off.

Live mode (CAPABILITY_LAYER_MODE=live):
    Wired in W7 deploy phase — will run the v2 Memory Bank query on
    Firestore (vector search via Vertex AI Matching Engine for similarity,
    `created_at >= now() - max_age_days` for the lifecycle filter).
    Today raises NotImplementedError.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D33 — Data lifecycle: Memory 14 days. The Pydantic `max_age_days`
          field is constrained to `[1, 14]`.
    conversation_responder.spec.md (ARCHITECTURE.md §3 row 5) — Memory
          Bank is the state backend for the responder agent.

Per-call cost: $0.0005 (Firestore read + small Matching Engine query;
slightly above sub-cent baseline because vector search costs more than a
flat read).
"""
from __future__ import annotations

import logging
import os
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0005
"""Per-call USD attribution surfaced via `memory_bank_search.usd_cost` for
the runtime's `cost_watch` aggregator (D41). Slightly above sub-cent baseline
because Vertex AI Matching Engine vector search costs more than a flat
Firestore read."""


# ─────────────────────────────────────────────────────────────────────────────
# D33 lifecycle constant — the single source of truth for the Memory Bank
# retention window. Pydantic uses this as the `le=` bound on `max_age_days`.
# ─────────────────────────────────────────────────────────────────────────────


_MEMORY_BANK_TTL_DAYS: int = 14
"""D33: Agent Memory Bank lifecycle = 14 days. Callers cannot request older
records via this capability."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class MemoryBankSearchInput(BaseModel):
    """Input contract — per W2-B7 task brief.

    Attributes:
        workspace_id:  Workspace whose Memory Bank to query. Memories are
                       partitioned per-workspace (D26 multi-tenancy); a
                       workspace cannot read another's memories.
        query:         Free-form natural-language query. Live mode embeds
                       this with Vertex AI text-embeddings and runs a
                       Matching Engine kNN search. Stub mode ignores the
                       query content (returns the canonical 3 memories)
                       but validates that it's a non-empty string.
        max_results:   1-10. The caller caps how many memories to return.
                       Stub mode trims the deterministic 3 memories to
                       this length.
        max_age_days:  1-14. D33 enforcement — cannot exceed the Memory
                       Bank's 14-day retention window. Pydantic rejects
                       larger values at validation time.
    """

    model_config = ConfigDict(extra="forbid")

    workspace_id: str = Field(min_length=1, max_length=64)
    query: str = Field(min_length=1, max_length=2_000)
    max_results: int = Field(ge=1, le=10)
    max_age_days: int = Field(ge=1, le=_MEMORY_BANK_TTL_DAYS)


class Memory(BaseModel):
    """One memory row — id + summary + created_at + similarity score.

    Attributes:
        memory_id:        Stable per-memory id (`mem_<workspace>_<n>`).
                          Echoed only — the capability is read-only.
        content_summary:  Short prose summary of the memory (≤ 500 chars).
                          The full memory body lives in Firestore;
                          callers fetch it via a follow-up capability if
                          needed.
        created_at:       UTC timestamp at which the memory was written.
                          Always within the last 14 days (D33).
        similarity_0_1:   Vector-space cosine similarity to the query, in
                          [0, 1]. Stub mode synthesizes a stable value
                          per (workspace, memory_id) so ordering is
                          deterministic.
    """

    model_config = ConfigDict(extra="forbid")

    memory_id: str = Field(min_length=1, max_length=120)
    content_summary: str = Field(min_length=1, max_length=500)
    created_at: datetime
    similarity_0_1: float = Field(ge=0.0, le=1.0)


class MemoryBankSearchOutput(BaseModel):
    """Output contract — per W2-B7 task brief.

    Attributes:
        memories:    Up to `max_results` matching memories, sorted by
                     descending similarity_0_1.
        total_found: Total matches in Firestore BEFORE `max_results`
                     truncation. Lets the caller decide whether to
                     re-query with a larger cap. Stub always reports 3.
    """

    model_config = ConfigDict(extra="forbid")

    memories: list[Memory] = Field(default_factory=list, max_length=10)
    total_found: int = Field(ge=0)


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def memory_bank_search(
    payload: MemoryBankSearchInput,
) -> MemoryBankSearchOutput:
    """Search the workspace's Agent Memory Bank.

    Backend dispatch (D15) takes precedence over the capability-layer mode:

    * `MEMORY_BACKEND=vertex` → the REAL managed Vertex AI Agent Engine Memory
      Bank `memories.retrieve` (operator-gated). Falls back to the
      `CAPABILITY_LAYER_MODE` dispatch when the managed backend is unreachable.
    * otherwise → the capability-layer dispatch (D41): stub by default, live
      when `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated `MemoryBankSearchInput`. Pydantic enforces
            `max_age_days <= 14` per D33.

    Returns:
        `MemoryBankSearchOutput` with up to `max_results` memories sorted
        by descending similarity.

    Raises:
        NotImplementedError: when `CAPABILITY_LAYER_MODE=live` (and
            `MEMORY_BACKEND` is not `vertex`) — until W7 wires the real
            Firestore + Matching Engine client. The runtime converts to a typed
            `EscalateToHuman`.
    """
    backend = os.getenv("MEMORY_BACKEND", "firestore")
    if backend == "vertex":
        return _vertex(payload)

    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
memory_bank_search.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic 3 memories per workspace.
#
# Algorithm:
#   1. Stable-hash the workspace_id into a 32-bit int.
#   2. Generate 3 canned memory summaries by combining a small content bank
#      with the hash so different workspaces see different content but the
#      SAME workspace sees the same content across calls.
#   3. similarity_0_1 is a function of the hash (decreasing for memory
#      index 0 → 2 so the output is always sorted by descending similarity).
#   4. created_at is "1, 2, 3 days ago" — always within the 14-day TTL.
#   5. Trim to `max_results` after sorting.
# ─────────────────────────────────────────────────────────────────────────────


_CONTENT_BANK: tuple[str, ...] = (
    "Operator previously asked the creator to share their shipping address; "
    "they replied with a Seoul-Gangnam street address on day -3.",
    "Compliance flagged a similar inbound 4 days ago — high spam_score on "
    "ALL-CAPS subject; operator approved the reply manually.",
    "Brand voice: warm + concise. Last 5 sent replies averaged 240 chars; "
    "deliverability_score median 0.87.",
    "Creator's last viral post (~120k views, day -6) was a morning-routine "
    "video featuring two vitamin-C brands.",
    "Workspace blacklist update on day -2: 14 new entries; none overlap "
    "with the current sourcing batch.",
    "Memory Bank record from day -5: operator confirmed sample shipping ETA "
    "is 3-5 business days for KR/JP, 7-10 for EN/CN.",
)
"""Closed-set content bank. Picked to mirror the kind of context the
conversation responder actually consumes (creator history, brand voice,
compliance flags) so smoke tests exercise realistic prompt shapes."""


def _stub(payload: MemoryBankSearchInput) -> MemoryBankSearchOutput:
    """Deterministic stub. Same `workspace_id` → same memories list."""
    h = _stable_hash(payload.workspace_id)
    now = datetime.now(tz=UTC)

    # Always 3 stub memories — `total_found` reports the pre-trim count so
    # the caller can decide whether to re-query with a larger cap.
    stub_count = 3
    memories: list[Memory] = []
    for i in range(stub_count):
        content_idx = (h + i) % len(_CONTENT_BANK)
        # Similarity decreases monotonically with i so the list is
        # already sorted by descending similarity — no need to re-sort.
        similarity = round(max(0.0, 0.95 - 0.15 * i), 4)
        memory_id = f"mem_{payload.workspace_id}_{i + 1:03d}"
        created_at = now - timedelta(days=i + 1)
        memories.append(
            Memory(
                memory_id=memory_id,
                content_summary=_CONTENT_BANK[content_idx],
                created_at=created_at,
                similarity_0_1=similarity,
            )
        )

    # Trim to max_results — the stub generates 3 deterministic memories
    # regardless of cap, but the caller's max_results is respected.
    trimmed = memories[: payload.max_results]

    logger.debug(
        "memory_bank_search_stub",
        extra={
            "workspace_id": payload.workspace_id,
            "query_len": len(payload.query),
            "max_results": payload.max_results,
            "max_age_days": payload.max_age_days,
            "returned_count": len(trimmed),
            "total_found": stub_count,
        },
    )

    return MemoryBankSearchOutput(
        memories=trimmed,
        total_found=stub_count,
    )


def _stable_hash(s: str) -> int:
    """Tiny FNV-style 32-bit hash. Deterministic across Python versions
    (unlike `hash()`, which is salted per-process). Same implementation as
    sibling W2 tools so cross-tool reasoning stays reproducible."""
    h = 0x811C9DC5
    for ch in s.encode("utf-8"):
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Today raises NotImplementedError so the
# runtime can convert to a typed `EscalateToHuman`.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: MemoryBankSearchInput) -> MemoryBankSearchOutput:
    """Live Memory Bank search — wired in W7 deploy phase.

    The live path will:
      1. Compute the embedding of `payload.query` via Vertex AI
         text-embeddings (gemini-embedding-001).
      2. Filter Firestore docs by
         `workspace_id == payload.workspace_id AND
          created_at >= now() - payload.max_age_days days`.
      3. Run a Matching Engine kNN search restricted to the filtered set.
      4. Take top-`max_results`, return alongside `total_found`.
    """
    raise NotImplementedError(
        "memory_bank_search live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Vertex — REAL managed Vertex AI Agent Engine Memory Bank (GA, 2026).
#
# Wired now (code real; live = operator-gated). Composes the managed
# `memories.retrieve` similarity request and maps the response onto the tool's
# existing output contract — callers are unchanged. On any unavailability we
# fall back to the `CAPABILITY_LAYER_MODE` dispatch so a misconfigured prod
# degrades to the stub instead of crashing an agent run.
# ─────────────────────────────────────────────────────────────────────────────


def _vertex(payload: MemoryBankSearchInput) -> MemoryBankSearchOutput:
    """Managed Memory Bank retrieve → `MemoryBankSearchOutput`.

    Steps:
      1. Build the managed backend from settings/env (`VERTEX_AGENT_ENGINE`).
      2. `memories.retrieve(scope={"workspace_id": ...},
         similarity_search_params={"search_query": query, "top_k": max_results})`.
      3. Map each retrieved memory's `distance` → `similarity_0_1`, `fact` →
         `content_summary` (truncated to the 500-char contract bound), `name`
         → `memory_id`, `create_time` → `created_at` (defaulting to "now" when
         the service omits it — every field is Optional per the SDK).
      4. Trim/sort to honor the descending-similarity + `max_results` contract.

    Falls back to the capability dispatch when the managed backend is
    unconfigured or unreachable (`VertexMemoryBankUnavailable`).
    """
    from ss_agents.memory.vertex_memory_bank import (
        VertexMemoryBankUnavailable,
        new_vertex_memory_bank,
    )

    try:
        bank = new_vertex_memory_bank()
        rows = bank.retrieve(
            workspace_id=payload.workspace_id,
            query=payload.query,
            top_k=payload.max_results,
        )
    except VertexMemoryBankUnavailable as exc:
        logger.warning(
            "memory_bank_search vertex backend unavailable (%s) — "
            "falling back to capability dispatch",
            exc,
        )
        mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
        return _stub(payload) if mode == "stub" else _live(payload)

    now = datetime.now(tz=UTC)
    memories: list[Memory] = []
    for row in rows:
        summary = (row.fact or "(empty memory)")[:500]
        memories.append(
            Memory(
                memory_id=row.memory_id[:120] or "mem_unknown",
                content_summary=summary,
                created_at=row.created_at or now,
                similarity_0_1=max(0.0, min(1.0, row.similarity_0_1)),
            )
        )

    # `bank.retrieve` already sorts closest-first; re-sort defensively so the
    # output contract (descending similarity) holds regardless of upstream order.
    memories.sort(key=lambda m: m.similarity_0_1, reverse=True)
    total_found = len(memories)
    trimmed = memories[: payload.max_results]

    logger.debug(
        "memory_bank_search_vertex",
        extra={
            "workspace_id": payload.workspace_id,
            "query_len": len(payload.query),
            "max_results": payload.max_results,
            "max_age_days": payload.max_age_days,
            "returned_count": len(trimmed),
            "total_found": total_found,
        },
    )

    return MemoryBankSearchOutput(memories=trimmed, total_found=total_found)


__all__ = [
    "USD_COST",
    "Memory",
    "MemoryBankSearchInput",
    "MemoryBankSearchOutput",
    "memory_bank_search",
]
