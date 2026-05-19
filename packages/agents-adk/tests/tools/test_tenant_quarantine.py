"""tests/tools/test_tenant_quarantine.py — W2-C1 security_watch tenant.quarantine.

Coverage matrix:
    1. Default = stub; quarantine_id stable; expires_at = applied_at + ttl_hours.
    2. Pydantic input validation (severity enum, ttl bounds, reason length).
    3. Stub determinism + multi-tenant isolation.
    4. severity parametrize — soft vs hard restrictions differ.
    5. D10 operator allow-list — live mode rejects non-allowlisted operator.
    6. Live mode + allow-listed operator raises NotImplementedError (W7 msg).
    7. `usd_cost` attribute exposed for cost_watch aggregator (D41).
    8. Stub mode does NOT enforce allow-list (no-op safety).

Citations: D41 (capability layer stub/live), D10 (operator allow-list),
    D19 (Identity Platform), D23 (Tier-3 W3), security_watch.spec.md §6.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.tenant_quarantine import (
    USD_COST,
    QuarantineSeverity,
    TenantQuarantineInput,
    TenantQuarantineOutput,
    tenant_quarantine,
)


_OPERATOR = "app.2weeks@gmail.com"  # the D10 allow-listed operator
_BAD_OPERATOR = "evil@attacker.com"
_REASON = "Burst of PI blocks exceeded baseline; security_watch escalated."


# ─────────────────────────────────────────────────────────────────────────────
# Test 1 — default mode is stub; expires_at math
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub_expires_at_correct(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = tenant_quarantine(
        TenantQuarantineInput(
            tenant_id="t_demo000000000000",
            reason=_REASON,
            severity="soft",
            operator_user_id=_OPERATOR,
            ttl_hours=2,
        )
    )
    assert isinstance(out, TenantQuarantineOutput)
    assert out.quarantine_id.startswith("stub_qtn_soft_")
    # expires_at = applied_at + 2 hours.
    delta = out.expires_at - out.applied_at
    assert delta.total_seconds() == 2 * 3600


def test_stub_returns_restrictions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = tenant_quarantine(
        TenantQuarantineInput(
            tenant_id="t_demo000000000000",
            reason=_REASON,
            severity="soft",
            operator_user_id=_OPERATOR,
            ttl_hours=2,
        )
    )
    assert "block_new_agent_invocations" in out.restrictions
    assert "block_outbound_email_send" in out.restrictions


# ─────────────────────────────────────────────────────────────────────────────
# Test 2 — input validation
# ─────────────────────────────────────────────────────────────────────────────


class TestInputValidation:
    def test_rejects_unknown_severity(self) -> None:
        with pytest.raises(ValidationError):
            TenantQuarantineInput.model_validate(
                {
                    "tenant_id": "t_demo000000000000",
                    "reason": _REASON,
                    "severity": "medium",  # not in literal
                    "operator_user_id": _OPERATOR,
                    "ttl_hours": 2,
                }
            )

    def test_rejects_ttl_below_min(self) -> None:
        with pytest.raises(ValidationError):
            TenantQuarantineInput(
                tenant_id="t_demo000000000000",
                reason=_REASON,
                severity="soft",
                operator_user_id=_OPERATOR,
                ttl_hours=0,  # below 1
            )

    def test_rejects_ttl_above_max(self) -> None:
        with pytest.raises(ValidationError):
            TenantQuarantineInput(
                tenant_id="t_demo000000000000",
                reason=_REASON,
                severity="soft",
                operator_user_id=_OPERATOR,
                ttl_hours=169,  # above 168 (7 days)
            )

    def test_rejects_short_reason(self) -> None:
        with pytest.raises(ValidationError):
            TenantQuarantineInput(
                tenant_id="t_demo000000000000",
                reason="too short",  # < 20 chars
                severity="soft",
                operator_user_id=_OPERATOR,
                ttl_hours=2,
            )

    def test_rejects_empty_tenant_id(self) -> None:
        with pytest.raises(ValidationError):
            TenantQuarantineInput(
                tenant_id="",
                reason=_REASON,
                severity="soft",
                operator_user_id=_OPERATOR,
                ttl_hours=2,
            )

    def test_rejects_unknown_extra_field(self) -> None:
        with pytest.raises(ValidationError):
            TenantQuarantineInput.model_validate(
                {
                    "tenant_id": "t_demo000000000000",
                    "reason": _REASON,
                    "severity": "soft",
                    "operator_user_id": _OPERATOR,
                    "ttl_hours": 2,
                    "notify": True,  # not in schema
                }
            )


# ─────────────────────────────────────────────────────────────────────────────
# Test 3 — determinism + multi-tenant isolation
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism_same_input_same_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = TenantQuarantineInput(
        tenant_id="t_demo000000000000",
        reason=_REASON,
        severity="soft",
        operator_user_id=_OPERATOR,
        ttl_hours=2,
    )
    a = tenant_quarantine(payload)
    b = tenant_quarantine(payload)
    assert a.quarantine_id == b.quarantine_id


def test_different_tenants_different_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    a = tenant_quarantine(
        TenantQuarantineInput(
            tenant_id="t_a000000000000000",
            reason=_REASON,
            severity="soft",
            operator_user_id=_OPERATOR,
            ttl_hours=2,
        )
    )
    b = tenant_quarantine(
        TenantQuarantineInput(
            tenant_id="t_b000000000000000",
            reason=_REASON,
            severity="soft",
            operator_user_id=_OPERATOR,
            ttl_hours=2,
        )
    )
    assert a.quarantine_id != b.quarantine_id


# ─────────────────────────────────────────────────────────────────────────────
# Test 4 — severity parametrize (soft vs hard restriction sets differ)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("severity", ["soft", "hard"])
def test_severity_roundtrip_and_restrictions(
    severity: QuarantineSeverity, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = tenant_quarantine(
        TenantQuarantineInput(
            tenant_id="t_demo000000000000",
            reason=_REASON,
            severity=severity,
            operator_user_id=_OPERATOR,
            ttl_hours=2,
        )
    )
    assert out.quarantine_id.startswith(f"stub_qtn_{severity}_")
    assert len(out.restrictions) >= 2
    if severity == "hard":
        assert "suspend_identity_platform_tenant" in out.restrictions
        assert "revoke_kms_key_access" in out.restrictions
    else:
        assert "suspend_identity_platform_tenant" not in out.restrictions


def test_hard_has_more_restrictions_than_soft(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    soft = tenant_quarantine(
        TenantQuarantineInput(
            tenant_id="t_demo000000000000",
            reason=_REASON,
            severity="soft",
            operator_user_id=_OPERATOR,
            ttl_hours=2,
        )
    )
    hard = tenant_quarantine(
        TenantQuarantineInput(
            tenant_id="t_demo000000000000",
            reason=_REASON,
            severity="hard",
            operator_user_id=_OPERATOR,
            ttl_hours=2,
        )
    )
    assert len(hard.restrictions) > len(soft.restrictions)


# ─────────────────────────────────────────────────────────────────────────────
# Test 5 — D10 allow-list guardrail (live mode)
# ─────────────────────────────────────────────────────────────────────────────


class TestD10AllowListGuardrail:
    def test_live_mode_rejects_non_allowlisted_operator(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(ValueError, match=r"D10 allow-list"):
            tenant_quarantine(
                TenantQuarantineInput(
                    tenant_id="t_demo000000000000",
                    reason=_REASON,
                    severity="hard",
                    operator_user_id=_BAD_OPERATOR,
                    ttl_hours=2,
                )
            )

    def test_stub_mode_does_not_enforce_allowlist(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Stub mode is a no-op — the allow-list runs ONLY in live mode."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = tenant_quarantine(
            TenantQuarantineInput(
                tenant_id="t_demo000000000000",
                reason=_REASON,
                severity="soft",
                operator_user_id=_BAD_OPERATOR,  # not allow-listed
                ttl_hours=2,
            )
        )
        # Stub completes — no enforcement.
        assert out.quarantine_id.startswith("stub_qtn_soft_")


# ─────────────────────────────────────────────────────────────────────────────
# Test 6 — live mode + allow-listed operator raises NotImplementedError
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_allowlisted_operator_raises_not_implemented(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        tenant_quarantine(
            TenantQuarantineInput(
                tenant_id="t_demo000000000000",
                reason=_REASON,
                severity="soft",
                operator_user_id=_OPERATOR,  # allow-listed
                ttl_hours=2,
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# Test 7 — cost attribute (D41)
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(tenant_quarantine, "usd_cost")
    assert tenant_quarantine.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert 0.0 < USD_COST < 0.01


# ─────────────────────────────────────────────────────────────────────────────
# Test 8 — TTL bounds parametrize
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("ttl_hours", [1, 24, 72, 168])
def test_ttl_bounds_accepted(
    ttl_hours: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = tenant_quarantine(
        TenantQuarantineInput(
            tenant_id="t_demo000000000000",
            reason=_REASON,
            severity="soft",
            operator_user_id=_OPERATOR,
            ttl_hours=ttl_hours,
        )
    )
    delta_hours = (out.expires_at - out.applied_at).total_seconds() / 3600
    assert abs(delta_hours - ttl_hours) < 0.01
