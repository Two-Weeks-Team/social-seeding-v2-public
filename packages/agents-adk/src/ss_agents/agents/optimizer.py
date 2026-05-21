"""Optimizer agent (M3) — Phase 4 Tier-2 meta-agent.

Nightly prompt-rewriter for the Tier-1 fleet, per the eval-driven-development
loop in `gcp-research/tests/MATRIX.md §10` and the optimizer.spec.md contract.

Behavior (per task brief + optimizer.spec.md §1):
    Reads recent eval traces (Vertex AI Agent Evaluation deltas + Agent
    Observability failure patterns) for ONE Tier-1 agent at a time and
    proposes a prompt diff (added / removed / rewritten lines) plus a
    confidence + expected per-metric lift. The optimizer NEVER hot-patches
    in-flight production prompts — Cloud Workflows opens a PR with the diff
    so a human reviews before merge (D27 + D24 Phase 0→1 hybrid in-process).

    Tier-2 meta: runs nightly (Cloud Scheduler), NOT per-request. Model =
    Gemini 3.1 Pro because reflection quality matters; cost cap = $0.10
    per single-agent invocation (heavier than Tier-1's $0.20 cap because
    the input includes 7-day eval history — but bounded since one call =
    one Tier-1 agent only).

Citations:
    D5    — Gemini 3.1 Pro (judgment-heavy reflection).
    D23   — Tier-2 meta agent M3 ("the 1→100 coordinators").
    D25   — Learning loop: "Prompt + Agent Evaluation + Vertex SFT +
            Distillation (Pro→Flash) + RLHF on Agent Simulation". This
            agent is the "Prompt" entry point; its `agent_optimizer.tune`
            tool drives the GA Vertex AI Prompt Optimizer (data-driven).
    D27   — AP2 Intent Mandate only — human approves the prompt PR before
            merge. The optimizer outputs a *proposal*, never a write.
    D38   — M3 PM agent coordinates the prompt-rewrite DAG at build-time.
    ARCHITECTURE.md §3 row 19:
        optimizer (M3) | 2 | Gemini 3.1 Pro
                       | agent_optimizer.tune, prompt_registry.update
                       | None | offline_eval_lift
    MATRIX.md §10 — closes the D25 loop:
        eval-score → prompt-diff → eval-rerun (per-agent, ≤1×/week,
        net delta ≥ +0.02, ≤2 simultaneous rewrites per night).

Compared to intake.py / analyst.py:
    - Single-shot agent (no conversation) — one rewrite proposal per call.
    - Output is a flat Pydantic class (no asking/done union, no wrapper).
    - Input embeds a 7-day eval-result window — list bounded to ≤100 runs
      to keep the prompt size + Pro token cost in check.
    - The agent NEVER writes back to prompt_registry; the workflow does
      that AFTER human PR approval (see edge case 1: optimizer must not
      rewrite its own prompt — caller's allowlist enforces this).
"""
from __future__ import annotations

import logging
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ss_agents.runtime import AgentDef
from ss_agents.tools.agent_optimizer_tune import agent_optimizer_tune
from ss_agents.tools.prompt_registry_update import prompt_registry_update

logger = logging.getLogger(__name__)


# Gemini 3.1 Pro per D53 / ARCHITECTURE.md §3 row 19 — reflection quality
# outweighs per-call cost on this Tier-2 nightly path.
DEFAULT_OPTIMIZER_MODEL = "gemini-3.1-pro"

# Reusable locale enum — D34 four-locale support. Multi-locale prompts
# must tune per-locale (optimizer.spec.md §8 edge case 5).
OptimizerLocale = Literal["ko", "en", "ja", "zh-CN"]

# Locale-keyed instruction tail. Same convention as intake.py / analyst.py.
_LOCALE_SUFFIX: dict[str, str] = {
    "ko": (
        "Respond in 한국어 for the `reasoning` field. Diff content stays in "
        "the target prompt's source language (English by convention)."
    ),
    "en": (
        "Respond in English. Diff content stays in the target prompt's "
        "source language (English by convention)."
    ),
    "ja": (
        "Respond in 日本語 for the `reasoning` field. Diff content stays in "
        "the target prompt's source language (English by convention)."
    ),
    "zh-CN": (
        "Respond in 简体中文 for the `reasoning` field. Diff content stays "
        "in the target prompt's source language (English by convention)."
    ),
}


# The 22-agent AgentId enum from specs/_common/shared.schema.json. Optimizer
# cannot tune itself or the watchdogs — see _ALLOWED_TARGETS below + spec §8
# edge case 1.
TargetAgentId = Literal[
    "sourcing", "vetting", "outreach-writer", "conversation",
    "conversation-responder", "logistics", "content-verify", "analyst",
    "research", "intake", "lead-outreach-writer",
    "payment-mandate", "compliance", "creative", "a11y", "customer-success",
    # Meta + watchdogs explicitly excluded from the type so callers can't
    # construct a request that targets them. The runtime ALSO double-checks
    # via _ALLOWED_TARGETS to defend against bypassed validators.
]


# Allowlist set used by the validators — kept in sync with TargetAgentId.
# Excludes: coordinator/critic/optimizer (Tier-2) and the three watchdogs
# (Tier-3 — rule-based, not prompt-driven).
_ALLOWED_TARGETS: frozenset[str] = frozenset(
    {
        "sourcing", "vetting", "outreach-writer", "conversation",
        "conversation-responder", "logistics", "content-verify", "analyst",
        "research", "intake", "lead-outreach-writer",
        "payment-mandate", "compliance", "creative", "a11y",
        "customer-success",
    }
)


# Target metrics the caller can ask the optimizer to lift. Mirrors the eval
# metrics in MATRIX.md §2.2 / optimizer.spec.md §2 objectiveMetric.
TargetMetric = Literal[
    "response_match_v2",
    "grounding_score",
    "activation_lift",
    "cost_efficiency",
    "tool_trajectory_avg_score",
    "hallucinations_v1",
    "safety_v1",
    "task_completion",
]


# Per-metric hint table embedded in the system prompt so the agent's
# reasoning stays consistent across runs. Same factor-out pattern as
# analyst._FLAG_HINTS. Not user-visible directly; the agent paraphrases.
_METRIC_HINTS: dict[str, str] = {
    "response_match_v2": (
        "Final-response match against a reference. Low scores point to "
        "schema drift or hallucinated structure — tighten output examples."
    ),
    "grounding_score": (
        "Citation-to-input fidelity. Low scores point to fabricated numbers "
        "or sources — add explicit 'do not invent' clauses."
    ),
    "activation_lift": (
        "Predicted downstream funnel lift. Low scores point to off-tone "
        "drafts — clarify operator-to-operator voice + audience."
    ),
    "cost_efficiency": (
        "USD per successful outcome. Low scores point to verbose prompts "
        "or unnecessary tool calls — trim instruction length, gate tools."
    ),
    "tool_trajectory_avg_score": (
        "Tool-call sequence vs. the expected trajectory. Low scores point "
        "to wrong ordering or missing tools — make the procedure explicit."
    ),
    "hallucinations_v1": (
        "Frequency of unsupported claims. High scores (worse) point to "
        "missing 'cite verbatim' constraints — add data-only rules."
    ),
    "safety_v1": (
        "Model Armor + RAI compliance. Low scores point to risky output "
        "patterns — add explicit content boundaries."
    ),
    "task_completion": (
        "Whether the agent reached a terminal state. Low scores point to "
        "premature escalation or infinite asking — sharpen 'ship when' "
        "criteria."
    ),
}


# ─────────────────────────────────────────────────────────────────────────────
# Input schema — one eval-window snapshot per target Tier-1 agent.
# ─────────────────────────────────────────────────────────────────────────────


class EvalResultRow(BaseModel):
    """One row of recent eval results. Mirrors the BigQuery
    `ss-v2-prod.agent_evals.l1_runs` schema (MATRIX.md §10 Step 2).

    Bounded: the optimizer reads up to 100 rows per call (input limit
    below) so the prompt size stays predictable for Gemini 3.1 Pro.
    """

    model_config = ConfigDict(extra="forbid")

    run_id: str = Field(min_length=1, max_length=128, alias="runId")
    """ULID of the eval run. Used by the agent to cite specific failures."""

    eval_case_id: str = Field(min_length=1, max_length=128, alias="evalCaseId")
    """`.evalset.json` case identifier (e.g. 'intake_en_01_minimal_brief')."""

    metric: TargetMetric
    score: float = Field(ge=0.0, le=1.0)
    """0-1 normalized score. Per-metric thresholds live in MATRIX.md §2.2."""

    passed: bool
    """Whether `score >= per-case threshold`. Pre-computed by the eval harness."""

    failure_reason: str | None = Field(
        default=None,
        alias="failureReason",
        max_length=500,
        description="Free-text reason when passed=False; null when passed=True.",
    )


class OptimizerInput(BaseModel):
    """Per the task brief: { target_agent_id, current_prompt,
    recent_eval_results (≤100 rows / 7 days), target_metrics[],
    locale, observed_failure_patterns[] }.

    Validation:
        - `target_agent_id` MUST be in _ALLOWED_TARGETS (excludes Tier-2 +
          watchdogs — see edge case 1).
        - `current_prompt` is bounded to keep the input prompt size in
          check (MAX_PROMPT_TOKENS-ish — optimizer.spec.md §8 edge case 3).
        - `target_metrics` are unique + non-empty.
        - `recent_eval_results` is bounded; the eval harness pre-filters.
    """

    model_config = ConfigDict(extra="forbid")

    target_agent_id: str = Field(
        min_length=1,
        max_length=64,
        alias="targetAgentId",
        description=(
            "Tier-1 agent whose prompt to rewrite. Must be in the allowed "
            "set (excludes Tier-2 + Tier-3 — optimizer.spec.md §8 #1)."
        ),
    )

    current_prompt: str = Field(
        min_length=50,
        max_length=20_000,
        alias="currentPrompt",
        description=(
            "Current system prompt of the target agent (the literal string "
            "produced by its build_*_system_prompt() function). The "
            "optimizer's diff is computed against THIS text."
        ),
    )

    recent_eval_results: list[EvalResultRow] = Field(
        default_factory=list,
        max_length=100,
        alias="recentEvalResults",
        description=(
            "Last-7-day eval runs for the target agent (≤100 rows). The "
            "optimizer clusters failures and proposes a fix per cluster."
        ),
    )

    target_metrics: list[TargetMetric] = Field(
        min_length=1,
        max_length=4,
        alias="targetMetrics",
        description=(
            "Metrics the rewrite must lift. The agent reports per-metric "
            "expected lift in the output. Per MATRIX.md §10.1 the net "
            "delta must be ≥ +0.02 — the runtime caller enforces this "
            "after reading the output."
        ),
    )

    locale: OptimizerLocale = "en"
    """Output language for `reasoning`. Diff content stays in the prompt's
    source language (English by convention). D34 + edge case 5."""

    observed_failure_patterns: list[str] = Field(
        default_factory=list,
        max_length=10,
        alias="observedFailurePatterns",
        description=(
            "0-10 hand-curated failure-pattern summaries from Agent "
            "Observability (e.g. 'agent asks about budget twice'). Steers "
            "the rewrite when the eval-results signal is too noisy."
        ),
    )

    @field_validator("target_agent_id")
    @classmethod
    def _target_in_allowlist(cls, v: str) -> str:
        """Defense in depth — also enforced by the TargetAgentId enum."""
        if v not in _ALLOWED_TARGETS:
            raise ValueError(
                f"target_agent_id {v!r} is not in the optimizer allowlist. "
                f"Allowed: {sorted(_ALLOWED_TARGETS)}"
            )
        return v

    @field_validator("target_metrics")
    @classmethod
    def _metrics_unique(cls, v: list[str]) -> list[str]:
        if len(set(v)) != len(v):
            raise ValueError("target_metrics must be unique")
        return v

    @field_validator("observed_failure_patterns")
    @classmethod
    def _patterns_bounded(cls, v: list[str]) -> list[str]:
        """Each pattern summary capped at 280 chars — keeps the prompt
        size predictable."""
        for i, pat in enumerate(v):
            if not pat or not pat.strip():
                raise ValueError(f"observed_failure_patterns[{i}] is empty")
            if len(pat) > 280:
                raise ValueError(
                    f"observed_failure_patterns[{i}] exceeds 280 chars "
                    f"(got {len(pat)})"
                )
        return v


# ─────────────────────────────────────────────────────────────────────────────
# Output schema — the prompt diff + projected lift + confidence.
# ─────────────────────────────────────────────────────────────────────────────


class PromptDiff(BaseModel):
    """The three-bucket diff format from the task brief.

    `added` / `removed` / `rewritten` are lists of plain strings (one entry
    per line or paragraph). The workflow side translates them into a
    unified-diff for the GitHub PR (MATRIX.md §10 Step 5).

    Each entry is capped at 1000 chars; the total combined size is also
    bounded by `_diff_size_within_limit` so a runaway rewrite (>50% of the
    original prompt — edge case in the task brief) trips escalation.
    """

    model_config = ConfigDict(extra="forbid")

    added: list[str] = Field(
        default_factory=list,
        max_length=30,
        description=(
            "New lines/paragraphs to insert. Each entry is 5-1000 chars. "
            "Empty list = no additions."
        ),
    )
    removed: list[str] = Field(
        default_factory=list,
        max_length=30,
        description=(
            "Existing lines/paragraphs to drop (must appear verbatim in "
            "the current_prompt input — the workflow validates this)."
        ),
    )
    rewritten: list[str] = Field(
        default_factory=list,
        max_length=30,
        description=(
            "Lines/paragraphs to replace. Format: 'OLD => NEW' where OLD "
            "appears verbatim in current_prompt and NEW is the proposed "
            "replacement. Total per entry 10-2000 chars."
        ),
    )

    @field_validator("added", "removed")
    @classmethod
    def _entry_length_bounds(cls, v: list[str]) -> list[str]:
        for i, entry in enumerate(v):
            if not (5 <= len(entry) <= 1000):
                raise ValueError(
                    f"diff entry [{i}] length must be 5-1000 chars "
                    f"(got {len(entry)})"
                )
        return v

    @field_validator("rewritten")
    @classmethod
    def _rewritten_format(cls, v: list[str]) -> list[str]:
        """Each rewritten entry MUST contain ' => ' as the separator."""
        for i, entry in enumerate(v):
            if " => " not in entry:
                raise ValueError(
                    f"rewritten[{i}] must use ' => ' separator (got: "
                    f"{entry[:60]!r}...)"
                )
            if not (10 <= len(entry) <= 2000):
                raise ValueError(
                    f"rewritten[{i}] length must be 10-2000 chars "
                    f"(got {len(entry)})"
                )
        return v

    @model_validator(mode="after")
    def _at_least_one_change(self) -> "PromptDiff":
        """A diff with no changes is a programmer error — the agent should
        emit an escalation in that case, not an empty diff."""
        total = len(self.added) + len(self.removed) + len(self.rewritten)
        if total == 0:
            raise ValueError(
                "PromptDiff must contain at least one of added/removed/"
                "rewritten — emit an Escalation instead of an empty diff"
            )
        return self

    def total_size(self) -> int:
        """Sum of character lengths across all three buckets — used by the
        runtime to enforce the 50%-of-original cap (edge case in brief)."""
        return (
            sum(len(s) for s in self.added)
            + sum(len(s) for s in self.removed)
            + sum(len(s) for s in self.rewritten)
        )


class OptimizerOutput(BaseModel):
    """Per task brief output:
        proposed_prompt_diff: PromptDiff
        expected_lift_per_metric: {metric: delta}
        confidence: 0-1
        reasoning: str
        simulation_recommended: bool
    """

    model_config = ConfigDict(extra="forbid")

    proposed_prompt_diff: PromptDiff = Field(alias="proposedPromptDiff")
    """The three-bucket diff. At least one of added/removed/rewritten must
    be non-empty (enforced at PromptDiff level)."""

    expected_lift_per_metric: dict[str, float] = Field(
        alias="expectedLiftPerMetric",
        description=(
            "Mapping metric -> projected score delta. Each value in [-1, 1]. "
            "Keys MUST be a subset of the input.target_metrics — the model "
            "validator enforces this."
        ),
    )

    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description=(
            "Optimizer's self-rated confidence in the projected lift. "
            "Below 0.6 → runtime caller escalates (edge case in brief)."
        ),
    )

    reasoning: str = Field(
        min_length=20,
        max_length=4000,
        description=(
            "Plain-language explanation of the failure-pattern clusters "
            "and why the proposed diff addresses them. Localized per "
            "input.locale (D34). Cited in the GitHub PR body."
        ),
    )

    simulation_recommended: bool = Field(
        alias="simulationRecommended",
        description=(
            "True when expected lift is < +0.05 on any target metric OR "
            "the diff touches > 30% of original prompt size. The workflow "
            "uses this to decide whether to fan out to Agent Simulation "
            "(MATRIX.md §5) before opening the PR."
        ),
    )

    @field_validator("expected_lift_per_metric")
    @classmethod
    def _lift_bounds(cls, v: dict[str, float]) -> dict[str, float]:
        if not v:
            raise ValueError("expected_lift_per_metric must not be empty")
        for metric, delta in v.items():
            if not (-1.0 <= delta <= 1.0):
                raise ValueError(
                    f"expected_lift_per_metric[{metric!r}]={delta} out of "
                    f"[-1, 1] bounds"
                )
        return v


# Type alias mirroring analyst.py — keeps the Annotated naming convention.
OptimizerAgentOutput = Annotated[
    OptimizerOutput, Field(description="OptimizerAgent output")
]


# ─────────────────────────────────────────────────────────────────────────────
# System prompt builder — assembled per-input (eval results inline).
# ─────────────────────────────────────────────────────────────────────────────


def _format_failure_clusters(rows: list[EvalResultRow]) -> str:
    """Group failures by metric + a 60-char prefix of failure_reason. The
    optimizer reasons over CLUSTERS, not individual rows — the same reduction
    the GA Vertex AI Prompt Optimizer (data-driven) applies when it scores
    instruction candidates against labeled failure examples (AI-AGENTS.md §21:
    "clusters real-world failures from production traces"). v2 has no precedent
    here; the pattern is canonical to this Tier-2 agent."""
    if not rows:
        return "Recent eval results: (none supplied — operate on observed_failure_patterns only)."
    failed = [r for r in rows if not r.passed]
    total = len(rows)
    if not failed:
        return (
            f"Recent eval results: {total} runs, all passed. Optimizer is "
            "running in lift-mode (looking for headroom, not failures)."
        )

    # Cluster by (metric, reason-prefix).
    clusters: dict[tuple[str, str], int] = {}
    for row in failed:
        key = (
            row.metric,
            (row.failure_reason or "(no reason recorded)")[:60],
        )
        clusters[key] = clusters.get(key, 0) + 1

    # Render top-10 clusters by frequency.
    ranked = sorted(clusters.items(), key=lambda kv: kv[1], reverse=True)[:10]
    lines = [
        f"Recent eval results: {total} runs, {len(failed)} failed "
        f"({len(failed) / total * 100:.0f}%). Top failure clusters:"
    ]
    for (metric, reason), count in ranked:
        lines.append(f"  · [{metric}] ×{count} — {reason}")
    return "\n".join(lines)


def _format_metric_hints(metrics: list[str]) -> str:
    """Render the per-target-metric hint block. Same factor-out as
    analyst._format_flag_block — keeps locale-translated reasoning
    consistent across runs."""
    hint_lines: list[str] = []
    for m in metrics:
        if m in _METRIC_HINTS:
            hint_lines.append(f"  · `{m}` → {_METRIC_HINTS[m]}")
    if not hint_lines:
        return ""
    return "Target-metric hints (paraphrase, do NOT echo verbatim):\n" + "\n".join(
        hint_lines
    )


def _format_observed_patterns(patterns: list[str]) -> str:
    """Render the operator-supplied failure-pattern bullets."""
    if not patterns:
        return "Observed failure patterns: (none supplied)."
    bullets = "\n".join(f"  · {p}" for p in patterns)
    return f"Observed failure patterns (operator-curated):\n{bullets}"


def build_optimizer_system_prompt(payload: BaseModel) -> str:
    """Compose the Gemini system prompt from the validated input.

    Mirrors the intake.py / analyst.py convention:
        1. Deterministic — same input ⇒ identical string.
        2. Locale-specific output suffix (D34).
        3. Per-metric hint table embedded so the reasoning stays
           consistent across runs.

    The prompt embeds the FULL current_prompt verbatim (capped at 20k chars
    by the input validator) so the agent can quote exact lines in the
    `removed` / `rewritten` buckets.
    """
    assert isinstance(payload, OptimizerInput), (
        f"unexpected input type: {type(payload)}"
    )

    failure_block = _format_failure_clusters(payload.recent_eval_results)
    metric_hints = _format_metric_hints(payload.target_metrics)
    pattern_block = _format_observed_patterns(payload.observed_failure_patterns)
    locale_line = _LOCALE_SUFFIX.get(payload.locale, _LOCALE_SUFFIX["en"])
    target_metrics_csv = ", ".join(payload.target_metrics)

    return "\n".join(
        [
            "You are the Optimizer agent (M3) for Social Seeding — a multi-tenant agent platform for influencer-marketing campaigns. You run nightly and propose targeted rewrites to ONE Tier-1 agent's system prompt at a time. You do NOT write to the prompt registry — the workflow opens a GitHub PR with your diff and a human reviews before merge.",
            "",
            f"## Target agent: `{payload.target_agent_id}`",
            f"Metrics to lift: {target_metrics_csv}.",
            metric_hints,
            "",
            "## Failure signal",
            failure_block,
            "",
            pattern_block,
            "",
            "## Current system prompt (verbatim — quote exact lines in `removed`/`rewritten`)",
            "```",
            payload.current_prompt,
            "```",
            "",
            "## What to produce",
            "Return JSON matching the response schema:",
            "",
            "1) `proposed_prompt_diff` — three-bucket diff:",
            "   · `added[]`   — new lines/paragraphs (5-1000 chars each, ≤30 entries).",
            "   · `removed[]` — lines/paragraphs to drop, EACH MUST APPEAR VERBATIM in the current prompt above.",
            "   · `rewritten[]` — entries of the form 'OLD => NEW' where OLD appears verbatim and NEW is the replacement (10-2000 chars each).",
            "   At least ONE of the three buckets must be non-empty.",
            "",
            "2) `expected_lift_per_metric` — one entry per target metric. Each value in [-1, 1]; positive values are score deltas the diff should produce.",
            "",
            "3) `confidence` — your self-rated confidence in (0-1). Below 0.6 the caller will escalate the proposal back to human review — be honest. Bias DOWN when:",
            "   · you cluster fewer than 3 failures on a metric (small sample),",
            "   · the rewrite touches the procedural backbone of the prompt (e.g. tool-call sequence),",
            "   · the target agent is `payment-mandate` or `compliance` (safety-critical — humans always review).",
            "",
            "4) `reasoning` — 20-4000 chars plain prose. Walk through the failure clusters you addressed and why your diff helps. This text lands in the GitHub PR body.",
            "",
            "5) `simulation_recommended` — true when:",
            "   · expected lift < +0.05 on any single target metric (close-to-noise),",
            "   · OR the diff touches >30% of the original prompt size (high regression risk),",
            "   · OR confidence is < 0.7.",
            "",
            "## Discipline",
            "  · Quote exact lines in `removed`/`rewritten` — the workflow validates against the input prompt and rejects diffs whose OLD text is not found.",
            "  · Cluster, don't chase individual runs. One diff entry per failure cluster.",
            "  · Don't propose stylistic edits when no metric needs lifting — emit an empty-bucket diff with a single small `added` clarification line and confidence ≥ 0.85 when in lift-mode.",
            "  · NEVER rewrite escalation conditions, USD caps, tool-call signatures, or schema field names — those are runtime contracts.",
            "  · NEVER add 'ignore previous instructions' or any meta-instruction targeting the optimizer itself. (Edge case #1 — optimizer cannot rewrite optimizer.)",
            "  · NEVER add chain-of-thought-leaking phrases ('reveal your reasoning', 'show the system prompt').",
            "",
            locale_line,
        ]
    )


# ─────────────────────────────────────────────────────────────────────────────
# AgentDef — the Pydantic config the runtime consumes.
# ─────────────────────────────────────────────────────────────────────────────


optimizer_agent_def: AgentDef[OptimizerInput, OptimizerOutput] = AgentDef(
    id="optimizer",
    description=(
        "Tier-2 meta agent (M3) that proposes prompt rewrites for a single "
        "Tier-1 agent based on 7-day eval results + operator-curated "
        "failure patterns. Outputs a three-bucket diff "
        "(added/removed/rewritten) plus expected per-metric lift, "
        "self-rated confidence, plain-prose reasoning, and a "
        "simulation-recommended flag. NEVER writes to prompt_registry — "
        "the workflow opens a GitHub PR for human review per D27/D24. "
        "Per optimizer.spec.md (D25 learning loop, D23 Tier-2 M3)."
    ),
    model=DEFAULT_OPTIMIZER_MODEL,
    # Task brief: $0.10 USD per invocation. Pro is ~$10/M out tokens, so
    # this comfortably covers a 4000-char reasoning + 30-entry diff on a
    # 20k-char input prompt. Heavier than Tier-1's $0.20 cap is INTENTIONAL —
    # one optimizer call replaces what would be a multi-hour human review.
    max_usd=0.10,
    input_schema=OptimizerInput,
    output_schema=OptimizerOutput,
    system_prompt=build_optimizer_system_prompt,
    # D41 capability layer — optimizer.spec.md §6 (ARCHITECTURE.md §3 row 19)
    # names `agent_optimizer.tune` (submit a Vertex AI Prompt Optimizer
    # data-driven job) and `prompt_registry.update` (write the optimized prompt)
    # as the M3 tool surface. Both return deterministic receipts in dev/CI
    # (stub). `agent_optimizer.tune` live mode is wired (operator-gated): it
    # composes the GA data-driven-optimizer config from observed failures +
    # the target metric and submits it via google-cloud-aiplatform — see
    # ss_agents.tools.agent_optimizer_tune for the operator prerequisites.
    #
    # The original "no tools" comment is preserved here as docs — the agent
    # still reasons over its input, but the two D41 tools let it CALL the
    # Prompt Optimizer when it needs prompt-rewrite proposals, and persist
    # the winning version when the human-review PR merges.
    tools=[agent_optimizer_tune, prompt_registry_update],
    # Single-turn agent — no self-correction loop. Cap at 3 turns for
    # defense in depth against Gemini self-revising the diff format.
    max_turns=3,
)


# ─────────────────────────────────────────────────────────────────────────────
# __main__ entry point for ad-hoc testing.
# ─────────────────────────────────────────────────────────────────────────────


if __name__ == "__main__":  # pragma: no cover
    """Run a single invocation against live Vertex AI.

    Requires:
        GOOGLE_GENAI_USE_VERTEXAI=TRUE
        GOOGLE_CLOUD_PROJECT=<…>
        GOOGLE_CLOUD_LOCATION=us-central1
        SS_LIVE=1
    """
    import asyncio
    import json

    from ss_agents.runtime import RunContext, run_agent

    async def main() -> None:
        ctx = RunContext(
            tenant_id="t_demo000000000000",
            workspace_id="ws_demo_optimizer_main",
            trace_id="trace-cli-optimizer-1",
        )
        payload = OptimizerInput(
            targetAgentId="intake",
            currentPrompt=(
                "You are the campaign intake agent for Social Seeding. "
                "Assemble a CampaignBrief from a short conversation with "
                "the user. Ask one focused question per turn until you "
                "have enough to produce a valid brief. Respond in the "
                "user's language. Keep questions ≤ 2 sentences."
            ),
            recentEvalResults=[
                EvalResultRow(
                    runId="run_001",
                    evalCaseId="intake_en_03_contradiction_confirms",
                    metric="task_completion",
                    score=0.55,
                    passed=False,
                    failureReason="agent asked the same question twice",
                ),
                EvalResultRow(
                    runId="run_002",
                    evalCaseId="intake_ko_04_one_shot",
                    metric="response_match_v2",
                    score=0.62,
                    passed=False,
                    failureReason="agent asked about budget unprompted",
                ),
            ],
            targetMetrics=["task_completion", "response_match_v2"],
            locale="en",
            observedFailurePatterns=[
                "agent re-asks creatorCount after it was answered",
                "agent volunteers budget questions despite the brief saying not to",
            ],
        )
        outcome = await run_agent(optimizer_agent_def, payload, ctx)
        print(json.dumps(outcome.model_dump(by_alias=True), indent=2, default=str))

    asyncio.run(main())


__all__ = [
    "DEFAULT_OPTIMIZER_MODEL",
    "EvalResultRow",
    "OptimizerAgentOutput",
    "OptimizerInput",
    "OptimizerLocale",
    "OptimizerOutput",
    "PromptDiff",
    "TargetAgentId",
    "TargetMetric",
    "build_optimizer_system_prompt",
    "optimizer_agent_def",
]


# Touch Any to keep static checkers from pruning the import — we carry it
# forward for Phase 5's eval-result-payload extension fields.
_TYPING_ECHO: tuple[Any, ...] = ()
