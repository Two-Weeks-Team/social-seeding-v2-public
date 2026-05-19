"""rapidapi_tiktok_search — capability layer per D41.

Search TikTok creators via RapidAPI. Implements the
`rapidapi.tiktok_search` capability declared in
`gcp-research/specs/tier1/sourcing.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI): returns 5
deterministic fake creators with IDs `tt_001..tt_005` so workflows can
exercise the union → dedupe → blacklist pipeline without burning RapidAPI
budget or hitting live infra.

Live mode (CAPABILITY_LAYER_MODE=live): real HTTPS call to RapidAPI. W2
ships the stub seam only; the live SDK call is wired in W7 (deploy phase)
once the secrets pipeline lands.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern (CAPABILITY_LAYER_MODE).
    D14 — RapidAPI-mediated sourcing (TikTok current; Instagram queued O3).
    D23 — Tier-1 agent #1 (sourcing) — consumer of this tool.
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

# Per-invocation USD cost estimate; `cost_watch` reads this attribute via
# `getattr(rapidapi_tiktok_search, "usd_cost", 0.0)` so it can budget agent
# runs against the per-agent cap (sourcing's $2.50 / run).
# RapidAPI TikTok endpoints quote ~$0.001 per call at the social-data tier.
USD_COST: float = 0.001


class RapidApiTiktokSearchInput(BaseModel):
    """Input contract — `rapidapi.tiktok_search` per sourcing.spec.md §6.

    Two search modes:
      - text:    free-text query (uses the product description / category)
      - hashtag: hashtag-mode query (uses the brief's hashtags)
    """

    model_config = ConfigDict(extra="forbid")

    query: str = Field(
        min_length=1,
        max_length=500,
        description=(
            "Search terms. Comma-separated for AND, space-separated for OR. "
            "In hashtag mode the leading `#` is optional."
        ),
    )
    mode: Literal["text", "hashtag"] = Field(
        default="text",
        description="`text` = free-text search, `hashtag` = hashtag-mode search.",
    )
    limit: int = Field(
        default=50,
        ge=1,
        le=200,
        description="Max creators to return (RapidAPI cap is 200).",
    )
    cursor: str | None = Field(
        default=None,
        max_length=500,
        description="Pagination cursor returned by a prior call.",
    )


class RapidApiTiktokCreator(BaseModel):
    """One creator candidate. Subset of sourcing.spec.md §2 #/$defs/TikTokCreator.

    The full creator profile (avatar, signature, engagement metrics) is
    fetched later by `tiktok.user_info`; this search response carries only
    the identity + headline metrics needed for the union step.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, description="TikTok numeric id.")
    unique_id: str = Field(
        min_length=1,
        alias="uniqueId",
        description="@handle without leading @.",
    )
    nickname: str = Field(max_length=200)
    follower_count: int = Field(ge=0, alias="followerCount")
    video_count: int = Field(ge=0, alias="videoCount")
    hashtags: list[str] = Field(default_factory=list, max_length=50)


class RapidApiTiktokSearchOutput(BaseModel):
    """Output contract — creators[] + pagination cursor."""

    model_config = ConfigDict(extra="forbid")

    creators: list[RapidApiTiktokCreator] = Field(
        default_factory=list,
        max_length=200,
    )
    next_cursor: str | None = Field(default=None, alias="nextCursor")
    query_echo: str = Field(
        min_length=1,
        alias="queryEcho",
        description="The query string as RapidAPI received it (post-normalization).",
    )


def rapidapi_tiktok_search(
    payload: RapidApiTiktokSearchInput,
) -> RapidApiTiktokSearchOutput:
    """Search TikTok creators by text or hashtag mode.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated search request.

    Returns:
        creators[] (up to `payload.limit`) + optional `nextCursor`.

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


def _stub(payload: RapidApiTiktokSearchInput) -> RapidApiTiktokSearchOutput:
    """Return 5 deterministic creators `tt_001..tt_005`.

    Determinism: the output is a pure function of `payload.query` only —
    repeated calls with the same input return byte-identical results. This
    lets the sourcing agent's `queriesUsed` invariant (no duplicates) be
    exercised offline.
    """
    # Cap at payload.limit so callers exercising small limits still see
    # the limit semantics.
    cap = min(5, payload.limit)
    creators = [
        RapidApiTiktokCreator(
            id=f"tt_{i:03d}",
            uniqueId=f"creator_{i:03d}",
            nickname=f"Stub Creator {i}",
            followerCount=10_000 * i,
            videoCount=50 * i,
            hashtags=[payload.query.strip().lstrip("#")] if payload.query.strip() else [],
        )
        for i in range(1, cap + 1)
    ]
    logger.debug(
        "rapidapi_tiktok_search_stub",
        extra={
            "query": payload.query,
            "mode": payload.mode,
            "returned": len(creators),
        },
    )
    return RapidApiTiktokSearchOutput(
        creators=creators,
        nextCursor=None,
        queryEcho=payload.query.strip(),
    )


def _live(payload: RapidApiTiktokSearchInput) -> RapidApiTiktokSearchOutput:
    """Live RapidAPI HTTPS call — wired in W7 deploy phase.

    The live path will use `ss_agents.tools.shared.make_rapidapi_client` once
    the RapidAPI secret + base URL land in the secret manager. Until then,
    any attempt to use live mode is a programmer error worth surfacing
    loudly (not silently falling back to the stub).
    """
    raise NotImplementedError(
        "rapidapi_tiktok_search live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


# Surface the per-invocation cost as a function attribute so the runtime's
# cost_watch can introspect it without importing the module-private constant.
# Pattern per D41: `def tool_fn(...): ...; tool_fn.usd_cost = USD_COST`.
rapidapi_tiktok_search.usd_cost = USD_COST  # type: ignore[attr-defined]


__all__ = [
    "RapidApiTiktokCreator",
    "RapidApiTiktokSearchInput",
    "RapidApiTiktokSearchOutput",
    "USD_COST",
    "rapidapi_tiktok_search",
]
