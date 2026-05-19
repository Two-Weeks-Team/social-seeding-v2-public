"""Unit tests for ``agent.py`` — heuristic ranker path.

These tests exercise the agent core without ADK / Vertex AI. The MCP client
is in stub mode (``MCP_BASE_URL=""``) so calls return canned creator data.

What's verified:
    * plan_creator_search returns ≤ DEFAULT_TOP_N creators.
    * All creators clear the FOLLOWER_SPAM_THRESHOLD.
    * source_attribution string is present (license terms).
    * Engagement rate stays in [0, 1].
    * Fit score stays in [0, 1].
    * Empty brief raises ValueError.
    * Model Armor block on input short-circuits and returns 0 creators with
      a trace.blocked_by entry.
    * RankedCreators model round-trips via JSON.
"""

from __future__ import annotations

import asyncio

import pytest

from tiktok_orchestrator import agent as agent_mod
from tiktok_orchestrator.agent import (
    DEFAULT_TOP_N,
    FOLLOWER_SPAM_THRESHOLD,
    CreatorRank,
    RankedCreators,
    plan_creator_search,
)
from tiktok_orchestrator import model_armor


def test_plan_creator_search_smoke() -> None:
    brief = (
        "We are a clean-beauty skincare brand launching a vegan, fragrance-free "
        "moisturizer line in Korea. Target audience is Korean Gen-Z women aged 18-26 "
        "who care about ingredient transparency and cruelty-free certification."
    )
    ranked = asyncio.run(plan_creator_search(brief))
    assert isinstance(ranked, RankedCreators)
    assert ranked.brief == brief
    assert "Source: Social Seeding" in ranked.source_attribution
    assert 0 < len(ranked.creators) <= DEFAULT_TOP_N

    for creator in ranked.creators:
        assert isinstance(creator, CreatorRank)
        assert creator.follower_count >= FOLLOWER_SPAM_THRESHOLD
        assert 0.0 <= creator.engagement_rate <= 1.0
        assert 0.0 <= creator.fit_score <= 1.0
        assert len(creator.reasoning) >= 10


def test_plan_creator_search_empty_brief_raises() -> None:
    with pytest.raises(ValueError):
        asyncio.run(plan_creator_search("   "))


def test_plan_creator_search_blocks_on_secret_in_brief(monkeypatch: pytest.MonkeyPatch) -> None:
    """Custom-regex pre-filter (model_armor._scan_custom_patterns) must
    block a brief containing a Google API key, even in stub mode.
    """
    # Force the custom-regex pre-filter to actually run by temporarily
    # disabling STUB_MODE on the sanitize path; the pre-filter runs FIRST
    # so we still don't need a live Model Armor client.
    monkeypatch.setattr(model_armor, "STUB_MODE", False)
    monkeypatch.setattr(model_armor, "TEMPLATE_INPUT", "")  # forces fail-closed if reached
    monkeypatch.setattr(model_armor, "TEMPLATE_OUTPUT", "")

    brief = (
        "We are launching a vegan skincare line. Our internal API key is "
        "AIzaSyDxVlAabc1234567890abc1234567890abcdEF and we want creators."
    )
    ranked = asyncio.run(plan_creator_search(brief))

    # Output structure must remain valid even when blocked.
    assert ranked.creators == []
    assert ranked.trace.get("blocked_by") == "model_armor_input"
    assert "custom_regex:gcp_api_key" in ranked.trace.get("reasons", [])


def test_ranked_creators_round_trip() -> None:
    payload = RankedCreators(
        brief="test",
        creators=[
            CreatorRank(
                unique_id="kr_vegan_beauty",
                follower_count=412_000,
                engagement_rate=0.067,
                fit_score=0.83,
                reasoning="High-engagement vegan skincare creator with a Gen-Z audience.",
            ),
        ],
    )
    blob = payload.model_dump_json()
    parsed = RankedCreators.model_validate_json(blob)
    assert parsed == payload


def test_extract_keywords_handles_korean_and_english() -> None:
    keywords = agent_mod._extract_keywords(
        "We're launching a 비건 vegan beauty skincare line in Korea."
    )
    # We expect at least one Korean variant and one English variant in the
    # heuristic keyword set.
    has_kr = any(any("가" <= ch <= "힣" for ch in k) for k in keywords)
    has_en = any(k.isascii() for k in keywords)
    assert has_kr and has_en, keywords


def test_fit_score_zero_when_no_overlap() -> None:
    score = agent_mod._fit_score("vegan korean beauty", "fintech investing")
    assert score == 0.0


def test_compute_engagement_returns_in_range() -> None:
    posts = [
        {"views": 100_000, "likes": 8_500, "comments": 320, "shares": 410},
        {"views": 200_000, "likes": 12_000, "comments": 500, "shares": 700},
        {"views": 0, "likes": 0, "comments": 0, "shares": 0},  # ignored
    ]
    er = agent_mod._compute_engagement(posts)
    assert 0.0 < er < 1.0
