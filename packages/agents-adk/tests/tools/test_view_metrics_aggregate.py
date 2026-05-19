"""tests/tools/test_view_metrics_aggregate.py

Covers four contracts on the `view_metrics_aggregate` capability tool:

1. **Stub determinism** — canonical 1000-view aggregate the brief specifies
   (850 unique, 0.62 completion, $10.00 cost). Same input → same output.
2. **D28 billing invariant** — `cost_usd == total_views × $0.01`. The
   output model's validator enforces this; we sweep both the stub path
   and a synthetic counter-example.
3. **Pydantic validation** — `extra=forbid`, time-range ordering,
   campaign_id whitespace, max window width.
4. **Live NotImplementedError** + cost attribute surfacing.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D28 — Per-view pricing ($0.01 per delivered view); this tool is the
          billing source of truth.
    D15 — BigQuery sits on the analytics side of the OLTP hybrid.
    analyst.spec.md §6 — `view_metrics.aggregate` tool contract.
"""
from __future__ import annotations

import datetime as dt

import pytest
from pydantic import ValidationError

from ss_agents.tools.view_metrics_aggregate import (
    PRICE_PER_VIEW_USD,
    USD_COST,
    DailyBreakdownRow,
    ViewMetricsAggregateInput,
    ViewMetricsAggregateOutput,
    view_metrics_aggregate,
)


# ─────────────────────────────────────────────────────────────────────────────
# Canonical fixtures.
# ─────────────────────────────────────────────────────────────────────────────


_START = dt.datetime(2026, 5, 1, 0, 0, tzinfo=dt.UTC)
_END = dt.datetime(2026, 5, 8, 0, 0, tzinfo=dt.UTC)


def _input(
    *,
    campaign_id: str = "cmp_demo001",
    start: dt.datetime = _START,
    end: dt.datetime = _END,
) -> ViewMetricsAggregateInput:
    return ViewMetricsAggregateInput(
        campaign_id=campaign_id,
        time_range=(start, end),
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism — pins the canonical 1000-view aggregate.
# ─────────────────────────────────────────────────────────────────────────────


class TestStubDeterminism:
    """Stub output must match the brief's documented canonical values."""

    def test_canonical_aggregate_shape(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """1000 views, 850 unique, 0.62 completion, $10.00 cost."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = view_metrics_aggregate(_input())
        assert isinstance(out, ViewMetricsAggregateOutput)
        assert out.total_views == 1000
        assert out.unique_viewers == 850
        assert out.completion_rate == 0.62
        assert out.cost_usd == 10.00
        assert out.fetched_via == "stub"

    def test_same_input_yields_byte_identical_output(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Re-invoking with the same input twice produces equal models."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out_a = view_metrics_aggregate(_input())
        out_b = view_metrics_aggregate(_input())
        assert out_a == out_b

    def test_daily_breakdown_pins_date(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The single breakdown row uses `time_range[0].date()` as its date."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = view_metrics_aggregate(_input())
        assert len(out.daily_breakdown) == 1
        row = out.daily_breakdown[0]
        assert isinstance(row, DailyBreakdownRow)
        assert row.date == _START.date()
        assert row.views == 1000

    def test_ctr_to_landing_is_within_bounds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`ctr_to_landing ∈ [0.0, 1.0]` is part of the output contract."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = view_metrics_aggregate(_input())
        assert 0.0 <= out.ctr_to_landing <= 1.0


# ─────────────────────────────────────────────────────────────────────────────
# 2. D28 billing invariant — cost_usd == total_views × $0.01.
# ─────────────────────────────────────────────────────────────────────────────


class TestBillingInvariant:
    """The output validator catches drift between view count and billing."""

    def test_stub_satisfies_billing_invariant(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """1000 × $0.01 = $10.00 exactly."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = view_metrics_aggregate(_input())
        expected = round(out.total_views * PRICE_PER_VIEW_USD, 2)
        assert out.cost_usd == expected

    def test_violating_billing_invariant_raises(self) -> None:
        """Synthetic counter-example: building an output where cost_usd
        diverges from total_views × $0.01 must fail validation."""
        with pytest.raises(ValidationError, match="D28 billing invariant"):
            ViewMetricsAggregateOutput(
                total_views=1000,
                unique_viewers=850,
                completion_rate=0.62,
                cost_usd=999.99,  # WRONG — should be $10.00
                ctr_to_landing=0.05,
                daily_breakdown=[],
                fetched_via="stub",
            )

    def test_unique_viewers_cannot_exceed_total_views(self) -> None:
        """Unique viewers ≤ total views by construction (a viewer with N
        views counts as N views + 1 unique viewer)."""
        with pytest.raises(ValidationError, match="cannot exceed total_views"):
            ViewMetricsAggregateOutput(
                total_views=100,
                unique_viewers=101,  # impossible
                completion_rate=0.5,
                cost_usd=1.00,
                ctr_to_landing=0.0,
                daily_breakdown=[],
                fetched_via="stub",
            )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Pydantic validation — input contract.
# ─────────────────────────────────────────────────────────────────────────────


class TestPydanticValidation:
    """`extra=forbid`, time-range ordering, campaign_id hygiene, window cap."""

    def test_extra_field_rejected(self) -> None:
        """`extra=forbid` means unknown input fields fail."""
        with pytest.raises(ValidationError):
            ViewMetricsAggregateInput.model_validate(
                {
                    "campaign_id": "cmp_demo001",
                    "time_range": (_START, _END),
                    "evil_extra_field": "haha",
                }
            )

    def test_empty_campaign_id_rejected(self) -> None:
        """min_length=1."""
        with pytest.raises(ValidationError):
            ViewMetricsAggregateInput(campaign_id="", time_range=(_START, _END))

    def test_whitespace_campaign_id_rejected(self) -> None:
        """Leading/trailing whitespace is a common copy-paste bug — fail closed."""
        with pytest.raises(ValidationError, match="whitespace"):
            ViewMetricsAggregateInput(
                campaign_id="  cmp_demo001 ",
                time_range=(_START, _END),
            )

    def test_inverted_time_range_rejected(self) -> None:
        """start >= end is not a valid window."""
        with pytest.raises(ValidationError, match="strictly before"):
            ViewMetricsAggregateInput(
                campaign_id="cmp_demo001",
                time_range=(_END, _START),
            )

    def test_equal_time_range_rejected(self) -> None:
        """start == end is also rejected (zero-width window has no rows)."""
        with pytest.raises(ValidationError, match="strictly before"):
            ViewMetricsAggregateInput(
                campaign_id="cmp_demo001",
                time_range=(_START, _START),
            )

    def test_overly_wide_window_rejected(self) -> None:
        """> 366-day window is rejected to avoid full-table scans."""
        start = dt.datetime(2025, 1, 1, tzinfo=dt.UTC)
        end = dt.datetime(2027, 1, 1, tzinfo=dt.UTC)  # 2 years
        with pytest.raises(ValidationError, match="too wide"):
            ViewMetricsAggregateInput(
                campaign_id="cmp_demo001",
                time_range=(start, end),
            )

    def test_completion_rate_out_of_bounds_rejected(self) -> None:
        """`completion_rate ∈ [0.0, 1.0]`."""
        with pytest.raises(ValidationError):
            ViewMetricsAggregateOutput(
                total_views=1000,
                unique_viewers=850,
                completion_rate=1.5,  # > 1.0
                cost_usd=10.00,
                ctr_to_landing=0.05,
                daily_breakdown=[],
                fetched_via="stub",
            )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Live NotImplementedError + cost attribute surfacing.
# ─────────────────────────────────────────────────────────────────────────────


class TestLiveAndCost:
    """`CAPABILITY_LAYER_MODE=live` must raise — W7 wires the real client."""

    def test_live_mode_raises_not_implemented(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(NotImplementedError, match="W7 deploy phase"):
            view_metrics_aggregate(_input())

    def test_usd_cost_attribute_surfaced(self) -> None:
        """`cost_watch` reads `tool.usd_cost` via getattr — must exist."""
        assert hasattr(view_metrics_aggregate, "usd_cost")
        assert view_metrics_aggregate.usd_cost == USD_COST  # type: ignore[attr-defined]
        assert USD_COST > 0.0

    def test_price_per_view_matches_d28(self) -> None:
        """D28 fixes the per-view price at $0.01. The constant must match
        — changing it changes the billing line item for every tenant."""
        assert PRICE_PER_VIEW_USD == 0.01
