"""tests/tools/test_analytics_funnel.py

Covers four contracts on the `analytics_funnel` capability tool:

1. **Stub determinism** — canonical funnel the brief specifies
   (intake=100, vetting=82, outreach=64, reply=28; drops 18%/22%/56%;
   biggest_drop="outreach->reply"; healthy_baseline=False).
2. **Funnel invariants** — `biggest_drop_stage` matches max of
   `drop_off_rates`; counts ≥ 0; rates ∈ [0, 1]; `healthy_baseline`
   reflects the HEALTHY_MAX_DROP_PCT gate.
3. **Pydantic validation** — `extra=forbid`, time-range ordering,
   workspace_id pattern, funnel_stages uniqueness, stage whitespace,
   max window width.
4. **Live NotImplementedError** + cost attribute surfacing.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D28 — Per-view pricing; funnel analytics underwrite the per-view
          metering and Drucker §9 management-by-exception triggers.
    D15 — BigQuery sits on the analytics side of the OLTP hybrid.
    customer_success.spec.md §6 — `analytics.funnel` tool contract.
"""
from __future__ import annotations

import datetime as dt

import pytest
from pydantic import ValidationError

from ss_agents.tools.analytics_funnel import (
    CANONICAL_BIGGEST_DROP_STAGE,
    CANONICAL_STAGE_COUNTS,
    HEALTHY_MAX_DROP_PCT,
    USD_COST,
    AnalyticsFunnelInput,
    AnalyticsFunnelOutput,
    analytics_funnel,
)


# ─────────────────────────────────────────────────────────────────────────────
# Canonical fixtures.
# ─────────────────────────────────────────────────────────────────────────────


_START = dt.datetime(2026, 4, 19, 0, 0, tzinfo=dt.UTC)
_END = dt.datetime(2026, 5, 19, 0, 0, tzinfo=dt.UTC)  # 30-day window
_WORKSPACE_ID = "ws_demo_cs_funnel"
_DEFAULT_STAGES: list[str] = ["intake", "vetting", "outreach", "reply"]


def _input(
    *,
    workspace_id: str = _WORKSPACE_ID,
    start: dt.datetime = _START,
    end: dt.datetime = _END,
    funnel_stages: list[str] | None = None,
) -> AnalyticsFunnelInput:
    return AnalyticsFunnelInput(
        workspace_id=workspace_id,
        time_range=(start, end),
        funnel_stages=funnel_stages if funnel_stages is not None else list(_DEFAULT_STAGES),
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism — pins the canonical brief-mandated funnel.
# ─────────────────────────────────────────────────────────────────────────────


class TestStubDeterminism:
    """Stub output must match the brief's documented canonical values."""

    def test_canonical_stage_counts(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """intake=100, vetting=82, outreach=64, reply=28 per brief."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = analytics_funnel(_input())
        assert isinstance(out, AnalyticsFunnelOutput)
        assert out.stage_counts == {
            "intake": 100,
            "vetting": 82,
            "outreach": 64,
            "reply": 28,
        }
        assert out.stage_counts == CANONICAL_STAGE_COUNTS
        assert out.fetched_via == "stub"

    def test_canonical_drop_off_rates(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """18% / 22% / 56% drops per brief.

        Computed exactly from counts: (100-82)/100=0.18, (82-64)/82≈0.2195,
        (64-28)/64=0.5625. The brief's "18%/22%/56%" rounds to integer
        percentages; the stored rates are unrounded fractions (rounded to
        4 decimals for float stability).
        """
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = analytics_funnel(_input())
        assert set(out.drop_off_rates.keys()) == {
            "intake->vetting",
            "vetting->outreach",
            "outreach->reply",
        }
        # Match brief: round to int percentages → 18 / 22 / 56.
        as_pct = {k: round(v * 100) for k, v in out.drop_off_rates.items()}
        assert as_pct["intake->vetting"] == 18
        assert as_pct["vetting->outreach"] == 22
        assert as_pct["outreach->reply"] == 56

    def test_biggest_drop_is_outreach_to_reply(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The 56% drop dominates. biggest_drop_stage names the transition,
        not just the target stage."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = analytics_funnel(_input())
        assert out.biggest_drop_stage == "outreach->reply"
        assert out.biggest_drop_stage == CANONICAL_BIGGEST_DROP_STAGE

    def test_healthy_baseline_is_false(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """56% > 50% threshold → unhealthy. The brief's canonical funnel
        is intentionally pegged just below the healthy line so the
        customer_success agent fires its friction signals on the default
        fixture."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out = analytics_funnel(_input())
        assert out.healthy_baseline is False
        # Document the threshold so the assertion above is meaningful.
        biggest_rate_pct = out.drop_off_rates[out.biggest_drop_stage] * 100
        assert biggest_rate_pct > HEALTHY_MAX_DROP_PCT

    def test_same_input_yields_byte_identical_output(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Re-invoking with the same input twice produces equal models."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out_a = analytics_funnel(_input())
        out_b = analytics_funnel(_input())
        assert out_a == out_b

    def test_input_variance_does_not_alter_stub_surface(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Different workspace_ids + time_ranges still produce the canonical
        funnel — the stub pins the surface so the customer_success agent
        sees deterministic friction signals regardless of caller."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        out_a = analytics_funnel(_input(workspace_id="ws_alpha_aaaaaaaa"))
        out_b = analytics_funnel(_input(workspace_id="ws_beta_bbbbbbbbb"))
        assert out_a.stage_counts == out_b.stage_counts
        assert out_a.drop_off_rates == out_b.drop_off_rates
        assert out_a.biggest_drop_stage == out_b.biggest_drop_stage


# ─────────────────────────────────────────────────────────────────────────────
# 2. Funnel invariants — output model's validators must hold.
# ─────────────────────────────────────────────────────────────────────────────


class TestFunnelInvariants:
    """The output validators enforce shape integrity at the boundary."""

    def test_biggest_drop_must_match_max_rate(self) -> None:
        """Synthetic counter-example: setting `biggest_drop_stage` to a
        transition that isn't the actual maximum must fail validation."""
        with pytest.raises(ValidationError, match="not the maximum"):
            AnalyticsFunnelOutput(
                stage_counts={"intake": 100, "vetting": 82, "outreach": 64},
                drop_off_rates={
                    "intake->vetting": 0.18,
                    "vetting->outreach": 0.22,
                },
                biggest_drop_stage="intake->vetting",  # 0.18 is NOT max
                healthy_baseline=True,
                fetched_via="stub",
            )

    def test_biggest_drop_must_be_a_known_transition(self) -> None:
        """If `biggest_drop_stage` references a transition not in
        `drop_off_rates`, validation must fail."""
        with pytest.raises(ValidationError, match="not in"):
            AnalyticsFunnelOutput(
                stage_counts={"intake": 100, "vetting": 82},
                drop_off_rates={"intake->vetting": 0.18},
                biggest_drop_stage="phantom->stage",
                healthy_baseline=True,
                fetched_via="stub",
            )

    def test_negative_stage_count_rejected(self) -> None:
        """Stage counts can't be negative."""
        with pytest.raises(ValidationError, match="cannot be negative"):
            AnalyticsFunnelOutput(
                stage_counts={"intake": -1},
                drop_off_rates={},
                biggest_drop_stage="intake->vetting",
                healthy_baseline=True,
                fetched_via="stub",
            )

    def test_drop_rate_above_one_rejected(self) -> None:
        """Drop-off rates are fractions [0, 1]. A rate > 1 means more
        drops than entries — impossible by construction."""
        with pytest.raises(ValidationError, match=r"must be in \[0\.0, 1\.0\]"):
            AnalyticsFunnelOutput(
                stage_counts={"intake": 100, "vetting": 0},
                drop_off_rates={"intake->vetting": 1.5},
                biggest_drop_stage="intake->vetting",
                healthy_baseline=False,
                fetched_via="stub",
            )

    def test_negative_drop_rate_rejected(self) -> None:
        """Negative drop rates would mean the funnel grew between stages
        — defensive validation catches misconfigured live impls."""
        with pytest.raises(ValidationError, match=r"must be in \[0\.0, 1\.0\]"):
            AnalyticsFunnelOutput(
                stage_counts={"intake": 100, "vetting": 110},
                drop_off_rates={"intake->vetting": -0.1},
                biggest_drop_stage="intake->vetting",
                healthy_baseline=True,
                fetched_via="stub",
            )

    def test_healthy_baseline_with_small_drop(self) -> None:
        """A funnel with all drops <= HEALTHY_MAX_DROP_PCT% (50%) can
        legitimately have `healthy_baseline=True`. Construct manually
        to confirm the output model accepts it."""
        out = AnalyticsFunnelOutput(
            stage_counts={"intake": 100, "vetting": 95, "outreach": 90},
            drop_off_rates={
                "intake->vetting": 0.05,
                "vetting->outreach": 0.0526,
            },
            biggest_drop_stage="vetting->outreach",
            healthy_baseline=True,
            fetched_via="live",
        )
        assert out.healthy_baseline is True


# ─────────────────────────────────────────────────────────────────────────────
# 3. Pydantic validation — input contract.
# ─────────────────────────────────────────────────────────────────────────────


class TestPydanticValidation:
    """`extra=forbid`, workspace_id pattern, time-range, funnel_stages."""

    def test_extra_field_rejected(self) -> None:
        """`extra=forbid` means unknown input fields fail."""
        with pytest.raises(ValidationError):
            AnalyticsFunnelInput.model_validate(
                {
                    "workspace_id": _WORKSPACE_ID,
                    "time_range": (_START, _END),
                    "funnel_stages": list(_DEFAULT_STAGES),
                    "evil_extra_field": "haha",
                }
            )

    def test_workspace_id_pattern_enforced(self) -> None:
        """`workspace_id` must match `ws_…` pattern."""
        with pytest.raises(ValidationError):
            AnalyticsFunnelInput(
                workspace_id="not-a-workspace-id",
                time_range=(_START, _END),
                funnel_stages=list(_DEFAULT_STAGES),
            )

    def test_inverted_time_range_rejected(self) -> None:
        """start >= end is not a valid window."""
        with pytest.raises(ValidationError, match="strictly before"):
            AnalyticsFunnelInput(
                workspace_id=_WORKSPACE_ID,
                time_range=(_END, _START),
                funnel_stages=list(_DEFAULT_STAGES),
            )

    def test_equal_time_range_rejected(self) -> None:
        """start == end is rejected (zero-width window)."""
        with pytest.raises(ValidationError, match="strictly before"):
            AnalyticsFunnelInput(
                workspace_id=_WORKSPACE_ID,
                time_range=(_START, _START),
                funnel_stages=list(_DEFAULT_STAGES),
            )

    def test_overly_wide_window_rejected(self) -> None:
        """> 366-day window is rejected to avoid full-table scans."""
        start = dt.datetime(2024, 1, 1, tzinfo=dt.UTC)
        end = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)  # 2 years
        with pytest.raises(ValidationError, match="too wide"):
            AnalyticsFunnelInput(
                workspace_id=_WORKSPACE_ID,
                time_range=(start, end),
                funnel_stages=list(_DEFAULT_STAGES),
            )

    def test_too_few_stages_rejected(self) -> None:
        """Need ≥2 stages to define at least one transition."""
        with pytest.raises(ValidationError):
            AnalyticsFunnelInput(
                workspace_id=_WORKSPACE_ID,
                time_range=(_START, _END),
                funnel_stages=["intake"],
            )

    def test_duplicate_stages_rejected(self) -> None:
        """Duplicate stage names would produce 0% self-drops."""
        with pytest.raises(ValidationError, match="duplicate stage"):
            AnalyticsFunnelInput(
                workspace_id=_WORKSPACE_ID,
                time_range=(_START, _END),
                funnel_stages=["intake", "vetting", "intake"],
            )

    def test_whitespace_stage_name_rejected(self) -> None:
        """Leading/trailing whitespace on stage names is a copy-paste bug."""
        with pytest.raises(ValidationError, match="whitespace"):
            AnalyticsFunnelInput(
                workspace_id=_WORKSPACE_ID,
                time_range=(_START, _END),
                funnel_stages=[" intake", "vetting"],
            )

    def test_empty_stage_name_rejected(self) -> None:
        """Empty stage names break the transition labelling."""
        with pytest.raises(ValidationError, match="non-empty"):
            AnalyticsFunnelInput(
                workspace_id=_WORKSPACE_ID,
                time_range=(_START, _END),
                funnel_stages=["", "vetting"],
            )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Live NotImplementedError + cost attribute surfacing.
# ─────────────────────────────────────────────────────────────────────────────


class TestLiveAndCost:
    """`CAPABILITY_LAYER_MODE=live` must raise — W7 wires the real client."""

    def test_live_mode_raises_not_implemented(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(NotImplementedError, match="W7 deploy phase"):
            analytics_funnel(_input())

    def test_usd_cost_attribute_surfaced(self) -> None:
        """`cost_watch` reads `tool.usd_cost` via getattr — must exist."""
        assert hasattr(analytics_funnel, "usd_cost")
        assert analytics_funnel.usd_cost == USD_COST  # type: ignore[attr-defined]
        assert USD_COST > 0.0

    def test_healthy_max_drop_pct_threshold(self) -> None:
        """The HEALTHY_MAX_DROP_PCT threshold must sit BELOW the canonical
        outreach->reply drop (56%) so the brief's fixture exercises the
        unhealthy-baseline code path."""
        assert HEALTHY_MAX_DROP_PCT < 56.0
        assert HEALTHY_MAX_DROP_PCT > 0.0
