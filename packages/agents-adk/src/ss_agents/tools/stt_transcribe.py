"""stt.transcribe — Speech-to-Text capability tool (W2-B5).

Phase 3 capability-layer tool wired into the **a11y** agent
(`a11y.spec.md §6`). Returns word-level timestamps + an optional speaker
diarization stream for an audio asset stored in Cloud Storage. Drives the
transcript + captionCues halves of the a11y bundle.

Citations:
    D5  — Gemini 2.5 Flash (multimodal: text + audio) OR Google Cloud
          Speech-to-Text v2 with `latest_long` recogniser — the live
          implementation picks whichever has lower WER on the test
          golden set (a11y.spec.md §7 caption_wer ≤ 0.10).
    D22 — PIPA-friendly: audio transcripts are operator-bounded; the
          capability never sends transcripts off-platform without an
          explicit policy gate.
    D23 — Tier-1 agent #15 (a11y) lists `stt.transcribe` as a callable
          capability for video/audio assets.
    D33 — Audio media stored 30d in Cloud Storage with lifecycle rule.
    D34 — 4-locale supported set: ko / en / ja / zh-CN. `source_locale`
          must be in this set.
    D41 — Capability layer ADK FunctionTool pattern. Stub vs live via
          `CAPABILITY_LAYER_MODE` env var, per-tool USD cost surfaced as
          `__capability_cost_usd__` for cost_watch.

Contract (a11y.spec.md §6 + task brief):

    Input:
        audio_gcs_uri              — gs:// URI to the audio asset.
        source_locale              — one of ko / en / ja / zh-CN (D34).
        enable_speaker_diarization — bool flag (default False).
        max_speakers               — optional int in [1, 6] for diarization.

    Output:
        transcript       — full text (joined from words).
        words            — list of {text, start_s, end_s, speaker?}.
        detected_locale  — locale STT detected from the audio (string).
        duration_s       — clip duration in seconds (float).

Stub determinism (D41):
    The stub returns the exact same 3-word transcript (one canned phrase
    per locale) every call. Three words is enough to exercise the word
    schema + speaker labels + monotonic timestamps; tests pin the JSON
    output for byte stability.

Live mode:
    Raises `NotImplementedError` with a Phase-4 wiring pointer. The
    eventual implementation will call
    `google.cloud.speech_v2.SpeechAsyncClient.batch_recognize` with the
    `latest_long` recogniser and diarization on when requested.
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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


class SttTranscribeInput(BaseModel):
    """Input schema for `stt_transcribe`.

    Validation:
        * `audio_gcs_uri` must start with `gs://` — STT only reads from
          Cloud Storage (D22 + cost: pulling from a public CDN forces a
          download-then-reupload round trip we explicitly want to avoid).
        * `source_locale` must be in the D34 set.
        * `max_speakers` only meaningful when `enable_speaker_diarization`
          is True; we enforce that via `model_validator`.
    """

    model_config = ConfigDict(extra="forbid")

    audio_gcs_uri: str = Field(
        min_length=1,
        max_length=2048,
        description=(
            "gs:// URI to the audio asset. Lifecycle: Cloud Storage 30d "
            "retention per D33."
        ),
    )
    source_locale: SupportedLocale = Field(
        description="Declared source locale of the audio (D34)."
    )
    enable_speaker_diarization: bool = Field(
        default=False,
        description=(
            "When True, the STT result includes a `speaker` label per word."
        ),
    )
    max_speakers: int | None = Field(
        default=None,
        ge=1,
        le=6,
        description=(
            "Upper bound on speaker count. Only consulted when "
            "`enable_speaker_diarization=True`. STT clamps internally too."
        ),
    )

    @field_validator("audio_gcs_uri")
    @classmethod
    def _validate_uri(cls, v: str) -> str:
        """Accept gs:// only (D22 — STT batch reads from Cloud Storage)."""
        v = v.strip()
        if not v:
            raise ValueError("audio_gcs_uri must be a non-empty URI")
        if not v.startswith("gs://"):
            raise ValueError(
                "audio_gcs_uri must start with gs:// "
                f"(got scheme in {v[:32]!r})"
            )
        return v

    @model_validator(mode="after")
    def _max_speakers_only_with_diarization(self) -> "SttTranscribeInput":
        if self.max_speakers is not None and not self.enable_speaker_diarization:
            raise ValueError(
                "max_speakers is only meaningful when "
                "enable_speaker_diarization=True"
            )
        return self


class TranscribedWord(BaseModel):
    """One word + its timing + optional speaker label.

    Same shape as Google Cloud STT v2's `WordInfo` minus the `confidence`
    field (we surface the aggregate confidence via the parent output).
    """

    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=200)
    start_s: float = Field(ge=0.0, description="Word start (seconds).")
    end_s: float = Field(ge=0.0, description="Word end (seconds).")
    speaker: str | None = Field(
        default=None,
        max_length=80,
        description="Speaker label when diarization is on; None otherwise.",
    )

    @model_validator(mode="after")
    def _start_before_end(self) -> "TranscribedWord":
        if self.start_s > self.end_s:
            raise ValueError(
                f"start_s ({self.start_s}) must be ≤ end_s ({self.end_s})"
            )
        return self


class SttTranscribeOutput(BaseModel):
    """Output schema for `stt_transcribe`.

    See module docstring for field semantics.
    """

    model_config = ConfigDict(extra="forbid")

    transcript: str = Field(
        min_length=0,
        max_length=20_000,
        description="Full transcript text, joined from `words`.",
    )
    words: list[TranscribedWord] = Field(
        default_factory=list,
        max_length=5000,
        description="Word-level timestamps + optional speaker labels.",
    )
    detected_locale: SupportedLocale = Field(
        description="Locale STT detected from the audio."
    )
    duration_s: float = Field(
        ge=0.0,
        description="Clip duration in seconds (float).",
    )

    @model_validator(mode="after")
    def _monotonic_words(self) -> "SttTranscribeOutput":
        """Word timestamps must be monotonically non-decreasing."""
        prev_start = -1.0
        for w in self.words:
            if w.start_s < prev_start:
                raise ValueError(
                    "word start_s must be monotonically non-decreasing "
                    f"(got {w.start_s} after {prev_start})"
                )
            prev_start = w.start_s
        return self


# ─────────────────────────────────────────────────────────────────────────────
# The capability function — what `a11y.tools=[…]` receives.
# ─────────────────────────────────────────────────────────────────────────────


# Google Cloud Speech-to-Text v2 batch price for `latest_long` model
# (2026 H1 list, USD per 15s chunk). Approximates a 10-second clip cost.
_CAPABILITY_COST_USD = 0.004


# Deterministic per-locale 3-word transcript. The same phrase ("hello world
# now"-equivalent) per locale so the stub exercises punctuation + word
# boundaries in each language.
_STUB_WORDS_BY_LOCALE: dict[str, list[tuple[str, float, float]]] = {
    "ko": [
        ("안녕하세요", 0.0, 0.4),
        ("세상", 0.4, 0.8),
        ("지금", 0.8, 1.2),
    ],
    "en": [
        ("hello", 0.0, 0.4),
        ("world", 0.4, 0.8),
        ("now", 0.8, 1.2),
    ],
    "ja": [
        ("こんにちは", 0.0, 0.4),
        ("世界", 0.4, 0.8),
        ("今", 0.8, 1.2),
    ],
    "zh-CN": [
        ("你好", 0.0, 0.4),
        ("世界", 0.4, 0.8),
        ("现在", 0.8, 1.2),
    ],
}


def stt_transcribe(input: SttTranscribeInput) -> SttTranscribeOutput:
    """Transcribe an audio asset with word-level timestamps.

    Args:
        input: SttTranscribeInput — gs:// URI + source_locale + diarization.

    Returns:
        SttTranscribeOutput — transcript / words / detected_locale /
        duration_s.

    Behaviour by mode (CAPABILITY_LAYER_MODE env, D41):
        * ``"stub"`` (default) — returns a 3-word deterministic transcript
          in the requested source_locale. When `enable_speaker_diarization`
          is True, each word gets a `speaker` label cycling S1/S2 up to
          `max_speakers`.
        * ``"live"`` — raises ``NotImplementedError`` until Phase 4 wires
          `google.cloud.speech_v2.SpeechAsyncClient.batch_recognize` with
          the `latest_long` recogniser.

    Example:
        >>> out = stt_transcribe(SttTranscribeInput(
        ...     audio_gcs_uri="gs://ss-v2-media/demo/clip.wav",
        ...     source_locale="en",
        ... ))
        >>> out.transcript
        'hello world now'
        >>> len(out.words)
        3
    """
    mode = _capability_mode()
    if mode == "live":
        raise NotImplementedError(
            "stt_transcribe live mode not yet implemented. Phase 4 will "
            "wire google.cloud.speech_v2.SpeechAsyncClient.batch_recognize "
            "with the latest_long recogniser. Until then run with "
            "CAPABILITY_LAYER_MODE=stub (the default)."
        )

    logger.debug(
        "stt_transcribe_stub_invoked",
        extra={
            "uri_prefix": input.audio_gcs_uri[:48],
            "source_locale": input.source_locale,
            "diarization": input.enable_speaker_diarization,
        },
    )

    raw_words = _STUB_WORDS_BY_LOCALE[input.source_locale]
    max_spk = input.max_speakers if input.max_speakers is not None else 2

    words: list[TranscribedWord] = []
    for i, (text, start, end) in enumerate(raw_words):
        speaker: str | None
        if input.enable_speaker_diarization:
            # Cycle S1, S2, …, up to max_spk; wrap on overflow.
            speaker = f"S{(i % max_spk) + 1}"
        else:
            speaker = None
        words.append(
            TranscribedWord(text=text, start_s=start, end_s=end, speaker=speaker)
        )

    # Joined transcript — CJK locales have no spaces, but joining on " "
    # matches Cloud STT's canonical output (space-separated tokens) so the
    # downstream caller renders consistently across locales.
    transcript = " ".join(w.text for w in words)
    duration_s = words[-1].end_s if words else 0.0

    return SttTranscribeOutput(
        transcript=transcript,
        words=words,
        detected_locale=input.source_locale,
        duration_s=duration_s,
    )


# Per-tool USD cost surfaced as an attribute so `cost_watch` can aggregate
# without re-reading the pricing page. D41 mandates this surface.
stt_transcribe.__capability_cost_usd__ = _CAPABILITY_COST_USD  # type: ignore[attr-defined]


__all__ = [
    "SttTranscribeInput",
    "SttTranscribeOutput",
    "TranscribedWord",
    "stt_transcribe",
]
