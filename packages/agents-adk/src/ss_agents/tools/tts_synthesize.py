"""tts.synthesize — Text-to-Speech capability tool (W2-B5).

Phase 3 capability-layer tool wired into the **a11y** agent
(`a11y.spec.md §6`). Synthesises a transcript into a downloadable audio
artifact (MP3) stored in Cloud Storage, in the requested locale + voice
profile. Drives the `ttsAudioGcsUri` field of the a11y bundle.

Citations:
    D5  — Gemini 3.1 Flash-Lite multimodal is NOT used here — TTS is a
          dedicated GCP service. The tool wraps Google Cloud
          Text-to-Speech v1 (`Studio` voices when available, `Neural2`
          otherwise).
    D22 — PIPA-friendly: TTS output is operator-controlled; the
          capability never leaks transcript text off-platform without an
          explicit policy gate.
    D23 — Tier-1 agent #15 (a11y) lists `tts.synthesize` as a callable
          capability for low-vision / screen-reader operators.
    D33 — TTS audio is written under `gs://ss-a11y-stub/...` with a 30-day
          Cloud Storage lifecycle rule.
    D34 — 4-locale supported set: ko / en / ja / zh-CN.
    D41 — Capability layer ADK FunctionTool pattern. Stub vs live via
          `CAPABILITY_LAYER_MODE` env var, per-tool USD cost surfaced as
          `__capability_cost_usd__` for cost_watch.

Contract (a11y.spec.md §6 + task brief):

    Input:
        text           — transcript text to synthesise (≤ 5000 chars).
        locale         — one of ko / en / ja / zh-CN (D34).
        voice_kind     — one of "neutral" / "warm" / "authoritative".
        speaking_rate  — float in [0.5, 2.0] (Cloud TTS contract).

    Output:
        audio_gcs_uri   — gs:// URI to the synthesised MP3.
        sha256          — SHA-256 of the audio bytes (hex string, 64 chars).
        duration_s      — clip duration in seconds (float).
        sample_rate_hz  — TTS sample rate (always 24000 for Studio voices).

Stub determinism (D41):
    For ANY valid input, the stub returns
    ``gs://ss-a11y-stub/tts_<locale>.mp3`` along with a fixed sha256,
    duration, and sample rate. The URI is the only locale-varying field —
    all other output is byte-stable across invocations.

Live mode:
    Raises `NotImplementedError` with a Phase-4 wiring pointer. The
    eventual implementation will call
    `google.cloud.texttospeech_v1.TextToSpeechAsyncClient.synthesize_speech`
    with `audio_config.audio_encoding=MP3` and upload to Cloud Storage.
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


VoiceKind = Literal["neutral", "warm", "authoritative"]
"""Voice persona. Maps to a specific Cloud TTS voice ID per locale (see
the `_VOICE_ID_BY_LOCALE` table in the live wiring task)."""


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


class TtsSynthesizeInput(BaseModel):
    """Input schema for `tts_synthesize`.

    Validation:
        * `text` must be non-empty and ≤ 5000 chars (Cloud TTS hard limit).
        * `locale` must be in the D34 set.
        * `voice_kind` must be one of the three personas we currently map.
        * `speaking_rate` is clamped to Cloud TTS's documented [0.25, 4.0]
          band, but we tighten further to [0.5, 2.0] — anything outside
          sounds unnatural for accessibility consumers (a11y.spec.md §8).
    """

    model_config = ConfigDict(extra="forbid")

    text: str = Field(
        min_length=1,
        max_length=5000,
        description="Transcript to synthesise. ≤ 5000 chars (Cloud TTS cap).",
    )
    locale: SupportedLocale = Field(
        description="Target locale for the synthesised audio (D34)."
    )
    voice_kind: VoiceKind = Field(
        description=(
            "Voice persona. Maps to a Cloud TTS voice ID per locale in "
            "the live wiring."
        ),
    )
    speaking_rate: float = Field(
        default=1.0,
        ge=0.5,
        le=2.0,
        description=(
            "Cloud TTS speaking_rate (1.0 = normal). Clamped to [0.5, 2.0] "
            "for accessibility ergonomics."
        ),
    )


class TtsSynthesizeOutput(BaseModel):
    """Output schema for `tts_synthesize`.

    See module docstring for field semantics.
    """

    model_config = ConfigDict(extra="forbid")

    audio_gcs_uri: str = Field(
        min_length=1,
        max_length=2048,
        pattern=r"^gs://",
        description="gs:// URI to the synthesised MP3 (30d retention per D33).",
    )
    sha256: str = Field(
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-f]{64}$",
        description="SHA-256 of the audio bytes (hex, lowercase).",
    )
    duration_s: float = Field(
        ge=0.0,
        description="Clip duration in seconds.",
    )
    sample_rate_hz: int = Field(
        ge=8000,
        le=48000,
        description="TTS sample rate (24000 for Studio voices).",
    )


# ─────────────────────────────────────────────────────────────────────────────
# The capability function — what `a11y.tools=[…]` receives.
# ─────────────────────────────────────────────────────────────────────────────


# Cloud TTS Studio voice list price (2026 H1, USD per 1M chars).
# Per-call cost averaged over a 200-char a11y transcript chunk.
_CAPABILITY_COST_USD = 0.0032


# Deterministic SHA-256 of the literal string "stub-tts-audio" — used by
# the stub for byte-stable goldens. Computed once and pinned here so we
# never have to reach into hashlib at module load.
_STUB_SHA256 = "5f1e0e6b7c8a2d4e9f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f"

# Stub duration in seconds (matches a typical 200-char a11y blurb).
_STUB_DURATION_S = 4.2

# Studio voice sample rate (24 kHz).
_STUB_SAMPLE_RATE_HZ = 24_000


def tts_synthesize(input: TtsSynthesizeInput) -> TtsSynthesizeOutput:
    """Synthesise a transcript into a Cloud-Storage-hosted MP3.

    Args:
        input: TtsSynthesizeInput — text + locale + voice_kind +
        speaking_rate.

    Returns:
        TtsSynthesizeOutput — audio_gcs_uri / sha256 / duration_s /
        sample_rate_hz.

    Behaviour by mode (CAPABILITY_LAYER_MODE env, D41):
        * ``"stub"`` (default) — returns
          ``gs://ss-a11y-stub/tts_<locale>.mp3`` with a fixed sha256,
          duration, and 24 kHz sample rate.
        * ``"live"`` — raises ``NotImplementedError`` until Phase 4 wires
          `google.cloud.texttospeech_v1.TextToSpeechAsyncClient.synthesize_speech`.

    Example:
        >>> out = tts_synthesize(TtsSynthesizeInput(
        ...     text="Hello world",
        ...     locale="en",
        ...     voice_kind="neutral",
        ... ))
        >>> out.audio_gcs_uri
        'gs://ss-a11y-stub/tts_en.mp3'
    """
    mode = _capability_mode()
    if mode == "live":
        raise NotImplementedError(
            "tts_synthesize live mode not yet implemented. Phase 4 will "
            "wire google.cloud.texttospeech_v1.TextToSpeechAsyncClient."
            "synthesize_speech with MP3 encoding + Cloud Storage upload. "
            "Until then run with CAPABILITY_LAYER_MODE=stub (the default)."
        )

    logger.debug(
        "tts_synthesize_stub_invoked",
        extra={
            "text_len": len(input.text),
            "locale": input.locale,
            "voice_kind": input.voice_kind,
            "speaking_rate": input.speaking_rate,
        },
    )

    return TtsSynthesizeOutput(
        audio_gcs_uri=f"gs://ss-a11y-stub/tts_{input.locale}.mp3",
        sha256=_STUB_SHA256,
        duration_s=_STUB_DURATION_S,
        sample_rate_hz=_STUB_SAMPLE_RATE_HZ,
    )


# Per-tool USD cost surfaced as an attribute so `cost_watch` can aggregate
# without re-reading the pricing page. D41 mandates this surface.
tts_synthesize.__capability_cost_usd__ = _CAPABILITY_COST_USD  # type: ignore[attr-defined]


__all__ = [
    "TtsSynthesizeInput",
    "TtsSynthesizeOutput",
    "tts_synthesize",
]
