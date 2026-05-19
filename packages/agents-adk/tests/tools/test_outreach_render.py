"""tests/tools/test_outreach_render.py — W2-A3 capability layer test.

Coverage matrix:
    TestInputContract       — Pydantic validation gates
    TestStubSubstitution    — Mustache-light `{{var}}` substitution works
    TestMissingVarFallback  — missing vars become typed placeholders, never ""
    TestLocaleParametrize   — D34's 4 locales drive signature + follow-up-eta
    TestDeterminism         — same input → byte-identical output
    TestOverrides           — `subject`/`body` overrides take precedence
    TestNestedFactsFlatten  — nested dict facts work as well as flat
    TestLiveModeRaises      — CAPABILITY_LAYER_MODE=live → NotImplementedError
    TestCostAttribute       — D41 cost attribute exposed
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.outreach_render import (
    USD_COST,
    OutreachRenderInput,
    OutreachRenderOutput,
    outreach_render,
)


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _force_stub_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")


def _canonical_facts() -> dict[str, object]:
    return {
        "creator": {
            "nickname": "K-Beauty Guru",
            "recentPostThemes": ["morning routine", "vitamin C review"],
            "topHashtags": ["스킨케어"],
        },
        "brand": {
            "name": "Freshly Vitamin C Serum",
            "category": "skincare/serum",
            "keyClaims": ["10% vitamin C", "fragrance-free"],
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# TestInputContract.
# ─────────────────────────────────────────────────────────────────────────────


class TestInputContract:
    def test_minimal_input_validates(self) -> None:
        payload = OutreachRenderInput(templateId="tmpl_brand_ko_001")
        assert payload.template_id == "tmpl_brand_ko_001"
        assert payload.locale == "ko"
        assert payload.subject is None

    def test_empty_template_id_rejected(self) -> None:
        with pytest.raises(ValidationError):
            OutreachRenderInput(templateId="")

    def test_invalid_locale_rejected(self) -> None:
        with pytest.raises(ValidationError):
            OutreachRenderInput(templateId="tmpl_brand_ko_001", locale="fr")  # type: ignore[arg-type]

    def test_extra_field_rejected(self) -> None:
        with pytest.raises(ValidationError):
            OutreachRenderInput.model_validate(  # type: ignore[call-arg]
                {"templateId": "tmpl_brand_ko_001", "rogue": 1}
            )


# ─────────────────────────────────────────────────────────────────────────────
# TestStubSubstitution — Mustache-light variable fill works.
# ─────────────────────────────────────────────────────────────────────────────


class TestStubSubstitution:
    def test_subject_override_substitutes_creator_nickname(self) -> None:
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_en_001",
                facts=_canonical_facts(),
                locale="en",
                subject="Hi {{creator.nickname}}, collab idea",
            )
        )
        assert "K-Beauty Guru" in out.subject
        assert "{{" not in out.subject

    def test_body_override_substitutes_brand_name(self) -> None:
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_en_001",
                facts=_canonical_facts(),
                locale="en",
                body="<p>{{brand.name}} — {{brand.category}}</p>",
            )
        )
        assert "Freshly Vitamin C Serum" in out.body
        assert "skincare/serum" in out.body
        assert "{{" not in out.body

    def test_list_indexing_resolves(self) -> None:
        """`brand.keyClaims.0` should resolve to the first list element."""
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_en_001",
                facts=_canonical_facts(),
                locale="en",
                body="<p>{{brand.keyClaims.0}}</p>",
            )
        )
        assert "10% vitamin C" in out.body


# ─────────────────────────────────────────────────────────────────────────────
# TestMissingVarFallback — missing variables become localised placeholders.
# ─────────────────────────────────────────────────────────────────────────────


class TestMissingVarFallback:
    @pytest.mark.parametrize(
        "locale,placeholder_fragment",
        [
            ("ko", "[누락된 변수: creator.nickname]"),
            ("en", "[missing: creator.nickname]"),
            ("ja", "[未設定: creator.nickname]"),
            ("zh-CN", "[缺失变量: creator.nickname]"),
        ],
    )
    def test_missing_var_emits_localised_placeholder(
        self, locale: str, placeholder_fragment: str
    ) -> None:
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_xx_001",
                facts={},  # no facts → variable is missing
                locale=locale,  # type: ignore[arg-type]
                body="<p>Hello {{creator.nickname}}</p>",
            )
        )
        assert placeholder_fragment in out.body, (
            f"expected localised placeholder for {locale}, got {out.body!r}"
        )
        # The placeholder is NOT the empty string.
        assert out.body != "<p>Hello </p>"


# ─────────────────────────────────────────────────────────────────────────────
# TestLocaleParametrize — every D34 locale produces a valid render.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("locale", ["ko", "en", "ja", "zh-CN"])
class TestLocaleParametrize:
    def test_fallback_template_renders_for_locale(self, locale: str) -> None:
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_xx_001",
                facts=_canonical_facts(),
                locale=locale,  # type: ignore[arg-type]
            )
        )
        assert isinstance(out, OutreachRenderOutput)
        assert "K-Beauty Guru" in out.body
        assert out.fetched_via == "stub"

    def test_signature_is_locale_specific(self, locale: str) -> None:
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_xx_001",
                facts=_canonical_facts(),
                locale=locale,  # type: ignore[arg-type]
            )
        )
        assert out.sender_signature.strip(), "signature must be non-empty"
        # Signature contains either the localised closing word or the brand.
        assert "Social Seeding" in out.sender_signature

    def test_follow_up_eta_within_bounds(self, locale: str) -> None:
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_xx_001",
                facts=_canonical_facts(),
                locale=locale,  # type: ignore[arg-type]
            )
        )
        assert 1 <= out.follow_up_eta_days <= 14


def test_follow_up_eta_varies_by_locale() -> None:
    """Regional norms: JA = 4d, ZH = 5d, KR/EN = 3d. Variance must be visible."""
    etas: set[int] = set()
    for locale in ("ko", "en", "ja", "zh-CN"):
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_xx_001",
                facts=_canonical_facts(),
                locale=locale,  # type: ignore[arg-type]
            )
        )
        etas.add(out.follow_up_eta_days)
    # At least 2 distinct values across the 4 locales (else the locale
    # information is a no-op and the contract is broken).
    assert len(etas) >= 2


# ─────────────────────────────────────────────────────────────────────────────
# TestDeterminism.
# ─────────────────────────────────────────────────────────────────────────────


class TestDeterminism:
    def test_same_input_byte_identical_output(self) -> None:
        payload = OutreachRenderInput(
            templateId="tmpl_brand_ko_001",
            facts=_canonical_facts(),
            locale="ko",
        )
        first = outreach_render(payload)
        second = outreach_render(payload)
        assert first.model_dump_json() == second.model_dump_json()


# ─────────────────────────────────────────────────────────────────────────────
# TestOverrides.
# ─────────────────────────────────────────────────────────────────────────────


class TestOverrides:
    def test_subject_override_takes_precedence(self) -> None:
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_en_001",
                facts=_canonical_facts(),
                locale="en",
                subject="Custom subject for {{creator.nickname}}",
            )
        )
        assert out.subject.startswith("Custom subject for")

    def test_body_override_takes_precedence(self) -> None:
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_en_001",
                facts=_canonical_facts(),
                locale="en",
                body="<p>Custom body for {{creator.nickname}}.</p>",
            )
        )
        assert "Custom body for" in out.body


# ─────────────────────────────────────────────────────────────────────────────
# TestNestedFactsFlatten.
# ─────────────────────────────────────────────────────────────────────────────


class TestNestedFactsFlatten:
    def test_nested_dict_is_flattened(self) -> None:
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_en_001",
                facts={"creator": {"nickname": "Foo"}},
                locale="en",
                body="<p>Hi {{creator.nickname}}</p>",
            )
        )
        assert "Foo" in out.body

    def test_already_flat_dict_works(self) -> None:
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_en_001",
                facts={"creator.nickname": "Bar"},
                locale="en",
                body="<p>Hi {{creator.nickname}}</p>",
            )
        )
        assert "Bar" in out.body

    def test_brief_and_facts_merge(self) -> None:
        out = outreach_render(
            OutreachRenderInput(
                templateId="tmpl_brand_en_001",
                facts={"creator": {"nickname": "Foo"}},
                brief={"brand": {"name": "Acme"}},
                locale="en",
                body="<p>{{creator.nickname}} — {{brand.name}}</p>",
            )
        )
        assert "Foo" in out.body
        assert "Acme" in out.body


# ─────────────────────────────────────────────────────────────────────────────
# TestLiveModeRaises.
# ─────────────────────────────────────────────────────────────────────────────


class TestLiveModeRaises:
    def test_live_mode_raises_not_implemented(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        with pytest.raises(NotImplementedError) as exc_info:
            outreach_render(
                OutreachRenderInput(
                    templateId="tmpl_brand_en_001",
                    facts=_canonical_facts(),
                    locale="en",
                )
            )
        assert "W7" in str(exc_info.value)


# ─────────────────────────────────────────────────────────────────────────────
# TestCostAttribute.
# ─────────────────────────────────────────────────────────────────────────────


class TestCostAttribute:
    def test_usd_cost_attribute_exposed(self) -> None:
        assert hasattr(outreach_render, "usd_cost")
        assert outreach_render.usd_cost == USD_COST  # type: ignore[attr-defined]
        assert outreach_render.usd_cost > 0.0  # type: ignore[attr-defined]
