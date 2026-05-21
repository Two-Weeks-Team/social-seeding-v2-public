"""veo.generate — Veo 3 sample-video capability tool.

Phase 4 capability-layer tool wired into the **creative** agent
(`creative.spec.md §6`). Generates one short sample video (≤ 30 sec, but
typically ≤ 8 sec per Veo 3 single-clip cap) from a text prompt + duration
+ aspect ratio + fps, returning a GCS URI + SHA-256 digest + watermark
provenance (SynthID).

Citations:
    D5  — Gemini 3.1 family multimodal baseline. Veo 3 ships on Vertex AI
          alongside the Gemini family; the creative agent (Gemini 3.1 Pro)
          composes the prompt, this tool dispatches the rendering.
    D13 — Multi-region active-active. Veo 3 endpoints exist in a subset
          of regions (us-central1 / europe-west4) at 2026 H1; the live
          wiring will fall back across regions on quota exhaustion per
          creative.spec.md §6 (escalation condition: "Veo 3 quota
          exhausted in region").
    D23 — Tier-1 agent #14 (creative, NEW) lists `veo.generate` as one of
          four callable capabilities.
    D29 — Multimodal + AP2 + Multi-agent — the v2 day-1 differentiator.
          Veo 3 sample video is the headline modality.
    D33 — Generated assets land in Cloud Storage with a 30-day lifecycle
          rule. The stub URI `gs://ss-creative-stub/vid_<duration>.mp4`
          mirrors the live `gs://ss-v2-creative/{ws}/{trace}/vid_*.mp4`
          layout.
    D39 — $1,500 credits unlock Veo 3 for the demo. Veo 3 is the cost
          driver (~$0.50-1.50 per 8s clip at 720p, 2026 H1 list); the
          creative agent's $3.00/run cap (creative.spec.md §6) is sized
          around one Veo call plus the Imagen + Lyria companions.
    D41 — Capability layer ADK FunctionTool pattern. This file is the
          **canonical W2-A1 form**: a `(PydanticInput) -> PydanticOutput`
          function that selects stub vs live via `CAPABILITY_LAYER_MODE`.
          Stubs return deterministic canned payloads keyed on the
          requested duration; live mode raises `NotImplementedError`.

Contract (creative.spec.md §6 + task brief):

    Input:
        prompt           — text prompt; describes subject + motion + style.
        duration_seconds — 4-30 (spec says ≤ 8 for single clip; we accept
                           up to 30 and let the workflow split if needed).
        aspect_ratio     — one of "1:1", "16:9", "9:16", "4:3".
        fps              — 24 or 30 (Veo 3 documented frame rates).

    Output:
        gcs_uri            — `gs://...mp4`.
        sha256             — SHA-256 hex digest (of bytes; of URI in stub).
        duration_s         — actual duration of the produced clip (float).
        fps                — frame rate of the produced clip.
        resolution         — string like "1920x1080" derived from
                             aspect_ratio.
        watermark_present  — bool; True for stub (mirrors Veo 3's default
                             SynthID watermark per provenance policy).

Stub determinism (D41):
    For any valid input, the stub returns
        gcs_uri = `gs://ss-creative-stub/vid_<duration>.mp4`
    where `<duration>` is the integer second value of `duration_seconds`.
    The `sha256` is SHA-256(gcs_uri) so the output is byte-stable across
    invocations regardless of prompt. `watermark_present` is always True
    in stub mode (matches Veo 3's default — SynthID is not opt-out per
    the GA terms).

Prompt-injection guard:
    The prompt field has a hard length cap (2000 chars) and is scanned
    against a tool-local ban-list of patterns Veo 3's safety filter
    would reject (or that creative.spec.md §8 calls out as escalation
    triggers — likeness of real persons, deepfake instructions, etc.).
    The upstream prompt-guard (D8 + D21) handles generic injection;
    this list is content-policy-specific.

Live mode:
    Raises `NotImplementedError` with a pointer to the Phase 4 wiring task.
    The eventual implementation will call `vertexai.preview.generative_models
    .GenerativeModel("veo-3.0")` (or the dedicated Veo SDK once GA) with
    the prompt + duration + aspect + fps, then upload to
    `gs://ss-v2-creative/{workspace_id}/{trace_id}/vid_N.mp4` per D33.
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


def _capability_mode() -> CapabilityLayerMode:
    """Read CAPABILITY_LAYER_MODE from env. Defaults to ``"stub"``."""
    raw = os.environ.get("CAPABILITY_LAYER_MODE", "stub").strip().lower()
    if raw not in ("stub", "live"):
        logger.warning(
            "capability_layer_mode_invalid",
            extra={"raw": raw, "fallback": "stub", "tool": "veo_generate"},
        )
        return "stub"
    return raw  # type: ignore[return-value]


# ─────────────────────────────────────────────────────────────────────────────
# Constants — prompt cap + ban-list + aspect-ratio resolution table.
# ─────────────────────────────────────────────────────────────────────────────


_PROMPT_MAX_LEN: Final[int] = 2000
"""Hard cap on prompt length. Matches creative.spec.md's Veo prompt
discipline ('Keep it under 2000 chars')."""

# Veo-specific ban-list. Patterns Veo 3's safety filter rejects (or that
# creative.spec.md §8 calls out as escalation triggers). The upstream
# `prompt_guard.scan_text` covers generic injection; this list is the
# content-policy belt-and-braces.
_VEO_BANNED_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    # Named real-person likeness in motion — Veo 3 RAI blocks this.
    re.compile(
        r"\b(?:video|footage|clip)\s+of\s+"
        r"(?:Taylor\s+Swift|Beyonc[eé]|Drake|Elon\s+Musk|Donald\s+Trump|"
        r"Joe\s+Biden|BTS|Blackpink|IU)\b",
        re.IGNORECASE,
    ),
    # Deepfake / face-swap motion synthesis.
    re.compile(
        r"\b(deepfake|face[\s-]?swap|impersonat\w+|voice[\s-]?clon\w+)\b",
        re.IGNORECASE,
    ),
    # Hallucinated text overlay against trademarks (creative.spec.md §8 #3).
    re.compile(
        r"\b(?:render|generate|create|draw)\s+(?:the\s+)?"
        r"(?:Nike|Adidas|Apple|Coca[\s-]?Cola|Pepsi)\s+logo\b",
        re.IGNORECASE,
    ),
    # Minor-likeness / CSAM (defence in depth).
    re.compile(r"\b(child|minor|underage)\s+(?:nude|sexual|explicit)\b", re.IGNORECASE),
)


# Aspect ratio → "WxH" resolution string. Veo 3's documented native
# resolutions per Vertex AI docs at GA (720p tier):
#   16:9 → 1280x720
#    9:16 → 720x1280
#    1:1 → 720x720
#    4:3 → 960x720
# Live wiring at 1080p tier will swap these for the higher-res equivalents.
_ASPECT_RESOLUTIONS: Final[dict[str, str]] = {
    "1:1":  "720x720",
    "16:9": "1280x720",
    "9:16": "720x1280",
    "4:3":  "960x720",
}


AspectRatio = Literal["1:1", "16:9", "9:16", "4:3"]
"""The 4 aspect ratios Veo 3 supports natively on Vertex AI."""

VeoFps = Literal[24, 30]
"""Veo 3's documented frame rates. 24 fps for cinematic feel, 30 fps for
social-platform default (TikTok native is 30 fps)."""


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic I/O schemas — the canonical D41 contract surface.
# ─────────────────────────────────────────────────────────────────────────────


class VeoGenerateInput(BaseModel):
    """Input schema for `veo_generate`.

    Validation:
        * `prompt` non-empty after strip + ≤ 2000 chars + scanned against
          the Veo-specific ban-list.
        * `duration_seconds` 4-30 (task brief). Veo 3 single-clip cap is 8s
          per creative.spec.md §6; values 9-30 imply multi-clip splitting
          downstream (the workflow handles that, not this tool).
        * `aspect_ratio` one of the 4 Veo-supported values.
        * `fps` is 24 or 30.
    """

    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(
        min_length=1,
        max_length=_PROMPT_MAX_LEN,
        description=(
            "Text prompt — describes subject + motion + camera + style. "
            f"Capped at {_PROMPT_MAX_LEN} chars; scanned against the Veo "
            "ban-list (named real-person likeness, deepfakes, competitor "
            "logos) BEFORE the Vertex round-trip."
        ),
    )
    duration_seconds: int = Field(
        ge=4,
        le=30,
        description=(
            "Sample video duration. Veo 3 single-clip cap is 8s; values "
            "9-30 imply multi-clip splitting downstream (handled by the "
            "workflow, not this tool)."
        ),
    )
    aspect_ratio: AspectRatio = Field(
        description="Output aspect ratio (one of the 4 Veo-supported values).",
    )
    fps: VeoFps = Field(
        description="Frame rate (24 cinematic / 30 social-platform default).",
    )

    @field_validator("prompt")
    @classmethod
    def _validate_prompt(cls, v: str) -> str:
        """Strip + reject empty + scan against the Veo ban-list."""
        stripped = v.strip()
        if not stripped:
            raise ValueError("prompt must be non-empty after strip")
        for pattern in _VEO_BANNED_PATTERNS:
            m = pattern.search(stripped)
            if m:
                raise ValueError(
                    f"prompt trips veo ban-list (pattern matched: {m.group(0)!r}); "
                    "see creative.spec.md §8 for the policy details"
                )
        return stripped


class VeoGenerateOutput(BaseModel):
    """Output schema for `veo_generate`."""

    model_config = ConfigDict(extra="forbid")

    gcs_uri: str = Field(
        pattern=r"^gs://",
        description="Cloud Storage URI of the generated video (gs://...).",
    )
    sha256: str = Field(
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-f]{64}$",
        description="SHA-256 hex digest (of bytes; of canonical URI in stub).",
    )
    duration_s: float = Field(
        gt=0.0,
        le=30.0,
        description="Actual duration of the produced clip in seconds.",
    )
    fps: int = Field(
        ge=1,
        le=120,
        description="Frame rate of the produced clip.",
    )
    resolution: str = Field(
        pattern=r"^\d+x\d+$",
        description="Output resolution as 'WxH' (e.g. '1280x720').",
    )
    watermark_present: bool = Field(
        description=(
            "True iff Veo 3's SynthID watermark is present. Veo 3 GA does not "
            "expose an opt-out, so this is True for any live-mode output; the "
            "stub mirrors that behaviour for downstream code paths."
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
# The capability function — what `creative.tools=[…]` receives.
# ─────────────────────────────────────────────────────────────────────────────


# Veo 3 per-clip cost (median 2026 H1 list — 8s @ 720p ≈ $1.00).
# Surfaced as an attribute (not multiplied by duration here) so
# `cost_watch` (D42) can apply per-second scaling at call time.
_CAPABILITY_COST_USD: Final[float] = 1.00


def veo_generate(input: VeoGenerateInput) -> VeoGenerateOutput:
    """Generate one short sample video via Veo 3.

    Args:
        input: VeoGenerateInput — prompt + duration + aspect + fps.

    Returns:
        VeoGenerateOutput — gcs_uri + sha256 + duration + fps + resolution
        + watermark presence flag.

    Behaviour by mode (CAPABILITY_LAYER_MODE env, D41):
        * ``"stub"`` (default) — returns
            `gs://ss-creative-stub/vid_<duration>.mp4` where <duration>
          is the integer second value of `duration_seconds`. The sha256
          is SHA-256(URI) so the output is byte-stable across invocations.
          `watermark_present` is always True (matches Veo 3 GA default).
        * ``"live"`` — raises ``NotImplementedError`` until Phase 4 wires
          the Veo 3 client.

    Example:
        >>> out = veo_generate(VeoGenerateInput(
        ...     prompt="A serene morning skincare flat-lay, soft daylight",
        ...     duration_seconds=8,
        ...     aspect_ratio="9:16",
        ...     fps=30,
        ... ))
        >>> out.gcs_uri
        'gs://ss-creative-stub/vid_8.mp4'
        >>> out.watermark_present
        True
    """
    mode = _capability_mode()
    if mode == "live":
        raise NotImplementedError(
            "veo_generate live mode not yet implemented. Phase 4 will wire "
            "vertexai.preview.generative_models.GenerativeModel('veo-3.0') "
            "(or the dedicated Veo SDK once GA) with the prompt + duration "
            "+ aspect + fps. Until then run with CAPABILITY_LAYER_MODE=stub "
            "(the default)."
        )

    duration_s = float(input.duration_seconds)
    gcs_uri = f"gs://ss-creative-stub/vid_{input.duration_seconds}.mp4"
    sha256 = hashlib.sha256(gcs_uri.encode("utf-8")).hexdigest()
    resolution = _ASPECT_RESOLUTIONS[input.aspect_ratio]

    logger.debug(
        "veo_generate_stub_invoked",
        extra={
            "prompt_prefix": input.prompt[:48],
            "duration_seconds": input.duration_seconds,
            "aspect_ratio": input.aspect_ratio,
            "fps": input.fps,
        },
    )

    return VeoGenerateOutput(
        gcs_uri=gcs_uri,
        sha256=sha256,
        duration_s=duration_s,
        fps=int(input.fps),
        resolution=resolution,
        watermark_present=True,  # SynthID — Veo 3 GA default, non-opt-out.
    )


# Per-tool USD cost surfaced as an attribute (D41 mandate).
veo_generate.__capability_cost_usd__ = _CAPABILITY_COST_USD  # type: ignore[attr-defined]


__all__ = [
    "AspectRatio",
    "VeoFps",
    "VeoGenerateInput",
    "VeoGenerateOutput",
    "veo_generate",
]
