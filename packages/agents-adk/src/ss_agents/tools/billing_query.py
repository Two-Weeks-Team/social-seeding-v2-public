"""billing_query — capability layer per D41.

Cloud Billing per-tenant USD/day query for the cost_watch (W2) watchdog.
Implements the `billing.query` capability declared in
`gcp-research/specs/tier3/cost_watch.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic. The canonical demo tenant (`workspace_id="ws_demo"`)
    is hardcoded to return $42.50/day spend → threshold_pct = 0.04
    (~4% of D39's $1500 cap) — a healthy reading that does NOT trip any
    cost_watch threshold (50/75/90/95%). Other workspace_ids return a
    deterministic but cheaper synthesis (~$10/day) so multi-tenant tests
    can assert isolation without enumerating every workspace.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real `bigquery.Client.query` against the BQ cost ledger (D33 90d
    retention) joined with the Spanner `tenant_budgets` table (D15).
    Wired in W7 deploy phase. Today raises NotImplementedError.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D23 — Tier-3 W2 cost_watch (DECISIONS.md §4 row W2).
    D28 — Per-view pricing ($0.01/view). cost_watch is the metering
          enforcer that converts the BQ ledger into threshold crossings.
    D33 — Cost ledger 90-day retention. Live path queries the
          `agent.cost.recorded` BQ table.
    D39 — $1500 budget ceiling. Hardcoded as `BUDGET_USD_CAP=1500.0`
          below — the absolute ceiling for any single tenant's monthly
          spend. Per-tenant Spanner overrides may set a LOWER cap, never
          higher.
    cost_watch.spec.md §6 — Tool table row for `billing.query`.

Per-call cost: $0.0003 (BigQuery on-demand pricing is ~$5/TB scanned;
a per-tenant per-day rollup over the 90d ledger costs sub-cent given
that BQ partitioning + clustering keep the scan small).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger(__name__)

USD_COST: float = 0.0003
"""Per-call USD attribution surfaced via `billing_query.usd_cost` for the
runtime's `cost_watch` aggregator (D41). Sub-cent; cost_watch is rule-based
(no LLM) so the entire watchdog tick is < $0.001 in stub mode."""


# ─────────────────────────────────────────────────────────────────────────────
# D39: $1500 hardcoded budget cap. Per-tenant overrides go LOWER, not higher.
# ─────────────────────────────────────────────────────────────────────────────


BUDGET_USD_CAP: float = 1500.0
"""D39: GCP credits available = $1500 USD for the entire judging window.
This is the ABSOLUTE upper bound on any single tenant's spend across all
windows. cost_watch's threshold ladder (50/75/90/95%) is computed against
this cap by default; per-tenant Spanner budgets MAY override DOWNWARD
(e.g. a free-tier tenant gets a $50/day cap), never upward."""


# Stub-only fixture: the canonical demo workspace surface.
_STUB_DEMO_WORKSPACE: str = "ws_demo"
_STUB_DEMO_DAILY_USD: float = 42.50
"""$42.50/day against the D39 $1500 cap → threshold_pct_consumed ~= 0.04
(4%). Below the 50% banner threshold; cost_watch returns no crossings."""


# ─────────────────────────────────────────────────────────────────────────────
# Breakdown enum + Input/Output models.
# ─────────────────────────────────────────────────────────────────────────────


Breakdown = Literal["by_service", "by_workspace", "total"]
"""Per-call rollup dimension:
    by_service:   group by Cloud Billing service (Vertex, BigQuery, …).
    by_workspace: group by workspace_id (per-tenant fan-out).
    total:        single-row total across the query window.
"""


class BillingQueryInput(BaseModel):
    """Capability input. Mirrors cost_watch.spec.md §6 `billing.query`.

    Attributes:
        workspace_id:  Optional workspace scope. None → tenant-wide rollup
            across every workspace under the tenant. When set, narrows
            the BQ scan to a single workspace partition.
        time_range:    Inclusive `(start, end)` tuple. Dates only (not
            timestamps) — the BQ ledger is partitioned on DATE. `start
            <= end` enforced.
        breakdown:     Aggregation dimension. See `Breakdown` literal.
    """

    model_config = ConfigDict(extra="forbid")

    workspace_id: str | None = Field(default=None, max_length=64)
    time_range: tuple[dt.date, dt.date]
    breakdown: Breakdown

    @model_validator(mode="after")
    def _validate_range(self) -> BillingQueryInput:
        start, end = self.time_range
        if start > end:
            raise ValueError(
                f"time_range start ({start}) must be <= end ({end})"
            )
        return self


class BreakdownRow(BaseModel):
    """One row of the breakdown result."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1, max_length=128)
    """Service name, workspace id, or the literal `"total"` for total breakdown."""
    usd: float = Field(ge=0.0)


class BillingQueryOutput(BaseModel):
    """Capability output.

    Attributes:
        total_usd:               Sum across all breakdown rows. Echoed at
            the top level so callers can short-circuit without iterating.
        breakdown_rows:          One row per group. Always non-empty —
            for `breakdown="total"` it has exactly one row keyed
            `"total"`.
        threshold_breached:      True iff `threshold_pct_consumed >=
            0.50` (the first cost_watch banner threshold). Provided so
            the rule evaluator can short-circuit on cheap queries.
        threshold_pct_consumed:  `total_usd / BUDGET_USD_CAP` clamped to
            [0.0, ∞). Used by cost_watch to compute crossings against
            the 50/75/90/95% threshold ladder.
    """

    model_config = ConfigDict(extra="forbid")

    total_usd: float = Field(ge=0.0)
    breakdown_rows: list[BreakdownRow] = Field(min_length=1, max_length=200)
    threshold_breached: bool
    threshold_pct_consumed: float = Field(ge=0.0)


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def billing_query(payload: BillingQueryInput) -> BillingQueryOutput:
    """Query Cloud Billing for a per-tenant USD rollup.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated `BillingQueryInput`.

    Returns:
        `BillingQueryOutput` with the rollup + threshold hint.

    Raises:
        NotImplementedError: in LIVE mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
billing_query.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic. The demo workspace is hardcoded; others synthesize.
#
# Algorithm:
#   1. Resolve daily USD:
#        ws_demo                       → $42.50 (the canonical fixture)
#        other workspace_ids           → deterministic synthesis $5-$15
#        None (tenant-wide)            → $80.00 (multi-workspace fixture)
#   2. Multiply by max(1, days_in_range) so the total scales with the
#      query window — exercises the rate-of-burn computation upstream.
#   3. Emit breakdown rows per `breakdown`:
#        total        → one row keyed "total"
#        by_workspace → one row per workspace (just the queried one when set)
#        by_service   → three rows: vertex_ai, bigquery, other
#   4. Compute threshold_pct against D39's BUDGET_USD_CAP.
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: BillingQueryInput) -> BillingQueryOutput:
    """Deterministic stub. Same input → byte-identical output."""
    start, end = payload.time_range
    days = max(1, (end - start).days + 1)
    daily_usd = _resolve_daily_usd(payload.workspace_id)
    total_usd = daily_usd * days

    breakdown_rows = _build_breakdown(
        payload.breakdown, payload.workspace_id, total_usd
    )

    threshold_pct = total_usd / BUDGET_USD_CAP
    threshold_breached = threshold_pct >= 0.50

    logger.debug(
        "billing_query_stub",
        extra={
            "workspace_id": payload.workspace_id,
            "breakdown": payload.breakdown,
            "days": days,
            "total_usd": total_usd,
            "threshold_pct": threshold_pct,
        },
    )

    return BillingQueryOutput(
        total_usd=total_usd,
        breakdown_rows=breakdown_rows,
        threshold_breached=threshold_breached,
        threshold_pct_consumed=threshold_pct,
    )


def _resolve_daily_usd(workspace_id: str | None) -> float:
    """Stub-only: per-workspace daily USD fixture.

    The canonical demo workspace ($42.50) lets the golden-path eval
    pin against a known surface; other workspaces synthesize a stable
    but distinct number so multi-tenant fan-out tests see isolation.
    """
    if workspace_id is None:
        return 80.00  # tenant-wide rollup
    if workspace_id == _STUB_DEMO_WORKSPACE:
        return _STUB_DEMO_DAILY_USD
    # FNV-style hash → $5.00-$14.99/day for arbitrary workspace_ids.
    digest = hashlib.sha256(workspace_id.encode("utf-8")).digest()
    raw = int.from_bytes(digest[:4], byteorder="big", signed=False)
    return 5.00 + (raw % 1000) / 100.0


def _build_breakdown(
    breakdown: Breakdown,
    workspace_id: str | None,
    total_usd: float,
) -> list[BreakdownRow]:
    """Emit breakdown rows per the requested dimension."""
    if breakdown == "total":
        return [BreakdownRow(key="total", usd=total_usd)]
    if breakdown == "by_workspace":
        key = workspace_id if workspace_id else "tenant_total"
        return [BreakdownRow(key=key, usd=total_usd)]
    # by_service — three deterministic shares. Vertex dominates per D5
    # (Gemini token cost is the bulk of the spend).
    return [
        BreakdownRow(key="vertex_ai", usd=total_usd * 0.70),
        BreakdownRow(key="bigquery", usd=total_usd * 0.20),
        BreakdownRow(key="other", usd=total_usd * 0.10),
    ]


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase).
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: BillingQueryInput) -> BillingQueryOutput:
    """Live BigQuery + Spanner rollup — wired in W7 deploy phase."""
    _ = payload
    raise NotImplementedError(
        "billing_query live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "BUDGET_USD_CAP",
    "BillingQueryInput",
    "BillingQueryOutput",
    "Breakdown",
    "BreakdownRow",
    "USD_COST",
    "billing_query",
]
