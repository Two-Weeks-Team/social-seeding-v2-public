"""tests/tools/test_intervention_propose.py

Covers four contracts on the `intervention_propose` capability tool:

1. **Stub determinism** — same `(signal_type, severity)` → identical
   output. Per-signal canonical playbook pins (`onboarding_stall=call`,
   `churn_risk=email`, `upsell_opportunity=feature_unlock`,
   `reply_rate_drop=slack_ping`).
2. **Signal-type 4-way parametrize** — every value of the `SignalType`
   Literal produces a valid intervention with a sensible `escalation_path`.
3. **Severity gates intervention_kind / dry_run flag** — `severity=high`
   forces `dry_run_required=False`; `low`/`medium` force `True`. The
   `intervention_kind` itself is signal-driven, not severity-driven, but
   the gate flips the auto-execute behavior.
4. **Pydantic validation** — `extra=forbid`, workspace_id pattern,
   signal_type / severity Literals, escalation_path URI shape.
5. **Live NotImplementedError** + cost attribute surfacing.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D28 — Per-view pricing; intervention proposals must NEVER recommend
          a discount > 25% (Drucker §9 + customer_success.py §Discipline).
    D32 — intervention-as-runbook on Cloud Workflows. `escalation_path`
          fields are runbook URIs in stub mode.
    customer_success.spec.md §6 — `intervention.propose` tool contract.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.intervention_propose import (
    USD_COST,
    InterventionProposeInput,
    InterventionProposeOutput,
    intervention_propose,
)


# ─────────────────────────────────────────────────────────────────────────────
# Canonical fixtures.
# ─────────────────────────────────────────────────────────────────────────────


_WORKSPACE_ID = "ws_demo_cs_iprop"


# Per-signal canonical pinning derived directly from the brief's stub spec.
# Each row = (signal_type, expected_intervention_kind, expected_path_substr).
# Kept as a separate constant so the parametrize block + the canonical
# determinism tests share a single source of truth.
_CANONICAL_PINS: list[tuple[str, str, str]] = [
    ("onboarding_stall", "call", "csm-call"),
    ("churn_risk", "email", "recovery-email"),
    ("upsell_opportunity", "feature_unlock", "feature-unlock"),
    ("reply_rate_drop", "slack_ping", "template-swap"),
]


def _input(
    *,
    workspace_id: str = _WORKSPACE_ID,
    signal_type: str = "onboarding_stall",
    severity: str = "medium",
) -> InterventionProposeInput:
    return InterventionProposeInput(
        workspace_id=workspace_id,
        signal_type=signal_type,  # type: ignore[arg-type]
        severity=severity,  # type: ignore[arg-type]
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism + per-signal canonical pins.
# ─────────────────────────────────────────────────────────────────────────────


class TestStubDeterminism:
    """Stub output must match the brief's documented canonical values."""

    def test_same_input_yields_byte_identical_output(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Re-invoking with the same input twice produces equal models."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out_a = intervention_propose(_input())
        out_b = intervention_propose(_input())
        assert out_a == out_b

    def test_onboarding_stall_maps_to_call(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Per brief: onboarding_stall → call (CSM phone intervention)."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = intervention_propose(_input(signal_type="onboarding_stall"))
        assert out.intervention_kind == "call"
        assert out.fetched_via == "stub"

    def test_churn_risk_maps_to_email(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Per brief: churn_risk → email (recovery email)."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = intervention_propose(_input(signal_type="churn_risk"))
        assert out.intervention_kind == "email"

    def test_upsell_opportunity_maps_to_feature_unlock(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Per brief: upsell_opportunity → feature_unlock (NOT credit_bonus
        — Drucker §9 forbids burning margin on growth signals)."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = intervention_propose(_input(signal_type="upsell_opportunity"))
        assert out.intervention_kind == "feature_unlock"

    def test_reply_rate_drop_maps_to_slack_ping(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Per brief: reply_rate_drop → slack_ping (low-overhead nudge,
        not a CSM call)."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = intervention_propose(_input(signal_type="reply_rate_drop"))
        assert out.intervention_kind == "slack_ping"

    def test_workspace_id_does_not_alter_stub_surface(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The canonical playbook is workspace-agnostic in stub mode."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out_a = intervention_propose(
            _input(workspace_id="ws_alpha_aaaaaaaa", signal_type="churn_risk")
        )
        out_b = intervention_propose(
            _input(workspace_id="ws_beta_bbbbbbbbb", signal_type="churn_risk")
        )
        assert out_a == out_b


# ─────────────────────────────────────────────────────────────────────────────
# 2. Signal-type 4-way parametrize — every Literal value produces output.
# ─────────────────────────────────────────────────────────────────────────────


class TestSignalTypeParametrize:
    """Sweep every value of the `SignalType` Literal."""

    @pytest.mark.parametrize(
        "signal_type,expected_kind,expected_path_substr",
        _CANONICAL_PINS,
        ids=[row[0] for row in _CANONICAL_PINS],
    )
    def test_canonical_pin_for_each_signal(
        self,
        monkeypatch: pytest.MonkeyPatch,
        signal_type: str,
        expected_kind: str,
        expected_path_substr: str,
    ) -> None:
        """Every signal_type maps to its canonical intervention_kind +
        a runbook URI that names the right playbook."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = intervention_propose(_input(signal_type=signal_type))
        assert out.intervention_kind == expected_kind
        assert out.escalation_path is not None
        assert expected_path_substr in out.escalation_path
        assert out.escalation_path.startswith("cs-runbook://")

    @pytest.mark.parametrize(
        "signal_type", [row[0] for row in _CANONICAL_PINS]
    )
    def test_scripted_message_has_merge_fields(
        self, monkeypatch: pytest.MonkeyPatch, signal_type: str
    ) -> None:
        """Every canonical scripted_message uses at least one merge field
        — the downstream runbook expands them per workspace_profile."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = intervention_propose(_input(signal_type=signal_type))
        # Merge field convention: `{{name}}`. At least one must be present.
        assert "{{" in out.scripted_message and "}}" in out.scripted_message

    @pytest.mark.parametrize(
        "signal_type", [row[0] for row in _CANONICAL_PINS]
    )
    def test_every_signal_has_escalation_path(
        self, monkeypatch: pytest.MonkeyPatch, signal_type: str
    ) -> None:
        """Stub mode always populates escalation_path — live mode may
        return None when no playbook matches, but the stub's canonical
        playbook is complete."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = intervention_propose(_input(signal_type=signal_type))
        assert out.escalation_path is not None
        assert "://" in out.escalation_path


# ─────────────────────────────────────────────────────────────────────────────
# 3. Severity gates intervention_kind + dry_run_required flag.
# ─────────────────────────────────────────────────────────────────────────────


class TestSeverityGate:
    """`severity=high` forces auto-execute; low/medium queue for CSM review.

    intervention_kind is signal-driven (not severity-driven), but the gate
    flips dry_run_required deterministically. The brief calls this out as
    the "severity gates intervention_kind" invariant — encoded here as
    "severity decides whether the kind ships now or after CSM approval".
    """

    @pytest.mark.parametrize(
        "signal_type", [row[0] for row in _CANONICAL_PINS]
    )
    def test_high_severity_auto_executes(
        self, monkeypatch: pytest.MonkeyPatch, signal_type: str
    ) -> None:
        """severity=high ⇒ dry_run_required=False (auto-execute)."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = intervention_propose(
            _input(signal_type=signal_type, severity="high")
        )
        assert out.dry_run_required is False

    @pytest.mark.parametrize(
        "signal_type", [row[0] for row in _CANONICAL_PINS]
    )
    def test_medium_severity_requires_dry_run(
        self, monkeypatch: pytest.MonkeyPatch, signal_type: str
    ) -> None:
        """severity=medium ⇒ dry_run_required=True (CSM review)."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = intervention_propose(
            _input(signal_type=signal_type, severity="medium")
        )
        assert out.dry_run_required is True

    @pytest.mark.parametrize(
        "signal_type", [row[0] for row in _CANONICAL_PINS]
    )
    def test_low_severity_requires_dry_run(
        self, monkeypatch: pytest.MonkeyPatch, signal_type: str
    ) -> None:
        """severity=low ⇒ dry_run_required=True (CSM review)."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = intervention_propose(
            _input(signal_type=signal_type, severity="low")
        )
        assert out.dry_run_required is True

    def test_severity_does_not_change_intervention_kind(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The intervention_kind is signal-driven. Varying severity for the
        same signal must NOT change the kind — only the dry_run flag."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        kinds_seen: set[str] = set()
        for sev in ("low", "medium", "high"):
            out = intervention_propose(
                _input(signal_type="churn_risk", severity=sev)
            )
            kinds_seen.add(out.intervention_kind)
        assert kinds_seen == {"email"}, (
            f"intervention_kind must be stable across severity; got {kinds_seen!r}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Pydantic validation — input + output contract.
# ─────────────────────────────────────────────────────────────────────────────


class TestPydanticValidation:
    """`extra=forbid`, workspace_id pattern, Literals, escalation_path URI."""

    def test_extra_field_rejected(self) -> None:
        """`extra=forbid` means unknown input fields fail."""
        with pytest.raises(ValidationError):
            InterventionProposeInput.model_validate(
                {
                    "workspace_id": _WORKSPACE_ID,
                    "signal_type": "churn_risk",
                    "severity": "high",
                    "evil_extra_field": "haha",
                }
            )

    def test_workspace_id_pattern_enforced(self) -> None:
        """`workspace_id` must match `ws_…` pattern."""
        with pytest.raises(ValidationError):
            InterventionProposeInput(
                workspace_id="not-a-workspace-id",
                signal_type="churn_risk",
                severity="high",
            )

    def test_invalid_signal_type_rejected(self) -> None:
        """signal_type must be one of the 4 Literal values."""
        with pytest.raises(ValidationError):
            InterventionProposeInput.model_validate(
                {
                    "workspace_id": _WORKSPACE_ID,
                    "signal_type": "completely_made_up",
                    "severity": "high",
                }
            )

    def test_invalid_severity_rejected(self) -> None:
        """severity must be one of {low, medium, high}."""
        with pytest.raises(ValidationError):
            InterventionProposeInput.model_validate(
                {
                    "workspace_id": _WORKSPACE_ID,
                    "signal_type": "churn_risk",
                    "severity": "catastrophic",  # not in enum
                }
            )

    def test_invalid_intervention_kind_rejected(self) -> None:
        """Synthetic counter-example: building an output with an unknown
        intervention_kind must fail validation."""
        with pytest.raises(ValidationError):
            InterventionProposeOutput(
                intervention_kind="not_a_real_kind",  # type: ignore[arg-type]
                scripted_message="Hi {{first_name}}, please reach out.",
                dry_run_required=True,
                escalation_path="cs-runbook://test/foo",
                fetched_via="stub",
            )

    def test_escalation_path_without_scheme_rejected(self) -> None:
        """Output escalation_path must be a URI (have a `://`)."""
        with pytest.raises(ValidationError, match="must be a URI"):
            InterventionProposeOutput(
                intervention_kind="email",
                scripted_message="Hi {{first_name}}, please reach out.",
                dry_run_required=True,
                escalation_path="not-a-uri",
                fetched_via="stub",
            )

    def test_escalation_path_none_is_acceptable(self) -> None:
        """`escalation_path=None` is valid (live mode may return no match)."""
        out = InterventionProposeOutput(
            intervention_kind="email",
            scripted_message="Hi {{first_name}}, please reach out.",
            dry_run_required=True,
            escalation_path=None,
            fetched_via="live",
        )
        assert out.escalation_path is None

    def test_short_scripted_message_rejected(self) -> None:
        """`scripted_message` has min_length=10 to catch placeholder bugs."""
        with pytest.raises(ValidationError):
            InterventionProposeOutput(
                intervention_kind="email",
                scripted_message="hi",  # too short
                dry_run_required=True,
                escalation_path=None,
                fetched_via="stub",
            )


# ─────────────────────────────────────────────────────────────────────────────
# 5. Live NotImplementedError + cost attribute surfacing.
# ─────────────────────────────────────────────────────────────────────────────


class TestLiveAndCost:
    """`CAPABILITY_LAYER_MODE=live` must raise — W7 wires the real client."""

    def test_live_mode_raises_not_implemented(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(NotImplementedError, match="W7 deploy phase"):
            intervention_propose(_input())

    def test_usd_cost_attribute_surfaced(self) -> None:
        """`cost_watch` reads `tool.usd_cost` via getattr — must exist."""
        assert hasattr(intervention_propose, "usd_cost")
        assert intervention_propose.usd_cost == USD_COST  # type: ignore[attr-defined]
        assert USD_COST > 0.0
