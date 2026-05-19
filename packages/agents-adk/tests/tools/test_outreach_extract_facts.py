"""tests/tools/test_outreach_extract_facts.py — W2-A3 capability layer test.

Coverage matrix:
    TestInputContract            — Pydantic validation gates
    TestCanonicalCreatorFacts    — `tt_001`-style IDs return the known fixture
    TestStubDeterminism          — same input → byte-identical output
    TestEngagementBuckets        — every EngagementPattern bucket is reachable
    TestContactPreferenceSignals — signature parsing for email/dm/manager/unknown
    TestNicheInference           — hashtag-keyword path + hash-fallback path
    TestLiveModeRaises           — CAPABILITY_LAYER_MODE=live → NotImplementedError
    TestCostAttribute            — `outreach_extract_facts.usd_cost` exposed
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.outreach_extract_facts import (
    USD_COST,
    ContactPreference,
    CreatorProfileInput,
    EngagementPattern,
    OutreachExtractFactsOutput,
    RecentCollab,
    outreach_extract_facts,
)


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _force_stub_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")


def _canonical_profile() -> CreatorProfileInput:
    return CreatorProfileInput(
        creatorId="tt_001",
        nickname="K-Beauty Guru",
        signature="Korean skincare reviews · DM for collabs",
        recentPostThemes=["morning routine", "vitamin C review"],
        topHashtags=["스킨케어", "kbeauty"],
        engagementRate=0.045,
        avgViews=18_500,
        followerCount=82_000,
    )


# ─────────────────────────────────────────────────────────────────────────────
# TestInputContract.
# ─────────────────────────────────────────────────────────────────────────────


class TestInputContract:
    def test_minimal_input_validates(self) -> None:
        payload = CreatorProfileInput(creatorId="tt_001")
        assert payload.creator_id == "tt_001"
        assert payload.engagement_rate == 0.0
        assert payload.recent_post_themes == []

    def test_empty_creator_id_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CreatorProfileInput(creatorId="")

    def test_engagement_rate_out_of_range_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CreatorProfileInput(creatorId="tt_001", engagementRate=1.5)
        with pytest.raises(ValidationError):
            CreatorProfileInput(creatorId="tt_001", engagementRate=-0.1)

    def test_too_many_recent_post_themes_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CreatorProfileInput(
                creatorId="tt_001",
                recentPostThemes=["a", "b", "c", "d", "e", "f"],
            )

    def test_extra_field_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CreatorProfileInput.model_validate(  # type: ignore[call-arg]
                {"creatorId": "tt_001", "rogue": True}
            )


# ─────────────────────────────────────────────────────────────────────────────
# TestCanonicalCreatorFacts — the spec-locked `tt_001` fixture path.
# ─────────────────────────────────────────────────────────────────────────────


class TestCanonicalCreatorFacts:
    def test_canonical_id_returns_kbeauty_niche(self) -> None:
        out = outreach_extract_facts(_canonical_profile())
        assert isinstance(out, OutreachExtractFactsOutput)
        assert out.niche == "k-beauty/skincare"
        assert out.fetched_via == "stub"

    def test_canonical_id_returns_high_consistency_engagement(self) -> None:
        out = outreach_extract_facts(_canonical_profile())
        assert out.engagement_pattern == "high_consistency"

    def test_canonical_id_signature_yields_dm_contact_pref(self) -> None:
        out = outreach_extract_facts(_canonical_profile())
        assert out.contact_pref == "dm"

    def test_canonical_id_has_two_recent_collabs(self) -> None:
        out = outreach_extract_facts(_canonical_profile())
        assert len(out.recent_collabs) == 2
        brand_names = {c.brand_name for c in out.recent_collabs}
        assert brand_names == {"Innisfree", "Laneige"}
        for collab in out.recent_collabs:
            assert isinstance(collab, RecentCollab)
            assert 0.0 <= collab.confidence <= 1.0


# ─────────────────────────────────────────────────────────────────────────────
# TestStubDeterminism.
# ─────────────────────────────────────────────────────────────────────────────


class TestStubDeterminism:
    def test_canonical_input_byte_identical_output(self) -> None:
        first = outreach_extract_facts(_canonical_profile())
        second = outreach_extract_facts(_canonical_profile())
        assert first.model_dump_json() == second.model_dump_json()

    def test_non_canonical_id_byte_identical_output(self) -> None:
        payload = CreatorProfileInput(
            creatorId="fitness_kid_2024",
            signature="DM for collabs · gym & meal prep",
            topHashtags=["fitness", "gymtok"],
            engagementRate=0.04,
        )
        first = outreach_extract_facts(payload)
        second = outreach_extract_facts(payload)
        assert first.model_dump_json() == second.model_dump_json()

    def test_changing_creator_id_changes_output(self) -> None:
        a = outreach_extract_facts(CreatorProfileInput(creatorId="alpha_creator"))
        b = outreach_extract_facts(CreatorProfileInput(creatorId="bravo_creator"))
        # At least one downstream field MUST diverge (else the stub is degenerate).
        assert (a.niche, a.engagement_pattern, a.contact_pref) != (
            b.niche,
            b.engagement_pattern,
            b.contact_pref,
        ) or a.recent_collabs != b.recent_collabs


# ─────────────────────────────────────────────────────────────────────────────
# TestEngagementBuckets — every bucket of the EngagementPattern enum is
# reachable via the engagement_rate threshold ladder.
# ─────────────────────────────────────────────────────────────────────────────


_BUCKET_CASES: list[tuple[float, EngagementPattern]] = [
    (0.08, "viral_outliers"),
    (0.06, "viral_outliers"),
    (0.045, "high_consistency"),
    (0.03, "high_consistency"),
    (0.02, "rising_steady"),
    (0.015, "rising_steady"),
    (0.01, "declining"),
    (0.005, "declining"),
    (0.001, "low_activity"),
    (0.0, "low_activity"),
]


@pytest.mark.parametrize("rate,expected", _BUCKET_CASES)
class TestEngagementBuckets:
    def test_threshold_maps_to_bucket(
        self, rate: float, expected: EngagementPattern
    ) -> None:
        # Use a non-canonical id so the engagement_rate (not the canned label)
        # decides the bucket.
        payload = CreatorProfileInput(
            creatorId=f"creator_rate_{rate:.4f}",
            engagementRate=rate,
        )
        out = outreach_extract_facts(payload)
        assert out.engagement_pattern == expected


# ─────────────────────────────────────────────────────────────────────────────
# TestContactPreferenceSignals — signature parsing covers all 4 outcomes.
# ─────────────────────────────────────────────────────────────────────────────


_CONTACT_CASES: list[tuple[str, ContactPreference]] = [
    ("Email me: collabs@example.com", "email"),
    ("DM for partnership inquiries", "dm"),
    ("message me on instagram", "dm"),
    ("managed by Awesome Talent Agency", "manager"),
    ("I love sunshine and good vibes only", "unknown"),
    ("", "unknown"),
]


@pytest.mark.parametrize("signature,expected", _CONTACT_CASES)
def test_contact_pref_from_signature(
    signature: str, expected: ContactPreference
) -> None:
    payload = CreatorProfileInput(
        creatorId="contact_test_001",
        signature=signature,
    )
    out = outreach_extract_facts(payload)
    assert out.contact_pref == expected, (
        f"signature={signature!r} expected {expected}, got {out.contact_pref}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# TestNicheInference — keyword path + hash-fallback path.
# ─────────────────────────────────────────────────────────────────────────────


class TestNicheInference:
    def test_fitness_hashtag_triggers_fitness_niche(self) -> None:
        payload = CreatorProfileInput(
            creatorId="random_creator_001",
            topHashtags=["fitness", "gymtok"],
        )
        out = outreach_extract_facts(payload)
        assert out.niche == "fitness/strength"

    def test_food_theme_triggers_food_niche(self) -> None:
        payload = CreatorProfileInput(
            creatorId="random_creator_002",
            recentPostThemes=["recipe walkthrough"],
        )
        out = outreach_extract_facts(payload)
        assert out.niche == "food/dessert"

    def test_unknown_keywords_fall_back_to_bank(self) -> None:
        payload = CreatorProfileInput(creatorId="opaque_creator_zzz")
        out = outreach_extract_facts(payload)
        # Just assert it's a registered niche string.
        assert "/" in out.niche
        assert out.niche != ""


# ─────────────────────────────────────────────────────────────────────────────
# TestLiveModeRaises.
# ─────────────────────────────────────────────────────────────────────────────


class TestLiveModeRaises:
    def test_live_mode_raises_not_implemented(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(NotImplementedError) as exc_info:
            outreach_extract_facts(_canonical_profile())
        assert "W7" in str(exc_info.value)

    def test_unknown_mode_routes_to_live(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "experimental")
        with pytest.raises(NotImplementedError):
            outreach_extract_facts(_canonical_profile())


# ─────────────────────────────────────────────────────────────────────────────
# TestCostAttribute.
# ─────────────────────────────────────────────────────────────────────────────


class TestCostAttribute:
    def test_usd_cost_attribute_exposed(self) -> None:
        assert hasattr(outreach_extract_facts, "usd_cost")
        assert outreach_extract_facts.usd_cost == USD_COST  # type: ignore[attr-defined]
        assert outreach_extract_facts.usd_cost > 0.0  # type: ignore[attr-defined]
