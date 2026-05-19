"""Tests for `ss_agents.tools.carrier_create` — capability layer per D41.

Covers:
    1. Stub determinism — same input → byte-identical output across calls.
    2. Korean address parametrize — KR destination shipments hit the canned row.
    3. Live mode raises NotImplementedError with the deferred-O11 message.
    4. Pydantic validation — reject malformed phone (<7 digits) on addresses.
    5. Pydantic validation — reject zero / negative parcel dimensions.

Citations:
    D41 — Capability layer stub/live (CAPABILITY_LAYER_MODE).
    D34 — Korean destination is the demo's primary locale.
    Carrier adapter deferred 2026-05-14 pending the O11 decision (W2 brief).
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.carrier_create import (
    USD_COST,
    CarrierCreateInput,
    ParcelAddress,
    ParcelDimensions,
    carrier_create,
)


# ─────────────────────────────────────────────────────────────────────────────
# Shared fixtures — minimal valid input.
# ─────────────────────────────────────────────────────────────────────────────


def _make_input(
    *,
    to_country: str = "KR",
    to_postal: str = "06236",
    weight_g: float = 80.0,
    declared_value_usd: float = 25.00,
    to_phone: str | None = "010-1234-5678",
) -> CarrierCreateInput:
    """Build a valid CarrierCreateInput with KR-style defaults."""
    from_addr = ParcelAddress(
        recipientName="Social Seeding Warehouse",
        addressLine1="123 Origin St",
        city="Seoul",
        stateOrProvince="서울특별시",
        postalCode="04524",
        countryIso2="KR",
        phone="02-1234-5678",
    )
    to_addr = ParcelAddress(
        recipientName="홍길동",
        addressLine1="테헤란로 152",
        addressLine2="강남파이낸스센터 11층",
        city="강남구",
        stateOrProvince="서울특별시",
        postalCode=to_postal,
        countryIso2=to_country,
        phone=to_phone,
    )
    dims = ParcelDimensions(
        lengthCm=20.0, widthCm=15.0, heightCm=10.0, weightGrams=weight_g
    )
    return CarrierCreateInput(
        fromAddress=from_addr,
        toAddress=to_addr,
        parcelDims=dims,
        declaredValueUsd=declared_value_usd,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_is_deterministic_same_input(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two stub calls with the same input must return byte-identical output."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = _make_input()
    a = carrier_create(payload)
    b = carrier_create(payload)
    assert a.model_dump(by_alias=True) == b.model_dump(by_alias=True)


def test_stub_returns_pinned_constants(monkeypatch: pytest.MonkeyPatch) -> None:
    """Per the W2-A4 brief, the stub returns these exact constants."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = carrier_create(_make_input())
    assert out.tracking_number == "KR1234567890"
    assert out.label_pdf_url == "https://stub.local/label/KR123.pdf"
    assert out.cost_usd == 8.50
    assert out.carrier == "cj-logistics-stub"
    assert out.fetched_via == "stub"


def test_stub_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """When CAPABILITY_LAYER_MODE is unset, the tool defaults to stub mode."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = carrier_create(_make_input())
    assert out.fetched_via == "stub"


# ─────────────────────────────────────────────────────────────────────────────
# 2. Korean address parametrize — destinations across the 4 D34 locales.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "to_country,to_postal",
    [
        ("KR", "06236"),  # canonical KR destination
        ("KR", "13494"),  # different KR postal — stub still returns canon row
        ("US", "94103"),  # cross-border destination
        ("JP", "100-0001"),
        ("CN", "100000"),
    ],
)
def test_stub_destination_independent_of_country(
    monkeypatch: pytest.MonkeyPatch,
    to_country: str,
    to_postal: str,
) -> None:
    """Stub returns the canonical row regardless of destination — workflows
    compare byte-for-byte against the stub, so this contract must not drift
    based on the input country.
    """
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = carrier_create(_make_input(to_country=to_country, to_postal=to_postal))
    assert out.tracking_number == "KR1234567890"
    assert out.cost_usd == 8.50
    assert out.carrier == "cj-logistics-stub"


# ─────────────────────────────────────────────────────────────────────────────
# 3. Live mode raises NotImplementedError with the O11-deferred message.
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented_with_o11_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Per the W2-A4 brief: live mode raises NotImplementedError with the
    'carrier adapter deferred pending O11 decision' message.
    """
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(
        NotImplementedError,
        match="carrier adapter deferred pending O11 decision",
    ):
        carrier_create(_make_input())


# ─────────────────────────────────────────────────────────────────────────────
# 4. Pydantic validation — reject malformed phone.
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
def test_parcel_address_rejects_malformed_phone(bad_phone: str) -> None:
    """ParcelAddress.phone validator must reject <7-digit strings."""
    with pytest.raises(ValidationError, match="at least 7 digits"):
        ParcelAddress(
            recipientName="홍길동",
            addressLine1="테헤란로 152",
            countryIso2="KR",
            phone=bad_phone,
        )


def test_parcel_address_accepts_well_formed_phone() -> None:
    """E.164 or local-format phones with ≥7 digits must be accepted."""
    addr = ParcelAddress(
        recipientName="홍길동",
        addressLine1="테헤란로 152",
        countryIso2="KR",
        phone="+82-10-1234-5678",
    )
    assert addr.phone == "+82-10-1234-5678"


def test_parcel_address_rejects_bad_country() -> None:
    """countryIso2 must be exactly 2 alphabetic chars."""
    with pytest.raises(ValidationError):
        ParcelAddress(
            recipientName="홍길동",
            addressLine1="테헤란로 152",
            countryIso2="KOR",  # 3 letters — wrong
        )


# ─────────────────────────────────────────────────────────────────────────────
# 5. Pydantic validation — reject zero / negative parcel dimensions.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad_field,bad_value",
    [
        ("lengthCm", 0.0),
        ("lengthCm", -5.0),
        ("widthCm", 0.0),
        ("widthCm", -1.0),
        ("heightCm", 0.0),
        ("heightCm", -10.0),
        ("weightGrams", 0.0),
        ("weightGrams", -50.0),
    ],
)
def test_parcel_dimensions_rejects_zero_or_negative(
    bad_field: str, bad_value: float
) -> None:
    """All parcel dimensions + weight must be strictly positive."""
    base: dict[str, float] = {
        "lengthCm": 20.0,
        "widthCm": 15.0,
        "heightCm": 10.0,
        "weightGrams": 80.0,
    }
    base[bad_field] = bad_value
    with pytest.raises(ValidationError):
        ParcelDimensions(**base)  # type: ignore[arg-type]


def test_parcel_dimensions_rejects_excessive_size() -> None:
    """Dimensions are capped at 300cm and 30kg — beyond that the carrier API
    rejects the parcel anyway, so we fail closed at input validation.
    """
    with pytest.raises(ValidationError):
        ParcelDimensions(
            lengthCm=301.0, widthCm=15.0, heightCm=10.0, weightGrams=80.0
        )
    with pytest.raises(ValidationError):
        ParcelDimensions(
            lengthCm=20.0, widthCm=15.0, heightCm=10.0, weightGrams=30_001.0
        )


def test_carrier_input_rejects_negative_declared_value() -> None:
    """declared_value_usd must be non-negative."""
    with pytest.raises(ValidationError):
        _make_input(declared_value_usd=-1.0)


# ─────────────────────────────────────────────────────────────────────────────
# 6. D41 cost attribute — `cost_watch` introspects this.
# ─────────────────────────────────────────────────────────────────────────────


def test_tool_exposes_usd_cost_attribute() -> None:
    """Per D41, the tool callable must surface `usd_cost` for cost_watch."""
    assert hasattr(carrier_create, "usd_cost")
    assert carrier_create.usd_cost == USD_COST
    assert USD_COST > 0.0
