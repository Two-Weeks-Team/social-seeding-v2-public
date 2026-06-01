"""Tests for `ranking_score` capability — per D41.

Coverage:
    · stub determinism (same input → byte-identical output on a re-run)
    · canonical contract (score=0.72 with deterministic sub-scores)
    · live mode raises `NotImplementedError` until W7
    · weighted-sum identity holds for non-canonical inputs
    · Pydantic input validation rejects malformed payloads
    · `usd_cost` attribute present per D41 (cost_watch surface)
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.ranking_score import (
    USD_COST,
    CampaignBriefSummary,
    CreatorProfileSummary,
    RankingScoreInput,
    RankingScoreOutput,
    RankingSubScores,
    ranking_score,
)


# ─────────────────────────────────────────────────────────────────────────────
# Env hygiene — every test forces stub mode unless it explicitly opts into
# live to exercise the NotImplementedError path.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _stub_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default every test to stub mode (D41 default)."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures — canonical + non-canonical inputs.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def canonical_input() -> RankingScoreInput:
    """The canonical `tt_001` profile the task brief pins at score=0.72."""
    return RankingScoreInput(
        creator_profile=CreatorProfileSummary(
            creator_id="tt_001",
            platform="tiktok",
            followers=100_000,
            engagement_rate=0.045,
            language="ko",
            hashtags=["skincare", "kbeauty"],
            bio="K-beauty skincare creator",
        ),
        campaign_brief=CampaignBriefSummary(
            product_category="skincare/serum",
            languages=["ko"],
            min_engagement_rate=0.02,
            target_hashtags=["skincare", "vitaminC"],
        ),
    )


@pytest.fixture
def non_canonical_input() -> RankingScoreInput:
    """A different profile that takes the non-canonical (`_derived_*`) branch."""
    return RankingScoreInput(
        creator_profile=CreatorProfileSummary(
            creator_id="beautyguru_kr",
            platform="tiktok",
            followers=82_000,
            engagement_rate=0.041,
            language="ko",
            hashtags=["skincare", "haircare"],
            bio="Beauty content from Seoul",
        ),
        campaign_brief=CampaignBriefSummary(
            product_category="skincare/serum",
            languages=["ko"],
            min_engagement_rate=0.03,
            target_hashtags=["skincare", "kbeauty"],
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
# usd_cost attribute — D41 requirement.
# ─────────────────────────────────────────────────────────────────────────────


def test_usd_cost_attribute_present() -> None:
    """Per D41 the tool must expose `usd_cost` for the cost_watch aggregator."""
    assert hasattr(ranking_score, "usd_cost")
    assert ranking_score.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(ranking_score.usd_cost, float)  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub determinism + canonical contract.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_canonical_contract_score_072(canonical_input: RankingScoreInput) -> None:
    """Task brief: canonical input returns score=0.72 with deterministic
    sub-scores (audience=0.70, engagement=0.80, content=0.70, brand_safety=0.65)."""
    out = ranking_score(canonical_input)

    assert isinstance(out, RankingScoreOutput)
    assert out.score == 0.72
    assert out.sub_scores.audience == 0.70
    assert out.sub_scores.engagement == 0.80
    assert out.sub_scores.content == 0.70
    assert out.sub_scores.brand_safety == 0.65
    assert out.computed_via == "stub"


def test_stub_canonical_weights_sum_to_one(canonical_input: RankingScoreInput) -> None:
    """The default weights vector must be a valid probability vector."""
    out = ranking_score(canonical_input)
    assert sum(out.weights.values()) == pytest.approx(1.0)
    assert set(out.weights.keys()) == {"audience", "engagement", "content", "brand_safety"}


def test_stub_is_deterministic_canonical(canonical_input: RankingScoreInput) -> None:
    """Same canonical input → byte-identical output across calls."""
    a = ranking_score(canonical_input)
    b = ranking_score(canonical_input)
    assert a.model_dump_json() == b.model_dump_json()


def test_stub_is_deterministic_non_canonical(
    non_canonical_input: RankingScoreInput,
) -> None:
    """Same non-canonical input → byte-identical output across calls."""
    a = ranking_score(non_canonical_input)
    b = ranking_score(non_canonical_input)
    assert a.model_dump_json() == b.model_dump_json()


def test_stub_non_canonical_weights_identity(
    non_canonical_input: RankingScoreInput,
) -> None:
    """For non-canonical inputs, composite score == weighted sum of sub-scores
    (within rounding) — pins the math contract so future refactors don't drift."""
    out = ranking_score(non_canonical_input)
    composite = (
        out.sub_scores.audience * out.weights["audience"]
        + out.sub_scores.engagement * out.weights["engagement"]
        + out.sub_scores.content * out.weights["content"]
        + out.sub_scores.brand_safety * out.weights["brand_safety"]
    )
    assert out.score == pytest.approx(composite, abs=1e-4)


def test_stub_two_different_profiles_yield_different_scores(
    canonical_input: RankingScoreInput,
    non_canonical_input: RankingScoreInput,
) -> None:
    """Sanity: the stub isn't returning a constant for every profile."""
    a = ranking_score(canonical_input)
    b = ranking_score(non_canonical_input)
    assert a.model_dump_json() != b.model_dump_json()


def test_stub_score_in_unit_interval(non_canonical_input: RankingScoreInput) -> None:
    """The composite score is always in [0,1] regardless of profile."""
    out = ranking_score(non_canonical_input)
    assert 0.0 <= out.score <= 1.0
    assert 0.0 <= out.sub_scores.audience <= 1.0
    assert 0.0 <= out.sub_scores.engagement <= 1.0
    assert 0.0 <= out.sub_scores.content <= 1.0
    assert 0.0 <= out.sub_scores.brand_safety <= 1.0


def test_stub_brand_safety_drops_on_banned_keywords() -> None:
    """Brand-safety axis must penalise banned-keyword presence in the bio."""
    payload = RankingScoreInput(
        creator_profile=CreatorProfileSummary(
            creator_id="dodgy_creator",
            followers=50_000,
            engagement_rate=0.04,
            language="en",
            hashtags=["lifestyle"],
            bio="I love gambling and crypto schemes",
        ),
        campaign_brief=CampaignBriefSummary(
            product_category="skincare/serum",
            languages=["en"],
            min_engagement_rate=0.02,
            target_hashtags=["skincare"],
            banned_keywords=["gambling", "crypto"],
        ),
    )
    out = ranking_score(payload)
    # 2 banned keywords matched → 1.0 - 0.20*2 = 0.60.
    assert out.sub_scores.brand_safety == 0.60


# ─────────────────────────────────────────────────────────────────────────────
# Live mode — same deterministic math as the stub, marked computed_via="live".
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_computes_same_math_marked_live(
    monkeypatch: pytest.MonkeyPatch, canonical_input: RankingScoreInput
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    stub_out = ranking_score(canonical_input)
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    live_out = ranking_score(canonical_input)
    assert live_out.computed_via == "live"
    assert stub_out.computed_via == "stub"
    # Ranking is pure math — the score + sub-scores must be identical.
    assert live_out.score == stub_out.score
    assert live_out.sub_scores == stub_out.sub_scores


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic input validation — fail closed.
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_engagement_rate_out_of_range() -> None:
    with pytest.raises(ValidationError):
        CreatorProfileSummary(
            creator_id="x",
            followers=1,
            engagement_rate=1.5,  # > 1.0
        )


def test_input_rejects_negative_followers() -> None:
    with pytest.raises(ValidationError):
        CreatorProfileSummary(creator_id="x", followers=-1, engagement_rate=0.04)


def test_input_rejects_extra_fields() -> None:
    """`extra=forbid` on the input payload."""
    with pytest.raises(ValidationError):
        RankingScoreInput.model_validate(
            {
                "creator_profile": {
                    "creator_id": "tt_001",
                    "platform": "tiktok",
                    "followers": 100_000,
                    "engagement_rate": 0.045,
                    "unknown": "x",
                },
                "campaign_brief": {
                    "product_category": "skincare/serum",
                },
            }
        )


def test_sub_scores_must_be_in_unit_interval() -> None:
    """Output schema enforces [0,1] on every axis."""
    with pytest.raises(ValidationError):
        RankingSubScores(audience=1.2, engagement=0.5, content=0.5, brand_safety=0.5)


def test_output_score_must_be_in_unit_interval() -> None:
    """Composite score is also constrained to [0,1]."""
    with pytest.raises(ValidationError):
        RankingScoreOutput(
            score=1.1,
            sub_scores=RankingSubScores(
                audience=0.5, engagement=0.5, content=0.5, brand_safety=0.5
            ),
            computed_via="stub",
        )
