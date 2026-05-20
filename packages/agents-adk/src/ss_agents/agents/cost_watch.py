"""Cost-Watch agent (W2) — Tier-3 watchdog, rule-based (no LLM).

Per-tenant USD-ceiling enforcer. Consumes a pre-fetched billing snapshot
(BigQuery cost ledger + Spanner tenant-budgets row) and emits Pub/Sub-bound
threshold crossings at 50/75/90/95/100% plus a 110% over-limit action.
The Phase 4 workflow layer publishes the resulting `crossings` to the
`watchdog.cost.threshold_crossed` and `watchdog.cost.budget_exceeded` Pub/Sub
topics (per spec §4 AsyncAPI) — this module is responsible only for the
rule evaluation.

Behaviour (cost_watch.spec.md §1):
    *Deterministic threshold gate*. Given (spentUsd, budgetUsd) the
    evaluator decides which thresholds have been *newly* crossed since the
    previous tick, what action to take per crossing, and whether to halt
    the tenant. Per D23 the agent is "agent-shaped for consistency" —
    it carries an `AgentDef` so the registry treats it like any other
    agent — but it has `tools=[]`, no model call, and a separate
    `evaluate_cost_watch()` pure function as the actual runtime path.

Why no LLM:
    - `false_negative_rate = 0` is a safety-critical eval metric (spec §7).
      Any LLM nondeterminism would violate that.
    - The decision surface is < 10 thresholds x 5 actions — a rule table is
      both faster and verifiable.
    - `model_client = None` everywhere — the agent never invokes the
      runtime's `run_agent()`; the workflow calls `evaluate_cost_watch()`
      directly and treats the AgentDef as metadata + registry consistency.

Citations:
    D23  — Tier-3 watchdog #W2 (DECISIONS.md §4 row W2).
    D28  — $0.01/view pricing → cost_watch is the metering enforcer.
    D31  — Cost SLO ("never exceed budget without alerting") is enterprise-grade.
    D33  — Cost ledger 90-day retention (BigQuery `agent.cost.recorded`).
    D39  — $1500 budget → default per-tenant cap raised; the actual cap
           ships from Spanner per tenant.
    ARCHITECTURE.md §3 row 21:
        cost_watch (W2) | 3 | rule-based (no LLM, but agent-shaped for D23
        consistency) | billing.query, pubsub.alert | None | latency to alert.

Compared to other agents (intake.py / analyst.py):
    - **No LLM**: the prompt builder returns a constant marker string so
      `AgentDef.system_prompt` stays a callable per the protocol, but it
      is never sent to a model.
    - **No conversation**: single-shot evaluator.
    - **Sentinel model id**: `"none-rule-based"` — explicitly not in
      `MODEL_PRICING`, so if anyone accidentally routes this AgentDef
      through `run_agent()` the runtime fails loud (KeyError on pricing
      lookup) rather than silently spending tokens.
    - **max_usd**: `AgentDef` constraint requires `gt=0.0`. We set
      `0.0001` ($0.0001 ≈ free) — the value is meaningless because no
      LLM is invoked, but the field is required.
"""
from __future__ import annotations

import datetime as dt
import logging
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ss_agents.runtime import AgentDef

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Threshold ladder + action table — the canonical rule surface.
# ─────────────────────────────────────────────────────────────────────────────

# Per cost_watch.spec.md §2 #/$defs/ThresholdPercent. Ordered ascending so
# `_thresholds_crossed(prev, current)` returns crossings in the order they
# fired — matters for downstream "first-time-50%" alert routing.
CANONICAL_THRESHOLDS: tuple[int, ...] = (50, 75, 90, 95, 100, 110)

# Per cost_watch.spec.md §2 #/$defs/BudgetWindow. The window dictates the
# rollup query upstream (BQ `WHERE ts >= now() - INTERVAL`); the agent
# itself is window-agnostic — it operates on whatever (spentUsd, budgetUsd)
# pair the caller supplies.
BudgetWindow = Literal["per_minute", "per_hour", "per_day", "per_month", "per_campaign"]

ThresholdPercent = Literal[50, 75, 90, 95, 100, 110]

# Per cost_watch.spec.md §2 properties.Output.crossings.items.action.
CrossingAction = Literal[
    "notified",  # 50% — Slack info banner.
    "warned",  # 75% — Slack warn + email FYI to workspace owner.
    "throttled",  # 90% — emit TPS throttle hint; agent runtime self-throttles.
    "halted",  # 95% — kill-switch armed; one more call may breach budget.
    "over_limit_block",  # 100%+ — invoke kill_switch.enforce; halt new invocations.
]

# Threshold → default action mapping. Workspaces MAY relax (eg map 95 →
# `throttled` instead of `halted`) via Spanner tenant config; the agent
# carries the *default* table for tenants without an override. The 100 and
# 110 levels collapse to `over_limit_block` — once you cross 100 % you're
# in the same operational state regardless of how far over you went.
_DEFAULT_ACTION_BY_THRESHOLD: dict[int, CrossingAction] = {
    50: "notified",
    75: "warned",
    90: "throttled",
    95: "halted",
    100: "over_limit_block",
    110: "over_limit_block",
}


# Fallback default budget for tenants with no Spanner row. Per spec §6:
#     "Tenant has no budget configured — default to $50/day (configurable;
#      D39 unlocks higher defaults)."
# D39's $1500/17d ≈ $88/d ceiling, but per-tenant default at the rule
# layer stays at $50/d because the workspace fan-out also consumes the
# overall budget. The caller (workflow) overrides via `budget_usd` when
# Spanner has a value.
DEFAULT_FALLBACK_BUDGET_USD: float = 50.0


# ─────────────────────────────────────────────────────────────────────────────
# Input + Output Pydantic schemas — mirror of cost_watch.spec.md §2.
# ─────────────────────────────────────────────────────────────────────────────


class BillingSnapshot(BaseModel):
    """The pre-fetched billing pair the workflow passes in.

    Spec §5 has the workflow do `SELECT SUM(usd) ... WHERE tenantId=...` against
    BigQuery and `SELECT budgetUsd ... FROM tenant_budgets` against Spanner.
    Both results land here so the rule evaluator stays pure (no I/O).

    Fields:
        spent_usd:           BQ rollup over the rolling `window`. ≥ 0.
        budget_usd:          Spanner `tenant_budgets.budgetUsd`. None means
                             "no row" → caller substitutes
                             `DEFAULT_FALLBACK_BUDGET_USD`.
        baseline_burn_rate_usd_per_hour:
                             Optional. When set, the agent flags anomalous
                             burns (current pace > 3x baseline) and forwards
                             a `kind="silent_log"` action so anomaly_watch
                             (W1) can pick it up. Per the user brief
                             "anomalous burn-rate (>3x baseline)" escalation.
        snapshot_stale:      True when BQ returned a stale replica result
                             (per spec §8 edge case 4 — 30s staleness OK).
    """

    model_config = ConfigDict(extra="forbid")

    spent_usd: float = Field(ge=0.0, alias="spentUsd")
    budget_usd: float | None = Field(default=None, ge=0.0, alias="budgetUsd")
    baseline_burn_rate_usd_per_hour: float | None = Field(
        default=None, ge=0.0, alias="baselineBurnRateUsdPerHour"
    )
    snapshot_stale: bool = Field(default=False, alias="snapshotStale")


class CostWatchInput(BaseModel):
    """Per cost_watch.spec.md §2 properties.Input + extension fields.

    Extension fields beyond spec §2:
        billing_snapshot     — pre-fetched (spent, budget) pair; the workflow
                               does the BigQuery + Spanner reads before
                               invoking the rule evaluator (see ARCHITECTURE.md
                               §3 row 21 — "billing.query, pubsub.alert" are
                               OTHER tools the workflow owns, not this agent).
        previous_crossings   — the set of thresholds already-crossed in
                               prior ticks for this window. Used so we only
                               emit a crossing event ONCE per threshold per
                               window. The workflow persists this in Spanner
                               between ticks (spec §8 edge case 6 — forced
                               recheck bypasses tick cadence but still uses
                               previous_crossings to dedupe events).
    """

    model_config = ConfigDict(extra="forbid")

    tenant_id: str = Field(min_length=1, max_length=64, alias="tenantId")
    """shared.schema.json#/$defs/TenantId."""

    workspace_id: str | None = Field(default=None, max_length=64, alias="workspaceId")
    """Optional workspace scope — when set, the rollup is per-workspace, not
    per-tenant. Spec §2 lists workspaceId as optional."""

    window: BudgetWindow
    """Per-window rollup the caller already queried."""

    tick_time: dt.datetime = Field(alias="tickTime")
    """Workflow's tick timestamp. Used as `crossedAt` for newly-fired events."""

    force_recheck: bool = Field(default=False, alias="forceRecheck")
    """Operator-requested poll outside the cadence. Doesn't change rule
    output (the rule is deterministic on the snapshot), but the workflow
    uses this to bypass its own cadence check upstream of the agent."""

    billing_snapshot: BillingSnapshot = Field(alias="billingSnapshot")
    """Pre-fetched (spent, budget) pair — see BillingSnapshot."""

    previous_crossings: list[ThresholdPercent] = Field(
        default_factory=list, alias="previousCrossings", max_length=10
    )
    """Thresholds already-emitted for this window's current rollup. The
    workflow resets this list whenever the window rolls over (start of new
    hour/day/month). Edge case spec §8.5: cost_watch's own cost is excluded
    upstream (the workflow filters out `agentId='cost-watch'` in the BQ
    query), so prevention of recursive alerts is the caller's job."""

    @model_validator(mode="after")
    def _validate_previous_crossings_unique(self) -> CostWatchInput:
        """Per the threshold ladder semantics: a threshold should appear
        at most once. If the workflow passes duplicates, that's a workflow
        bug — fail fast so the operator notices."""
        if len(self.previous_crossings) != len(set(self.previous_crossings)):
            raise ValueError("previous_crossings must be unique")
        return self


class Crossing(BaseModel):
    """Per cost_watch.spec.md §2 properties.Output.crossings.items."""

    model_config = ConfigDict(extra="forbid")

    threshold: ThresholdPercent
    """One of {50, 75, 90, 95, 100, 110}."""

    crossed_at: dt.datetime = Field(alias="crossedAt")
    """Tick time at which the crossing was detected. Always == input.tick_time
    for a single invocation."""

    action: CrossingAction
    """Default action per `_DEFAULT_ACTION_BY_THRESHOLD`."""


class Throttle(BaseModel):
    """Per cost_watch.spec.md §2 properties.Output.throttle.

    When the agent crosses 90 % it emits a throttle hint — TPS cap + until
    timestamp. The Agent Runtime (Vertex AI Agent Engine) consumes this and
    self-throttles per-tenant invocation rate. None when no throttle is
    active.
    """

    model_config = ConfigDict(extra="forbid")

    tps: float = Field(gt=0.0, le=100.0)
    """Target throttle in tenant agent-invocations per second."""

    until: dt.datetime
    """Throttle expiration. The workflow re-evaluates each tick — once
    spend drops below the relevant threshold (eg new window rolls over),
    the next tick emits a fresh Output with `throttle=None`."""


class CostWatchOutput(BaseModel):
    """Per cost_watch.spec.md §2 properties.Output.

    Deterministic from input — same `(billing_snapshot, previous_crossings,
    tick_time)` ⇒ same output. The Phase 4 workflow consumes this and
    publishes `crossings` to `watchdog.cost.threshold_crossed`
    (+ `watchdog.cost.budget_exceeded` when any crossing is
    `over_limit_block`).
    """

    model_config = ConfigDict(extra="forbid")

    tenant_id: str = Field(alias="tenantId")
    workspace_id: str | None = Field(default=None, alias="workspaceId")
    window: BudgetWindow

    spent_usd: float = Field(ge=0.0, alias="spentUsd")
    budget_usd: float = Field(ge=0.0, alias="budgetUsd")
    """Echoes the resolved budget (`billing_snapshot.budget_usd` or the
    `DEFAULT_FALLBACK_BUDGET_USD` substitution)."""

    percent: float = Field(ge=0.0)
    """Spend / budget x 100. May exceed 100. **Special case**:
    when `budget_usd == 0` AND `spent_usd > 0` we report `percent = 100.0 *
    spent_usd` (effectively infinity scaled) — but we cap it at a sentinel
    `999_999.0` so callers downstream don't blow up on overflow (spec §8
    edge case 3 "free-tier tenant: any spend crosses 100%")."""

    crossings: list[Crossing] = Field(default_factory=list)
    """Newly-fired crossings since the last tick. Empty when nothing
    crossed (the typical case)."""

    throttle: Throttle | None = Field(default=None)
    """Active TPS throttle, when applicable."""

    new_previous_crossings: list[ThresholdPercent] = Field(
        default_factory=list, alias="newPreviousCrossings", max_length=10
    )
    """The state the workflow should persist for the NEXT tick. Equals
    `previous_crossings + {c.threshold for c in crossings}`. Convenience —
    the workflow could recompute, but emitting it keeps the workflow stateless."""

    blind: bool = Field(default=False)
    """True when the BQ snapshot was stale (snapshot_stale=True). Workflow
    surfaces a `cost_watch_blind` Pub/Sub event so anomaly_watch can pick up
    the staleness signal. Spec §6 escalation: "BigQuery query fails — degrade
    to last-known-good cached value; emit `cost_watch_blind`."."""


# ─────────────────────────────────────────────────────────────────────────────
# Pure rule evaluator — the actual runtime path.
# ─────────────────────────────────────────────────────────────────────────────


def _resolve_budget(snapshot: BillingSnapshot) -> float:
    """Substitute `DEFAULT_FALLBACK_BUDGET_USD` when no Spanner row exists.

    Spec §6 escalation: "Tenant has no budget configured — default to
    $50/day (configurable; D39 unlocks higher defaults)." We do the
    substitution here; callers who want a different default override via
    Spanner before calling.
    """
    if snapshot.budget_usd is None:
        return DEFAULT_FALLBACK_BUDGET_USD
    return float(snapshot.budget_usd)


def _compute_percent(spent_usd: float, budget_usd: float) -> float:
    """Compute spent / budget x 100 with sentinel for budget=0.

    Spec §8 edge case 7: "Budget = 0 + zero spend — percent is NaN; output
    0.0 explicitly, no action."
    Spec §8 edge case 3: "Free-tier tenant — budgetUsd=0, so any spend
    crosses 100%; agent emits a clear 'free tier exceeded' message."

    We cap the over-zero division at 999_999.0 so downstream
    Pydantic float fields don't trip on `inf` / `nan`.
    """
    if budget_usd == 0.0:
        if spent_usd == 0.0:
            return 0.0
        # Any positive spend on a $0 budget → over the cap. Use 999_999 as a
        # finite-but-obviously-saturated sentinel.
        return 999_999.0
    return (spent_usd / budget_usd) * 100.0


def _new_crossings(
    *,
    percent: float,
    previous: list[ThresholdPercent],
    tick_time: dt.datetime,
) -> list[Crossing]:
    """Return Crossings for thresholds newly crossed at this tick.

    A threshold T is "newly crossed" iff `percent >= T` AND T not in
    `previous`. We emit in ascending threshold order so callers that
    publish-then-stop on first hit get the lowest-severity crossing first
    (matches Slack rate-limiting upstream).
    """
    out: list[Crossing] = []
    prev_set = set(previous)
    for threshold in CANONICAL_THRESHOLDS:
        if percent >= threshold and threshold not in prev_set:
            out.append(
                Crossing(
                    threshold=threshold,  # type: ignore[arg-type]
                    crossedAt=tick_time,
                    action=_DEFAULT_ACTION_BY_THRESHOLD[threshold],
                )
            )
    return out


def _maybe_throttle(*, percent: float, tick_time: dt.datetime) -> Throttle | None:
    """Emit a TPS throttle when the tenant is between 90 % and 100 %.

    At ≥ 100 % the kill-switch (`over_limit_block` action) takes over —
    throttling is moot. Below 90 % no throttle is needed. The TPS slope is
    a coarse step function (5 TPS at 90 %, 2 TPS at 95 %) — finer-grained
    backoff is the Agent Runtime's job downstream.
    """
    if percent < 90.0 or percent >= 100.0:
        return None
    tps = 2.0 if percent >= 95.0 else 5.0
    # Hold the throttle until the next per_hour rollover — the workflow's
    # next-tick re-evaluation will refresh.
    until = tick_time + dt.timedelta(minutes=15)
    return Throttle(tps=tps, until=until)


def _check_anomalous_burn(
    snapshot: BillingSnapshot, percent: float
) -> bool:
    """Per the user brief: escalate when "anomalous burn-rate (>3x baseline)".

    The baseline is in `BillingSnapshot.baseline_burn_rate_usd_per_hour`
    (workflow pre-computes from a 7-day BQ rolling avg). When `None`,
    no baseline → no anomaly check, return False.

    `percent` is used here only as a sanity dampener — anomalies below 25 %
    of budget aren't actionable (could just be a busy minute). Above 25 %
    burn anomalies are forwarded to anomaly_watch (W1) for second-look.

    Returns:
        True when the spend pace suggests a runaway burn — workflow forwards
        to anomaly_watch as a `silent_log` event. False otherwise.
    """
    if snapshot.baseline_burn_rate_usd_per_hour is None:
        return False
    if snapshot.baseline_burn_rate_usd_per_hour == 0.0:
        # Baseline of 0 means "no historical activity" — any burn is novel
        # but probably first-use, not anomalous. Defer to the threshold ladder.
        return False
    if percent < 25.0:
        return False
    # 3x baseline expressed as USD-per-hour. The agent doesn't have the
    # actual burn rate of the current window without timestamps, so we use
    # a coarse proxy: percent advancement faster than the threshold ladder
    # would expect. Spec §6 escalation conditions imply the workflow
    # actually does the rate math; here we just relay the boolean and
    # leave the absolute-rate decision to the workflow.
    return snapshot.spent_usd > (3.0 * snapshot.baseline_burn_rate_usd_per_hour)


def evaluate_cost_watch(payload: CostWatchInput) -> CostWatchOutput:
    """Pure rule evaluation — the canonical runtime path for cost_watch.

    No I/O, no LLM, no async. Returns a deterministic `CostWatchOutput`
    that the Phase 4 workflow consumes + publishes to Pub/Sub.

    Per cost_watch.spec.md §1: "*Deterministic threshold gate.*" Same input
    ⇒ identical output (modulo `tick_time` which the caller controls).

    Args:
        payload: validated CostWatchInput. The workflow has already done
                 the BQ rollup + Spanner read and packed both into
                 `payload.billing_snapshot`.

    Returns:
        CostWatchOutput with the list of newly-crossed thresholds (most
        common case: empty list), an optional Throttle hint, and the
        `new_previous_crossings` state the workflow should persist for the
        next tick.
    """
    snapshot = payload.billing_snapshot
    budget_usd = _resolve_budget(snapshot)
    percent = _compute_percent(snapshot.spent_usd, budget_usd)

    crossings = _new_crossings(
        percent=percent,
        previous=list(payload.previous_crossings),
        tick_time=payload.tick_time,
    )
    throttle = _maybe_throttle(percent=percent, tick_time=payload.tick_time)

    anomalous = _check_anomalous_burn(snapshot, percent)
    if anomalous:
        # Anomalous burns surface as a debug log here; the workflow reads
        # this output's structured trace and emits a `silent_log` event
        # to anomaly_watch upstream. Per spec §6 we don't *block* on an
        # anomaly — it's a hint, not a hard gate.
        logger.warning(
            "cost_watch_anomalous_burn",
            extra={
                "tenant_id": payload.tenant_id,
                "workspace_id": payload.workspace_id,
                "window": payload.window,
                "spent_usd": snapshot.spent_usd,
                "baseline_usd_per_hour": snapshot.baseline_burn_rate_usd_per_hour,
                "percent": percent,
            },
        )

    new_previous = list(payload.previous_crossings) + [c.threshold for c in crossings]

    return CostWatchOutput(
        tenantId=payload.tenant_id,
        workspaceId=payload.workspace_id,
        window=payload.window,
        spentUsd=snapshot.spent_usd,
        budgetUsd=budget_usd,
        percent=percent,
        crossings=crossings,
        throttle=throttle,
        newPreviousCrossings=new_previous,
        blind=snapshot.snapshot_stale,
    )


# ─────────────────────────────────────────────────────────────────────────────
# D46 cost-guard wiring — billing.query → threshold ladder → pubsub.alert →
# (≥90%) runbook_execute("scale_down").
#
# `evaluate_cost_watch()` above is the PURE rule layer (no I/O). This section
# is the ORCHESTRATION the I4 brief asks for: it fetches a live (or stubbed)
# billing rollup, runs the rule layer, publishes one Pub/Sub alert per banner
# crossing, and at the 90% threshold auto-triggers the `scale_down` runbook
# that forces every essential Cloud Run service back to min=0 (D46).
#
# The three capabilities are imported lazily inside the function so the pure
# `evaluate_cost_watch` path keeps zero import-time coupling to the I/O tools
# (and so a caller that only wants the rule layer never pays the cost of
# pulling the runbook client into scope).
# ─────────────────────────────────────────────────────────────────────────────


# The threshold at which the cost-guard escalates from "alert only" to
# "alert + auto scale-down". Per the I4 brief: "90%서 runbook_execute('scale_down')
# 자동 트리거". Kept as a module constant so the test and the guard agree.
SCALE_DOWN_TRIGGER_PERCENT: float = 90.0

# pubsub_alert only accepts the 50/75/90/95 banner ladder (not 100/110). The
# 100+% over-limit case goes on a different topic (watchdog.cost.budget_exceeded)
# per pubsub_alert.py; the guard maps those crossings to scale_down + an
# over-limit log, not to a banner alert.
_BANNER_ALERT_KIND_BY_THRESHOLD: dict[int, str] = {
    50: "budget_50",
    75: "budget_75",
    90: "budget_90",
    95: "budget_95",
}

# Operator identity stamped on the auto-triggered runbook's audit trail. The
# guard fires autonomously (no human in the loop at 90%), so the audit line
# must make that explicit rather than impersonating a person.
_GUARD_ACTOR: str = "cost_watch-autoscale-guard@system"


class CostGuardResult(BaseModel):
    """Outcome of one `cost_guard()` tick — what was observed and what fired.

    This is the guard's audit record: the rule output it computed, the
    Pub/Sub message ids it published (one per banner crossing), and the
    scale_down runbook execution id when the 90% trigger fired (None when
    it didn't). Deterministic in stub mode, so the unit test can pin every
    field.
    """

    model_config = ConfigDict(extra="forbid")

    evaluation: CostWatchOutput
    """The full rule-layer output for this tick."""

    alert_message_ids: list[str] = Field(default_factory=list)
    """One Pub/Sub message id per banner crossing (50/75/90/95) published."""

    scale_down_triggered: bool = False
    """True iff spend reached SCALE_DOWN_TRIGGER_PERCENT and the scale_down
    runbook was invoked."""

    scale_down_execution_id: str | None = None
    """The runbook execution id when scale_down fired; None otherwise."""


def cost_guard(
    payload: CostWatchInput,
    *,
    dry_run: bool = True,
) -> CostGuardResult:
    """Wire the cost-watch tools into one auto-scale guard tick (D46).

    Pipeline:
        1. `evaluate_cost_watch(payload)` — deterministic threshold ladder
           against the pre-fetched `payload.billing_snapshot`. (The caller
           — or `cost_guard_from_billing` below — does the `billing_query`
           read; this function takes the snapshot so it stays testable
           without the BigQuery seam.)
        2. For each NEWLY-crossed banner threshold (50/75/90/95), publish a
           `pubsub_alert` onto `watchdog.cost.threshold_crossed`.
        3. If spend reached `SCALE_DOWN_TRIGGER_PERCENT` (90%) on this tick
           — i.e. the 90 crossing fired now — invoke
           `runbook_execute("scale_down")` to force every essential Cloud
           Run service back to min=0.

    Safety:
        `dry_run` defaults to True. In stub capability mode the runbook is
        ALWAYS a dry run regardless (runbook_execute forces it). In live
        mode the operator must pass `dry_run=False` to actually flip
        serving capacity — the guard surfaces the flag straight through to
        `runbook_execute`, which enforces the mutating-kind opt-in.

    Args:
        payload:  A validated `CostWatchInput` carrying the pre-fetched
                  billing snapshot (see `cost_guard_from_billing`).
        dry_run:  When True (default), the scale_down runbook is invoked in
                  dry-run mode. When False (live + explicit opt-in), the
                  runbook actually scales the fleet to zero.

    Returns:
        `CostGuardResult` — the rule output, the published alert ids, and
        the scale_down execution id (when fired).
    """
    # Lazy import keeps the pure rule path free of the I/O tools.
    from ss_agents.tools.pubsub_alert import PubsubAlertInput, pubsub_alert
    from ss_agents.tools.runbook_execute import (
        RunbookExecuteInput,
        runbook_execute,
    )

    evaluation = evaluate_cost_watch(payload)

    alert_message_ids: list[str] = []
    crossed_threshold_at_or_above_trigger = False

    for crossing in evaluation.crossings:
        threshold = crossing.threshold
        if threshold >= SCALE_DOWN_TRIGGER_PERCENT:
            crossed_threshold_at_or_above_trigger = True

        alert_kind = _BANNER_ALERT_KIND_BY_THRESHOLD.get(threshold)
        if alert_kind is None:
            # 100/110 over-limit crossings are not banner alerts — they go on
            # the budget_exceeded topic (handled by the workflow), not here.
            # The scale_down trigger above still fires for them (>= 90).
            continue

        # pct_consumed is expressed as a 0..1 ratio for pubsub_alert; the rule
        # layer carries percent as 0..100. Use the crossing's threshold as the
        # reported pct so the alert_kind ↔ pct consistency check inside
        # pubsub_alert passes (it expects pct within ±5% of the threshold).
        result = pubsub_alert(
            PubsubAlertInput(
                workspace_id=payload.workspace_id or payload.tenant_id,
                current_pct_consumed=threshold / 100.0,
                alert_kind=alert_kind,  # type: ignore[arg-type]
                message_body=(
                    f"cost_watch: {payload.tenant_id} reached {threshold}% of "
                    f"the {payload.window} budget "
                    f"(${evaluation.spent_usd:.2f} / ${evaluation.budget_usd:.2f})."
                ),
            )
        )
        alert_message_ids.append(result.message_id)

    scale_down_triggered = False
    scale_down_execution_id: str | None = None
    if crossed_threshold_at_or_above_trigger:
        logger.warning(
            "cost_watch_scale_down_trigger",
            extra={
                "tenant_id": payload.tenant_id,
                "workspace_id": payload.workspace_id,
                "window": payload.window,
                "percent": evaluation.percent,
                "dry_run": dry_run,
            },
        )
        runbook_out = runbook_execute(
            RunbookExecuteInput(
                runbook_name="rb_scale_down_v1",
                params={
                    "reason": "cost_guard_90pct",
                    "tenant_id": payload.tenant_id,
                    "window": payload.window,
                },
                dry_run=dry_run,
                executing_user=_GUARD_ACTOR,
                runbook_kind="scale_down",
            )
        )
        scale_down_triggered = True
        scale_down_execution_id = runbook_out.execution_id

    return CostGuardResult(
        evaluation=evaluation,
        alert_message_ids=alert_message_ids,
        scale_down_triggered=scale_down_triggered,
        scale_down_execution_id=scale_down_execution_id,
    )


def cost_guard_from_billing(
    *,
    tenant_id: str,
    window: BudgetWindow,
    tick_time: dt.datetime,
    time_range: tuple[dt.date, dt.date],
    workspace_id: str | None = None,
    budget_usd: float | None = None,
    previous_crossings: list[ThresholdPercent] | None = None,
    dry_run: bool = True,
) -> CostGuardResult:
    """End-to-end guard tick: read billing, evaluate, alert, auto-scale-down.

    This is the full I4 wiring — it owns the `billing_query` read that
    `cost_guard()` deliberately does not, then delegates to `cost_guard()`
    for the alert + scale_down chain. The split keeps `cost_guard()` unit-
    testable on a hand-built snapshot while this function exercises the
    real (stub-or-live) billing seam.

    Budget resolution: when `budget_usd` is None, the guard treats the D39
    `BUDGET_USD_CAP` ($1500) as the budget — the global judging-window cap —
    so the 50/75/90/95 ladder is computed against the credits ceiling per
    UNIFIED-TRACK3-PLAN §3.

    Args:
        tenant_id:          Tenant the rollup is scoped to.
        window:             Budget window (per_day, per_month, …).
        tick_time:          Guard tick timestamp (crossedAt for new events).
        time_range:         Inclusive (start, end) dates for billing_query.
        workspace_id:       Optional workspace scope.
        budget_usd:         Budget to measure against; None → D39 $1500 cap.
        previous_crossings: Thresholds already emitted this window (dedupe).
        dry_run:            Forwarded to the scale_down runbook.

    Returns:
        `CostGuardResult` for this tick.
    """
    from ss_agents.tools.billing_query import (
        BUDGET_USD_CAP,
        BillingQueryInput,
        billing_query,
    )

    billing = billing_query(
        BillingQueryInput(
            workspace_id=workspace_id,
            time_range=time_range,
            breakdown="total",
        )
    )

    resolved_budget = budget_usd if budget_usd is not None else BUDGET_USD_CAP

    payload = CostWatchInput(
        tenantId=tenant_id,
        workspaceId=workspace_id,
        window=window,
        tickTime=tick_time,
        billingSnapshot=BillingSnapshot(
            spentUsd=billing.total_usd,
            budgetUsd=resolved_budget,
        ),
        previousCrossings=previous_crossings or [],  # type: ignore[arg-type]
    )
    return cost_guard(payload, dry_run=dry_run)


# ─────────────────────────────────────────────────────────────────────────────
# AgentDef wrapper — for registry consistency only. Never invoked via run_agent.
# ─────────────────────────────────────────────────────────────────────────────


def build_cost_watch_system_prompt(payload: BaseModel) -> str:
    """Sentinel prompt builder — required by `AgentDef.system_prompt`.

    Returns a fixed marker string. This is NEVER sent to a model — the
    runtime path is `evaluate_cost_watch()`, not `run_agent()`. The marker
    exists so tooling that introspects every agent's prompt has something
    to render in the registry view.

    See module docstring "Why no LLM" for the rationale.
    """
    return (
        "cost_watch is a rule-based watchdog (W2). "
        "It has no LLM call — call evaluate_cost_watch() directly. "
        "See packages/agents-adk/src/ss_agents/agents/cost_watch.py."
    )


# The model id intentionally does NOT appear in `MODEL_PRICING`. If anyone
# accidentally routes this AgentDef through `run_agent()`, the runtime's
# `_run_with_adk → model_pricing(...)` will KeyError loud — preferable to
# silently paying for tokens.
COST_WATCH_MODEL_SENTINEL = "none-rule-based"


# Capability-layer tools (W2-C1, per D41). cost_watch itself is rule-based —
# the workflow calls `evaluate_cost_watch()` directly, never `run_agent()`.
# These tools live on the AgentDef for REGISTRY consistency (so observability
# tooling that enumerates `agent.tools` sees the capabilities cost_watch owns
# under ARCHITECTURE.md §3 row 21) and so the workflow's billing.query +
# pubsub.alert call sites resolve through the canonical capability seam.
from ss_agents.tools.billing_query import billing_query  # noqa: E402
from ss_agents.tools.pubsub_alert import pubsub_alert  # noqa: E402

cost_watch_agent_def: AgentDef[CostWatchInput, CostWatchOutput] = AgentDef(
    id="cost-watch",
    description=(
        "Tier-3 watchdog (W2) — rule-based per-tenant USD ceiling enforcer. "
        "Emits Pub/Sub-bound crossings at 50/75/90/95/100/110% of the tenant's "
        "budget for a given window. No LLM (D23 'agent-shaped for consistency' + "
        "false_negative_rate=0 safety requirement). Workflow consumers call "
        "evaluate_cost_watch() directly; this AgentDef exists for registry + "
        "observability consistency only. Spec: gcp-research/specs/tier3/"
        "cost_watch.spec.md (D23 W2, D28 per-view billing, D33 cost ledger 90d, "
        "D39 $1500 budget)."
    ),
    model=COST_WATCH_MODEL_SENTINEL,
    # `AgentDef.max_usd` requires `gt=0.0`. The value is meaningless for this
    # agent (no LLM call → no cost). Use the smallest meaningful float so it
    # never accidentally allows a charge if the runtime path is misused.
    max_usd=0.0001,
    input_schema=CostWatchInput,
    output_schema=CostWatchOutput,
    system_prompt=build_cost_watch_system_prompt,
    # Per ARCHITECTURE.md §3 row 21: cost_watch OWNS billing.query +
    # pubsub.alert as capabilities (the *workflow* invokes them on its
    # behalf). Wiring them here lets the registry surface the full tool
    # contract even though `evaluate_cost_watch()` itself never invokes
    # them via the ADK runtime.
    tools=[billing_query, pubsub_alert],
    # Single-shot rule eval — cap at 1 (the AgentDef field requires ≥ 1).
    max_turns=1,
)


__all__ = [
    "CANONICAL_THRESHOLDS",
    "COST_WATCH_MODEL_SENTINEL",
    "DEFAULT_FALLBACK_BUDGET_USD",
    "SCALE_DOWN_TRIGGER_PERCENT",
    "BillingSnapshot",
    "BudgetWindow",
    "CostGuardResult",
    "CostWatchInput",
    "CostWatchOutput",
    "Crossing",
    "CrossingAction",
    "ThresholdPercent",
    "Throttle",
    "build_cost_watch_system_prompt",
    "cost_guard",
    "cost_guard_from_billing",
    "cost_watch_agent_def",
    "evaluate_cost_watch",
]
