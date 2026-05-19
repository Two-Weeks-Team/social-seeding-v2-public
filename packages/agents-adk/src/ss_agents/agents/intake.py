"""Intake agent — Phase 2's working agent.

Direct port of v2's `packages/agents/src/intake.agent.ts:23-57` onto ADK +
Gemini 2.5 Flash + Pydantic, following the contract in
`gcp-research/specs/tier1/intake.spec.md`.

Behavior (intake.spec.md §1):
    Bounded conversational agent. Each invocation is ONE deliberation step.
    The caller (Mission Control's SSE route) maintains conversation history
    and re-invokes after each user reply until status === "done".

Citations:
    D5  — Gemini 2.5 Flash (short conversational turn).
    D23 — Tier-1 agent #10.
    D34 — Operates in operator's locale (ko/en/ja/zh-CN).
    ARCHITECTURE.md §3 row 10:
        intake | 1 | Gemini 2.5 Flash | forms.upsert | Session | task_completion
"""
from __future__ import annotations

import datetime as dt
import logging
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ss_agents.config import DEFAULT_INTAKE_MODEL
from ss_agents.runtime import AgentDef

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic mirrors of @ss/contracts (CampaignBrief) — manually ported for now.
# Phase 3 will codegen these from packages/contracts via the SDD pipeline (D36).
# ─────────────────────────────────────────────────────────────────────────────


class BrandProduct(BaseModel):
    """Mirrors @ss/contracts CampaignBriefSchema.brandProduct
    (packages/contracts/src/campaign.ts:10-16)."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=120)
    """e.g. 'skincare/serum'."""
    description: str = Field(min_length=1, max_length=2000)
    landing_url: str | None = Field(default=None, alias="landingUrl")
    key_claims: list[str] = Field(default_factory=list, alias="keyClaims", max_length=20)


class Targeting(BaseModel):
    """Mirrors @ss/contracts CampaignBriefSchema.targeting (campaign.ts:17-24)."""

    model_config = ConfigDict(extra="forbid")

    creator_count: int = Field(gt=0, le=1000, alias="creatorCount")
    follower_range: tuple[int, int] | None = Field(default=None, alias="followerRange")
    min_engagement_rate: float = Field(default=0.02, ge=0.0, le=1.0, alias="minEngagementRate")
    languages: list[str] = Field(default_factory=lambda: ["ko"], max_length=4)
    hashtags: list[str] = Field(default_factory=list, max_length=50)
    exclude_blacklist: bool = Field(default=True, alias="excludeBlacklist")

    @field_validator("languages")
    @classmethod
    def _two_letter_codes(cls, v: list[str]) -> list[str]:
        for code in v:
            if len(code) != 2:
                raise ValueError(f"language code must be 2 letters, got {code!r}")
        return v


class Logistics(BaseModel):
    """Mirrors @ss/contracts CampaignBriefSchema.logistics (campaign.ts:25-28)."""

    model_config = ConfigDict(extra="forbid")

    ships_samples: bool = Field(default=True, alias="shipsSamples")
    sample_sku: str | None = Field(default=None, alias="sampleSku")


class Goals(BaseModel):
    """Mirrors @ss/contracts CampaignBriefSchema.goals (campaign.ts:29-33)."""

    model_config = ConfigDict(extra="forbid")

    target_live_posts: int = Field(gt=0, le=10_000, alias="targetLivePosts")
    deadline: dt.datetime
    budget_usd: float | None = Field(default=None, ge=0.0, alias="budgetUsd")


class CampaignBrief(BaseModel):
    """Mirrors @ss/contracts CampaignBriefSchema (campaign.ts:7-35).

    The "done" output payload — what gets persisted to Spanner v2_briefs and
    handed to the brand-campaign workflow.
    """

    model_config = ConfigDict(extra="forbid")

    workspace_id: str = Field(min_length=1, alias="workspaceId")
    created_by: str = Field(min_length=1, alias="createdBy")
    brand_product: BrandProduct = Field(alias="brandProduct")
    targeting: Targeting
    logistics: Logistics
    goals: Goals


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output schemas per intake.spec.md §2 + §6.
# ─────────────────────────────────────────────────────────────────────────────


class IntakeMessage(BaseModel):
    """One conversation message. Mirrors intake.spec.md §2 #/$defs/IntakeMessage."""

    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=10_000)


class IntakeInput(BaseModel):
    """Per intake.spec.md §2 properties.Input."""

    model_config = ConfigDict(extra="forbid")

    messages: list[IntakeMessage] = Field(min_length=1, max_length=20)
    workspace_id: str = Field(min_length=1, alias="workspaceId")
    created_by: str = Field(min_length=1, alias="createdBy")
    locale: Literal["ko", "en", "ja", "zh-CN"] = "ko"


class AskingOutput(BaseModel):
    """Per intake.spec.md §6. Returned when the agent needs more info."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["asking"]
    question: str = Field(min_length=1, max_length=400)
    field_focus: (
        Literal["brandProduct", "targeting", "logistics", "goals", "clarification"]
        | None
    ) = Field(default=None, alias="fieldFocus")


class DoneOutput(BaseModel):
    """Per intake.spec.md §6. Returned when the brief is complete + validated."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["done"]
    brief: CampaignBrief


# Discriminated union — `status` field is the discriminator. The runtime's
# generic O TypeVar accepts this directly (Pydantic resolves the union).
IntakeOutput = Annotated[
    Union[AskingOutput, DoneOutput],  # noqa: UP007 — Pydantic prefers Union
    Field(discriminator="status"),
]


class IntakeOutputWrapper(BaseModel):
    """Wrapper required because `AgentDef.output_schema` expects a concrete
    Pydantic class — Annotated unions cannot be passed directly. The wrapper
    exposes the same shape via a single `result` field that Gemini fills in
    against the discriminated union.

    Phase 3 may swap this for `LlmAgent(output_schema=DoneOutput | AskingOutput)`
    once we confirm Vertex AI's responseSchema supports top-level oneOf
    (currently it requires a top-level object — hence this wrapper)."""

    model_config = ConfigDict(extra="forbid")

    # The discriminator is already baked into IntakeOutput via Annotated[...]
    # — no need to re-declare here.
    result: IntakeOutput


# ─────────────────────────────────────────────────────────────────────────────
# System prompt builder — port of intake.agent.ts:39-57.
# ─────────────────────────────────────────────────────────────────────────────


_LOCALE_SUFFIX = {
    "ko": "Respond in 한국어. Keep questions ≤ 2 sentences.",
    "en": "Respond in English. Keep questions ≤ 2 sentences.",
    "ja": "Respond in 日本語. Keep questions ≤ 2 sentences.",
    "zh-CN": "Respond in 简体中文. Keep questions ≤ 2 sentences.",
}


def build_intake_system_prompt(payload: BaseModel) -> str:
    """Per intake.spec.md §6 + intake.agent.ts:39-57.

    Mirrors the v2 prompt nearly verbatim with one addition: a locale-specific
    suffix per D34 (the v2 prompt let Claude infer from the user's last
    message, which worked but was inconsistent across the 4 supported
    locales — Gemini benefits from an explicit hint).
    """
    assert isinstance(payload, IntakeInput), f"unexpected input type: {type(payload)}"
    turn_count = max(1, len(payload.messages))
    locale_line = _LOCALE_SUFFIX.get(payload.locale, _LOCALE_SUFFIX["ko"])
    return "\n".join(
        [
            "You are the campaign intake agent for Social Seeding, an agent-orchestrated TikTok seeding operator. Your only job is to assemble a CampaignBrief from a short conversation with the user.",
            "",
            "A CampaignBrief has these required fields:",
            "  · brandProduct: { name, category (e.g. 'skincare/serum'), description, keyClaims[] (optional) }",
            "  · targeting: { creatorCount (int>0), followerRange[min,max] (optional), minEngagementRate (0-1, default 0.02), languages (ISO-639-1, default ['ko']), hashtags[] (optional) }",
            "  · logistics: { shipsSamples (bool) }",
            "  · goals: { targetLivePosts (int>0), deadline (ISO date), budgetUsd (optional) }",
            f'  · workspaceId = "{payload.workspace_id}", createdBy = "{payload.created_by}" '
            "(the caller pre-fills these — include them as-is in the brief).",
            "",
            "Procedure (one decision per invocation — the caller re-invokes you after each user reply):",
            '1) Read the conversation so far. Identify the most important field still missing or ambiguous.',
            '2) If you have enough to produce a valid CampaignBrief (every required field filled with a reasonable value), respond with {"result": {"status":"done", "brief":{…full brief…}}}.',
            '3) Otherwise respond with {"result": {"status":"asking", "question":"…", "fieldFocus":"…"}} — ONE focused question, in the user\'s language, ≤2 sentences. Don\'t restate what the user already said.',
            f'4) If after {turn_count} turn(s) the answers contradict each other or you genuinely can\'t produce a valid brief, return {{"result":{{"status":"asking", "question":"<reason as a question>", "fieldFocus":"clarification"}}}} — the workflow will escalate from there.',
            "",
            "Bias: ship the brief as soon as it's complete enough. Don't ask about budget unless the user volunteers it (defaults exist downstream). Don't ask about creatorCount more than once.",
            "",
            locale_line,
        ]
    )


# ─────────────────────────────────────────────────────────────────────────────
# AgentDef — the Pydantic config the runtime consumes.
# ─────────────────────────────────────────────────────────────────────────────

# `forms_upsert` is imported here (rather than at the top of the module) to
# break a load-order cycle: `ss_agents.tools.forms_upsert` consumes the
# `CampaignBrief` type defined above. Importing it after the class definitions
# is intentional and load-safe.
from ss_agents.tools.forms_upsert import forms_upsert  # noqa: E402

intake_agent_def: AgentDef[IntakeInput, IntakeOutputWrapper] = AgentDef(
    id="intake",
    description=(
        "Conversational agent that assembles a CampaignBrief from a short "
        "operator conversation. Returns {status:'asking', question} on each "
        "turn until enough information is collected to return {status:'done', "
        "brief: CampaignBrief}. Per intake.spec.md (D23 Tier-1 agent #10)."
    ),
    model=DEFAULT_INTAKE_MODEL,
    max_usd=0.20,  # intake.spec.md §6: $0.20 across the full conversation
    input_schema=IntakeInput,
    output_schema=IntakeOutputWrapper,
    system_prompt=build_intake_system_prompt,
    # `forms_upsert` is invoked ONLY on the agent's final "done" turn to
    # persist the assembled CampaignBrief to v2_briefs (Spanner per D15;
    # capability layer per D41 via intake.spec.md §6 `forms.upsert`). The
    # earlier "asking" turns are pure conversation — they do not invoke this
    # tool. intake.agent.ts:25 originally had `tools: []` because v1 used a
    # separate workflow step to persist; D41's stub/live seam lets the agent
    # own the write directly without coupling to live infra in dev/CI.
    tools=[forms_upsert],
    max_turns=6,  # intake.spec.md §6: escalates "after 6 turns the brief is still incomplete"
)


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
            workspace_id="ws_demo_intake_main",
            trace_id="trace-cli-1",
        )
        user_text = (
            sys.argv[1]
            if len(sys.argv) > 1
            else "Run a Korean skincare campaign with 20 creators."
        )
        payload = IntakeInput(
            messages=[IntakeMessage(role="user", content=user_text)],
            workspaceId="ws_demo_intake_main",
            createdBy="cli@example.com",
            locale="ko",
        )
        outcome = await run_agent(intake_agent_def, payload, ctx)
        print(json.dumps(outcome.model_dump(by_alias=True), indent=2, default=str))

    asyncio.run(main())
