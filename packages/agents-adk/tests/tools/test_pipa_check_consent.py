"""tests/tools/test_pipa_check_consent.py — capability-layer seam tests.

Coverage matrix (W2-B3):

    1. Default = stub mode (no env var) → canonical demo email returns
       granted=True, every other email returns granted=False.
    2. Determinism — repeated calls produce byte-identical output.
    3. Live mode raises NotImplementedError with the W7 deploy phase message.
    4. Input validation — Pydantic rejects bad email shapes, missing fields,
       unknown fields, and out-of-enum consent types.
    5. PIPA Article 22 granularity — the consent_type literal is enforced
       per-purpose (marketing / transactional / analytics).
    6. opt_out_url is ALWAYS present (PIPA Article 22 §3 right-to-manage)
       regardless of consent state.
    7. `usd_cost` attribute is surfaced for the `cost_watch` aggregator (D41).

Citations: D41 (capability layer stub/live), D22 (PIPA day-1),
    compliance.spec.md §6.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.pipa_check_consent import (
    USD_COST,
    PipaCheckConsentInput,
    PipaCheckConsentOutput,
    pipa_check_consent,
)


# ─────────────────────────────────────────────────────────────────────────────
# Test 1 — default mode is stub
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub_granted_for_demo_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stub returns granted=True for the canonical demo address."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = pipa_check_consent(
        PipaCheckConsentInput(
            recipientEmail="consent_test@2weeks.com",
            workspaceId="ws_demo_compliance",
            consentType="marketing",
        )
    )
    assert isinstance(out, PipaCheckConsentOutput)
    assert out.consent_granted is True
    assert out.consent_date == "2026-04-01T00:00:00+00:00"
    assert out.consent_source == "tiktok_form_2026-04-01"
    assert out.requires_re_consent is False
    assert out.opt_out_url.startswith("https://")


def test_default_mode_is_stub_denied_for_other_emails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stub returns granted=False + requires_re_consent=True for any
    address other than the canonical demo email."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = pipa_check_consent(
        PipaCheckConsentInput(
            recipientEmail="creator@example.com",
            workspaceId="ws_demo_compliance",
            consentType="marketing",
        )
    )
    assert out.consent_granted is False
    assert out.consent_date is None
    assert out.consent_source is None
    assert out.requires_re_consent is True
    # Right-to-manage URL is mandatory even when consent is absent (PIPA §3).
    assert out.opt_out_url


def test_demo_email_is_case_insensitive(monkeypatch: pytest.MonkeyPatch) -> None:
    """Email local-part is case-insensitive per RFC 5321 §2.3.11 (we apply
    case-insensitive comparison so 'Consent_Test@2weeks.com' also matches)."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = pipa_check_consent(
        PipaCheckConsentInput(
            recipientEmail="Consent_Test@2WEEKS.com",
            workspaceId="ws_demo_compliance",
            consentType="transactional",
        )
    )
    assert out.consent_granted is True


# ─────────────────────────────────────────────────────────────────────────────
# Test 2 — determinism
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism_granted_branch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two calls with the same input produce byte-identical JSON output."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = PipaCheckConsentInput(
        recipientEmail="consent_test@2weeks.com",
        workspaceId="ws_demo_compliance",
        consentType="marketing",
    )
    a = pipa_check_consent(payload)
    b = pipa_check_consent(payload)
    assert a.model_dump_json() == b.model_dump_json()


def test_stub_determinism_denied_branch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = PipaCheckConsentInput(
        recipientEmail="cold@nowhere.example",
        workspaceId="ws_demo_compliance",
        consentType="analytics",
    )
    a = pipa_check_consent(payload)
    b = pipa_check_consent(payload)
    assert a.model_dump_json() == b.model_dump_json()


# ─────────────────────────────────────────────────────────────────────────────
# Test 3 — live mode raises with W7 message
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        pipa_check_consent(
            PipaCheckConsentInput(
                recipientEmail="anyone@example.com",
                workspaceId="ws_demo_compliance",
                consentType="marketing",
            )
        )


def test_unknown_mode_falls_through_to_live(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Per D41 the env var is a binary stub|live switch. Any non-`stub`
    value routes to the live path (and therefore NotImplementedError until
    W7), which is the safe failure mode."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "production")
    with pytest.raises(NotImplementedError):
        pipa_check_consent(
            PipaCheckConsentInput(
                recipientEmail="anyone@example.com",
                workspaceId="ws_demo_compliance",
                consentType="marketing",
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# Test 4 — input validation
# ─────────────────────────────────────────────────────────────────────────────


class TestInputValidation:
    """Pydantic + `extra=forbid` fails closed on every malformed input."""

    def test_input_rejects_missing_recipient_email(self) -> None:
        with pytest.raises(ValidationError):
            PipaCheckConsentInput.model_validate(
                {"workspaceId": "ws_demo_compliance", "consentType": "marketing"}
            )

    def test_input_rejects_missing_workspace_id(self) -> None:
        with pytest.raises(ValidationError):
            PipaCheckConsentInput.model_validate(
                {
                    "recipientEmail": "x@example.com",
                    "consentType": "marketing",
                }
            )

    def test_input_rejects_missing_consent_type(self) -> None:
        with pytest.raises(ValidationError):
            PipaCheckConsentInput.model_validate(
                {
                    "recipientEmail": "x@example.com",
                    "workspaceId": "ws_demo_compliance",
                }
            )

    def test_input_rejects_unknown_field(self) -> None:
        with pytest.raises(ValidationError):
            PipaCheckConsentInput.model_validate(
                {
                    "recipientEmail": "x@example.com",
                    "workspaceId": "ws_demo_compliance",
                    "consentType": "marketing",
                    "secretField": "should-fail",
                }
            )

    def test_input_rejects_invalid_consent_type(self) -> None:
        """Only marketing/transactional/analytics are accepted."""
        with pytest.raises(ValidationError):
            PipaCheckConsentInput.model_validate(
                {
                    "recipientEmail": "x@example.com",
                    "workspaceId": "ws_demo_compliance",
                    "consentType": "promotional",  # not in literal
                }
            )

    @pytest.mark.parametrize(
        "bad_email",
        [
            "no-at-sign.example.com",
            "double@@sign.example.com",
            "no-domain@",
            "no-local@example.com" .replace("no-local", ""),  # empty local
            "no-tld@example",
        ],
    )
    def test_input_rejects_bad_email_shape(self, bad_email: str) -> None:
        with pytest.raises(ValidationError):
            PipaCheckConsentInput(
                recipientEmail=bad_email,
                workspaceId="ws_demo_compliance",
                consentType="marketing",
            )

    def test_input_rejects_oversize_recipient_email(self) -> None:
        """RFC 5321 caps email at 320 chars."""
        long_local = "a" * 400
        with pytest.raises(ValidationError):
            PipaCheckConsentInput(
                recipientEmail=f"{long_local}@x.example",
                workspaceId="ws_demo_compliance",
                consentType="marketing",
            )


# ─────────────────────────────────────────────────────────────────────────────
# Test 5 — PIPA Article 22 granularity (per-purpose consent)
# ─────────────────────────────────────────────────────────────────────────────


class TestConsentTypeGranularity:
    """PIPA Article 22 mandates granular consent per purpose. The tool's
    contract supports the 3 day-1 purposes; the stub treats them uniformly
    for the demo address but the input shape enforces granularity."""

    @pytest.mark.parametrize(
        "consent_type", ["marketing", "transactional", "analytics"]
    )
    def test_each_consent_type_resolves_for_demo_email(
        self, consent_type: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = pipa_check_consent(
            PipaCheckConsentInput(
                recipientEmail="consent_test@2weeks.com",
                workspaceId="ws_demo_compliance",
                consentType=consent_type,  # type: ignore[arg-type]
            )
        )
        assert out.consent_granted is True


# ─────────────────────────────────────────────────────────────────────────────
# Test 6 — right-to-manage URL is always present
# ─────────────────────────────────────────────────────────────────────────────


def test_opt_out_url_is_always_present_regardless_of_consent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """PIPA Article 22 §3: recipients have a right to manage preferences
    regardless of current consent state — the opt_out_url is mandatory."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    for email in (
        "consent_test@2weeks.com",
        "stranger@example.com",
        "OTHER@example.org",
    ):
        out = pipa_check_consent(
            PipaCheckConsentInput(
                recipientEmail=email,
                workspaceId="ws_demo_compliance",
                consentType="marketing",
            )
        )
        assert out.opt_out_url, f"opt_out_url missing for {email}"
        assert out.opt_out_url.startswith("https://")


# ─────────────────────────────────────────────────────────────────────────────
# Test 7 — cost attribute
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    """Per D41, the cost watch reads `tool_fn.usd_cost` to aggregate spend."""
    assert hasattr(pipa_check_consent, "usd_cost")
    assert pipa_check_consent.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(pipa_check_consent.usd_cost, float)  # type: ignore[attr-defined]


def test_cost_is_sub_cent() -> None:
    """Compliance agent's $0.03 cap must not be eroded by tool calls."""
    assert 0.0 < USD_COST < 0.01
