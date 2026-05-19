"""analytics_funnel — capability layer per D41.

Aggregates per-workspace funnel-stage counts + drop-off rates over a time
window. Backs the `customer_success` agent's friction-signal detection
(`customer_success.spec.md §6` tool table row `analytics.funnel`).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Returns deterministic canned funnel counts so the customer_success
    agent can produce its intervention ranking + grounding-evidence
    references without live BigQuery traffic. Canonical shape per the
    task brief: intake=100, vetting=82, outreach=64, reply=28; drops
    18% / 22% / 56%; biggest_drop="outreach->reply".

Live mode (CAPABILITY_LAYER_MODE=live):
    Real BigQuery aggregation query against `v2_audit_events` — wired
    in W7 (deploy phase) once the per-tenant Pub/Sub → BigQuery ELT
    pipeline lands. Today raises NotImplementedError so the runtime
    converts the call into an `EscalateToHuman` outcome rather than
    crashing.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern
          (CAPABILITY_LAYER_MODE).
    D28 — Per-view pricing ($0.01/view, $10 effective CPM). Funnel
          analytics underwrite the per-view metering: the customer_success
          agent flags `budget_unused` when funnel drop-off correlates with
          a dollars-spent shortfall (Drucker §9 management-by-exception —
          the platform's per-tenant data triggers CSM action, not the
          opposite).
    D15 — OLTP hybrid; per-event audit data sits in BigQuery (analytics
          side). Spanner holds the OLTP source-of-truth; BigQuery owns the
          analytical rollup.
    customer_success.spec.md §6 — tool table row `analytics.funnel`
          (per-tenant funnel rollup; BigQuery).
    ARCHITECTURE.md §3 row 16 — customer_success agent's tool list.

Per-call cost: $0.0025 (sub-cent; 30-day funnel scan against
`v2_audit_events` typically scans ~5 MB → $5/TB → ~$0.0025/call).
"""
from __future__ import annotations

import datetime as dt
import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

logger = logging.getLogger(__name__)


# Per-invocation USD cost estimate; `cost_watch` reads this attribute via
# `getattr(analytics_funnel, "usd_cost", 0.0)`. A 30-day aggregation
# against `v2_audit_events` scans ~5 MB typical → $5/TB → ~$0.0025/call.
USD_COST: float = 0.0025


# Canonical funnel shape per the task brief. Exposed as module constants
# so tests + downstream callers can assert on the canonical pin without
# string-matching the stub body.
CANONICAL_STAGE_COUNTS: dict[str, int] = {
    "intake": 100,
    "vetting": 82,
    "outreach": 64,
    "reply": 28,
}
"""Per task brief: intake=100, vetting=82, outreach=64, reply=28.

Reproducible across stub invocations regardless of `workspace_id` or
`time_range` — the stub's job is pinning the surface, not modeling per-
workspace variance."""

CANONICAL_BIGGEST_DROP_STAGE: str = "outreach->reply"
"""Per task brief: the 56% drop from outreach to reply dominates the
funnel; biggest_drop_stage names the from->to pair (not just the target
stage) so the agent can address both surfaces in its message_template."""


# Healthy-baseline thresholds — per Drucker §9 the platform's intervention
# is triggered by deviation from baseline, not by absolute counts. The
# brief pegs the canonical funnel just BELOW the healthy line (56% outreach
# → reply drop > 50% threshold) so the customer_success agent fires
# `low_response_rate` and `outreach_unanswered_30d` on the canonical
# fixture.
HEALTHY_MAX_DROP_PCT: float = 50.0
"""Maximum per-stage drop-off considered healthy. The canonical 56%
outreach→reply drop exceeds this → `healthy_baseline=False` in the
stub output."""


FunnelStageDefault = Literal["intake", "vetting", "outreach", "reply"]
"""The four canonical funnel stages baked into the stub. Callers may pass
additional stages in `funnel_stages` (they'll be echoed as zero-count
rows by the live impl); the stub only emits the canonical four."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class AnalyticsFunnelInput(BaseModel):
    """Capability input. Mirrors customer_success.spec.md §6 `analytics.funnel`.

    Attributes:
        workspace_id: v2 workspace id (`ws_…`). Funnel rows are scoped per
            workspace; multi-tenant aggregation happens at a different
            analytics surface (analyst-of-customer-success).
        time_range: `(start, end)` UTC datetime tuple. The aggregation
            window is half-open `[start, end)` per BigQuery convention.
            `start < end` enforced by a model-level validator.
        funnel_stages: Ordered list of stage names to include in the
            rollup. Order MATTERS — adjacent pairs in this list define the
            drop-off transitions (e.g. ["intake","vetting","outreach","reply"]
            → drops {intake->vetting, vetting->outreach, outreach->reply}).
            Cap at 12 stages (no real campaign funnel has more).
    """

    model_config = ConfigDict(extra="forbid")

    workspace_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^ws_[A-Za-z0-9_-]{8,40}$",
        description="Per shared.schema.json#/$defs/WorkspaceId.",
    )
    time_range: tuple[dt.datetime, dt.datetime] = Field(
        description="(start, end) UTC datetimes; half-open [start, end).",
    )
    funnel_stages: list[str] = Field(
        min_length=2,
        max_length=12,
        description=(
            "Ordered stage names. Adjacent pairs define drop-off transitions; "
            "min 2 (one transition); max 12 (no real funnel has more)."
        ),
    )

    @field_validator("funnel_stages")
    @classmethod
    def _stages_unique_and_non_empty(cls, v: list[str]) -> list[str]:
        """Reject empty stage names + duplicates. A duplicate stage would
        produce a 0% self-drop row that mis-ranks `biggest_drop_stage`."""
        seen: set[str] = set()
        for s in v:
            stripped = s.strip()
            if stripped != s:
                raise ValueError(
                    f"funnel stage name has leading/trailing whitespace: {s!r}"
                )
            if not stripped:
                raise ValueError("funnel stage names must be non-empty")
            if stripped in seen:
                raise ValueError(
                    f"funnel_stages contains duplicate stage: {stripped!r}"
                )
            seen.add(stripped)
        return v

    @model_validator(mode="after")
    def _validate_time_range(self) -> "AnalyticsFunnelInput":
        """Enforce start < end and cap window width at 366 days."""
        start, end = self.time_range
        if start >= end:
            raise ValueError(
                f"time_range start ({start.isoformat()}) must be strictly "
                f"before end ({end.isoformat()})"
            )
        delta = end - start
        if delta > dt.timedelta(days=366):
            raise ValueError(
                f"time_range too wide ({delta.days} days); cap is 366 days"
            )
        return self


class AnalyticsFunnelOutput(BaseModel):
    """Capability output. Drives the customer_success agent's signal
    detection + grounding evidence.

    Attributes:
        stage_counts: Stage-name → count map. Same keys as `funnel_stages`
            in the input; the live impl will emit 0 for stages with no
            events in the window.
        drop_off_rates: Transition-name → drop-off fraction (0.0 .. 1.0).
            Key format: `"<from>-><to>"`. The customer_success agent reads
            these into grounding_evidence as percentages (e.g. "56%").
        biggest_drop_stage: Transition name with the highest drop-off rate.
            Format matches `drop_off_rates` keys (`"<from>-><to>"`). The
            agent uses this to focus the intervention on the right stage.
        healthy_baseline: True when no transition exceeds
            `HEALTHY_MAX_DROP_PCT`. The canonical stub returns False
            (outreach→reply drop = 56% > 50% threshold).
        fetched_via: 'stub' vs 'live' — OTel splits the two streams.
    """

    model_config = ConfigDict(extra="forbid")

    stage_counts: dict[str, int] = Field(
        description="Stage-name → event count over the window.",
    )
    drop_off_rates: dict[str, float] = Field(
        description=(
            "Transition-name → drop-off fraction (0.0 .. 1.0). "
            "Key format: '<from>-><to>'."
        ),
    )
    biggest_drop_stage: str = Field(
        min_length=1,
        max_length=128,
        description="Transition with the largest drop-off ('<from>-><to>').",
    )
    healthy_baseline: bool = Field(
        description=(
            "True when every transition drop ≤ HEALTHY_MAX_DROP_PCT. "
            "Canonical stub returns False (outreach→reply = 56% > 50%)."
        ),
    )
    fetched_via: Literal["stub", "live"]

    @field_validator("stage_counts")
    @classmethod
    def _counts_non_negative(cls, v: dict[str, int]) -> dict[str, int]:
        """Stage counts can't be negative — defensive validation."""
        for stage, count in v.items():
            if count < 0:
                raise ValueError(
                    f"stage_counts[{stage!r}]={count} cannot be negative"
                )
        return v

    @field_validator("drop_off_rates")
    @classmethod
    def _rates_in_unit_interval(cls, v: dict[str, float]) -> dict[str, float]:
        """Drop-off rates are fractions [0, 1]. Negative rates would mean
        the funnel grew between stages (impossible by definition); rates
        >1 would mean more drops than entries.

        A negative drop CAN legitimately mean upstream stages were
        time-shifted into the window (e.g. vetting count > intake count
        when intake happened just before the window opened) — in that
        case the live impl is expected to clamp to 0 before emitting.
        """
        for transition, rate in v.items():
            if not (0.0 <= rate <= 1.0):
                raise ValueError(
                    f"drop_off_rates[{transition!r}]={rate} must be in [0.0, 1.0]"
                )
        return v

    @model_validator(mode="after")
    def _biggest_drop_in_rates(self) -> "AnalyticsFunnelOutput":
        """`biggest_drop_stage` must be a key in `drop_off_rates` AND it
        must actually have the maximum rate — guards against accidental
        mis-pin in a future stub revision."""
        if self.biggest_drop_stage not in self.drop_off_rates:
            raise ValueError(
                f"biggest_drop_stage {self.biggest_drop_stage!r} not in "
                f"drop_off_rates keys {list(self.drop_off_rates)!r}"
            )
        if self.drop_off_rates:
            max_rate = max(self.drop_off_rates.values())
            if self.drop_off_rates[self.biggest_drop_stage] != max_rate:
                raise ValueError(
                    f"biggest_drop_stage {self.biggest_drop_stage!r} "
                    f"(rate={self.drop_off_rates[self.biggest_drop_stage]}) "
                    f"is not the maximum (max={max_rate})"
                )
        return self


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def analytics_funnel(payload: AnalyticsFunnelInput) -> AnalyticsFunnelOutput:
    """Aggregate per-workspace funnel-stage counts + drop-off rates.

    Stub vs live is selected via the `CAPABILITY_LAYER_MODE` env var (D41).
    Stub returns the canonical {intake:100, vetting:82, outreach:64, reply:28}
    funnel with 18% / 22% / 56% drops; live performs the real BigQuery
    aggregation (wired in W7).

    Args:
        payload: Validated `AnalyticsFunnelInput`.

    Returns:
        `AnalyticsFunnelOutput` with stage counts, transition drops,
        `biggest_drop_stage`, and a `healthy_baseline` flag.

    Raises:
        NotImplementedError: When `CAPABILITY_LAYER_MODE=live` — until W7
            wires the real google-cloud-bigquery client.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
analytics_funnel.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic canned funnel.
#
# Contract per the task brief:
#   intake=100, vetting=82, outreach=64, reply=28
#   drops 18% / 22% / 56%
#   biggest_drop_stage = "outreach->reply"
#   healthy_baseline = False (56% > HEALTHY_MAX_DROP_PCT=50%)
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: AnalyticsFunnelInput) -> AnalyticsFunnelOutput:
    """Deterministic stub. Same input → same output, always.

    Returns the canonical funnel regardless of `workspace_id` or
    `time_range`. The brief's task is pinning the surface so the
    customer_success agent can be exercised with deterministic friction
    signals end-to-end.

    Note: the `funnel_stages` input is acknowledged but not honored — the
    stub always emits the canonical 4-stage funnel. The live impl WILL
    honor caller-supplied stages.
    """
    # Compute drop-offs from the canonical stage counts. Adjacent-pair
    # transitions in the canonical order (intake → vetting → outreach →
    # reply). Done from constants (not hard-coded percentages) so the
    # invariant `drop = 1 - next/prev` stays consistent if a future
    # revision tweaks the counts.
    stages = ["intake", "vetting", "outreach", "reply"]
    stage_counts: dict[str, int] = {s: CANONICAL_STAGE_COUNTS[s] for s in stages}

    drop_off_rates: dict[str, float] = {}
    for i in range(len(stages) - 1):
        prev_stage = stages[i]
        next_stage = stages[i + 1]
        prev_count = stage_counts[prev_stage]
        next_count = stage_counts[next_stage]
        # Clamp at 0.0 (can't be negative); div-by-zero impossible (canonical
        # counts are all > 0).
        rate = max(0.0, (prev_count - next_count) / prev_count)
        # Round to 4 decimals so floating-point drift doesn't bite the
        # output validator's "must equal max(rates)" check.
        drop_off_rates[f"{prev_stage}->{next_stage}"] = round(rate, 4)

    # Biggest drop = transition with the maximum rate. Identify by key so
    # we don't accidentally lookup by stage name (`biggest_drop_stage`
    # carries the full "<from>-><to>" name per the output contract).
    biggest = max(drop_off_rates.items(), key=lambda kv: kv[1])
    biggest_transition = biggest[0]
    biggest_rate = biggest[1]

    # Sanity-pin: the brief says biggest_drop == "outreach->reply". If a
    # future maintainer alters CANONICAL_STAGE_COUNTS and breaks this, the
    # assertion catches it immediately.
    assert biggest_transition == CANONICAL_BIGGEST_DROP_STAGE, (
        f"stub canonical funnel must keep '{CANONICAL_BIGGEST_DROP_STAGE}' "
        f"as the biggest drop; got {biggest_transition!r}"
    )

    healthy = (biggest_rate * 100.0) <= HEALTHY_MAX_DROP_PCT

    logger.info(
        "analytics_funnel_stub",
        extra={
            "workspace_id": payload.workspace_id,
            "biggest_drop_stage": biggest_transition,
            "healthy_baseline": healthy,
        },
    )

    return AnalyticsFunnelOutput(
        stage_counts=stage_counts,
        drop_off_rates=drop_off_rates,
        biggest_drop_stage=biggest_transition,
        healthy_baseline=healthy,
        fetched_via="stub",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Raises NotImplementedError so the
# runtime converts to an `EscalateToHuman` rather than crashing.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: AnalyticsFunnelInput) -> AnalyticsFunnelOutput:
    """Live BigQuery funnel aggregation. Wired in W7 deploy phase.

    When wired up the live path will:
      1. Compose a BigQuery SQL query against `v2_audit_events` grouped
         by `event_type` matching the caller's `funnel_stages`.
      2. Run with a labels={tool: "analytics_funnel"} hint so the BQ
         labels surface in the per-tool cost ledger.
      3. Build `stage_counts` from the grouped result + compute drop-off
         rates from adjacent pairs in `funnel_stages` order.
      4. Return the structured output with `fetched_via="live"`.
    """
    raise NotImplementedError(
        "analytics_funnel live mode wired in W7 deploy phase "
        "(google-cloud-bigquery client + Spanner→BigQuery ELT pipeline)"
    )


__all__ = [
    "CANONICAL_BIGGEST_DROP_STAGE",
    "CANONICAL_STAGE_COUNTS",
    "HEALTHY_MAX_DROP_PCT",
    "USD_COST",
    "AnalyticsFunnelInput",
    "AnalyticsFunnelOutput",
    "FunnelStageDefault",
    "analytics_funnel",
]
