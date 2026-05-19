"""tests/tools/test_templates_list.py — W2-A3 capability layer test.

Coverage matrix:
    TestInputContract        — Pydantic + Literal locale enforcement
    TestStubDeterminism      — same input → byte-identical output
    TestLocaleParametrize    — D34's 4 locales (ko/en/ja/zh-CN) all return 3 templates
    TestCountLimit           — `count_limit` clamps the returned set
    TestCampaignType         — `brand` vs `lead` return different banks
    TestLiveModeRaises       — CAPABILITY_LAYER_MODE=live → NotImplementedError
    TestCostAttribute        — `templates_list.usd_cost` exposed for cost_watch (D41)
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.templates_list import (
    USD_COST,
    OutreachTemplate,
    TemplatesListInput,
    TemplatesListOutput,
    templates_list,
)


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _force_stub_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default every test to stub mode. Live-mode tests opt-in via monkeypatch."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")


# ─────────────────────────────────────────────────────────────────────────────
# TestInputContract — Pydantic validation gates.
# ─────────────────────────────────────────────────────────────────────────────


class TestInputContract:
    """`extra=forbid` + Literal locale + ge/le on count_limit must hold."""

    def test_default_input_validates(self) -> None:
        payload = TemplatesListInput(locale="ko")
        assert payload.locale == "ko"
        assert payload.campaign_type == "brand"
        assert payload.count_limit == 3

    def test_invalid_locale_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TemplatesListInput(locale="fr")  # type: ignore[arg-type]

    def test_unknown_campaign_type_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TemplatesListInput(locale="ko", campaignType="enterprise")  # type: ignore[arg-type]

    def test_count_limit_too_high_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TemplatesListInput(locale="ko", countLimit=100)

    def test_count_limit_zero_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TemplatesListInput(locale="ko", countLimit=0)

    def test_extra_field_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TemplatesListInput.model_validate(  # type: ignore[call-arg]
                {"locale": "ko", "rogue_field": 1}
            )


# ─────────────────────────────────────────────────────────────────────────────
# TestStubDeterminism — golden contract for offline reproducibility.
# ─────────────────────────────────────────────────────────────────────────────


class TestStubDeterminism:
    """Same input → byte-identical output across calls."""

    def test_same_input_returns_byte_identical_output(self) -> None:
        payload = TemplatesListInput(locale="ko", campaignType="brand")
        first = templates_list(payload)
        second = templates_list(payload)
        assert first.model_dump_json() == second.model_dump_json()

    def test_template_ids_are_stable(self) -> None:
        out = templates_list(TemplatesListInput(locale="ko"))
        ids = [t.template_id for t in out.templates]
        assert ids == [
            "tmpl_brand_ko_001",
            "tmpl_brand_ko_002",
            "tmpl_brand_ko_003",
        ]

    def test_lead_template_ids_are_distinct(self) -> None:
        out = templates_list(
            TemplatesListInput(locale="en", campaignType="lead")
        )
        assert all(t.template_id.startswith("tmpl_lead_en_") for t in out.templates)


# ─────────────────────────────────────────────────────────────────────────────
# TestLocaleParametrize — every D34 locale returns a non-empty 3-template set.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("locale", ["ko", "en", "ja", "zh-CN"])
class TestLocaleParametrize:
    """D34 contract: 4 locales × brand + lead campaigns must all be served."""

    def test_brand_returns_three_templates(self, locale: str) -> None:
        out = templates_list(
            TemplatesListInput(locale=locale, campaignType="brand")  # type: ignore[arg-type]
        )
        assert isinstance(out, TemplatesListOutput)
        assert out.locale == locale
        assert out.fetched_via == "stub"
        assert len(out.templates) == 3
        for tmpl in out.templates:
            assert isinstance(tmpl, OutreachTemplate)
            assert tmpl.locale == locale
            assert tmpl.subject.strip()
            assert tmpl.body.strip()
            assert tmpl.variables, "every template must declare its variables"

    def test_lead_returns_three_templates(self, locale: str) -> None:
        out = templates_list(
            TemplatesListInput(locale=locale, campaignType="lead")  # type: ignore[arg-type]
        )
        assert out.locale == locale
        assert len(out.templates) == 3
        for tmpl in out.templates:
            assert tmpl.locale == locale

    def test_template_bodies_contain_mustache_vars(self, locale: str) -> None:
        """Each template must reference at least one `{{var}}` placeholder so
        the downstream renderer has work to do (else the template is hand-
        wired text and the writer's facts-cite invariant is meaningless)."""
        out = templates_list(
            TemplatesListInput(locale=locale, campaignType="brand")  # type: ignore[arg-type]
        )
        for tmpl in out.templates:
            assert "{{" in tmpl.body, (
                f"{tmpl.template_id} body has no Mustache vars: {tmpl.body!r}"
            )


# ─────────────────────────────────────────────────────────────────────────────
# TestCountLimit — `count_limit` clamps the returned set.
# ─────────────────────────────────────────────────────────────────────────────


class TestCountLimit:
    def test_limit_one_returns_one(self) -> None:
        out = templates_list(TemplatesListInput(locale="en", countLimit=1))
        assert len(out.templates) == 1

    def test_limit_higher_than_bank_returns_full_bank(self) -> None:
        out = templates_list(TemplatesListInput(locale="en", countLimit=50))
        # Stub bank has 3 templates per locale per campaign type.
        assert len(out.templates) == 3

    def test_limit_two_returns_two(self) -> None:
        out = templates_list(TemplatesListInput(locale="ja", countLimit=2))
        assert len(out.templates) == 2


# ─────────────────────────────────────────────────────────────────────────────
# TestCampaignType — brand vs lead diverge in subject + body wording.
# ─────────────────────────────────────────────────────────────────────────────


class TestCampaignType:
    def test_brand_vs_lead_have_distinct_subjects(self) -> None:
        brand_out = templates_list(
            TemplatesListInput(locale="en", campaignType="brand")
        )
        lead_out = templates_list(
            TemplatesListInput(locale="en", campaignType="lead")
        )
        brand_subjects = {t.subject for t in brand_out.templates}
        lead_subjects = {t.subject for t in lead_out.templates}
        assert brand_subjects.isdisjoint(lead_subjects), (
            "brand + lead template subjects should not overlap"
        )

    def test_brand_variables_include_creator_paths(self) -> None:
        out = templates_list(TemplatesListInput(locale="en", campaignType="brand"))
        for tmpl in out.templates:
            assert any(v.startswith("creator.") for v in tmpl.variables)

    def test_lead_variables_include_lead_paths(self) -> None:
        out = templates_list(TemplatesListInput(locale="en", campaignType="lead"))
        for tmpl in out.templates:
            assert any(v.startswith("lead.") for v in tmpl.variables)


# ─────────────────────────────────────────────────────────────────────────────
# TestLiveModeRaises — D41 contract: live mode is wired in W7 only.
# ─────────────────────────────────────────────────────────────────────────────


class TestLiveModeRaises:
    """`CAPABILITY_LAYER_MODE=live` must raise NotImplementedError — no silent
    stub fallback in prod."""

    def test_live_mode_raises_not_implemented(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(NotImplementedError) as exc_info:
            templates_list(TemplatesListInput(locale="ko"))
        assert "W7" in str(exc_info.value)

    def test_unknown_mode_falls_through_to_live(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Any non-`stub` value routes to live (fail-closed)."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "staging")
        with pytest.raises(NotImplementedError):
            templates_list(TemplatesListInput(locale="en"))


# ─────────────────────────────────────────────────────────────────────────────
# TestCostAttribute — D41 contract: per-tool USD cost on the callable.
# ─────────────────────────────────────────────────────────────────────────────


class TestCostAttribute:
    def test_usd_cost_attribute_exposed(self) -> None:
        assert hasattr(templates_list, "usd_cost")
        assert templates_list.usd_cost == USD_COST  # type: ignore[attr-defined]
        assert templates_list.usd_cost > 0.0  # type: ignore[attr-defined]
