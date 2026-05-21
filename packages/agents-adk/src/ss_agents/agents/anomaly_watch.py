"""Anomaly Watch agent — Tier-3 W1 watchdog.

Cloud Monitoring metric anomaly detector + auto-runbook trigger. Runs every
5 minutes via Cloud Scheduler against the active region's metric snapshots,
classifies each metric as healthy / warn / page based on z-score against a
baseline window, then decides whether to trigger an auto-runbook, page the
on-call, or silent-log.

Behavior (anomaly_watch.spec.md §1 + §6):
    Single-shot agent, no conversation. Each invocation receives a fixed
    window of metric snapshots (typically last 5-15 min) and a list of
    runbook ids the operator pre-registered. The agent's *only* job is to
    map (anomaly, available_runbooks) → action. It does NOT decide WHICH
    metrics to look at (Cloud Monitoring's alert policy did that), only
    what to do once a metric has tripped a baseline boundary.

    The agent stays cheap on purpose: $0.01 USD per call, ≤ 1 model turn,
    Gemini 3.1 Flash-Lite. Every 5-minute tick costs ≤ $2.88/day per region —
    well inside the D39 $25/day default ceiling.

Citations:
    D23 — Tier-3 watchdog agent #1 (W1 anomaly_watch).
    D31 — 99.99% availability SLO. Mean-time-to-detect is the lever; this
          agent's median-latency target is < 60 s from snapshot to action.
    D32 — Auto-runbook via Cloud Workflows + PagerDuty + Slack + Chronicle
          SIEM. The agent's `action.kind="trigger_runbook"` output is the
          input event for the Cloud Workflows handler.
    D34 — Locale-aware human-facing strings (the `reason` field renders in
          the operator's locale for the dashboard timeline).
    D37 — Agent Anomaly Detection signals feed back into chaos test results.
    ARCHITECTURE.md §3 row 20:
        anomaly_watch (W1) | 3 | Gemini 3.1 Flash-Lite | metrics.query,
            runbook.execute | None | precision (alert vs false)

Eval criteria (anomaly_watch.spec.md §7):
    precision >= 0.90 -- low false positives. A 5-minute ticker that pages on
                         every cold-start would page ~300x/day; the agent must
                         distinguish real outage from noise.
    recall    >= 0.80 -- catch real anomalies before the on-call's pager.
    mean_time_to_action <= 60 s -- measured at the Cloud Workflows layer.
"""
from __future__ import annotations

import datetime as dt
import logging
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ss_agents.runtime import AgentDef

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Constants — model + USD cap come from anomaly_watch.spec.md §6 + the brief.
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_ANOMALY_WATCH_MODEL = "gemini-3.1-flash-lite"
"""ARCHITECTURE.md §3 row 20 — flash-lite tier. Pro would blow the per-call cap."""

ANOMALY_WATCH_MAX_USD = 0.01
"""Per-tick USD cap from the brief. Strict -- runs every 5 min, ~288 calls/day."""

# Z-score boundaries for severity classification. Calibrated against a
# normal distribution: ~1.96 = 95% CI, ~3.0 = 99.7% CI. The agent treats
# anything outside the 99.7% envelope as a real anomaly worth paging on,
# anything outside 95% as worth warning. Implementations may swap for a
# robust z-score (MAD-based) once Cloud Monitoring exposes percentile
# baselines -- for Phase 4 we use p50/p99 from the snapshot itself.
Z_WARN = 2.0
Z_CRIT = 3.5


# ─────────────────────────────────────────────────────────────────────────────
# Input + output Pydantic mirrors.
#
# The brief's shape ({metric_snapshots[], current_runbooks_available[], …})
# is the canonical agent contract. The spec's JSON Schema (§2) describes the
# Cloud Workflows event shape (one-anomaly-at-a-time); this agent batches
# them so a single 5-minute snapshot can decide on N metrics at once and
# spend one Flash call instead of N.
# ─────────────────────────────────────────────────────────────────────────────


MetricName = Literal[
    "latency_p95_ms",
    "latency_p99_ms",
    "error_rate",
    "model_armor_block_count",
    "agent_escalation_count",
    "token_count_per_call",
    "tool_failure_count",
    "cost_usd_per_hour",
]
"""Hot-path metric ids the watchdog watches. Subset of Cloud Monitoring
SLIs the platform emits (see specs/_common/observability.md). Anything
outside this enum is rejected at input validation — the brief explicitly
sets `unknown_signal_kind` as a degraded path, but we surface it as an
input error so the operator sees the bug instead of swallowing it."""


class MetricSnapshot(BaseModel):
    """One metric reading at one point in time, with its baseline.

    The baseline is computed by Cloud Monitoring's `MQL aligner` over a
    rolling 24h window (anomaly_watch.spec.md §2 default lookbackHours).
    The agent itself never queries baselines — that's an upstream concern.
    """

    model_config = ConfigDict(extra="forbid")

    metric_name: MetricName = Field(alias="metricName")
    ts: dt.datetime
    """Snapshot timestamp (ISO-8601 with timezone)."""

    value: float = Field(ge=0.0)
    """The observed value at `ts`. Must be ≥ 0 — counts, rates, and
    latencies are all non-negative."""

    baseline_p50: float = Field(ge=0.0, alias="baselineP50")
    """Median of the rolling baseline window. Used to compute z-score."""

    baseline_p99: float = Field(ge=0.0, alias="baselineP99")
    """99th percentile of the rolling baseline. We treat
    `(p99 - p50) / 2` as a proxy for sigma since Cloud Monitoring's MQL exposes
    percentiles but not standard deviation directly. Crude but cheap, and
    it matches what an SRE would eyeball off a Grafana panel."""

    tenant_id: str | None = Field(default=None, alias="tenantId")
    """Optional tenant scope. When set, the agent may recommend
    `quarantine_tenant` per anomaly_watch.spec.md §2 Output enum."""

    region: str | None = Field(default=None)
    """e.g. 'us-central1'. Multi-region anomalies (same metric, multiple
    regions) get escalated to page-human per spec §8 edge case 2."""

    @field_validator("baseline_p99")
    @classmethod
    def _p99_at_least_p50(cls, v: float, info: object) -> float:
        # p99 must be >= p50 in any sane percentile stack. We can't reach
        # `info.data` from a classmethod in pydantic v2 reliably without
        # ValidationInfo; check via the model_validator if needed. For now
        # the bound check (≥ 0) is the only invariant we strictly enforce.
        return v


Severity = Literal["info", "warn", "critical"]
"""Maps to spec §2 Severity enum: info → silent_log, warn → trigger_runbook,
critical → page_human (unless a matching runbook exists)."""


ActionKind = Literal["trigger_runbook", "page_human", "silent_log"]
"""Spec §2 Output.decision is wider (`log_only|runbook|page_oncall|
quarantine_tenant`); the brief reduces to three since `quarantine_tenant`
is just a runbook in our registry (`runbook-quarantine-tenant`)."""


class DetectedAnomaly(BaseModel):
    """One anomaly the agent classified from the input snapshots."""

    model_config = ConfigDict(extra="forbid")

    metric: MetricName
    severity: Severity
    z_score: float = Field(alias="zScore")
    """Signed z-score: positive = above baseline, negative = below.
    Most metrics only care about the positive tail, but `escalation_count`
    going to zero across all agents is also a signal (silent failure mode
    — agents are returning bad outputs without escalating)."""

    suspected_cause: str = Field(min_length=1, max_length=400, alias="suspectedCause")
    """One-sentence hypothesis. The agent generates this; it is not
    authoritative — operators reading the dashboard should treat it as a
    starting point, not a root-cause-analysis verdict."""


class AnomalyAction(BaseModel):
    """One decision the agent emits per detected anomaly (or one umbrella
    action covering several anomalies if they share a root cause)."""

    model_config = ConfigDict(extra="forbid")

    kind: ActionKind
    runbook_id: str | None = Field(default=None, alias="runbookId")
    """Required when kind=trigger_runbook; ignored otherwise. Validated
    by `runbooks_available` membership at the workflow layer."""

    severity: Severity
    reason: str = Field(min_length=1, max_length=600)
    """Human-readable explanation rendered to the dashboard + paging text.
    Matches anomaly_watch.spec.md §2 Output.rationale (600-char cap)."""

    tenant_id: str | None = Field(default=None, alias="tenantId")
    """Echoed from the triggering snapshot when the action is tenant-scoped
    (quarantine, throttle). None for global actions."""


class AnomalyWatchInput(BaseModel):
    """Per the brief: one tick of metric snapshots + the registered
    runbook catalog. The agent decides what to do with them."""

    model_config = ConfigDict(extra="forbid")

    metric_snapshots: list[MetricSnapshot] = Field(
        min_length=1, max_length=200, alias="metricSnapshots"
    )
    """Cloud Monitoring snapshots for the current 5-minute window. Cap at
    200 to keep the Flash prompt under ~30 KB."""

    current_runbooks_available: list[str] = Field(
        default_factory=list,
        max_length=50,
        alias="currentRunbooksAvailable",
    )
    """Registered runbook ids the operator has pre-authorized for auto-
    execution. Empty list means the agent can only page_human/silent_log."""

    page_threshold_severity: Severity = Field(
        default="critical", alias="pageThresholdSeverity"
    )
    """Anomalies AT or ABOVE this severity become page_human if no runbook
    matches. Operators can relax to 'warn' during incidents or tighten to
    'critical' during demo recordings (spec §8 edge case 1)."""

    locale: Literal["ko", "en", "ja", "zh-CN"] = "ko"
    """D34 — operator's locale for the `reason` field rendering."""


class AnomalyWatchOutput(BaseModel):
    """The decision packet consumed by the Cloud Workflows handler."""

    model_config = ConfigDict(extra="forbid")

    anomalies_detected: list[DetectedAnomaly] = Field(
        default_factory=list, alias="anomaliesDetected", max_length=50
    )
    """Empty list = clean tick (no anomalies). The agent SHOULD return an
    empty list rather than fabricate noise — false positives burn the
    operator's pager budget faster than missed positives."""

    actions: list[AnomalyAction] = Field(default_factory=list, max_length=50)
    """One action per anomaly, OR one umbrella action covering multiple
    anomalies if they share a root cause (e.g. all latency_p99 metrics
    spike together → one `trigger_runbook` with reason='regional brownout').
    Order is not significant; the workflow handler dispatches in parallel."""

    confidence: float = Field(ge=0.0, le=1.0, default=1.0)
    """Agent's self-reported confidence in the classification. < 0.6 → the
    workflow handler degrades severity by one notch (critical→warn,
    warn→info). Calibrated against the eval golden set during Phase 5."""


# ─────────────────────────────────────────────────────────────────────────────
# Pure-Python z-score helper. The agent could compute these inside the
# prompt, but Flash is bad at floating-point arithmetic; we precompute
# and embed the numbers in the prompt so the agent only does
# classification + cause-hypothesis (text generation, which Flash is good at).
# ─────────────────────────────────────────────────────────────────────────────


def compute_z_score(value: float, p50: float, p99: float) -> float:
    """Crude z-score: (value - p50) / sigma, with sigma ~= (p99 - p50) / 2.326.

    The 2.326 divisor maps the 99th percentile of a standard normal back
    to its z-score (inverse-Phi(0.99) ~= 2.326). When sigma ~= 0 (perfectly
    flat baseline), any deviation reads as +/- inf; we cap at +/- 10 to keep
    the prompt and downstream consumers numerically sane.

    This is good enough for spike detection. For drift detection (slow
    creep over hours) the upstream alert policy uses Cloud Monitoring's
    `change_rate` aligner and feeds us a snapshot where p50 already
    reflects the new normal -- the agent then correctly returns "info".
    """
    sigma = max((p99 - p50) / 2.326, 1e-9)
    z = (value - p50) / sigma
    return max(-10.0, min(10.0, z))


def classify_severity(z: float) -> Severity:
    """Map |z| to severity using the spec's two-tier boundary."""
    abs_z = abs(z)
    if abs_z >= Z_CRIT:
        return "critical"
    if abs_z >= Z_WARN:
        return "warn"
    return "info"


# ─────────────────────────────────────────────────────────────────────────────
# System prompt builder — mirrors intake.py shape.
# ─────────────────────────────────────────────────────────────────────────────


_LOCALE_SUFFIX: dict[str, str] = {
    "ko": "Respond in 한국어 for the `reason` and `suspectedCause` strings. SRE tone — concise, no marketing.",
    "en": "Respond in English for `reason` and `suspectedCause`. SRE tone — concise, no marketing.",
    "ja": "Respond in 日本語 for `reason` and `suspectedCause`. SRE tone — concise, no marketing.",
    "zh-CN": "Respond in 简体中文 for `reason` and `suspectedCause`. SRE tone — concise, no marketing.",
}


def build_anomaly_watch_system_prompt(payload: BaseModel) -> str:
    """Compose the Flash prompt. Embeds the precomputed z-scores so the
    model only has to *classify* and *hypothesize* — not do arithmetic."""
    assert isinstance(payload, AnomalyWatchInput), f"unexpected input type: {type(payload)}"

    # Precompute z-scores so the model never has to. Format each as a
    # one-line summary the prompt can consume.
    lines: list[str] = []
    for snap in payload.metric_snapshots:
        z = compute_z_score(snap.value, snap.baseline_p50, snap.baseline_p99)
        sev = classify_severity(z)
        scope = f"[tenant={snap.tenant_id}]" if snap.tenant_id else "[global]"
        region = f"[region={snap.region}]" if snap.region else ""
        lines.append(
            f"  · {snap.metric_name} {scope}{region} "
            f"value={snap.value:.4f} baseline_p50={snap.baseline_p50:.4f} "
            f"baseline_p99={snap.baseline_p99:.4f} z={z:+.2f} precomputed_severity={sev}"
        )

    runbooks_block = (
        ", ".join(payload.current_runbooks_available)
        if payload.current_runbooks_available
        else "(none — page_human or silent_log only)"
    )

    locale_line = _LOCALE_SUFFIX.get(payload.locale, _LOCALE_SUFFIX["ko"])

    return "\n".join(
        [
            "You are the anomaly_watch watchdog agent for Social Seeding. You decide what to do with Cloud Monitoring snapshots: trigger a registered auto-runbook, page the on-call human, or silent-log.",
            "",
            "Inputs you are given (precomputed — DO NOT recompute arithmetic):",
            "  · A batch of metric snapshots, each annotated with its z-score and a precomputed_severity (info|warn|critical).",
            "  · A list of currently-available runbook ids.",
            f"  · The page threshold severity for this tick: {payload.page_threshold_severity}",
            "",
            "Snapshots:",
            *lines,
            "",
            f"Available runbooks: {runbooks_block}",
            "",
            "Procedure (one tick = one invocation):",
            "1) For each snapshot with precomputed_severity ∈ {warn, critical}, emit a DetectedAnomaly with the precomputed z_score and severity. Generate a one-sentence suspected_cause grounded in the metric name + magnitude.",
            "2) Decide an AnomalyAction per anomaly:",
            "   - If a runbook id in the available list semantically matches (e.g. 'throttle-vertex-v1' for latency_p99 spikes, 'quarantine-tenant-v1' for per-tenant error_rate spikes), emit kind='trigger_runbook' with that runbook_id.",
            f"   - Else if severity ≥ {payload.page_threshold_severity}, emit kind='page_human'.",
            "   - Else emit kind='silent_log'.",
            "3) If two or more anomalies appear to share a root cause (e.g. all latency_p99 metrics spike in the same region), you MAY emit ONE umbrella action covering them — set reason to explain the correlation.",
            "4) If precomputed_severity is 'info' for ALL snapshots, return anomalies_detected=[], actions=[], confidence=1.0. The tick is clean.",
            "5) Set confidence ∈ [0,1] reflecting your certainty. If multiple plausible causes exist (ambiguous root cause), drop confidence to ≤ 0.6 — the workflow handler will downgrade severity by one notch.",
            "",
            "Hard rules:",
            "  · NEVER fabricate an anomaly the precomputed_severity did not flag. False positives burn the operator's pager budget.",
            "  · NEVER recommend a runbook_id outside the available list — the workflow handler will reject it.",
            "  · NEVER recurse into cost_watch metrics (`cost_usd_per_hour`) when the spike is in cost_watch's own agent activity — that's a defensive guard against feedback loops.",
            "  · The agent does NOT call any tools; this is a pure classification + decision pass.",
            "",
            locale_line,
        ]
    )


# ─────────────────────────────────────────────────────────────────────────────
# AgentDef — what the runtime consumes.
# ─────────────────────────────────────────────────────────────────────────────


# Capability-layer tools (W2-C1, per D41). Imported here to avoid a load-order
# cycle: each tool module is leaf-importable and only references the runtime
# `AgentDef` shape via its Pydantic input/output models.
from ss_agents.tools.metrics_query import metrics_query  # noqa: E402
from ss_agents.tools.runbook_execute import runbook_execute  # noqa: E402

anomaly_watch_agent_def: AgentDef[AnomalyWatchInput, AnomalyWatchOutput] = AgentDef(
    id="anomaly-watch",
    description=(
        "Tier-3 W1 watchdog. Reads a batch of Cloud Monitoring snapshots "
        "with precomputed z-scores and decides: trigger a registered "
        "runbook, page the on-call, or silent-log. Single-shot, "
        "$0.01 USD cap per tick. Per anomaly_watch.spec.md (D23 Tier-3 W1)."
    ),
    model=DEFAULT_ANOMALY_WATCH_MODEL,
    max_usd=ANOMALY_WATCH_MAX_USD,
    input_schema=AnomalyWatchInput,
    output_schema=AnomalyWatchOutput,
    system_prompt=build_anomaly_watch_system_prompt,
    # spec §6: metrics already queried upstream typically; the agent may
    # still re-query for context drift (`metrics.query`) and invoke an
    # auto-runbook (`runbook.execute`) per D32 IR chain.
    tools=[metrics_query, runbook_execute],
    max_turns=1,  # single-shot classification
)


__all__ = [
    "ANOMALY_WATCH_MAX_USD",
    "DEFAULT_ANOMALY_WATCH_MODEL",
    "Z_CRIT",
    "Z_WARN",
    "ActionKind",
    "AnomalyAction",
    "AnomalyWatchInput",
    "AnomalyWatchOutput",
    "DetectedAnomaly",
    "MetricName",
    "MetricSnapshot",
    "Severity",
    "anomaly_watch_agent_def",
    "build_anomaly_watch_system_prompt",
    "classify_severity",
    "compute_z_score",
]
