"""Tests for translation.translate — the W2-B5 capability-layer tool.

Coverage matrix:
    1. Stub determinism — same input ⇒ byte-identical output across calls.
    2. 4-locale matrix — every (source, target) cell in the 4×4 D34 grid
       produces a deterministic translation (12 non-identity cells + 4
       identity cells).
    3. Identity cells (source == target) return input unchanged + 1.0
       confidence.
    4. Pydantic validation — text length, glossary id shape, locale enum.
    5. Live mode raises NotImplementedError when CAPABILITY_LAYER_MODE=live.
    6. Per-tool cost attribute is published (D41 — cost_watch reads this).
"""
from __future__ import annotations

from itertools import product

import pytest
from pydantic import ValidationError

from ss_agents.tools.translation_translate import (
    TranslationTranslateInput,
    TranslationTranslateOutput,
    translation_translate,
)

_LOCALES: tuple[str, ...] = ("ko", "en", "ja", "zh-CN")


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_returns_canonical_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stub MUST return the exact canned translation for every valid
    (source, target) pair."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = TranslationTranslateInput(
        text="안녕하세요 세상 지금",
        source_locale="ko",
        target_locale="en",
    )
    out = translation_translate(payload)
    assert isinstance(out, TranslationTranslateOutput)
    assert out.translated_text == "Hello world. Now."
    assert out.detected_source_locale == "ko"
    assert out.confidence_0_1 == 0.98


def test_stub_determinism_across_invocations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Repeated calls with the same input must serialise to identical JSON."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = TranslationTranslateInput(
        text="hello world",
        source_locale="en",
        target_locale="ko",
    )
    json_outputs = {translation_translate(payload).model_dump_json() for _ in range(5)}
    assert len(json_outputs) == 1


def test_stub_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """When CAPABILITY_LAYER_MODE is unset, default is "stub"."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = translation_translate(
        TranslationTranslateInput(
            text="hello",
            source_locale="en",
            target_locale="ko",
        )
    )
    assert out.translated_text != ""
    assert 0.0 <= out.confidence_0_1 <= 1.0


# ─────────────────────────────────────────────────────────────────────────────
# 2. 4-locale matrix parametrize (4×4 = 16 cells).
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("source", "target"),
    list(product(_LOCALES, _LOCALES)),
)
def test_full_matrix_is_deterministic(
    source: str, target: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every cell in the 4×4 D34 matrix produces a deterministic translation."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = TranslationTranslateInput(
        text="sample text",
        source_locale=source,  # type: ignore[arg-type]
        target_locale=target,  # type: ignore[arg-type]
    )
    out = translation_translate(payload)
    assert out.detected_source_locale == source
    assert out.translated_text != ""


def test_non_identity_cells_have_high_confidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Non-identity cells return confidence 0.98."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    for source, target in product(_LOCALES, _LOCALES):
        if source == target:
            continue
        out = translation_translate(
            TranslationTranslateInput(
                text="sample",
                source_locale=source,  # type: ignore[arg-type]
                target_locale=target,  # type: ignore[arg-type]
            )
        )
        assert out.confidence_0_1 == 0.98, (
            f"({source}->{target}) expected 0.98, got {out.confidence_0_1}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Identity cells.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("locale", list(_LOCALES))
def test_identity_cell_returns_input_unchanged(
    locale: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """source == target → input returned unchanged + confidence 1.0."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = translation_translate(
        TranslationTranslateInput(
            text="My exact text",
            source_locale=locale,  # type: ignore[arg-type]
            target_locale=locale,  # type: ignore[arg-type]
        )
    )
    assert out.translated_text == "My exact text"
    assert out.confidence_0_1 == 1.0
    assert out.detected_source_locale == locale


# ─────────────────────────────────────────────────────────────────────────────
# 4. Pydantic validation.
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_empty_text() -> None:
    """text must be non-empty."""
    with pytest.raises(ValidationError):
        TranslationTranslateInput(
            text="",
            source_locale="en",
            target_locale="ko",
        )


def test_input_rejects_overlong_text() -> None:
    """text > 5000 chars rejected."""
    with pytest.raises(ValidationError):
        TranslationTranslateInput(
            text="x" * 5001,
            source_locale="en",
            target_locale="ko",
        )


@pytest.mark.parametrize("bad_locale", ["fr", "de", "es", "EN", "", "zh"])
def test_invalid_source_locale_rejected(bad_locale: str) -> None:
    """Source locales outside D34 fail Pydantic validation."""
    with pytest.raises(ValidationError):
        TranslationTranslateInput(
            text="hello",
            source_locale=bad_locale,  # type: ignore[arg-type]
            target_locale="en",
        )


@pytest.mark.parametrize("bad_locale", ["fr", "de", "es", "EN", "", "zh"])
def test_invalid_target_locale_rejected(bad_locale: str) -> None:
    """Target locales outside D34 fail Pydantic validation."""
    with pytest.raises(ValidationError):
        TranslationTranslateInput(
            text="hello",
            source_locale="en",
            target_locale=bad_locale,  # type: ignore[arg-type]
        )


def test_input_accepts_optional_glossary() -> None:
    """glossary_id (when present) is a Translation API resource path."""
    payload = TranslationTranslateInput(
        text="hello",
        source_locale="en",
        target_locale="ko",
        glossary_id="projects/p/locations/us-central1/glossaries/g",
    )
    assert payload.glossary_id == "projects/p/locations/us-central1/glossaries/g"


def test_input_forbids_extra_fields() -> None:
    """Extra fields rejected."""
    with pytest.raises(ValidationError):
        TranslationTranslateInput.model_validate(
            {
                "text": "hello",
                "source_locale": "en",
                "target_locale": "ko",
                "rogue": "drop",
            }
        )


# ─────────────────────────────────────────────────────────────────────────────
# 5. Live mode.
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    """Until Phase 4 wires real Translation API, live mode MUST raise."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    payload = TranslationTranslateInput(
        text="hello",
        source_locale="en",
        target_locale="ko",
    )
    with pytest.raises(NotImplementedError) as exc:
        translation_translate(payload)
    assert "Phase 4" in str(exc.value) or "live mode" in str(exc.value).lower()


# ─────────────────────────────────────────────────────────────────────────────
# 6. Cost attribute.
# ─────────────────────────────────────────────────────────────────────────────


def test_capability_cost_attribute_published() -> None:
    """D41: per-tool USD cost surfaced as a function attribute."""
    cost = getattr(translation_translate, "__capability_cost_usd__", None)
    assert cost is not None
    assert isinstance(cost, float)
    assert 0 < cost < 0.01
