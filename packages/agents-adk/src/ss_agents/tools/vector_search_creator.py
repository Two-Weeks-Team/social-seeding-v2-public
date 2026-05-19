"""vector_search_creator — capability layer per D41.

Semantic similarity search via Vertex AI Vector Search (D16). Implements
the `vector_search.creator` capability declared in
`gcp-research/specs/tier1/sourcing.spec.md §6`.

The sourcing agent calls this in parallel with `rapidapi.tiktok_search`:
RapidAPI returns lexical matches (hashtag / text), vector_search returns
*semantic* matches against the brand-product embedding so the union step
captures creators whose hashtags don't lexically overlap but whose niche
does (e.g. a clean-beauty creator with no `#비타민C` tag).

Stub mode (CAPABILITY_LAYER_MODE=stub, default): 10 deterministic ids
`vs_001..vs_010` with descending scores (0.99, 0.98, …, 0.90).

Live mode (CAPABILITY_LAYER_MODE=live): real Vertex AI Vector Search
`find_neighbors` call. Wired in W7 deploy phase once the index endpoint +
embedding model bind land.

Citations:
    D16 — Vertex AI Vector Search dedicated service (10M+ vectors, p99 < 50ms).
    D41 — Capability layer ADK FunctionTool stub/live pattern.
"""
from __future__ import annotations

import logging
import os

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

# Vertex AI Vector Search `find_neighbors` is ~$0.0002 per query at the
# committed-use tier (D16 service plan).
USD_COST: float = 0.0002


class VectorSearchCreatorInput(BaseModel):
    """Input contract — `vector_search.creator` per sourcing.spec.md §6.

    Two ways to drive the search:

      - `query_text` — free-text ("Korean vitamin C serum"). The live impl
        embeds this via the Vertex embedding model before the lookup.
      - `embedding`  — pre-computed embedding vector. Faster path for the
        sourcing agent which can cache the brand embedding once per brief.

    Exactly one of `query_text` / `embedding` must be provided. Validation
    enforces this so the LLM's tool-call payload can't accidentally
    underspecify.
    """

    model_config = ConfigDict(extra="forbid")

    query_text: str | None = Field(
        default=None,
        min_length=1,
        max_length=2_000,
        alias="queryText",
    )
    embedding: list[float] | None = Field(
        default=None,
        description=(
            "Pre-computed embedding vector. Length must match the deployed "
            "embedding model dimension (768 for text-embedding-005 — the "
            "live impl validates this)."
        ),
    )
    top_k: int = Field(
        default=10,
        ge=1,
        le=200,
        alias="topK",
        description="Number of nearest neighbours to return.",
    )
    min_score: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        alias="minScore",
        description="Cosine-similarity floor (results below this are dropped).",
    )

    def model_post_init(self, _: object) -> None:
        """Enforce exactly-one-of(query_text, embedding)."""
        has_text = self.query_text is not None and self.query_text.strip() != ""
        has_emb = self.embedding is not None and len(self.embedding) > 0
        if has_text == has_emb:
            raise ValueError(
                "vector_search_creator: exactly one of `queryText` or "
                "`embedding` must be provided (got "
                f"queryText={'set' if has_text else 'unset'}, "
                f"embedding={'set' if has_emb else 'unset'})"
            )


class VectorSearchCreatorHit(BaseModel):
    """One semantic neighbour — creator id + cosine score."""

    model_config = ConfigDict(extra="forbid")

    creator_id: str = Field(min_length=1, alias="creatorId")
    score: float = Field(
        ge=0.0,
        le=1.0,
        description="Cosine similarity to the query embedding (0=unrelated, 1=identical).",
    )


class VectorSearchCreatorOutput(BaseModel):
    """Output contract — `hits[]` ordered by score (highest first)."""

    model_config = ConfigDict(extra="forbid")

    hits: list[VectorSearchCreatorHit] = Field(
        default_factory=list,
        max_length=200,
    )


def vector_search_creator(
    payload: VectorSearchCreatorInput,
) -> VectorSearchCreatorOutput:
    """Find creators semantically near a brand embedding.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated search request (exactly-one-of queryText or
            embedding; topK; min_score).

    Returns:
        `hits[]` of up to `payload.top_k` creator ids ordered by descending
        cosine score, filtered by `min_score`.

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


def _stub(payload: VectorSearchCreatorInput) -> VectorSearchCreatorOutput:
    """Return 10 deterministic neighbours `vs_001..vs_010` with descending scores.

    Scores walk 0.99 → 0.90 in 0.01 steps so tests of the `min_score`
    filter can reliably trim the tail (e.g. `min_score=0.95` ⇒ 5 hits).
    The output is capped at `payload.top_k` so the agent's "ask for top-10"
    and "ask for top-3" cases differ deterministically.
    """
    full = [
        VectorSearchCreatorHit(
            creatorId=f"vs_{i:03d}",
            score=round(1.00 - (i * 0.01), 2),
        )
        for i in range(1, 11)
    ]
    # Apply min_score filter then truncate to top_k.
    filtered = [h for h in full if h.score >= payload.min_score]
    truncated = filtered[: payload.top_k]
    logger.debug(
        "vector_search_creator_stub",
        extra={
            "has_query_text": payload.query_text is not None,
            "has_embedding": payload.embedding is not None,
            "top_k": payload.top_k,
            "min_score": payload.min_score,
            "returned": len(truncated),
        },
    )
    return VectorSearchCreatorOutput(hits=truncated)


def _live(payload: VectorSearchCreatorInput) -> VectorSearchCreatorOutput:
    """Live Vertex AI Vector Search call — wired in W7 deploy phase.

    The live path will:
      1. If `query_text` set, embed via Vertex `text-embedding-005`.
      2. Call `MatchServiceClient.find_neighbors` on the deployed index
         endpoint (D16 service plan).
      3. Map `Neighbor.datapoint_id` ⇒ `creator_id`, `Neighbor.distance`
         ⇒ `1 - distance` (cosine) for the response shape.
    """
    raise NotImplementedError(
        "vector_search_creator live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


# Per-invocation cost attribute (D41 pattern).
vector_search_creator.usd_cost = USD_COST  # type: ignore[attr-defined]


__all__ = [
    "USD_COST",
    "VectorSearchCreatorHit",
    "VectorSearchCreatorInput",
    "VectorSearchCreatorOutput",
    "vector_search_creator",
]
