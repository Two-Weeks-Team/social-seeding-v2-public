"""outreach_extract_facts — capability layer per D41.

Extracts a closed-set, structured `facts` payload from a creator profile so
the outreach_writer's drafter (and 4 judges) cite ONLY pre-vetted fields —
no hallucinated metrics, no invented mutual connections. Implements the
`outreach.extract_facts` capability declared in
`gcp-research/specs/tier1/outreach_writer.spec.md §6`:

    outreach.extract_facts | deterministic (closed-set) | The fact bench the
                                                          draft cites

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Returns deterministic facts derived from a canned `tt_001`-style creator
    profile (matches the W2-A1/A2 sibling stubs' canonical IDs so the full
    sourcing → vetting → outreach loop is reproducible offline). The returned
    `niche`, `recent_collabs[]`, `engagement_pattern`, and `contact_pref` are
    a pure function of `creator_profile.creator_id`.

Live mode (CAPABILITY_LAYER_MODE=live):
    Wired in W7 deploy phase — will run the v2 deterministic fact-extraction
    pipeline (bio parsing + TikTok signature heuristics + recent-post topic
    extraction). Today raises NotImplementedError so prod can never silently
    fall back to the stub.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D33 — Memory 14d. Extracted facts are written to the Memory Bank with
          a 14-day TTL (matches the data lifecycle); rendered drafts inherit
          the TTL.
    D21 — Model Armor scans the creator profile input + extracted fact output
          at the gateway. This module is the in-process layer that returns
          closed-set, type-safe values BEFORE the drafter sees them.

Per-call cost: $0.0001 (deterministic compute — no LLM call, no external HTTP).
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `outreach_extract_facts.usd_cost`
for the runtime's `cost_watch` aggregator (D41). Deterministic compute keeps
this sub-cent — the cost is dominated by the surrounding Pub/Sub round-trip."""


# ─────────────────────────────────────────────────────────────────────────────
# Input — a minimal creator profile. We accept ONLY the fields the v2
# fact-extraction step actually reads; the upstream sourcing/vetting stage
# carries the full TikTokCreator and projects to this shape.
# ─────────────────────────────────────────────────────────────────────────────


ContactPreference = Literal["email", "dm", "manager", "unknown"]
"""How the creator prefers to be contacted (parsed from signature + bio)."""


EngagementPattern = Literal[
    "high_consistency",
    "viral_outliers",
    "rising_steady",
    "declining",
    "low_activity",
]
"""Coarse engagement-curve label. The drafter uses this to choose which angle
fact-set is safest (e.g. `viral_outliers` rewards data_specific framing,
`declining` rewards aspirational)."""


class CreatorProfileInput(BaseModel):
    """The closed-set creator profile passed in. Mirrors a projection of
    `RapidApiUserInfoOutput` (the W2-A2 sibling tool) — kept independent so
    this module can be tested without that tool's deps.

    Attributes:
        creator_id:     TikTok handle / `uniqueId` (canonical `tt_001`-style
                        triggers the known-stub branch).
        nickname:       Display name. Used as a salutation in the rendered email.
        signature:      Public bio / signature text. Parsed for the contact
                        preference (`DM for collabs` → `dm`,
                        `manage@…` → `manager`, etc.).
        recent_post_themes: Up to 5 theme strings (e.g. ["morning routine",
                            "vitamin C review"]). Drives the `niche` inference.
        top_hashtags:   Up to 5 hashtag strings (no leading `#`).
        engagement_rate: 0-1 ratio. Feeds the engagement_pattern bucket.
        avg_views:      Mean view count across recent posts.
        follower_count: Headline follower count.
    """

    model_config = ConfigDict(extra="forbid")

    creator_id: str = Field(min_length=1, max_length=80, alias="creatorId")
    nickname: str = Field(default="", max_length=200)
    signature: str = Field(default="", max_length=4000)
    recent_post_themes: list[str] = Field(
        default_factory=list, max_length=5, alias="recentPostThemes"
    )
    top_hashtags: list[str] = Field(
        default_factory=list, max_length=5, alias="topHashtags"
    )
    engagement_rate: float = Field(
        default=0.0, ge=0.0, le=1.0, alias="engagementRate"
    )
    avg_views: int = Field(default=0, ge=0, alias="avgViews")
    follower_count: int = Field(default=0, ge=0, alias="followerCount")


# ─────────────────────────────────────────────────────────────────────────────
# Output — the spec's `{niche, recent_collabs[], engagement_pattern,
# contact_pref}` shape per the task brief.
# ─────────────────────────────────────────────────────────────────────────────


class RecentCollab(BaseModel):
    """One previously detected brand collab. Used by the peer_proof drafter
    angle (carefully: the drafter is forbidden from inventing collabs that
    are not in this list)."""

    model_config = ConfigDict(extra="forbid")

    brand_name: str = Field(min_length=1, max_length=200, alias="brandName")
    detected_in: Literal["bio", "signature", "recent_post_caption", "hashtag"] = (
        Field(alias="detectedIn")
    )
    confidence: float = Field(ge=0.0, le=1.0)


class OutreachExtractFactsOutput(BaseModel):
    """Capability output — the closed-set fact bench the drafter may cite.

    Mirrors the task brief's contract:
        `{niche, recent_collabs[], engagement_pattern, contact_pref}`.
    """

    model_config = ConfigDict(extra="forbid")

    niche: str = Field(
        min_length=1,
        max_length=80,
        description=(
            "Best-guess content niche (e.g. 'k-beauty/skincare', "
            "'fitness/strength', 'food/dessert'). Single string — coarse "
            "enough to be reliable, specific enough to be useful."
        ),
    )
    recent_collabs: list[RecentCollab] = Field(
        default_factory=list,
        max_length=10,
        alias="recentCollabs",
        description=(
            "Brand collaborations detected from public signals. Empty list "
            "is a legitimate finding — the drafter MUST handle it (e.g. "
            "peer_proof angle de-prioritises)."
        ),
    )
    engagement_pattern: EngagementPattern = Field(
        alias="engagementPattern",
        description=(
            "Coarse engagement-curve label. Stub uses engagement_rate as the "
            "proxy; live mode uses time-series analysis of the last 30 posts."
        ),
    )
    contact_pref: ContactPreference = Field(
        alias="contactPref",
        description=(
            "How the creator prefers to be contacted (email / dm / manager / "
            "unknown). Used to gate gmail.send vs Mission Control inbox steps."
        ),
    )
    fetched_via: Literal["stub", "live"] = Field(alias="fetchedVia")
    """OTel-friendly source label — distinguishes stub from real extraction."""


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def outreach_extract_facts(
    payload: CreatorProfileInput,
) -> OutreachExtractFactsOutput:
    """Extract closed-set facts from a creator profile.

    The runtime selects stub vs live via `CAPABILITY_LAYER_MODE` (D41). Stub
    mode returns deterministic facts derived from `creator_profile.creator_id`;
    live mode runs the v2 deterministic fact-extraction pipeline (wired in W7).

    Args:
        payload: Validated `CreatorProfileInput`.

    Returns:
        `OutreachExtractFactsOutput` — the closed-set fact bench the drafter
        + judges cite.

    Raises:
        NotImplementedError: when `CAPABILITY_LAYER_MODE=live` — until W7
            wires the real extraction pipeline. The runtime converts to a
            typed `EscalateToHuman`.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
outreach_extract_facts.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic facts derived from creator_id.
#
# Canonical IDs (`tt_001`-style — matches the W2-A2 rapidapi_get_user_info
# stub contract) return a fixed canned set. Non-canonical IDs derive from a
# tiny stable hash so determinism still holds for arbitrary test inputs.
# ─────────────────────────────────────────────────────────────────────────────


_CANONICAL_NICHE = "k-beauty/skincare"
"""The canonical `tt_001` creator is the K-Beauty Guru fixture used across
the outreach_writer spec + tests."""


_CANONICAL_RECENT_COLLABS: tuple[tuple[str, str, float], ...] = (
    ("Innisfree", "recent_post_caption", 0.92),
    ("Laneige", "bio", 0.78),
)
"""Two known collabs for the canonical `tt_001` creator. detected_in + score
chosen to exercise both the strong-confidence (>= 0.9) and medium-confidence
(0.5-0.9) paths in the peer_proof drafter angle."""


def _stub(payload: CreatorProfileInput) -> OutreachExtractFactsOutput:
    """Deterministic stub. Same `creator_id` → same output, always."""
    is_canonical = _is_canonical_id(payload.creator_id)
    if is_canonical:
        niche = _CANONICAL_NICHE
        recent_collabs = [
            RecentCollab(
                brandName=brand,
                detectedIn=where,  # type: ignore[arg-type]
                confidence=conf,
            )
            for (brand, where, conf) in _CANONICAL_RECENT_COLLABS
        ]
        # Canonical creator: 0.045 engagement → high_consistency bucket.
        engagement_pattern: EngagementPattern = "high_consistency"
        # Canonical signature says "DM for collabs".
        contact_pref: ContactPreference = "dm"
    else:
        h = _stable_hash(payload.creator_id)
        niche = _derive_niche(payload, h)
        recent_collabs = _derive_recent_collabs(payload, h)
        engagement_pattern = _derive_engagement_pattern(payload, h)
        contact_pref = _derive_contact_pref(payload)

    logger.debug(
        "outreach_extract_facts_stub",
        extra={
            "creator_id": payload.creator_id,
            "niche": niche,
            "engagement_pattern": engagement_pattern,
            "contact_pref": contact_pref,
            "recent_collabs_count": len(recent_collabs),
        },
    )
    return OutreachExtractFactsOutput(
        niche=niche,
        recentCollabs=recent_collabs,
        engagementPattern=engagement_pattern,
        contactPref=contact_pref,
        fetchedVia="stub",
    )


def _is_canonical_id(creator_id: str) -> bool:
    """True for `tt_001`-style IDs per the W2 sibling contracts.

    Pattern: `tt_` prefix + 1-6 digits (e.g. `tt_001`, `tt_42`). Matches
    `rapidapi_get_user_info._is_canonical_id` so the two stubs agree on
    what counts as a known fixture.
    """
    if not creator_id.startswith("tt_"):
        return False
    suffix = creator_id[3:]
    return bool(suffix) and suffix.isdigit() and len(suffix) <= 6


def _stable_hash(s: str) -> int:
    """Tiny FNV-style 32-bit hash. Deterministic across Python versions
    (unlike `hash()`, which is salted per-process). Same implementation as
    `rapidapi_get_user_info._stable_hash` so cross-tool reasoning stays
    reproducible."""
    h = 0x811C9DC5
    for ch in s.encode("utf-8"):
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


_NICHE_BANK: tuple[str, ...] = (
    "lifestyle/general",
    "fitness/strength",
    "food/dessert",
    "tech/gadgets",
    "fashion/streetwear",
    "travel/budget",
    "gaming/casual",
    "education/study",
)


def _derive_niche(payload: CreatorProfileInput, h: int) -> str:
    """Derive a coarse niche label from hashtags + post themes + a stable hash.

    Priority order:
      1. If a known hashtag matches a niche keyword, use that.
      2. Otherwise, pick from `_NICHE_BANK` indexed by the hash.
    """
    keyword_to_niche: dict[str, str] = {
        "fitness": "fitness/strength",
        "gym": "fitness/strength",
        "food": "food/dessert",
        "recipe": "food/dessert",
        "tech": "tech/gadgets",
        "gadget": "tech/gadgets",
        "fashion": "fashion/streetwear",
        "outfit": "fashion/streetwear",
        "travel": "travel/budget",
        "gaming": "gaming/casual",
        "study": "education/study",
    }
    haystack: list[str] = []
    haystack.extend(t.lower() for t in payload.top_hashtags)
    haystack.extend(t.lower() for t in payload.recent_post_themes)
    haystack.append(payload.signature.lower())
    haystack.append(payload.nickname.lower())
    joined = " ".join(haystack)
    for keyword, niche in keyword_to_niche.items():
        if keyword in joined:
            return niche
    return _NICHE_BANK[h % len(_NICHE_BANK)]


def _derive_recent_collabs(
    payload: CreatorProfileInput, h: int
) -> list[RecentCollab]:
    """Derive 0-3 recent collabs deterministically from the hash.

    We intentionally return EMPTY about a third of the time — empty
    recent_collabs is a real-world finding and the drafter must handle it.
    """
    # Deterministic "did we detect any collabs?" decision.
    if h % 3 == 0:
        return []

    count = 1 + ((h >> 4) % 2)  # 1 or 2 collabs
    brand_bank = (
        "Acme",
        "Nimbus",
        "Vertex",
        "Lumen",
        "Aster",
        "Quartz",
    )
    sources: tuple[Literal["bio", "signature", "recent_post_caption", "hashtag"], ...] = (
        "recent_post_caption",
        "bio",
        "hashtag",
    )
    collabs: list[RecentCollab] = []
    for i in range(count):
        brand_idx = (h >> (8 + i * 4)) % len(brand_bank)
        src_idx = (h >> (12 + i * 4)) % len(sources)
        # Confidence in [0.40, 0.95]. Higher when detected_in == 'recent_post_caption'.
        base = 0.40 + ((h >> (16 + i * 4)) % 56) / 100.0
        confidence = round(min(0.95, base), 4)
        collabs.append(
            RecentCollab(
                brandName=brand_bank[brand_idx],
                detectedIn=sources[src_idx],
                confidence=confidence,
            )
        )
    return collabs


def _derive_engagement_pattern(
    payload: CreatorProfileInput, h: int
) -> EngagementPattern:
    """Map engagement_rate + a hash bit to one of 5 engagement buckets.

    Buckets (engagement_rate in 0-1 space):
      ≥ 0.06 → viral_outliers
      ≥ 0.03 → high_consistency
      ≥ 0.015 → rising_steady
      ≥ 0.005 → declining
      < 0.005 → low_activity
    """
    rate = payload.engagement_rate
    if rate >= 0.06:
        return "viral_outliers"
    if rate >= 0.03:
        return "high_consistency"
    if rate >= 0.015:
        return "rising_steady"
    if rate >= 0.005:
        return "declining"
    return "low_activity"


def _derive_contact_pref(payload: CreatorProfileInput) -> ContactPreference:
    """Parse the public signature for contact-preference signals.

    Heuristic order:
      1. Email regex hit → email
      2. 'DM for…' / 'message' / 'inbox' → dm
      3. 'managed by' / 'manager' → manager
      4. else → unknown
    """
    sig = payload.signature.lower()
    if "@" in sig and "." in sig:
        return "email"
    if "dm for" in sig or "message" in sig or "inbox" in sig:
        return "dm"
    if "managed by" in sig or "manager" in sig or "agency" in sig:
        return "manager"
    return "unknown"


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Today raises NotImplementedError so the
# runtime can convert to a typed `EscalateToHuman`.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: CreatorProfileInput) -> OutreachExtractFactsOutput:
    """Live extraction — wired in W7 deploy phase."""
    raise NotImplementedError("live mode wired in W7 deploy phase")


__all__ = [
    "ContactPreference",
    "CreatorProfileInput",
    "EngagementPattern",
    "OutreachExtractFactsOutput",
    "RecentCollab",
    "USD_COST",
    "outreach_extract_facts",
]
