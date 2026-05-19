"""tests/tools/test_runbook_execute.py — W2-C1 anomaly_watch runbook.execute seam.

Coverage matrix:
    1. Default mode = stub; stub forces dry_run_applied=True regardless of input.
    2. Pydantic input validation (kind enum, required fields).
    3. Stub determinism — execution_id is stable across calls.
    4. runbook_kind parametrize — every mutating kind round-trips.
    5. Demo-safety guardrail — live mode + mutating kind + dry_run=True raises ValueError.
    6. Live mode + mutating kind + dry_run=False raises NotImplementedError.
    7. Live mode message matches W7 deploy-phase.
    8. `usd_cost` attribute exposed for cost_watch aggregator (D41).
    9. `MUTATING_KINDS` set is the exact 4-kind closed set.

Citations: D41 (capability layer stub/live), D23 (Tier-3 W1), D32 (Auto-runbook),
    anomaly_watch.spec.md §6.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.runbook_execute import (
    MUTATING_KINDS,
    USD_COST,
    RunbookExecuteInput,
    RunbookExecuteOutput,
    RunbookKind,
    runbook_execute,
)


_OPERATOR = "app.2weeks@gmail.com"


# ─────────────────────────────────────────────────────────────────────────────
# Test 1 — default mode is stub, dry_run forced True
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub_forces_dry_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = runbook_execute(
        RunbookExecuteInput(
            runbook_name="rb_scale_up_v1",
            params={"factor": 2},
            dry_run=False,  # caller asked for real — stub IGNORES.
            executing_user=_OPERATOR,
            runbook_kind="scale_up",
        )
    )
    assert isinstance(out, RunbookExecuteOutput)
    # Stub MUST force dry_run_applied=True even when input says False.
    assert out.dry_run_applied is True
    assert out.status == "queued"
    assert out.runbook_kind == "scale_up"
    assert out.execution_id.startswith("stub_exec_scale_up_")


def test_stub_forces_dry_run_even_with_dry_run_true_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the caller asks for dry_run=True, stub still applies it."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = runbook_execute(
        RunbookExecuteInput(
            runbook_name="rb_rollback_v1",
            params={},
            dry_run=True,
            executing_user=_OPERATOR,
            runbook_kind="rollback",
        )
    )
    assert out.dry_run_applied is True


# ─────────────────────────────────────────────────────────────────────────────
# Test 2 — input validation
# ─────────────────────────────────────────────────────────────────────────────


class TestInputValidation:
    def test_rejects_empty_runbook_name(self) -> None:
        with pytest.raises(ValidationError):
            RunbookExecuteInput(
                runbook_name="",
                params={},
                dry_run=True,
                executing_user=_OPERATOR,
                runbook_kind="scale_up",
            )

    def test_rejects_unknown_runbook_kind(self) -> None:
        with pytest.raises(ValidationError):
            RunbookExecuteInput.model_validate(
                {
                    "runbook_name": "rb_x_v1",
                    "params": {},
                    "dry_run": True,
                    "executing_user": _OPERATOR,
                    "runbook_kind": "purge_database",  # not in literal
                }
            )

    def test_rejects_missing_executing_user(self) -> None:
        with pytest.raises(ValidationError):
            RunbookExecuteInput.model_validate(
                {
                    "runbook_name": "rb_x_v1",
                    "params": {},
                    "dry_run": True,
                    "runbook_kind": "scale_up",
                }
            )

    def test_rejects_unknown_extra_field(self) -> None:
        with pytest.raises(ValidationError):
            RunbookExecuteInput.model_validate(
                {
                    "runbook_name": "rb_x_v1",
                    "params": {},
                    "dry_run": True,
                    "executing_user": _OPERATOR,
                    "runbook_kind": "scale_up",
                    "force": True,  # not in schema
                }
            )


# ─────────────────────────────────────────────────────────────────────────────
# Test 3 — determinism
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism_same_input_same_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = RunbookExecuteInput(
        runbook_name="rb_scale_up_v1",
        params={"factor": 2, "region": "us-central1"},
        dry_run=False,
        executing_user=_OPERATOR,
        runbook_kind="scale_up",
    )
    a = runbook_execute(payload)
    b = runbook_execute(payload)
    assert a.execution_id == b.execution_id


def test_stub_determinism_different_params_different_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    a = runbook_execute(
        RunbookExecuteInput(
            runbook_name="rb_scale_up_v1",
            params={"factor": 2},
            dry_run=False,
            executing_user=_OPERATOR,
            runbook_kind="scale_up",
        )
    )
    b = runbook_execute(
        RunbookExecuteInput(
            runbook_name="rb_scale_up_v1",
            params={"factor": 4},
            dry_run=False,
            executing_user=_OPERATOR,
            runbook_kind="scale_up",
        )
    )
    assert a.execution_id != b.execution_id


# ─────────────────────────────────────────────────────────────────────────────
# Test 4 — runbook_kind parametrize
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "kind", ["scale_up", "rollback", "quarantine", "circuit_breaker"]
)
def test_stub_runbook_kind_roundtrip(
    kind: RunbookKind, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = runbook_execute(
        RunbookExecuteInput(
            runbook_name=f"rb_{kind}_v1",
            params={},
            dry_run=True,
            executing_user=_OPERATOR,
            runbook_kind=kind,
        )
    )
    assert out.runbook_kind == kind
    assert out.execution_id.startswith(f"stub_exec_{kind}_")
    # All four kinds are mutating; dry_run_applied is always True in stub.
    assert out.dry_run_applied is True


# ─────────────────────────────────────────────────────────────────────────────
# Test 5 — demo-safety guardrail (live + mutating + dry_run=True → ValueError)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "kind", ["scale_up", "rollback", "quarantine", "circuit_breaker"]
)
def test_live_mode_mutating_kind_requires_explicit_opt_in(
    kind: RunbookKind, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Live + mutating + dry_run=True → ValueError BEFORE any client built."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(ValueError, match=r"production-mutating"):
        runbook_execute(
            RunbookExecuteInput(
                runbook_name=f"rb_{kind}_v1",
                params={},
                dry_run=True,  # missing opt-in
                executing_user=_OPERATOR,
                runbook_kind=kind,
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# Test 6 — live + opt-in cleared → NotImplementedError (W7 deploy phase)
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_opt_in_cleared_raises_not_implemented(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        runbook_execute(
            RunbookExecuteInput(
                runbook_name="rb_scale_up_v1",
                params={},
                dry_run=False,  # explicit opt-in
                executing_user=_OPERATOR,
                runbook_kind="scale_up",
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# Test 7 — MUTATING_KINDS is the exact set
# ─────────────────────────────────────────────────────────────────────────────


def test_mutating_kinds_exact_set() -> None:
    assert MUTATING_KINDS == frozenset(
        {"scale_up", "rollback", "quarantine", "circuit_breaker"}
    )


# ─────────────────────────────────────────────────────────────────────────────
# Test 8 — cost attribute (D41)
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(runbook_execute, "usd_cost")
    assert runbook_execute.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert 0.0 < USD_COST < 0.01
