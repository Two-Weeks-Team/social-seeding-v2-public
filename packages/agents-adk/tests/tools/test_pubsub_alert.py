"""tests/tools/test_pubsub_alert.py — W2-C1 cost_watch pubsub.alert seam.

Coverage matrix:
    1. Default = stub; deterministic message_id; correct topic.
    2. Pydantic input validation.
    3. Stub determinism + multi-tenant + multi-kind isolation.
    4. alert_kind parametrize — every banner threshold (50/75/90/95).
    5. Threshold consistency guardrail — alert_kind ↔ pct mismatch rejected.
    6. Live mode raises NotImplementedError with W7 message.
    7. `usd_cost` attribute exposed for cost_watch aggregator (D41).
    8. Topic is the canonical `watchdog.cost.threshold_crossed`.

Citations: D41 (capability layer stub/live), D23 (Tier-3 W2), D32 (Pub/Sub IR),
    cost_watch.spec.md §4.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.pubsub_alert import (
    USD_COST,
    AlertKind,
    PubsubAlertInput,
    PubsubAlertOutput,
    pubsub_alert,
)


# ─────────────────────────────────────────────────────────────────────────────
# Test 1 — default mode is stub, topic + message_id shape
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub_returns_topic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = pubsub_alert(
        PubsubAlertInput(
            workspace_id="ws_demo",
            current_pct_consumed=0.52,
            alert_kind="budget_50",
            message_body="50% of monthly budget used",
        )
    )
    assert isinstance(out, PubsubAlertOutput)
    assert out.topic == "watchdog.cost.threshold_crossed"
    assert out.message_id.startswith("stub_msg_budget_50_")
    assert 10 <= out.ack_deadline_s <= 600


# ─────────────────────────────────────────────────────────────────────────────
# Test 2 — input validation
# ─────────────────────────────────────────────────────────────────────────────


class TestInputValidation:
    def test_rejects_unknown_alert_kind(self) -> None:
        with pytest.raises(ValidationError):
            PubsubAlertInput.model_validate(
                {
                    "workspace_id": "ws_demo",
                    "current_pct_consumed": 0.50,
                    "alert_kind": "budget_100",  # not in the 50/75/90/95 ladder
                    "message_body": "x",
                }
            )

    def test_rejects_empty_workspace_id(self) -> None:
        with pytest.raises(ValidationError):
            PubsubAlertInput(
                workspace_id="",
                current_pct_consumed=0.50,
                alert_kind="budget_50",
                message_body="x",
            )

    def test_rejects_negative_pct(self) -> None:
        with pytest.raises(ValidationError):
            PubsubAlertInput(
                workspace_id="ws_demo",
                current_pct_consumed=-0.10,
                alert_kind="budget_50",
                message_body="x",
            )

    def test_rejects_unknown_extra_field(self) -> None:
        with pytest.raises(ValidationError):
            PubsubAlertInput.model_validate(
                {
                    "workspace_id": "ws_demo",
                    "current_pct_consumed": 0.50,
                    "alert_kind": "budget_50",
                    "message_body": "x",
                    "topic_override": "custom",  # not in schema
                }
            )

    def test_rejects_oversized_message_body(self) -> None:
        with pytest.raises(ValidationError):
            PubsubAlertInput(
                workspace_id="ws_demo",
                current_pct_consumed=0.50,
                alert_kind="budget_50",
                message_body="x" * 501,
            )


# ─────────────────────────────────────────────────────────────────────────────
# Test 3 — determinism + isolation
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = PubsubAlertInput(
        workspace_id="ws_demo",
        current_pct_consumed=0.76,
        alert_kind="budget_75",
        message_body="75% of monthly budget used",
    )
    a = pubsub_alert(payload)
    b = pubsub_alert(payload)
    assert a.message_id == b.message_id


def test_different_workspaces_different_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    a = pubsub_alert(
        PubsubAlertInput(
            workspace_id="ws_demo",
            current_pct_consumed=0.52,
            alert_kind="budget_50",
            message_body="x",
        )
    )
    b = pubsub_alert(
        PubsubAlertInput(
            workspace_id="ws_other",
            current_pct_consumed=0.52,
            alert_kind="budget_50",
            message_body="x",
        )
    )
    assert a.message_id != b.message_id


def test_different_alert_kinds_different_prefixes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    a = pubsub_alert(
        PubsubAlertInput(
            workspace_id="ws_demo",
            current_pct_consumed=0.52,
            alert_kind="budget_50",
            message_body="x",
        )
    )
    b = pubsub_alert(
        PubsubAlertInput(
            workspace_id="ws_demo",
            current_pct_consumed=0.76,
            alert_kind="budget_75",
            message_body="x",
        )
    )
    assert a.message_id.startswith("stub_msg_budget_50_")
    assert b.message_id.startswith("stub_msg_budget_75_")


# ─────────────────────────────────────────────────────────────────────────────
# Test 4 — alert_kind parametrize (full ladder)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "alert_kind,pct",
    [
        ("budget_50", 0.52),
        ("budget_75", 0.76),
        ("budget_90", 0.91),
        ("budget_95", 0.96),
    ],
)
def test_alert_kind_threshold_matrix(
    alert_kind: AlertKind,
    pct: float,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = pubsub_alert(
        PubsubAlertInput(
            workspace_id="ws_demo",
            current_pct_consumed=pct,
            alert_kind=alert_kind,
            message_body=f"{alert_kind} crossing",
        )
    )
    assert out.message_id.startswith(f"stub_msg_{alert_kind}_")
    assert out.topic == "watchdog.cost.threshold_crossed"


# ─────────────────────────────────────────────────────────────────────────────
# Test 5 — alert_kind ↔ pct consistency guardrail
# ─────────────────────────────────────────────────────────────────────────────


class TestAlertKindConsistency:
    """A budget_75 alert with pct=0.40 is a workflow bug — the rule layer
    picked the wrong alert_kind. The Pydantic validator catches this BEFORE
    the message is published."""

    def test_far_below_threshold_rejected(self) -> None:
        """budget_75 with pct=0.40 → ValidationError."""
        with pytest.raises(ValidationError, match=r"alert_kind"):
            PubsubAlertInput(
                workspace_id="ws_demo",
                current_pct_consumed=0.40,
                alert_kind="budget_75",
                message_body="x",
            )

    def test_at_threshold_accepted(self) -> None:
        """budget_50 with pct=0.50 → OK (exactly at threshold)."""
        payload = PubsubAlertInput(
            workspace_id="ws_demo",
            current_pct_consumed=0.50,
            alert_kind="budget_50",
            message_body="x",
        )
        assert payload.alert_kind == "budget_50"

    def test_within_tolerance_accepted(self) -> None:
        """budget_75 with pct=0.72 (within ±5%) → OK."""
        payload = PubsubAlertInput(
            workspace_id="ws_demo",
            current_pct_consumed=0.72,
            alert_kind="budget_75",
            message_body="x",
        )
        assert payload.current_pct_consumed == 0.72

    def test_above_threshold_accepted(self) -> None:
        """budget_50 with pct=0.92 → OK; the rule layer may emit multiple
        alerts in sequence (50, 75, 90) and the first one is legit."""
        payload = PubsubAlertInput(
            workspace_id="ws_demo",
            current_pct_consumed=0.92,
            alert_kind="budget_50",
            message_body="x",
        )
        assert payload.current_pct_consumed == 0.92


# ─────────────────────────────────────────────────────────────────────────────
# Test 6 — live mode raises
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        pubsub_alert(
            PubsubAlertInput(
                workspace_id="ws_demo",
                current_pct_consumed=0.52,
                alert_kind="budget_50",
                message_body="x",
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# Test 7 — cost attribute (D41)
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(pubsub_alert, "usd_cost")
    assert pubsub_alert.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert 0.0 < USD_COST < 0.01


# ─────────────────────────────────────────────────────────────────────────────
# Test 8 — topic is canonical
# ─────────────────────────────────────────────────────────────────────────────


def test_topic_is_canonical(monkeypatch: pytest.MonkeyPatch) -> None:
    """Per cost_watch.spec.md §4 AsyncAPI."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = pubsub_alert(
        PubsubAlertInput(
            workspace_id="ws_demo",
            current_pct_consumed=0.52,
            alert_kind="budget_50",
            message_body="x",
        )
    )
    assert out.topic == "watchdog.cost.threshold_crossed"
