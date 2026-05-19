"""Firestore-backed Agent Memory Bank wrapper.

Maps onto:
    Collection:  v2_memory
    Document id: {tenant_id}/{workspace_id}/{agent_id}/{key}

Per D33:
    PII   30 d  (handled by Firestore TTL on `pii_at`).
    Audit 90 d  (audit lives in BigQuery, not here).
    Memory 14 d (TTL on `created_at`).

Per ADK-GUIDE.md §2.3:
    "Memory Bank is a credible replacement for the bespoke 'creator notes' RAG
    used in v1 vetting — but it is still Preview, so only viable on a 90-day
    demo horizon." We keep the door open by talking to the Vertex Memory Bank
    service when available (preview); fall back to direct Firestore when not.
"""
from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


class MemoryNotFound(KeyError):
    """Raised when a `get(...)` call has no entry. Callers catch + handle."""


@dataclass(frozen=True)
class MemoryEntry:
    """One memory record. Mirrors the v1 'creator notes' row layout."""

    tenant_id: str
    workspace_id: str
    agent_id: str
    key: str
    payload: dict[str, Any]
    created_at: dt.datetime
    expires_at: dt.datetime


class AgentMemoryBank:
    """Firestore-backed key→payload store with 14-day TTL per D33.

    Phase 2 keeps the API stable and offers an in-memory fallback so unit tests
    pass without a live Firestore. Phase 4 switches the production code path to
    Vertex AI Memory Bank (preview) once the project is allowlisted (O7).
    """

    def __init__(self, *, project: str, database: str = "(default)"):
        self.project = project
        self.database = database
        self._client: Any | None = None
        # Fallback in-memory store keyed by full document path.
        self._in_memory: dict[str, MemoryEntry] = {}

    @property
    def client(self) -> Any | None:
        """Lazy Firestore client. Returns None if google-cloud-firestore is
        not installed or auth is unavailable — in which case we fall back to
        the in-memory store."""
        if self._client is not None:
            return self._client
        try:
            from google.cloud import firestore  # type: ignore[import-untyped]

            self._client = firestore.Client(project=self.project, database=self.database)
            return self._client
        except Exception as exc:  # pragma: no cover — env-dependent
            logger.info(
                "firestore unavailable (%s) — using in-memory fallback for AgentMemoryBank",
                exc,
            )
            return None

    # ── Public API ──────────────────────────────────────────────────────────

    async def put(
        self,
        *,
        tenant_id: str,
        workspace_id: str,
        agent_id: str,
        key: str,
        payload: dict[str, Any],
        ttl_days: int = 14,
    ) -> MemoryEntry:
        """Write/overwrite a memory entry. TTL enforced via `expires_at`."""
        now = dt.datetime.now(tz=dt.UTC)
        entry = MemoryEntry(
            tenant_id=tenant_id,
            workspace_id=workspace_id,
            agent_id=agent_id,
            key=key,
            payload=payload,
            created_at=now,
            expires_at=now + dt.timedelta(days=ttl_days),
        )
        path = self._doc_path(tenant_id, workspace_id, agent_id, key)
        client = self.client
        if client is None:
            self._in_memory[path] = entry
            return entry
        # Real Firestore path. The collection-group `v2_memory` has a TTL
        # policy on `expires_at` configured at infra time.
        doc = client.document(path)
        doc.set(
            {
                "tenant_id": tenant_id,
                "workspace_id": workspace_id,
                "agent_id": agent_id,
                "key": key,
                "payload": payload,
                "created_at": entry.created_at,
                "expires_at": entry.expires_at,
            }
        )
        return entry

    async def get(
        self,
        *,
        tenant_id: str,
        workspace_id: str,
        agent_id: str,
        key: str,
    ) -> MemoryEntry:
        """Read a memory entry. Raises `MemoryNotFound` when absent."""
        path = self._doc_path(tenant_id, workspace_id, agent_id, key)
        client = self.client
        if client is None:
            entry = self._in_memory.get(path)
            if entry is None:
                raise MemoryNotFound(path)
            if entry.expires_at < dt.datetime.now(tz=dt.UTC):
                del self._in_memory[path]
                raise MemoryNotFound(path)
            return entry
        snap = client.document(path).get()
        if not snap.exists:
            raise MemoryNotFound(path)
        data = snap.to_dict() or {}
        return MemoryEntry(
            tenant_id=data["tenant_id"],
            workspace_id=data["workspace_id"],
            agent_id=data["agent_id"],
            key=data["key"],
            payload=data.get("payload", {}),
            created_at=data["created_at"],
            expires_at=data["expires_at"],
        )

    async def delete(
        self,
        *,
        tenant_id: str,
        workspace_id: str,
        agent_id: str,
        key: str,
    ) -> None:
        """Delete a memory entry (no-op if missing)."""
        path = self._doc_path(tenant_id, workspace_id, agent_id, key)
        client = self.client
        if client is None:
            self._in_memory.pop(path, None)
            return
        client.document(path).delete()

    # ── Internal ────────────────────────────────────────────────────────────

    @staticmethod
    def _doc_path(tenant_id: str, workspace_id: str, agent_id: str, key: str) -> str:
        # 4-level path keeps tenant isolation enforceable via Firestore rules.
        return (
            f"v2_memory/{tenant_id}/workspaces/{workspace_id}"
            f"/agents/{agent_id}/keys/{key}"
        )


def new_memory_bank(project: str | None = None) -> AgentMemoryBank:
    """Factory — reads `project` from settings if not supplied."""
    if project is None:
        from ss_agents.config import get_settings

        project = get_settings().google_cloud_project
    return AgentMemoryBank(project=project)


__all__ = ["AgentMemoryBank", "MemoryEntry", "MemoryNotFound", "new_memory_bank"]
