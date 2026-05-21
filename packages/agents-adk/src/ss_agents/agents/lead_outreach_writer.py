"""Lead Outreach Writer agent — Tier-1 agent #11.

B2B sibling of `conversation_responder` (agent #5) and `outreach_writer`
(agent #3). Drafts ONE cold-sales email from a `LeadCampaignBrief` +
`LeadResearch` summary (output of the research agent #9). The shared
`OutreachDraft`-shaped output flows downstream to `gmail.send` and the
conversation classifier exactly like the brand-side writer's draft —
which is the whole point of the same-shape contract.

Why a separate agent (vs. reusing the brand writer):
    · Tone leans **sales-to-business-decision-maker**, not "inviting a
      creator to a free sample." The system prompt enforces this register.
    · No TikTok-creator context (`facts.creator`); grounded facts come
      from the research agent (P5-C2) which already distilled them.
    · No tournament. Phase-3 brief: simpler than `outreach_writer`. We
      self-judge spam + deliverability + ICP-fit in-prompt and escalate
      on threshold rather than re-judging with deterministic judges.

Spec deviations recorded by the Phase-3 brief (brief wins over spec):
    · Output `tone` enum = `formal | consultative | direct` (B2B register),
      not the responder's `formal | warm | urgent`.
    · Output adds `suggested_next_step` (B2B CTA hint for the operator).
    · USD cap = $0.05 (brief), not spec's $1.20 — the Phase-3 brief
      tightens the cap because we removed the 4-judge tournament pass.
    · `ICP fit < 0.5` is an escalation condition. This maps to
      `research.confidence < 50` for the in-prompt heuristic (the lead's
      research confidence is the closest proxy for ICP fit until the
      `crm.enrich` capability lands in Phase 4 — at which point an
      explicit `icpFitScore` becomes a first-class input field).

Citations:
    D5  — Gemini 3.1 Pro (judgment-heavy creative drafting; B2B copy
          benefits from the Pro tier vs Flash even at the higher cost).
    D17 — Vertex AI Agent Runtime.
    D23 — Tier-1 agent #11.
    D27 — When a sales-priced tier is proposed in the draft, the
          downstream workflow mints an AP2 Intent Mandate; the writer
          itself does NOT touch payment surfaces (separation of duties).
    D34 — Drafts in the lead's locale (ko/en/ja/zh-CN); JP recipients
          default to formal register per spec §8 edge case 6.
    ARCHITECTURE.md §3 row 11:
        lead_outreach_writer | 1 | Gemini 3.1 Pro | templates.list,
                              outreach.render, crm.enrich | Memory Bank |
                              response_match_v2
"""
from __future__ import annotations

import datetime as dt
import logging
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ss_agents.runtime import AgentDef
from ss_agents.tools.crm_enrich import crm_enrich

logger = logging.getLogger(__name__)


# Gemini 3.1 Pro per DECISIONS.md D53 / ARCHITECTURE.md §3 row 11.
LEAD_OUTREACH_WRITER_MODEL = "gemini-3.1-pro"

# B2B tone enum — distinct from the responder's `warm/urgent/formal`. The
# brief calls these out explicitly. `formal` for JP/regulated industries,
# `consultative` for default mid-market SaaS pitch, `direct` for high-
# confidence ICP fits where the lead already shows buying-signal.
LeadOutreachTone = Literal["formal", "consultative", "direct"]

# The 5 angle archetypes inherited from the brand-side writer's
# `OutreachDraft.angle` enum. Carried verbatim so the conversation
# classifier sees a stable surface across both writers.
LeadOutreachAngle = Literal[
    "data_specific",   # cite a concrete metric the lead would care about
    "pain_killer",     # name the pain we relieve
    "mutual_benefit",  # frame as exchange of value
    "authority",       # lean on social proof / credentialed customer base
    "directness",      # short + blunt; works for warm leads only
]

Locale = Literal["ko", "en", "ja", "zh-CN"]


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic mirrors of @ss/contracts (LeadCampaignBrief + LeadResearch + Lead).
# Manually ported — Phase 3 will codegen these from packages/contracts via SDD.
# ─────────────────────────────────────────────────────────────────────────────


class OurProduct(BaseModel):
    """Mirrors @ss/contracts LeadCampaignBriefSchema.ourProduct (lead.ts:132-137)."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    pitch_summary: str = Field(min_length=10, max_length=600, alias="pitchSummary")
    key_claims: list[str] = Field(
        default_factory=list, alias="keyClaims", max_length=20
    )


class LeadTargeting(BaseModel):
    """Mirrors @ss/contracts LeadCampaignBriefSchema.targeting (lead.ts:138-145)."""

    model_config = ConfigDict(extra="forbid")

    countries: list[str] = Field(default_factory=lambda: ["KR"], max_length=20)
    categories: list[str] = Field(default_factory=list, max_length=20)
    exclude_blacklist: bool = Field(default=True, alias="excludeBlacklist")

    @field_validator("countries")
    @classmethod
    def _two_letter_country_codes(cls, v: list[str]) -> list[str]:
        for code in v:
            if len(code) != 2:
                raise ValueError(f"country code must be 2 letters, got {code!r}")
        return v


class LeadOutreachConfig(BaseModel):
    """Mirrors @ss/contracts LeadCampaignBriefSchema.outreach (lead.ts:146-151)."""

    model_config = ConfigDict(extra="forbid")

    max_sends_per_batch: int = Field(default=20, gt=0, le=10_000, alias="maxSendsPerBatch")
    tone_notes: str = Field(default="", alias="toneNotes", max_length=2000)


class LeadGoals(BaseModel):
    """Mirrors @ss/contracts LeadCampaignBriefSchema.goals (lead.ts:152-157)."""

    model_config = ConfigDict(extra="forbid")

    target_replies: int = Field(gt=0, le=10_000, alias="targetReplies")
    deadline: dt.datetime
    budget_usd: float | None = Field(default=None, ge=0.0, alias="budgetUsd")


class LeadCampaignBrief(BaseModel):
    """Mirrors @ss/contracts LeadCampaignBriefSchema (lead.ts:127-159).

    The operator's intent for one B2B campaign. The writer reads
    `our_product` + `outreach.tone_notes` to shape the draft; targeting and
    goals are informational (the workflow filters leads upstream)."""

    model_config = ConfigDict(extra="forbid")

    workspace_id: str = Field(min_length=1, alias="workspaceId")
    created_by: str = Field(min_length=1, alias="createdBy")
    name: str = Field(min_length=2, max_length=120)
    our_product: OurProduct = Field(alias="ourProduct")
    targeting: LeadTargeting
    outreach: LeadOutreachConfig
    goals: LeadGoals


class LeadResearch(BaseModel):
    """Mirrors @ss/contracts LeadResearchSchema (lead.ts:76-89).

    Output of the research agent (P5-C2). The writer's single source of
    truth — only facts named here may be cited in the body."""

    model_config = ConfigDict(extra="forbid")

    pitch: str = Field(min_length=20, max_length=800)
    angles: list[str] = Field(min_length=1, max_length=5)
    grounded_facts: list[str] = Field(
        default_factory=list, alias="groundedFacts", max_length=30
    )
    contact_profile: str = Field(default="", alias="contactProfile", max_length=500)
    confidence: float = Field(ge=0.0, le=100.0, default=50.0)
    researched_at: dt.datetime | None = Field(default=None, alias="researchedAt")

    @field_validator("angles")
    @classmethod
    def _angle_item_length(cls, v: list[str]) -> list[str]:
        """Spec §2: angles items minLength 10, maxLength 280."""
        for item in v:
            if len(item) < 10:
                raise ValueError(f"angle too short (<10 chars): {item!r}")
            if len(item) > 280:
                raise ValueError(f"angle too long (>280 chars): {item[:60]!r}")
        return v

    @field_validator("grounded_facts")
    @classmethod
    def _fact_item_length(cls, v: list[str]) -> list[str]:
        """Spec §2: groundedFacts items minLength 5, maxLength 280."""
        for item in v:
            if len(item) < 5:
                raise ValueError(f"grounded fact too short (<5 chars): {item!r}")
            if len(item) > 280:
                raise ValueError(f"grounded fact too long (>280 chars): {item[:60]!r}")
        return v


class LeadContact(BaseModel):
    """Mirrors @ss/contracts LeadSchema-derived contact fields
    (lead-outreach-writer.agent.ts:45-51)."""

    model_config = ConfigDict(extra="forbid")

    company_name: str = Field(min_length=1, max_length=200, alias="companyName")
    company_name_en: str | None = Field(
        default=None, alias="companyNameEn", max_length=200
    )
    country: str = Field(default="KR", min_length=2, max_length=2)
    homepage_url: str | None = Field(default=None, alias="homepageUrl", max_length=2000)
    contact_email: str | None = Field(default=None, alias="contactEmail", max_length=200)


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output schemas per lead_outreach_writer.spec.md §2 + Phase-3 brief.
# ─────────────────────────────────────────────────────────────────────────────


class LeadOutreachWriterInput(BaseModel):
    """Per lead_outreach_writer.spec.md §2 properties.Input.

    `brief` + `research` + `lead` are the three required blocks (spec §2);
    everything else is operator preference. `locale` defaults to lead's
    country-implied locale resolved here — see field validator below."""

    model_config = ConfigDict(extra="forbid")

    brief: LeadCampaignBrief
    research: LeadResearch
    lead: LeadContact
    signature_block: str = Field(default="", alias="signatureBlock", max_length=1000)
    banned_phrases: list[str] = Field(
        default_factory=list, alias="bannedPhrases", max_length=50
    )
    locale: Locale = "ko"


class LeadOutreachWriterOutput(BaseModel):
    """Per Phase-3 brief + lead_outreach_writer.spec.md §6.

    Brief-defined shape (overrides spec §6's `OutreachDraft`-reuse where they
    diverge):
        { subject, body, tone (formal|consultative|direct), spam_score,
          deliverability_score, grounded_facts, suggested_next_step }

    Added back from the spec's OutreachDraft for downstream compatibility:
        - `angle`: which of the 5 angle archetypes the writer picked.
        - `icp_fit_score`: 0-1 self-rated ICP fit (spec §6 escalation
          threshold). When < 0.5 the writer is expected to append
          'LOW_ICP_FIT' to grounded_facts and the runtime escalates.
    """

    model_config = ConfigDict(extra="forbid")

    subject: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=8000)
    tone: LeadOutreachTone = "consultative"
    angle: LeadOutreachAngle = "mutual_benefit"
    spam_score: float = Field(default=0.0, ge=0.0, le=1.0, alias="spamScore")
    """Normalized 0-1. Brief threshold: > 0.4 → escalate."""
    deliverability_score: float = Field(
        default=0.0, ge=0.0, le=1.0, alias="deliverabilityScore"
    )
    """Self-rated SPF/DMARC/spam-trigger heuristics 0-1. ≥ 0.7 = ok."""
    icp_fit_score: float = Field(
        default=0.5, ge=0.0, le=1.0, alias="icpFitScore"
    )
    """Self-rated ICP fit 0-1. Brief threshold: < 0.5 → escalate.
    Default 0.5 = no-opinion (e.g. when research.confidence is borderline)."""
    grounded_facts: list[str] = Field(
        default_factory=list, alias="groundedFacts", max_length=20
    )
    """Each item names a fact the body cites (verbatim or by short
    description). Append 'HALLUCINATION' here to force escalation when the
    writer would otherwise need to invent a fact — per Phase-3 brief
    escalation condition."""
    suggested_next_step: str = Field(
        default="", alias="suggestedNextStep", max_length=400
    )
    """One-line CTA hint for the operator's review. NOT included in the body
    verbatim — the body has its own CTA. This is a Mission-Control-side
    summary so the operator can decide whether to approve send."""


# ─────────────────────────────────────────────────────────────────────────────
# System prompt builder — port of lead-outreach-writer.agent.ts:58-113.
# ─────────────────────────────────────────────────────────────────────────────


_LOCALE_SUFFIX: dict[str, str] = {
    "ko": "Respond in 한국어. B2B 톤 (정중 + 간결).",
    "en": "Respond in English. B2B register (polite, direct, no salesy tropes).",
    "ja": "Respond in 日本語. ビジネス丁寧語 (敬体 + 簡潔)。",
    "zh-CN": "Respond in 简体中文. B2B商务语气 (礼貌、简洁、避免营销腔)。",
}

# Spec §8 edge case 6: JP recipients default to formal regardless of the
# operator's tone_notes. Other countries inherit the consultative default.
_COUNTRY_TONE_DEFAULT: dict[str, LeadOutreachTone] = {
    "JP": "formal",
    "KR": "consultative",
    "US": "consultative",
    "CN": "formal",
}


def build_lead_outreach_writer_system_prompt(payload: BaseModel) -> str:
    """Per lead_outreach_writer.spec.md §6 + lead-outreach-writer.agent.ts:58-113.

    Mirrors the v2 prompt with three additions:
      1. Explicit locale hint (D34).
      2. Country-aware tone default (spec §8 edge case 6: JP → formal).
      3. ICP-fit + spam + deliverability + suggested_next_step output
         discipline per the Phase-3 brief.
    """
    assert isinstance(payload, LeadOutreachWriterInput), (
        f"unexpected input type: {type(payload)}"
    )

    brief = payload.brief
    research = payload.research
    lead = payload.lead
    locale_line = _LOCALE_SUFFIX.get(payload.locale, _LOCALE_SUFFIX["ko"])
    default_tone = _COUNTRY_TONE_DEFAULT.get(lead.country.upper(), "consultative")

    # Compose research block — angles enumerated, facts bulleted. When
    # facts is empty the writer must produce a SHORT draft (spec §8 #2).
    angles_block = "\n".join(
        f"  {i + 1}. {a}" for i, a in enumerate(research.angles)
    )
    if research.grounded_facts:
        facts_block = "Grounded facts (cite only what's here):\n" + "\n".join(
            f"  · {f}" for f in research.grounded_facts
        )
    else:
        facts_block = (
            "Grounded facts: (none — your draft MUST therefore be brief + "
            "skip company-specific claims. Lean on `ourProduct.keyClaims` only.)"
        )

    voice_line = (
        f"Voice notes: {brief.outreach.tone_notes}"
        if brief.outreach.tone_notes
        else "Voice notes: neutral, warm, concise."
    )
    banned_line = (
        f"Banned phrases (do not use): {', '.join(payload.banned_phrases)}."
        if payload.banned_phrases
        else ""
    )
    homepage_line = f"URL: {lead.homepage_url}" if lead.homepage_url else ""
    contact_line = (
        f"Contact profile: {research.contact_profile}"
        if research.contact_profile
        else "Contact profile: unknown — use a neutral greeting (no name)."
    )
    company_line = (
        f"Company: {lead.company_name}"
        + (f" ({lead.company_name_en})" if lead.company_name_en else "")
    )

    blocks: list[str] = [
        (
            f"You are the Lead Outreach Writer. Compose ONE cold-sales email pitching "
            f"\"{brief.our_product.name}\" ({brief.our_product.pitch_summary}) to "
            f"{lead.company_name}"
            + (f" ({lead.company_name_en})" if lead.company_name_en else "")
            + "."
        ),
        "",
        "## What we're pitching",
        f"Product: {brief.our_product.name}",
        f"Summary: {brief.our_product.pitch_summary}",
        (
            f"Key claims: {' / '.join(brief.our_product.key_claims)}"
            if brief.our_product.key_claims
            else "Key claims: (none supplied — be conservative)."
        ),
        voice_line,
        banned_line,
        "",
        "## Lead",
        company_line,
        homepage_line,
        f"Country: {lead.country.upper()} (default tone for this country: {default_tone})",
        "",
        "## Research summary (single source of truth — do not invent)",
        f"Pitch anchor: {research.pitch}",
        "Angles to choose among:",
        angles_block,
        facts_block,
        contact_line,
        f"Research confidence: {research.confidence:.0f}/100.",
        "",
        "## Procedure",
        "1. Pick the strongest angle from the research summary. The chosen "
        "angle MUST be one of: data_specific, pain_killer, mutual_benefit, "
        "authority, directness. Justify silently — the chosen value goes in "
        "the `angle` output field.",
        "2. Pick a `tone`: formal | consultative | direct.",
        f"   · Default for {lead.country.upper()} is `{default_tone}`.",
        "   · `direct` only when research.confidence ≥ 70 AND you can cite ≥ 2 grounded facts.",
        "   · `formal` for JP/CN recipients regardless of confidence (cultural).",
        "3. Draft the email:",
        "   · subject: 6-10 words. No spammy phrases ('quick chat?', 'limited time', ALL CAPS, multiple !).",
        "   · body: 3-5 short paragraphs. Open with a SPECIFIC observation about THIS company "
        "(cite a grounded fact). Then the pitch (anchored on ourProduct.pitchSummary + 1-2 keyClaims). "
        "Then ONE low-pressure CTA (e.g. '15-min intro call', 'short deck via reply').",
        "   · Locale: match `locale` field strictly. Korean lead → Korean draft.",
        "   · Length: ≤ 220 words. B2B inboxes punish length.",
        "4. Self-score the draft and populate output fields:",
        "   · spamScore (0-1): ALL-CAPS subject = +0.3, multiple '!' = +0.2, bait phrases "
        "('act now', 'limited time') = +0.4, vague urgency = +0.1, missing recipient handle = +0.1. "
        "     Clip to [0,1]. **If spamScore > 0.4, revise once and re-score; if still > 0.4, "
        "append 'SPAM_RISK' to groundedFacts so the runtime escalates.**",
        "   · deliverabilityScore (0-1): SPF-friendly (no link-shorteners, ≤ 2 links), no images, "
        "plain-text-safe HTML only. Higher = better. Target ≥ 0.7.",
        "   · icpFitScore (0-1): how well the lead fits the campaign's ICP. Heuristic: "
        "research.confidence / 100 × angles_count_used (capped at 1.0). **If < 0.5 append "
        "'LOW_ICP_FIT' to groundedFacts so the runtime escalates.**",
        "5. Populate groundedFacts: name each fact the body cites by SHORT label "
        "(e.g. 'research.groundedFacts[0]', 'ourProduct.keyClaims[1]'). Special sentinel labels:",
        "   · 'HALLUCINATION' — append when you would otherwise need to invent a fact NOT in the "
        "research summary. Forces escalation.",
        "   · 'SPAM_RISK' — append when spamScore > 0.4 after one revise (see step 4).",
        "   · 'LOW_ICP_FIT' — append when icpFitScore < 0.5 (see step 4).",
        "6. Populate suggestedNextStep: ONE line summarizing the CTA + the optimal operator "
        "follow-up if the lead replies (e.g. 'Book 15-min intro call; if interested, send case-study deck').",
        "",
        "## Discipline",
        "  · Don't invent company-specific facts. The research summary is the ONLY source of truth.",
        "  · If `research.confidence < 30`, append 'HALLUCINATION' to groundedFacts so the runtime "
        "escalates — the lead is under-researched.",
        "  · Don't add an unsubscribe footer or tracking pixel — `gmail.send` adds those.",
        "  · Don't include the signature in the body — the workflow appends `signatureBlock` verbatim.",
        "  · No Re:/Fwd: prefixes in the subject.",
        "",
        f"Output JSON: {{subject, body, tone, angle, spamScore, deliverabilityScore, "
        f"icpFitScore, groundedFacts, suggestedNextStep}} — nothing else.",
        "",
        (
            f"## Signature block (appended automatically downstream — DO NOT include in body):\n"
            f"{payload.signature_block}"
            if payload.signature_block
            else ""
        ),
        "",
        locale_line,
    ]

    return "\n".join(b for b in blocks if b != "")


# ─────────────────────────────────────────────────────────────────────────────
# AgentDef — the Pydantic config the runtime consumes.
# ─────────────────────────────────────────────────────────────────────────────


lead_outreach_writer_agent_def: AgentDef[
    LeadOutreachWriterInput, LeadOutreachWriterOutput
] = AgentDef(
    id="lead-outreach-writer",
    description=(
        "Draft one cold-sales email for one B2B lead from the campaign brief "
        "+ the lead's research summary. Self-scores spam + deliverability + "
        "ICP fit; escalates via sentinel labels in groundedFacts. "
        "Per lead_outreach_writer.spec.md (D23 Tier-1 agent #11)."
    ),
    model=LEAD_OUTREACH_WRITER_MODEL,
    # Phase-3 brief: $0.05. Tighter than spec's $1.20 because we removed the
    # 4-judge tournament pass (self-judgment is in-prompt now). Live runs that
    # trip BudgetExceeded should raise to $0.20 here, NOT via an in-prompt
    # nudge to the model.
    max_usd=0.05,
    input_schema=LeadOutreachWriterInput,
    output_schema=LeadOutreachWriterOutput,
    system_prompt=build_lead_outreach_writer_system_prompt,
    # W2-B1 (D41): `crm.enrich` capability wired as the first FunctionTool.
    # `templates.render` + `outreach.judge` remain Phase-4 work — the writer's
    # self-judge in-prompt covers the brief's tightened scope until then.
    tools=[crm_enrich],
    max_turns=6,  # spec §6 expects 4-6 turns when self-revising
)


__all__ = [
    "LEAD_OUTREACH_WRITER_MODEL",
    "LeadCampaignBrief",
    "LeadContact",
    "LeadGoals",
    "LeadOutreachAngle",
    "LeadOutreachConfig",
    "LeadOutreachTone",
    "LeadOutreachWriterInput",
    "LeadOutreachWriterOutput",
    "LeadResearch",
    "LeadTargeting",
    "Locale",
    "OurProduct",
    "build_lead_outreach_writer_system_prompt",
    "lead_outreach_writer_agent_def",
]


# ─────────────────────────────────────────────────────────────────────────────
# __main__ entry point for ad-hoc testing against live Vertex.
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

    from ss_agents.runtime import RunContext, run_agent

    async def main() -> None:
        ctx = RunContext(
            tenant_id="t_demo000000000000",
            workspace_id="ws_demo_lead_writer_cli",
            trace_id="trace-lead-writer-cli-1",
        )
        payload = LeadOutreachWriterInput(
            brief=LeadCampaignBrief(
                workspaceId="ws_demo_lead_writer_cli",
                createdBy="cli@example.com",
                name="Pitch SS to K-beauty D2C",
                ourProduct=OurProduct(
                    name="Social Seeding",
                    pitchSummary=(
                        "Agent-orchestrated TikTok influencer marketing platform "
                        "for K-beauty D2C brands."
                    ),
                    keyClaims=[
                        "Average $10 CPM ROI-linked",
                        "Source → vet → outreach → ship → verify loop fully agentized",
                    ],
                ),
                targeting=LeadTargeting(countries=["KR"], categories=["cosmetics"]),
                outreach=LeadOutreachConfig(
                    maxSendsPerBatch=20,
                    toneNotes="warm + factual; reference numbers when possible",
                ),
                goals=LeadGoals(
                    targetReplies=10,
                    deadline=dt.datetime(2026, 7, 31, 23, 59, tzinfo=dt.UTC),
                ),
            ),
            research=LeadResearch(
                pitch=(
                    "K-beauty D2C brand on Cafe24 with active Instagram presence "
                    "but no TikTok storefront — high upside for paid TikTok seeding."
                ),
                angles=[
                    "data_specific: their Cafe24 SKU count suggests 6-mo seeding pilot",
                    "mutual_benefit: we drive trial; they share monthly CPM data",
                ],
                groundedFacts=[
                    "Brand operates a Cafe24 storefront with 40+ SKUs",
                    "Instagram follower count: 12,400 (growing)",
                    "No TikTok official account as of 2026-04",
                ],
                contactProfile="Marketing Lead",
                confidence=72.0,
                researchedAt=dt.datetime(2026, 5, 1, tzinfo=dt.UTC),
            ),
            lead=LeadContact(
                companyName="프레쉴리 코스메틱",
                companyNameEn="Freshly Cosmetics",
                country="KR",
                homepageUrl="https://freshly.example.kr",
                contactEmail="marketing@freshly.example.kr",
            ),
            signatureBlock="— The Social Seeding team\nseoul.socialseed.ing",
            bannedPhrases=["limited time", "act now"],
            locale="ko",
        )
        outcome = await run_agent(lead_outreach_writer_agent_def, payload, ctx)
        print(json.dumps(outcome.model_dump(by_alias=True), indent=2, default=str))

    asyncio.run(main())
