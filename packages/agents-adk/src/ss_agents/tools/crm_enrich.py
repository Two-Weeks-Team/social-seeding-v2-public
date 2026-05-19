"""crm_enrich — capability layer per D41.

Enriches a B2B lead with firmographic + buying-signal data for the
`lead_outreach_writer` agent (D23 Tier-1 agent #11). Implements the
`crm.enrich` capability declared in
`gcp-research/specs/tier1/lead_outreach_writer.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic enrichment — the canonical demo lead `lead@demo.com`
    always returns the same `Demo Co Inc.` firmographic fixture so the
    Phase-3 brand-vs-lead loop demo (D11) can be replayed offline.
    All other emails get a domain-derived, stable record (`company_name`
    inferred from the email domain; tech_stack + intent_signals stable
    across runs).

Live mode (CAPABILITY_LAYER_MODE=live):
    Real CRM enrichment provider call wired by the W7 deploy phase
    (NotImplementedError today — surfacing a typed escalation rather than
    silently calling out). The spec mentions Modal + Kimi as the live
    provider; the actual SDK selection lands with the secret-manager work
    in W7.

PII guardrails (per task brief):
    - `lead_email` must pass a lightweight RFC 5322 shape check (exactly
      one `@`, non-empty local + domain, domain has a `.`). The capability
      layer's downstream CRM provider does the deep MX validation.
    - `lead_name` is rejected when it matches Korean Resident Registration
      Number (주민등록번호, `XXXXXX-XXXXXXX`) or US SSN (`XXX-XX-XXXX`)
      patterns. Per PIPA Article 24, RRN must NEVER flow into a prompt
      context — fail closed here before any downstream call.

Citations:
    D41 — Capability layer ADK FunctionTool pattern (stub/live env switch +
          per-tool USD cost attribute).
    D11 — B2B lead loop is in v2 day-1 scope; the writer's `crm.enrich`
          tool is the second loop's enrichment surface.
    D22 — PIPA Article 23/24 compliance baked in day-1. RRN block here is
          the in-process belt-and-braces; Model Armor (D21) custom regex
          catches the long tail.
    lead_outreach_writer.spec.md §6 — Tool table row for `crm.enrich`.

Per-call cost: $0.005 — CRM enrichment providers (Clearbit / Apollo /
ZoomInfo class) quote ~$0.005 per match at the firmographic tier; this
keeps the writer's $1.20 spec cap (or the Phase-3 brief's tightened
$0.05) intact even if the agent re-enriches mid-draft.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)

USD_COST: float = 0.005
"""Per-call USD attribution surfaced via `crm_enrich.usd_cost` for the
runtime's `cost_watch` aggregator (D41)."""


# ─────────────────────────────────────────────────────────────────────────────
# PII regex patterns — fail-closed guardrails per PIPA Article 24 (D22).
#
# Korean RRN (주민등록번호): 6 digits, hyphen (optional), 7 digits.
# US SSN: 3 digits, hyphen, 2 digits, hyphen, 4 digits.
#
# We deliberately keep these tight + readable. False positives here are an
# operator-visible UX failure (legitimate names get blocked); Model Armor's
# custom regex set (D21) handles the long tail of jurisdictional ID formats.
# ─────────────────────────────────────────────────────────────────────────────


_KR_RRN_PATTERN = re.compile(r"\b\d{6}[-\s]?\d{7}\b")
"""Korean Resident Registration Number — 주민등록번호. Format
`YYMMDD-CRRRRRR` (13 digits). Match accepts optional hyphen / space."""

_US_SSN_PATTERN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
"""US Social Security Number — `XXX-XX-XXXX`. Strict (hyphen required) to
avoid matching arbitrary 9-digit numerics like order IDs."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class CrmEnrichInput(BaseModel):
    """Capability input. Mirrors lead_outreach_writer.spec.md §6 `crm.enrich`.

    Attributes:
        lead_email: Lead's business email. Required (the enrichment
            provider keys off this). Validated to a light RFC 5322 shape
            (exactly one `@`, non-empty local + domain, domain has a `.`).
            Deep MX validation is delegated to the live provider.
        company_domain: Optional explicit company domain. When None the
            stub derives it from the email's domain part. Live mode
            forwards this to the provider as a hint.
        lead_name: Optional human name of the lead. Rejected when it
            matches Korean RRN or US SSN patterns — PII MUST NOT enter
            prompt context (PIPA Article 24).
    """

    model_config = ConfigDict(extra="forbid")

    lead_email: str = Field(min_length=3, max_length=320)
    """RFC 5321 caps local-part + domain at 320 chars. We use the same
    light regex as `compliance.OutboundMessage.recipient_email` — see the
    field validator below for the exact shape contract."""

    company_domain: str | None = Field(default=None, max_length=253)
    """Optional explicit company domain (e.g. `acme.com`). RFC 1035 caps
    a domain at 253 chars. Live mode forwards as a hint; stub mode prefers
    this over the email-derived domain when present."""

    lead_name: str | None = Field(default=None, max_length=200)
    """Optional human name. Validated to NOT contain Korean RRN or US SSN
    patterns — fail closed per PIPA Article 24."""

    @field_validator("lead_email")
    @classmethod
    def _email_shape(cls, v: str) -> str:
        """Light RFC 5322 shape — exactly one `@`, non-empty local +
        domain, domain has a `.` separator. Mirrors the validator used in
        `ss_agents.agents.compliance.OutboundMessage.recipient_email`.

        We deliberately avoid Pydantic's `EmailStr` to dodge the
        `email-validator` runtime dep — the live CRM provider does the
        deep MX validation, this layer just rejects obvious shape errors.
        """
        if v.count("@") != 1:
            raise ValueError(
                f"invalid email shape (need exactly one @): {v!r}"
            )
        local, _, domain = v.partition("@")
        if not local or not domain or "." not in domain:
            raise ValueError(f"invalid email shape: {v!r}")
        return v

    @field_validator("lead_name")
    @classmethod
    def _no_pii_in_name(cls, v: str | None) -> str | None:
        """Reject Korean RRN / US SSN patterns in the lead's name.

        PIPA Article 24 forbids unique personal identifiers (RRN) from
        being processed without an explicit legal basis. A `crm.enrich`
        capability has no such basis — fail closed.

        Pattern coverage:
          - `YYMMDD-CRRRRRR` (KR RRN, with or without hyphen / space)
          - `XXX-XX-XXXX`    (US SSN, hyphenated)

        False positives are an operator-visible UX failure; the patterns
        above are tight (anchored on word boundaries + explicit digit
        counts) so casual name strings cannot accidentally match.
        """
        if v is None:
            return v
        if _KR_RRN_PATTERN.search(v):
            raise ValueError(
                "lead_name contains Korean RRN pattern (PIPA Article 24)"
            )
        if _US_SSN_PATTERN.search(v):
            raise ValueError(
                "lead_name contains US SSN pattern"
            )
        return v


# Employee-range bucket per the spec output schema. Discrete buckets keep
# the downstream prompt deterministic + reviewable; absolute counts vary
# wildly across providers so we never surface them raw.
EmployeeRange = Literal[
    "1-10",
    "11-50",
    "51-200",
    "201-500",
    "501-1000",
    "1001-5000",
    "5001+",
    "unknown",
]

# Revenue bucket per the spec output schema. Same discretization rationale
# as EmployeeRange — also keeps the writer from inventing precise USD
# figures the provider didn't actually return.
RevenueRangeUsd = Literal[
    "0-1M",
    "1M-10M",
    "10M-50M",
    "50M-250M",
    "250M-1B",
    "1B+",
    "unknown",
]


class CrmEnrichOutput(BaseModel):
    """Capability output. Per lead_outreach_writer.spec.md §6 task brief.

    Attributes:
        company_name: Resolved company name (often the email domain's
            registrable part for stub mode).
        industry: Top-level industry label (e.g. `Software`, `Cosmetics`).
        employee_range: Discrete bucket; see `EmployeeRange`.
        annual_revenue_usd_range: Discrete bucket; see `RevenueRangeUsd`.
        decision_maker_titles: Likely titles of decision makers at this
            company for the writer's CTA targeting (e.g. `Marketing Lead`,
            `Head of Growth`). Empty list when unknown.
        tech_stack: Detected tech stack (e.g. `Salesforce`, `Cafe24`,
            `Shopify`). Empty list when unknown.
        intent_signals: Recent intent signals (e.g. `hiring_marketers`,
            `recent_funding_round`). Empty list when unknown.
        enrichment_confidence_0_1: Self-rated 0-1 confidence in the match.
            The writer escalates when `< 0.5` per the spec's ICP-fit
            heuristic (`research.confidence` is the closest proxy until
            this capability lands).
    """

    model_config = ConfigDict(extra="forbid")

    company_name: str = Field(min_length=1, max_length=200)
    industry: str = Field(default="unknown", max_length=120)
    employee_range: EmployeeRange = "unknown"
    annual_revenue_usd_range: RevenueRangeUsd = "unknown"
    decision_maker_titles: list[str] = Field(default_factory=list, max_length=20)
    tech_stack: list[str] = Field(default_factory=list, max_length=50)
    intent_signals: list[str] = Field(default_factory=list, max_length=20)
    enrichment_confidence_0_1: float = Field(ge=0.0, le=1.0, default=0.0)


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def crm_enrich(payload: CrmEnrichInput) -> CrmEnrichOutput:
    """Enrich a B2B lead with firmographic + buying-signal data.

    The runtime selects stub vs live via the `CAPABILITY_LAYER_MODE` env
    var (D41). Stub mode returns deterministic canned data; live mode
    performs the real provider HTTP call (wired in W7).

    Args:
        payload: Validated `CrmEnrichInput`. Pydantic has already enforced
            the email shape + PII guardrails on lead_name.

    Returns:
        `CrmEnrichOutput` — firmographic fields + buying signals + a 0-1
        confidence score.

    Raises:
        NotImplementedError: If `CAPABILITY_LAYER_MODE=live` — until W7
            wires the real provider client. Caller (the writer agent's
            runtime) surfaces as `EscalateToHuman`.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
crm_enrich.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic enrichment.
#
# Contract per the task brief:
#   - `lead@demo.com` always returns the canonical `Demo Co Inc.` fixture.
#   - All other emails return a stable, domain-derived record so golden
#     tests + the /goal evaluator can replay offline.
# ─────────────────────────────────────────────────────────────────────────────


_DEMO_EMAIL: str = "lead@demo.com"
"""Canonical demo lead. Stable across /goal runs + Phase-3 demo recording
(D30). The fixture lines up with the Phase-3 brief's expected B2B sample
output."""


def _stub(payload: CrmEnrichInput) -> CrmEnrichOutput:
    """Deterministic stub. Same input → same output, always."""
    if payload.lead_email.lower() == _DEMO_EMAIL:
        return _demo_fixture()

    # Domain-derived stable fixture for any other email. The company name
    # is the registrable part of the email domain capitalized; tech_stack
    # and intent_signals are derived deterministically from a tiny hash so
    # two test runs against the same email yield byte-identical output.
    domain = payload.company_domain or payload.lead_email.split("@", 1)[1]
    registrable = domain.split(".")[0] if "." in domain else domain
    company_name = registrable.capitalize() if registrable else "Unknown Co"

    h = _stable_hash(payload.lead_email.lower())
    employee_range: EmployeeRange = _EMPLOYEE_BUCKETS[h % len(_EMPLOYEE_BUCKETS)]
    revenue_range: RevenueRangeUsd = _REVENUE_BUCKETS[(h >> 4) % len(_REVENUE_BUCKETS)]
    confidence = round(0.50 + ((h >> 8) % 41) / 100.0, 2)  # 0.50..0.90 stable

    logger.debug(
        "crm_enrich_stub",
        extra={
            "lead_email_domain": domain,
            "company_name": company_name,
            "confidence": confidence,
        },
    )
    return CrmEnrichOutput(
        company_name=company_name,
        industry="Software",
        employee_range=employee_range,
        annual_revenue_usd_range=revenue_range,
        decision_maker_titles=["Marketing Lead", "Head of Growth"],
        tech_stack=_STABLE_TECH_STACK,
        intent_signals=_STABLE_INTENT_SIGNALS,
        enrichment_confidence_0_1=confidence,
    )


def _demo_fixture() -> CrmEnrichOutput:
    """Canonical fixture for `lead@demo.com` — stable across runs."""
    return CrmEnrichOutput(
        company_name="Demo Co Inc.",
        industry="Cosmetics",
        employee_range="51-200",
        annual_revenue_usd_range="10M-50M",
        decision_maker_titles=[
            "Marketing Lead",
            "Head of Growth",
            "VP Brand",
        ],
        tech_stack=["Cafe24", "Shopify", "Klaviyo", "Google Analytics"],
        intent_signals=[
            "hiring_marketers",
            "recent_funding_round",
            "tiktok_account_inactive",
        ],
        enrichment_confidence_0_1=0.82,
    )


_EMPLOYEE_BUCKETS: list[EmployeeRange] = [
    "1-10",
    "11-50",
    "51-200",
    "201-500",
    "501-1000",
    "1001-5000",
]
_REVENUE_BUCKETS: list[RevenueRangeUsd] = [
    "0-1M",
    "1M-10M",
    "10M-50M",
    "50M-250M",
    "250M-1B",
]
_STABLE_TECH_STACK: list[str] = ["Salesforce", "HubSpot", "Slack"]
_STABLE_INTENT_SIGNALS: list[str] = ["recent_blog_activity"]


def _stable_hash(s: str) -> int:
    """FNV-1a 32-bit hash. Deterministic across Python versions (unlike
    `hash()`, which is salted per-process).

    Mirrors the helper used in `rapidapi_get_user_info._stable_hash` —
    duplicated here rather than imported to avoid a tools-module
    cross-dependency for a 6-line function.
    """
    h = 0x811C9DC5
    for ch in s.encode("utf-8"):
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Today raises NotImplementedError; the
# runtime converts that to an `EscalateToHuman` so the workflow routes to
# the human queue rather than crashing.
#
# When wired up the live path will:
#   1. Resolve `company_domain` (input override > email domain).
#   2. Call the CRM provider's enrichment endpoint with the company domain
#      and lead email. The spec lists `Modal + Kimi` as the live provider;
#      the actual SDK ships with the W7 secret-manager wiring.
#   3. Map provider response fields to the `CrmEnrichOutput` schema +
#      bucket employees/revenue to the discrete enums.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: CrmEnrichInput) -> CrmEnrichOutput:
    """Live CRM provider call. Wired in W7 deploy phase."""
    raise NotImplementedError("live mode wired in W7 deploy phase")


__all__ = [
    "CrmEnrichInput",
    "CrmEnrichOutput",
    "EmployeeRange",
    "RevenueRangeUsd",
    "USD_COST",
    "crm_enrich",
]
