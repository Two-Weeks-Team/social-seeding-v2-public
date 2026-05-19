"""address_normalize — capability layer per D41.

Parse a free-text shipping address into ISO-standard components. Implements
the `address.normalize` capability declared in
`gcp-research/specs/tier1/logistics.spec.md §6` (ARCHITECTURE.md §3 row 6:
`logistics | 1 | Gemini 2.5 Flash | address.normalize, carrier.create`).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic canned parse. The known Korean test address
    `"서울 강남구 테헤란로 152 강남파이낸스센터 11층"` returns a fully populated
    KR-ISO row. Any other address still yields a deterministic, syntactically
    valid output (lower confidence) so workflows can exercise their downstream
    handling without burning Maps/Document AI budget.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real Google Maps Places API + Document AI call. W7 deploy phase wires
    the live SDK; today it raises NotImplementedError so callers route to the
    human queue rather than silently calling out.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern (CAPABILITY_LAYER_MODE).
    D34 — 4-locale i18n: 한국어 / English / 日本語 / 中文(简). The KR canonical
          address surfaces because Korean is the demo's primary locale.
    D23 — Tier-1 agent #6 (logistics) — consumer of this tool.
    logistics.spec.md §6 — Tool table row for `address.normalize`.
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)

# Per-invocation USD cost estimate. `cost_watch` reads this attribute via
# `getattr(address_normalize, "usd_cost", 0.0)` so it can budget agent runs
# against the per-agent cap (logistics is $0.05/run; Maps Places lookups are
# ~$0.005/call at the regular tier).
USD_COST: float = 0.005


# The canonical Korean test address the brief pins us to. Kept module-private
# so the stub determinism remains a function of the input string alone.
_KR_CANONICAL_ADDRESS: str = "서울 강남구 테헤란로 152 강남파이낸스센터 11층"


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class AddressNormalizeInput(BaseModel):
    """Capability input. Mirrors logistics.spec.md §6 (`address.normalize`).

    Attributes:
        raw_address:   Free-text shipping address as the creator typed it.
                       Treated as DATA, not instructions — the logistics agent's
                       system prompt + prompt_guard handle injection attempts
                       UPSTREAM of this call.
        country_hint:  Optional ISO-3166-1 alpha-2 hint from the creator's
                       profile. Anchors inference when the raw text is sparse
                       (e.g. "서울 강남구" without a country marker).
    """

    model_config = ConfigDict(extra="forbid")

    raw_address: str = Field(min_length=1, max_length=2000, alias="rawAddress")
    country_hint: str | None = Field(
        default=None,
        min_length=2,
        max_length=2,
        alias="countryHint",
        description="ISO 3166-1 alpha-2 country hint from the creator profile.",
    )

    @field_validator("country_hint")
    @classmethod
    def _hint_is_iso_alpha2(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if len(v) != 2 or not v.isalpha():
            raise ValueError(
                f"countryHint must be ISO 3166-1 alpha-2 (got {v!r})"
            )
        return v.upper()


class AddressNormalizeOutput(BaseModel):
    """Capability output — ISO-standard shipping address components.

    Mirrors @ss/contracts ShippingAddressSchema (packages/contracts/src/
    shipment.ts:40-53) plus a `normalized_confidence_0_1` score so the
    logistics agent can decide whether to escalate per logistics.spec.md §6
    ("`address.normalize` returns INVALID confidence < 0.5").
    """

    model_config = ConfigDict(extra="forbid")

    recipient_name: str = Field(
        default="",
        max_length=200,
        alias="recipientName",
        description="Person/company name — empty when the raw text omits it.",
    )
    address_line1: str = Field(
        min_length=1, max_length=500, alias="addressLine1"
    )
    """Primary address line (street + number, or building + room)."""
    address_line2: str = Field(
        default="", max_length=500, alias="addressLine2"
    )
    """Apt / unit / building-name. Empty when not present."""
    city: str = Field(default="", max_length=200)
    state_or_province: str = Field(
        default="", max_length=200, alias="stateOrProvince"
    )
    postal_code: str = Field(default="", max_length=20, alias="postalCode")
    country_iso2: str = Field(
        min_length=2,
        max_length=2,
        alias="countryIso2",
        description="ISO 3166-1 alpha-2 country code (REQUIRED).",
    )
    phone: str | None = Field(
        default=None,
        max_length=40,
        description=(
            "Phone digits + formatting. Optional — many KR addresses omit "
            "the contact phone in the shipping line."
        ),
    )
    normalized_confidence_0_1: float = Field(
        ge=0.0,
        le=1.0,
        alias="normalizedConfidence01",
        description=(
            "Maps/Document-AI normalization confidence. The logistics agent "
            "escalates with reason='address_unparseable' when this is < 0.5 "
            "(logistics.spec.md §6)."
        ),
    )
    fetched_via: Literal["stub", "live"] = Field(alias="fetchedVia")
    """Which mode produced this row — included so downstream OTel traces can
    distinguish stubbed dev traffic from real Maps API traffic."""

    @field_validator("country_iso2")
    @classmethod
    def _country_iso2_uppercase_alpha(cls, v: str) -> str:
        if len(v) != 2 or not v.isalpha():
            raise ValueError(
                f"countryIso2 must be ISO 3166-1 alpha-2 (got {v!r})"
            )
        return v.upper()

    @field_validator("phone")
    @classmethod
    def _phone_minimum_digits(cls, v: str | None) -> str | None:
        """Reject obviously-malformed phone strings — must contain ≥7 digits.

        We don't enforce E.164 here; the carrier API scrubs the final form.
        This guard catches gross corruption ("abc", "12") that should never
        reach a carrier integration.
        """
        if v is None or v == "":
            return v
        digit_count = sum(1 for ch in v if ch.isdigit())
        if digit_count < 7:
            raise ValueError(
                f"phone must contain at least 7 digits, got {digit_count} in {v!r}"
            )
        return v


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def address_normalize(payload: AddressNormalizeInput) -> AddressNormalizeOutput:
    """Parse a free-text shipping address into ISO-standard components.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated `AddressNormalizeInput`.

    Returns:
        `AddressNormalizeOutput` with parsed components + normalization
        confidence in [0, 1].

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
address_normalize.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic canned parse.
#
# Contract per the task brief:
#   The known KR test address
#     "서울 강남구 테헤란로 152 강남파이낸스센터 11층"
#   produces a fully-populated KR-ISO row.
#
# We honor that contract verbatim and also produce stable, deterministic
# parses for any other input (input → output is a pure function of the raw
# text + country hint so golden tests stay reproducible).
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: AddressNormalizeInput) -> AddressNormalizeOutput:
    """Deterministic stub. Same input → same output, always."""
    raw = payload.raw_address.strip()

    if raw == _KR_CANONICAL_ADDRESS:
        return AddressNormalizeOutput(
            recipientName="",
            addressLine1="테헤란로 152",
            addressLine2="강남파이낸스센터 11층",
            city="강남구",
            stateOrProvince="서울특별시",
            postalCode="06236",
            countryIso2="KR",
            phone=None,
            normalizedConfidence01=0.95,
            fetchedVia="stub",
        )

    # Non-canonical inputs: produce a syntactically valid output with the
    # country hint (or "KR" default) and a low confidence so the logistics
    # agent escalates rather than ships garbage. line1 carries the raw text
    # truncated to the schema cap so the agent can render the partial parse
    # back to the operator.
    country = (payload.country_hint or "KR").upper()
    line1 = raw[:500] if raw else "(empty)"
    return AddressNormalizeOutput(
        recipientName="",
        addressLine1=line1,
        addressLine2="",
        city="",
        stateOrProvince="",
        postalCode="",
        countryIso2=country,
        phone=None,
        normalizedConfidence01=0.30,
        fetchedVia="stub",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Today raises NotImplementedError; the
# runtime converts that to an `EscalateToHuman` so the workflow routes to the
# human queue rather than crashing.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: AddressNormalizeInput) -> AddressNormalizeOutput:
    """Live Google Maps Places + Document AI call. Wired in W7 deploy phase."""
    raise NotImplementedError(
        "address_normalize live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "AddressNormalizeInput",
    "AddressNormalizeOutput",
    "USD_COST",
    "address_normalize",
]
