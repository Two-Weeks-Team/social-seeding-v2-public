"""gmail_thread_classify — capability layer per D41.

Deterministic 8-way classifier for inbound Gmail threads, used as a *pre-LLM*
signal by the conversation agent (Tier-1 #4). This is **not** the agent —
it's the closed-set capability the agent invokes when it wants a fast,
deterministic second opinion (string-matching the body for high-confidence
patterns) before / instead of paying for a Flash-Lite call.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Pure keyword-matching against the inbound body + (optionally) the
    sender domain. Returns one of 8 ReplyCategory values + a confidence in
    [0, 1] + the matched signal keywords. Deterministic by construction:
    same body → same classification → same confidence, byte-identical.

Live mode (CAPABILITY_LAYER_MODE=live):
    Wired in W7 deploy phase — will run the v2 deterministic classifier on
    Vertex (NL Cloud entity sentiment + a small Gemini judge for edge cases).
    Today raises NotImplementedError so prod can never silently fall back
    to the stub.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D10 — Gmail demo: only `app.2weeks@gmail.com` is operator-owned. Classify
          freely; *sending* is what's allow-listed (see gmail_send_reply).
    D33 — Memory 14d. Classification results may be persisted to Firestore
          Memory Bank with a 14-day TTL; the tool itself is stateless.
    conversation.spec.md §6 — 8-way classification + `needsHumanReason`
          escalation conditions (negotiating / declined / unsubscribe →
          always escalate).

Per-call cost: $0.0001 (deterministic compute — no LLM call, no external HTTP).
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `gmail_thread_classify.usd_cost`
for the runtime's `cost_watch` aggregator (D41). Deterministic compute keeps
this sub-cent — the cost is dominated by surrounding Pub/Sub round-trip."""


# ─────────────────────────────────────────────────────────────────────────────
# Output enum — the 8 categories the conversation agent branches on.
#
# This is the *capability-layer* enum, which is intentionally a different
# label set from `conversation.ReplyClass` (which mirrors the v2 contract
# verbatim). The capability returns coarser, "is this conversation
# actionable?" buckets; the agent does the nuanced 8-way mapping. The two
# sets overlap in spirit but the capability layer keeps the names the brief
# specifies.
# ─────────────────────────────────────────────────────────────────────────────


ReplyCategory = Literal[
    "interested",
    "needs_more_info",
    "unavailable",
    "negotiating",
    "accepted",
    "declined",
    "off_topic",
    "spam",
]
"""8-way coarse category. Order is significant (most → least actionable),
mirroring `conversation.ReplyClass` shape so downstream branches stay in sync."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class GmailThreadClassifyInput(BaseModel):
    """Input contract — per W2-B7 task brief.

    Attributes:
        thread_id:           Gmail thread id (`thr_…` or RFC-2822 Message-ID
                             prefix). Echoed only via OTel — the classifier
                             itself is stateless on this field.
        latest_message_body: Plain-text body (already HTML-stripped +
                             quote-stripped upstream). Capped at 20 000 chars
                             to mirror conversation.spec.md §8 #5; longer
                             bodies are truncated by the caller.
        sender_email:        RFC-5322 'From:' header. Shape-validated only —
                             we don't pull in `email-validator` for one field.
        language_hint:       Operator-locale hint (D34). The stub matches the
                             same English keywords across locales (the
                             agent's prompt does the heavy locale work);
                             the field is recorded for OTel + future live
                             implementations.
    """

    model_config = ConfigDict(extra="forbid")

    thread_id: str = Field(min_length=1, max_length=120)
    latest_message_body: str = Field(min_length=1, max_length=20_000)
    sender_email: str = Field(
        min_length=3,
        max_length=320,
        pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$",
    )
    language_hint: Literal["ko", "en", "ja", "zh-CN"] | None = None


class GmailThreadClassifyOutput(BaseModel):
    """Output contract — per W2-B7 task brief.

    Attributes:
        category:        One of the 8 ReplyCategory values.
        confidence_0_1:  Classifier confidence in [0, 1]. Anything below 0.6
                         should make the caller escalate per
                         conversation.spec.md §6.
        signal_keywords: The keywords actually matched in the body, in the
                         order they were detected. Empty list ⇒ no strong
                         signal → category typically defaults to `off_topic`
                         with a low confidence.
        requires_human:  True iff the category is one that ALWAYS escalates
                         (`negotiating`, `declined`, `spam`) OR confidence
                         is below 0.6. Mirrors conversation.spec.md §6
                         escalation conditions.
    """

    model_config = ConfigDict(extra="forbid")

    category: ReplyCategory
    confidence_0_1: float = Field(ge=0.0, le=1.0)
    signal_keywords: list[str] = Field(default_factory=list, max_length=20)
    requires_human: bool


# ─────────────────────────────────────────────────────────────────────────────
# Keyword bank — the closed-set signal vocabulary.
#
# Entries are (canonical_keyword, ReplyCategory). The stub looks for each
# keyword as a *substring* of the lowercased body. Multiple matches accumulate
# into `signal_keywords[]`; the *first* match wins as the category (so order
# below = match priority).
#
# Order rationale: the most decisive / hard-no signals are listed first so
# they outrank softer signals (e.g. `unsubscribe` > `not now` > `interested`).
# This mirrors the conversation.spec.md §6 escalation order.
# ─────────────────────────────────────────────────────────────────────────────


_KEYWORD_BANK: tuple[tuple[str, ReplyCategory], ...] = (
    # === spam / off_topic — domain-style markers, evaluated first ===
    ("viagra", "spam"),
    ("crypto giveaway", "spam"),
    ("nigerian prince", "spam"),
    ("won the lottery", "spam"),
    # === declined — hard no ===
    ("unsubscribe", "declined"),
    ("remove me", "declined"),
    ("do not contact", "declined"),
    ("don't contact", "declined"),
    ("not interested", "declined"),
    ("no thank you", "declined"),
    ("no thanks", "declined"),
    # === unavailable — soft no / OOO ===
    ("out of office", "unavailable"),
    ("on vacation", "unavailable"),
    ("on holiday", "unavailable"),
    ("not now", "unavailable"),
    ("maybe later", "unavailable"),
    ("currently unavailable", "unavailable"),
    ("busy this month", "unavailable"),
    # === negotiating — rate / terms / counter-offer ===
    ("my rate is", "negotiating"),
    ("my fee is", "negotiating"),
    ("counter-offer", "negotiating"),
    ("counter offer", "negotiating"),
    ("how about", "negotiating"),  # generic counter, e.g. "How about $X?"
    ("usd", "negotiating"),
    ("$", "negotiating"),
    # === accepted — explicit agreement ===
    ("i accept", "accepted"),
    ("i agree", "accepted"),
    ("sounds good", "accepted"),
    ("let's do it", "accepted"),
    ("lets do it", "accepted"),
    ("count me in", "accepted"),
    # === needs_more_info — explicit question ===
    ("?", "needs_more_info"),
    ("could you", "needs_more_info"),
    ("can you tell", "needs_more_info"),
    ("more details", "needs_more_info"),
    ("more info", "needs_more_info"),
    ("what is", "needs_more_info"),
    # === interested — soft positive ===
    ("interested", "interested"),
    ("looks great", "interested"),
    ("looking forward", "interested"),
    ("happy to", "interested"),
    ("would love", "interested"),
    ("ship to", "interested"),
    ("send to", "interested"),
    ("my address", "interested"),
)
"""Closed-set keyword vocabulary. Order = priority — earlier entries dominate."""


_ALWAYS_ESCALATE: frozenset[ReplyCategory] = frozenset(
    {"negotiating", "declined", "spam"}
)
"""Categories that ALWAYS set `requires_human=True`, mirroring
conversation.spec.md §6 escalation conditions."""


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def gmail_thread_classify(
    payload: GmailThreadClassifyInput,
) -> GmailThreadClassifyOutput:
    """Classify a Gmail thread's latest message into one of 8 categories.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated `GmailThreadClassifyInput`.

    Returns:
        `GmailThreadClassifyOutput` with the resolved category, confidence,
        matched signal keywords, and `requires_human` escalation flag.

    Raises:
        NotImplementedError: when `CAPABILITY_LAYER_MODE=live` — until W7
            wires the real classifier. The runtime converts to a typed
            `EscalateToHuman`.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
gmail_thread_classify.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic keyword-match classifier.
#
# Algorithm:
#   1. Lowercase the body.
#   2. Walk _KEYWORD_BANK in order; collect every match into
#      `signal_keywords[]`. The FIRST match's category wins.
#   3. If no keyword matches, category = "off_topic" with confidence=0.3.
#   4. Confidence is a function of (a) the winning category's "always
#      escalate" status (those get a baseline of 0.9), (b) the number of
#      reinforcing matches (each extra match adds 0.05, capped at 1.0).
#   5. `requires_human` = winning category ∈ _ALWAYS_ESCALATE OR
#      confidence < 0.6.
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: GmailThreadClassifyInput) -> GmailThreadClassifyOutput:
    """Deterministic stub. Same body → same output, always."""
    body_lower = payload.latest_message_body.lower()

    winning_category: ReplyCategory | None = None
    matched_keywords: list[str] = []

    for keyword, category in _KEYWORD_BANK:
        if keyword in body_lower:
            matched_keywords.append(keyword)
            if winning_category is None:
                winning_category = category

    if winning_category is None:
        # No keyword hit → off_topic with low confidence. Caller decides
        # whether to escalate (requires_human=True since confidence < 0.6).
        category: ReplyCategory = "off_topic"
        confidence = 0.3
    else:
        category = winning_category
        # Baseline 0.7 for "found at least one signal". +0.05 per extra
        # reinforcing match. +0.2 if the winning category is always-escalate
        # (these are unambiguous patterns).
        baseline = 0.9 if category in _ALWAYS_ESCALATE else 0.7
        bonus = 0.05 * max(0, len(matched_keywords) - 1)
        confidence = min(1.0, baseline + bonus)

    requires_human = category in _ALWAYS_ESCALATE or confidence < 0.6

    logger.debug(
        "gmail_thread_classify_stub",
        extra={
            "thread_id": payload.thread_id,
            "category": category,
            "confidence": confidence,
            "match_count": len(matched_keywords),
            "requires_human": requires_human,
        },
    )

    return GmailThreadClassifyOutput(
        category=category,
        confidence_0_1=round(confidence, 4),
        signal_keywords=matched_keywords,
        requires_human=requires_human,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Today raises NotImplementedError so the
# runtime can convert to a typed `EscalateToHuman`.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: GmailThreadClassifyInput) -> GmailThreadClassifyOutput:
    """Live classifier — wired in W7 deploy phase."""
    raise NotImplementedError(
        "gmail_thread_classify live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "GmailThreadClassifyInput",
    "GmailThreadClassifyOutput",
    "ReplyCategory",
    "USD_COST",
    "gmail_thread_classify",
]
