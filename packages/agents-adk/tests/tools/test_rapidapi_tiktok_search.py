"""tests/tools/test_rapidapi_tiktok_search.py — capability-layer seam tests.

Per D41 + W2-A1 brief: the four sourcing tools share a stub/live dispatch
contract. Each tool's test suite asserts four invariants:

  1. Default (no env var) ⇒ stub path runs ⇒ deterministic fixture data.
  2. Stub determinism — two calls with the same input return identical output.
  3. Live mode (CAPABILITY_LAYER_MODE=live) raises NotImplementedError with
     a clear "W7 deploy phase" message.
  4. Pydantic input validation rejects malformed payloads (extra="forbid").
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.rapidapi_tiktok_search import (
    USD_COST,
    RapidApiTiktokSearchInput,
    RapidApiTiktokSearchOutput,
    rapidapi_tiktok_search,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Default = stub: env unset ⇒ stub path
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """When CAPABILITY_LAYER_MODE is unset, the tool runs the stub path."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = rapidapi_tiktok_search(RapidApiTiktokSearchInput(query="kbeauty"))
    assert isinstance(out, RapidApiTiktokSearchOutput)
    assert len(out.creators) == 5
    expected_ids = [f"tt_{i:03d}" for i in range(1, 6)]
    assert [c.id for c in out.creators] == expected_ids


def test_stub_explicit_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """CAPABILITY_LAYER_MODE=stub also drives the stub path."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = rapidapi_tiktok_search(RapidApiTiktokSearchInput(query="serum"))
    assert [c.id for c in out.creators] == [
        "tt_001",
        "tt_002",
        "tt_003",
        "tt_004",
        "tt_005",
    ]
    assert out.query_echo == "serum"
    assert out.next_cursor is None


def test_stub_respects_limit_floor(monkeypatch: pytest.MonkeyPatch) -> None:
    """Small limits truncate the canned 5-item list (limit < 5)."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = rapidapi_tiktok_search(RapidApiTiktokSearchInput(query="x", limit=2))
    assert [c.id for c in out.creators] == ["tt_001", "tt_002"]


# ─────────────────────────────────────────────────────────────────────────────
# 2. Determinism — same input ⇒ same output
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two stub calls with identical input return byte-identical JSON."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = RapidApiTiktokSearchInput(query="vitamin C", mode="text", limit=5)
    a = rapidapi_tiktok_search(payload)
    b = rapidapi_tiktok_search(payload)
    assert a.model_dump_json() == b.model_dump_json()


# ─────────────────────────────────────────────────────────────────────────────
# 3. Live mode raises with a clear "W7" message
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    """CAPABILITY_LAYER_MODE=live raises NotImplementedError citing W7."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        rapidapi_tiktok_search(RapidApiTiktokSearchInput(query="serum"))


# ─────────────────────────────────────────────────────────────────────────────
# 4. Input validation — Pydantic rejects malformed payloads
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_empty_query() -> None:
    with pytest.raises(ValidationError):
        RapidApiTiktokSearchInput(query="")


def test_input_rejects_unknown_field() -> None:
    """extra='forbid' rejects extra keys."""
    with pytest.raises(ValidationError):
        RapidApiTiktokSearchInput.model_validate(
            {"query": "x", "unknown_field": "boom"}
        )


def test_input_rejects_invalid_mode() -> None:
    with pytest.raises(ValidationError):
        RapidApiTiktokSearchInput.model_validate({"query": "x", "mode": "video"})


def test_input_rejects_limit_above_cap() -> None:
    with pytest.raises(ValidationError):
        RapidApiTiktokSearchInput(query="x", limit=500)


# ─────────────────────────────────────────────────────────────────────────────
# Cost attribute exposed for cost_watch (D41)
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    """The function carries a `usd_cost` attribute so cost_watch can read it."""
    assert hasattr(rapidapi_tiktok_search, "usd_cost")
    assert rapidapi_tiktok_search.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(rapidapi_tiktok_search.usd_cost, float)  # type: ignore[attr-defined]
    assert rapidapi_tiktok_search.usd_cost > 0.0  # type: ignore[attr-defined]
