"""tests/tools/test_crm_enrich.py — capability-layer seam tests.

Per D41 + W2-B1 brief: the `crm.enrich` capability tool (the B2B lead
loop's enrichment surface) ships with the same stub/live dispatch
contract as the four W2-A1 sourcing tools, PLUS two PII guardrails
required by PIPA Article 24 (D22):

  1. Default (no env var) ⇒ stub path runs ⇒ deterministic fixture data.
  2. Stub determinism — same input ⇒ byte-identical output (canonical
     demo lead + domain-derived path both).
  3. Live mode (CAPABILITY_LAYER_MODE=live) raises NotImplementedError
     with a clear "W7 deploy phase" message.
  4. Pydantic input validation:
       a. Rejects invalid email shape (no `@`, two `@`, missing `.`).
       b. Rejects `extra='forbid'` extra keys.
       c. Rejects Korean RRN (주민등록번호) embedded in lead_name.
       d. Rejects US SSN embedded in lead_name.
  5. Cost attribute exposed for cost_watch (D41).
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.crm_enrich import (
    USD_COST,
    CrmEnrichInput,
    CrmEnrichOutput,
    crm_enrich,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Default = stub: env unset ⇒ stub path
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """When CAPABILITY_LAYER_MODE is unset, the tool runs the stub path."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = crm_enrich(CrmEnrichInput(lead_email="lead@demo.com"))
    assert isinstance(out, CrmEnrichOutput)
    assert out.company_name == "Demo Co Inc."


def test_stub_explicit_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """CAPABILITY_LAYER_MODE=stub also drives the stub path."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = crm_enrich(CrmEnrichInput(lead_email="lead@demo.com"))
    assert out.company_name == "Demo Co Inc."
    assert out.industry == "Cosmetics"
    assert out.employee_range == "51-200"
    assert out.annual_revenue_usd_range == "10M-50M"
    assert out.enrichment_confidence_0_1 == pytest.approx(0.82)
    assert "Marketing Lead" in out.decision_maker_titles
    assert "Cafe24" in out.tech_stack
    assert "hiring_marketers" in out.intent_signals


def test_stub_canonical_demo_case_insensitive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The canonical demo branch is case-insensitive on the email."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = crm_enrich(CrmEnrichInput(lead_email="LEAD@DEMO.COM"))
    assert out.company_name == "Demo Co Inc."


def test_stub_non_canonical_email_returns_domain_derived(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Non-canonical emails get a stable domain-derived record."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = crm_enrich(CrmEnrichInput(lead_email="vp@acme.com"))
    assert out.company_name == "Acme"
    assert out.industry == "Software"
    # Confidence is a stable float in the [0.50, 0.90] band.
    assert 0.50 <= out.enrichment_confidence_0_1 <= 0.90


def test_stub_company_domain_override(monkeypatch: pytest.MonkeyPatch) -> None:
    """`company_domain` overrides the email-derived domain in stub mode."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = crm_enrich(
        CrmEnrichInput(
            lead_email="contact@personal-gmail.com",
            company_domain="freshly.example.kr",
        )
    )
    assert out.company_name == "Freshly"


# ─────────────────────────────────────────────────────────────────────────────
# 2. Determinism — same input ⇒ same output
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism_demo_lead(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two stub calls with the canonical demo email return identical JSON."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = CrmEnrichInput(lead_email="lead@demo.com")
    a = crm_enrich(payload)
    b = crm_enrich(payload)
    assert a.model_dump_json() == b.model_dump_json()


def test_stub_determinism_arbitrary_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two stub calls with the same non-canonical email return identical JSON."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = CrmEnrichInput(
        lead_email="growth@example.io",
        company_domain="example.io",
        lead_name="Alex Park",
    )
    a = crm_enrich(payload)
    b = crm_enrich(payload)
    assert a.model_dump_json() == b.model_dump_json()


# ─────────────────────────────────────────────────────────────────────────────
# 3. Live mode raises with a clear "W7" message
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    """CAPABILITY_LAYER_MODE=live raises NotImplementedError citing W7."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        crm_enrich(CrmEnrichInput(lead_email="lead@demo.com"))


# ─────────────────────────────────────────────────────────────────────────────
# 4a. Input validation — email shape (RFC 5322 light)
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_missing_at_sign() -> None:
    """No `@` ⇒ invalid email shape."""
    with pytest.raises(ValidationError, match=r"invalid email shape"):
        CrmEnrichInput(lead_email="lead.demo.com")


def test_input_rejects_two_at_signs() -> None:
    """Two `@`s ⇒ invalid email shape."""
    with pytest.raises(ValidationError, match=r"invalid email shape"):
        CrmEnrichInput(lead_email="lead@@demo.com")


def test_input_rejects_missing_domain_dot() -> None:
    """Domain without a `.` ⇒ invalid email shape."""
    with pytest.raises(ValidationError, match=r"invalid email shape"):
        CrmEnrichInput(lead_email="lead@localhost")


def test_input_rejects_empty_local_part() -> None:
    """Empty local part ⇒ invalid email shape."""
    with pytest.raises(ValidationError, match=r"invalid email shape"):
        CrmEnrichInput(lead_email="@demo.com")


def test_input_rejects_empty_email_string() -> None:
    """Empty string ⇒ min_length=3 trips first."""
    with pytest.raises(ValidationError):
        CrmEnrichInput(lead_email="")


# ─────────────────────────────────────────────────────────────────────────────
# 4b. Input validation — extra='forbid'
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_unknown_field() -> None:
    """extra='forbid' rejects extra keys."""
    with pytest.raises(ValidationError):
        CrmEnrichInput.model_validate(
            {"lead_email": "lead@demo.com", "unknown_field": "boom"}
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4c. PII guardrails — Korean RRN (주민등록번호) embedded in lead_name
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_korean_rrn_with_hyphen() -> None:
    """`YYMMDD-CRRRRRR` shape (with hyphen) ⇒ PIPA Article 24 block."""
    with pytest.raises(ValidationError, match=r"Korean RRN|PIPA"):
        CrmEnrichInput(
            lead_email="kim@example.kr",
            lead_name="김세준 900101-1234567",
        )


def test_input_rejects_korean_rrn_no_hyphen() -> None:
    """Bare 13-digit RRN (no hyphen) ⇒ PIPA Article 24 block."""
    with pytest.raises(ValidationError, match=r"Korean RRN|PIPA"):
        CrmEnrichInput(
            lead_email="kim@example.kr",
            lead_name="김세준 9001011234567",
        )


def test_input_rejects_korean_rrn_with_space() -> None:
    """`YYMMDD␣CRRRRRR` shape (space separator) ⇒ PIPA Article 24 block."""
    with pytest.raises(ValidationError, match=r"Korean RRN|PIPA"):
        CrmEnrichInput(
            lead_email="kim@example.kr",
            lead_name="김세준 900101 1234567",
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4d. PII guardrails — US SSN embedded in lead_name
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_us_ssn() -> None:
    """`XXX-XX-XXXX` ⇒ US SSN block."""
    with pytest.raises(ValidationError, match=r"US SSN|SSN"):
        CrmEnrichInput(
            lead_email="alex@acme.com",
            lead_name="Alex Park 123-45-6789",
        )


def test_input_accepts_clean_name() -> None:
    """A legitimate human name passes the PII guardrails."""
    payload = CrmEnrichInput(
        lead_email="alex@acme.com",
        lead_name="Alex Park",
    )
    assert payload.lead_name == "Alex Park"


def test_input_accepts_korean_name() -> None:
    """A legitimate Korean name (no RRN) passes the PII guardrails."""
    payload = CrmEnrichInput(
        lead_email="kim@example.kr",
        lead_name="김세준",
    )
    assert payload.lead_name == "김세준"


def test_input_accepts_none_lead_name() -> None:
    """lead_name is optional — None is the canonical default."""
    payload = CrmEnrichInput(lead_email="lead@demo.com")
    assert payload.lead_name is None


# ─────────────────────────────────────────────────────────────────────────────
# 5. Cost attribute exposed for cost_watch (D41)
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    """The function carries a `usd_cost` attribute so cost_watch can read it."""
    assert hasattr(crm_enrich, "usd_cost")
    assert crm_enrich.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(crm_enrich.usd_cost, float)  # type: ignore[attr-defined]
    assert crm_enrich.usd_cost > 0.0  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# 6. Output schema sanity — extra='forbid' on the output too
# ─────────────────────────────────────────────────────────────────────────────


def test_output_extra_fields_forbidden() -> None:
    """Output schema is `extra='forbid'` — defense in depth against drift."""
    with pytest.raises(ValidationError):
        CrmEnrichOutput.model_validate(
            {
                "company_name": "Acme",
                "extra_drift_field": "boom",
            }
        )
