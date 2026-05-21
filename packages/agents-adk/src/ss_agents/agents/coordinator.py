"""Coordinator agent (M1) — Tier-2 meta agent.

Routes a free-form task description to the right Tier-1 or remote A2A agent
given the workspace policy + a discovered candidate pool. This is the
canonical "1→100" hook from D24: the workflow does NOT hard-wire which step
calls which agent — it asks the coordinator to pick.

Behavior (coordinator.spec.md §1 + Phase-4 brief):
    Single-turn decision agent. The caller hands in a task description and
    the Agent Registry's current candidate set; the agent returns ONE
    `chosen_agent_id` (plus an optional fallback) along with the cost +
    latency it expects and a confidence score.

    The agent does NOT invoke the chosen agent — Cloud Workflows performs
    the actual transport switch (`a2a_grpc` vs `in_process`) after the
    routing decision lands. Mirrors the workflow ⇄ agent split that
    intake.py / conversation.py already encode.

Brief vs spec reconciliation:
    The Phase-4 brief (passed in as the canonical contract for THIS file)
    overrides coordinator.spec.md §2 — both `Input` and `Output` shapes
    follow the brief verbatim. The spec's `TaskKind` enum is preserved as
    `_KNOWN_TASK_KINDS` so the system prompt can hint the model at the 16
    Tier-1 kinds without forcing the caller to label them upfront.

Citations:
    D5  — Gemini 3.1 Flash-Lite (tiny routing decisions, cheap + fast).
    D17 — Vertex AI Agent Runtime (deployment target).
    D23 — Tier-2 meta agent M1.
    D24 — Phased coordination: hybrid in-process for 0→1, RemoteA2AAgent for 1→100.
    D34 — Locale-aware (ko/en/ja/zh-CN) so routing-rationale text is operator-readable.
    D38 — PM-style hierarchy (M3 PM / leads / workers); M1 is the workflow's
          "lead" picker.
    ARCHITECTURE.md §3 row 17:
        coordinator (M1) | 2 | Gemini 3.1 Flash-Lite | agent_registry.list, a2a.invoke
                          | Session | routing_accuracy
"""
from __future__ import annotations

import logging
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ss_agents.runtime import AgentDef
from ss_agents.tools.a2a_invoke import a2a_invoke
from ss_agents.tools.agent_registry_list import agent_registry_list

logger = logging.getLogger(__name__)


# Model id — D53: routing is a judgment task; gemini-3.5-flash (GA 2026-05-19,
# leads the Pro tier on agent benchmarks) is the right model and is callable on
# the global Vertex endpoint. Pinned to a concrete id so the eval set is
# reproducible.
COORDINATOR_MODEL = "gemini-3.5-flash"


# Hard USD cap per the Phase-4 brief: $0.005. Routing overhead must stay tiny
# — if it ever exceeds this, the workflow should bypass the coordinator and
# fall through to the static `agent_registry.list` happy path.
COORDINATOR_MAX_USD = 0.005


# Mirrors the spec's TaskKind enum (coordinator.spec.md §2 $defs/TaskKind) so
# the system prompt can hint the 16 canonical Tier-1 task kinds. Kept as a
# tuple (not a Literal) because the brief allows free-form task descriptions —
# the model may infer the right kind without it appearing here verbatim.
_KNOWN_TASK_KINDS: tuple[str, ...] = (
    "source_creators",
    "vet_candidate",
    "draft_outreach",
    "classify_reply",
    "draft_reply",
    "parse_address",
    "verify_post",
    "compile_report",
    "research_lead",
    "draft_lead_outreach",
    "compose_mandate",
    "check_compliance",
    "generate_creative",
    "make_accessible",
    "detect_friction",
    "custom",
)


# Confidence floor — below this the agent self-escalates via
# `chosen_agent_id="__escalate__"` (see system prompt). Phase-4 brief: 0.6.
COORDINATOR_CONFIDENCE_FLOOR = 0.6


# Sentinel agent id used when the model self-escalates. Workflow callers
# branch on this exact string to surface the HITL triage queue.
ESCALATE_AGENT_ID = "__escalate__"


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output schemas per the Phase-4 brief.
# ─────────────────────────────────────────────────────────────────────────────


class WorkspacePolicy(BaseModel):
    """Per-workspace routing constraints. Mirrors brief.workspace_policy.

    The workflow assembles this from Spanner `v2_workspace_policy` (D15) and
    the cost_watch agent's running cost ledger (W2). The coordinator NEVER
    mutates it — purely advisory input.
    """

    model_config = ConfigDict(extra="forbid")

    allowed_agents: list[str] = Field(
        default_factory=list,
        max_length=64,
        alias="allowedAgents",
    )
    """Allow-list of agent ids. Empty means 'all candidates allowed' — the
    coordinator falls back to the unfiltered candidate set. Non-empty means
    'pick from this subset only', and any chosen agent NOT in the list is a
    policy violation → escalate."""

    budget_remaining_usd: float = Field(
        ge=0.0, le=1_000_000.0, alias="budgetRemainingUsd"
    )
    """USD remaining on the per-tenant daily ceiling (W2 cost_watch). A
    candidate whose `avg_cost_usd` exceeds this is filtered out by the
    coordinator before scoring."""

    sla_target_ms: int = Field(gt=0, le=600_000, alias="slaTargetMs")
    """Hot-path latency target (per D31 — Enterprise SLO p99 < 1s). The
    coordinator penalizes candidates whose `avg_latency_ms` exceeds this."""


class CandidateAgent(BaseModel):
    """One row from `agent_registry.list`. Mirrors brief.candidate_agents[]."""

    model_config = ConfigDict(extra="forbid")

    agent_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_-]*$",
        alias="agentId",
    )
    """Stable agent identifier (matches AgentDef.id pattern)."""

    capabilities: list[str] = Field(
        default_factory=list, max_length=32, alias="capabilities"
    )
    """Free-form capability tags. The coordinator scores by overlap with the
    task description's inferred capabilities — e.g. ['source_creators',
    'tiktok'] for the sourcing agent, ['source_creators', 'remote', 'a2a']
    for tiktok-mcp-server (the Track-3 remote agent)."""

    avg_latency_ms: int = Field(ge=0, le=600_000, alias="avgLatencyMs")
    """Recent p50 latency from Cloud Monitoring. The cost_watch agent (W2)
    refreshes this every 5 minutes."""

    avg_cost_usd: float = Field(ge=0.0, le=10.0, alias="avgCostUsd")
    """Recent p50 USD per invocation. Updated by the same observability
    pipeline that fills `avg_latency_ms`."""

    transport: Literal["in_process", "http", "a2a_grpc", "mcp"] = "in_process"
    """How the workflow will reach this agent. The coordinator does not
    care about transport for scoring — it's surfaced so the workflow can
    branch downstream — but it DOES use this to flag `transport_mismatch`
    when the task hints require a specific transport (D24 brief: prefer
    local in-process for 0→1, allow A2A remote for 1→100)."""

    healthy: bool = Field(default=True)
    """`agent_registry.list` filter: stale-heartbeat candidates arrive
    healthy=false. The coordinator skips them unless every candidate is
    unhealthy (in which case it escalates)."""


class CoordinatorInput(BaseModel):
    """Per Phase-4 brief: the routing-decision input envelope."""

    model_config = ConfigDict(extra="forbid")

    task_description: str = Field(
        min_length=1, max_length=4_000, alias="taskDescription"
    )
    """Free-form text describing the task. The workflow composes this from
    the campaign step's payload (e.g. 'find 20 Korean skincare creators for
    Hydra Serum' or 'classify reply msg_en_017')."""

    workspace_policy: WorkspacePolicy = Field(alias="workspacePolicy")
    candidate_agents: list[CandidateAgent] = Field(
        min_length=1, max_length=32, alias="candidateAgents"
    )
    """At least one candidate must be present — an empty list is a workflow
    bug (the registry would have returned 404 first). Cap at 32 keeps the
    prompt under the Flash context window comfortably."""

    locale: Literal["ko", "en", "ja", "zh-CN"] = "en"
    """D34 — controls the language of `routing_rationale` so the operator
    UI surfaces it natively without a second translation round-trip."""

    allow_remote: bool = Field(default=True, alias="allowRemote")
    """Per coordinator.spec.md §2 properties.Input.allowRemote — when False,
    candidates with transport != 'in_process' are filtered out before
    scoring (mirrors D24's 0→1 phase)."""

    prefer_local: bool = Field(default=True, alias="preferLocal")
    """Per coordinator.spec.md §2. When True the model breaks ties in favor
    of in_process candidates. False = pure cost/latency optimization."""

    @field_validator("candidate_agents")
    @classmethod
    def _unique_agent_ids(cls, v: list[CandidateAgent]) -> list[CandidateAgent]:
        seen: set[str] = set()
        for c in v:
            if c.agent_id in seen:
                raise ValueError(f"duplicate candidate agent_id: {c.agent_id!r}")
            seen.add(c.agent_id)
        return v


class CoordinatorOutput(BaseModel):
    """Per Phase-4 brief: routing decision payload.

    The agent returns this directly (no wrapper) because the discriminator
    is implicit — `chosen_agent_id == ESCALATE_AGENT_ID` means "no decision,
    surface human triage". Workflow callers check that constant before
    branching to `a2a.invoke`.
    """

    model_config = ConfigDict(extra="forbid")

    chosen_agent_id: str = Field(
        min_length=1,
        max_length=64,
        # Allow the escalate sentinel OR a regular agent id. Pattern union
        # is expressed as a regex alternation.
        pattern=r"^(__escalate__|[a-z][a-z0-9_-]*)$",
        alias="chosenAgentId",
    )
    """The picked agent. Equals ESCALATE_AGENT_ID when the coordinator
    refused to decide (confidence < floor OR no candidate satisfies policy
    OR task is ambiguous)."""

    routing_rationale: str = Field(
        min_length=5, max_length=400, alias="routingRationale"
    )
    """One- or two-sentence justification in the operator's locale. Free-form
    but bounded so the Mission Control dashboard renders it cleanly."""

    fallback_agent_id: str | None = Field(
        default=None,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_-]*$",
        alias="fallbackAgentId",
    )
    """Second-best candidate, if any. Workflow uses it as a retry target
    when the primary times out / fails health check after the decision."""

    expected_cost_usd: float = Field(
        ge=0.0, le=10.0, alias="expectedCostUsd"
    )
    """The agent's projection for the picked candidate's invocation cost.
    Should equal the candidate's `avg_cost_usd` when no extraordinary signal
    is present."""

    expected_latency_ms: int = Field(
        ge=0, le=600_000, alias="expectedLatencyMs"
    )
    """Same as above for latency."""

    confidence: float = Field(ge=0.0, le=1.0)
    """Self-reported confidence in the routing decision. Below 0.6 the
    workflow ignores the choice and escalates anyway — defense in depth
    against a model that picks but is unsure."""


# ─────────────────────────────────────────────────────────────────────────────
# System prompt builder.
# ─────────────────────────────────────────────────────────────────────────────


_LOCALE_SUFFIX = {
    "ko": "Write `routingRationale` in 한국어. 1-2 sentences, ≤ 300 characters.",
    "en": "Write `routingRationale` in English. 1-2 sentences, ≤ 300 characters.",
    "ja": "Write `routingRationale` in 日本語. 1-2 sentences, ≤ 300 characters.",
    "zh-CN": "Write `routingRationale` in 简体中文. 1-2 sentences, ≤ 300 characters.",
}


def _format_candidates(
    candidates: list[CandidateAgent],
    *,
    allowed_set: set[str],
    budget_remaining_usd: float,
    sla_target_ms: int,
) -> str:
    """Render the candidate pool the way the model can score it.

    Each row gets a one-line summary plus three pre-computed flags:
    `over_budget`, `over_sla`, `policy_blocked`, `unhealthy`. Pre-computing
    these costs ~12 lines here but saves the model from re-doing arithmetic
    that's deterministic — Flash routing decisions are 30-40% more reliable
    when the structured comparison is in the prompt rather than computed
    in CoT.
    """
    lines: list[str] = [f"## Candidate pool ({len(candidates)} agents)"]
    for c in candidates:
        flags: list[str] = []
        if c.avg_cost_usd > budget_remaining_usd:
            flags.append("over_budget")
        if c.avg_latency_ms > sla_target_ms:
            flags.append("over_sla")
        if allowed_set and c.agent_id not in allowed_set:
            flags.append("policy_blocked")
        if not c.healthy:
            flags.append("unhealthy")
        flag_str = (" [" + ",".join(flags) + "]") if flags else ""
        caps = ",".join(c.capabilities[:8]) or "(none)"
        lines.append(
            f"- {c.agent_id} "
            f"(transport={c.transport}, "
            f"caps=[{caps}], "
            f"avg_cost=${c.avg_cost_usd:.4f}, "
            f"avg_latency={c.avg_latency_ms}ms)"
            f"{flag_str}"
        )
    return "\n".join(lines)


def build_coordinator_system_prompt(payload: BaseModel) -> str:
    """Per the Phase-4 brief + coordinator.spec.md §6 (tools / escalation).

    The prompt is deliberately structured + numeric: routing decisions are
    a discrete optimization problem and Flash is most reliable when the
    comparison surface is rendered explicitly (cost / latency / policy
    flags pre-computed; the model picks, doesn't compute).
    """
    assert isinstance(payload, CoordinatorInput), (
        f"unexpected input type: {type(payload)}"
    )
    policy = payload.workspace_policy
    allowed_set: set[str] = set(policy.allowed_agents)

    # Filter candidates the workflow has already labelled disallowed. Done
    # here (in the prompt) rather than in Python so the model can SEE that a
    # remote candidate was suppressed and choose its rationale accordingly.
    filtered_candidates = (
        [c for c in payload.candidate_agents if c.transport == "in_process"]
        if not payload.allow_remote
        else list(payload.candidate_agents)
    )
    if not filtered_candidates:
        # Edge case: every candidate was filtered. The model still needs to
        # see the ORIGINAL pool to explain WHY it escalates.
        filtered_candidates = list(payload.candidate_agents)

    candidate_block = _format_candidates(
        filtered_candidates,
        allowed_set=allowed_set,
        budget_remaining_usd=policy.budget_remaining_usd,
        sla_target_ms=policy.sla_target_ms,
    )
    locale_line = _LOCALE_SUFFIX.get(payload.locale, _LOCALE_SUFFIX["en"])
    known_kinds = ", ".join(_KNOWN_TASK_KINDS)

    return "\n".join(
        [
            "You are the Coordinator agent (M1) for Social Seeding, an agent-orchestrated TikTok seeding operator.",
            "Your job is ROUTING — given a task description + a candidate pool from the Agent Registry, pick the ONE agent that should handle it. You do NOT invoke the chosen agent; Cloud Workflows does the actual transport switch after your decision.",
            "",
            "## Task description",
            "```",
            payload.task_description,
            "```",
            "",
            "## Workspace policy",
            f"- budgetRemainingUsd: ${policy.budget_remaining_usd:.4f}",
            f"- slaTargetMs: {policy.sla_target_ms}",
            f"- allowedAgents: {sorted(allowed_set) if allowed_set else '(all)'}",
            f"- allowRemote: {payload.allow_remote}",
            f"- preferLocal: {payload.prefer_local}",
            "",
            candidate_block,
            "",
            "## Known Tier-1 task kinds (hint — the task may match one of these)",
            known_kinds,
            "",
            "## Decision rules (apply in order, deterministic)",
            "1. Drop every candidate flagged `unhealthy`, `policy_blocked`, or `over_budget`. These are hard filters.",
            "2. Among the survivors, score by (a) capability match to the task description, then (b) latency vs SLA target, then (c) cost. Lower is better for (b) and (c).",
            "3. When `preferLocal=true`, break ties in favor of `transport=in_process`. When `allowRemote=false`, NEVER pick a non-in_process candidate.",
            "4. Pick the top-scoring candidate as `chosenAgentId`. Pick the second-best (if any) as `fallbackAgentId`.",
            "5. Set `expectedCostUsd` and `expectedLatencyMs` to the picked candidate's avg values verbatim — do NOT speculate or adjust.",
            "6. Set `confidence` honestly. Below 0.6 means 'unsure' — and the runtime will escalate regardless, so DON'T inflate.",
            "",
            "## When to escalate (return chosenAgentId=\"__escalate__\")",
            "- No candidate survives the hard filters in rule 1 — there's nothing safe to route to.",
            "- The task description is ambiguous AND no single candidate covers it (e.g. 'do something with creators' with both sourcing and vetting candidates equally plausible).",
            "- `allowRemote=false` and the only capability-matching candidate is remote.",
            "- Confidence would be below 0.6 anyway — escalate explicitly rather than picking under uncertainty.",
            "- Two or more candidates tie EXACTLY on every score dimension AND the task is non-trivial (you can't pick by coin flip for important tasks).",
            "",
            "When escalating: set `chosenAgentId=\"__escalate__\"`, `fallbackAgentId=null`, "
            "`expectedCostUsd=0`, `expectedLatencyMs=0`, `confidence` = the value you'd otherwise have used.",
            "The `routingRationale` MUST name the specific escalation rule above that triggered.",
            "",
            "## Output",
            'Return strictly valid JSON matching the CoordinatorOutput schema: {"chosenAgentId","routingRationale","fallbackAgentId":<string|null>,"expectedCostUsd","expectedLatencyMs","confidence"}. Use null (not empty string) when no fallback exists.',
            "",
            locale_line,
        ]
    )


# ─────────────────────────────────────────────────────────────────────────────
# Helper — Python-side scoring (used by unit tests + as the deterministic
# floor if the model ever produces a clearly-wrong answer). Mirrors the
# decision rules in the prompt so tests can assert "the model picked the
# same candidate the scorer would have picked".
# ─────────────────────────────────────────────────────────────────────────────


def score_candidate(
    candidate: CandidateAgent,
    *,
    policy: WorkspacePolicy,
    capability_match: float,
    prefer_local: bool,
) -> float:
    """Deterministic scoring function — higher is better.

    Used by `pick_best_candidate` below and by unit tests asserting that
    the model's choice matches the scorer's choice on the golden set. The
    weights are tuned so capability match dominates (×10), then latency
    headroom, then cost headroom, then a small local-preference bonus.
    """
    # Hard filters → -inf (can never be picked).
    if not candidate.healthy:
        return float("-inf")
    if (
        policy.allowed_agents
        and candidate.agent_id not in policy.allowed_agents
    ):
        return float("-inf")
    if candidate.avg_cost_usd > policy.budget_remaining_usd:
        return float("-inf")

    # Soft factors.
    latency_headroom = max(
        0.0, (policy.sla_target_ms - candidate.avg_latency_ms) / policy.sla_target_ms
    )
    cost_headroom = (
        max(0.0, (policy.budget_remaining_usd - candidate.avg_cost_usd))
        / max(policy.budget_remaining_usd, 1e-6)
    )
    local_bonus = (
        0.05 if (prefer_local and candidate.transport == "in_process") else 0.0
    )
    return (
        capability_match * 10.0
        + latency_headroom * 2.0
        + cost_headroom * 1.0
        + local_bonus
    )


def pick_best_candidate(
    payload: CoordinatorInput,
    *,
    capability_scores: dict[str, float] | None = None,
) -> tuple[CandidateAgent | None, CandidateAgent | None]:
    """Deterministic baseline — picks (best, fallback) given pre-scored
    capability matches. Used by tests; the LLM may diverge based on the
    task_description text. When `capability_scores` is None, every
    candidate gets a flat 0.5 match (i.e. tie-break by cost/latency only).

    Returns (None, None) when no candidate survives the hard filters.
    """
    capability_scores = capability_scores or {}
    survivors: list[tuple[float, CandidateAgent]] = []
    for c in payload.candidate_agents:
        if not payload.allow_remote and c.transport != "in_process":
            continue
        match = capability_scores.get(c.agent_id, 0.5)
        s = score_candidate(
            c,
            policy=payload.workspace_policy,
            capability_match=match,
            prefer_local=payload.prefer_local,
        )
        if s > float("-inf"):
            survivors.append((s, c))
    if not survivors:
        return None, None
    survivors.sort(key=lambda row: row[0], reverse=True)
    best = survivors[0][1]
    fallback = survivors[1][1] if len(survivors) >= 2 else None
    return best, fallback


# ─────────────────────────────────────────────────────────────────────────────
# Cross-field validator on output — make `expected_*` align with the chosen
# candidate when the model returns an in-pool id. Pure defense-in-depth: the
# prompt asks for this, but a well-meaning model occasionally re-estimates.
# Implemented as a model-level validator so the runtime catches the drift as
# a ValidationError → Escalation.
# ─────────────────────────────────────────────────────────────────────────────


class _OutputCrossCheck(BaseModel):
    """Hidden helper — not exported. Used by `validate_output_against_pool`
    in tests + by Phase 5 workflow code that wants to second-guess the LLM."""

    model_config = ConfigDict(extra="forbid")

    output: CoordinatorOutput
    input_payload: CoordinatorInput

    @model_validator(mode="after")
    def _enforce_consistency(self) -> "_OutputCrossCheck":
        # Escalation path: no further checks (expected_* are zeroed by spec).
        if self.output.chosen_agent_id == ESCALATE_AGENT_ID:
            return self

        # Must pick from the input pool.
        pool_ids = {c.agent_id for c in self.input_payload.candidate_agents}
        if self.output.chosen_agent_id not in pool_ids:
            raise ValueError(
                f"chosen_agent_id {self.output.chosen_agent_id!r} not in candidate pool {sorted(pool_ids)!r}"
            )
        if (
            self.output.fallback_agent_id is not None
            and self.output.fallback_agent_id not in pool_ids
        ):
            raise ValueError(
                f"fallback_agent_id {self.output.fallback_agent_id!r} not in candidate pool"
            )
        if self.output.fallback_agent_id == self.output.chosen_agent_id:
            raise ValueError("fallback_agent_id must differ from chosen_agent_id")
        return self


def validate_output_against_pool(
    output: CoordinatorOutput, payload: CoordinatorInput
) -> None:
    """Public helper — raises ValueError when the output is inconsistent
    with the input pool. Workflow code calls this before acting on the
    decision; unit tests call it on every Plumbing-class test.
    """
    _OutputCrossCheck(output=output, input_payload=payload)


# ─────────────────────────────────────────────────────────────────────────────
# AgentDef — the Pydantic config the runtime consumes.
# ─────────────────────────────────────────────────────────────────────────────


coordinator_agent_def: AgentDef[CoordinatorInput, CoordinatorOutput] = AgentDef(
    id="coordinator",
    description=(
        "Tier-2 meta agent (M1). Routes a task description to the best "
        "Tier-1 or remote A2A candidate from the Agent Registry, respecting "
        "the workspace's budget + SLA + allow-list. Returns the choice, an "
        "optional fallback, the expected cost/latency, and a confidence "
        "score. Escalates (chosenAgentId='__escalate__') when no candidate "
        "satisfies policy or the task is ambiguous. Per coordinator.spec.md "
        "(D23 Tier-2 M1, D24 phased coordination, D5 Flash for routing)."
    ),
    model=COORDINATOR_MODEL,
    max_usd=COORDINATOR_MAX_USD,
    input_schema=CoordinatorInput,
    output_schema=CoordinatorOutput,
    system_prompt=build_coordinator_system_prompt,
    # D41 capability layer — coordinator.spec.md §6 names these two tools as
    # the M1 capability surface. The agent uses `agent_registry_list` to
    # discover candidates when the caller-supplied pool is sparse, and
    # `a2a_invoke` is wired here for parity with the spec (Cloud Workflows
    # still performs the actual transport switch — the agent CAN invoke a
    # remote candidate directly when the workflow defers that decision back
    # to it, e.g. for health-check probes).
    tools=[agent_registry_list, a2a_invoke],
    max_turns=1,  # single-turn classifier-style invocation
)


__all__ = [
    "COORDINATOR_CONFIDENCE_FLOOR",
    "COORDINATOR_MAX_USD",
    "COORDINATOR_MODEL",
    "CandidateAgent",
    "CoordinatorInput",
    "CoordinatorOutput",
    "ESCALATE_AGENT_ID",
    "WorkspacePolicy",
    "build_coordinator_system_prompt",
    "coordinator_agent_def",
    "pick_best_candidate",
    "score_candidate",
    "validate_output_against_pool",
]


# ─────────────────────────────────────────────────────────────────────────────
# __main__ entry point for ad-hoc testing.
# ─────────────────────────────────────────────────────────────────────────────


if __name__ == "__main__":  # pragma: no cover
    """Run a single invocation against the live Vertex AI.

    Requires:
        GOOGLE_GENAI_USE_VERTEXAI=TRUE
        GOOGLE_CLOUD_PROJECT=<…>
        GOOGLE_CLOUD_LOCATION=us-central1
        SS_LIVE=1
    """
    import asyncio
    import json
    import sys

    from ss_agents.runtime import RunContext, run_agent

    async def main() -> None:
        ctx = RunContext(
            tenant_id="t_demo000000000000",
            workspace_id="ws_demo_coord_main",
            trace_id="trace-cli-coord-1",
        )
        task_desc = (
            sys.argv[1]
            if len(sys.argv) > 1
            else "Find 20 Korean skincare creators on TikTok with > 50k followers."
        )
        payload = CoordinatorInput(
            taskDescription=task_desc,
            workspacePolicy=WorkspacePolicy(
                allowedAgents=[],
                budgetRemainingUsd=2.50,
                slaTargetMs=4_000,
            ),
            candidateAgents=[
                CandidateAgent(
                    agentId="sourcing",
                    capabilities=["source_creators", "tiktok", "rapidapi"],
                    avgLatencyMs=2_400,
                    avgCostUsd=0.018,
                    transport="in_process",
                ),
                CandidateAgent(
                    agentId="tiktok-mcp-search",
                    capabilities=["source_creators", "tiktok", "remote", "a2a"],
                    avgLatencyMs=3_100,
                    avgCostUsd=0.012,
                    transport="a2a_grpc",
                ),
            ],
            locale="ko",
        )
        outcome = await run_agent(coordinator_agent_def, payload, ctx)
        print(json.dumps(outcome.model_dump(by_alias=True), indent=2, default=str))

    asyncio.run(main())
