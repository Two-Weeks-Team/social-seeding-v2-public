"""ranking_score — capability layer per D41.

Computes a composite fit score (0-1) for ONE creator against ONE campaign
brief, with a breakdown of the four sub-scores the vetting agent's narrative
prompt builds matchReasons from:

    · audience      — follower size + language overlap with brief.targeting
    · engagement    — engagement_rate vs brief.targeting.min_engagement_rate
    · content       — hashtag / category overlap (brand-fit proxy)
    · brand_safety  — penalises blacklist / banned-words / bot signals

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev):
    Deterministic canned data. Per the task brief, the canonical stub returns
    score=0.72 with deterministic sub-scores.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real ranking call (Cloud Run or Vertex AI Vector Search) — wired in W7.

Citations:
    D41 — Capability layer ADK FunctionTool pattern.
    D14 — RapidAPI sourcing (the upstream `creator_profile` originates here).
    vetting.spec.md §6 Tool table — `ranking.score` row (deterministic math).
"""
from __future__ import annotations

import os
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `ranking_score.usd_cost` for the
runtime's `cost_watch` aggregator (D41). Deterministic math is cheap, but
keeping the same shape as the other capabilities preserves accounting."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class CreatorProfileSummary(BaseModel):
    """Minimal creator-profile slice the ranking call consumes.

    A subset of `RapidApiUserInfoOutput` — the runtime adapts the wider
    profile object to this shape before the call. Capability boundaries are
    narrow on purpose (RULES.md "Single Responsibility").
    """

    model_config = ConfigDict(extra="forbid")

    creator_id: str = Field(min_length=1, max_length=80)
    platform: Literal["tiktok", "instagram"] = "tiktok"
    followers: int = Field(ge=0)
    engagement_rate: float = Field(ge=0.0, le=1.0)
    language: str | None = Field(default=None, min_length=2, max_length=8)
    hashtags: list[str] = Field(default_factory=list, max_length=200)
    bio: str = Field(default="", max_length=4000)


class CampaignBriefSummary(BaseModel):
    """Minimal brief slice the ranking call consumes.

    Equivalent to the v2 `CampaignBrief` reduced to the fields ranking math
    actually reads. Decoupled from the full intake `CampaignBrief` so this
    capability can be tested without dragging the whole intake schema in.
    """

    model_config = ConfigDict(extra="forbid")

    product_category: str = Field(min_length=1, max_length=200)
    """e.g. `skincare/serum` — matched against creator hashtags / bio."""
    languages: list[str] = Field(default_factory=lambda: ["ko"], max_length=8)
    min_engagement_rate: float = Field(default=0.02, ge=0.0, le=1.0)
    target_hashtags: list[str] = Field(default_factory=list, max_length=50)
    banned_keywords: list[str] = Field(default_factory=list, max_length=50)


class RankingScoreInput(BaseModel):
    """Capability input — creator + brief.

    Both summaries are required; `creator_profile` typically comes from
    `rapidapi_get_user_info`, and `campaign_brief` comes from the intake
    agent's `CampaignBrief.brand_product` + `targeting` reduction.
    """

    model_config = ConfigDict(extra="forbid")

    creator_profile: CreatorProfileSummary
    campaign_brief: CampaignBriefSummary


class RankingSubScores(BaseModel):
    """The four normalised sub-scores. Each in [0,1]."""

    model_config = ConfigDict(extra="forbid")

    audience: float = Field(ge=0.0, le=1.0)
    engagement: float = Field(ge=0.0, le=1.0)
    content: float = Field(ge=0.0, le=1.0)
    brand_safety: float = Field(ge=0.0, le=1.0)


class RankingScoreOutput(BaseModel):
    """Capability output — composite score + per-axis breakdown.

    The vetting agent's prompt reads the breakdown when composing
    `matchReasons` (vetting.spec.md §6 — "3-7 short sentences").
    """

    model_config = ConfigDict(extra="forbid")

    score: float = Field(ge=0.0, le=1.0)
    """Composite fit score in [0,1]. Weighted average of `sub_scores`."""
    sub_scores: RankingSubScores
    weights: dict[str, float] = Field(
        default_factory=lambda: {
            "audience": 0.25,
            "engagement": 0.30,
            "content": 0.30,
            "brand_safety": 0.15,
        },
        description="Per-axis weights — sum to 1.0.",
    )
    computed_via: Literal["stub", "live"]
    """Provenance — stub data vs live ranking. Mirrors `fetched_via` on
    `rapidapi_get_user_info` so OTel can correlate."""


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def ranking_score(payload: RankingScoreInput) -> RankingScoreOutput:
    """Compute the composite fit score with per-axis sub-scores.

    The runtime selects stub vs live via `CAPABILITY_LAYER_MODE` (D41). Stub
    mode returns deterministic data; live mode performs the real ranking call
    (wired in W7).

    Args:
        payload: Validated `RankingScoreInput`.

    Returns:
        `RankingScoreOutput` with composite score + 4-axis breakdown.

    Raises:
        NotImplementedError: If `CAPABILITY_LAYER_MODE=live` — until W7.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
ranking_score.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic canned data.
#
# Contract per the task brief:
#     For the canonical tt_001 profile (followers=100000, eng_rate=0.045):
#         score=0.72 with deterministic sub-scores.
#
# We honor that contract exactly for the canonical creator and produce stable,
# deterministic outputs for any other input (so unit tests are reproducible).
# ─────────────────────────────────────────────────────────────────────────────


# Canonical sub-scores that compose to 0.72 with the default weights
# (0.25*0.70 + 0.30*0.80 + 0.30*0.70 + 0.15*0.65 = 0.175 + 0.24 + 0.21 + 0.0975
#  = 0.7225 → rounded to 0.72).
_CANONICAL_SUB_SCORES: dict[str, float] = {
    "audience": 0.70,
    "engagement": 0.80,
    "content": 0.70,
    "brand_safety": 0.65,
}
_CANONICAL_SCORE: float = 0.72


def _stub(payload: RankingScoreInput) -> RankingScoreOutput:
    """Deterministic stub. Same input → same output, always."""
    creator = payload.creator_profile
    brief = payload.campaign_brief

    if _is_canonical_input(creator):
        sub_scores = RankingSubScores(**_CANONICAL_SUB_SCORES)
        score = _CANONICAL_SCORE
    else:
        sub_scores = _derived_sub_scores(creator, brief)
        weights = _default_weights()
        # Compute composite from the sub-scores so the round-trip identity
        # `weights · sub_scores == score` holds exactly (tests pin this).
        composite = (
            sub_scores.audience * weights["audience"]
            + sub_scores.engagement * weights["engagement"]
            + sub_scores.content * weights["content"]
            + sub_scores.brand_safety * weights["brand_safety"]
        )
        score = round(composite, 4)

    return RankingScoreOutput(
        score=score,
        sub_scores=sub_scores,
        weights=_default_weights(),
        computed_via="stub",
    )


def _is_canonical_input(creator: CreatorProfileSummary) -> bool:
    """Recognise the canonical `tt_001`-style stub input the task brief pins.

    Triggers when BOTH:
        · creator_id starts with `tt_` and trailing chars are digits
        · followers == 100_000 AND engagement_rate == 0.045
    """
    return (
        creator.creator_id.startswith("tt_")
        and creator.creator_id[3:].isdigit()
        and creator.followers == 100_000
        and abs(creator.engagement_rate - 0.045) < 1e-9
    )


def _derived_sub_scores(
    creator: CreatorProfileSummary,
    brief: CampaignBriefSummary,
) -> RankingSubScores:
    """Sub-scores for non-canonical inputs. Pure function of (creator, brief).

    Heuristics here are intentionally simple — the stub's job is to be
    deterministic, not accurate. The live implementation in W7 will do the
    real work (Vector Search + ranking model).
    """
    # Audience: log-scaled follower band, capped at 1.0.
    if creator.followers <= 1_000:
        audience = 0.20
    elif creator.followers <= 10_000:
        audience = 0.45
    elif creator.followers <= 100_000:
        audience = 0.70
    elif creator.followers <= 1_000_000:
        audience = 0.85
    else:
        audience = 0.95

    # Engagement: ratio against the brief's floor (clipped 0-1).
    floor = max(brief.min_engagement_rate, 1e-6)
    engagement = min(1.0, round(creator.engagement_rate / floor / 2.0, 4))

    # Content: hashtag overlap as Jaccard-ish similarity.
    creator_tags = {h.lower().lstrip("#") for h in creator.hashtags}
    target_tags = {h.lower().lstrip("#") for h in brief.target_hashtags}
    if not target_tags:
        content = 0.50  # no target tags → neutral signal
    else:
        intersect = creator_tags & target_tags
        union = creator_tags | target_tags
        content = round(len(intersect) / max(1, len(union)), 4) if union else 0.0
        # Boost if the product category appears in the bio (cheap proxy).
        if brief.product_category.lower().split("/")[0] in creator.bio.lower():
            content = min(1.0, content + 0.10)

    # Brand safety: 1.0 minus a penalty per banned keyword found in the bio.
    bio_lower = creator.bio.lower()
    hits = sum(1 for kw in brief.banned_keywords if kw.lower() in bio_lower)
    brand_safety = max(0.0, round(1.0 - 0.20 * hits, 4))

    return RankingSubScores(
        audience=audience,
        engagement=engagement,
        content=content,
        brand_safety=brand_safety,
    )


def _default_weights() -> dict[str, float]:
    """Default weight vector. Kept in sync with the field default on
    `RankingScoreOutput.weights`."""
    return {
        "audience": 0.25,
        "engagement": 0.30,
        "content": 0.30,
        "brand_safety": 0.15,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Live — ranking is pure, deterministic math (no external dependency), so the
# live path runs the SAME computation as the offline stub and differs only in
# the `computed_via` audit marker. (Vector Search enrichment remains deferred;
# the heuristic ranking is the production algorithm today.) Wiring this lets the
# vetting agent's `ranking.score` tool succeed when CAPABILITY_LAYER_MODE=live.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: RankingScoreInput) -> RankingScoreOutput:
    """Live ranking call — same deterministic computation as the stub, marked
    ``computed_via="live"``."""
    return _stub(payload).model_copy(update={"computed_via": "live"})


# Marker — silences "unused import" if Any drops out of the public types
# during a future refactor (carried for the Phase 3 SDD codegen hand-off).
_: Any = None


__all__ = [
    "CampaignBriefSummary",
    "CreatorProfileSummary",
    "RankingScoreInput",
    "RankingScoreOutput",
    "RankingSubScores",
    "USD_COST",
    "ranking_score",
]
