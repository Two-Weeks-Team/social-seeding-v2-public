"""vision.brand_logo_detect — Cloud Vision logo detection capability tool.

Phase 3 capability-layer tool wired into the **content-verify** agent
(`content_verify.spec.md §6`). Detects whether a creator's post thumbnail /
video frame contains the seeded brand's logo and returns a structured score
the agent reasons over alongside the post desc + hashtags.

Citations:
    D5  — Gemini 2.5 Flash multimodal (content-verify is the first multimodal
          Tier-1 agent; this tool is its visual channel).
    D23 — Tier-1 agent #7 (content_verify) listed `vision.brand_logo_detect`
          as one of two callable capabilities.
    D33 — Post media stored 30d in Cloud Storage with lifecycle rule. The
          `media_url` argument is typically a `gs://` URI under that bucket;
          we also accept `https://` for live RapidAPI fallback paths.
    D41 — Capability layer ADK FunctionTool pattern. This file is the
          **canonical W2-A1 form**: a `(PydanticInput) -> PydanticOutput`
          function that selects stub vs live via `CAPABILITY_LAYER_MODE`
          env var, with stubs returning deterministic canned data and live
          mode raising `NotImplementedError` until the live wiring lands.
          Per-tool USD cost is published on the function via the
          `__capability_cost_usd__` attribute for `cost_watch`.

Contract (content_verify.spec.md §6):

    Input:
        media_url           — gs:// or https:// URI to the thumbnail / frame.
        expected_brand_name — operator-supplied brand name to match against.

    Output:
        logo_detected       — bool, True iff Vision AI reported any logo hits.
        confidence_0_1      — float in [0, 1], confidence of the strongest hit.
        brand_match         — bool, True iff a detected logo's description
                              matches `expected_brand_name` (case-insensitive,
                              partial OK — Vision returns canonical brand text).
        logo_bounding_boxes — list of dicts {x, y, w, h} for each detected
                              logo, ordered by confidence descending.
        detected_logos      — list of brand-text strings Vision returned.

Stub determinism (D41):
    For ANY valid input, the stub returns:
        {
            "logo_detected": True,
            "confidence_0_1": 0.87,
            "brand_match": True,
            "logo_bounding_boxes": [{"x": 100, "y": 100, "w": 200, "h": 200}],
            "detected_logos": ["StubBrand"],
        }
    The output is byte-identical across invocations so golden-set evals and
    CI workflow runs are reproducible. Test fixtures pin this exact shape.

Live mode:
    Raises `NotImplementedError` with a pointer to the Phase 4 wiring task.
    The eventual implementation will call `google.cloud.vision_v1`'s
    `AsyncImageAnnotatorClient.batch_annotate_images` with
    `LOGO_DETECTION` features, then post-filter by the operator's brand
    name. Per-call cost is $0.0015 (Cloud Vision LOGO_DETECTION list price,
    2026 H1) — surfaced as `__capability_cost_usd__` so `cost_watch` can
    aggregate without re-reading the pricing page.
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


class VisionBrandLogoDetectInput(BaseModel):
    """Input schema for `vision_brand_logo_detect`.

    Validation:
        * `media_url` must be `gs://...` or `https://...`. HTTP-without-TLS
          is rejected per D20 (CMEK + DLP — exfil channels must be encrypted).
        * `expected_brand_name` must be non-empty after stripping whitespace;
          a blank brand name guarantees a meaningless `brand_match` result.
    """

    model_config = ConfigDict(extra="forbid")

    media_url: str = Field(
        min_length=1,
        max_length=2048,
        description=(
            "gs:// or https:// URI to the creator post's thumbnail JPEG or "
            "extracted video frame. Lifecycle: Cloud Storage 30d (D33)."
        ),
    )
    expected_brand_name: str = Field(
        min_length=1,
        max_length=200,
        description=(
            "The brand we seeded. Vision AI's logo descriptions are matched "
            "case-insensitively against this string (substring match — Vision "
            "may return 'Nike, Inc.' for 'Nike')."
        ),
    )

    @field_validator("media_url")
    @classmethod
    def _validate_media_url(cls, v: str) -> str:
        """Accept gs:// or https:// only. Reject http:// + every other scheme."""
        v = v.strip()
        if not v:
            raise ValueError("media_url must be a non-empty URI")
        if not (v.startswith("gs://") or v.startswith("https://")):
            raise ValueError(
                "media_url must start with gs:// or https:// "
                f"(got scheme in {v[:32]!r})"
            )
        return v

    @field_validator("expected_brand_name")
    @classmethod
    def _validate_brand_name(cls, v: str) -> str:
        """Strip whitespace, reject empty-after-strip."""
        stripped = v.strip()
        if not stripped:
            raise ValueError("expected_brand_name must be non-empty after strip")
        return stripped


class BoundingBox(BaseModel):
    """Pixel-space bounding box for one detected logo hit."""

    model_config = ConfigDict(extra="forbid")

    x: int = Field(ge=0, description="Top-left X (pixels).")
    y: int = Field(ge=0, description="Top-left Y (pixels).")
    w: int = Field(gt=0, description="Width (pixels).")
    h: int = Field(gt=0, description="Height (pixels).")


class VisionBrandLogoDetectOutput(BaseModel):
    """Output schema for `vision_brand_logo_detect`.

    See module docstring for field semantics.
    """

    model_config = ConfigDict(extra="forbid")

    logo_detected: bool = Field(
        description="True iff Vision AI reported at least one logo hit."
    )
    confidence_0_1: float = Field(
        ge=0.0,
        le=1.0,
        description="Confidence of the strongest hit, normalised to [0, 1].",
    )
    brand_match: bool = Field(
        description=(
            "True iff at least one detected logo's description matches the "
            "operator-supplied `expected_brand_name` (case-insensitive partial)."
        )
    )
    logo_bounding_boxes: list[BoundingBox] = Field(
        default_factory=list,
        max_length=20,
        description="Bounding boxes per detected logo, sorted by confidence desc.",
    )
    detected_logos: list[str] = Field(
        default_factory=list,
        max_length=20,
        description="Brand-text strings Vision returned (canonical names).",
    )


# ─────────────────────────────────────────────────────────────────────────────
# The capability function — what `content_verify.tools=[…]` receives.
# ─────────────────────────────────────────────────────────────────────────────


# Cloud Vision LOGO_DETECTION price (2026 H1 list, 1-1000 images/month tier).
# https://cloud.google.com/vision/pricing
_CAPABILITY_COST_USD = 0.0015


def vision_brand_logo_detect(
    input: VisionBrandLogoDetectInput,
) -> VisionBrandLogoDetectOutput:
    """Detect brand logos in a creator's post thumbnail / video frame.

    Args:
        input: VisionBrandLogoDetectInput — media_url + expected_brand_name.

    Returns:
        VisionBrandLogoDetectOutput — logo_detected / confidence / brand_match
        / bounding boxes / canonical detected-logo names.

    Behaviour by mode (CAPABILITY_LAYER_MODE env, D41):
        * ``"stub"`` (default) — returns the deterministic canned payload
          documented in the module docstring. Input is still Pydantic-validated
          so callers exercising the real contract paths catch schema errors
          identically to live mode.
        * ``"live"`` — raises ``NotImplementedError`` until Phase 4 wires the
          real `google.cloud.vision_v1.AsyncImageAnnotatorClient`.

    Example:
        >>> out = vision_brand_logo_detect(VisionBrandLogoDetectInput(
        ...     media_url="gs://ss-v2-media/posts/p1/thumb.jpg",
        ...     expected_brand_name="Freshly",
        ... ))
        >>> out.logo_detected, out.confidence_0_1, out.brand_match
        (True, 0.87, True)
    """
    mode = _capability_mode()
    if mode == "live":
        raise NotImplementedError(
            "vision_brand_logo_detect live mode not yet implemented. "
            "Phase 4 will wire google.cloud.vision_v1.AsyncImageAnnotatorClient "
            "with LOGO_DETECTION features. Until then run with "
            "CAPABILITY_LAYER_MODE=stub (the default)."
        )

    logger.debug(
        "vision_brand_logo_detect_stub_invoked",
        extra={
            "media_url_prefix": input.media_url[:48],
            "expected_brand_name": input.expected_brand_name,
        },
    )
    return VisionBrandLogoDetectOutput(
        logo_detected=True,
        confidence_0_1=0.87,
        brand_match=True,
        logo_bounding_boxes=[BoundingBox(x=100, y=100, w=200, h=200)],
        detected_logos=["StubBrand"],
    )


# Per-tool USD cost surfaced as an attribute so `cost_watch` (the Tier-1
# cost-monitoring agent) can aggregate without re-reading the pricing page.
# D41 mandates this surface for every capability-layer tool.
vision_brand_logo_detect.__capability_cost_usd__ = _CAPABILITY_COST_USD  # type: ignore[attr-defined]


__all__ = [
    "BoundingBox",
    "VisionBrandLogoDetectInput",
    "VisionBrandLogoDetectOutput",
    "vision_brand_logo_detect",
]
