"""tests/agents/test_cost_watch.py — Tier-3 W2 rule-based watchdog.

Three classes mirroring the project's MATRIX.md §4.2 contract:

| Test class             | Purpose                                       |
|------------------------|-----------------------------------------------|
| TestInputContract      | Pydantic validation (parametrized + property) |
| TestRuleEvaluator      | Pure-function rule outputs (no async)         |
| TestAgentDefShape      | AgentDef registry-consistency invariants      |

Unlike LLM-driven agents, cost_watch has no `TestPlumbing` (no stub model
client — there's no model). Instead `TestRuleEvaluator` exhaustively
exercises the rule surface: every threshold crossing, the throttle
ladder, the $0-budget edge case, the previous_crossings dedupe, etc.

Spec §7 eval criteria — safety-critical:
    - false_negative_rate == 0  (never miss a crossing)
    - kill_switch_accuracy == 1 (never halt within budget)
"""
from __future__ import annotations

import datetime as dt

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from pydantic import ValidationError

from ss_agents.agents.cost_watch import (
    CANONICAL_THRESHOLDS,
    COST_WATCH_MODEL_SENTINEL,
    DEFAULT_FALLBACK_BUDGET_USD,
    SCALE_DOWN_TRIGGER_PERCENT,
    BillingSnapshot,
    CostGuardResult,
    CostWatchInput,
    CostWatchOutput,
    Crossing,
    Throttle,
    _check_anomalous_burn,
    _compute_percent,
    _maybe_throttle,
    _new_crossings,
    _resolve_budget,
    build_cost_watch_system_prompt,
    cost_guard,
    cost_guard_from_billing,
    cost_watch_agent_def,
    evaluate_cost_watch,
)

# ─────────────────────────────────────────────────────────────────────────────
# Local fixtures — cost_watch-specific.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def now_utc() -> dt.datetime:
    """Stable tick time. UTC per spec §8 edge case 2 (per_month uses UTC)."""
    return dt.datetime(2026, 5, 19, 12, 0, 0, tzinfo=dt.UTC)


def _input(
    *,
    spent: float,
    budget: float | None = 100.0,
    window: str = "per_day",
    previous: list[int] | None = None,
    tick: dt.datetime | None = None,
    workspace: str | None = None,
    baseline: float | None = None,
    stale: bool = False,
    force: bool = False,
) -> CostWatchInput:
    """Build a CostWatchInput with sensible defaults. Reduces boilerplate."""
    return CostWatchInput(
        tenantId="t_tenant_abc12345",
        workspaceId=workspace,
        window=window,  # type: ignore[arg-type]
        tickTime=tick or dt.datetime(2026, 5, 19, 12, 0, 0, tzinfo=dt.UTC),
        forceRecheck=force,
        billingSnapshot=BillingSnapshot(
            spentUsd=spent,
            budgetUsd=budget,
            baselineBurnRateUsdPerHour=baseline,
            snapshotStale=stale,
        ),
        previousCrossings=previous or [],  # type: ignore[arg-type]
    )


# ═════════════════════════════════════════════════════════════════════════════
# 1. TestInputContract — Pydantic validation.
# ═════════════════════════════════════════════════════════════════════════════


class TestInputContract:
    """Spec §2 properties.Input + extension fields. Every invalid input
    fails fast with ValidationError; every valid one round-trips by alias."""

    # ── Valid construction ────────────────────────────────────────────

    def test_minimal_valid_input(self, now_utc: dt.datetime) -> None:
        v = CostWatchInput(
            tenantId="t_x123",
            window="per_hour",
            tickTime=now_utc,
            billingSnapshot=BillingSnapshot(spentUsd=10.0, budgetUsd=100.0),
        )
        assert v.tenant_id == "t_x123"
        assert v.previous_crossings == []
        assert v.force_recheck is False

    @pytest.mark.parametrize(
        "window",
        ["per_minute", "per_hour", "per_day", "per_month", "per_campaign"],
    )
    def test_all_canonical_windows_accepted(
        self, window: str, now_utc: dt.datetime
    ) -> None:
        v = CostWatchInput(
            tenantId="t_x",
            window=window,  # type: ignore[arg-type]
            tickTime=now_utc,
            billingSnapshot=BillingSnapshot(spentUsd=0.0, budgetUsd=100.0),
        )
        assert v.window == window

    @pytest.mark.parametrize(
        "bad_window", ["", "per_week", "per_year", "daily", "PER_DAY"]
    )
    def test_invalid_window_rejected(
        self, bad_window: str, now_utc: dt.datetime
    ) -> None:
        with pytest.raises(ValidationError):
            CostWatchInput(
                tenantId="t_x",
                window=bad_window,  # type: ignore[arg-type]
                tickTime=now_utc,
                billingSnapshot=BillingSnapshot(spentUsd=0.0, budgetUsd=100.0),
            )

    def test_negative_spent_rejected(self, now_utc: dt.datetime) -> None:
        with pytest.raises(ValidationError):
            BillingSnapshot(spentUsd=-0.01, budgetUsd=100.0)

    def test_negative_budget_rejected(self, now_utc: dt.datetime) -> None:
        with pytest.raises(ValidationError):
            BillingSnapshot(spentUsd=0.0, budgetUsd=-1.0)

    def test_none_budget_accepted(self) -> None:
        """`None` is the canonical sentinel for 'tenant has no budget row'."""
        s = BillingSnapshot(spentUsd=10.0, budgetUsd=None)
        assert s.budget_usd is None

    def test_previous_crossings_must_be_unique(
        self, now_utc: dt.datetime
    ) -> None:
        with pytest.raises(ValidationError):
            CostWatchInput(
                tenantId="t_x",
                window="per_day",
                tickTime=now_utc,
                billingSnapshot=BillingSnapshot(spentUsd=0.0, budgetUsd=100.0),
                previousCrossings=[50, 50],  # type: ignore[list-item]
            )

    def test_previous_crossings_only_canonical_thresholds(
        self, now_utc: dt.datetime
    ) -> None:
        """An out-of-enum threshold (e.g. 60) must fail validation."""
        with pytest.raises(ValidationError):
            CostWatchInput(
                tenantId="t_x",
                window="per_day",
                tickTime=now_utc,
                billingSnapshot=BillingSnapshot(spentUsd=0.0, budgetUsd=100.0),
                previousCrossings=[60],  # type: ignore[list-item]
            )

    def test_extra_fields_forbidden(self, now_utc: dt.datetime) -> None:
        """Pydantic's `extra='forbid'` blocks typos at the input layer."""
        with pytest.raises(ValidationError):
            CostWatchInput.model_validate(
                {
                    "tenantId": "t_x",
                    "window": "per_day",
                    "tickTime": now_utc.isoformat(),
                    "billingSnapshot": {"spentUsd": 0.0, "budgetUsd": 100.0},
                    "unknownField": "boom",  # extra
                }
            )

    def test_round_trip_by_alias(self, now_utc: dt.datetime) -> None:
        payload = CostWatchInput(
            tenantId="t_tenant_abc12345",
            workspaceId="ws_acme",
            window="per_day",
            tickTime=now_utc,
            forceRecheck=True,
            billingSnapshot=BillingSnapshot(
                spentUsd=42.5,
                budgetUsd=100.0,
                baselineBurnRateUsdPerHour=1.5,
                snapshotStale=False,
            ),
            previousCrossings=[50],  # type: ignore[list-item]
        )
        d = payload.model_dump(by_alias=True)
        reborn = CostWatchInput.model_validate(d)
        assert reborn == payload

    # ── Output schema validation ──────────────────────────────────────

    def test_output_throttle_tps_bounds(self, now_utc: dt.datetime) -> None:
        with pytest.raises(ValidationError):
            Throttle(tps=0.0, until=now_utc)  # tps must be > 0
        with pytest.raises(ValidationError):
            Throttle(tps=200.0, until=now_utc)  # tps must be ≤ 100

    def test_crossing_threshold_canonical_only(
        self, now_utc: dt.datetime
    ) -> None:
        with pytest.raises(ValidationError):
            Crossing(
                threshold=80,  # type: ignore[arg-type]  # not in {50,75,90,95,100,110}
                crossedAt=now_utc,
                action="notified",
            )


# ═════════════════════════════════════════════════════════════════════════════
# 2. TestRuleEvaluator — pure-function rule outputs.
# ═════════════════════════════════════════════════════════════════════════════


class TestRuleEvaluator:
    """Exhaustive coverage of the rule surface. The eval criteria
    (false_negative_rate == 0, kill_switch_accuracy == 1) translate
    directly into "if pct >= T then T in output.crossings" and "if pct <
    100 then no over_limit_block fires"."""

    # ── _compute_percent ──────────────────────────────────────────────

    def test_compute_percent_basic(self) -> None:
        assert _compute_percent(25.0, 100.0) == pytest.approx(25.0)
        assert _compute_percent(75.0, 100.0) == pytest.approx(75.0)
        assert _compute_percent(100.0, 100.0) == pytest.approx(100.0)
        assert _compute_percent(110.0, 100.0) == pytest.approx(110.0)

    def test_compute_percent_zero_zero_returns_zero(self) -> None:
        """Spec §8 edge case 7: budget=0, spend=0 → 0.0 (not NaN)."""
        assert _compute_percent(0.0, 0.0) == 0.0

    def test_compute_percent_zero_budget_with_spend_returns_sentinel(
        self,
    ) -> None:
        """Spec §8 edge case 3: free-tier — any spend → >> 100%."""
        v = _compute_percent(0.01, 0.0)
        assert v == 999_999.0
        # And the actual sentinel must be ≥ 110 so all thresholds fire.
        assert v > 110

    # ── _resolve_budget ───────────────────────────────────────────────

    def test_resolve_budget_uses_snapshot_value_when_set(self) -> None:
        s = BillingSnapshot(spentUsd=0.0, budgetUsd=250.0)
        assert _resolve_budget(s) == 250.0

    def test_resolve_budget_falls_back_when_none(self) -> None:
        """Spec §6 escalation: 'no budget configured → default $50/day'."""
        s = BillingSnapshot(spentUsd=0.0, budgetUsd=None)
        assert _resolve_budget(s) == DEFAULT_FALLBACK_BUDGET_USD
        assert DEFAULT_FALLBACK_BUDGET_USD == 50.0

    def test_resolve_budget_zero_is_explicit(self) -> None:
        """budget=0 is explicit free-tier — distinct from None."""
        s = BillingSnapshot(spentUsd=0.0, budgetUsd=0.0)
        assert _resolve_budget(s) == 0.0

    # ── _new_crossings ────────────────────────────────────────────────

    def test_no_crossings_below_50_percent(
        self, now_utc: dt.datetime
    ) -> None:
        out = _new_crossings(percent=49.99, previous=[], tick_time=now_utc)
        assert out == []

    @pytest.mark.parametrize(
        "percent,expected",
        [
            (50.0, [50]),
            (74.99, [50]),
            (75.0, [50, 75]),
            (90.0, [50, 75, 90]),
            (95.0, [50, 75, 90, 95]),
            (100.0, [50, 75, 90, 95, 100]),
            (110.0, [50, 75, 90, 95, 100, 110]),
            (200.0, [50, 75, 90, 95, 100, 110]),
        ],
    )
    def test_new_crossings_threshold_ladder(
        self,
        percent: float,
        expected: list[int],
        now_utc: dt.datetime,
    ) -> None:
        """For every percent, exactly the right set of thresholds fires."""
        out = _new_crossings(percent=percent, previous=[], tick_time=now_utc)
        assert [c.threshold for c in out] == expected
        # All crossings must carry the supplied tick_time.
        assert all(c.crossed_at == now_utc for c in out)

    def test_previous_crossings_are_deduped(self, now_utc: dt.datetime) -> None:
        """If 50 already fired, ticking at 60% should emit nothing new."""
        out = _new_crossings(percent=60.0, previous=[50], tick_time=now_utc)
        assert out == []

    def test_only_newly_crossed_thresholds_emit(
        self, now_utc: dt.datetime
    ) -> None:
        """50 already fired; now we're at 80% → only 75 fires."""
        out = _new_crossings(
            percent=80.0, previous=[50], tick_time=now_utc
        )
        assert [c.threshold for c in out] == [75]

    def test_actions_map_canonically_to_thresholds(
        self, now_utc: dt.datetime
    ) -> None:
        """Action ladder per spec §2: notified/warned/throttled/halted/
        over_limit_block."""
        out = _new_crossings(percent=200.0, previous=[], tick_time=now_utc)
        actions_by_threshold = {c.threshold: c.action for c in out}
        assert actions_by_threshold == {
            50: "notified",
            75: "warned",
            90: "throttled",
            95: "halted",
            100: "over_limit_block",
            110: "over_limit_block",
        }

    # ── _maybe_throttle ───────────────────────────────────────────────

    def test_no_throttle_below_90(self, now_utc: dt.datetime) -> None:
        assert _maybe_throttle(percent=80.0, tick_time=now_utc) is None
        assert _maybe_throttle(percent=89.99, tick_time=now_utc) is None

    def test_throttle_at_90_is_5_tps(self, now_utc: dt.datetime) -> None:
        t = _maybe_throttle(percent=90.0, tick_time=now_utc)
        assert t is not None
        assert t.tps == 5.0

    def test_throttle_at_95_is_2_tps(self, now_utc: dt.datetime) -> None:
        t = _maybe_throttle(percent=95.0, tick_time=now_utc)
        assert t is not None
        assert t.tps == 2.0

    def test_no_throttle_at_100_and_above(self, now_utc: dt.datetime) -> None:
        """At 100% the kill-switch takes over — throttling is moot."""
        assert _maybe_throttle(percent=100.0, tick_time=now_utc) is None
        assert _maybe_throttle(percent=150.0, tick_time=now_utc) is None

    def test_throttle_until_is_15_minutes_out(
        self, now_utc: dt.datetime
    ) -> None:
        t = _maybe_throttle(percent=92.0, tick_time=now_utc)
        assert t is not None
        assert t.until == now_utc + dt.timedelta(minutes=15)

    # ── _check_anomalous_burn ─────────────────────────────────────────

    def test_no_baseline_no_anomaly(self) -> None:
        s = BillingSnapshot(spentUsd=100.0, budgetUsd=100.0)
        assert _check_anomalous_burn(s, percent=99.0) is False

    def test_zero_baseline_returns_false(self) -> None:
        """Baseline of 0 = first-use, not anomalous."""
        s = BillingSnapshot(
            spentUsd=100.0, budgetUsd=100.0, baselineBurnRateUsdPerHour=0.0
        )
        assert _check_anomalous_burn(s, percent=99.0) is False

    def test_low_percent_no_anomaly_check(self) -> None:
        """Under 25% — not worth alerting even if rate looks high."""
        s = BillingSnapshot(
            spentUsd=10.0, budgetUsd=100.0, baselineBurnRateUsdPerHour=0.5
        )
        # 10 / 100 = 10% < 25 → False regardless of ratio.
        assert _check_anomalous_burn(s, percent=10.0) is False

    def test_anomalous_when_above_3x_baseline(self) -> None:
        """Per user brief: ">3x baseline" → forward to anomaly_watch."""
        s = BillingSnapshot(
            spentUsd=10.0, budgetUsd=100.0, baselineBurnRateUsdPerHour=1.0
        )
        # spent=10 > 3 * 1 = 3, AND percent 30% > 25 threshold → anomalous.
        assert _check_anomalous_burn(s, percent=30.0) is True

    def test_not_anomalous_when_below_3x_baseline(self) -> None:
        s = BillingSnapshot(
            spentUsd=2.0, budgetUsd=100.0, baselineBurnRateUsdPerHour=1.0
        )
        # 2 < 3 * 1 = 3 → not anomalous.
        assert _check_anomalous_burn(s, percent=30.0) is False

    # ── evaluate_cost_watch (end-to-end pure function) ────────────────

    def test_evaluate_happy_below_threshold(
        self, now_utc: dt.datetime
    ) -> None:
        out = evaluate_cost_watch(
            _input(spent=20.0, budget=100.0, tick=now_utc)
        )
        assert isinstance(out, CostWatchOutput)
        assert out.percent == 20.0
        assert out.crossings == []
        assert out.throttle is None
        assert out.new_previous_crossings == []
        assert out.blind is False

    def test_evaluate_first_50_crossing(
        self, now_utc: dt.datetime
    ) -> None:
        out = evaluate_cost_watch(_input(spent=55.0, budget=100.0, tick=now_utc))
        assert [c.threshold for c in out.crossings] == [50]
        assert out.crossings[0].action == "notified"
        assert out.new_previous_crossings == [50]

    def test_evaluate_emits_throttle_at_92_percent(
        self, now_utc: dt.datetime
    ) -> None:
        out = evaluate_cost_watch(
            _input(spent=92.0, budget=100.0, previous=[50, 75], tick=now_utc)
        )
        assert [c.threshold for c in out.crossings] == [90]
        assert out.throttle is not None
        assert out.throttle.tps == 5.0

    def test_evaluate_over_limit_block_fires_at_100(
        self, now_utc: dt.datetime
    ) -> None:
        """kill_switch_accuracy: 100% → over_limit_block fires."""
        out = evaluate_cost_watch(
            _input(
                spent=110.0,
                budget=100.0,
                previous=[50, 75, 90, 95],
                tick=now_utc,
            )
        )
        assert [c.threshold for c in out.crossings] == [100, 110]
        assert all(c.action == "over_limit_block" for c in out.crossings)
        # Throttle is None once we cross 100 (kill-switch takes over).
        assert out.throttle is None

    def test_evaluate_kill_switch_does_not_fire_within_budget(
        self, now_utc: dt.datetime
    ) -> None:
        """kill_switch_accuracy = 1.00 means: never halt within budget.
        Spec §7."""
        for pct in [10.0, 49.0, 65.0, 89.5, 99.99]:
            spent = pct  # budget=100 → spent==pct
            out = evaluate_cost_watch(
                _input(spent=spent, budget=100.0, tick=now_utc)
            )
            actions = {c.action for c in out.crossings}
            assert "over_limit_block" not in actions, (
                f"Kill-switch fired at {pct}% — violates kill_switch_accuracy"
            )

    def test_evaluate_zero_budget_free_tier_crosses_all(
        self, now_utc: dt.datetime
    ) -> None:
        """Spec §8 edge case 3: free-tier — any spend crosses 100%."""
        out = evaluate_cost_watch(
            _input(spent=0.01, budget=0.0, tick=now_utc)
        )
        # Every canonical threshold fires.
        assert [c.threshold for c in out.crossings] == list(CANONICAL_THRESHOLDS)
        assert out.percent == 999_999.0
        assert out.budget_usd == 0.0

    def test_evaluate_zero_budget_zero_spend_no_crossing(
        self, now_utc: dt.datetime
    ) -> None:
        """Spec §8 edge case 7: budget=0, spend=0 → 0%, no action."""
        out = evaluate_cost_watch(
            _input(spent=0.0, budget=0.0, tick=now_utc)
        )
        assert out.percent == 0.0
        assert out.crossings == []

    def test_evaluate_no_budget_falls_back_to_50(
        self, now_utc: dt.datetime
    ) -> None:
        """No Spanner row → DEFAULT_FALLBACK_BUDGET_USD."""
        out = evaluate_cost_watch(
            _input(spent=25.0, budget=None, tick=now_utc)
        )
        assert out.budget_usd == DEFAULT_FALLBACK_BUDGET_USD
        # 25 / 50 = 50% → exactly the 50 crossing.
        assert out.percent == 50.0
        assert [c.threshold for c in out.crossings] == [50]

    def test_evaluate_blind_flag_propagated(
        self, now_utc: dt.datetime
    ) -> None:
        """Spec §6 escalation: BQ failure → blind=True so workflow can emit
        cost_watch_blind."""
        out = evaluate_cost_watch(
            _input(spent=10.0, budget=100.0, stale=True, tick=now_utc)
        )
        assert out.blind is True

    def test_evaluate_dedupe_via_previous_crossings(
        self, now_utc: dt.datetime
    ) -> None:
        """A tenant who already crossed 50 + 75 last tick should not re-fire."""
        out = evaluate_cost_watch(
            _input(spent=80.0, budget=100.0, previous=[50, 75], tick=now_utc)
        )
        assert out.crossings == []
        assert out.new_previous_crossings == [50, 75]  # unchanged

    def test_evaluate_new_previous_crossings_accumulates(
        self, now_utc: dt.datetime
    ) -> None:
        """previous=[50] + new crossing of 75 → new_previous=[50, 75]."""
        out = evaluate_cost_watch(
            _input(spent=78.0, budget=100.0, previous=[50], tick=now_utc)
        )
        assert out.new_previous_crossings == [50, 75]

    def test_evaluate_force_recheck_does_not_change_output(
        self, now_utc: dt.datetime
    ) -> None:
        """Spec §8 edge case 6 — forced recheck bypasses cadence at the
        WORKFLOW layer; the rule output is identical."""
        a = evaluate_cost_watch(
            _input(spent=80.0, budget=100.0, force=False, tick=now_utc)
        )
        b = evaluate_cost_watch(
            _input(spent=80.0, budget=100.0, force=True, tick=now_utc)
        )
        assert [c.threshold for c in a.crossings] == [
            c.threshold for c in b.crossings
        ]

    def test_evaluate_tenant_and_workspace_echoed(
        self, now_utc: dt.datetime
    ) -> None:
        out = evaluate_cost_watch(
            _input(
                spent=10.0,
                budget=100.0,
                workspace="ws_acme",
                tick=now_utc,
            )
        )
        assert out.tenant_id == "t_tenant_abc12345"
        assert out.workspace_id == "ws_acme"
        assert out.window == "per_day"

    def test_evaluate_is_deterministic(self, now_utc: dt.datetime) -> None:
        """Same input ⇒ same output. Spec §1: 'Deterministic threshold gate'."""
        a = evaluate_cost_watch(_input(spent=77.0, budget=100.0, tick=now_utc))
        b = evaluate_cost_watch(_input(spent=77.0, budget=100.0, tick=now_utc))
        assert a == b

    def test_evaluate_output_round_trips(self, now_utc: dt.datetime) -> None:
        out = evaluate_cost_watch(
            _input(spent=92.0, budget=100.0, tick=now_utc)
        )
        d = out.model_dump(by_alias=True)
        reborn = CostWatchOutput.model_validate(d)
        assert reborn == out

    # ── Hypothesis property tests ─────────────────────────────────────

    @given(
        spent=st.floats(min_value=0.0, max_value=10_000.0, allow_nan=False, allow_infinity=False),
        budget=st.floats(min_value=0.01, max_value=10_000.0, allow_nan=False, allow_infinity=False),
    )
    @settings(max_examples=80, suppress_health_check=[HealthCheck.too_slow])
    def test_false_negative_rate_is_zero(
        self, spent: float, budget: float
    ) -> None:
        """Spec §7 hard requirement: false_negative_rate == 0.

        For any (spent, budget) pair with no previous crossings:
            T in output.crossings iff spent/budget * 100 >= T
        """
        percent = spent / budget * 100.0
        out = evaluate_cost_watch(
            _input(
                spent=spent,
                budget=budget,
                tick=dt.datetime(2026, 5, 19, tzinfo=dt.UTC),
            )
        )
        fired = {c.threshold for c in out.crossings}
        for threshold in CANONICAL_THRESHOLDS:
            if percent >= threshold:
                assert threshold in fired, (
                    f"FN: T={threshold} not fired at {percent:.2f}% "
                    f"(spent={spent}, budget={budget})"
                )
            else:
                assert threshold not in fired, (
                    f"FP: T={threshold} fired at {percent:.2f}% "
                    f"(spent={spent}, budget={budget})"
                )

    @given(
        pct=st.floats(min_value=0.0, max_value=99.999, allow_nan=False, allow_infinity=False),
    )
    @settings(max_examples=40, suppress_health_check=[HealthCheck.too_slow])
    def test_kill_switch_accuracy_within_budget(self, pct: float) -> None:
        """Spec §7: kill_switch_accuracy == 1.00. The over_limit_block
        action must NEVER fire below 100 %, regardless of percentage."""
        out = evaluate_cost_watch(
            _input(
                spent=pct,  # budget=100 → spent==pct
                budget=100.0,
                tick=dt.datetime(2026, 5, 19, tzinfo=dt.UTC),
            )
        )
        assert all(c.action != "over_limit_block" for c in out.crossings)


# ═════════════════════════════════════════════════════════════════════════════
# 3. TestAgentDefShape — registry-consistency invariants.
# ═════════════════════════════════════════════════════════════════════════════


class TestAgentDefShape:
    """cost_watch's AgentDef exists for registry + observability parity
    with the LLM-driven agents. These tests pin the differences that
    matter (no tools, sentinel model id, etc.)."""

    def test_agent_id(self) -> None:
        assert cost_watch_agent_def.id == "cost-watch"

    def test_no_tools(self) -> None:
        """W2-C1: cost_watch owns billing.query + pubsub.alert per
        ARCHITECTURE.md §3 row 21. The agent itself is rule-based (no
        LLM, evaluate_cost_watch() is the runtime path) but the
        capabilities are surfaced on the AgentDef tool list so the
        registry view enumerates the full contract."""
        tool_names = {t.__name__ for t in cost_watch_agent_def.tools}
        assert tool_names == {"billing_query", "pubsub_alert"}

    def test_model_is_sentinel(self) -> None:
        """Sentinel id NOT in MODEL_PRICING → loud failure if anyone routes
        this through `run_agent()`. See module docstring."""
        assert cost_watch_agent_def.model == COST_WATCH_MODEL_SENTINEL
        assert cost_watch_agent_def.model == "none-rule-based"

    def test_model_sentinel_not_in_pricing(self) -> None:
        from ss_agents.config import MODEL_PRICING

        assert COST_WATCH_MODEL_SENTINEL not in MODEL_PRICING

    def test_max_usd_is_minimal(self) -> None:
        """Field requires gt=0.0; we set 0.0001 — meaningless, never charged."""
        assert cost_watch_agent_def.max_usd == 0.0001

    def test_max_turns_is_one(self) -> None:
        """Single-shot rule eval."""
        assert cost_watch_agent_def.max_turns == 1

    def test_input_schema_is_cost_watch_input(self) -> None:
        assert cost_watch_agent_def.input_schema is CostWatchInput

    def test_output_schema_is_cost_watch_output(self) -> None:
        assert cost_watch_agent_def.output_schema is CostWatchOutput

    def test_description_mentions_watchdog_and_no_llm(self) -> None:
        """Description must surface the rule-based nature so registry
        consumers (M1 coordinator, dashboard) handle it correctly."""
        desc = cost_watch_agent_def.description.lower()
        assert "watchdog" in desc
        assert "rule-based" in desc
        assert "no llm" in desc

    def test_system_prompt_builder_is_sentinel(self) -> None:
        """The prompt builder returns a constant marker string — never
        sent to a model. We pin the content so a future refactor doesn't
        accidentally start expanding it into a real prompt."""
        # Builder accepts any BaseModel (signature compatibility with
        # the rest of the fleet) — pass a dummy.
        marker = build_cost_watch_system_prompt(
            CostWatchInput(
                tenantId="t_x",
                window="per_day",
                tickTime=dt.datetime(2026, 5, 19, tzinfo=dt.UTC),
                billingSnapshot=BillingSnapshot(
                    spentUsd=0.0, budgetUsd=100.0
                ),
            )
        )
        assert "rule-based watchdog" in marker
        assert "evaluate_cost_watch" in marker


# ═════════════════════════════════════════════════════════════════════════════
# 4. Misc invariants surfaced by the spec eval-criteria block.
# ═════════════════════════════════════════════════════════════════════════════


class TestEvalInvariants:
    """One-liner pins for the spec §7 eval table. These run fast and would
    catch any regression on the safety-critical metrics."""

    def test_canonical_thresholds_match_spec(self) -> None:
        """Spec §2 #/$defs/ThresholdPercent enum."""
        assert CANONICAL_THRESHOLDS == (50, 75, 90, 95, 100, 110)

    def test_actions_are_canonical_enum(self) -> None:
        """Spec §2 properties.Output.crossings.items.action enum."""
        canonical_actions = {
            "notified",
            "warned",
            "throttled",
            "halted",
            "over_limit_block",
        }
        # Run every threshold so every action shows up at least once.
        out_all = _new_crossings(
            percent=200.0,
            previous=[],
            tick_time=dt.datetime(2026, 5, 19, tzinfo=dt.UTC),
        )
        observed = {c.action for c in out_all}
        # Every observed action must be canonical.
        assert observed <= canonical_actions

    def test_default_fallback_budget_is_50_usd_per_day(self) -> None:
        """Spec §6: 'default to $50/day'."""
        assert DEFAULT_FALLBACK_BUDGET_USD == 50.0


# ═════════════════════════════════════════════════════════════════════════════
# 5. TestCostGuard — D46 auto-scale wiring (I4).
#
# Proves the billing.query → threshold ladder → pubsub.alert → (90%)
# runbook_execute("scale_down") chain. Every tool runs in stub capability
# mode (CAPABILITY_LAYER_MODE unset/stub) so the test is offline + deterministic.
# ═════════════════════════════════════════════════════════════════════════════


class TestCostGuard:
    """The cost-guard wiring is the I4 deliverable: it ties the three
    cost_watch capabilities together and auto-triggers scale_down at 90%.

    Stub mode keeps every hop deterministic + side-effect-free
    (runbook_execute forces dry_run; pubsub_alert mints a synthetic id)."""

    @pytest.fixture(autouse=True)
    def _force_stub_mode(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """All guard tests run with the capability layer in stub mode so no
        real Pub/Sub publish or Cloud Workflows execution can occur."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")

    def test_trigger_constant_is_90(self) -> None:
        """The scale_down trigger fires at the 90% banner threshold per the
        I4 brief."""
        assert SCALE_DOWN_TRIGGER_PERCENT == 90.0

    # ── below trigger: alert(s) only, no scale_down ───────────────────

    def test_below_50_no_alerts_no_scale_down(
        self, now_utc: dt.datetime
    ) -> None:
        out = cost_guard(_input(spent=20.0, budget=100.0, tick=now_utc))
        assert isinstance(out, CostGuardResult)
        assert out.evaluation.crossings == []
        assert out.alert_message_ids == []
        assert out.scale_down_triggered is False
        assert out.scale_down_execution_id is None

    def test_50_crossing_publishes_one_alert_no_scale_down(
        self, now_utc: dt.datetime
    ) -> None:
        out = cost_guard(_input(spent=55.0, budget=100.0, tick=now_utc))
        assert [c.threshold for c in out.evaluation.crossings] == [50]
        # One banner alert published for the 50 crossing.
        assert len(out.alert_message_ids) == 1
        assert out.alert_message_ids[0].startswith("stub_msg_budget_50_")
        # 50 < 90 → no scale_down.
        assert out.scale_down_triggered is False
        assert out.scale_down_execution_id is None

    def test_75_crossing_publishes_two_alerts_no_scale_down(
        self, now_utc: dt.datetime
    ) -> None:
        out = cost_guard(_input(spent=80.0, budget=100.0, tick=now_utc))
        assert [c.threshold for c in out.evaluation.crossings] == [50, 75]
        assert len(out.alert_message_ids) == 2
        assert out.scale_down_triggered is False

    # ── at/above trigger: scale_down fires ────────────────────────────

    def test_90_crossing_triggers_scale_down(
        self, now_utc: dt.datetime
    ) -> None:
        """The headline I4 contract: at 90% the guard auto-triggers the
        scale_down runbook."""
        out = cost_guard(
            _input(spent=92.0, budget=100.0, previous=[50, 75], tick=now_utc)
        )
        # 90 fired this tick (50/75 already deduped).
        assert [c.threshold for c in out.evaluation.crossings] == [90]
        # Banner alert for the 90 crossing.
        assert len(out.alert_message_ids) == 1
        assert out.alert_message_ids[0].startswith("stub_msg_budget_90_")
        # And the scale_down runbook fired.
        assert out.scale_down_triggered is True
        assert out.scale_down_execution_id is not None
        assert out.scale_down_execution_id.startswith("stub_exec_scale_down_")

    def test_fresh_climb_to_95_alerts_all_and_scales_down(
        self, now_utc: dt.datetime
    ) -> None:
        """A tenant that jumps straight to 95% with no prior crossings fires
        50/75/90/95 alerts AND scale_down (because 90 + 95 both >= trigger)."""
        out = cost_guard(_input(spent=96.0, budget=100.0, tick=now_utc))
        assert [c.threshold for c in out.evaluation.crossings] == [
            50,
            75,
            90,
            95,
        ]
        # Four banner alerts (50/75/90/95 are all banner kinds).
        assert len(out.alert_message_ids) == 4
        assert out.scale_down_triggered is True

    def test_over_limit_crossings_scale_down_but_no_banner_for_100_110(
        self, now_utc: dt.datetime
    ) -> None:
        """100/110 are NOT banner alert kinds (they belong to the
        budget_exceeded topic) — so no banner alert is published for them,
        but they DO trigger scale_down (>= 90)."""
        out = cost_guard(
            _input(
                spent=110.0,
                budget=100.0,
                previous=[50, 75, 90, 95],
                tick=now_utc,
            )
        )
        assert [c.threshold for c in out.evaluation.crossings] == [100, 110]
        # No banner alerts (100/110 aren't in the banner ladder).
        assert out.alert_message_ids == []
        # But scale_down still fired (crossings >= 90).
        assert out.scale_down_triggered is True

    def test_already_at_90_does_not_refire(self, now_utc: dt.datetime) -> None:
        """If 90 already crossed last tick (in previous_crossings), a tick
        still above 90 emits NO new crossing → no new alert, no scale_down."""
        out = cost_guard(
            _input(
                spent=92.0,
                budget=100.0,
                previous=[50, 75, 90],
                tick=now_utc,
            )
        )
        assert out.evaluation.crossings == []
        assert out.alert_message_ids == []
        # No NEW 90 crossing this tick → guard does not re-trigger scale_down.
        assert out.scale_down_triggered is False

    # ── dry-run safety ────────────────────────────────────────────────

    def test_scale_down_is_dry_run_by_default(
        self, now_utc: dt.datetime
    ) -> None:
        """The guard defaults to dry_run; the stub runbook forces it too, so
        no real fleet scale can occur from a test/dev tick."""
        out = cost_guard(_input(spent=92.0, budget=100.0, previous=[50, 75], tick=now_utc))
        assert out.scale_down_triggered is True
        # Stub execution id is deterministic regardless of dry_run.
        again = cost_guard(
            _input(spent=92.0, budget=100.0, previous=[50, 75], tick=now_utc),
            dry_run=False,
        )
        # Same params → same stub execution id (the stub ignores dry_run for
        # determinism; the LIVE path is where dry_run=False matters).
        assert again.scale_down_execution_id == out.scale_down_execution_id

    def test_guard_is_deterministic(self, now_utc: dt.datetime) -> None:
        a = cost_guard(_input(spent=96.0, budget=100.0, tick=now_utc))
        b = cost_guard(_input(spent=96.0, budget=100.0, tick=now_utc))
        assert a.alert_message_ids == b.alert_message_ids
        assert a.scale_down_execution_id == b.scale_down_execution_id

    # ── full billing-fed path ─────────────────────────────────────────

    def test_from_billing_uses_d39_cap_when_no_budget(
        self, now_utc: dt.datetime
    ) -> None:
        """cost_guard_from_billing reads billing_query (stub) and measures
        against the D39 $1500 cap when no explicit budget is given. The
        canonical demo workspace ($42.50/day → ~3% of $1500) trips nothing."""
        out = cost_guard_from_billing(
            tenant_id="t_demo",
            window="per_day",
            tick_time=now_utc,
            time_range=(now_utc.date(), now_utc.date()),
            workspace_id="ws_demo",
        )
        # $42.50 / $1500 = ~2.8% → no crossings, no alerts, no scale_down.
        assert out.evaluation.crossings == []
        assert out.alert_message_ids == []
        assert out.scale_down_triggered is False
        assert out.evaluation.budget_usd == 1500.0

    def test_from_billing_explicit_low_budget_trips_scale_down(
        self, now_utc: dt.datetime
    ) -> None:
        """With a tight explicit budget the demo workspace's $42.50/day
        crosses 90% and the guard auto-scales-down."""
        # $42.50 spend against a $45 budget = ~94% → fires 50/75/90 + scale_down.
        out = cost_guard_from_billing(
            tenant_id="t_demo",
            window="per_day",
            tick_time=now_utc,
            time_range=(now_utc.date(), now_utc.date()),
            workspace_id="ws_demo",
            budget_usd=45.0,
        )
        thresholds = [c.threshold for c in out.evaluation.crossings]
        assert 90 in thresholds
        assert out.scale_down_triggered is True
        assert out.scale_down_execution_id is not None
