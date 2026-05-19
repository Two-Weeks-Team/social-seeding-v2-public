"""carrier_create — capability layer per D41.

Create a shipment label via a carrier API. Implements the `carrier.create`
capability declared in `gcp-research/specs/tier1/logistics.spec.md §6`
(ARCHITECTURE.md §3 row 6: `logistics | 1 | Gemini 2.5 Flash |
address.normalize, carrier.create`).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic canned shipment row. Tracking number is the pinned
    `KR1234567890`; PDF URL, cost, and carrier name are constants so
    workflow / agent goldens stay reproducible.

Live mode (CAPABILITY_LAYER_MODE=live):
    PER THE TASK BRIEF the carrier adapter is **deferred 2026-05-14**
    pending the O11 decision (carrier selection — Yuntrack port vs.
    direct CJ Logistics integration). Until O11 lands, any attempt to
    use live mode raises NotImplementedError so the runtime surfaces a
    typed `EscalateToHuman` rather than silently calling an unfinished
    adapter.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern (CAPABILITY_LAYER_MODE).
    D23 — Tier-1 agent #6 (logistics) — consumer of this tool.
    D34 — 4-locale i18n. The stub label PDF URL is locale-neutral; W7's
          live mode will route to the operator's locale label template.
    logistics.spec.md §6 — Tool table row for `carrier.create`.
    Carrier adapter deferred per the W2 task brief (2026-05-14).
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)

# Per-invocation USD cost estimate. `cost_watch` reads this attribute via
# `getattr(carrier_create, "usd_cost", 0.0)` so it can budget agent runs
# against the per-agent cap (logistics is $0.05/run; the carrier API call
# itself is metered separately as shipping cost, NOT inference cost — the
# attribute here is the API-call surcharge only).
USD_COST: float = 0.002


# Stub constants — pinned per the task brief so the goldens stay byte-stable.
_STUB_TRACKING_NUMBER: str = "KR1234567890"
_STUB_LABEL_PDF_URL: str = "https://stub.local/label/KR123.pdf"
_STUB_COST_USD: float = 8.50
_STUB_CARRIER: str = "cj-logistics-stub"
_STUB_ESTIMATED_DELIVERY: str = "2026-05-23"  # ISO-8601 date, deterministic.


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class ParcelAddress(BaseModel):
    """One address row inside a carrier shipment request.

    Mirrors @ss/contracts ShippingAddressSchema (packages/contracts/src/
    shipment.ts:40-53) with the minimum fields any carrier API requires.
    """

    model_config = ConfigDict(extra="forbid")

    recipient_name: str = Field(
        min_length=1, max_length=200, alias="recipientName"
    )
    address_line1: str = Field(min_length=1, max_length=500, alias="addressLine1")
    address_line2: str = Field(default="", max_length=500, alias="addressLine2")
    city: str = Field(default="", max_length=200)
    state_or_province: str = Field(
        default="", max_length=200, alias="stateOrProvince"
    )
    postal_code: str = Field(default="", max_length=20, alias="postalCode")
    country_iso2: str = Field(
        min_length=2, max_length=2, alias="countryIso2"
    )
    phone: str | None = Field(
        default=None,
        max_length=40,
        description="Optional contact phone for the recipient.",
    )

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
        """Reject malformed phone strings — at least 7 digits required.

        Matches address_normalize's phone validator so address.normalize output
        flows straight into carrier.create input without re-validation drift.
        """
        if v is None or v == "":
            return v
        digit_count = sum(1 for ch in v if ch.isdigit())
        if digit_count < 7:
            raise ValueError(
                f"phone must contain at least 7 digits, got {digit_count} in {v!r}"
            )
        return v


class ParcelDimensions(BaseModel):
    """Physical dimensions + weight of the parcel.

    All four fields must be strictly positive — carriers reject zero-volume
    or zero-weight parcels (logistics.spec.md §6 escalation path
    `unsupported_country` only fires once the parcel is valid).
    """

    model_config = ConfigDict(extra="forbid")

    length_cm: float = Field(gt=0.0, le=300.0, alias="lengthCm")
    width_cm: float = Field(gt=0.0, le=300.0, alias="widthCm")
    height_cm: float = Field(gt=0.0, le=300.0, alias="heightCm")
    weight_grams: float = Field(gt=0.0, le=30_000.0, alias="weightGrams")


class CarrierCreateInput(BaseModel):
    """Capability input. Mirrors logistics.spec.md §6 (`carrier.create`).

    Attributes:
        from_address:   Origin address (warehouse / fulfillment center).
        to_address:     Destination address (creator's normalized address).
        parcel_dims:    Physical dimensions + weight of the parcel.
        declared_value_usd: Declared value in USD for customs. Non-negative.
    """

    model_config = ConfigDict(extra="forbid")

    from_address: ParcelAddress = Field(alias="fromAddress")
    to_address: ParcelAddress = Field(alias="toAddress")
    parcel_dims: ParcelDimensions = Field(alias="parcelDims")
    declared_value_usd: float = Field(
        ge=0.0, le=100_000.0, alias="declaredValueUsd"
    )


class CarrierCreateOutput(BaseModel):
    """Capability output — shipment label + tracking + cost.

    Mirrors @ss/contracts ShipmentSchema fields needed by the logistics agent
    (shipment.ts:82-109): tracking_number → Shipment.trackingNumber; carrier →
    Shipment.carrier; cost_usd lands in the campaign cost ledger via the
    workflow.
    """

    model_config = ConfigDict(extra="forbid")

    tracking_number: str = Field(
        min_length=1, max_length=64, alias="trackingNumber"
    )
    label_pdf_url: str = Field(
        min_length=1, max_length=2000, alias="labelPdfUrl"
    )
    estimated_delivery: str = Field(
        min_length=1, max_length=32, alias="estimatedDelivery",
        description="ISO-8601 date (YYYY-MM-DD) — carrier ETA.",
    )
    cost_usd: float = Field(ge=0.0, alias="costUsd")
    carrier: str = Field(min_length=1, max_length=64)
    fetched_via: Literal["stub", "live"] = Field(alias="fetchedVia")
    """Which mode produced this row — included so downstream OTel traces can
    distinguish stubbed dev traffic from real carrier traffic."""


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def carrier_create(payload: CarrierCreateInput) -> CarrierCreateOutput:
    """Create a shipment label + tracking number via a carrier API.

    Capability-layer dispatch (D41): stub by default. Live mode raises
    NotImplementedError per the W2 task brief (carrier adapter deferred
    2026-05-14, pending the O11 decision).

    Args:
        payload: Validated `CarrierCreateInput`.

    Returns:
        `CarrierCreateOutput` with tracking number, label URL, ETA, cost.

    Raises:
        NotImplementedError: live mode — carrier adapter deferred pending
            O11 decision (W2 task brief).
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
carrier_create.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic shipment row per the task brief.
#
# Contract per the task brief (pinned constants):
#   tracking_number = "KR1234567890"
#   label_pdf_url   = "https://stub.local/label/KR123.pdf"
#   cost_usd        = 8.50
#   carrier         = "cj-logistics-stub"
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: CarrierCreateInput) -> CarrierCreateOutput:
    """Deterministic stub. Same input → same output, always.

    The output is independent of the input (we always return the same
    canonical shipment). This is a deliberate choice — Phase 3 workflow
    goldens compare byte-for-byte against this row.
    """
    logger.debug(
        "carrier_create_stub",
        extra={
            "to_country": payload.to_address.country_iso2,
            "weight_grams": payload.parcel_dims.weight_grams,
            "declared_value_usd": payload.declared_value_usd,
        },
    )
    return CarrierCreateOutput(
        trackingNumber=_STUB_TRACKING_NUMBER,
        labelPdfUrl=_STUB_LABEL_PDF_URL,
        estimatedDelivery=_STUB_ESTIMATED_DELIVERY,
        costUsd=_STUB_COST_USD,
        carrier=_STUB_CARRIER,
        fetchedVia="stub",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live — DEFERRED 2026-05-14 per the W2 task brief.
#
# Per the brief: "live mode raises NotImplementedError with 'carrier adapter
# deferred pending O11 decision'." The runtime converts this to an
# `EscalateToHuman` so the workflow routes to the human queue.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: CarrierCreateInput) -> CarrierCreateOutput:
    """Live carrier API call — deferred pending O11 decision (2026-05-14)."""
    raise NotImplementedError("carrier adapter deferred pending O11 decision")


__all__ = [
    "CarrierCreateInput",
    "CarrierCreateOutput",
    "ParcelAddress",
    "ParcelDimensions",
    "USD_COST",
    "carrier_create",
]
