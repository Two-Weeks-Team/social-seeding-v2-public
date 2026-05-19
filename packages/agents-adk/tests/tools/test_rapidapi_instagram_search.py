"""tests/tools/test_rapidapi_instagram_search.py — capability-layer seam tests.

Special case (vs the TikTok tool): the live path is gated on O3 (D14
Instagram feasibility study). The live test asserts the error message
calls out O3 explicitly so a downstream operator who flips the env var
sees the right blocker, not a generic "W7" placeholder.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.rapidapi_instagram_search import (
    USD_COST,
    RapidApiInstagramSearchInput,
    RapidApiInstagramSearchOutput,
    rapidapi_instagram_search,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Default = stub
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = rapidapi_instagram_search(RapidApiInstagramSearchInput(query="kbeauty"))
    assert isinstance(out, RapidApiInstagramSearchOutput)
    assert len(out.creators) == 5
    expected = [f"ig_{i:03d}" for i in range(1, 6)]
    assert [c.id for c in out.creators] == expected


def test_stub_explicit_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = rapidapi_instagram_search(RapidApiInstagramSearchInput(query="serum"))
    assert [c.id for c in out.creators] == [
        "ig_001",
        "ig_002",
        "ig_003",
        "ig_004",
        "ig_005",
    ]
    assert out.query_echo == "serum"
    assert out.next_cursor is None


# ─────────────────────────────────────────────────────────────────────────────
# 2. Determinism
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = RapidApiInstagramSearchInput(query="vitamin C", mode="text", limit=5)
    a = rapidapi_instagram_search(payload)
    b = rapidapi_instagram_search(payload)
    assert a.model_dump_json() == b.model_dump_json()


# ─────────────────────────────────────────────────────────────────────────────
# 3. Live mode raises with an O3-specific message
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_with_o3_message(monkeypatch: pytest.MonkeyPatch) -> None:
    """Instagram's live path must cite O3 (D14 feasibility) — not 'W7'.

    A future operator flipping the env var should see the actual blocker
    so they don't go chasing the wrong owner.
    """
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError) as exc_info:
        rapidapi_instagram_search(RapidApiInstagramSearchInput(query="serum"))
    msg = str(exc_info.value)
    assert "O3" in msg, f"expected O3 reference in error, got: {msg!r}"


# ─────────────────────────────────────────────────────────────────────────────
# 4. Input validation
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_empty_query() -> None:
    with pytest.raises(ValidationError):
        RapidApiInstagramSearchInput(query="")


def test_input_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        RapidApiInstagramSearchInput.model_validate(
            {"query": "x", "platform": "tiktok"}
        )


def test_input_rejects_invalid_mode() -> None:
    with pytest.raises(ValidationError):
        RapidApiInstagramSearchInput.model_validate({"query": "x", "mode": "image"})


# ─────────────────────────────────────────────────────────────────────────────
# Cost attribute
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(rapidapi_instagram_search, "usd_cost")
    assert rapidapi_instagram_search.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(rapidapi_instagram_search.usd_cost, float)  # type: ignore[attr-defined]
