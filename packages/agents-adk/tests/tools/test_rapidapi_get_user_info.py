"""Tests for `rapidapi_get_user_info` capability — per D41.

Coverage:
    · stub determinism (same input → byte-identical output on a re-run)
    · canonical tt_001 contract (followers=100000, eng=0.045, recent_posts=10,
      public_email=None) — locked by the task brief
    · live mode raises `NotImplementedError` until W7
    · Pydantic input validation rejects malformed payloads
    · `usd_cost` attribute present per D41 (cost_watch surface)
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.rapidapi_get_user_info import (
    USD_COST,
    RapidApiUserInfoInput,
    RapidApiUserInfoOutput,
    rapidapi_get_user_info,
)


# ─────────────────────────────────────────────────────────────────────────────
# Env hygiene — every test forces stub mode unless it explicitly opts into
# live to exercise the NotImplementedError path. The autouse `_isolate_env`
# in conftest already clears SS_LIVE; we only force CAPABILITY_LAYER_MODE.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _stub_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default every test to stub mode (D41 default)."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")


# ─────────────────────────────────────────────────────────────────────────────
# usd_cost attribute — D41 requirement.
# ─────────────────────────────────────────────────────────────────────────────


def test_usd_cost_attribute_present() -> None:
    """Per D41 the tool must expose `usd_cost` for the cost_watch aggregator."""
    assert hasattr(rapidapi_get_user_info, "usd_cost")
    assert rapidapi_get_user_info.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(rapidapi_get_user_info.usd_cost, float)  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub determinism + canonical contract.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_canonical_tt_001_contract() -> None:
    """Task brief: tt_001 returns followers=100000, engagement_rate=0.045,
    10 recent_posts, public_email=None."""
    out = rapidapi_get_user_info(RapidApiUserInfoInput(creator_id="tt_001"))

    assert isinstance(out, RapidApiUserInfoOutput)
    assert out.creator_id == "tt_001"
    assert out.platform == "tiktok"
    assert out.followers == 100_000
    assert out.engagement_rate == 0.045
    assert len(out.recent_posts) == 10
    assert out.public_email is None
    assert out.fetched_via == "stub"


def test_stub_canonical_pattern_holds_for_tt_042_too() -> None:
    """Any `tt_<digits>` ID is canonical per the spec — checks the pattern
    matches, not just the literal `tt_001` string."""
    out = rapidapi_get_user_info(RapidApiUserInfoInput(creator_id="tt_042"))
    assert out.followers == 100_000
    assert out.engagement_rate == 0.045
    assert len(out.recent_posts) == 10
    assert out.public_email is None


def test_stub_is_deterministic_on_repeated_calls() -> None:
    """Same input → byte-identical output. Stable across calls in one process."""
    payload = RapidApiUserInfoInput(creator_id="tt_001")
    a = rapidapi_get_user_info(payload)
    b = rapidapi_get_user_info(payload)
    assert a.model_dump_json() == b.model_dump_json()


def test_stub_deterministic_for_non_canonical_id() -> None:
    """A non-`tt_NNN` ID also returns deterministic output (uses stable hash)."""
    payload = RapidApiUserInfoInput(creator_id="beautyguru_kr")
    a = rapidapi_get_user_info(payload)
    b = rapidapi_get_user_info(payload)
    assert a.model_dump_json() == b.model_dump_json()
    # And the canonical contract does NOT bleed into non-canonical IDs.
    assert a.followers != 100_000 or a.engagement_rate != 0.045


def test_stub_two_different_ids_produce_different_outputs() -> None:
    """Sanity: the stub isn't returning a constant for everything."""
    a = rapidapi_get_user_info(RapidApiUserInfoInput(creator_id="beautyguru_kr"))
    b = rapidapi_get_user_info(RapidApiUserInfoInput(creator_id="foodieboy_jp"))
    assert a.creator_id != b.creator_id
    assert a.model_dump_json() != b.model_dump_json()


def test_stub_recent_posts_have_valid_shape() -> None:
    """Recent posts validate cleanly — every metric is a non-negative int."""
    out = rapidapi_get_user_info(RapidApiUserInfoInput(creator_id="tt_001"))
    assert all(p.views >= 0 for p in out.recent_posts)
    assert all(p.likes >= 0 for p in out.recent_posts)
    assert all(p.comments >= 0 for p in out.recent_posts)
    assert all(p.shares >= 0 for p in out.recent_posts)


def test_stub_instagram_platform_passes_through() -> None:
    """Adding an `instagram` platform per O3 must not break the capability."""
    out = rapidapi_get_user_info(
        RapidApiUserInfoInput(creator_id="some_ig_handle", platform="instagram")
    )
    assert out.platform == "instagram"
    assert out.fetched_via == "stub"


# ─────────────────────────────────────────────────────────────────────────────
# Live mode — NotImplementedError until W7.
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match="W7"):
        rapidapi_get_user_info(RapidApiUserInfoInput(creator_id="tt_001"))


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic input validation — fail closed.
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_empty_creator_id() -> None:
    with pytest.raises(ValidationError):
        RapidApiUserInfoInput(creator_id="")


def test_input_rejects_unknown_platform() -> None:
    with pytest.raises(ValidationError):
        RapidApiUserInfoInput(creator_id="tt_001", platform="youtube")  # type: ignore[arg-type]


def test_input_rejects_extra_fields() -> None:
    """`extra=forbid` — fail closed on unknown keys (defensive vs prompt
    injection that smuggles fields into the call payload)."""
    with pytest.raises(ValidationError):
        RapidApiUserInfoInput.model_validate(
            {"creator_id": "tt_001", "unknown_field": "x"}
        )


def test_output_rejects_extra_fields() -> None:
    """Symmetric defence — capability output also `extra=forbid`."""
    with pytest.raises(ValidationError):
        RapidApiUserInfoOutput.model_validate(
            {
                "creator_id": "tt_001",
                "platform": "tiktok",
                "nickname": "x",
                "followers": 0,
                "following": 0,
                "video_count": 0,
                "engagement_rate": 0.0,
                "recent_posts": [],
                "public_email": None,
                "fetched_via": "stub",
                "unknown_field": "x",
            }
        )
