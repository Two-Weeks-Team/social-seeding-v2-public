"""tests/tools/test_metrics_query.py — W2-C1 anomaly_watch metrics.query seam.

Coverage matrix:
    1. Default mode = stub; healthy reading returns 10 points + score 0.15.
    2. Pydantic input validation (range ordering, tz-awareness, aggregation enum).
    3. Stub determinism (byte-identical output across calls).
    4. Aggregation parametrize — every aligner round-trips through `aggregation_used`.
    5. Filter dict — different filters → different base values.
    6. Live mode raises NotImplementedError with W7 message.
    7. `usd_cost` attribute exposed for cost_watch aggregator (D41).
    8. Sub-cent USD cost.

Citations: D41 (capability layer stub/live), D23 (Tier-3 W1), D32 (Cloud
    Monitoring IR), anomaly_watch.spec.md §6.
"""
from __future__ import annotations

import datetime as dt

import pytest
from pydantic import ValidationError

from ss_agents.tools.metrics_query import (
    USD_COST,
    Aggregation,
    MetricPoint,
    MetricsQueryInput,
    MetricsQueryOutput,
    metrics_query,
)


_START = dt.datetime(2026, 5, 19, 12, 0, 0, tzinfo=dt.UTC)
_END = dt.datetime(2026, 5, 19, 12, 5, 0, tzinfo=dt.UTC)


# ─────────────────────────────────────────────────────────────────────────────
# Test 1 — default mode is stub, healthy reading
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub_returns_10_points(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = metrics_query(
        MetricsQueryInput(
            metric_type="aiplatform.googleapis.com/agent/latency_p99",
            time_range=(_START, _END),
            aggregation="p99",
        )
    )
    assert isinstance(out, MetricsQueryOutput)
    assert out.total_points == 10
    assert len(out.points) == 10
    assert all(isinstance(p, MetricPoint) for p in out.points)
    assert out.aggregation_used == "p99"
    assert out.anomaly_score_0_1 == 0.15


def test_stub_points_span_time_range(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = metrics_query(
        MetricsQueryInput(
            metric_type="x.metric",
            time_range=(_START, _END),
            aggregation="mean",
        )
    )
    timestamps = [p.timestamp for p in out.points]
    assert timestamps[0] == _START
    assert timestamps[-1] == _END
    # Monotonic ascending.
    assert timestamps == sorted(timestamps)


# ─────────────────────────────────────────────────────────────────────────────
# Test 2 — input validation
# ─────────────────────────────────────────────────────────────────────────────


class TestInputValidation:
    def test_rejects_inverted_range(self) -> None:
        with pytest.raises(ValidationError):
            MetricsQueryInput(
                metric_type="x",
                time_range=(_END, _START),  # inverted
                aggregation="mean",
            )

    def test_rejects_naive_datetime(self) -> None:
        naive_start = dt.datetime(2026, 5, 19, 12, 0, 0)
        with pytest.raises(ValidationError):
            MetricsQueryInput(
                metric_type="x",
                time_range=(naive_start, _END),
                aggregation="mean",
            )

    def test_rejects_unknown_aggregation(self) -> None:
        with pytest.raises(ValidationError):
            MetricsQueryInput.model_validate(
                {
                    "metric_type": "x",
                    "time_range": [_START, _END],
                    "aggregation": "median",  # not in literal
                }
            )

    def test_rejects_empty_metric_type(self) -> None:
        with pytest.raises(ValidationError):
            MetricsQueryInput(
                metric_type="",
                time_range=(_START, _END),
                aggregation="mean",
            )

    def test_rejects_unknown_extra_field(self) -> None:
        with pytest.raises(ValidationError):
            MetricsQueryInput.model_validate(
                {
                    "metric_type": "x",
                    "time_range": [_START, _END],
                    "aggregation": "mean",
                    "namespace": "default",  # not in schema
                }
            )

    def test_caps_filters_at_16(self) -> None:
        with pytest.raises(ValidationError):
            MetricsQueryInput(
                metric_type="x",
                time_range=(_START, _END),
                aggregation="mean",
                filters={f"k{i}": f"v{i}" for i in range(17)},
            )


# ─────────────────────────────────────────────────────────────────────────────
# Test 3 — determinism
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = MetricsQueryInput(
        metric_type="latency_p99_ms",
        time_range=(_START, _END),
        aggregation="p99",
        filters={"region": "us-central1"},
    )
    a = metrics_query(payload)
    b = metrics_query(payload)
    assert a.model_dump_json() == b.model_dump_json()


# ─────────────────────────────────────────────────────────────────────────────
# Test 4 — aggregation parametrize
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "aggregation", ["mean", "p50", "p95", "p99", "sum", "count"]
)
def test_aggregation_roundtrip(
    aggregation: Aggregation, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = metrics_query(
        MetricsQueryInput(
            metric_type="latency",
            time_range=(_START, _END),
            aggregation=aggregation,
        )
    )
    assert out.aggregation_used == aggregation


# ─────────────────────────────────────────────────────────────────────────────
# Test 5 — different filters → different base value (but still deterministic)
# ─────────────────────────────────────────────────────────────────────────────


def test_filters_change_base_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    a = metrics_query(
        MetricsQueryInput(
            metric_type="x",
            time_range=(_START, _END),
            aggregation="mean",
            filters={"region": "us-central1"},
        )
    )
    b = metrics_query(
        MetricsQueryInput(
            metric_type="x",
            time_range=(_START, _END),
            aggregation="mean",
            filters={"region": "asia-northeast3"},
        )
    )
    assert a.points[0].value != b.points[0].value


def test_no_filters_still_deterministic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = MetricsQueryInput(
        metric_type="x",
        time_range=(_START, _END),
        aggregation="mean",
    )
    a = metrics_query(payload)
    b = metrics_query(payload)
    assert a.points[0].value == b.points[0].value


# ─────────────────────────────────────────────────────────────────────────────
# Test 6 — live mode raises
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        metrics_query(
            MetricsQueryInput(
                metric_type="x",
                time_range=(_START, _END),
                aggregation="mean",
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# Test 7 — cost attribute (D41)
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(metrics_query, "usd_cost")
    assert metrics_query.usd_cost == USD_COST  # type: ignore[attr-defined]


def test_cost_is_sub_cent() -> None:
    assert 0.0 < USD_COST < 0.01


# ─────────────────────────────────────────────────────────────────────────────
# Test 8 — anomaly_score is bounded [0, 1]
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_anomaly_score_is_healthy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = metrics_query(
        MetricsQueryInput(
            metric_type="x", time_range=(_START, _END), aggregation="mean"
        )
    )
    assert out.anomaly_score_0_1 is not None
    assert 0.0 <= out.anomaly_score_0_1 <= 0.4  # below Z_WARN-equivalent
