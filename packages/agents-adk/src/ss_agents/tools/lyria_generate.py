"""lyria.generate — Lyria audio-sting / BGM capability tool.

Phase 4 capability-layer tool wired into the **creative** agent
(`creative.spec.md §6`). Generates one short audio sting / BGM track
(4-60 sec) from a text prompt + duration + optional genre hint, returning
a GCS URI + SHA-256 digest + sample rate.

Citations:
    D5  — Gemini 3.1 family multimodal baseline. Lyria ships on Vertex AI
          alongside the Gemini family.
    D13 — Multi-region active-active. Lyria endpoints exist in a subset
          of regions at 2026 H1; live wiring will route per tenant region.
    D23 — Tier-1 agent #14 (creative, NEW) lists `lyria.generate` as one
          of four callable capabilities.
    D29 — Multimodal + AP2 + Multi-agent — Lyria contributes the audio
          channel to the headline multimodal demo.
    D33 — Generated audio lands in Cloud Storage with a 30-day lifecycle
          rule. Stub URI `gs://ss-creative-stub/audio_<duration>.mp3`
          mirrors live `gs://ss-v2-creative/{ws}/{trace}/audio_*.mp3`.
    D39 — $1,500 credits unlock Lyria for the demo (~$0.10 per 8s sting).
    D41 — Capability layer ADK FunctionTool pattern. Canonical W2-A1 form;
          stub returns deterministic canned data, live raises
          NotImplementedError.

Contract (creative.spec.md §6 + task brief):

    Input:
        prompt              — text prompt; describes genre + tempo + mood.
        duration_seconds    — 4-60.
        genre_hint          — optional short genre descriptor (e.g.
                              "lo-fi", "ambient electronic").
        instrumental_only   — bool; True forbids any vocal synthesis.

    Output:
        gcs_uri          — `gs://...mp3`.
        sha256           — SHA-256 hex digest (bytes; URI in stub).
        duration_s       — actual produced duration (float).
        sample_rate_hz   — output sample rate (44_100 default per Lyria GA).

Stub determinism (D41):
    For any valid input, the stub returns
        gcs_uri = `gs://ss-creative-stub/audio_<duration>.mp3`
    where `<duration>` is the integer second value of `duration_seconds`.
    sha256 = SHA-256(URI), byte-stable across invocations. sample_rate_hz
    is fixed at 44_100 (Lyria GA default).

Prompt-injection guard:
    The prompt field has a hard length cap (600 chars per creative.spec.md
    §6 — "lyria_music_prompt: ≤ 600 chars") and is scanned against the
    Lyria copyright filter: named-artist style transfer, "cover of X",
    "sample of Y", etc. This mirrors the `lyria_prompt_blocked` helper
    in `agents/creative.py` (where the agent-level CreativeOutput
    invariant lives) — we re-implement here at the capability layer so
    the agent can NEVER bypass it by calling the tool with a prompt the
    output validator wouldn't accept.

Live mode:
    Raises `NotImplementedError` with a pointer to the Phase 4 wiring task.
    The eventual implementation will call the Vertex AI Lyria endpoint
    (path: `projects/{p}/locations/{r}/publishers/google/models/lyria-002:
    generateAudio`) with the prompt + duration, then upload to
    `gs://ss-v2-creative/{workspace_id}/{trace_id}/audio_N.mp3` per D33.
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
            extra={"raw": raw, "fallback": "stub", "tool": "lyria_generate"},
        )
        return "stub"
    return raw  # type: ignore[return-value]


# ─────────────────────────────────────────────────────────────────────────────
# Constants — prompt cap + ban-list (Lyria copyright filter mirror).
# ─────────────────────────────────────────────────────────────────────────────


_PROMPT_MAX_LEN: Final[int] = 600
"""Hard cap on prompt length. Matches creative.spec.md / agents/creative.py
constraint on `lyria_music_prompt` (≤ 600 chars)."""


# Lyria copyright-filter ban-list. Mirrors the regex on
# `ss_agents.agents.creative._LYRIA_BLOCKED_RE` so the tool rejects the
# same patterns the agent-level output validator would reject — defence
# in depth. Per Vertex AI safety docs ("Lyria content filter scope",
# 2026 Q1):
#   · Named artists (style transfer of named living/recent artists is
#     IP/copyright unsafe).
#   · "in the style of <Proper Noun>" patterns.
#   · Explicit "cover of <song>" / "sample of <album>" requests.
_LYRIA_BANNED_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(
        r"""(
            \bin\s+the\s+style\s+of\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?
            | \bcover\s+of\s+["“][^"”]+["”]
            | \bsample(?:s|d|ing)?\s+(?:of|from)\s+[A-Z][a-z]+
            | \b(?:Taylor\s+Swift|Beyonc[eé]|Drake|BTS|Blackpink|IU)\b
        )""",
        re.IGNORECASE | re.VERBOSE,
    ),
)


_DEFAULT_SAMPLE_RATE_HZ: Final[int] = 44_100
"""Lyria GA default output sample rate (44.1 kHz / 16-bit MP3)."""


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic I/O schemas — the canonical D41 contract surface.
# ─────────────────────────────────────────────────────────────────────────────


class LyriaGenerateInput(BaseModel):
    """Input schema for `lyria_generate`.

    Validation:
        * `prompt` non-empty after strip + ≤ 600 chars + scanned against
          the Lyria copyright-filter ban-list (mirror of the agent-level
          `lyria_prompt_blocked` check).
        * `duration_seconds` 4-60.
        * `genre_hint` optional, 0-200 chars.
        * `instrumental_only` bool.
    """

    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(
        min_length=1,
        max_length=_PROMPT_MAX_LEN,
        description=(
            "Text prompt — describes genre, tempo (BPM range OK), "
            "instrumentation, mood. NEVER name an artist (Lyria's filter "
            "blocks 'in the style of <Artist>'). Generic descriptors only."
        ),
    )
    duration_seconds: int = Field(
        ge=4,
        le=60,
        description="Audio duration in seconds (4-60).",
    )
    genre_hint: str | None = Field(
        default=None,
        max_length=200,
        description="Optional short genre descriptor (e.g. 'lo-fi', 'ambient electronic').",
    )
    instrumental_only: bool = Field(
        description=(
            "True forbids any vocal synthesis — recommended for ads where "
            "voice content is recorded separately."
        ),
    )

    @field_validator("prompt")
    @classmethod
    def _validate_prompt(cls, v: str) -> str:
        """Strip + reject empty + scan against the Lyria copyright filter."""
        stripped = v.strip()
        if not stripped:
            raise ValueError("prompt must be non-empty after strip")
        for pattern in _LYRIA_BANNED_PATTERNS:
            m = pattern.search(stripped)
            if m:
                raise ValueError(
                    f"prompt trips lyria copyright filter (matched: {m.group(0)!r}); "
                    "use generic descriptors (genre/tempo/mood) — no named artists, "
                    "no 'cover of'/'sample of' patterns"
                )
        return stripped

    @field_validator("genre_hint")
    @classmethod
    def _validate_genre_hint(cls, v: str | None) -> str | None:
        """Strip + normalise empty-after-strip to None."""
        if v is None:
            return None
        stripped = v.strip()
        return stripped if stripped else None


class LyriaGenerateOutput(BaseModel):
    """Output schema for `lyria_generate`."""

    model_config = ConfigDict(extra="forbid")

    gcs_uri: str = Field(
        pattern=r"^gs://",
        description="Cloud Storage URI of the generated audio (gs://...).",
    )
    sha256: str = Field(
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-f]{64}$",
        description="SHA-256 hex digest (of bytes; of canonical URI in stub).",
    )
    duration_s: float = Field(
        gt=0.0,
        le=60.0,
        description="Actual duration of the produced audio in seconds.",
    )
    sample_rate_hz: int = Field(
        ge=8_000,
        le=192_000,
        description="Output sample rate in Hz (Lyria GA default: 44_100).",
    )


# ─────────────────────────────────────────────────────────────────────────────
# The capability function — what `creative.tools=[…]` receives.
# ─────────────────────────────────────────────────────────────────────────────


# Lyria per-call cost (median 2026 H1 — ~$0.10 per 8s sting).
_CAPABILITY_COST_USD: Final[float] = 0.10


def lyria_generate(input: LyriaGenerateInput) -> LyriaGenerateOutput:
    """Generate one short audio sting / BGM via Lyria.

    Args:
        input: LyriaGenerateInput — prompt + duration + optional genre +
               instrumental flag.

    Returns:
        LyriaGenerateOutput — gcs_uri + sha256 + duration + sample rate.

    Behaviour by mode (CAPABILITY_LAYER_MODE env, D41):
        * ``"stub"`` (default) — returns
            `gs://ss-creative-stub/audio_<duration>.mp3` where <duration>
          is the integer second value of `duration_seconds`. sha256 =
          SHA-256(URI); sample_rate_hz = 44_100.
        * ``"live"`` — raises ``NotImplementedError`` until Phase 4 wires
          the Lyria endpoint.

    Example:
        >>> out = lyria_generate(LyriaGenerateInput(
        ...     prompt="Soft lo-fi morning beat, 80 bpm, gentle piano",
        ...     duration_seconds=8,
        ...     instrumental_only=True,
        ... ))
        >>> out.gcs_uri
        'gs://ss-creative-stub/audio_8.mp3'
        >>> out.sample_rate_hz
        44100
    """
    mode = _capability_mode()
    if mode == "live":
        raise NotImplementedError(
            "lyria_generate live mode not yet implemented. Phase 4 will wire "
            "the Vertex AI Lyria endpoint "
            "(publishers/google/models/lyria-002:generateAudio) with the "
            "prompt + duration. Until then run with CAPABILITY_LAYER_MODE=stub "
            "(the default)."
        )

    duration_s = float(input.duration_seconds)
    gcs_uri = f"gs://ss-creative-stub/audio_{input.duration_seconds}.mp3"
    sha256 = hashlib.sha256(gcs_uri.encode("utf-8")).hexdigest()

    logger.debug(
        "lyria_generate_stub_invoked",
        extra={
            "prompt_prefix": input.prompt[:48],
            "duration_seconds": input.duration_seconds,
            "genre_hint": input.genre_hint,
            "instrumental_only": input.instrumental_only,
        },
    )

    return LyriaGenerateOutput(
        gcs_uri=gcs_uri,
        sha256=sha256,
        duration_s=duration_s,
        sample_rate_hz=_DEFAULT_SAMPLE_RATE_HZ,
    )


# Per-tool USD cost surfaced as an attribute (D41 mandate).
lyria_generate.__capability_cost_usd__ = _CAPABILITY_COST_USD  # type: ignore[attr-defined]


__all__ = [
    "LyriaGenerateInput",
    "LyriaGenerateOutput",
    "lyria_generate",
]
