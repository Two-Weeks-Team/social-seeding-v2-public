"""tests/tools/test_chronicle_query.py — W2-C1 security_watch chronicle.query.

Coverage matrix:
    1. Default = stub; known template → 5 events + 3 unique actors.
    2. Pydantic input validation (range, tz-aware).
    3. Stub determinism.
    4. Template_name allow-list — unknown template raises ValueError BEFORE
       backend call (both stub AND live mode, same guardrail).
    5. Raw UDM strings rejected (injection guardrail).
    6. Live mode + known template raises NotImplementedError with W7 msg.
    7. `usd_cost` attribute exposed for cost_watch aggregator (D41).
    8. Known templates list is the closed allow-list set.

Citations: D41 (capability layer stub/live), D23 (Tier-3 W3), D32 (Chronicle
    SIEM), security_watch.spec.md §6.
"""
from __future__ import annotations

import datetime as dt

import pytest
from pydantic import ValidationError

from ss_agents.tools.chronicle_query import (
    USD_COST,
    ChronicleQueryInput,
    ChronicleQueryOutput,
    chronicle_query,
    known_templates,
)


_START = dt.datetime(2026, 5, 19, 11, 0, 0, tzinfo=dt.UTC)
_END = dt.datetime(2026, 5, 19, 12, 0, 0, tzinfo=dt.UTC)


# ─────────────────────────────────────────────────────────────────────────────
# Test 1 — default mode is stub, known template
# ─────────────────────────────────────────────────────────────────────────────


def test_default_mode_is_stub_known_template(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = chronicle_query(
        ChronicleQueryInput(
            query_template_name="recent_pi_alerts",
            params={"tenant_id": "t_demo000000000000"},
            time_range=(_START, _END),
        )
    )
    assert isinstance(out, ChronicleQueryOutput)
    assert out.total == 5
    assert out.total_unique_actors == 3
    assert len(out.events) == 5
    # Every event references the template name.
    for event in out.events:
        assert event["template"] == "recent_pi_alerts"


# ─────────────────────────────────────────────────────────────────────────────
# Test 2 — input validation
# ─────────────────────────────────────────────────────────────────────────────


class TestInputValidation:
    def test_rejects_inverted_range(self) -> None:
        with pytest.raises(ValidationError):
            ChronicleQueryInput(
                query_template_name="recent_pi_alerts",
                time_range=(_END, _START),
            )

    def test_rejects_naive_datetime(self) -> None:
        naive_start = dt.datetime(2026, 5, 19, 11, 0, 0)
        with pytest.raises(ValidationError):
            ChronicleQueryInput(
                query_template_name="recent_pi_alerts",
                time_range=(naive_start, _END),
            )

    def test_rejects_empty_template_name(self) -> None:
        with pytest.raises(ValidationError):
            ChronicleQueryInput(
                query_template_name="",
                time_range=(_START, _END),
            )

    def test_rejects_unknown_extra_field(self) -> None:
        with pytest.raises(ValidationError):
            ChronicleQueryInput.model_validate(
                {
                    "query_template_name": "recent_pi_alerts",
                    "time_range": [_START, _END],
                    "raw_udm": "events | metadata.event_type = ...",
                }
            )


# ─────────────────────────────────────────────────────────────────────────────
# Test 3 — determinism
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = ChronicleQueryInput(
        query_template_name="recent_pi_alerts",
        params={"tenant_id": "t_demo000000000000"},
        time_range=(_START, _END),
    )
    a = chronicle_query(payload)
    b = chronicle_query(payload)
    assert a.model_dump_json() == b.model_dump_json()


def test_different_params_different_event_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    a = chronicle_query(
        ChronicleQueryInput(
            query_template_name="recent_pi_alerts",
            params={"tenant_id": "t_a"},
            time_range=(_START, _END),
        )
    )
    b = chronicle_query(
        ChronicleQueryInput(
            query_template_name="recent_pi_alerts",
            params={"tenant_id": "t_b"},
            time_range=(_START, _END),
        )
    )
    a_ids = {e["event_id"] for e in a.events}
    b_ids = {e["event_id"] for e in b.events}
    assert a_ids != b_ids


# ─────────────────────────────────────────────────────────────────────────────
# Test 4 — allow-list guardrail (BOTH stub and live)
# ─────────────────────────────────────────────────────────────────────────────


class TestAllowListGuardrail:
    """The template_name allow-list is the canonical injection guardrail —
    enforced in BOTH stub and live mode."""

    def test_unknown_template_rejected_in_stub_mode(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        with pytest.raises(
            ValueError, match=r"unknown query_template_name"
        ):
            chronicle_query(
                ChronicleQueryInput(
                    query_template_name="arbitrary_template",
                    time_range=(_START, _END),
                )
            )

    def test_unknown_template_rejected_in_live_mode(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(
            ValueError, match=r"unknown query_template_name"
        ):
            chronicle_query(
                ChronicleQueryInput(
                    query_template_name="arbitrary_template",
                    time_range=(_START, _END),
                )
            )

    def test_raw_udm_string_rejected(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A raw UDM query passed as `query_template_name` must be rejected."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        with pytest.raises(
            ValueError, match=r"injection guardrail"
        ):
            chronicle_query(
                ChronicleQueryInput(
                    query_template_name="events | metadata.event_type = USER_LOGIN",
                    time_range=(_START, _END),
                )
            )

    @pytest.mark.parametrize(
        "template_name",
        sorted(known_templates()),
    )
    def test_all_known_templates_accepted_in_stub(
        self,
        template_name: str,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Every name in the allow-list resolves to a successful stub call."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = chronicle_query(
            ChronicleQueryInput(
                query_template_name=template_name,
                time_range=(_START, _END),
            )
        )
        assert out.total == 5


# ─────────────────────────────────────────────────────────────────────────────
# Test 5 — known templates includes the spec-required entries
# ─────────────────────────────────────────────────────────────────────────────


def test_known_templates_includes_pi_alerts() -> None:
    assert "recent_pi_alerts" in known_templates()


def test_known_templates_is_frozenset() -> None:
    assert isinstance(known_templates(), frozenset)


# ─────────────────────────────────────────────────────────────────────────────
# Test 6 — live mode + known template raises NotImplementedError
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_known_template_raises_not_implemented(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        chronicle_query(
            ChronicleQueryInput(
                query_template_name="recent_pi_alerts",
                time_range=(_START, _END),
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# Test 7 — cost attribute (D41)
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(chronicle_query, "usd_cost")
    assert chronicle_query.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert 0.0 < USD_COST < 0.01


# ─────────────────────────────────────────────────────────────────────────────
# Test 8 — event timestamps fall within the input window
# ─────────────────────────────────────────────────────────────────────────────


def test_event_timestamps_within_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = chronicle_query(
        ChronicleQueryInput(
            query_template_name="recent_pi_alerts",
            time_range=(_START, _END),
        )
    )
    for event in out.events:
        ts = dt.datetime.fromisoformat(event["timestamp"])
        assert _START <= ts <= _END
