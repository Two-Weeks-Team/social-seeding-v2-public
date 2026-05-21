"""Outreach Writer agent — Phase 3 agent #7 (Tier-1 #3).

Tournament-pattern port of v1's `lib/cold-mail` discipline + v2's
`packages/agents/src/outreach-writer.agent.ts:34-133`, reshaped onto ADK +
Gemini 3.1 Pro + Pydantic, following the contract in
`gcp-research/specs/tier1/outreach_writer.spec.md`.

Tournament shape (per task brief + spec §1 + §5 sequence):
    1. 5 candidate drafts produced in parallel from 5 angles
         (pain_killer / aspirational / peer_proof / data_specific / contrarian_hook).
       Each angle is its own short Gemini 3.1 Pro call (single-angle prompt).
    2. For every successful draft, 4 judges score in parallel:
         brand / conversion / deliverability / skeptic.
    3. Final score per draft = JUDGE_WEIGHTS-weighted GEOMETRIC mean of the
       four judge scores. Geometric punishes any single weak dimension harder
       than arithmetic does — matches v1's "skeptic is veto-strong" intuition.
    4. Winner attaches the four scorecards, returns groundedFacts + spamScore.

The JUDGE_WEIGHTS dict is carried verbatim from `packages/contracts/src/outreach.ts:74-79`
(skeptic 0.40 · conversion 0.30 · deliverability 0.15 · brand 0.15) so v1↔v2
A/B comparisons stay calibrated.

USD cap (per task brief):
    $0.10 per tournament — capped by `OUTREACH_WRITER_TOURNAMENT_MAX_USD`.
    The orchestrator counts cumulative spend (5 drafter calls + 20 judge
    calls = 25 max LLM hits) and short-circuits the moment the cap would be
    breached. Spec §6 cites $1.50 for the v2 single-tool flow; we under-spend
    by an order of magnitude because each tournament call is a small
    Pro/Pro-style prompt rather than a multi-tool ReAct loop.

Escalation conditions (per task brief + spec §6):
    - facts.hasMinimumContext is False                   → insufficient_context
    - top weighted score < 0.6                           → draft_below_quality_floor
    - all 5 drafts spamScore > 0.4 (normalised 0–1)      → draft_below_quality_floor
    - all 5 drafts failed (drafter Escalations)          → tournament_collapse
    - tournament budget exhausted before any winner      → budget_exhausted
    - tournament wall-clock timeout (OUTREACH_TIMEOUT_S) → tournament_timeout
    - input locale ∉ {ko, en, ja, zh-CN}                 → locale validation (Pydantic)

Citations:
    D5  — Gemini 3.1 Pro for judgment (drafter + judges share the Pro tier).
    D10 — Gmail demo restricted to operator-owned test accounts (writer never sends).
    D21 — Model Armor PII/competitor regex scans drafter input + output at the
          gateway; this agent's prompt_guard is the in-process belt-and-braces.
    D23 — Tier-1 agent #3.
    D27 — Output feeds the AP2 Intent Mandate composer — compliance + approval
          gates sit between writer and gmail.send (never bypassed).
    D34 — 4-locale support: ko / en / ja / zh-CN.
    ARCHITECTURE.md §3 row 3:
        outreach_writer | 1 | Gemini 3.1 Pro tournament | templates.list,
        outreach.extract_facts, outreach.render, outreach.judge | Memory Bank
        | response_match_v2 + spam_score
    v2 reference: packages/agents/src/outreach-writer.agent.ts:34-133.
    Spec: gcp-research/specs/tier1/outreach_writer.spec.md.
    Porting reference: gcp-research/porting-v2/PORTING-V2.md §5 lines 344-617
        (single-writer template; we wrap it in the tournament orchestrator).
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ss_agents.runtime import (
    AgentDef,
    AgentOutcome,
    Escalation,
    OutcomeOk,
    RunContext,
    run_agent,
)
from ss_agents.tools.outreach_extract_facts import outreach_extract_facts
from ss_agents.tools.outreach_render import outreach_render
from ss_agents.tools.templates_list import templates_list

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Locale + angle + judge enums (spec §2 + outreach.ts contracts).
# ─────────────────────────────────────────────────────────────────────────────


Locale = Literal["ko", "en", "ja", "zh-CN"]

# Mirrors @ss/contracts AngleKey + outreach_writer.spec.md §2 $defs/AngleKey.
AngleKey = Literal[
    "pain_killer",
    "aspirational",
    "peer_proof",
    "data_specific",
    "contrarian_hook",
]

# Mirrors @ss/contracts JudgeKey + outreach_writer.spec.md §2 $defs/JudgeKey.
JudgeKey = Literal["brand", "conversion", "deliverability", "skeptic"]


# The five tournament angles, ordered by v1's `lib/cold-mail` hypothesis space
# (pain → aspirational → peer → data → contrarian). The order doubles as the
# fan-out order in the orchestrator (purely cosmetic; calls are parallel).
TOURNAMENT_ANGLES: tuple[AngleKey, ...] = (
    "pain_killer",
    "aspirational",
    "peer_proof",
    "data_specific",
    "contrarian_hook",
)

# The four judges, ordered to match outreach.ts:74-79 weights table.
TOURNAMENT_JUDGES: tuple[JudgeKey, ...] = (
    "skeptic",
    "conversion",
    "deliverability",
    "brand",
)


# ─────────────────────────────────────────────────────────────────────────────
# JUDGE_WEIGHTS — carried VERBATIM from packages/contracts/src/outreach.ts:74-79
# Do NOT change these values without retiring the v1↔v2 A/B calibration corpus.
# ─────────────────────────────────────────────────────────────────────────────


JUDGE_WEIGHTS: dict[JudgeKey, float] = {
    "skeptic": 0.40,
    "conversion": 0.30,
    "deliverability": 0.15,
    "brand": 0.15,
}


def weighted_geometric_score(scores: dict[JudgeKey, float]) -> float:
    """Weighted geometric mean of four judge scores.

    g = exp( Σ w_i · ln(max(s_i, ε)) / Σ w_i )

    Geometric (vs arithmetic) punishes any single weak dimension harder — a
    skeptic-veto of 0.10 drags the whole tournament score even if the other
    three judges score 0.90+. Matches v1's "skeptic is veto-strong" intuition.

    The `JUDGE_WEIGHTS` dict from v2 outreach.ts is the canonical weight set
    (skeptic 0.40, conversion 0.30, deliverability 0.15, brand 0.15). Weights
    sum to 1.0 exactly — but we re-normalise for safety in case a future caller
    passes a subset of judges.

    Args:
        scores: dict mapping each JudgeKey to its [0, 1] score. Missing
                judges are skipped (weight not counted toward the denominator).

    Returns:
        Weighted geometric mean in [0, 1]. Returns 0.0 if no judges scored.
    """
    epsilon = 1e-6  # floor for log() to keep zero-score drafts representable
    weight_sum = 0.0
    log_acc = 0.0
    for judge, score in scores.items():
        weight = JUDGE_WEIGHTS.get(judge)
        if weight is None:
            continue
        clamped = max(min(score, 1.0), 0.0)
        log_acc += weight * math.log(max(clamped, epsilon))
        weight_sum += weight
    if weight_sum == 0.0:
        return 0.0
    return math.exp(log_acc / weight_sum)


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic schemas — mirrors of @ss/contracts OutreachFacts + OutreachDraft +
# JudgeScoreCard (spec §2). Manually ported; Phase 3.0 codegen replaces these.
# ─────────────────────────────────────────────────────────────────────────────


class OutreachCreatorFacts(BaseModel):
    """Mirrors @ss/contracts OutreachFactsSchema.creator (outreach.ts:20-32)."""

    model_config = ConfigDict(extra="forbid")

    unique_id: str = Field(min_length=1, alias="uniqueId")
    nickname: str = Field(min_length=0, max_length=200)
    signature: str = Field(default="", max_length=4000)
    top_hashtags: list[str] = Field(
        default_factory=list, max_length=5, alias="topHashtags"
    )
    recent_post_themes: list[str] = Field(
        default_factory=list, max_length=3, alias="recentPostThemes"
    )
    follower_count: int = Field(ge=0, alias="followerCount")
    avg_views: int | None = Field(default=None, ge=0, alias="avgViews")
    engagement_rate: float | None = Field(
        default=None, ge=0.0, le=1.0, alias="engagementRate"
    )


class OutreachBrandFacts(BaseModel):
    """Mirrors @ss/contracts OutreachFactsSchema.brand (outreach.ts:33-39)."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=2000)
    key_claims: list[str] = Field(
        default_factory=list, max_length=20, alias="keyClaims"
    )


class OutreachLogisticsFacts(BaseModel):
    """Mirrors @ss/contracts OutreachFactsSchema.logistics (outreach.ts:40-42)."""

    model_config = ConfigDict(extra="forbid")

    ships_samples: bool = Field(alias="shipsSamples")


class OutreachFacts(BaseModel):
    """Closed fact set the agent may cite. Mirrors OutreachFactsSchema."""

    model_config = ConfigDict(extra="forbid")

    creator: OutreachCreatorFacts
    brand: OutreachBrandFacts
    logistics: OutreachLogisticsFacts
    has_minimum_context: bool = Field(alias="hasMinimumContext")


class JudgeScoreCard(BaseModel):
    """One judge's score + rationale. Mirrors spec §2 $defs/JudgeScoreCard +
    @ss/contracts JudgeScoreCardSchema (outreach.ts:61-66)."""

    model_config = ConfigDict(extra="forbid")

    judge: JudgeKey
    score: float = Field(ge=0.0, le=1.0)
    rationale: str = Field(min_length=1, max_length=600)
    flags: list[str] = Field(default_factory=list, max_length=12)


class JudgeScores(BaseModel):
    """Compact judge-score map. Mirrors spec §2 OutreachDraft.judgeScores."""

    model_config = ConfigDict(extra="forbid")

    brand: float = Field(ge=0.0, le=1.0)
    conversion: float = Field(ge=0.0, le=1.0)
    deliverability: float = Field(ge=0.0, le=1.0)
    skeptic: float = Field(ge=0.0, le=1.0)


class OutreachDraft(BaseModel):
    """Output of one drafter call — and the tournament winner shape (spec §2)."""

    model_config = ConfigDict(extra="forbid")

    subject: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=8000)
    angle: AngleKey
    spam_score: float = Field(ge=0.0, le=10.0, alias="spamScore")
    grounded_facts: list[str] = Field(
        min_length=0, max_length=20, alias="groundedFacts"
    )
    locale: Locale = "ko"


class OutreachTournamentWinner(BaseModel):
    """Tournament winner — OutreachDraft + the 4 scorecards + weighted score.

    Returned by `run_outreach_tournament()`. The downstream workflow persists
    `judgeScoreCards` to Spanner v2_outreach_drafts (per spec §4 AsyncAPI)."""

    model_config = ConfigDict(extra="forbid")

    subject: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=8000)
    angle: AngleKey
    spam_score: float = Field(ge=0.0, le=10.0, alias="spamScore")
    grounded_facts: list[str] = Field(
        min_length=0, max_length=20, alias="groundedFacts"
    )
    locale: Locale = "ko"
    judge_scores: JudgeScores = Field(alias="judgeScores")
    judge_score_cards: list[JudgeScoreCard] = Field(
        min_length=4, max_length=4, alias="judgeScoreCards"
    )
    weighted_score: float = Field(ge=0.0, le=1.0, alias="weightedScore")


# ─────────────────────────────────────────────────────────────────────────────
# Input schema — agent_def consumes OutreachWriterInput; the orchestrator
# uses the same shape but invokes drafter + judge defs internally.
# ─────────────────────────────────────────────────────────────────────────────


class OutreachWriterInput(BaseModel):
    """Per outreach_writer.spec.md §2 properties.Input.

    `facts` is REQUIRED (workflow always pre-runs `outreach.extract_facts`
    before calling the writer — see spec §5 sequence diagram lines 225-227).
    """

    model_config = ConfigDict(extra="forbid")

    facts: OutreachFacts
    voice_notes: str = Field(default="", max_length=2000, alias="voiceNotes")
    signature_block: str = Field(
        default="", max_length=2000, alias="signatureBlock"
    )
    banned_phrases: list[str] = Field(
        default_factory=list, max_length=40, alias="bannedPhrases"
    )
    locale: Locale = "ko"

    @field_validator("locale")
    @classmethod
    def _locale_in_d34_set(cls, v: Locale) -> Locale:
        # Pydantic's Literal already enforces this; this validator gives a
        # crisper error string for spec §6 "Locale of creator.language not in
        # {ko,en,ja,zh-CN}" escalation telemetry. Belt-and-braces.
        if v not in ("ko", "en", "ja", "zh-CN"):
            raise ValueError(f"locale must be one of ko/en/ja/zh-CN, got {v!r}")
        return v


# ─────────────────────────────────────────────────────────────────────────────
# Inner drafter input/output — one angle, one draft.
# ─────────────────────────────────────────────────────────────────────────────


class _DrafterInput(BaseModel):
    """Internal — one drafter invocation produces a draft for ONE angle."""

    model_config = ConfigDict(extra="forbid")

    facts: OutreachFacts
    angle: AngleKey
    voice_notes: str = Field(default="", alias="voiceNotes")
    banned_phrases: list[str] = Field(default_factory=list, alias="bannedPhrases")
    locale: Locale = "ko"


# ─────────────────────────────────────────────────────────────────────────────
# Inner judge input/output — one judge, one draft.
# ─────────────────────────────────────────────────────────────────────────────


class _JudgeInput(BaseModel):
    """Internal — one judge invocation scores ONE draft on ONE dimension."""

    model_config = ConfigDict(extra="forbid")

    judge: JudgeKey
    draft: OutreachDraft
    facts: OutreachFacts
    banned_phrases: list[str] = Field(default_factory=list, alias="bannedPhrases")


# ─────────────────────────────────────────────────────────────────────────────
# System prompt builders — drafter + judge.
# ─────────────────────────────────────────────────────────────────────────────


_LOCALE_INSTRUCTION: dict[Locale, str] = {
    "ko": "Write subject + body in 한국어 (Korean).",
    "en": "Write subject + body in English.",
    "ja": "Write subject + body in 日本語 (Japanese).",
    "zh-CN": "Write subject + body in 简体中文 (Simplified Chinese).",
}


_ANGLE_DESCRIPTIONS: dict[AngleKey, str] = {
    "pain_killer": "empathize with a friction point the creator has shown",
    "aspirational": "reach-goal framing tied to the creator's themes",
    "peer_proof": "same-niche success pattern, citing themes from the fact set",
    "data_specific": "a concrete claim from brand.keyClaims, anchored to one creator theme",
    "contrarian_hook": "open with a counter-intuitive insight relevant to the creator's content",
}


def build_drafter_system_prompt(payload: BaseModel) -> str:
    """Drafter prompt — port of outreach-writer.agent.ts:82-132, single-angle.

    Per spec §6: drafter cites ONLY facts from `OutreachFacts`. Banned phrases
    are forbidden. Sample policy carries from logistics.shipsSamples.
    """
    assert isinstance(payload, _DrafterInput), f"unexpected type: {type(payload)}"
    facts = payload.facts
    creator = facts.creator
    brand = facts.brand
    sample_line = (
        "Sample policy: we ARE sending a free sample. Invite the creator to receive it."
        if facts.logistics.ships_samples
        else "Sample policy: NO sample. This is a paid / affiliate ask — never imply a free sample."
    )
    voice_line = (
        f"Brand voice: {payload.voice_notes}"
        if payload.voice_notes
        else "Brand voice: neutral, warm, concise (no specific style notes provided)."
    )
    banned_line = (
        f"Banned phrases (NEVER use): {', '.join(payload.banned_phrases)}."
        if payload.banned_phrases
        else ""
    )
    locale_line = _LOCALE_INSTRUCTION.get(payload.locale, _LOCALE_INSTRUCTION["ko"])
    angle_hint = _ANGLE_DESCRIPTIONS[payload.angle]

    facts_json = facts.model_dump_json(by_alias=True, indent=2)

    return "\n".join(
        [
            f'You are the Outreach Drafter (angle: {payload.angle}). Write ONE cold-outreach email inviting @{creator.unique_id} ("{creator.nickname}") to a "{brand.name}" ({brand.category}) TikTok collaboration.',
            "",
            sample_line,
            voice_line,
            banned_line,
            "",
            "## OutreachFacts (the ONLY claims you may cite)",
            "",
            "```json",
            facts_json,
            "```",
            "",
            f"## Angle: {payload.angle} — {angle_hint}",
            "",
            "Write a draft for THIS angle only. Do NOT consider other angles.",
            "",
            "Requirements:",
            f"  · subject ≤ 80 chars · body 200–800 chars (HTML stripped) · exactly one '?' as CTA",
            "  · cite at least one fact from recentPostThemes[] OR topHashtags[] OR brand.keyClaims[]",
            "  · groundedFacts[] = the dotted-path strings the body cited (e.g. 'creator.recentPostThemes[0]', 'brand.keyClaims[1]')",
            "  · spamScore 0–10 (lower=better): start at 1, +1 per spammy phrase ('urgent', 'limited time', overuse of CAPS, multiple '!'s, '$', 'free!', …)",
            f"  · locale = {payload.locale!r}",
            "",
            "Discipline:",
            "  · No invented metrics (follower counts, view counts not in the fact set).",
            "  · No fake mutual connections / 'I saw your DM' / 'a friend recommended'.",
            "  · Subject is plain text — no Re:/Fwd: prefixes.",
            "  · Body is HTML; do NOT include unsubscribe footer or tracking pixel (gmail.send adds those).",
            "",
            locale_line,
            "",
            "Output: ONE JSON object matching the OutreachDraft schema.",
        ]
    )


_JUDGE_RUBRICS: dict[JudgeKey, str] = {
    "skeptic": (
        "Skeptic rubric: would a busy creator dismiss this in 3 seconds? "
        "Penalise vagueness, AI-generated tone, generic claims, anything that "
        "could be sent to anyone. Reward specificity grounded in the facts."
    ),
    "conversion": (
        "Conversion rubric: does the email increase reply odds? Penalise "
        "missing CTA, multi-question paragraphs, friction (asking before "
        "offering). Reward a clear single ask + sample mention when applicable."
    ),
    "deliverability": (
        "Deliverability rubric: would Gmail / inbox filters mark this as "
        "promotional or spam? Penalise CAPS, '!!!', '$', 'free!', 'limited "
        "time', 'urgent', hidden text patterns, Re:/Fwd: subject prefixes, "
        "multiple links, image-only bodies. Reward plain conversational HTML. "
        "Flag any CRITICAL hit: hiddenText, tooManyExclamations, excessiveCaps."
    ),
    "brand": (
        "Brand rubric: does the draft match the brief's voice + claims? "
        "Penalise banned phrases (escalate to 0.0 if found), competitor "
        "name-drops, factual claims absent from brand.keyClaims. Reward "
        "tone match + faithful use of keyClaims."
    ),
}


def build_judge_system_prompt(payload: BaseModel) -> str:
    """Judge prompt — port of v2's outreach.judge capability.

    Returns rationale + score + flags. The agent emits a JudgeScoreCard.
    """
    assert isinstance(payload, _JudgeInput), f"unexpected type: {type(payload)}"
    rubric = _JUDGE_RUBRICS[payload.judge]
    facts_json = payload.facts.model_dump_json(by_alias=True)
    draft_json = payload.draft.model_dump_json(by_alias=True)
    banned_line = (
        f"Banned phrases (instant 0.0 from brand judge if present): "
        f"{', '.join(payload.banned_phrases)}."
        if payload.banned_phrases
        else "No banned phrases configured."
    )

    return "\n".join(
        [
            f"You are the {payload.judge.upper()} judge for the Outreach Writer tournament.",
            "",
            rubric,
            "",
            "## OutreachFacts (closed fact set the drafter was given)",
            facts_json,
            "",
            "## Draft under review",
            draft_json,
            "",
            banned_line,
            "",
            "Output one JudgeScoreCard JSON object:",
            f'  · judge = "{payload.judge}"',
            "  · score ∈ [0, 1] (lower means the draft fails this rubric harder)",
            "  · rationale ≤ 600 chars — explain the score, name specific lines",
            "  · flags[] — short codes (e.g. 'tooManyExclamations', 'bannedPhraseLeak')",
        ]
    )


# ─────────────────────────────────────────────────────────────────────────────
# Inner AgentDefs — drafter + judge. Cost ceilings per-call are tight so the
# combined 5-draft + 20-judge tournament stays under $0.10.
# ─────────────────────────────────────────────────────────────────────────────


# Spec §6 cites $1.50 for the v2 single-tool flow. The tournament-pattern
# rebuilds that as 25 cheap calls — so per-call caps are roughly:
#   5 drafter × $0.014 + 20 judge × $0.0035 = $0.07 + $0.07 = $0.14 ceiling.
# Tournament hard cap (OUTREACH_WRITER_TOURNAMENT_MAX_USD) clamps cumulative
# spend at $0.10 — whichever trips first wins.
_DRAFTER_MAX_USD: float = 0.02
_JUDGE_MAX_USD: float = 0.005


outreach_drafter_agent_def: AgentDef[_DrafterInput, OutreachDraft] = AgentDef(
    id="outreach-drafter",
    description=(
        "Inner drafter — produces ONE OutreachDraft for ONE angle. Invoked 5x "
        "in parallel by the outreach_writer tournament orchestrator."
    ),
    model="gemini-3.1-pro",  # D53 — judgment-grade prose for a 200-800 char body.
    max_usd=_DRAFTER_MAX_USD,
    input_schema=_DrafterInput,
    output_schema=OutreachDraft,
    system_prompt=build_drafter_system_prompt,
    tools=[],  # spec §6 "tools: outreach.render, outreach.extract_facts" —
    # facts are pre-computed by the workflow; render is replaced by Gemini's
    # responseSchema-enforced output (no Mustache step needed).
    max_turns=2,  # single emit + retry buffer.
)


outreach_judge_agent_def: AgentDef[_JudgeInput, JudgeScoreCard] = AgentDef(
    id="outreach-judge",
    description=(
        "Inner judge — scores ONE draft on ONE rubric "
        "(brand / conversion / deliverability / skeptic). Invoked 4x per draft."
    ),
    model="gemini-3.1-pro",  # D53 — calibration of [0,1] needs Pro-level judgment.
    max_usd=_JUDGE_MAX_USD,
    input_schema=_JudgeInput,
    output_schema=JudgeScoreCard,
    system_prompt=build_judge_system_prompt,
    tools=[],
    max_turns=2,
)


# ─────────────────────────────────────────────────────────────────────────────
# Public agent_def — the SPEC-LEVEL contract. The orchestrator below is the
# operational entry point; agent_def stays here so eval harnesses + Mission
# Control router can address the writer by its canonical id.
# ─────────────────────────────────────────────────────────────────────────────


# Per task brief: USD cap $0.10 per tournament (5 drafts + 20 judge calls).
OUTREACH_WRITER_TOURNAMENT_MAX_USD: float = 0.10

# Tournament wall-clock budget. Generous because each call is independent —
# we lean on Gemini's typical p95 (≤ 4 s) and add headroom for the 4-judge
# parallel barrier. spec §6 escalation: "tournament timeout".
OUTREACH_TIMEOUT_S: float = 60.0

# Top-score floor below which the orchestrator escalates instead of returning.
# Brief: "Escalate when: top score < 0.6".
OUTREACH_QUALITY_FLOOR: float = 0.60

# Per-draft spam normalisation: OutreachDraft.spam_score is 0–10; threshold
# 0.4 in 0–1 space ⇔ 4.0 in 0–10 space.
OUTREACH_SPAM_THRESHOLD_NORMALISED: float = 0.40
OUTREACH_SPAM_THRESHOLD_RAW: float = OUTREACH_SPAM_THRESHOLD_NORMALISED * 10.0


def build_outreach_system_prompt(payload: BaseModel) -> str:
    """The public-facing system prompt — describes the tournament outcome
    shape. The agent_def is registered so eval harnesses can introspect it,
    but the operational path is `run_outreach_tournament()`, not this
    single-agent invocation. We keep a coherent prompt for spec parity.
    """
    assert isinstance(payload, OutreachWriterInput), (
        f"unexpected type: {type(payload)}"
    )
    facts = payload.facts
    locale_line = _LOCALE_INSTRUCTION.get(payload.locale, _LOCALE_INSTRUCTION["ko"])
    return "\n".join(
        [
            "You are the Outreach Writer agent.",
            "",
            "The workflow has pre-computed OutreachFacts; the tournament "
            "orchestrator drafts 5 candidate emails (one per angle) and scores "
            "each with the 4 judges (skeptic / conversion / deliverability / "
            "brand). The winner is the draft with the highest "
            "JUDGE_WEIGHTS-weighted geometric mean of the four judge scores.",
            "",
            f"Brand: {facts.brand.name} ({facts.brand.category}).",
            f"Creator: @{facts.creator.unique_id}.",
            f"Locale: {payload.locale}. {locale_line}",
            "",
            f"hasMinimumContext: {facts.has_minimum_context} — "
            "escalate immediately if False.",
        ]
    )


outreach_writer_agent_def: AgentDef[OutreachWriterInput, OutreachTournamentWinner] = (
    AgentDef(
        id="outreach-writer",
        description=(
            "Tournament writer — drafts 5 candidate emails in parallel "
            "(5 angles × 1), scores each with 4 parallel judges, returns the "
            "JUDGE_WEIGHTS-weighted geometric-mean winner with the 4 "
            "scorecards attached. Per outreach_writer.spec.md "
            "(D23 Tier-1 agent #3)."
        ),
        model="gemini-3.1-pro",
        max_usd=OUTREACH_WRITER_TOURNAMENT_MAX_USD,
        input_schema=OutreachWriterInput,
        output_schema=OutreachTournamentWinner,
        system_prompt=build_outreach_system_prompt,
        # Per W2-A3 + outreach_writer.spec.md §6 capability table + D41:
        #   templates.list           → per-locale template inventory
        #   outreach.extract_facts   → closed-set fact bench
        #   outreach.render          → Mustache-style variable fill
        # The tournament orchestrator (`run_outreach_tournament`) pre-runs
        # extract_facts before the drafters; the drafters consume render via
        # FunctionTool dispatch when the responseSchema path is unavailable.
        tools=[templates_list, outreach_extract_facts, outreach_render],
        max_turns=4,
    )
)


# ─────────────────────────────────────────────────────────────────────────────
# Tournament orchestrator — the operational entry point.
# ─────────────────────────────────────────────────────────────────────────────


def _draft_ctx(ctx: RunContext, angle: AngleKey) -> RunContext:
    """Spawn a per-leg RunContext.

    Each drafter/judge leg needs its own ctx because:
      · model_client is mutated on the shared ctx (would cross-talk under gather).
      · trace_id is suffixed for OTel span isolation.
      · campaign_budget_usd is shared by reference — we keep that intentionally
        so global budget exhaustion still trips across legs.
    """
    return ctx.model_copy(
        update={
            "trace_id": f"{ctx.trace_id}:draft:{angle}",
        }
    )


def _judge_ctx(ctx: RunContext, angle: AngleKey, judge: JudgeKey) -> RunContext:
    """Per-leg RunContext for a judge call — see `_draft_ctx` notes."""
    return ctx.model_copy(
        update={
            "trace_id": f"{ctx.trace_id}:judge:{angle}:{judge}",
        }
    )


async def _draft_one_angle(
    *,
    facts: OutreachFacts,
    angle: AngleKey,
    voice_notes: str,
    banned_phrases: list[str],
    locale: Locale,
    ctx: RunContext,
) -> AgentOutcome:
    """Invoke the drafter once for `angle`. Returns the typed AgentOutcome.

    Any escalation (input invalid / USD cap / prompt guard) is propagated as
    `Escalation` — the orchestrator drops failed legs and continues with the
    survivors.
    """
    payload = _DrafterInput(
        facts=facts,
        angle=angle,
        voiceNotes=voice_notes,
        bannedPhrases=banned_phrases,
        locale=locale,
    )
    return await run_agent(outreach_drafter_agent_def, payload, _draft_ctx(ctx, angle))


async def _judge_one_draft_one_dimension(
    *,
    judge: JudgeKey,
    draft: OutreachDraft,
    facts: OutreachFacts,
    banned_phrases: list[str],
    ctx: RunContext,
) -> AgentOutcome:
    """Score one draft on one rubric. Returns the typed AgentOutcome."""
    payload = _JudgeInput(
        judge=judge,
        draft=draft,
        facts=facts,
        bannedPhrases=banned_phrases,
    )
    return await run_agent(
        outreach_judge_agent_def, payload, _judge_ctx(ctx, draft.angle, judge)
    )


def _banned_phrase_in_draft(draft: OutreachDraft, banned: list[str]) -> bool:
    """Case-insensitive substring match of banned phrases against subject+body."""
    if not banned:
        return False
    haystack = (draft.subject + "\n" + draft.body).lower()
    return any(phrase.lower() in haystack for phrase in banned if phrase)


async def run_outreach_tournament(
    payload: OutreachWriterInput,
    ctx: RunContext,
) -> AgentOutcome:
    """Public entry point — run the full 5-angle × 4-judge tournament.

    Per task brief + spec §1 + §5 sequence diagram:
        1. Validate input + early-exit on hasMinimumContext=False.
        2. Fan out 5 drafter calls in parallel (`asyncio.gather`).
        3. Drop legs that escalated; if nothing survives → tournament_collapse.
        4. For each surviving draft, fan out 4 judge calls in parallel.
        5. Compute weighted geometric score per draft.
        6. Pick the winner; escalate if top < 0.6 or all spam > 0.4.
        7. Stop the tournament early if cumulative USD ≥ cap or wall-clock ≥
           OUTREACH_TIMEOUT_S — emits `budget_exhausted` / `tournament_timeout`.

    Never raises — every escalation surfaces as `Escalation`. The caller
    (Cloud Workflow) inspects `outcome.kind` to decide downstream routing.
    """
    started_at = time.monotonic()

    # 1. Validate.
    try:
        validated: OutreachWriterInput = (
            payload
            if isinstance(payload, OutreachWriterInput)
            else OutreachWriterInput.model_validate(payload)
        )
    except Exception as exc:
        return Escalation(
            reason=f"input validation failed: {type(exc).__name__}: {exc}",
            partial={},
            usdSpent=0.0,
        )

    # 2. hasMinimumContext fast-path (spec §6 + §8 #3).
    if not validated.facts.has_minimum_context:
        logger.info(
            "outreach_writer_insufficient_context",
            extra={
                "agent_id": outreach_writer_agent_def.id,
                "trace_id": ctx.trace_id,
                "creator_unique_id": validated.facts.creator.unique_id,
            },
        )
        return Escalation(
            reason="insufficient_context: facts.hasMinimumContext is False",
            partial={"facts_creator": validated.facts.creator.unique_id},
            usdSpent=0.0,
        )

    # 3. Fan out the 5 drafters in parallel.
    draft_tasks = [
        _draft_one_angle(
            facts=validated.facts,
            angle=angle,
            voice_notes=validated.voice_notes,
            banned_phrases=validated.banned_phrases,
            locale=validated.locale,
            ctx=ctx,
        )
        for angle in TOURNAMENT_ANGLES
    ]
    try:
        draft_outcomes = await asyncio.wait_for(
            asyncio.gather(*draft_tasks, return_exceptions=False),
            timeout=OUTREACH_TIMEOUT_S / 2,
        )
    except asyncio.TimeoutError:
        return Escalation(
            reason="tournament_timeout: drafter phase exceeded budget",
            partial={"elapsed_s": time.monotonic() - started_at},
            usdSpent=0.0,
        )

    # 4. Filter to successful drafts. Carry cumulative cost forward.
    cumulative_usd = 0.0
    drafts: list[OutreachDraft] = []
    drafter_errors: list[str] = []
    for outcome in draft_outcomes:
        cumulative_usd += outcome.usd_spent
        if isinstance(outcome, OutcomeOk):
            value = outcome.value
            if isinstance(value, OutreachDraft):
                drafts.append(value)
            else:
                # Defensive: should never happen given output_schema.
                drafter_errors.append(
                    f"drafter returned unexpected type: {type(value).__name__}"
                )
        else:
            drafter_errors.append(outcome.reason)

    if cumulative_usd >= OUTREACH_WRITER_TOURNAMENT_MAX_USD:
        return Escalation(
            reason=(
                f"budget_exhausted: drafter phase spent ${cumulative_usd:.4f} "
                f"≥ cap ${OUTREACH_WRITER_TOURNAMENT_MAX_USD:.4f}"
            ),
            partial={
                "drafts_succeeded": len(drafts),
                "drafter_errors": drafter_errors[:5],
            },
            usdSpent=cumulative_usd,
        )

    if not drafts:
        return Escalation(
            reason=(
                f"tournament_collapse: all 5 drafter legs failed "
                f"(errors: {drafter_errors[:3]})"
            ),
            partial={"drafter_errors": drafter_errors},
            usdSpent=cumulative_usd,
        )

    # 4b. All-spam short-circuit (per brief escalation rule).
    if all(d.spam_score > OUTREACH_SPAM_THRESHOLD_RAW for d in drafts):
        return Escalation(
            reason=(
                f"draft_below_quality_floor: all {len(drafts)} drafts exceeded "
                f"spam threshold {OUTREACH_SPAM_THRESHOLD_RAW:.1f}/10"
            ),
            partial={
                "spam_scores": [d.spam_score for d in drafts],
            },
            usdSpent=cumulative_usd,
        )

    # 4c. Banned-phrase filter — drop any draft that smuggled a banned phrase.
    surviving_drafts: list[OutreachDraft] = []
    for draft in drafts:
        if _banned_phrase_in_draft(draft, validated.banned_phrases):
            drafter_errors.append(f"angle={draft.angle}: banned_phrase_leak")
            continue
        surviving_drafts.append(draft)

    if not surviving_drafts:
        return Escalation(
            reason=(
                "draft_below_quality_floor: every draft contained a banned phrase"
            ),
            partial={"banned_phrases": validated.banned_phrases},
            usdSpent=cumulative_usd,
        )

    # 5. Fan out 4 judges per surviving draft, in parallel.
    judge_results: dict[str, list[JudgeScoreCard]] = {
        d.angle: [] for d in surviving_drafts
    }
    judge_tasks: list[tuple[AngleKey, JudgeKey, asyncio.Task[AgentOutcome]]] = []
    for draft in surviving_drafts:
        for judge in TOURNAMENT_JUDGES:
            t = asyncio.create_task(
                _judge_one_draft_one_dimension(
                    judge=judge,
                    draft=draft,
                    facts=validated.facts,
                    banned_phrases=validated.banned_phrases,
                    ctx=ctx,
                )
            )
            judge_tasks.append((draft.angle, judge, t))

    judge_phase_budget = max(
        0.0, OUTREACH_TIMEOUT_S - (time.monotonic() - started_at)
    )
    try:
        await asyncio.wait_for(
            asyncio.gather(
                *(t for _, _, t in judge_tasks), return_exceptions=False
            ),
            timeout=judge_phase_budget if judge_phase_budget > 0 else 1.0,
        )
    except asyncio.TimeoutError:
        return Escalation(
            reason="tournament_timeout: judge phase exceeded budget",
            partial={"surviving_drafts": [d.angle for d in surviving_drafts]},
            usdSpent=cumulative_usd,
        )

    judge_errors: list[str] = []
    for angle, judge, task in judge_tasks:
        outcome = task.result()
        cumulative_usd += outcome.usd_spent
        if isinstance(outcome, OutcomeOk) and isinstance(outcome.value, JudgeScoreCard):
            judge_results[angle].append(outcome.value)
        else:
            judge_errors.append(
                f"angle={angle} judge={judge}: "
                f"{outcome.reason if isinstance(outcome, Escalation) else 'unexpected'}"
            )

    if cumulative_usd >= OUTREACH_WRITER_TOURNAMENT_MAX_USD:
        return Escalation(
            reason=(
                f"budget_exhausted: tournament spent ${cumulative_usd:.4f} "
                f"≥ cap ${OUTREACH_WRITER_TOURNAMENT_MAX_USD:.4f}"
            ),
            partial={
                "drafts_succeeded": len(surviving_drafts),
                "judge_errors": judge_errors[:5],
            },
            usdSpent=cumulative_usd,
        )

    # 6. Score every draft that has all 4 judge cards.
    scored: list[tuple[OutreachDraft, list[JudgeScoreCard], float]] = []
    for draft in surviving_drafts:
        cards = judge_results[draft.angle]
        if len(cards) < 4:
            judge_errors.append(
                f"angle={draft.angle}: only {len(cards)}/4 judges returned"
            )
            continue
        scores_by_judge: dict[JudgeKey, float] = {c.judge: c.score for c in cards}
        weighted = weighted_geometric_score(scores_by_judge)
        scored.append((draft, cards, weighted))

    if not scored:
        return Escalation(
            reason=(
                f"tournament_collapse: no draft accumulated a full 4-judge "
                f"scorecard (errors: {judge_errors[:3]})"
            ),
            partial={"judge_errors": judge_errors},
            usdSpent=cumulative_usd,
        )

    # 7. Winner = highest weighted geometric score.
    scored.sort(key=lambda triple: triple[2], reverse=True)
    winner_draft, winner_cards, winner_score = scored[0]

    if winner_score < OUTREACH_QUALITY_FLOOR:
        return Escalation(
            reason=(
                f"draft_below_quality_floor: top weighted score "
                f"{winner_score:.3f} < floor {OUTREACH_QUALITY_FLOOR}"
            ),
            partial={
                "top_angle": winner_draft.angle,
                "top_weighted_score": winner_score,
                "ranking": [(a.angle, s) for (a, _, s) in scored[:5]],
            },
            usdSpent=cumulative_usd,
        )

    scores_by_judge: dict[JudgeKey, float] = {c.judge: c.score for c in winner_cards}
    winner = OutreachTournamentWinner(
        subject=winner_draft.subject,
        body=winner_draft.body,
        angle=winner_draft.angle,
        spamScore=winner_draft.spam_score,
        groundedFacts=winner_draft.grounded_facts,
        locale=winner_draft.locale,
        judgeScores=JudgeScores(
            brand=scores_by_judge.get("brand", 0.0),
            conversion=scores_by_judge.get("conversion", 0.0),
            deliverability=scores_by_judge.get("deliverability", 0.0),
            skeptic=scores_by_judge.get("skeptic", 0.0),
        ),
        judgeScoreCards=winner_cards,
        weightedScore=winner_score,
    )

    elapsed_ms = int((time.monotonic() - started_at) * 1000)
    logger.info(
        "outreach_tournament_completed",
        extra={
            "agent_id": outreach_writer_agent_def.id,
            "trace_id": ctx.trace_id,
            "tenant_id": ctx.tenant_id,
            "campaign_id": ctx.campaign_id,
            "creator_unique_id": validated.facts.creator.unique_id,
            "winning_angle": winner.angle,
            "weighted_score": winner.weighted_score,
            "spam_score": winner.spam_score,
            "drafts_attempted": 5,
            "drafts_survived": len(surviving_drafts),
            "drafts_scored": len(scored),
            "usd_spent": cumulative_usd,
            "elapsed_ms": elapsed_ms,
        },
    )
    return OutcomeOk(value=winner, usdSpent=cumulative_usd)


# ─────────────────────────────────────────────────────────────────────────────
# __main__ — ad-hoc CLI invocation against live Vertex (SS_LIVE=1).
# ─────────────────────────────────────────────────────────────────────────────


if __name__ == "__main__":  # pragma: no cover
    """Run a single tournament against live Vertex.

    Requires:
        GOOGLE_GENAI_USE_VERTEXAI=TRUE
        GOOGLE_CLOUD_PROJECT=<…>
        GOOGLE_CLOUD_LOCATION=us-central1
        SS_LIVE=1
    """
    import asyncio
    import json

    async def main() -> None:
        ctx = RunContext(
            tenant_id="t_demo000000000000",
            workspace_id="ws_demo_outreach_writer",
            trace_id="trace-cli-outreach-1",
            campaign_id="c_demo_outreach_001",
        )
        payload = OutreachWriterInput(
            facts=OutreachFacts(
                creator=OutreachCreatorFacts(
                    uniqueId="beautyguru_kr",
                    nickname="K-Beauty Guru",
                    signature="Korean skincare reviews · DM for collabs",
                    topHashtags=["스킨케어", "kbeauty"],
                    recentPostThemes=["morning routine", "vitamin C review"],
                    followerCount=82_000,
                    avgViews=18_500,
                    engagementRate=0.041,
                ),
                brand=OutreachBrandFacts(
                    name="Freshly Vitamin C Serum",
                    category="skincare/serum",
                    description="Brightening vitamin C serum with hyaluronic acid.",
                    keyClaims=["10% vitamin C", "fragrance-free", "vegan"],
                ),
                logistics=OutreachLogisticsFacts(shipsSamples=True),
                hasMinimumContext=True,
            ),
            voiceNotes="warm, conversational, K-beauty native vocabulary",
            bannedPhrases=["urgent", "limited time"],
            locale="ko",
        )
        outcome = await run_outreach_tournament(payload, ctx)
        print(json.dumps(outcome.model_dump(by_alias=True), indent=2, default=str))

    asyncio.run(main())


__all__ = [
    "AngleKey",
    "JUDGE_WEIGHTS",
    "JudgeKey",
    "JudgeScoreCard",
    "JudgeScores",
    "Locale",
    "OUTREACH_QUALITY_FLOOR",
    "OUTREACH_SPAM_THRESHOLD_NORMALISED",
    "OUTREACH_SPAM_THRESHOLD_RAW",
    "OUTREACH_TIMEOUT_S",
    "OUTREACH_WRITER_TOURNAMENT_MAX_USD",
    "OutreachBrandFacts",
    "OutreachCreatorFacts",
    "OutreachDraft",
    "OutreachFacts",
    "OutreachLogisticsFacts",
    "OutreachTournamentWinner",
    "OutreachWriterInput",
    "TOURNAMENT_ANGLES",
    "TOURNAMENT_JUDGES",
    "build_drafter_system_prompt",
    "build_judge_system_prompt",
    "build_outreach_system_prompt",
    "outreach_drafter_agent_def",
    "outreach_judge_agent_def",
    "outreach_writer_agent_def",
    "run_outreach_tournament",
    "weighted_geometric_score",
]
