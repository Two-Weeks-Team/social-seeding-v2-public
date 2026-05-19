"""translation.translate — Cross-locale translation capability tool (W2-B5).

Phase 3 capability-layer tool wired into the **a11y** agent
(`a11y.spec.md §6`). Translates a single text string from one D34 locale
to another, with optional glossary scoping. Drives the cross-locale fan-out
inside the a11y agent (one call per non-source locale per asset).

Citations:
    D23 — Tier-1 agent #15 (a11y) lists `translation.translate` as a
          callable capability for cross-locale fan-out.
    D33 — Translation requests are stateless: nothing is persisted to
          Cloud Storage by this capability. Glossaries (when supplied)
          live in Translation API itself, not Cloud Storage.
    D34 — 4-locale supported set: ko / en / ja / zh-CN. The 4×4 matrix
          (16 cells, 12 of which are non-identity translations) is the
          deterministic stub's golden surface.
    D41 — Capability layer ADK FunctionTool pattern. Stub vs live via
          `CAPABILITY_LAYER_MODE` env var, per-tool USD cost surfaced as
          `__capability_cost_usd__` for cost_watch.

Contract (a11y.spec.md §6 + task brief):

    Input:
        text           — text to translate (≤ 5000 chars).
        source_locale  — one of ko / en / ja / zh-CN (D34).
        target_locale  — one of ko / en / ja / zh-CN (D34).
        glossary_id    — optional Translation API glossary id.

    Output:
        translated_text         — translated string in target_locale.
        detected_source_locale  — locale Translation API detected (string).
        confidence_0_1          — float [0, 1].

Stub determinism (D41):
    Deterministic per-(source, target) cell. The 16-cell matrix is pinned
    in `_STUB_TRANSLATION_TABLE`. Identity cells (source == target) return
    the original text unchanged. Confidence is fixed at 0.98 for non-
    identity cells and 1.0 for identity cells. Tests parametrize across
    all 16 cells.

Live mode:
    Raises `NotImplementedError` with a Phase-4 wiring pointer. The
    eventual implementation will call
    `google.cloud.translate_v3.TranslationServiceAsyncClient.translate_text`
    with `model="general/nmt"` (or the model id chosen by the live wiring
    task once we measure BLEU per a11y.spec.md §7).
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Capability-layer mode selector — D41.
# ─────────────────────────────────────────────────────────────────────────────


CapabilityLayerMode = Literal["stub", "live"]


SupportedLocale = Literal["ko", "en", "ja", "zh-CN"]


def _capability_mode() -> CapabilityLayerMode:
    """Read CAPABILITY_LAYER_MODE from env. Defaults to ``"stub"``."""
    raw = os.environ.get("CAPABILITY_LAYER_MODE", "stub").strip().lower()
    if raw not in ("stub", "live"):
        logger.warning(
            "capability_layer_mode_invalid",
            extra={"raw": raw, "fallback": "stub"},
        )
        return "stub"
    return raw  # type: ignore[return-value]


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic I/O schemas — the canonical W2-A1 contract surface.
# ─────────────────────────────────────────────────────────────────────────────


class TranslationTranslateInput(BaseModel):
    """Input schema for `translation_translate`.

    Validation:
        * `text` must be non-empty and ≤ 5000 chars.
        * `source_locale` + `target_locale` must both be in the D34 set.
        * `glossary_id` (when present) must match the Translation API id
          shape: `projects/{p}/locations/{l}/glossaries/{g}`.
    """

    model_config = ConfigDict(extra="forbid")

    text: str = Field(
        min_length=1,
        max_length=5000,
        description="Text to translate. ≤ 5000 chars (Translation API cap).",
    )
    source_locale: SupportedLocale = Field(
        description="Declared source locale (D34)."
    )
    target_locale: SupportedLocale = Field(
        description="Target locale (D34)."
    )
    glossary_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=512,
        description=(
            "Optional Translation API glossary id "
            "(projects/{p}/locations/{l}/glossaries/{g})."
        ),
    )


class TranslationTranslateOutput(BaseModel):
    """Output schema for `translation_translate`.

    See module docstring for field semantics.
    """

    model_config = ConfigDict(extra="forbid")

    translated_text: str = Field(
        min_length=0,
        max_length=10_000,
        description="Translated string in target_locale.",
    )
    detected_source_locale: SupportedLocale = Field(
        description="Locale Translation API detected from the input text."
    )
    confidence_0_1: float = Field(
        ge=0.0,
        le=1.0,
        description="Confidence of the translation, in [0, 1].",
    )


# ─────────────────────────────────────────────────────────────────────────────
# The capability function — what `a11y.tools=[…]` receives.
# ─────────────────────────────────────────────────────────────────────────────


# Google Cloud Translation NMT model price (2026 H1 list, USD per 1M chars).
# Per-call cost averaged over a 500-char a11y transcript translation.
_CAPABILITY_COST_USD = 0.0010


# The canonical 4×4 round-trip matrix. The 16 cells cover every D34 pair.
# Identity cells (diagonal) are NOT stored here — the function returns the
# input text unchanged for those. The table content matches the deterministic
# stub strings used by the `vision_describe` + `stt_transcribe` stubs so
# golden-set evals can chain calls without divergence.
_STUB_TRANSLATION_TABLE: dict[tuple[str, str], str] = {
    # source=ko
    ("ko", "en"): "Hello world. Now.",
    ("ko", "ja"): "こんにちは、世界。今。",
    ("ko", "zh-CN"): "你好,世界。现在。",
    # source=en
    ("en", "ko"): "안녕하세요, 세상. 지금.",
    ("en", "ja"): "こんにちは、世界。今。",
    ("en", "zh-CN"): "你好,世界。现在。",
    # source=ja
    ("ja", "ko"): "안녕하세요, 세상. 지금.",
    ("ja", "en"): "Hello world. Now.",
    ("ja", "zh-CN"): "你好,世界。现在。",
    # source=zh-CN
    ("zh-CN", "ko"): "안녕하세요, 세상. 지금.",
    ("zh-CN", "en"): "Hello world. Now.",
    ("zh-CN", "ja"): "こんにちは、世界。今。",
}


def translation_translate(
    input: TranslationTranslateInput,
) -> TranslationTranslateOutput:
    """Translate text between two D34 locales.

    Args:
        input: TranslationTranslateInput — text + source_locale +
        target_locale + optional glossary_id.

    Returns:
        TranslationTranslateOutput — translated_text /
        detected_source_locale / confidence_0_1.

    Behaviour by mode (CAPABILITY_LAYER_MODE env, D41):
        * ``"stub"`` (default) — returns a deterministic per-(source,
          target) translation from the 4×4 matrix. Identity cells
          (source == target) return the input unchanged with confidence
          1.0. Non-identity cells return the canned string with confidence
          0.98.
        * ``"live"`` — raises ``NotImplementedError`` until Phase 4 wires
          `google.cloud.translate_v3.TranslationServiceAsyncClient.translate_text`.

    Example:
        >>> out = translation_translate(TranslationTranslateInput(
        ...     text="안녕하세요 세상 지금",
        ...     source_locale="ko",
        ...     target_locale="en",
        ... ))
        >>> out.translated_text
        'Hello world. Now.'
        >>> out.detected_source_locale
        'ko'
    """
    mode = _capability_mode()
    if mode == "live":
        raise NotImplementedError(
            "translation_translate live mode not yet implemented. Phase 4 "
            "will wire google.cloud.translate_v3.TranslationServiceAsyncClient."
            "translate_text with the NMT model. Until then run with "
            "CAPABILITY_LAYER_MODE=stub (the default)."
        )

    logger.debug(
        "translation_translate_stub_invoked",
        extra={
            "text_len": len(input.text),
            "source_locale": input.source_locale,
            "target_locale": input.target_locale,
            "has_glossary": input.glossary_id is not None,
        },
    )

    # Identity cells — short-circuit. Translation API would return the
    # source string unchanged + 1.0 confidence, so we mirror that.
    if input.source_locale == input.target_locale:
        return TranslationTranslateOutput(
            translated_text=input.text,
            detected_source_locale=input.source_locale,
            confidence_0_1=1.0,
        )

    translated = _STUB_TRANSLATION_TABLE[(input.source_locale, input.target_locale)]
    return TranslationTranslateOutput(
        translated_text=translated,
        detected_source_locale=input.source_locale,
        confidence_0_1=0.98,
    )


# Per-tool USD cost surfaced as an attribute so `cost_watch` can aggregate
# without re-reading the pricing page. D41 mandates this surface.
translation_translate.__capability_cost_usd__ = _CAPABILITY_COST_USD  # type: ignore[attr-defined]


__all__ = [
    "TranslationTranslateInput",
    "TranslationTranslateOutput",
    "translation_translate",
]
