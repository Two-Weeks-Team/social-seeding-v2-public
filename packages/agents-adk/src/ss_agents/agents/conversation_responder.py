"""Conversation Responder agent — Tier-1 agent #5.

Direct port of v2's `packages/agents/src/conversation-responder.agent.ts:28-119`
onto ADK + Gemini 2.5 Pro + Pydantic, following the contract in
`gcp-research/specs/tier1/conversation_responder.spec.md`.

Behavior (conversation_responder.spec.md §1):
    Drafts ONE reply on a creator thread when the classifier
    (conversation #4) returned a turn that needs one (`interested` /
    `needs_info`). Cites only the OutreachFacts + verbatim incoming
    message, self-checks deliverability via outreach.judge before
    returning. Sending is a downstream workflow step gated by
    compliance (#13) + payment_mandate (#12) + `approveReplyResponse`.

Why a separate agent (not part of conversation #4):
    · classification fires on EVERY inbound; drafting is rarer.
      Split saves the Pro call on declines / OOO / unrelated / unsub.
    · classification needs cheap + JSON-strict (Flash). Drafting needs
      tone + judgment (Pro). Model routing carried from ARCHITECTURE.md §3.

Citations:
    D5  — Gemini 2.5 Pro (judgment-heavy creative drafting).
    D17 — Vertex AI Agent Runtime.
    D23 — Tier-1 agent #5 (Tier-1 #5 in the §4 fleet inventory).
    D25 — Learning loop: the `_OPTIMIZED` triage below is the deterministic,
          locally-runnable analogue of the prompt-rewrite half of D25's loop.
          The GA Vertex AI Prompt Optimizer (data-driven —
          `agent_optimizer_tune` live mode) is the production path; its live
          submission is wired (operator-gated). The measured before/after in
          `scripts/demo/HARDENING-CHAPTER.md` comes from this in-process LOCAL
          deterministic optimization pass over the synthetic set, not from the
          GA Prompt Optimizer.
    D27 — Drafted reply may carry AP2 Intent Mandate disclosure when a
          rate is proposed (escalation path; agent does NOT mint mandates).
    D32 — Observability: `triage_inbound` returns a structured `TriageDecision`
          so the stall→repair path is a span attribute, not buried in prose.
    D34 — Replies in the inbound's locale (ko/en/ja/zh-CN).
    ARCHITECTURE.md §3 row 5:
        conversation_responder | 1 | Gemini 2.5 Pro | templates.list,
                                  outreach.render | Memory Bank | response_match_v2

Hardening chapter (H1, GRAND-NARRATIVE-PLAN §5-1):
    The pre-LLM `triage_inbound` decides respond-vs-escalate BEFORE the
    expensive Pro draft. Two rule sets are kept so before/after is measurable
    on the SAME function:
      · `_baseline_triage` — the prompt-only era. Escalates on the literal
        `negotiating` class and on `has_minimum_context=False`, but MISSES the
        "interested/needs_info + proposed_rate_usd present" case → wrongly
        routes it to `respond`. THAT is the stall the chapter narrates.
      · `_optimized_triage` — adds the rate-signal rule (a proposed rate on an
        otherwise-positive class IS a negotiation → escalate), plus the soft-no
        and hallucination-prone classes. `triage_inbound` (the agent's live
        behavior) delegates to `_optimized_triage`, so this is real hardening.
"""
from __future__ import annotations

import logging
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ss_agents.runtime import AgentDef
from ss_agents.tools.gmail_send_reply import gmail_send_reply
from ss_agents.tools.memory_bank_search import memory_bank_search

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic mirrors of @ss/contracts — manually ported. Phase 3 will codegen
# from packages/contracts via SDD (D36). For now we mirror the fields the
# responder actually reads, not the entire contract surface.
# ─────────────────────────────────────────────────────────────────────────────


# ── ReplyClass (outreach.ts:111-120) ─────────────────────────────────────────


ReplyClass = Literal[
    "interested",     # wants to proceed
    "needs_info",     # asked a question we can answer
    "negotiating",    # rate/terms — should escalate
    "not_now",        # soft no
    "declined",       # hard no
    "out_of_office",
    "unsubscribe",
    "unrelated",
]


# ── OutreachFacts (outreach.ts:19-50) ────────────────────────────────────────


class CreatorFacts(BaseModel):
    """Mirrors OutreachFactsSchema.creator (outreach.ts:20-32)."""

    model_config = ConfigDict(extra="forbid")

    unique_id: str = Field(min_length=1, max_length=120, alias="uniqueId")
    """TikTok handle, e.g. '@freshly'."""
    nickname: str = Field(min_length=1, max_length=200)
    signature: str = Field(default="", max_length=500)
    """TikTok bio text."""
    top_hashtags: list[str] = Field(default_factory=list, alias="topHashtags", max_length=5)
    recent_post_themes: list[str] = Field(
        default_factory=list, alias="recentPostThemes", max_length=3
    )
    follower_count: int = Field(ge=0, alias="followerCount")
    avg_views: int | None = Field(default=None, ge=0, alias="avgViews")
    engagement_rate: float | None = Field(default=None, ge=0.0, le=1.0, alias="engagementRate")


class BrandFacts(BaseModel):
    """Mirrors OutreachFactsSchema.brand (outreach.ts:33-39)."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=2000)
    key_claims: list[str] = Field(default_factory=list, alias="keyClaims", max_length=20)


class LogisticsFacts(BaseModel):
    """Mirrors OutreachFactsSchema.logistics (outreach.ts:40-42)."""

    model_config = ConfigDict(extra="forbid")

    ships_samples: bool = Field(alias="shipsSamples")


class OutreachFacts(BaseModel):
    """Mirrors OutreachFactsSchema (outreach.ts:19-50)."""

    model_config = ConfigDict(extra="forbid")

    creator: CreatorFacts
    brand: BrandFacts
    logistics: LogisticsFacts
    has_minimum_context: bool = Field(alias="hasMinimumContext")
    """False when the creator profile has neither a signature nor recent post
    themes — the responder should escalate instead of inventing details."""


# ── ConversationTurn (outreach.ts:123-137) ───────────────────────────────────


class TurnExtracted(BaseModel):
    """Mirrors ConversationTurnSchema.extracted (outreach.ts:128-134)."""

    model_config = ConfigDict(extra="forbid")

    shipping_address: str | None = Field(default=None, alias="shippingAddress", max_length=500)
    proposed_rate_usd: float | None = Field(default=None, ge=0.0, alias="proposedRateUsd")
    question: str | None = Field(default=None, max_length=2000)


class ConversationTurnInput(BaseModel):
    """Mirrors ConversationTurnSchema (outreach.ts:123-137), minus the
    draftedReply field (omitted on input per v2 agent line 44:
    `ConversationTurnSchema.omit({ draftedReply: true })`)."""

    model_config = ConfigDict(extra="forbid")

    thread_id: str = Field(min_length=1, max_length=120, alias="threadId")
    creator_id: str = Field(min_length=1, max_length=120, alias="creatorId")
    incoming_message_id: str = Field(min_length=1, max_length=120, alias="incomingMessageId")
    classification: ReplyClass
    extracted: TurnExtracted = Field(default_factory=TurnExtracted)
    needs_human_reason: str | None = Field(default=None, alias="needsHumanReason", max_length=500)


# ── Thread history (spec §2 properties.Input.threadHistory) ──────────────────


class ThreadMessage(BaseModel):
    """One historical message on the thread, role-tagged.
    Per conversation_responder.spec.md §2."""

    model_config = ConfigDict(extra="forbid")

    role: Literal["us", "them"]
    subject: str = Field(default="", max_length=200)
    body_text: str = Field(default="", max_length=10_000, alias="bodyText")


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output schemas per conversation_responder.spec.md §2 + §6.
# ─────────────────────────────────────────────────────────────────────────────


class ConversationResponderInput(BaseModel):
    """Per conversation_responder.spec.md §2 properties.Input."""

    model_config = ConfigDict(extra="forbid")

    turn: ConversationTurnInput
    facts: OutreachFacts
    thread_history: list[ThreadMessage] = Field(
        default_factory=list, alias="threadHistory", max_length=20
    )
    voice_notes: str = Field(default="", alias="voiceNotes", max_length=2000)
    signature_block: str = Field(default="", alias="signatureBlock", max_length=1000)
    banned_phrases: list[str] = Field(
        default_factory=list, alias="bannedPhrases", max_length=50
    )
    locale: Literal["ko", "en", "ja", "zh-CN"] = "ko"


class ConversationResponderOutput(BaseModel):
    """Per conversation_responder.spec.md §2 properties.Output + §6.

    Mirrors v2 `OutreachDraftSchema.pick({subject,body}).extend({...})`
    (conversation-responder.agent.ts:68-71) with the spec §2 additions:
    `tone`, `spamScore`, `groundedFacts`, `skepticScore`, `revisionCount`.
    """

    model_config = ConfigDict(extra="forbid")

    subject: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=8000)
    tone: Literal["formal", "warm", "urgent"] = "warm"
    """Per spec brief: caller may route by tone for compliance preview."""
    spam_score: float = Field(default=0.0, ge=0.0, le=1.0, alias="spamScore")
    """Normalized 0-1 (v2 used 0-10). Escalation threshold: > 0.4."""
    deliverability_score: float = Field(
        default=0.0, ge=0.0, le=1.0, alias="deliverabilityScore"
    )
    """outreach.judge[deliverability] self-check result."""
    skeptic_score: float | None = Field(default=None, ge=0.0, le=1.0, alias="skepticScore")
    revision_count: int = Field(default=0, ge=0, le=2, alias="revisionCount")
    grounded_facts: list[str] = Field(
        default_factory=list, alias="groundedFacts", max_length=20
    )
    """Each item names a fact the body cites. Empty = no claim; flag
    'HALLUCINATION' as an item to force escalation per spec §6."""


# ─────────────────────────────────────────────────────────────────────────────
# H1 — pre-LLM triage. Decides respond vs escalate BEFORE the Pro draft.
#
# This is the "hardening chapter" core (GRAND-NARRATIVE-PLAN §5-1, D50). The
# function is pure + deterministic + offline (conftest SS_OFFLINE-safe): no LLM,
# no I/O. The agent calls `triage_inbound` (which delegates to the OPTIMIZED
# rule set) as its live, real behavior; the BASELINE rule set is retained only
# so the before/after pass-rate is measured on the SAME function surface.
# ─────────────────────────────────────────────────────────────────────────────


TriageAction = Literal["respond", "escalate"]
"""What the responder should do with an inbound BEFORE spending a Pro draft.

  · respond  → the inbound is a clean drafting case; proceed to the LLM.
  · escalate → route to the human queue (rate/terms, soft/hard no, missing
    context, or a class the responder has no business drafting for).
"""


TriageReasonTag = Literal[
    "clean_interested",          # interested/needs_info, no escalation trigger → respond
    "negotiation_class",         # classifier already tagged it `negotiating`
    "rate_signal_on_positive",   # interested/needs_info BUT a rate was proposed → negotiation
    "missing_context",           # facts.has_minimum_context == False
    "soft_no",                   # not_now — don't auto-nudge; a human decides cadence
    "hard_no",                   # declined / unsubscribe — never auto-reply
    "out_of_scope_class",        # out_of_office / unrelated — not a drafting case
]
"""Stable machine-readable reason for a TriageDecision. Surfaced as the
`triage.reason_tag` span attribute (D32) so the dashboard renders WHY a turn
stalled/escalated without re-deriving it from prose."""


class TriageDecision(BaseModel):
    """Result of the pre-LLM triage. Deterministic + content-blind enough to
    drive an OTel span attribute (D32) and the synthetic-set pass/fail check.

    Per GRAND-NARRATIVE-PLAN §5-1 (H1) the decision is `respond` or `escalate`
    with an explicit machine-readable `reason` tag — that tag is what the
    Observability "stall→repair" trace renders, and what the synthetic case set
    asserts against (`expected_reason_tag`)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    action: TriageAction
    reason: TriageReasonTag
    detail: str = Field(default="", max_length=240)
    """Human-readable one-liner for the operator queue / trace overlay."""


# Classes that must NEVER be auto-drafted (they are not a "draft a reply" case).
# Mirrors conversation_responder system-prompt step 7 + spec §6 escalation list.
_HARD_NO_CLASSES: frozenset[ReplyClass] = frozenset({"declined", "unsubscribe"})
_SOFT_NO_CLASSES: frozenset[ReplyClass] = frozenset({"not_now"})
_OUT_OF_SCOPE_CLASSES: frozenset[ReplyClass] = frozenset({"out_of_office", "unrelated"})
_DRAFTABLE_CLASSES: frozenset[ReplyClass] = frozenset({"interested", "needs_info"})


def _baseline_triage(
    turn: ConversationTurnInput, facts: OutreachFacts
) -> TriageDecision:
    """The prompt-only-era triage — DELIBERATELY under-powered.

    This reproduces the stall the chapter narrates. It escalates on:
      · the literal `negotiating` class (the classifier already labeled it),
      · `has_minimum_context == False`.
    It does NOT inspect `extracted.proposed_rate_usd`, so an `interested` or
    `needs_info` turn that carries a proposed rate — i.e. the creator IS
    negotiating but the classifier rounded them to "interested" — is wrongly
    routed to `respond`. The Pro drafter then stalls at the auto-respond ↔
    escalate boundary (it is told in step 7 to escalate negotiations, but the
    triage already sent it down the drafting path with no rate-handling fact).

    Kept ONLY for the before/after measurement; never wired as live behavior.
    """
    if not facts.has_minimum_context:
        return TriageDecision(
            action="escalate",
            reason="missing_context",
            detail="no signature and no recent post themes — nothing concrete to cite",
        )
    if turn.classification == "negotiating":
        return TriageDecision(
            action="escalate",
            reason="negotiation_class",
            detail="classifier tagged the turn as negotiating",
        )
    # BUG (the stall): everything else — including interested/needs_info that
    # carry a proposed rate — falls through to respond.
    return TriageDecision(
        action="respond",
        reason="clean_interested",
        detail=f"classified as {turn.classification}; drafting a reply",
    )


def _optimized_triage(
    turn: ConversationTurnInput, facts: OutreachFacts
) -> TriageDecision:
    """The hardened triage — the fix the Optimizer pass produces (H4).

    Adds, in priority order, the rules the baseline failures revealed:
      1. missing context  → escalate (unchanged from baseline).
      2. hard no (declined/unsubscribe) → escalate; never auto-reply.
      3. explicit `negotiating` class → escalate (unchanged).
      4. NEW — rate signal on a positive class: an `interested`/`needs_info`
         turn carrying `extracted.proposed_rate_usd` IS a negotiation that the
         classifier rounded down. Escalate as a negotiation. THIS closes the
         stall.
      5. soft no (not_now) → escalate; a human owns re-engagement cadence.
      6. out-of-scope classes (out_of_office/unrelated) → escalate.
      7. otherwise (clean interested/needs_info, no rate) → respond.
    """
    # 1. Missing context — same as baseline, highest priority (we have nothing
    #    truthful to cite).
    if not facts.has_minimum_context:
        return TriageDecision(
            action="escalate",
            reason="missing_context",
            detail="no signature and no recent post themes — nothing concrete to cite",
        )
    # 2. Hard no — declined / unsubscribe must never be auto-replied to.
    if turn.classification in _HARD_NO_CLASSES:
        return TriageDecision(
            action="escalate",
            reason="hard_no",
            detail=f"{turn.classification}: do not auto-reply; human-only close-out",
        )
    # 3. Explicit negotiation class.
    if turn.classification == "negotiating":
        return TriageDecision(
            action="escalate",
            reason="negotiation_class",
            detail="classifier tagged the turn as negotiating",
        )
    # 4. THE FIX — rate signal on an otherwise-positive class. A proposed rate
    #    means terms are on the table, even if the classifier said "interested".
    if (
        turn.classification in _DRAFTABLE_CLASSES
        and turn.extracted.proposed_rate_usd is not None
    ):
        return TriageDecision(
            action="escalate",
            reason="rate_signal_on_positive",
            detail=(
                f"classified {turn.classification} but a rate "
                f"(USD {turn.extracted.proposed_rate_usd}) was proposed — "
                "negotiation; escalate per D27 (agent does not mint mandates)"
            ),
        )
    # 5. Soft no — don't auto-nudge; a human decides whether/when to re-engage.
    if turn.classification in _SOFT_NO_CLASSES:
        return TriageDecision(
            action="escalate",
            reason="soft_no",
            detail="not_now: human owns re-engagement cadence",
        )
    # 6. Out-of-scope classes — not a drafting case at all.
    if turn.classification in _OUT_OF_SCOPE_CLASSES:
        return TriageDecision(
            action="escalate",
            reason="out_of_scope_class",
            detail=f"{turn.classification}: not a reply-drafting case",
        )
    # 7. Clean draftable case.
    return TriageDecision(
        action="respond",
        reason="clean_interested",
        detail=f"classified as {turn.classification}; drafting a reply",
    )


def triage_inbound(
    turn: ConversationTurnInput, facts: OutreachFacts
) -> TriageDecision:
    """The responder's LIVE pre-LLM gate (H1). Delegates to `_optimized_triage`.

    Call this BEFORE `run_agent`/`build_responder_system_prompt`. When it
    returns `action == "escalate"`, route to the human queue and DO NOT spend a
    Pro draft. When it returns `action == "respond"`, proceed to draft.

    This is real hardening, not a toy: the optimized rule set is wired as the
    agent's actual behavior. The baseline rule set (`_baseline_triage`) exists
    only for the measured before/after.
    """
    return _optimized_triage(turn, facts)


# ─────────────────────────────────────────────────────────────────────────────
# System prompt builder — port of conversation-responder.agent.ts:72-118.
# ─────────────────────────────────────────────────────────────────────────────


_LOCALE_SUFFIX = {
    "ko": "Respond in 한국어. Match the inbound's locale even if the original outreach was in a different language.",
    "en": "Respond in English. Match the inbound's locale even if the original outreach was in a different language.",
    "ja": "Respond in 日本語. Match the inbound's locale even if the original outreach was in a different language.",
    "zh-CN": "Respond in 简体中文. Match the inbound's locale even if the original outreach was in a different language.",
}


def build_responder_system_prompt(payload: BaseModel) -> str:
    """Per conversation_responder.spec.md §6 + conversation-responder.agent.ts:72-118.

    Mirrors the v2 prompt with two additions:
    1. Explicit locale hint (D34) — v2 inferred from the inbound; Gemini
       benefits from an explicit directive on which of the 4 locales to use.
    2. spam_score + grounded_facts output discipline per spec §2.
    """
    assert isinstance(payload, ConversationResponderInput), (
        f"unexpected input type: {type(payload)}"
    )

    turn = payload.turn
    facts = payload.facts
    history = payload.thread_history
    voice = payload.voice_notes
    banned = payload.banned_phrases
    locale_line = _LOCALE_SUFFIX.get(payload.locale, _LOCALE_SUFFIX["ko"])

    # Compose the "what we know" block — empty lines stripped at join time
    # (matches the v2 .filter(Boolean) pattern at line 117).
    sample_policy = (
        "WE ship a sample (free)."
        if facts.logistics.ships_samples
        else "NO sample — paid/affiliate only."
    )
    themes_line = (
        f"Creator themes we already cited (don't repeat verbatim): "
        f"{' / '.join(facts.creator.recent_post_themes)}."
        if facts.creator.recent_post_themes
        else ""
    )
    voice_line = f"Brand voice: {voice}" if voice else ""
    banned_line = f"Banned phrases: {', '.join(banned)}." if banned else ""

    # Extracted-facts block — only emit lines for fields that are set, so the
    # model isn't told about absent fields (mirrors v2's truthy filter).
    extracted_lines: list[str] = []
    if turn.extracted.question:
        extracted_lines.append(f"Their question (verbatim): {turn.extracted.question}")
    if turn.extracted.shipping_address:
        extracted_lines.append(
            f"Shipping address they shared: {turn.extracted.shipping_address}"
        )
    if turn.extracted.proposed_rate_usd is not None:
        extracted_lines.append(f"They proposed: USD {turn.extracted.proposed_rate_usd}.")

    # Thread history — last ≤6, oldest-first, per spec §8 edge case 3.
    if history:
        history_block_lines = [
            f"[{i + 1}] {'WE wrote' if t.role == 'us' else 'THEY wrote'}: "
            f"{t.subject or '(no subject)'}\n{t.body_text[:600]}"
            for i, t in enumerate(history[-6:])
        ]
        history_block = (
            "## Thread history (oldest-first, last ≤6)\n"
            + "\n\n".join(history_block_lines)
        )
    else:
        history_block = ""

    blocks: list[str] = [
        (
            f"You are the Conversation Responder. The thread is between us (the brand) "
            f"and @{facts.creator.unique_id} ({facts.creator.nickname}). The classifier "
            f"returned classification=\"{turn.classification}\"."
        ),
        "",
        "## What we know",
        f"Brand: {facts.brand.name} ({facts.brand.category}). "
        f"Key claims: {', '.join(facts.brand.key_claims) or '(none)'}.",
        f"Sample policy: {sample_policy}",
        themes_line,
        voice_line,
        banned_line,
        "",
        f"## The inbound message (classified as {turn.classification})",
        *extracted_lines,
        "",
        history_block,
        "",
        "## Procedure",
        "1. Decide what to address in the reply, in this priority order:",
        "   · interested + shippingAddress → confirm receipt, set expectation on shipping ETA + posting timeline.",
        "   · interested + no address     → ask for the shipping address. ONE clear question.",
        "   · needs_info                  → answer the literal question. No upsell.",
        "2. Draft a subject (≤ 80 chars) and a body (single paragraph or two short paragraphs; 200–800 visible chars).",
        "3. Call outreach.judge with judge='deliverability' on your draft. If score < 0.8, revise once and re-judge.",
        "   Report the final deliverabilityScore. Set revisionCount to the number of revise passes (0, 1, or 2).",
        "4. Self-estimate spamScore in [0, 1] using these heuristics: ALL-CAPS subject, multiple '!', vague urgency, "
        "   bait phrases (\"limited time\", \"act now\"), missing recipient handle. spamScore > 0.4 → escalate.",
        "5. Populate groundedFacts with a short name for each fact your body cites (e.g. 'brand.keyClaims[0]', "
        "   'creator.recentPostThemes[1]', 'logistics.shipsSamples'). If you would need to invent a fact not in this "
        "   prompt, append 'HALLUCINATION' to groundedFacts and escalate.",
        "6. Discipline:",
        "   · Use the recipient's nickname / @handle.",
        "   · Don't invent product specs not in brand.keyClaims.",
        "   · Don't promise samples when shipsSamples=false.",
        "   · Don't add an unsubscribe footer or tracking pixel — gmail.send adds those.",
        "   · No Re:/Fwd: prefixes (the deliverability judge will flag).",
        "7. If the inbound classification is in {declined, negotiating, unsubscribe, not_now, out_of_office, unrelated} "
        "   you should not be here — escalate via partial output + reason.",
        "8. If facts.hasMinimumContext is false, escalate (we have nothing concrete to cite).",
        # H4 / D25: the Optimizer pass added this clarification. The classifier
        # sometimes rounds a rate-bearing reply down to `interested`/`needs_info`;
        # a proposed rate means terms are on the table → it is a negotiation, so
        # escalate (the agent never mints AP2 mandates — D27). This mirrors the
        # `_optimized_triage` rate-signal rule that already gates this prompt.
        "9. A proposed rate is a NEGOTIATION SIGNAL: if the inbound names a USD rate / fee / 단가 / 報酬 / 报价 "
        "   (even when classified interested/needs_info), do NOT draft a reply — escalate. We do not negotiate "
        "   rates or mint payment mandates here (a human + the payment_mandate agent own that, per D27).",
        "",
        "Output JSON: { subject, body, tone, spamScore, deliverabilityScore, skepticScore, "
        "revisionCount, groundedFacts } — nothing else.",
        "",
        locale_line,
    ]

    return "\n".join(b for b in blocks if b != "")


# ─────────────────────────────────────────────────────────────────────────────
# AgentDef — the Pydantic config the runtime consumes.
# ─────────────────────────────────────────────────────────────────────────────


# D5: Gemini 2.5 Pro for judgment-heavy drafting. Per
# `gcp-research/decisions/DECISIONS.md` line 44 + ARCHITECTURE.md §3 row 5.
RESPONDER_MODEL = "gemini-2.5-pro"


conversation_responder_agent_def: AgentDef[
    ConversationResponderInput, ConversationResponderOutput
] = AgentDef(
    id="conversation-responder",
    description=(
        "Draft a single reply to a classified inbound creator message. Cites "
        "only the OutreachFacts + verbatim incoming message; self-checks "
        "deliverability via outreach.judge before returning. "
        "Per conversation_responder.spec.md (D23 Tier-1 agent #5)."
    ),
    model=RESPONDER_MODEL,
    # Brief asked for $0.05; spec §6 records the v2 lesson ($0.25 → $1.0 was
    # needed for Pro tool loops). We honor the brief here (it's the prompt
    # owner's explicit cap) but log the historical context.
    # If live runs trip BudgetExceeded, raise to $1.00 per spec §6, not via
    # an in-prompt nudge.
    max_usd=0.05,
    input_schema=ConversationResponderInput,
    output_schema=ConversationResponderOutput,
    system_prompt=build_responder_system_prompt,
    # W2-B7: wired in the capability-layer tools per D41.
    #   · gmail_send_reply    — sends the drafted reply on the existing thread.
    #     LIVE mode enforces the D10 allow-list ({app.2weeks@gmail.com}); stub
    #     mode forces dry_run=True so the agent can rehearse end-to-end
    #     without touching real Gmail.
    #   · memory_bank_search  — D33-bounded Memory Bank lookup so the drafter
    #     can cite brand-voice notes + prior thread context without inventing
    #     details. outreach.judge + templates.render remain Phase-3 wiring.
    tools=[gmail_send_reply, memory_bank_search],
    max_turns=6,  # spec §6 observed 4-6 turns in v2
)


__all__ = [
    "RESPONDER_MODEL",
    "BrandFacts",
    "ConversationResponderInput",
    "ConversationResponderOutput",
    "ConversationTurnInput",
    "CreatorFacts",
    "LogisticsFacts",
    "OutreachFacts",
    "ReplyClass",
    "ThreadMessage",
    "TriageAction",
    "TriageDecision",
    "TriageReasonTag",
    "TurnExtracted",
    "build_responder_system_prompt",
    "conversation_responder_agent_def",
    "triage_inbound",
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
            workspace_id="ws_demo_responder_cli",
            trace_id="trace-responder-cli-1",
        )
        payload = ConversationResponderInput(
            turn=ConversationTurnInput(
                threadId="thr_demo_001",
                creatorId="cr_demo_freshly",
                incomingMessageId="msg_demo_001",
                classification="interested",
                extracted=TurnExtracted(
                    shippingAddress="123 Test St, Seoul, KR 04524",
                ),
            ),
            facts=OutreachFacts(
                creator=CreatorFacts(
                    uniqueId="@freshly",
                    nickname="Freshly",
                    signature="Skincare reviews · Seoul",
                    recentPostThemes=["morning routine"],
                    followerCount=42_000,
                ),
                brand=BrandFacts(
                    name="Freshly Vitamin C Serum",
                    category="skincare/serum",
                    description="Brightening Vitamin C serum with HA.",
                    keyClaims=["10% vitamin C", "fragrance-free"],
                ),
                logistics=LogisticsFacts(shipsSamples=True),
                hasMinimumContext=True,
            ),
            locale="en",
        )
        outcome = await run_agent(conversation_responder_agent_def, payload, ctx)
        print(json.dumps(outcome.model_dump(by_alias=True), indent=2, default=str))

    asyncio.run(main())
