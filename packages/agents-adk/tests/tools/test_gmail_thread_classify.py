"""tests/tools/test_gmail_thread_classify.py — W2-B7 capability layer test.

Coverage matrix:
    TestInputContract               — Pydantic validation gates (D41).
    TestStubDeterminism             — same body → byte-identical output.
    TestAllEightCategoriesReachable — exhaustive parametrize over 8 enum values.
    TestRequiresHuman               — always-escalate categories surface the flag.
    TestLiveModeRaises              — CAPABILITY_LAYER_MODE=live → NotImplementedError.
    TestCostAttribute               — `gmail_thread_classify.usd_cost` exposed.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.gmail_thread_classify import (
    USD_COST,
    GmailThreadClassifyInput,
    GmailThreadClassifyOutput,
    ReplyCategory,
    gmail_thread_classify,
)


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _force_stub_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default every test to stub mode — live tests opt back into 'live'."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")


def _input(body: str, **kwargs: object) -> GmailThreadClassifyInput:
    """Construct a baseline input with the body parameter swapped."""
    return GmailThreadClassifyInput(
        thread_id=kwargs.get("thread_id", "thr_demo_001"),  # type: ignore[arg-type]
        latest_message_body=body,
        sender_email=kwargs.get(  # type: ignore[arg-type]
            "sender_email", "creator@example.com"
        ),
        language_hint=kwargs.get("language_hint"),  # type: ignore[arg-type]
    )


# ─────────────────────────────────────────────────────────────────────────────
# TestInputContract.
# ─────────────────────────────────────────────────────────────────────────────


class TestInputContract:
    def test_minimal_input_validates(self) -> None:
        payload = _input("Hello there!")
        assert payload.thread_id == "thr_demo_001"
        assert payload.language_hint is None

    def test_empty_body_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _input("")

    def test_invalid_sender_email_rejected(self) -> None:
        with pytest.raises(ValidationError):
            GmailThreadClassifyInput(
                thread_id="thr_demo_001",
                latest_message_body="Hi",
                sender_email="not-an-email",
            )

    def test_unknown_field_rejected(self) -> None:
        with pytest.raises(ValidationError):
            GmailThreadClassifyInput.model_validate(
                {
                    "thread_id": "thr_demo_001",
                    "latest_message_body": "Hi",
                    "sender_email": "creator@example.com",
                    "extra_field": "rejected",
                }
            )

    def test_body_too_long_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _input("x" * 20_001)

    def test_language_hint_validates_to_known_locale(self) -> None:
        payload = _input("Hello!", language_hint="ko")
        assert payload.language_hint == "ko"

    def test_unknown_language_hint_rejected(self) -> None:
        with pytest.raises(ValidationError):
            GmailThreadClassifyInput.model_validate(
                {
                    "thread_id": "thr_demo_001",
                    "latest_message_body": "Hi",
                    "sender_email": "creator@example.com",
                    "language_hint": "fr",  # not in the 4-locale list
                }
            )


# ─────────────────────────────────────────────────────────────────────────────
# TestStubDeterminism.
# ─────────────────────────────────────────────────────────────────────────────


class TestStubDeterminism:
    def test_same_body_yields_byte_identical_output(self) -> None:
        body = "I'm interested! Please ship to my address."
        a = gmail_thread_classify(_input(body))
        b = gmail_thread_classify(_input(body))
        assert a.model_dump_json() == b.model_dump_json()

    def test_different_bodies_yield_different_categories(self) -> None:
        positive = gmail_thread_classify(
            _input("I'm interested! Ship to my address please.")
        )
        decline = gmail_thread_classify(_input("Please unsubscribe me."))
        assert positive.category != decline.category

    def test_no_keyword_match_falls_back_to_off_topic(self) -> None:
        # A body with no signal keywords falls through to off_topic.
        out = gmail_thread_classify(
            _input("Greetings from the void today and yesterday.")
        )
        assert out.category == "off_topic"
        # Below-0.6 confidence ⇒ requires_human=True per spec §6.
        assert out.confidence_0_1 < 0.6
        assert out.requires_human is True
        assert out.signal_keywords == []


# ─────────────────────────────────────────────────────────────────────────────
# TestAllEightCategoriesReachable — exhaustive parametrize.
#
# We pin one canonical body per category so a regression in keyword priority
# or category enum surfaces immediately. Cross-checked against the spec's
# 8-way classification list in conversation.spec.md §6.
# ─────────────────────────────────────────────────────────────────────────────


_CATEGORY_FIXTURES: tuple[tuple[str, ReplyCategory], ...] = (
    ("I'm interested! Please ship to my address.", "interested"),
    ("Could you tell me more details about the product?", "needs_more_info"),
    ("Sorry, I'm out of office until next month.", "unavailable"),
    ("My rate is $1000 per video.", "negotiating"),
    ("I accept the terms — let's do it!", "accepted"),
    ("Please unsubscribe me from this list.", "declined"),
    ("Greetings from the void today and yesterday.", "off_topic"),
    ("You won the lottery! Click here to claim.", "spam"),
)


class TestAllEightCategoriesReachable:
    @pytest.mark.parametrize(("body", "expected"), _CATEGORY_FIXTURES)
    def test_category_routes_to_expected_value(
        self, body: str, expected: ReplyCategory
    ) -> None:
        out = gmail_thread_classify(_input(body))
        assert isinstance(out, GmailThreadClassifyOutput)
        assert out.category == expected

    def test_all_eight_categories_are_exercised(self) -> None:
        """Belt-and-braces: every ReplyCategory enum value appears at least once
        in the fixtures above. Guards against an accidental fixture drop."""
        covered = {expected for _, expected in _CATEGORY_FIXTURES}
        expected_set: set[ReplyCategory] = {
            "interested",
            "needs_more_info",
            "unavailable",
            "negotiating",
            "accepted",
            "declined",
            "off_topic",
            "spam",
        }
        assert covered == expected_set


# ─────────────────────────────────────────────────────────────────────────────
# TestRequiresHuman — always-escalate buckets + low-confidence fallback.
# ─────────────────────────────────────────────────────────────────────────────


class TestRequiresHuman:
    @pytest.mark.parametrize(
        "body",
        [
            "My rate is $5000 per post.",  # negotiating
            "Please unsubscribe me.",       # declined
            "You won the lottery! Click here.",  # spam
        ],
    )
    def test_always_escalate_categories_set_flag(self, body: str) -> None:
        out = gmail_thread_classify(_input(body))
        assert out.requires_human is True

    def test_low_confidence_triggers_human_flag(self) -> None:
        # off_topic w/ no signals → confidence 0.3 → requires_human=True
        out = gmail_thread_classify(_input("Random unrelated text body."))
        assert out.category == "off_topic"
        assert out.confidence_0_1 < 0.6
        assert out.requires_human is True

    def test_confident_positive_does_not_escalate(self) -> None:
        # "interested" with strong signal → confidence >= 0.7 → no escalation
        out = gmail_thread_classify(
            _input("I'm interested! Please ship to my address.")
        )
        assert out.category == "interested"
        assert out.confidence_0_1 >= 0.6
        assert out.requires_human is False


# ─────────────────────────────────────────────────────────────────────────────
# TestLiveModeRaises.
# ─────────────────────────────────────────────────────────────────────────────


class TestLiveModeRaises:
    def test_live_mode_raises_not_implemented(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
            gmail_thread_classify(_input("I'm interested!"))


# ─────────────────────────────────────────────────────────────────────────────
# TestCostAttribute.
# ─────────────────────────────────────────────────────────────────────────────


class TestCostAttribute:
    def test_cost_attribute_exposed(self) -> None:
        assert hasattr(gmail_thread_classify, "usd_cost")
        assert gmail_thread_classify.usd_cost == USD_COST  # type: ignore[attr-defined]
        assert isinstance(gmail_thread_classify.usd_cost, float)  # type: ignore[attr-defined]
