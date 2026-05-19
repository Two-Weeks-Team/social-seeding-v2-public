"""view_metrics_aggregate — capability layer per D41.

Aggregates per-view delivery metrics for a campaign over a time window.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Returns deterministic canned aggregates so the analyst agent can
    produce its narrative + the cost-watch agent can verify the per-view
    pricing math (D28) without live BigQuery traffic.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real BigQuery aggregation query — wired in W7 (deploy phase) once
    the Spanner→AlloyDB→BigQuery per-view metering pipeline lands. Today
    raises NotImplementedError so the runtime converts the call into an
    `EscalateToHuman` outcome rather than crashing.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern (CAPABILITY_LAYER_MODE).
    D28 — Per-view pricing ($0.01 per delivered view; $10 effective CPM).
          This tool is THE billing-source-of-truth aggregator: cost_usd it
          returns feeds both the analyst's `cost` section AND the
          per-tenant billing line item.
    D15 — OLTP hybrid; per-view events sit in BigQuery (analytics side).
    analyst.spec.md §6 — tool table row `view_metrics.aggregate`
                         (BigQuery rollup; verified-view aggregates per
                         shipment cohort).
    ARCHITECTURE.md §3 row 8 — analyst agent's tool list.
"""
from __future__ import annotations

import datetime as dt
import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

logger = logging.getLogger(__name__)

# Per-invocation USD cost estimate; `cost_watch` reads this attribute via
# `getattr(view_metrics_aggregate, "usd_cost", 0.0)`. A 7-day aggregation
# against `v2_view_metrics` scans ~5 MB typical → $5/TB → ~$0.0025/call.
USD_COST: float = 0.0025

# D28 — per-view billing constant. Single source of truth so cost_watch
# and the analyst agent compute identical totals from identical inputs.
PRICE_PER_VIEW_USD: float = 0.01


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class ViewMetricsAggregateInput(BaseModel):
    """Capability input. Mirrors analyst.spec.md §6 `view_metrics.aggregate`.

    Attributes:
        campaign_id: v2 campaign id (e.g. `cmp_demo001`). Validated as a
            non-empty short string — full id hygiene happens upstream
            (Spanner enforces uniqueness at write time).
        time_range: `(start, end)` UTC datetime tuple. The aggregation
            window is half-open `[start, end)` per BigQuery convention.
            `start < end` is enforced by a model-level validator.
    """

    model_config = ConfigDict(extra="forbid")

    campaign_id: str = Field(min_length=1, max_length=128)
    time_range: tuple[dt.datetime, dt.datetime] = Field(
        description="(start, end) UTC datetimes; half-open [start, end).",
    )

    @field_validator("campaign_id")
    @classmethod
    def _strip_campaign_id(cls, v: str) -> str:
        """Reject leading/trailing whitespace — common copy-paste bug."""
        stripped = v.strip()
        if stripped != v:
            raise ValueError(
                f"campaign_id must not have leading/trailing whitespace "
                f"(got {v!r})"
            )
        return v

    @model_validator(mode="after")
    def _validate_time_range(self) -> "ViewMetricsAggregateInput":
        """Enforce start < end. Equal timestamps are not a valid window."""
        start, end = self.time_range
        if start >= end:
            raise ValueError(
                f"time_range start ({start.isoformat()}) must be strictly "
                f"before end ({end.isoformat()})"
            )
        # Sanity bound — refuse > 1 year windows so a buggy caller doesn't
        # scan the entire metrics table.
        delta = end - start
        if delta > dt.timedelta(days=366):
            raise ValueError(
                f"time_range too wide ({delta.days} days); cap is 366 days"
            )
        return self


class DailyBreakdownRow(BaseModel):
    """One day's view metrics for the campaign.

    Used by the analyst agent's `Numbers` table and by cost-watch to compute
    the burn rate and surface `budget_exceeded` flags before they hit the
    deadline.
    """

    model_config = ConfigDict(extra="forbid")

    date: dt.date
    views: int = Field(ge=0)
    unique_viewers: int = Field(ge=0)
    cost_usd: float = Field(ge=0.0)


class ViewMetricsAggregateOutput(BaseModel):
    """Capability output.

    Attributes:
        total_views: Sum over the window. Multiplied by `PRICE_PER_VIEW_USD`
            this MUST equal `cost_usd` (D28 billing-integrity invariant).
        unique_viewers: Distinct viewer count. `unique_viewers ≤ total_views`
            by construction (a viewer with N views counts as N views and 1
            unique viewer).
        completion_rate: Fraction `[0.0, 1.0]` of views that reached the
            video's "completed" marker (≥ 95% of duration watched).
        cost_usd: D28 per-view price × total_views. Single source of truth
            for the campaign's media spend on TikTok seeding.
        ctr_to_landing: Click-through rate to the brand's landing URL,
            when present. `0.0` when the brief has no landing URL.
        daily_breakdown: Per-day rows. Length == days in window (or 0
            when stub returns the canonical 1-day shape).
        fetched_via: 'stub' vs 'live' — OTel splits the two streams.
    """

    model_config = ConfigDict(extra="forbid")

    total_views: int = Field(ge=0)
    unique_viewers: int = Field(ge=0)
    completion_rate: float = Field(ge=0.0, le=1.0)
    cost_usd: float = Field(ge=0.0)
    ctr_to_landing: float = Field(ge=0.0, le=1.0)
    daily_breakdown: list[DailyBreakdownRow] = Field(default_factory=list)
    fetched_via: Literal["stub", "live"]

    @model_validator(mode="after")
    def _check_billing_invariant(self) -> "ViewMetricsAggregateOutput":
        """D28: cost_usd must equal total_views × PRICE_PER_VIEW_USD.

        Caught at the output boundary so any future stub / live implementor
        that breaks the invariant trips this validator instead of silently
        emitting bad billing numbers. Tolerance: 1 cent (float drift).
        """
        expected = round(self.total_views * PRICE_PER_VIEW_USD, 2)
        if abs(self.cost_usd - expected) > 0.01:
            raise ValueError(
                f"D28 billing invariant violated: cost_usd={self.cost_usd!r} "
                f"!= total_views * ${PRICE_PER_VIEW_USD} "
                f"({self.total_views} × {PRICE_PER_VIEW_USD} = ${expected})"
            )
        if self.unique_viewers > self.total_views:
            raise ValueError(
                f"unique_viewers ({self.unique_viewers}) cannot exceed "
                f"total_views ({self.total_views})"
            )
        return self


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def view_metrics_aggregate(
    payload: ViewMetricsAggregateInput,
) -> ViewMetricsAggregateOutput:
    """Aggregate per-view metrics for `campaign_id` over `time_range`.

    Stub vs live is selected via the `CAPABILITY_LAYER_MODE` env var (D41).
    Stub returns deterministic canned aggregates; live performs the real
    BigQuery aggregation (wired in W7).

    Args:
        payload: Validated `ViewMetricsAggregateInput`.

    Returns:
        `ViewMetricsAggregateOutput` with totals + per-day breakdown.

    Raises:
        NotImplementedError: When `CAPABILITY_LAYER_MODE=live` — until W7
            wires the real google-cloud-bigquery client.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
view_metrics_aggregate.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic canned data.
#
# Contract per the task brief: 1000 views, 850 unique viewers, 0.62
# completion rate, $10.00 cost. cost = 1000 × $0.01 = $10.00 — satisfies
# the D28 billing invariant exactly.
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: ViewMetricsAggregateInput) -> ViewMetricsAggregateOutput:
    """Deterministic stub. Same input → same output, always.

    Returns the canonical 1000-view aggregate regardless of `campaign_id`
    or `time_range` (deterministic, easy to assert against). The single
    daily-breakdown row pins the date to `time_range[0].date()` so
    downstream tests that bucket by day see a real value.
    """
    total_views = 1000
    unique_viewers = 850
    completion_rate = 0.62
    cost_usd = round(total_views * PRICE_PER_VIEW_USD, 2)  # 10.00
    ctr_to_landing = 0.045

    daily = [
        DailyBreakdownRow(
            date=payload.time_range[0].date(),
            views=total_views,
            unique_viewers=unique_viewers,
            cost_usd=cost_usd,
        )
    ]

    return ViewMetricsAggregateOutput(
        total_views=total_views,
        unique_viewers=unique_viewers,
        completion_rate=completion_rate,
        cost_usd=cost_usd,
        ctr_to_landing=ctr_to_landing,
        daily_breakdown=daily,
        fetched_via="stub",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Raises NotImplementedError so the
# runtime converts to an `EscalateToHuman` rather than crashing.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: ViewMetricsAggregateInput) -> ViewMetricsAggregateOutput:
    """Live BigQuery aggregation. Wired in W7 deploy phase."""
    raise NotImplementedError(
        "view_metrics_aggregate live mode wired in W7 deploy phase "
        "(google-cloud-bigquery client + Spanner→BigQuery ELT pipeline)"
    )


__all__ = [
    "DailyBreakdownRow",
    "PRICE_PER_VIEW_USD",
    "USD_COST",
    "ViewMetricsAggregateInput",
    "ViewMetricsAggregateOutput",
    "view_metrics_aggregate",
]
