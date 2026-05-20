"""Managed Vertex AI Agent Engine **Memory Bank** backend (GA, 2026).

This module is the REAL managed-memory backend the project switches to when
``MEMORY_BACKEND=vertex``. It talks to the Vertex AI Agent Engine *Memory Bank*
surface — GA in ``google-cloud-aiplatform`` (the ``vertexai`` SDK) via::

    client = vertexai.Client(project=..., location=...)
    client.agent_engines.memories.retrieve(name=<engine>, scope={...}, ...)
    client.agent_engines.memories.create(name=<engine>, fact=..., scope={...})
    client.agent_engines.memories.generate(name=<engine>, ..., scope={...})

API shape (verified against ``google-cloud-aiplatform`` 1.153.1 +
Vertex AI docs "Agent Engine Memory Bank"):

* ``memories.retrieve(name, scope, similarity_search_params={"search_query",
  "top_k"})`` → iterable of ``RetrieveMemoriesResponseRetrievedMemory`` with
  ``.distance`` (smaller == closer) and ``.memory`` (a ``Memory`` with
  ``.name`` / ``.fact`` / ``.create_time``).
* ``memories.create(name, fact, scope)`` → an ``AgentEngineMemoryOperation``.
* ``name`` is the Agent Engine (reasoning engine) resource:
  ``projects/{p}/locations/{l}/reasoningEngines/{id}``.
* ``scope`` is the partitioning dict — we key it on ``{"workspace_id": ...}``
  to preserve the v1/D26 per-workspace tenancy boundary.

D33 retention: managed Memory Bank applies the engine-level TTL; we additionally
honor the same 14-day query window the capability contract enforces by passing
``top_k`` and never requesting beyond the contract's ``max_age_days`` bound
(the bound itself is validated upstream at the Pydantic layer).

Honest scope: this code is real and exercised offline against a mocked SDK.
Going live is **operator-gated** — it needs an Agent Engine instance with a
``MemoryBankConfig`` (+ ``SimilaritySearchConfig`` for similarity retrieval) and
Application Default Credentials. See ``new_vertex_memory_bank`` and the module
docstring in ``memory_bank_search`` for the operator runbook. Firestore stays
the default backend so offline/CI is unaffected.
"""
from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


class VertexMemoryBankUnavailable(RuntimeError):  # noqa: N818 — descriptive name matches sibling MemoryNotFound
    """Raised when the managed Memory Bank backend cannot be reached.

    The caller (capability seam) converts this into the contract's safe
    fallback (empty result / Firestore) rather than crashing the agent run.
    """


@dataclass(frozen=True)
class RetrievedMemory:
    """One memory returned by the managed Memory Bank retrieve call.

    Backend-neutral shape so the capability seam can map it onto its own
    Pydantic ``Memory`` contract without leaking the SDK's types.

    Attributes:
        memory_id:   Stable resource name of the memory (SDK ``Memory.name``),
                     or a synthesized id when the service omitted one.
        fact:        The semantic fact text stored in the memory.
        created_at:  UTC creation time, when the service provides it.
        distance:    Vector distance from the query — *smaller is closer*.
                     ``None`` when retrieval was not similarity-based.
    """

    memory_id: str
    fact: str
    created_at: dt.datetime | None
    distance: float | None

    @property
    def similarity_0_1(self) -> float:
        """Map the SDK ``distance`` onto a [0, 1] similarity score.

        Memory Bank returns a distance where *smaller means more similar*. We
        map it monotonically to a bounded similarity so the capability layer's
        ``similarity_0_1`` contract (descending = better) is preserved::

            similarity = 1 / (1 + distance)

        ``distance == 0`` → 1.0 (perfect), large distance → ~0.0. When no
        distance is provided (non-similarity retrieval) we surface a neutral
        0.5 so ordering is stable and the field stays in-contract.
        """
        if self.distance is None:
            return 0.5
        d = max(0.0, float(self.distance))
        return round(1.0 / (1.0 + d), 6)


class VertexMemoryBank:
    """Thin, typed wrapper over the managed Vertex AI Memory Bank surface.

    The wrapper owns: client construction (lazy), request composition for the
    GA ``memories.retrieve`` / ``memories.create`` calls, and response parsing
    into backend-neutral :class:`RetrievedMemory` rows.

    It deliberately does NOT import ``vertexai`` at module import time — the
    import is lazy inside :pyattr:`client` so the package loads (and all
    offline tests run) with no network and without forcing the SDK onto the
    stub/Firestore code paths.
    """

    def __init__(
        self,
        *,
        project: str,
        location: str,
        agent_engine: str,
        client: Any | None = None,
    ) -> None:
        """Construct the wrapper.

        Args:
            project:       GCP project id.
            location:      Vertex AI region (e.g. ``us-central1``).
            agent_engine:  The Agent Engine (reasoning engine) resource that
                           owns the Memory Bank. Accepts either the bare id or
                           a full ``projects/.../reasoningEngines/{id}``
                           resource path; :meth:`engine_resource` normalizes it.
            client:        Pre-built ``vertexai.Client`` (used by tests to inject
                           a mock). When ``None`` the client is built lazily via
                           Application Default Credentials.
        """
        self.project = project
        self.location = location
        self.agent_engine = agent_engine
        self._client = client

    # ── Client / resource helpers ─────────────────────────────────────────

    @property
    def client(self) -> Any:
        """Lazy ``vertexai.Client``. Raises :class:`VertexMemoryBankUnavailable`
        when the SDK is missing or the client cannot be constructed (e.g. no
        ADC). The capability seam catches this and falls back safely."""
        if self._client is not None:
            return self._client
        try:
            import vertexai

            self._client = vertexai.Client(
                project=self.project,
                location=self.location,
            )
            return self._client
        except Exception as exc:  # pragma: no cover — env-dependent
            raise VertexMemoryBankUnavailable(
                f"vertexai Memory Bank client unavailable: {exc}"
            ) from exc

    def engine_resource(self) -> str:
        """Return the fully-qualified Agent Engine resource name.

        Memory Bank ``retrieve``/``create`` take ``name=`` as the owning
        reasoning-engine resource. We accept a bare id for ergonomics and
        expand it here so callers never have to assemble the path.
        """
        if "/" in self.agent_engine:
            return self.agent_engine
        return (
            f"projects/{self.project}/locations/{self.location}"
            f"/reasoningEngines/{self.agent_engine}"
        )

    @staticmethod
    def _scope(workspace_id: str) -> dict[str, str]:
        """Per-workspace scope dict (D26 tenancy). Memory Bank partitions all
        reads/writes on this scope so one workspace cannot see another's
        memories — the managed equivalent of the 4-level Firestore path."""
        return {"workspace_id": workspace_id}

    # ── Retrieve (read path — backs memory_bank_search vertex mode) ────────

    def retrieve(
        self,
        *,
        workspace_id: str,
        query: str,
        top_k: int,
    ) -> list[RetrievedMemory]:
        """Similarity-retrieve memories from the managed Memory Bank.

        Composes the GA request::

            memories.retrieve(
                name=<reasoningEngine>,
                scope={"workspace_id": workspace_id},
                similarity_search_params={"search_query": query, "top_k": top_k},
            )

        and parses the iterable of ``RetrieveMemoriesResponseRetrievedMemory``
        into backend-neutral :class:`RetrievedMemory` rows sorted by ascending
        ``distance`` (closest first).

        Args:
            workspace_id:  Tenancy scope key.
            query:         Natural-language similarity query.
            top_k:         Max memories to return (the SDK caps at 100).

        Returns:
            ``RetrievedMemory`` rows, closest-first.

        Raises:
            VertexMemoryBankUnavailable: when the SDK call fails. The caller
                converts this into a safe fallback.
        """
        try:
            results = self.client.agent_engines.memories.retrieve(
                name=self.engine_resource(),
                scope=self._scope(workspace_id),
                similarity_search_params={
                    "search_query": query,
                    "top_k": top_k,
                },
            )
        except VertexMemoryBankUnavailable:
            raise
        except Exception as exc:  # pragma: no cover — network/SDK-dependent
            raise VertexMemoryBankUnavailable(
                f"Memory Bank retrieve failed: {exc}"
            ) from exc

        rows = [self._parse_retrieved(r) for r in results]
        # SDK distance: smaller == closer. Stable sort, closest first; None
        # distances (non-similarity) sink to the end deterministically.
        rows.sort(key=lambda r: (r.distance is None, r.distance or 0.0))
        return rows

    @staticmethod
    def _parse_retrieved(raw: Any) -> RetrievedMemory:
        """Parse one ``RetrieveMemoriesResponseRetrievedMemory`` (or dict).

        Tolerates both the typed SDK object and a plain dict (what tests inject
        and what the REST transport may surface), reading ``distance`` and the
        nested ``memory`` (``name`` / ``fact`` / ``create_time``).
        """
        distance = _getattr_or_key(raw, "distance")
        memory = _getattr_or_key(raw, "memory")

        name = _getattr_or_key(memory, "name")
        fact = _getattr_or_key(memory, "fact")
        created = _getattr_or_key(memory, "create_time")

        return RetrievedMemory(
            memory_id=str(name) if name else "mem_unknown",
            fact=str(fact) if fact is not None else "",
            created_at=created if isinstance(created, dt.datetime) else None,
            distance=float(distance) if distance is not None else None,
        )

    # ── Create (write path — backs AgentMemoryBank vertex mode) ────────────

    def create(
        self,
        *,
        workspace_id: str,
        fact: str,
        memory_name: str,
    ) -> str:
        """Write a memory via the managed ``memories.create`` API.

        Args:
            workspace_id:  Tenancy scope key.
            fact:          The semantic fact to store.
            memory_name:   Caller-chosen logical name for the memory.

        Returns:
            The created memory's resource name (or ``memory_name`` echo when the
            operation response omits it).

        Raises:
            VertexMemoryBankUnavailable: when the SDK call fails.
        """
        try:
            operation = self.client.agent_engines.memories.create(
                name=self.engine_resource(),
                fact=fact,
                scope=self._scope(workspace_id),
            )
        except VertexMemoryBankUnavailable:
            raise
        except Exception as exc:  # pragma: no cover — network/SDK-dependent
            raise VertexMemoryBankUnavailable(
                f"Memory Bank create failed: {exc}"
            ) from exc

        response = _getattr_or_key(operation, "response")
        created_name = _getattr_or_key(response, "name") if response else None
        return str(created_name) if created_name else memory_name


def _getattr_or_key(obj: Any, field: str) -> Any:
    """Read ``field`` from either an attribute (typed SDK model) or a mapping
    key (dict). Returns ``None`` when absent — the SDK marks every memory field
    ``Optional`` so we never assume presence."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(field)
    return getattr(obj, field, None)


def new_vertex_memory_bank(
    *,
    project: str | None = None,
    location: str | None = None,
    agent_engine: str | None = None,
) -> VertexMemoryBank:
    """Factory — fills project/location/agent-engine from settings/env.

    Operator runbook to go live (all operator-gated; no live call here):
        1. Create an Agent Engine instance with a Memory Bank config (and a
           ``SimilaritySearchConfig`` for similarity retrieval).
        2. Export ``VERTEX_AGENT_ENGINE`` (the reasoning-engine id or resource).
        3. Provide Application Default Credentials (``gcloud auth
           application-default login`` or a service account) for the project.
        4. Set ``MEMORY_BACKEND=vertex``.
    Until then the default ``MEMORY_BACKEND`` stays ``firestore`` / ``stub``.

    Raises:
        VertexMemoryBankUnavailable: when no Agent Engine resource is
            configured — the seam treats this as "not live" and falls back.
    """
    from ss_agents.config import get_settings

    settings = get_settings()
    project = project or settings.google_cloud_project
    location = location or settings.google_cloud_location
    agent_engine = agent_engine or settings.vertex_agent_engine

    if not agent_engine:
        raise VertexMemoryBankUnavailable(
            "MEMORY_BACKEND=vertex requires VERTEX_AGENT_ENGINE "
            "(the Agent Engine reasoning-engine id or resource). "
            "Falling back — see operator runbook in vertex_memory_bank.py."
        )

    return VertexMemoryBank(
        project=project,
        location=location,
        agent_engine=agent_engine,
    )


__all__ = [
    "RetrievedMemory",
    "VertexMemoryBank",
    "VertexMemoryBankUnavailable",
    "new_vertex_memory_bank",
]
