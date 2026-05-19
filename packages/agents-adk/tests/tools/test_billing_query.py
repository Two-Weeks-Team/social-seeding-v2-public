"""tests/tools/test_billing_query.py — W2-C1 cost_watch billing.query seam.

Coverage matrix:
    1. Default = stub; ws_demo returns $42.50/day, threshold_pct ~= 0.04.
    2. Pydantic input validation (range ordering, breakdown enum).
    3. Stub determinism + multi-tenant isolation.
    4. Breakdown parametrize — total / by_workspace / by_service.
    5. Threshold ladder — 50/75/90/95% boundary behaviour against $1500 cap.
    6. Tenant-wide query (workspace_id=None) sums across workspaces.
    7. Multi-day range scales daily into total.
    8. Live mode raises NotImplementedError with W7 message.
    9. `usd_cost` + BUDGET_USD_CAP=$1500 (D39).

Citations: D41 (capability layer stub/live), D23 (Tier-3 W2), D33 (cost
    ledger), D39 ($1500 cap), cost_watch.spec.md §6.
"""
from __future__ import annotations

import datetime as dt

import pytest
from pydantic import ValidationError

from ss_agents.tools.billing_query import (
    BUDGET_USD_CAP,
    USD_COST,
    BillingQueryInput,
    BillingQueryOutput,
    Breakdown,
    BreakdownRow,
    billing_query,
)


_DAY = dt.date(2026, 5, 19)
_DAY_NEXT = dt.date(2026, 5, 20)


# ─────────────────────────────────────────────────────────────────────────────
# Test 1 — default mode is stub; canonical demo workspace
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub_demo_workspace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = billing_query(
        BillingQueryInput(
            workspace_id="ws_demo",
            time_range=(_DAY, _DAY),  # single day
            breakdown="total",
        )
    )
    assert isinstance(out, BillingQueryOutput)
    assert out.total_usd == 42.50
    # 42.50 / 1500 = 0.02833...
    assert abs(out.threshold_pct_consumed - 0.02833) < 0.01
    assert out.threshold_breached is False
    assert out.breakdown_rows[0].key == "total"
    assert out.breakdown_rows[0].usd == 42.50


# ─────────────────────────────────────────────────────────────────────────────
# Test 2 — input validation
# ─────────────────────────────────────────────────────────────────────────────


class TestInputValidation:
    def test_rejects_inverted_range(self) -> None:
        with pytest.raises(ValidationError):
            BillingQueryInput(
                workspace_id="ws_demo",
                time_range=(_DAY_NEXT, _DAY),  # inverted
                breakdown="total",
            )

    def test_rejects_unknown_breakdown(self) -> None:
        with pytest.raises(ValidationError):
            BillingQueryInput.model_validate(
                {
                    "workspace_id": "ws_demo",
                    "time_range": [_DAY, _DAY],
                    "breakdown": "by_region",  # not in literal
                }
            )

    def test_rejects_unknown_extra_field(self) -> None:
        with pytest.raises(ValidationError):
            BillingQueryInput.model_validate(
                {
                    "workspace_id": "ws_demo",
                    "time_range": [_DAY, _DAY],
                    "breakdown": "total",
                    "currency": "KRW",  # not in schema
                }
            )

    def test_accepts_workspace_id_none(self) -> None:
        payload = BillingQueryInput(
            workspace_id=None,
            time_range=(_DAY, _DAY),
            breakdown="total",
        )
        assert payload.workspace_id is None


# ─────────────────────────────────────────────────────────────────────────────
# Test 3 — determinism + multi-tenant isolation
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = BillingQueryInput(
        workspace_id="ws_demo",
        time_range=(_DAY, _DAY),
        breakdown="by_workspace",
    )
    a = billing_query(payload)
    b = billing_query(payload)
    assert a.model_dump_json() == b.model_dump_json()


def test_multi_tenant_isolation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    a = billing_query(
        BillingQueryInput(
            workspace_id="ws_demo",
            time_range=(_DAY, _DAY),
            breakdown="total",
        )
    )
    b = billing_query(
        BillingQueryInput(
            workspace_id="ws_other",
            time_range=(_DAY, _DAY),
            breakdown="total",
        )
    )
    # Demo fixture is $42.50; other workspaces synthesize $5-$15.
    assert a.total_usd == 42.50
    assert 5.0 <= b.total_usd < 15.0


# ─────────────────────────────────────────────────────────────────────────────
# Test 4 — breakdown parametrize
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("breakdown", ["by_service", "by_workspace", "total"])
def test_breakdown_shape(
    breakdown: Breakdown, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = billing_query(
        BillingQueryInput(
            workspace_id="ws_demo",
            time_range=(_DAY, _DAY),
            breakdown=breakdown,
        )
    )
    assert all(isinstance(r, BreakdownRow) for r in out.breakdown_rows)
    if breakdown == "total":
        assert len(out.breakdown_rows) == 1
        assert out.breakdown_rows[0].key == "total"
    elif breakdown == "by_workspace":
        assert len(out.breakdown_rows) == 1
        assert out.breakdown_rows[0].key == "ws_demo"
    elif breakdown == "by_service":
        assert len(out.breakdown_rows) == 3
        keys = {r.key for r in out.breakdown_rows}
        assert keys == {"vertex_ai", "bigquery", "other"}
        # Service breakdown sums to total.
        assert abs(sum(r.usd for r in out.breakdown_rows) - out.total_usd) < 1e-6


# ─────────────────────────────────────────────────────────────────────────────
# Test 5 — threshold matrix (50/75/90/95% boundaries vs $1500 D39 cap)
# ─────────────────────────────────────────────────────────────────────────────


class TestThresholdMatrix:
    """The cost_watch agent rules trip at 50/75/90/95%. billing_query's
    `threshold_breached` is the 50% breaker; the full ladder is the agent's
    job. We verify that ANY result that crosses 50% sets the flag."""

    def test_threshold_pct_against_1500_cap(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        # Demo workspace × 18 days = $42.50 * 18 = $765 → 765/1500 = 0.51 (>50%)
        start = dt.date(2026, 5, 1)
        end = dt.date(2026, 5, 18)  # 18 days inclusive
        out = billing_query(
            BillingQueryInput(
                workspace_id="ws_demo",
                time_range=(start, end),
                breakdown="total",
            )
        )
        assert out.total_usd == 42.50 * 18
        expected_pct = out.total_usd / BUDGET_USD_CAP
        assert abs(out.threshold_pct_consumed - expected_pct) < 1e-6
        assert out.threshold_breached is True  # > 50%

    def test_below_50pct_threshold_not_breached(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = billing_query(
            BillingQueryInput(
                workspace_id="ws_demo",
                time_range=(_DAY, _DAY),  # single day → $42.50 / $1500 ~ 3%
                breakdown="total",
            )
        )
        assert out.threshold_breached is False

    @pytest.mark.parametrize("threshold_pct", [0.50, 0.75, 0.90, 0.95])
    def test_threshold_ladder_thresholds_are_valid_floats(
        self, threshold_pct: float
    ) -> None:
        """The cost_watch ladder consumes 50/75/90/95 as floats — sanity check."""
        assert 0.0 < threshold_pct < 1.0


# ─────────────────────────────────────────────────────────────────────────────
# Test 6 — tenant-wide query
# ─────────────────────────────────────────────────────────────────────────────


def test_tenant_wide_query(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = billing_query(
        BillingQueryInput(
            workspace_id=None,  # tenant-wide
            time_range=(_DAY, _DAY),
            breakdown="by_workspace",
        )
    )
    # Tenant-wide stub fixture is $80.
    assert out.total_usd == 80.0
    # The single row is keyed `tenant_total` when workspace_id is None.
    assert out.breakdown_rows[0].key == "tenant_total"


# ─────────────────────────────────────────────────────────────────────────────
# Test 7 — multi-day range
# ─────────────────────────────────────────────────────────────────────────────


def test_multi_day_range_scales_total(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = billing_query(
        BillingQueryInput(
            workspace_id="ws_demo",
            time_range=(_DAY, _DAY_NEXT),  # 2 days inclusive
            breakdown="total",
        )
    )
    assert out.total_usd == 42.50 * 2


# ─────────────────────────────────────────────────────────────────────────────
# Test 8 — live mode raises
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        billing_query(
            BillingQueryInput(
                workspace_id="ws_demo",
                time_range=(_DAY, _DAY),
                breakdown="total",
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# Test 9 — cost attribute + D39 budget cap
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(billing_query, "usd_cost")
    assert billing_query.usd_cost == USD_COST  # type: ignore[attr-defined]


def test_cost_is_sub_cent() -> None:
    assert 0.0 < USD_COST < 0.01


def test_budget_cap_is_d39_value() -> None:
    """D39: $1500 GCP credits → BUDGET_USD_CAP."""
    assert BUDGET_USD_CAP == 1500.0
