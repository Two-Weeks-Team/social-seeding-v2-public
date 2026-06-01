"""Vetting agent — Phase 3 agent #5 (Tier-1 #2).

Per-creator fit scoring with parallel-friendly `vet_creator()` callable. The
brand-campaign workflow fans this out one Pub/Sub message per candidate (D18
+ D24); each invocation scores ONE creator. The N-way fan-out lives in the
workflow layer (TF-8 integration module) — the agent itself is single-input.

Direct port of v2's `packages/agents/src/vetting.agent.ts:16-40` onto ADK +
Gemini 3.5 Flash + Pydantic, following the contract in
`gcp-research/specs/tier1/vetting.spec.md`.

Citations:
    D5  — Gemini 3.5 Flash for judgment-grade scoring.
    D17 — Vertex AI Agent Runtime (parallel fan-out).
    D23 — Tier-1 agent #2 (high-volume role).
    D24 — Parallel fan-out is the canonical 1→100 example.
    ARCHITECTURE.md §3 row 2:
        vetting | 1 | Gemini 3.5 Flash (parallel) | rapidapi.get_user_info,
        ranking.score, vector_search.brand_fit | Session | tool_trajectory_avg_score
    v2 reference: packages/agents/src/vetting.agent.ts — schema mirrored, model
    upgraded Haiku → Gemini 3.5 Flash per D5.
"""
from __future__ import annotations

import datetime as dt
import logging
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ss_agents.agents.intake import CampaignBrief
from ss_agents.runtime import AgentDef, AgentOutcome, RunContext, run_agent
from ss_agents.tools.ranking_score import ranking_score
from ss_agents.tools.rapidapi_get_user_info import rapidapi_get_user_info

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic mirrors of @ss/contracts (TikTokCreator, Candidate, VettingFlag).
# Manually ported from packages/contracts/src/creator.ts:7-43. Phase 3+ will
# codegen these from packages/contracts via the SDD pipeline (D36).
# ─────────────────────────────────────────────────────────────────────────────


# Per vetting.spec.md §2 + creator.ts:40 — the six spec-defined flag codes.
# Per task brief — three additional hard-fail codes that gate recommended_action.
VettingFlag = Literal[
    # spec-defined (vetting.spec.md §2)
    "below_engagement_floor",
    "blacklisted",
    "wrong_language",
    "brand_unsafe",
    "prior_flake",
    "data_stale",
    # task-brief hard-fail codes (drop / manual_review gate)
    "banned_words",
    "blacklist_match",
    "bot_account",
]

# Hard-fail codes from the task brief: presence of ANY of these forces
# recommended_action ∈ {drop, manual_review} regardless of fitScore.
HARD_FAIL_FLAGS: frozenset[str] = frozenset(
    {"banned_words", "blacklist_match", "bot_account", "blacklisted"}
)


class TikTokCreator(BaseModel):
    """Mirrors @ss/contracts TikTokCreatorSchema (creator.ts:7-32).

    Identity + metrics + v2-derived fields + relationship memory.
    """

    model_config = ConfigDict(extra="forbid")

    # identity (v1 parity)
    id: str = Field(min_length=1)
    """TikTok unique numeric id."""
    unique_id: str = Field(min_length=1, alias="uniqueId")
    """@handle."""
    nickname: str = Field(min_length=0, max_length=200)
    signature: str = Field(default="", max_length=4000)
    avatar_thumb: str | None = Field(default=None, alias="avatarThumb")
    avatar_larger: str | None = Field(default=None, alias="avatarLarger")
    verified: bool = False
    private_account: bool = Field(default=False, alias="privateAccount")
    # metrics (v1 parity)
    follower_count: int = Field(ge=0, alias="followerCount")
    following_count: int = Field(ge=0, alias="followingCount")
    video_count: int = Field(ge=0, alias="videoCount")
    heart_count: int | None = Field(default=None, ge=0, alias="heartCount")
    hashtags: list[str] = Field(default_factory=list, max_length=200)
    # v2-derived
    language: str | None = Field(default=None, min_length=2, max_length=2)
    avg_views: float | None = Field(default=None, ge=0.0, alias="avgViews")
    engagement_rate: float | None = Field(
        default=None, ge=0.0, le=1.0, alias="engagementRate"
    )
    influence_score: float | None = Field(
        default=None, ge=0.0, le=100.0, alias="influenceScore"
    )
    # v2 relationship memory (per workspace) — populated by the vetting agent
    prior_outcome: (
        Literal["responded", "ignored", "declined", "flaked", "delivered", "overperformed"]
        | None
    ) = Field(default=None, alias="priorOutcome")


class CandidateProposal(BaseModel):
    """Sourcing agent's pre-vetting proposal — matches the spec's `Input.candidate`.

    Mirrors `CandidateSchema.omit({ fitScore: true, vettedAt: true })` from
    v2 vetting.agent.ts:24.
    """

    model_config = ConfigDict(extra="forbid")

    creator: TikTokCreator
    match_reasons: list[str] = Field(default_factory=list, alias="matchReasons", max_length=20)
    flags: list[VettingFlag] = Field(default_factory=list, max_length=12)


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output schemas per vetting.spec.md §2 + task-brief deliverable.
# ─────────────────────────────────────────────────────────────────────────────


class VettingInput(BaseModel):
    """Per vetting.spec.md §2 properties.Input.

    The optional `brandEmbedding` is the 768-dim brand embedding the workflow
    pre-computed via gemini-embedding; absent → the agent computes it via the
    embedding tool (escalates `embedding_dim_mismatch` per §8 edge case 6).
    """

    model_config = ConfigDict(extra="forbid")

    brief: CampaignBrief
    candidate: CandidateProposal
    brand_embedding: list[float] | None = Field(
        default=None,
        alias="brandEmbedding",
        description="Optional pre-computed brand embedding (768-dim).",
    )

    @field_validator("brand_embedding")
    @classmethod
    def _validate_embedding_dim(cls, v: list[float] | None) -> list[float] | None:
        if v is not None and len(v) not in (256, 384, 768, 1536):
            # The valid dims match Vertex AI Vector Search index shapes (D16).
            raise ValueError(
                f"brandEmbedding must be 256/384/768/1536 dim; got {len(v)}"
            )
        return v


class VettedCandidate(BaseModel):
    """Per vetting.spec.md §2 #/$defs/Candidate + task-brief `recommended_action`.

    The `matchReasons` field is constrained to 3-7 entries per the task brief
    (each entry is one sentence of rationale — the human-readable trail for
    Mission Control's approval inbox).
    """

    model_config = ConfigDict(extra="forbid")

    creator: TikTokCreator
    fit_score: float = Field(ge=0.0, le=1.0, alias="fitScore")
    flags: list[VettingFlag] = Field(default_factory=list, max_length=12)
    match_reasons: list[str] = Field(
        min_length=3,
        max_length=7,
        alias="matchReasons",
        description="3-7 sentences justifying the fitScore. One reason per item.",
    )
    recommended_action: Literal["shortlist", "drop", "manual_review"] = Field(
        alias="recommendedAction"
    )
    vetted_at: dt.datetime = Field(alias="vettedAt")

    @field_validator("match_reasons")
    @classmethod
    def _non_empty_reasons(cls, v: list[str]) -> list[str]:
        for i, reason in enumerate(v):
            if not reason or not reason.strip():
                raise ValueError(f"matchReasons[{i}] is empty")
            if len(reason) > 1000:
                raise ValueError(f"matchReasons[{i}] exceeds 1000 chars")
        return v


# ─────────────────────────────────────────────────────────────────────────────
# System prompt builder — port of vetting.agent.ts:27-39.
# ─────────────────────────────────────────────────────────────────────────────


def build_vetting_system_prompt(payload: BaseModel) -> str:
    """Per vetting.spec.md §6 procedure + vetting.agent.ts:27-39.

    The procedure mirrors v2's 5-step recipe (blacklist → profile → score →
    decide → flag) and adds two task-brief requirements: matchReasons 3-7
    items and recommended_action ∈ {shortlist, drop, manual_review} gated on
    hard-fail flags.
    """
    assert isinstance(payload, VettingInput), f"unexpected input type: {type(payload)}"
    brief = payload.brief
    candidate = payload.candidate
    creator = candidate.creator
    languages = ",".join(brief.targeting.languages)
    return "\n".join(
        [
            f'You are the Vetting agent. Score creator @{creator.unique_id} for the "{brief.brand_product.name}" ({brief.brand_product.category}) campaign.',
            "",
            "Procedure (5 deterministic steps, then synthesise):",
            '1) Call blacklist.check on the candidate\'s uniqueId. If a hit returns severity="permanent", return immediately with fitScore ≤ 0.1, flags including "blacklist_match" (hard-fail), and recommended_action="drop".',
            "2) Call rapidapi.get_user_info with withRecentPosts=true to load profile + recent posts.",
            "3) Call ranking.score with { creator, recentPosts } from step (2) to compute avgViews / engagementRate / influenceScore.",
            "4) Call vector_search.brand_fit with (brandEmbedding, creatorEmbedding) for semantic similarity. If brandEmbedding is absent in the input, compute it via the embedding tool first.",
            "5) Decide fitScore ∈ [0,1] from: content-topic overlap, audience match, authenticity (penalise engagement-pod / bot patterns).",
            "",
            f"Flag rules — set EACH applicable code from this list:",
            f"  · below_engagement_floor — engagementRate < {brief.targeting.min_engagement_rate}",
            # Bracket set-notation (not braces): ADK's LlmAgent.instruction does
            # `{var}` session-state injection, so a literal `{ko}` in the prompt
            # is read as a state key and raises "Context variable not found".
            f"  · wrong_language — creator language ∉ [{languages}]",
            "  · brand_unsafe — bio/captions show competing brands, unsafe content, or political extremes",
            "  · prior_flake — creator.priorOutcome == 'flaked' (fitScore must be ≤ 0.4 regardless)",
            "  · data_stale — profile data > 30 days old OR (signature empty AND no recent posts)",
            "  · banned_words — bio/captions contain banned terms (workspace policy)",
            "  · blacklist_match — step (1) returned permanent hit",
            "  · bot_account — engagement-pod / scripted-comment / video-loop patterns",
            "",
            "Recommended_action gate:",
            "  · If ANY of {banned_words, blacklist_match, bot_account, blacklisted} → recommended_action='drop'.",
            "  · Else if fitScore < 0.45 OR any 2+ flags from {below_engagement_floor, wrong_language, brand_unsafe, prior_flake, data_stale} → 'manual_review'.",
            "  · Else → 'shortlist'.",
            "",
            "Output:",
            "  · Return the candidate exactly as given, with fitScore (0-1), flags (union of input flags + ones you set), matchReasons (3-7 short sentences — each one a distinct reason), recommended_action, and vettedAt = the current ISO-8601 timestamp.",
            "  · Bias: be conservative. A false 'great fit' wastes a sample; a false 'drop' is recoverable via manual_review.",
        ]
    )


# ─────────────────────────────────────────────────────────────────────────────
# AgentDef — the Pydantic config the runtime consumes.
# ─────────────────────────────────────────────────────────────────────────────


# Task brief: USD cap $0.03 per vetting call (10 vetting calls = $0.30 demo).
# vetting.spec.md §6 cites $0.10/candidate (50-candidate × $0.10 = $5); the
# task brief tightens that to $0.03/candidate for demo cost control. Tighter
# wins (RULES.md "Conflict Resolution Hierarchy: Safety First / Quality > Speed").
VETTING_MAX_USD: float = 0.03


vetting_agent_def: AgentDef[VettingInput, VettedCandidate] = AgentDef(
    id="vetting",
    description=(
        "Score one TikTok creator against a campaign brief. Returns a "
        "VettedCandidate with fitScore (0-1), risk flags, 3-7 matchReasons, "
        "and a recommended_action (shortlist | drop | manual_review). "
        "Per vetting.spec.md (D23 Tier-1 agent #2). Designed for N-way "
        "Pub/Sub fan-out at the workflow layer (D18 + D24)."
    ),
    model="gemini-3.5-flash",  # D53 — judgment role.
    max_usd=VETTING_MAX_USD,
    input_schema=VettingInput,
    output_schema=VettedCandidate,
    system_prompt=build_vetting_system_prompt,
    # Capability layer (D41 / W2-A2): RapidAPI profile fetch + ranking math.
    # `vector_search.brand_fit` and `blacklist.check` ship in later W2-A* slices.
    tools=[rapidapi_get_user_info, ranking_score],
    max_turns=6,  # Procedure is 5 tool calls + 1 synthesis turn.
)


# ─────────────────────────────────────────────────────────────────────────────
# Parallel-friendly per-candidate callable. The workflow layer (Cloud
# Workflows + Pub/Sub fan-out, TF-8 integration module) invokes this once
# per candidate. The function itself is a thin wrapper that builds the
# input, calls run_agent, and propagates the AgentOutcome unchanged.
# ─────────────────────────────────────────────────────────────────────────────


async def vet_creator(
    *,
    brief: CampaignBrief,
    candidate: CandidateProposal,
    ctx: RunContext,
    brand_embedding: list[float] | None = None,
) -> AgentOutcome:
    """Vet ONE creator. Returns the typed AgentOutcome envelope.

    This is the function the workflow's Pub/Sub subscriber calls. Concurrency
    is owned by the workflow (one message per candidate, N pull workers); this
    function is safe to invoke from any number of coroutines in parallel.

    Args:
        brief: The CampaignBrief from intake.
        candidate: One CandidateProposal from the sourcing agent.
        ctx: Per-invocation RunContext (tenant, workspace, trace, budget).
        brand_embedding: Optional pre-computed 768-dim brand embedding. When
            None, the agent will compute it via the embedding tool.

    Returns:
        OutcomeOk[VettedCandidate] on success.
        Escalation when any escalation condition trips (see vetting.spec.md §6
        and runtime.run_agent docstring).

    Never raises — all errors are converted to Escalation by run_agent. The
    caller (workflow) inspects `outcome.kind` to decide downstream routing.
    """
    payload = VettingInput(
        brief=brief,
        candidate=candidate,
        brandEmbedding=brand_embedding,
    )
    outcome = await run_agent(vetting_agent_def, payload, ctx)
    logger.info(
        "vet_creator_completed",
        extra={
            "agent_id": vetting_agent_def.id,
            "trace_id": ctx.trace_id,
            "tenant_id": ctx.tenant_id,
            "campaign_id": ctx.campaign_id,
            "creator_unique_id": candidate.creator.unique_id,
            "outcome_kind": outcome.kind,
            "usd_spent": outcome.usd_spent,
        },
    )
    return outcome


# ─────────────────────────────────────────────────────────────────────────────
# __main__ entry point for ad-hoc testing.
# ─────────────────────────────────────────────────────────────────────────────


if __name__ == "__main__":  # pragma: no cover
    """Run a single vetting invocation against the live Vertex AI.

    Requires: GOOGLE_GENAI_USE_VERTEXAI=TRUE, GOOGLE_CLOUD_PROJECT,
              GOOGLE_CLOUD_LOCATION=us-central1, SS_LIVE=1.
    """
    import asyncio
    import json

    from ss_agents.agents.intake import (
        BrandProduct,
        Goals,
        Logistics,
        Targeting,
    )

    async def main() -> None:
        brief = CampaignBrief(
            workspaceId="ws_demo_vetting_main",
            createdBy="cli@example.com",
            brandProduct=BrandProduct(
                name="Freshly Vitamin C Serum",
                category="skincare/serum",
                description="Brightening Vitamin C serum.",
            ),
            targeting=Targeting(creatorCount=20, languages=["ko"]),
            logistics=Logistics(),
            goals=Goals(
                targetLivePosts=15,
                deadline=dt.datetime(2026, 6, 30, 23, 59, tzinfo=dt.UTC),
            ),
        )
        candidate = CandidateProposal(
            creator=TikTokCreator(
                id="123456789",
                uniqueId="beautyguru_kr",
                nickname="K-Beauty Guru",
                followerCount=82_000,
                followingCount=312,
                videoCount=412,
                language="ko",
                engagementRate=0.041,
            ),
            matchReasons=["Korean skincare niche", "82k engaged followers"],
        )
        ctx = RunContext(
            tenant_id="t_demo000000000000",
            workspace_id="ws_demo_vetting_main",
            trace_id="trace-cli-vetting-1",
            campaign_id="c_demo_001",
        )
        outcome = await vet_creator(brief=brief, candidate=candidate, ctx=ctx)
        print(json.dumps(outcome.model_dump(by_alias=True), indent=2, default=str))

    asyncio.run(main())


__all__ = [
    "CandidateProposal",
    "HARD_FAIL_FLAGS",
    "TikTokCreator",
    "VETTING_MAX_USD",
    "VettedCandidate",
    "VettingFlag",
    "VettingInput",
    "build_vetting_system_prompt",
    "vet_creator",
    "vetting_agent_def",
]
