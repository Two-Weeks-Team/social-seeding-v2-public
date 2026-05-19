"""rapidapi_instagram_search — capability layer per D41.

Search Instagram creators via RapidAPI. Implements the
`rapidapi.instagram_search` capability declared in
`gcp-research/specs/tier1/sourcing.spec.md §6`.

**O3 outstanding** — per D14, the Instagram sourcing path is queued behind
an email-base feasibility study (Task #21). The agent's system prompt
already instructs Gemini NOT to call this tool, but we ship the seam so:

  1. The capability layer's tool registry contains a complete entry
     (the agent's `tools=[...]` list reflects the spec — `tools=[]` would
     drift from sourcing.spec.md §6's 4-tool table).
  2. Live mode raises a clear "O3 pending" message rather than silently
     making a billed RapidAPI call against an endpoint we have not vetted.
  3. Stub mode returns deterministic data so existing tests + workflows
     can dry-run the Instagram branch behind a feature flag.

Stub mode (CAPABILITY_LAYER_MODE=stub, default): 5 fake creators
`ig_001..ig_005` (parallel to the TikTok stub).

Live mode (CAPABILITY_LAYER_MODE=live): raises NotImplementedError citing
O3 — only flips once the feasibility study green-lights the path.

Citations:
    D14 — RapidAPI sourcing; Instagram queued (O3 feasibility study).
    D41 — Capability layer ADK FunctionTool stub/live pattern.
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

# Per-invocation USD cost estimate. Instagram endpoint pricing is currently
# a placeholder — re-evaluate when O3 completes.
USD_COST: float = 0.002


class RapidApiInstagramSearchInput(BaseModel):
    """Input contract — Instagram search (mirrors TikTok shape for symmetry)."""

    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=500)
    mode: Literal["text", "hashtag"] = "text"
    limit: int = Field(default=50, ge=1, le=200)
    cursor: str | None = Field(default=None, max_length=500)


class RapidApiInstagramCreator(BaseModel):
    """One Instagram creator candidate (search response subset)."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, description="Instagram numeric id.")
    username: str = Field(
        min_length=1,
        description="@handle without leading @ (mirrors TikTok `uniqueId`).",
    )
    full_name: str = Field(default="", max_length=200, alias="fullName")
    follower_count: int = Field(ge=0, alias="followerCount")
    media_count: int = Field(ge=0, alias="mediaCount")
    hashtags: list[str] = Field(default_factory=list, max_length=50)


class RapidApiInstagramSearchOutput(BaseModel):
    """Output contract — creators[] + pagination cursor."""

    model_config = ConfigDict(extra="forbid")

    creators: list[RapidApiInstagramCreator] = Field(
        default_factory=list,
        max_length=200,
    )
    next_cursor: str | None = Field(default=None, alias="nextCursor")
    query_echo: str = Field(min_length=1, alias="queryEcho")


def rapidapi_instagram_search(
    payload: RapidApiInstagramSearchInput,
) -> RapidApiInstagramSearchOutput:
    """Search Instagram creators — O3 pending in live mode.

    Capability-layer dispatch (D41): stub by default, live raises clear
    "O3 pending" error.

    Args:
        payload: Validated search request.

    Returns:
        creators[] (5 stubs in stub mode).

    Raises:
        NotImplementedError: live mode — O3 (D14 feasibility study) must
            complete before this path can be enabled.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


def _stub(payload: RapidApiInstagramSearchInput) -> RapidApiInstagramSearchOutput:
    """Return 5 deterministic creators `ig_001..ig_005`."""
    cap = min(5, payload.limit)
    creators = [
        RapidApiInstagramCreator(
            id=f"ig_{i:03d}",
            username=f"ig_creator_{i:03d}",
            fullName=f"Stub IG Creator {i}",
            followerCount=20_000 * i,
            mediaCount=120 * i,
            hashtags=(
                [payload.query.strip().lstrip("#")] if payload.query.strip() else []
            ),
        )
        for i in range(1, cap + 1)
    ]
    logger.debug(
        "rapidapi_instagram_search_stub",
        extra={
            "query": payload.query,
            "mode": payload.mode,
            "returned": len(creators),
        },
    )
    return RapidApiInstagramSearchOutput(
        creators=creators,
        nextCursor=None,
        queryEcho=payload.query.strip(),
    )


def _live(payload: RapidApiInstagramSearchInput) -> RapidApiInstagramSearchOutput:
    """Live RapidAPI Instagram call — gated behind O3 feasibility study.

    Per D14 the Instagram path is DEFERRED until the email-base feasibility
    study (Task O3) completes. Flipping `CAPABILITY_LAYER_MODE=live` while
    O3 is outstanding is a process error; we surface it as a clear
    NotImplementedError rather than silently calling a billed endpoint.
    """
    raise NotImplementedError(
        "rapidapi_instagram_search live mode is BLOCKED on O3 "
        "(Instagram feasibility study, D14). "
        "Set CAPABILITY_LAYER_MODE=stub or wait for O3 sign-off."
    )


# Surface the per-invocation cost as a function attribute (D41 pattern).
rapidapi_instagram_search.usd_cost = USD_COST  # type: ignore[attr-defined]


__all__ = [
    "RapidApiInstagramCreator",
    "RapidApiInstagramSearchInput",
    "RapidApiInstagramSearchOutput",
    "USD_COST",
    "rapidapi_instagram_search",
]
