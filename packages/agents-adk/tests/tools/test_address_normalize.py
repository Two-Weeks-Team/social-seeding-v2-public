"""Tests for `ss_agents.tools.address_normalize` — capability layer per D41.

Covers:
    1. Stub determinism — same input → byte-identical output across calls.
    2. KR canonical address parametrize — the pinned brief address parses to
       a fully populated KR-ISO row.
    3. Live mode raises NotImplementedError (W7-deferred).
    4. Pydantic validation rejects malformed phone (<7 digits).
    5. Pydantic validation rejects bad country_hint / countryIso2.

Citations:
    D41 — Capability layer stub/live (CAPABILITY_LAYER_MODE).
    D34 — Korean locale is the demo's primary locale; the canonical KR
          address comes straight from logistics.spec.md §8.1.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.address_normalize import (
    USD_COST,
    AddressNormalizeInput,
    AddressNormalizeOutput,
    address_normalize,
)


# The exact KR canonical address from the W2-A4 brief.
KR_CANONICAL = "서울 강남구 테헤란로 152 강남파이낸스센터 11층"


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_is_deterministic_same_input(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two stub calls with the same input must return byte-identical output."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = AddressNormalizeInput(rawAddress=KR_CANONICAL, countryHint="KR")
    a = address_normalize(payload)
    b = address_normalize(payload)
    assert a.model_dump(by_alias=True) == b.model_dump(by_alias=True), (
        "stub must be deterministic across calls"
    )


def test_stub_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """When CAPABILITY_LAYER_MODE is unset, the tool defaults to stub mode."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    payload = AddressNormalizeInput(rawAddress=KR_CANONICAL)
    out = address_normalize(payload)
    assert out.fetched_via == "stub"


# ─────────────────────────────────────────────────────────────────────────────
# 2. Korean address parametrize — canonical row + degraded non-canonical.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected_line1,expected_line2,expected_city,expected_postal",
    [
        # Canonical KR address — fully populated row, high confidence.
        (
            KR_CANONICAL,
            "테헤란로 152",
            "강남파이낸스센터 11층",
            "강남구",
            "06236",
        ),
    ],
)
def test_stub_kr_canonical_parses_fully(
    monkeypatch: pytest.MonkeyPatch,
    raw: str,
    expected_line1: str,
    expected_line2: str,
    expected_city: str,
    expected_postal: str,
) -> None:
    """The pinned KR address from the W2-A4 brief parses to a full row."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = address_normalize(AddressNormalizeInput(rawAddress=raw))
    assert out.address_line1 == expected_line1
    assert out.address_line2 == expected_line2
    assert out.city == expected_city
    assert out.postal_code == expected_postal
    assert out.country_iso2 == "KR"
    assert out.state_or_province == "서울특별시"
    assert out.normalized_confidence_0_1 >= 0.5, (
        "canonical KR address must clear the 0.5 confidence floor "
        "(logistics.spec.md §6 escalation threshold)"
    )
    assert out.fetched_via == "stub"


@pytest.mark.parametrize(
    "raw,country_hint",
    [
        # Non-canonical inputs degrade to low confidence + country fallback.
        ("123 anywhere street", "US"),
        ("partial 한국 주소", "KR"),
        ("foo", None),
    ],
)
def test_stub_non_canonical_low_confidence(
    monkeypatch: pytest.MonkeyPatch,
    raw: str,
    country_hint: str | None,
) -> None:
    """Non-canonical inputs return < 0.5 confidence so the agent escalates."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = AddressNormalizeInput(
        rawAddress=raw, countryHint=country_hint
    )
    out = address_normalize(payload)
    assert out.normalized_confidence_0_1 < 0.5, (
        f"non-canonical input {raw!r} must surface low confidence to trigger "
        "the logistics agent's escalation path"
    )
    # Country falls back to the hint when provided, else "KR" by default.
    expected_country = (country_hint or "KR").upper()
    assert out.country_iso2 == expected_country


# ─────────────────────────────────────────────────────────────────────────────
# 3. Live mode raises NotImplementedError (W7-deferred).
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    """Live mode is W7-deferred; calling it must raise NotImplementedError."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    payload = AddressNormalizeInput(rawAddress=KR_CANONICAL)
    with pytest.raises(NotImplementedError, match="W7"):
        address_normalize(payload)


# ─────────────────────────────────────────────────────────────────────────────
# 4. Pydantic validation — reject malformed phone (<7 digits).
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad_phone",
    [
        "abc",      # zero digits
        "12",       # 2 digits
        "1-2-3",    # 3 digits
        "12345-6",  # 6 digits, below floor
    ],
)
def test_output_rejects_malformed_phone(bad_phone: str) -> None:
    """The output model's phone validator must reject <7-digit strings."""
    with pytest.raises(ValidationError, match="at least 7 digits"):
        AddressNormalizeOutput(
            addressLine1="some line",
            countryIso2="KR",
            normalizedConfidence01=0.8,
            fetchedVia="stub",
            phone=bad_phone,
        )


def test_output_accepts_well_formed_phone() -> None:
    """Phones with ≥7 digits must be accepted (E.164 or local format)."""
    out = AddressNormalizeOutput(
        addressLine1="some line",
        countryIso2="KR",
        normalizedConfidence01=0.8,
        fetchedVia="stub",
        phone="010-1234-5678",
    )
    assert out.phone == "010-1234-5678"


def test_output_accepts_empty_phone() -> None:
    """Empty/None phone is allowed — many KR shipping rows omit it."""
    out = AddressNormalizeOutput(
        addressLine1="some line",
        countryIso2="KR",
        normalizedConfidence01=0.8,
        fetchedVia="stub",
        phone=None,
    )
    assert out.phone is None


# ─────────────────────────────────────────────────────────────────────────────
# 5. Pydantic validation — reject malformed countryIso2 / countryHint.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("bad_country", ["KOR", "K", "12", "K1"])
def test_output_rejects_bad_country_iso2(bad_country: str) -> None:
    """countryIso2 must be exactly 2 alphabetic chars (ISO 3166-1 alpha-2)."""
    with pytest.raises(ValidationError):
        AddressNormalizeOutput(
            addressLine1="line",
            countryIso2=bad_country,
            normalizedConfidence01=0.8,
            fetchedVia="stub",
        )


@pytest.mark.parametrize("bad_hint", ["KOR", "1A", "K1"])
def test_input_rejects_bad_country_hint(bad_hint: str) -> None:
    """countryHint must be ISO 3166-1 alpha-2 (validator on the input)."""
    with pytest.raises(ValidationError):
        AddressNormalizeInput(rawAddress="something", countryHint=bad_hint)


def test_input_rejects_empty_raw_address() -> None:
    """raw_address has min_length=1; empty string must fail validation."""
    with pytest.raises(ValidationError):
        AddressNormalizeInput(rawAddress="")


def test_input_rejects_over_long_raw_address() -> None:
    """raw_address has max_length=2000; over-long strings must fail."""
    with pytest.raises(ValidationError):
        AddressNormalizeInput(rawAddress="x" * 2001)


# ─────────────────────────────────────────────────────────────────────────────
# 6. D41 cost attribute — `cost_watch` introspects this.
# ─────────────────────────────────────────────────────────────────────────────


def test_tool_exposes_usd_cost_attribute() -> None:
    """Per D41, the tool callable must surface `usd_cost` for cost_watch."""
    assert hasattr(address_normalize, "usd_cost")
    assert address_normalize.usd_cost == USD_COST
    assert USD_COST > 0.0
