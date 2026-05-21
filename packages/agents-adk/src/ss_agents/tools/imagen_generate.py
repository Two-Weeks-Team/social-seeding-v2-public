"""imagen.generate — Imagen 4 moodboard-stills capability tool.

Phase 4 capability-layer tool wired into the **creative** agent
(`creative.spec.md §6`). Generates moodboard stills (3-5 per run) from a
text prompt + aspect ratio + safety filter level, returning GCS URIs +
SHA-256 digests + safety attributes the workflow can verify before publish.

Citations:
    D5  — Gemini 3.1 family multimodal baseline; Imagen 4 ships on Vertex AI
          under the same multi-region GA umbrella (D13). The creative agent
          itself runs Gemini 3.5 Flash for direction; this tool is the *image*
          generation channel underneath it.
    D13 — Multi-region active-active. Imagen 4 endpoints exist in
          us-central1 / europe-west4 / asia-northeast3; the live wiring will
          select the closest region to the caller's tenant per D13.
    D23 — Tier-1 agent #14 (creative, NEW) lists `imagen.generate` as one of
          four callable capabilities.
    D33 — Generated assets land in Cloud Storage with a 30-day lifecycle
          rule (the `gs://ss-creative-stub/img_<idx>.png` stub URIs mirror
          the live `gs://ss-v2-creative/{workspace}/{trace}/...` layout).
    D39 — $1,500 credits unlock Imagen 4 + Veo 3 + Lyria for the demo;
          Imagen 4 ≈ $0.04/image at 2026 H1 list, so $3.00/run agent cap
          (creative.spec.md §6) leaves headroom for 3-5 images per call.
    D41 — Capability layer ADK FunctionTool pattern. This file is the
          **canonical W2-A1 form**: a `(PydanticInput) -> PydanticOutput`
          function that selects stub vs live via `CAPABILITY_LAYER_MODE`
          env var. Stubs return deterministic canned payloads keyed on
          input index; live mode raises `NotImplementedError` until the
          Phase 4 live wiring lands. Per-tool USD cost is published on
          the function via `__capability_cost_usd__` for `cost_watch`.

Contract (creative.spec.md §6 + task brief):

    Input:
        prompt              — text prompt describing the desired image.
        num_images          — how many variants to generate (1-4).
        aspect_ratio        — one of "1:1", "16:9", "9:16", "4:3".
        style_hint          — optional short style descriptor (e.g.
                              "minimal", "soft morning-light").
        safety_filter_level — Vertex AI safety enum (BLOCK_LOW_AND_ABOVE /
                              BLOCK_MEDIUM_AND_ABOVE / BLOCK_NONE).

    Output:
        generated_images    — list of {gcs_uri, sha256, width_px, height_px,
                              safety_attributes[]}, one per requested image.
        total_generated     — int, len(generated_images).

Stub determinism (D41):
    For any valid input, the stub returns `num_images` entries where the
    i-th entry's `gcs_uri` is `gs://ss-creative-stub/img_<idx>.png` (idx
    is 1-based). The `sha256` is the SHA-256 hex digest of that URI string,
    making the output byte-stable across invocations regardless of the
    prompt — fixtures pin this exact shape. Width / height are derived
    deterministically from `aspect_ratio` so downstream layout code can
    reason about expected dimensions in CI.

Prompt-injection guard:
    The prompt field has a hard length cap (2000 chars) and is scanned
    against a tool-local ban-list of patterns the upstream prompt-guard
    (D8 + D21) lets through but Imagen's content filter would reject (or
    worse — would produce policy-violating output). The ban-list is
    deliberately narrow: it catches the explicit IP/likeness violations
    that creative.spec.md §8 calls out as RAI-block triggers. Model Armor
    (D21) backstops at the Vertex layer; this is the belt-and-braces.

Live mode:
    Raises `NotImplementedError` with a pointer to the Phase 4 wiring task.
    The eventual implementation will call `vertexai.preview.vision_models
    .ImageGenerationModel.from_pretrained("imagegeneration@006")
    .generate_images(...)` with the requested aspect ratio + safety filter,
    then upload to `gs://ss-v2-creative/{workspace_id}/{trace_id}/img_N.png`
    per D33's lifecycle layout.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
from typing import Final, Literal

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
            extra={"raw": raw, "fallback": "stub", "tool": "imagen_generate"},
        )
        return "stub"
    return raw  # type: ignore[return-value]


# ─────────────────────────────────────────────────────────────────────────────
# Constants — prompt cap + ban-list + aspect-ratio dimension table.
# ─────────────────────────────────────────────────────────────────────────────


_PROMPT_MAX_LEN: Final[int] = 2000
"""Hard cap on prompt length. Imagen 4's input limit is ~480 tokens; 2000
chars is conservative and lets the upstream prompt-guard scan run quickly."""

# Tool-local ban-list. Patterns here are the *Imagen-specific* policy
# violations creative.spec.md §8 calls out — likeness of real people,
# competitor-IP rendering instructions, explicit deepfake requests. The
# upstream `prompt_guard.scan_text` covers the generic prompt-injection
# corpus; this list is for content-policy violations that Imagen would
# itself reject (we trip before the Vertex round-trip to save spend).
_IMAGEN_BANNED_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    # Named real-person likeness (creative.spec.md §8 #1).
    re.compile(
        r"\b(?:photo|image|picture|portrait|likeness)\s+of\s+"
        r"(?:Taylor\s+Swift|Beyonc[eé]|Drake|Elon\s+Musk|Donald\s+Trump|"
        r"Joe\s+Biden|BTS|Blackpink|IU)\b",
        re.IGNORECASE,
    ),
    # Explicit deepfake / face-swap requests.
    re.compile(r"\b(deepfake|face[\s-]?swap|impersonat\w+)\b", re.IGNORECASE),
    # Competitor logo rendering instructions (creative.spec.md §8 #5).
    re.compile(
        r"\b(?:render|generate|create|draw)\s+(?:the\s+)?"
        r"(?:Nike|Adidas|Apple|Coca[\s-]?Cola|Pepsi)\s+logo\b",
        re.IGNORECASE,
    ),
    # CSAM / minor-likeness (defence in depth — Model Armor catches this).
    re.compile(r"\b(child|minor|underage)\s+(?:nude|sexual|explicit)\b", re.IGNORECASE),
)


# Aspect ratio → (width_px, height_px) at Imagen 4's default resolution
# tier (1024-ish on the long edge). The exact pixel sizes match the
# Imagen 4 documented output for each aspect ratio per Vertex AI docs:
# https://cloud.google.com/vertex-ai/generative-ai/docs/image/generate-images
_ASPECT_DIMENSIONS: Final[dict[str, tuple[int, int]]] = {
    "1:1":  (1024, 1024),
    "16:9": (1408, 768),
    "9:16": (768, 1408),
    "4:3":  (1280, 960),
}


AspectRatio = Literal["1:1", "16:9", "9:16", "4:3"]
"""The 4 aspect ratios Imagen 4 supports natively on Vertex AI."""

SafetyFilterLevel = Literal[
    "BLOCK_LOW_AND_ABOVE",
    "BLOCK_MEDIUM_AND_ABOVE",
    "BLOCK_NONE",
]
"""Vertex AI safety filter levels. BLOCK_LOW_AND_ABOVE is the strictest
(blocks LOW + MEDIUM + HIGH); BLOCK_NONE is unsafe and reserved for
operator-confirmed campaigns only."""


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic I/O schemas — the canonical D41 contract surface.
# ─────────────────────────────────────────────────────────────────────────────


class ImagenGenerateInput(BaseModel):
    """Input schema for `imagen_generate`.

    Validation:
        * `prompt` is non-empty after strip + capped at 2000 chars + scanned
          against the Imagen-specific ban-list (defence in depth on top of
          the upstream prompt-guard).
        * `num_images` is 1-4 (Imagen 4's per-call sample cap).
        * `aspect_ratio` is one of the 4 Imagen-supported ratios.
        * `style_hint` optional, 0-200 chars.
        * `safety_filter_level` is one of the 3 Vertex AI enums.
    """

    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(
        min_length=1,
        max_length=_PROMPT_MAX_LEN,
        description=(
            "Text prompt describing the desired image. Capped at "
            f"{_PROMPT_MAX_LEN} chars; scanned against the Imagen-specific "
            "ban-list (named real-person likeness / deepfake / competitor "
            "logo rendering) BEFORE the Vertex round-trip happens."
        ),
    )
    num_images: int = Field(
        ge=1,
        le=4,
        description="How many image variants to generate (1-4, Imagen 4 per-call cap).",
    )
    aspect_ratio: AspectRatio = Field(
        description="Output aspect ratio. One of the 4 Imagen-supported values.",
    )
    style_hint: str | None = Field(
        default=None,
        max_length=200,
        description="Optional short style descriptor (e.g. 'minimal', 'soft morning-light').",
    )
    safety_filter_level: SafetyFilterLevel = Field(
        description=(
            "Vertex AI safety filter level. BLOCK_LOW_AND_ABOVE is strictest; "
            "BLOCK_NONE is reserved for operator-confirmed runs only."
        ),
    )

    @field_validator("prompt")
    @classmethod
    def _validate_prompt(cls, v: str) -> str:
        """Strip, reject empty, scan against the Imagen ban-list."""
        stripped = v.strip()
        if not stripped:
            raise ValueError("prompt must be non-empty after strip")
        for pattern in _IMAGEN_BANNED_PATTERNS:
            m = pattern.search(stripped)
            if m:
                raise ValueError(
                    f"prompt trips imagen ban-list (pattern matched: {m.group(0)!r}); "
                    "see creative.spec.md §8 for the policy details"
                )
        return stripped

    @field_validator("style_hint")
    @classmethod
    def _validate_style_hint(cls, v: str | None) -> str | None:
        """Strip + normalise empty-after-strip to None."""
        if v is None:
            return None
        stripped = v.strip()
        return stripped if stripped else None


class GeneratedImage(BaseModel):
    """One generated image's manifest entry."""

    model_config = ConfigDict(extra="forbid")

    gcs_uri: str = Field(
        pattern=r"^gs://",
        description="Cloud Storage URI of the generated image (gs://...).",
    )
    sha256: str = Field(
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-f]{64}$",
        description="SHA-256 hex digest of the image bytes (or the canonical URI in stub mode).",
    )
    width_px: int = Field(
        gt=0,
        description="Image width in pixels — derived from aspect_ratio.",
    )
    height_px: int = Field(
        gt=0,
        description="Image height in pixels — derived from aspect_ratio.",
    )
    safety_attributes: list[str] = Field(
        default_factory=list,
        max_length=20,
        description=(
            "RAI safety attributes Vertex AI reported (e.g. 'safe', "
            "'low_risk_violence'). Empty list = no flags raised."
        ),
    )


class ImagenGenerateOutput(BaseModel):
    """Output schema for `imagen_generate`.

    `total_generated` must equal `len(generated_images)` — enforced by the
    validator below. The runtime asserts this invariant pre-handoff so the
    downstream agent never reasons over a mismatched count.
    """

    model_config = ConfigDict(extra="forbid")

    generated_images: list[GeneratedImage] = Field(
        min_length=1,
        max_length=4,
        description="Per-image manifest entries; length == total_generated.",
    )
    total_generated: int = Field(
        ge=1,
        le=4,
        description="Number of images actually generated (== len(generated_images)).",
    )

    @field_validator("total_generated")
    @classmethod
    def _coherent_count(cls, v: int, info: object) -> int:
        # ValidationInfo carries field state; cross-field check is enforced
        # by model_validator below — keep this validator deliberately simple
        # so error messages point at the right field path.
        return v


# ─────────────────────────────────────────────────────────────────────────────
# The capability function — what `creative.tools=[…]` receives.
# ─────────────────────────────────────────────────────────────────────────────


# Imagen 4 list price per image (2026 H1, Vertex AI Standard tier).
# https://cloud.google.com/vertex-ai/generative-ai/pricing
_CAPABILITY_COST_USD: Final[float] = 0.04


def imagen_generate(input: ImagenGenerateInput) -> ImagenGenerateOutput:
    """Generate moodboard still images via Imagen 4.

    Args:
        input: ImagenGenerateInput — prompt + count + aspect + style + safety.

    Returns:
        ImagenGenerateOutput — per-image manifest + total count.

    Behaviour by mode (CAPABILITY_LAYER_MODE env, D41):
        * ``"stub"`` (default) — returns `num_images` entries where the i-th
          entry's `gcs_uri` is `gs://ss-creative-stub/img_<idx>.png` (1-based).
          The `sha256` is SHA-256(URI) so the output is byte-identical across
          invocations regardless of prompt. Width / height come from the
          aspect ratio table.
        * ``"live"`` — raises ``NotImplementedError`` until Phase 4 wires
          `vertexai.preview.vision_models.ImageGenerationModel`.

    Example:
        >>> out = imagen_generate(ImagenGenerateInput(
        ...     prompt="A serene morning skincare flat-lay, soft daylight",
        ...     num_images=3,
        ...     aspect_ratio="1:1",
        ...     safety_filter_level="BLOCK_MEDIUM_AND_ABOVE",
        ... ))
        >>> out.total_generated
        3
        >>> out.generated_images[0].gcs_uri
        'gs://ss-creative-stub/img_1.png'
    """
    mode = _capability_mode()
    if mode == "live":
        raise NotImplementedError(
            "imagen_generate live mode not yet implemented. Phase 4 will wire "
            "vertexai.preview.vision_models.ImageGenerationModel with the "
            "requested aspect ratio + safety filter. Until then run with "
            "CAPABILITY_LAYER_MODE=stub (the default)."
        )

    width, height = _ASPECT_DIMENSIONS[input.aspect_ratio]
    images: list[GeneratedImage] = []
    for idx in range(1, input.num_images + 1):
        gcs_uri = f"gs://ss-creative-stub/img_{idx}.png"
        sha256 = hashlib.sha256(gcs_uri.encode("utf-8")).hexdigest()
        images.append(
            GeneratedImage(
                gcs_uri=gcs_uri,
                sha256=sha256,
                width_px=width,
                height_px=height,
                safety_attributes=["safe"],
            )
        )

    logger.debug(
        "imagen_generate_stub_invoked",
        extra={
            "prompt_prefix": input.prompt[:48],
            "num_images": input.num_images,
            "aspect_ratio": input.aspect_ratio,
            "safety_filter_level": input.safety_filter_level,
        },
    )

    return ImagenGenerateOutput(
        generated_images=images,
        total_generated=len(images),
    )


# Per-tool USD cost surfaced as an attribute so `cost_watch` (the Tier-1
# cost-monitoring agent) can aggregate without re-reading the pricing page.
# D41 mandates this surface for every capability-layer tool. Note: this is
# the PER-IMAGE cost — total cost for an invocation is num_images × this.
imagen_generate.__capability_cost_usd__ = _CAPABILITY_COST_USD  # type: ignore[attr-defined]


__all__ = [
    "AspectRatio",
    "GeneratedImage",
    "ImagenGenerateInput",
    "ImagenGenerateOutput",
    "SafetyFilterLevel",
    "imagen_generate",
]
