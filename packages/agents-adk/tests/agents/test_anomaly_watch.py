"""tests/agents/test_anomaly_watch.py — 3-class contract per MATRIX.md §4.2.

Mirrors `test_intake.py` shape:

| Test class                | Purpose                                          |
|---------------------------|--------------------------------------------------|
| TestInputContract         | Pydantic validation (parametrized + property)    |
| TestPlumbing              | Scripted-stub end-to-end (single-shot, no tools) |
| TestEscalation            | Forces every escalation path                     |

Plus:
- TestZScoreMath — pure-Python z-score + classify_severity invariants.
- TestSystemPrompt — locale rendering + precomputed-severity embedding.
"""
from __future__ import annotations

import datetime as dt
import math
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from pydantic import ValidationError

from ss_agents.agents.anomaly_watch import (
    ANOMALY_WATCH_MAX_USD,
    Z_CRIT,
    Z_WARN,
    AnomalyAction,
    AnomalyWatchInput,
    AnomalyWatchOutput,
    DetectedAnomaly,
    MetricSnapshot,
    anomaly_watch_agent_def,
    build_anomaly_watch_system_prompt,
    classify_severity,
    compute_z_score,
)
from ss_agents.runtime import Escalation, OutcomeOk, RunContext, run_agent

# ─────────────────────────────────────────────────────────────────────────────
# Fixtures — local to this module (the shared conftest has nothing watchdog-
# specific yet; Phase 5 may promote these into conftest if other watchdog
# agents grow tests).
# ─────────────────────────────────────────────────────────────────────────────


NOW = dt.datetime(2026, 5, 19, 12, 0, tzinfo=dt.UTC)


def _snap(
    metric: str = "latency_p99_ms",
    value: float = 1100.0,
    p50: float = 1000.0,
    p99: float = 1200.0,
    tenant: str | None = None,
    region: str | None = "us-central1",
) -> MetricSnapshot:
    """Convenience constructor — keeps tests readable."""
    return MetricSnapshot(
        metricName=metric,  # type: ignore[arg-type]
        ts=NOW,
        value=value,
        baselineP50=p50,
        baselineP99=p99,
        tenantId=tenant,
        region=region,
    )


def _clean_input() -> AnomalyWatchInput:
    """A 'no anomalies' tick — every metric near its p50."""
    return AnomalyWatchInput(
        metricSnapshots=[
            _snap("latency_p99_ms", 1010.0, 1000.0, 1200.0),
            _snap("error_rate", 0.011, 0.010, 0.020),
        ],
        currentRunbooksAvailable=["throttle-vertex-v1", "quarantine-tenant-v1"],
        pageThresholdSeverity="critical",
        locale="en",
    )


def _spike_input(z_target: float = 4.5) -> AnomalyWatchInput:
    """One metric way above its baseline — should classify critical."""
    p50, p99 = 1000.0, 1200.0
    sigma = (p99 - p50) / 2.326
    value = p50 + z_target * sigma
    return AnomalyWatchInput(
        metricSnapshots=[_snap("latency_p99_ms", value, p50, p99)],
        currentRunbooksAvailable=["throttle-vertex-v1"],
        pageThresholdSeverity="critical",
        locale="en",
    )


# ═════════════════════════════════════════════════════════════════════════════
# 1. TestInputContract — Pydantic validation.
# ═════════════════════════════════════════════════════════════════════════════


class TestInputContract:
    """Per MATRIX.md §4.2 row 1: valid inputs accepted; invalid raise."""

    def test_minimal_valid_input(self) -> None:
        v = _clean_input()
        assert len(v.metric_snapshots) == 2
        assert v.locale == "en"
        assert v.page_threshold_severity == "critical"

    @pytest.mark.parametrize(
        "metric_name",
        [
            "latency_p95_ms",
            "latency_p99_ms",
            "error_rate",
            "model_armor_block_count",
            "agent_escalation_count",
            "token_count_per_call",
            "tool_failure_count",
            "cost_usd_per_hour",
        ],
    )
    def test_all_metric_names_accepted(self, metric_name: str) -> None:
        s = _snap(metric_name)
        assert s.metric_name == metric_name

    @pytest.mark.parametrize("bad", ["cpu_pct", "memory_mb", "", "LATENCY_P99_MS"])
    def test_invalid_metric_name_rejected(self, bad: str) -> None:
        with pytest.raises(ValidationError):
            _snap(bad)

    def test_negative_value_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _snap("error_rate", value=-0.01)

    def test_empty_snapshots_rejected(self) -> None:
        with pytest.raises(ValidationError):
            AnomalyWatchInput(
                metricSnapshots=[],
                currentRunbooksAvailable=[],
            )

    def test_snapshots_cap_at_200(self) -> None:
        many = [_snap("error_rate", 0.01, 0.01, 0.02) for _ in range(201)]
        with pytest.raises(ValidationError):
            AnomalyWatchInput(metricSnapshots=many)

    @pytest.mark.parametrize("locale", ["ko", "en", "ja", "zh-CN"])
    def test_all_four_locales_accepted(self, locale: str) -> None:
        v = AnomalyWatchInput(
            metricSnapshots=[_snap()],
            currentRunbooksAvailable=[],
            locale=locale,  # type: ignore[arg-type]
        )
        assert v.locale == locale

    @pytest.mark.parametrize("bad_locale", ["fr", "de", "EN", ""])
    def test_invalid_locale_rejected(self, bad_locale: str) -> None:
        with pytest.raises(ValidationError):
            AnomalyWatchInput(
                metricSnapshots=[_snap()],
                locale=bad_locale,  # type: ignore[arg-type]
            )

    def test_output_action_kind_validated(self) -> None:
        with pytest.raises(ValidationError):
            AnomalyAction(
                kind="explode",  # type: ignore[arg-type]
                severity="critical",
                reason="x",
            )

    def test_output_severity_validated(self) -> None:
        with pytest.raises(ValidationError):
            DetectedAnomaly(
                metric="latency_p99_ms",
                severity="catastrophic",  # type: ignore[arg-type]
                zScore=5.0,
                suspectedCause="x",
            )

    def test_output_confidence_bounded(self) -> None:
        with pytest.raises(ValidationError):
            AnomalyWatchOutput(
                anomaliesDetected=[],
                actions=[],
                confidence=1.5,
            )
        with pytest.raises(ValidationError):
            AnomalyWatchOutput(
                anomaliesDetected=[],
                actions=[],
                confidence=-0.1,
            )

    def test_runbooks_cap_at_50(self) -> None:
        with pytest.raises(ValidationError):
            AnomalyWatchInput(
                metricSnapshots=[_snap()],
                currentRunbooksAvailable=[f"rb-{i}" for i in range(51)],
            )

    # ── Hypothesis property tests ─────────────────────────────────────────

    @given(
        value=st.floats(min_value=0.0, max_value=1e6, allow_nan=False, allow_infinity=False),
        p50=st.floats(min_value=0.01, max_value=1e6, allow_nan=False, allow_infinity=False),
        delta=st.floats(min_value=0.0, max_value=1e5, allow_nan=False, allow_infinity=False),
    )
    @settings(max_examples=40, suppress_health_check=[HealthCheck.too_slow])
    def test_snapshot_property_accepts_any_nonneg(
        self, value: float, p50: float, delta: float
    ) -> None:
        # p99 = p50 + delta guarantees p99 >= p50 (the natural percentile order).
        s = MetricSnapshot(
            metricName="latency_p99_ms",
            ts=NOW,
            value=value,
            baselineP50=p50,
            baselineP99=p50 + delta,
        )
        assert s.value == value


# ═════════════════════════════════════════════════════════════════════════════
# 2. TestPlumbing — scripted stub end-to-end through the runtime.
# ═════════════════════════════════════════════════════════════════════════════


class TestPlumbing:
    """The agent has no tools; 'plumbing' here means: the runtime threads
    input → prompt → stub → validated output → OutcomeOk correctly."""

    async def test_clean_tick_returns_empty_actions(
        self, run_context: RunContext, make_stub: Any
    ) -> None:
        clean_output = AnomalyWatchOutput(
            anomaliesDetected=[], actions=[], confidence=1.0
        )
        stub = make_stub(turns=[clean_output], usd_per_call=0.002)
        run_context.model_client = stub

        outcome = await run_agent(anomaly_watch_agent_def, _clean_input(), run_context)
        assert isinstance(outcome, OutcomeOk)
        out: AnomalyWatchOutput = outcome.value  # type: ignore[assignment]
        assert out.anomalies_detected == []
        assert out.actions == []
        assert out.confidence == 1.0
        assert stub._call_count == 1

    async def test_spike_triggers_runbook(
        self, run_context: RunContext, make_stub: Any
    ) -> None:
        scripted = AnomalyWatchOutput(
            anomaliesDetected=[
                DetectedAnomaly(
                    metric="latency_p99_ms",
                    severity="critical",
                    zScore=4.5,
                    suspectedCause="Vertex AI Agent Runtime cold start storm in us-central1.",
                )
            ],
            actions=[
                AnomalyAction(
                    kind="trigger_runbook",
                    runbookId="throttle-vertex-v1",
                    severity="critical",
                    reason="p99 latency 4.5 sigma above baseline; throttling Vertex calls.",
                )
            ],
            confidence=0.88,
        )
        stub = make_stub(turns=[scripted], usd_per_call=0.003)
        run_context.model_client = stub

        outcome = await run_agent(anomaly_watch_agent_def, _spike_input(), run_context)
        assert isinstance(outcome, OutcomeOk)
        out: AnomalyWatchOutput = outcome.value  # type: ignore[assignment]
        assert len(out.anomalies_detected) == 1
        assert out.anomalies_detected[0].severity == "critical"
        assert out.actions[0].kind == "trigger_runbook"
        assert out.actions[0].runbook_id == "throttle-vertex-v1"

    async def test_no_matching_runbook_pages_human(
        self, run_context: RunContext, make_stub: Any
    ) -> None:
        """Spec §6 escalation: 'no matching runbook' → page_human."""
        scripted = AnomalyWatchOutput(
            anomaliesDetected=[
                DetectedAnomaly(
                    metric="model_armor_block_count",
                    severity="critical",
                    zScore=6.2,
                    suspectedCause="Sustained injection campaign — no auto-runbook covers Model Armor blocks.",
                )
            ],
            actions=[
                AnomalyAction(
                    kind="page_human",
                    severity="critical",
                    reason="Model Armor block count 6 sigma above baseline; no registered runbook.",
                )
            ],
            confidence=0.92,
        )
        stub = make_stub(turns=[scripted], usd_per_call=0.003)
        run_context.model_client = stub

        payload = AnomalyWatchInput(
            metricSnapshots=[
                _snap("model_armor_block_count", 60.0, 5.0, 12.0)
            ],
            currentRunbooksAvailable=["throttle-vertex-v1"],  # no match
            pageThresholdSeverity="critical",
            locale="en",
        )
        outcome = await run_agent(anomaly_watch_agent_def, payload, run_context)
        assert isinstance(outcome, OutcomeOk)
        out: AnomalyWatchOutput = outcome.value  # type: ignore[assignment]
        assert out.actions[0].kind == "page_human"
        assert out.actions[0].runbook_id is None

    async def test_warn_severity_silent_log_when_threshold_critical(
        self, run_context: RunContext, make_stub: Any
    ) -> None:
        """page_threshold=critical → warn anomalies silent-log instead of page."""
        scripted = AnomalyWatchOutput(
            anomaliesDetected=[
                DetectedAnomaly(
                    metric="error_rate",
                    severity="warn",
                    zScore=2.4,
                    suspectedCause="Mild error-rate elevation, within SLO budget.",
                )
            ],
            actions=[
                AnomalyAction(
                    kind="silent_log",
                    severity="warn",
                    reason="Error rate 2.4 sigma above baseline but no available runbook and below page threshold.",
                )
            ],
            confidence=0.75,
        )
        stub = make_stub(turns=[scripted], usd_per_call=0.002)
        run_context.model_client = stub

        outcome = await run_agent(anomaly_watch_agent_def, _clean_input(), run_context)
        assert isinstance(outcome, OutcomeOk)
        out: AnomalyWatchOutput = outcome.value  # type: ignore[assignment]
        assert out.actions[0].kind == "silent_log"


# ═════════════════════════════════════════════════════════════════════════════
# 3. TestEscalation — every escalation path returns Escalation, not raises.
# ═════════════════════════════════════════════════════════════════════════════


class TestEscalation:
    """Per MATRIX.md §4.2 row 3 + anomaly_watch.spec.md §6 escalation."""

    async def test_budget_exhausted_pre_call(
        self, run_context: RunContext, make_stub: Any
    ) -> None:
        clean_output = AnomalyWatchOutput(
            anomaliesDetected=[], actions=[], confidence=1.0
        )
        stub = make_stub(turns=[clean_output])
        run_context.model_client = stub
        run_context.campaign_budget_usd = 0.0

        outcome = await run_agent(anomaly_watch_agent_def, _clean_input(), run_context)
        assert isinstance(outcome, Escalation)
        assert "budget exhausted" in outcome.reason.lower()
        assert stub._call_count == 0

    async def test_max_usd_cap_breached(
        self, run_context: RunContext, make_stub: Any
    ) -> None:
        """Per-call cap is $0.01. A 0.05 stub call must escalate."""
        clean_output = AnomalyWatchOutput(
            anomaliesDetected=[], actions=[], confidence=1.0
        )
        stub = make_stub(turns=[clean_output], usd_per_call=0.05)
        run_context.model_client = stub

        outcome = await run_agent(anomaly_watch_agent_def, _clean_input(), run_context)
        assert isinstance(outcome, Escalation)
        assert "USD cap" in outcome.reason

    async def test_invalid_input_escalates_not_raises(
        self, run_context: RunContext, make_stub: Any
    ) -> None:
        """Bad input dict → Escalation, not ValidationError. The runtime
        catches pydantic errors and converts to Escalation envelope."""
        clean_output = AnomalyWatchOutput(
            anomaliesDetected=[], actions=[], confidence=1.0
        )
        stub = make_stub(turns=[clean_output])
        run_context.model_client = stub

        bad_payload = {"metricSnapshots": []}  # empty list violates min_length=1
        outcome = await run_agent(anomaly_watch_agent_def, bad_payload, run_context)
        assert isinstance(outcome, Escalation)
        assert "input validation failed" in outcome.reason

    async def test_stub_raises_runtime_error_escalates(
        self, run_context: RunContext, make_stub: Any
    ) -> None:
        clean_output = AnomalyWatchOutput(
            anomaliesDetected=[], actions=[], confidence=1.0
        )
        stub = make_stub(turns=[clean_output], error_on_call=1)
        run_context.model_client = stub

        outcome = await run_agent(anomaly_watch_agent_def, _clean_input(), run_context)
        assert isinstance(outcome, Escalation)
        assert "scripted vertex failure" in outcome.reason


# ═════════════════════════════════════════════════════════════════════════════
# 4. TestZScoreMath — the precomputation helpers (the agent doesn't do math).
# ═════════════════════════════════════════════════════════════════════════════


class TestZScoreMath:
    def test_value_at_baseline_is_zero_z(self) -> None:
        z = compute_z_score(1000.0, 1000.0, 1200.0)
        assert z == pytest.approx(0.0, abs=1e-6)

    def test_value_at_p99_is_about_2_326(self) -> None:
        """By construction (sigma = (p99 - p50) / 2.326), a value sitting
        exactly at p99 must have z ≈ +2.326."""
        z = compute_z_score(1200.0, 1000.0, 1200.0)
        assert z == pytest.approx(2.326, rel=0.01)

    def test_z_score_capped_at_plus_minus_10(self) -> None:
        # Tiny sigma → divides explode → capped.
        z = compute_z_score(1e6, 1.0, 1.001)
        assert z == 10.0
        z2 = compute_z_score(0.0, 1e6, 1e6 + 0.001)
        assert z2 == -10.0

    def test_classify_severity_boundaries(self) -> None:
        assert classify_severity(0.0) == "info"
        assert classify_severity(Z_WARN - 0.01) == "info"
        assert classify_severity(Z_WARN) == "warn"
        assert classify_severity(Z_WARN + 0.5) == "warn"
        assert classify_severity(Z_CRIT) == "critical"
        assert classify_severity(Z_CRIT + 1.0) == "critical"
        # Symmetric: negative deviations also classify (e.g. escalation_count
        # dropping to zero is a silent-failure signal).
        assert classify_severity(-Z_CRIT - 1.0) == "critical"

    @given(value=st.floats(min_value=0.0, max_value=1e9, allow_nan=False, allow_infinity=False))
    @settings(max_examples=40, suppress_health_check=[HealthCheck.too_slow])
    def test_z_score_is_always_finite_and_bounded(self, value: float) -> None:
        z = compute_z_score(value, 100.0, 200.0)
        assert math.isfinite(z)
        assert -10.0 <= z <= 10.0


# ═════════════════════════════════════════════════════════════════════════════
# 5. TestSystemPrompt — locale + precomputed-severity embedding.
# ═════════════════════════════════════════════════════════════════════════════


class TestSystemPrompt:
    def test_prompt_includes_precomputed_z_scores(self) -> None:
        payload = _spike_input(z_target=4.5)
        rendered = build_anomaly_watch_system_prompt(payload)
        # Severity classification appears verbatim in the rendered prompt.
        assert "precomputed_severity=critical" in rendered
        assert "latency_p99_ms" in rendered

    def test_prompt_includes_runbook_list(self) -> None:
        payload = AnomalyWatchInput(
            metricSnapshots=[_snap()],
            currentRunbooksAvailable=["rb-a", "rb-b"],
        )
        rendered = build_anomaly_watch_system_prompt(payload)
        assert "rb-a, rb-b" in rendered

    def test_prompt_handles_empty_runbook_list(self) -> None:
        payload = AnomalyWatchInput(
            metricSnapshots=[_snap()],
            currentRunbooksAvailable=[],
        )
        rendered = build_anomaly_watch_system_prompt(payload)
        assert "page_human or silent_log only" in rendered

    @pytest.mark.parametrize(
        ("locale", "marker"),
        [("ko", "한국어"), ("en", "English"), ("ja", "日本語"), ("zh-CN", "简体中文")],
    )
    def test_prompt_renders_locale(self, locale: str, marker: str) -> None:
        payload = AnomalyWatchInput(
            metricSnapshots=[_snap()],
            locale=locale,  # type: ignore[arg-type]
        )
        rendered = build_anomaly_watch_system_prompt(payload)
        assert marker in rendered

    def test_agent_def_metadata(self) -> None:
        assert anomaly_watch_agent_def.id == "anomaly-watch"
        assert anomaly_watch_agent_def.model == "gemini-2.5-flash"
        assert anomaly_watch_agent_def.max_usd == ANOMALY_WATCH_MAX_USD == 0.01
        # W2-C1: anomaly_watch owns metrics.query + runbook.execute per
        # anomaly_watch.spec.md §6. The capabilities are exposed as tools
        # on the AgentDef even though the workflow typically pre-queries.
        tool_names = {t.__name__ for t in anomaly_watch_agent_def.tools}
        assert tool_names == {"metrics_query", "runbook_execute"}
        assert anomaly_watch_agent_def.max_turns == 1
