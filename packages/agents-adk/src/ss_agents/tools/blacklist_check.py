"""blacklist_check — capability layer per D41.

Check creator IDs against the workspace's Spanner `blacklist` table.
Implements the `blacklist.check` capability declared in
`gcp-research/specs/tier1/sourcing.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default): returns an empty `hits[]`
list so the sourcing agent's downstream union → drop pipeline can run
deterministically in CI without a Spanner instance.

Live mode (CAPABILITY_LAYER_MODE=live): real Spanner read against
`v2_blacklist` (per D15 the v2 OLTP store). Wired in W7 deploy phase
once the Spanner client + SPIFFE identity bind land.

Citations:
    D15 — Spanner as the OLTP store of record (v2 collections).
    D41 — Capability layer ADK FunctionTool stub/live pattern.
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

# Spanner reads are cheap at this volume — pricing in mid-five-figure-rows
# range is ~$0.0001 per read unit. The blacklist tops out at a few thousand
# rows per workspace.
USD_COST: float = 0.0001


BlacklistSeverity = Literal["PERMANENT", "TEMPORARY", "WARNING"]
"""Per v1 `blacklist` collection schema — also used by v2_blacklist.

  - PERMANENT  → drop the creator outright (sourcing.spec.md step 3).
  - TEMPORARY  → keep but flag `blacklisted` (operator reviews).
  - WARNING    → keep but flag `blacklisted` with a soft hint.
"""


class BlacklistCheckInput(BaseModel):
    """Input contract — `blacklist.check` per sourcing.spec.md §6."""

    model_config = ConfigDict(extra="forbid")

    workspace_id: str = Field(
        min_length=1,
        max_length=64,
        alias="workspaceId",
        description="Workspace whose blacklist table to read.",
    )
    creator_ids: list[str] = Field(
        min_length=1,
        max_length=5_000,
        alias="creatorIds",
        description=(
            "Mix of numeric ids OR `@handles` — the live impl normalises both. "
            "Up to 5000 ids in one call; the sourcing agent batches when needed."
        ),
    )


class BlacklistHit(BaseModel):
    """One blacklist row — identity + severity + reason."""

    model_config = ConfigDict(extra="forbid")

    creator_id: str = Field(min_length=1, alias="creatorId")
    severity: BlacklistSeverity
    reason: str = Field(
        default="",
        max_length=500,
        description="Free-form operator note; nullable in Spanner but echoed as '' here.",
    )


class BlacklistCheckOutput(BaseModel):
    """Output contract — `hits[]` list (subset of input `creator_ids`).

    Empty list means none of the input ids are blacklisted. Stub mode
    ALWAYS returns the empty list — see `_stub`.
    """

    model_config = ConfigDict(extra="forbid")

    hits: list[BlacklistHit] = Field(default_factory=list, max_length=5_000)
    checked_count: int = Field(
        ge=0,
        alias="checkedCount",
        description="Number of ids actually looked up (= len(input.creator_ids)).",
    )


def blacklist_check(payload: BlacklistCheckInput) -> BlacklistCheckOutput:
    """Look up creator ids against the workspace blacklist.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated check request.

    Returns:
        `hits[]` (subset of input creator_ids that are blacklisted) +
        `checkedCount` (always == len(input.creator_ids)).

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


def _stub(payload: BlacklistCheckInput) -> BlacklistCheckOutput:
    """Return empty hits[] — no creator is blacklisted in stub mode.

    The deterministic empty result lets the dedupe → drop pipeline in
    sourcing's `should_escalate` exercise the no-saturation branch by
    default. Tests that need a non-empty hit list should monkeypatch
    `_stub` directly rather than juggle env vars.
    """
    logger.debug(
        "blacklist_check_stub",
        extra={
            "workspace_id": payload.workspace_id,
            "checked_count": len(payload.creator_ids),
        },
    )
    return BlacklistCheckOutput(
        hits=[],
        checkedCount=len(payload.creator_ids),
    )


def _live(payload: BlacklistCheckInput) -> BlacklistCheckOutput:
    """Live Spanner read — wired in W7 deploy phase.

    The live path will use the google-cloud-spanner client to run an
    indexed `SELECT creator_id, severity, reason FROM v2_blacklist
    WHERE workspace_id = @ws AND creator_id IN UNNEST(@ids)` query, with
    automatic chunking when len(creator_ids) > 1000 (Spanner IN-list cap).
    """
    raise NotImplementedError(
        "blacklist_check live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


# Per-invocation cost attribute (D41 pattern).
blacklist_check.usd_cost = USD_COST  # type: ignore[attr-defined]


__all__ = [
    "BlacklistCheckInput",
    "BlacklistCheckOutput",
    "BlacklistHit",
    "BlacklistSeverity",
    "USD_COST",
    "blacklist_check",
]
