"""metrics_query — capability layer per D41.

Cloud Monitoring time-series query for the anomaly_watch (W1) watchdog.
Implements the `metrics.query` capability declared in
`gcp-research/specs/tier3/anomaly_watch.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic synthesis of 10 evenly-spaced time-series points across
    the supplied `time_range`. The `anomaly_score_0_1` field is held at
    0.15 — a healthy reading — so the anomaly_watch agent's golden-path
    eval can pin against a stable signal that does NOT trip the warn/page
    thresholds. Tests exercising the "anomaly fired" branch override the
    score via monkeypatch (not by env vars — keeps the prod path clean).

Live mode (CAPABILITY_LAYER_MODE=live):
    Real `monitoring_v3.MetricServiceClient.list_time_series` against the
    Cloud Monitoring API per D32, with the requested aggregation aligner.
    Wired in W7 deploy phase. Today raises NotImplementedError.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D23 — Tier-3 watchdog W1 anomaly_watch (DECISIONS.md §4 row W1).
    D32 — Cloud Monitoring + Auto-runbook IR stack. metrics.query is the
          first hop into that chain (anomaly_watch reads → decides).
    D31 — 99.99% SLO. mean_time_to_detect <= 60s — this tool's live
          implementation must P95 < 5s.
    anomaly_watch.spec.md §6 — Tool table row for `metrics.query`.

Per-call cost: $0.0002 (Cloud Monitoring list_time_series is billed per
1k data points; a 5-min window with 10 points is sub-cent in live mode,
and stub mode is essentially free).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger(__name__)

USD_COST: float = 0.0002
"""Per-call USD attribution surfaced via `metrics_query.usd_cost` for the
runtime's `cost_watch` aggregator (D41). Sub-cent so the anomaly_watch
$0.05 per-anomaly cap (spec §6) is preserved even when the agent makes
the full 2-tool-call budget."""


# ─────────────────────────────────────────────────────────────────────────────
# Aggregation enum — mirrors Cloud Monitoring aligner / reducer options.
# https://cloud.google.com/monitoring/api/v3/aggregation
# ─────────────────────────────────────────────────────────────────────────────


Aggregation = Literal["mean", "p50", "p95", "p99", "sum", "count"]
"""Subset of Cloud Monitoring aligners the watchdog uses. Other aligners
(stddev, fraction_true) are not surfaced here — the agent doesn't need
them, and tighter contracts catch caller errors at validation time."""


_STUB_TOTAL_POINTS: int = 10
"""Fixed number of synthetic points the stub returns. Keeps prompt size
predictable in the anomaly_watch agent's pre-computed z-score embedding."""

_STUB_HEALTHY_SCORE: float = 0.15
"""Synthetic anomaly score for the stub's golden-path readings. Below
the Z_WARN boundary (~0.4 in the watch agent's mapping), so the agent
correctly returns `info` / `silent_log`."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class MetricsQueryInput(BaseModel):
    """Capability input. Mirrors anomaly_watch.spec.md §6 `metrics.query`.

    Attributes:
        metric_type:  Cloud Monitoring metric type (e.g.
            `aiplatform.googleapis.com/agent/latency_p99`). Validated as a
            non-empty dotted-path string; the live path resolves this
            against the project's available descriptors.
        time_range:   Inclusive `(start, end)` tuple. `start < end`
            enforced at validation time; both must be timezone-aware.
        aggregation:  Per-point aligner. The live path maps these to
            Cloud Monitoring's ALIGN_MEAN, ALIGN_PERCENTILE_50/95/99,
            ALIGN_SUM, ALIGN_COUNT respectively.
        filters:      Optional Cloud Monitoring filter map (label → value,
            e.g. `{"resource.label.region": "us-central1"}`). Empty dict
            means no filtering. Max 16 entries to keep the prompt small.
    """

    model_config = ConfigDict(extra="forbid")

    metric_type: str = Field(min_length=1, max_length=200)
    time_range: tuple[dt.datetime, dt.datetime]
    aggregation: Aggregation
    filters: dict[str, str] = Field(default_factory=dict, max_length=16)

    @model_validator(mode="after")
    def _validate_range(self) -> MetricsQueryInput:
        start, end = self.time_range
        # Check tz-awareness BEFORE comparison — comparing a naive datetime
        # against a tz-aware one raises TypeError (not ValueError), which
        # would short-circuit the message we want to surface to callers.
        if start.tzinfo is None or end.tzinfo is None:
            raise ValueError("time_range timestamps must be timezone-aware")
        if start >= end:
            raise ValueError(
                f"time_range start ({start}) must be strictly before end ({end})"
            )
        return self


class MetricPoint(BaseModel):
    """One time-series point. Matches Cloud Monitoring's Point shape."""

    model_config = ConfigDict(extra="forbid")

    timestamp: dt.datetime
    value: float


class MetricsQueryOutput(BaseModel):
    """Capability output. Aggregated time-series + an anomaly score hint.

    Attributes:
        points:              Aggregated samples spanning `time_range`,
            uniformly distributed across the window in stub mode. Empty
            list is allowed (live mode may return zero points for an
            interval that genuinely has no data).
        aggregation_used:    Echoes the input aligner. Surfaced so the
            agent's prompt can cite which percentile it is reasoning
            about.
        total_points:        `len(points)`. Echoed at the top level for
            quick triage without iterating the list.
        anomaly_score_0_1:   Self-reported anomaly score in [0,1]. None
            when no baseline was available. Stub mode pins this to 0.15
            (healthy). The anomaly_watch agent uses this purely as a
            HINT — its own z-score computation is the authoritative
            severity classifier.
    """

    model_config = ConfigDict(extra="forbid")

    points: list[MetricPoint] = Field(default_factory=list, max_length=1000)
    aggregation_used: Aggregation
    total_points: int = Field(ge=0)
    anomaly_score_0_1: float | None = Field(default=None, ge=0.0, le=1.0)


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def metrics_query(payload: MetricsQueryInput) -> MetricsQueryOutput:
    """Query Cloud Monitoring for an aggregated time-series.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated `MetricsQueryInput`. The Pydantic validator
            enforces ordered timezone-aware `time_range`.

    Returns:
        `MetricsQueryOutput` with aggregated points + an anomaly hint.

    Raises:
        NotImplementedError: in LIVE mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
metrics_query.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic 10-point synthesis.
#
# Algorithm:
#   1. Hash `(metric_type, aggregation, filters)` to a stable base value
#      so different queries produce different (but still deterministic)
#      surfaces. The hash is a tiny FNV-32 of the canonical string.
#   2. Emit 10 evenly-spaced points across `time_range`, each value
#      derived from `base + i * 0.5` so the series is monotone enough
#      to be recognisable but varied enough to look real.
#   3. Echo the aligner; emit total_points=10; pin anomaly_score=0.15.
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: MetricsQueryInput) -> MetricsQueryOutput:
    """Deterministic stub. Same input → byte-identical output (modulo the
    timestamps, which are derived from the input time_range)."""
    start, end = payload.time_range
    seed_text = (
        f"{payload.metric_type}|{payload.aggregation}|"
        + "|".join(f"{k}={v}" for k, v in sorted(payload.filters.items()))
    )
    base = _seed_value(seed_text)

    points: list[MetricPoint] = []
    span_us = (end - start).total_seconds() * 1_000_000
    denom = max(1, _STUB_TOTAL_POINTS - 1)
    for i in range(_STUB_TOTAL_POINTS):
        # Integer-microsecond stride avoids float-precision drift at the
        # endpoint — `start + i * (span/n)` accumulates ~1us error per step,
        # which makes the final point land at `end - 3us` instead of `end`.
        offset_us = round(span_us * i / denom)
        ts = start + dt.timedelta(microseconds=offset_us)
        value = base + i * 0.5
        points.append(MetricPoint(timestamp=ts, value=value))

    logger.debug(
        "metrics_query_stub",
        extra={
            "metric_type": payload.metric_type,
            "aggregation": payload.aggregation,
            "total_points": len(points),
            "base_value": base,
        },
    )

    return MetricsQueryOutput(
        points=points,
        aggregation_used=payload.aggregation,
        total_points=len(points),
        anomaly_score_0_1=_STUB_HEALTHY_SCORE,
    )


def _seed_value(seed_text: str) -> float:
    """Tiny FNV-32 hash → float in [10, 110). Stable across runs."""
    digest = hashlib.sha256(seed_text.encode("utf-8")).digest()
    # Take the first 4 bytes as a uint32, normalize to a sensible range.
    raw = int.from_bytes(digest[:4], byteorder="big", signed=False)
    return 10.0 + (raw % 100_000) / 1000.0


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase).
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: MetricsQueryInput) -> MetricsQueryOutput:
    """Live Cloud Monitoring query — wired in W7 deploy phase.

    The live path will:
      1. Build `monitoring_v3.types.ListTimeSeriesRequest` with the
         aligner mapped from `payload.aggregation`.
      2. Apply `payload.filters` as label filters.
      3. Call `client.list_time_series(request)` and aggregate the
         response into `MetricPoint` instances.
      4. Compute the anomaly score from the Cloud Monitoring response's
         `point.summary` field (or leave None if the API doesn't surface
         a baseline for this metric type).
    """
    _ = payload  # touch — keeps the import live for static checkers.
    raise NotImplementedError(
        "metrics_query live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "Aggregation",
    "MetricPoint",
    "MetricsQueryInput",
    "MetricsQueryOutput",
    "USD_COST",
    "metrics_query",
]
