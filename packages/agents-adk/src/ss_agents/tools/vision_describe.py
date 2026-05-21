"""vision.describe — alt-text + scene description capability tool (W2-B5).

Phase 3 capability-layer tool wired into the **a11y** agent
(`a11y.spec.md §6`). Generates WCAG 2.1 AA-grade alt-text + scene
description + detected-object list for an image asset in the operator's
target locale. The a11y agent calls this on every requested locale (D34).

Citations:
    D5  — Gemini 3.1 Flash-Lite (multimodal: text + image). Vision.describe is
          a thin wrapper over Gemini multimodal for image captioning OR
          Cloud Vision LABEL_DETECTION when label-only confidence suffices.
    D23 — Tier-1 agent #15 (a11y) lists `vision.describe` as a callable
          capability.
    D33 — Image media stored 30d in Cloud Storage with lifecycle rule.
          Accepts `gs://` (canonical) and `https://` (RapidAPI live-CDN
          fallback) schemes.
    D34 — 4-locale mandatory: ko / en / ja / zh-CN. Stub returns the
          locale-specific deterministic alt-text used by golden-set evals.
    D41 — Capability layer ADK FunctionTool pattern. Same `(PydanticInput)
          -> PydanticOutput` contract as `vision_brand_logo_detect.py`
          (the canonical W2-A1 form): stub vs live selected via
          `CAPABILITY_LAYER_MODE` env var, per-tool USD cost surfaced via
          `__capability_cost_usd__` for `cost_watch` aggregation.

Contract (a11y.spec.md §6 + task brief):

    Input:
        gcs_uri_or_https_url — gs:// or https:// URI to the image.
        locale               — one of ko / en / ja / zh-CN (D34).
        max_length           — alt-text upper bound in chars (50-300).

    Output:
        alt_text          — WCAG-grade alt-text in the requested locale.
        detected_objects  — list of canonical object labels (English).
        scene_description — longer scene description in the requested locale.
        confidence_0_1    — float [0, 1], confidence of the strongest
                            visual signal.

Stub determinism (D41):
    For ANY valid input, the stub returns locale-specific canned alt-text
    + a fixed object list + a fixed confidence. The stub uses the locale
    field to select the alt-text string but every other field is
    byte-identical across invocations.

Live mode:
    Raises `NotImplementedError` with a Phase-4 wiring pointer. The
    eventual implementation will call Gemini 3.1 Flash-Lite multimodal via
    Vertex AI (image + locale-pinned prompt) or fall back to Cloud
    Vision LABEL_DETECTION for the label-only fast path.
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Capability-layer mode selector — D41.
# ─────────────────────────────────────────────────────────────────────────────


CapabilityLayerMode = Literal["stub", "live"]
"""The two modes the capability layer runs in. Set via the
`CAPABILITY_LAYER_MODE` environment variable; defaults to `"stub"` so dev,
CI, and golden-set evals all see deterministic responses."""


# D34 supported locales — single source of truth in this module.
SupportedLocale = Literal["ko", "en", "ja", "zh-CN"]


def _capability_mode() -> CapabilityLayerMode:
    """Read CAPABILITY_LAYER_MODE from env. Defaults to ``"stub"``.

    Unknown values fall back to ``"stub"`` and log a warning — the safer
    default for an operator who fat-fingers the env var.
    """
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


class VisionDescribeInput(BaseModel):
    """Input schema for `vision_describe`.

    Validation:
        * `gcs_uri_or_https_url` must be `gs://...` or `https://...`. Plain
          HTTP is rejected per D20 (CMEK + DLP — exfil channels must be
          encrypted in transit).
        * `locale` must be in the D34 supported set.
        * `max_length` is clamped to the WCAG-friendly band [50, 300].
    """

    model_config = ConfigDict(extra="forbid")

    gcs_uri_or_https_url: str = Field(
        min_length=1,
        max_length=2048,
        description=(
            "gs:// or https:// URI to the image. Lifecycle: Cloud Storage "
            "30d retention per D33."
        ),
    )
    locale: SupportedLocale = Field(
        description="Target locale for alt-text + scene description (D34)."
    )
    max_length: int = Field(
        default=125,
        ge=50,
        le=300,
        description=(
            "Upper bound on alt-text length (chars). 50 < length ≤ 300 per "
            "WCAG SC 1.1.1 + a11y.spec.md §2 #/$defs (altText maxLength=400)."
        ),
    )

    @field_validator("gcs_uri_or_https_url")
    @classmethod
    def _validate_uri(cls, v: str) -> str:
        """Accept gs:// or https:// only. Reject every other scheme."""
        v = v.strip()
        if not v:
            raise ValueError("gcs_uri_or_https_url must be a non-empty URI")
        if not (v.startswith("gs://") or v.startswith("https://")):
            raise ValueError(
                "gcs_uri_or_https_url must start with gs:// or https:// "
                f"(got scheme in {v[:32]!r})"
            )
        return v


class VisionDescribeOutput(BaseModel):
    """Output schema for `vision_describe`.

    See module docstring for field semantics.
    """

    model_config = ConfigDict(extra="forbid")

    alt_text: str = Field(
        min_length=1,
        max_length=400,
        description=(
            "WCAG-grade alt-text in the requested locale. ≤ 400 chars per "
            "a11y.spec.md §2."
        ),
    )
    detected_objects: list[str] = Field(
        default_factory=list,
        max_length=50,
        description=(
            "Canonical object labels (English) from Vision/Gemini multimodal."
        ),
    )
    scene_description: str = Field(
        min_length=0,
        max_length=1000,
        description=(
            "Longer scene description in the requested locale. May exceed "
            "alt_text length when the caller asked for verbose context."
        ),
    )
    confidence_0_1: float = Field(
        ge=0.0,
        le=1.0,
        description="Confidence of the strongest visual signal, in [0, 1].",
    )


# ─────────────────────────────────────────────────────────────────────────────
# The capability function — what `a11y.tools=[…]` receives.
# ─────────────────────────────────────────────────────────────────────────────


# Gemini 3.1 Flash-Lite multimodal price (2026 H1 list, single-image describe).
# Documented for cost_watch aggregation per D41.
_CAPABILITY_COST_USD = 0.0008


# Deterministic per-locale alt-text — used by stub mode. Keep the strings
# short + WCAG-friendly so they satisfy any reasonable max_length above 50.
_STUB_ALT_BY_LOCALE: dict[str, str] = {
    "ko": "비타민C 세럼 30ml 보틀이 욕실 선반 위에 놓여 있는 정물 사진.",
    "en": "Still life of a 30 ml vitamin C serum bottle on a bathroom shelf.",
    "ja": "バスルームの棚に置かれた30mlのビタミンCセラムボトルの静物写真。",
    "zh-CN": "浴室搁板上放置的30毫升维生素C精华液瓶的静物照片。",
}

_STUB_SCENE_BY_LOCALE: dict[str, str] = {
    "ko": (
        "밝은 자연광이 비치는 욕실 선반에 비타민C 세럼 30ml 보틀이 정중앙에 "
        "놓여 있으며, 배경에는 흰색 타일과 작은 식물이 보입니다."
    ),
    "en": (
        "A 30 ml vitamin C serum bottle sits centered on a sunlit bathroom "
        "shelf, with white tile and a small plant in the background."
    ),
    "ja": (
        "明るい自然光が差し込むバスルームの棚の中央に30mlのビタミンCセラム"
        "ボトルが置かれており、背景には白いタイルと小さな観葉植物が見えます。"
    ),
    "zh-CN": (
        "明亮自然光照射下,30毫升的维生素C精华液瓶居中放置在浴室搁板上,"
        "背景可见白色瓷砖和一株小植物。"
    ),
}


def vision_describe(input: VisionDescribeInput) -> VisionDescribeOutput:
    """Generate WCAG-grade alt-text + scene description for an image.

    Args:
        input: VisionDescribeInput — gcs/https URI + locale + max_length.

    Returns:
        VisionDescribeOutput — alt_text / detected_objects /
        scene_description / confidence_0_1.

    Behaviour by mode (CAPABILITY_LAYER_MODE env, D41):
        * ``"stub"`` (default) — returns locale-specific deterministic
          alt-text + a fixed object list. Input is still Pydantic-validated
          so callers exercising the real contract paths catch schema errors
          identically to live mode. The alt_text is truncated to
          ``input.max_length`` at a word boundary when the canned string
          exceeds the cap.
        * ``"live"`` — raises ``NotImplementedError`` until Phase 4 wires
          the real Gemini 3.1 Flash-Lite multimodal call (or Cloud Vision
          LABEL_DETECTION for label-only fast path).

    Example:
        >>> out = vision_describe(VisionDescribeInput(
        ...     gcs_uri_or_https_url="gs://ss-v2-media/demo/skincare.jpg",
        ...     locale="ko",
        ...     max_length=125,
        ... ))
        >>> out.alt_text.startswith("비타민C")
        True
    """
    mode = _capability_mode()
    if mode == "live":
        raise NotImplementedError(
            "vision_describe live mode not yet implemented. Phase 4 will "
            "wire Gemini 3.1 Flash-Lite multimodal via Vertex AI for "
            "image-with-locale captioning. Until then run with "
            "CAPABILITY_LAYER_MODE=stub (the default)."
        )

    logger.debug(
        "vision_describe_stub_invoked",
        extra={
            "uri_prefix": input.gcs_uri_or_https_url[:48],
            "locale": input.locale,
            "max_length": input.max_length,
        },
    )

    raw_alt = _STUB_ALT_BY_LOCALE[input.locale]
    # Clamp the canned string to the caller's max_length while preserving
    # word boundaries (no ugly mid-word cuts in the screen-reader output).
    if len(raw_alt) > input.max_length:
        clipped = raw_alt[: input.max_length]
        # Walk back to the last space so we don't cut a syllable in half;
        # CJK locales have no spaces, so fall back to the hard cut.
        last_space = clipped.rfind(" ")
        if last_space > 0:
            clipped = clipped[:last_space]
        alt_text = clipped
    else:
        alt_text = raw_alt

    return VisionDescribeOutput(
        alt_text=alt_text,
        detected_objects=["bottle", "shelf", "plant", "tile"],
        scene_description=_STUB_SCENE_BY_LOCALE[input.locale],
        confidence_0_1=0.92,
    )


# Per-tool USD cost surfaced as an attribute so `cost_watch` (the Tier-1
# cost-monitoring agent) can aggregate without re-reading the pricing page.
# D41 mandates this surface for every capability-layer tool.
vision_describe.__capability_cost_usd__ = _CAPABILITY_COST_USD  # type: ignore[attr-defined]


__all__ = [
    "VisionDescribeInput",
    "VisionDescribeOutput",
    "vision_describe",
]
