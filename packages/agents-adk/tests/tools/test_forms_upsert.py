"""Tests for `forms_upsert` — capability layer per D41 + intake.spec.md §6.

Coverage matrix:

    1. Stub determinism (no brief_id → canonical `brief_demo_001`).
    2. Echo-back path (caller-supplied brief_id is preserved verbatim).
    3. `created` toggles: first write → True/version=1; subsequent → False with
       a strictly-monotonic version counter.
    4. Invalid `brief_payload` is rejected by Pydantic — the field-validator
       mirrors `CampaignBrief.model_validate(...)`.
    5. Live mode (CAPABILITY_LAYER_MODE=live) raises NotImplementedError,
       which the runtime converts to an `EscalateToHuman` outcome (D41 contract).
    6. `usd_cost` attribute is surfaced for the `cost_watch` aggregator (D41).
"""
from __future__ import annotations

import datetime as dt
from typing import Any

import pytest
from pydantic import ValidationError

from ss_agents.agents.intake import (
    BrandProduct,
    CampaignBrief,
    Goals,
    Logistics,
    Targeting,
)
from ss_agents.tools.forms_upsert import (
    USD_COST,
    FormsUpsertInput,
    FormsUpsertOutput,
    _reset_stub_state,
    forms_upsert,
)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers + fixtures.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_stub_state() -> None:
    """Each test starts with an empty `_SEEN` set + version ledger so the
    determinism contract holds independently across cases.
    """
    _reset_stub_state()
    yield
    _reset_stub_state()


@pytest.fixture(autouse=True)
def _force_stub_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force CAPABILITY_LAYER_MODE=stub for every test (the live-mode case
    overrides this with its own `monkeypatch.setenv` call)."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")


def _build_brief() -> CampaignBrief:
    """Reusable golden brief — same shape as `tests/conftest.py::example_brief`."""
    return CampaignBrief(
        workspaceId="ws_test_intake_001",
        createdBy="op@social-seeding.test",
        brandProduct=BrandProduct(
            name="Freshly Vitamin C Serum",
            category="skincare/serum",
            description="Brightening Vitamin C serum with hyaluronic acid.",
            keyClaims=["10% vitamin C", "fragrance-free", "vegan"],
        ),
        targeting=Targeting(
            creatorCount=20,
            minEngagementRate=0.03,
            languages=["ko"],
            hashtags=["스킨케어", "비타민C"],
        ),
        logistics=Logistics(shipsSamples=True),
        goals=Goals(
            targetLivePosts=15,
            deadline=dt.datetime(2026, 6, 30, 23, 59, tzinfo=dt.UTC),
        ),
    )


def _payload(brief_id: str | None = None) -> FormsUpsertInput:
    return FormsUpsertInput(
        brief_id=brief_id,
        brief_payload=_build_brief(),
        workspace_id="ws_test_intake_001",
        created_by="op@social-seeding.test",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Test 1 — stub determinism: no brief_id → canonical `brief_demo_001`.
# ─────────────────────────────────────────────────────────────────────────────


class TestStubDeterminism:
    """Per the W2-A8 brief: stub returns deterministic `brief_demo_001` when
    no id is supplied, and the same id across calls (modulo bookkeeping)."""

    def test_no_brief_id_returns_canonical_demo_id(self) -> None:
        out = forms_upsert(_payload(brief_id=None))
        assert out.brief_id == "brief_demo_001"
        assert out.created is True
        assert out.version == 1
        assert isinstance(out, FormsUpsertOutput)
        assert out.persisted_at.tzinfo is not None  # tz-aware UTC

    def test_second_call_with_no_id_returns_same_canonical_id(self) -> None:
        """Two consecutive calls without a brief_id must resolve to the
        SAME canonical id — that's what 'deterministic' means here."""
        first = forms_upsert(_payload(brief_id=None))
        second = forms_upsert(_payload(brief_id=None))
        assert first.brief_id == second.brief_id == "brief_demo_001"


# ─────────────────────────────────────────────────────────────────────────────
# Test 2 — UUIDv7 vs explicit-ID path. The brief says "On insert, generates
# UUIDv7" for live mode (which is unwired). In stub mode the contract is:
#   - explicit id → echo it back.
#   - no id → canonical `brief_demo_001`.
# We assert both branches.
# ─────────────────────────────────────────────────────────────────────────────


class TestIdResolution:

    def test_explicit_brief_id_is_echoed(self) -> None:
        out = forms_upsert(_payload(brief_id="brief_custom_abc"))
        assert out.brief_id == "brief_custom_abc"
        assert out.created is True
        assert out.version == 1

    def test_uuidv7_shaped_id_is_echoed_verbatim(self) -> None:
        """Live mode mints a UUIDv7. Stub mode just echoes whatever the caller
        provides — including a UUIDv7-shaped string. This pins the contract:
        the stub never rewrites caller-supplied ids."""
        # A canonical UUIDv7 form (lowercase, hyphenated).
        # Version nibble '7' at position [12], variant '8|9|a|b' at [16].
        uuid7_like = "0192f8e2-0000-7000-8000-000000000001"
        out = forms_upsert(_payload(brief_id=uuid7_like))
        assert out.brief_id == uuid7_like


# ─────────────────────────────────────────────────────────────────────────────
# Test 3 — `created` toggles + version monotonicity.
# ─────────────────────────────────────────────────────────────────────────────


class TestCreatedFlag:
    """The module-level `_SEEN` set drives `created`. First call → True;
    subsequent calls for the SAME brief_id → False with a bumped version."""

    def test_first_call_inserts(self) -> None:
        out = forms_upsert(_payload(brief_id="brief_xyz"))
        assert out.created is True
        assert out.version == 1

    def test_second_call_updates(self) -> None:
        forms_upsert(_payload(brief_id="brief_xyz"))
        out = forms_upsert(_payload(brief_id="brief_xyz"))
        assert out.created is False
        assert out.version == 2

    def test_version_is_strictly_monotonic_across_many_writes(self) -> None:
        """Five upserts of the same id → versions 1..5, created=True only once."""
        outputs = [forms_upsert(_payload(brief_id="brief_loop")) for _ in range(5)]
        assert [o.version for o in outputs] == [1, 2, 3, 4, 5]
        assert [o.created for o in outputs] == [True, False, False, False, False]

    def test_different_brief_ids_have_independent_counters(self) -> None:
        """`_SEEN` is keyed by brief_id, not global. Two distinct ids must
        each start at version=1/created=True."""
        a1 = forms_upsert(_payload(brief_id="brief_a"))
        b1 = forms_upsert(_payload(brief_id="brief_b"))
        a2 = forms_upsert(_payload(brief_id="brief_a"))
        assert a1.created is True and a1.version == 1
        assert b1.created is True and b1.version == 1
        assert a2.created is False and a2.version == 2


# ─────────────────────────────────────────────────────────────────────────────
# Test 4 — invalid CampaignBrief rejected.
# ─────────────────────────────────────────────────────────────────────────────


class TestInvalidBriefRejected:
    """Pydantic validation must reject `brief_payload` that does not pass
    `CampaignBrief.model_validate(...)`. The field-validator surfaces this
    as a standard `ValidationError`."""

    def test_dict_missing_required_subobjects_is_rejected(self) -> None:
        bad: dict[str, Any] = {
            "workspaceId": "ws_test_intake_001",
            "createdBy": "op@social-seeding.test",
            # Missing brandProduct / targeting / logistics / goals.
        }
        with pytest.raises(ValidationError) as exc:
            FormsUpsertInput(
                brief_id=None,
                brief_payload=bad,
                workspace_id="ws_test_intake_001",
                created_by="op@social-seeding.test",
            )
        # The error must point at `brief_payload`.
        assert any("brief_payload" in str(e["loc"]) for e in exc.value.errors())

    def test_non_dict_brief_payload_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            FormsUpsertInput(
                brief_id=None,
                brief_payload="not a brief",  # type: ignore[arg-type]
                workspace_id="ws_test_intake_001",
                created_by="op@social-seeding.test",
            )

    def test_brief_with_invalid_creator_count_is_rejected(self) -> None:
        """Targeting.creatorCount has `gt=0, le=1000`. A zero value must be
        rejected by the field validator (delegated to CampaignBrief)."""
        bad = {
            "workspaceId": "ws_test_intake_001",
            "createdBy": "op@social-seeding.test",
            "brandProduct": {
                "name": "X",
                "category": "skincare/serum",
                "description": "Y",
            },
            "targeting": {"creatorCount": 0},  # invalid → gt=0
            "logistics": {"shipsSamples": True},
            "goals": {
                "targetLivePosts": 10,
                "deadline": "2026-06-30T23:59:00Z",
            },
        }
        with pytest.raises(ValidationError):
            FormsUpsertInput(
                brief_id=None,
                brief_payload=bad,
                workspace_id="ws_test_intake_001",
                created_by="op@social-seeding.test",
            )

    def test_valid_campaign_brief_instance_passes_through(self) -> None:
        """A pre-constructed CampaignBrief should be accepted as-is — the
        `before` validator's `isinstance` short-circuit avoids redundant
        re-validation work."""
        payload = FormsUpsertInput(
            brief_id="brief_ok",
            brief_payload=_build_brief(),
            workspace_id="ws_test_intake_001",
            created_by="op@social-seeding.test",
        )
        assert isinstance(payload.brief_payload, CampaignBrief)


# ─────────────────────────────────────────────────────────────────────────────
# Test 5 — live mode is unwired pending W7.
# ─────────────────────────────────────────────────────────────────────────────


class TestLiveMode:

    def test_live_mode_raises_not_implemented(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(NotImplementedError, match="W7"):
            forms_upsert(_payload(brief_id=None))

    def test_unknown_mode_falls_through_to_live(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Per D41 the env var is a binary `stub|live` switch. Any non-`stub`
        value routes to the live path (and therefore NotImplementedError
        until W7), which is the safe failure mode."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "production")
        with pytest.raises(NotImplementedError):
            forms_upsert(_payload(brief_id=None))


# ─────────────────────────────────────────────────────────────────────────────
# Test 6 — `usd_cost` attribute surfaced for `cost_watch` (D41).
# ─────────────────────────────────────────────────────────────────────────────


class TestUsdCostSurface:

    def test_usd_cost_attribute_is_attached(self) -> None:
        """Per D41, the cost watch reads `tool_fn.usd_cost` to aggregate spend.
        Missing this attribute would silently undercount intake's USD ledger."""
        assert getattr(forms_upsert, "usd_cost", None) == USD_COST

    def test_usd_cost_is_positive_and_sub_cent(self) -> None:
        """Sanity-bound: a single forms_upsert call must not erode intake's
        $0.20 multi-turn cap — sub-cent keeps the math headroom comfortable."""
        assert 0.0 < USD_COST < 0.01
