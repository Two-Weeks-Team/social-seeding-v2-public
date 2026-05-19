"""Tests for stt.transcribe — the W2-B5 capability-layer tool.

Coverage matrix:
    1. Stub determinism — same input ⇒ byte-identical output across calls.
    2. 4-locale parametrize — ko / en / ja / zh-CN each yield distinct
       3-word transcripts (D34).
    3. Speaker-diarization wiring — labels appear when enabled, absent
       otherwise; max_speakers bound respected.
    4. Pydantic validation — gs:// only URIs; max_speakers requires
       diarization; locale must be in D34.
    5. Live mode raises NotImplementedError when CAPABILITY_LAYER_MODE=live.
    6. Per-tool cost attribute published (D41 — cost_watch reads this).
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.stt_transcribe import (
    SttTranscribeInput,
    SttTranscribeOutput,
    TranscribedWord,
    stt_transcribe,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_returns_canonical_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stub MUST return exactly 3 words for every valid input."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = SttTranscribeInput(
        audio_gcs_uri="gs://ss-v2-media/demo/clip.wav",
        source_locale="en",
    )
    out = stt_transcribe(payload)
    assert isinstance(out, SttTranscribeOutput)
    assert len(out.words) == 3
    assert out.transcript == "hello world now"
    assert out.detected_locale == "en"
    assert out.duration_s == 1.2
    # No diarization → no speaker labels.
    assert all(w.speaker is None for w in out.words)


def test_stub_determinism_across_invocations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Repeated calls with the same input must serialise to identical JSON."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = SttTranscribeInput(
        audio_gcs_uri="gs://x/y.wav",
        source_locale="ja",
    )
    json_outputs = {stt_transcribe(payload).model_dump_json() for _ in range(5)}
    assert len(json_outputs) == 1


def test_stub_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """When CAPABILITY_LAYER_MODE is unset, default is "stub"."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = stt_transcribe(
        SttTranscribeInput(audio_gcs_uri="gs://x/y.wav", source_locale="en")
    )
    assert len(out.words) == 3


# ─────────────────────────────────────────────────────────────────────────────
# 2. 4-locale parametrize.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("locale", "first_word"),
    [
        ("ko", "안녕하세요"),
        ("en", "hello"),
        ("ja", "こんにちは"),
        ("zh-CN", "你好"),
    ],
)
def test_locale_produces_distinct_transcript(
    locale: str, first_word: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each D34 locale produces a locale-specific 3-word transcript."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = stt_transcribe(
        SttTranscribeInput(
            audio_gcs_uri="gs://x/y.wav",
            source_locale=locale,  # type: ignore[arg-type]
        )
    )
    assert out.words[0].text == first_word
    assert out.detected_locale == locale


def test_all_four_locales_distinct(monkeypatch: pytest.MonkeyPatch) -> None:
    """The four locales must produce four distinct transcripts."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    transcripts = {
        loc: stt_transcribe(
            SttTranscribeInput(
                audio_gcs_uri="gs://x/y.wav",
                source_locale=loc,  # type: ignore[arg-type]
            )
        ).transcript
        for loc in ("ko", "en", "ja", "zh-CN")
    }
    assert len(set(transcripts.values())) == 4


@pytest.mark.parametrize("bad_locale", ["fr", "de", "es", "EN", "", "zh"])
def test_invalid_locale_rejected(bad_locale: str) -> None:
    """Locales outside D34 fail Pydantic validation."""
    with pytest.raises(ValidationError):
        SttTranscribeInput(
            audio_gcs_uri="gs://x/y.wav",
            source_locale=bad_locale,  # type: ignore[arg-type]
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Speaker diarization wiring.
# ─────────────────────────────────────────────────────────────────────────────


def test_diarization_labels_words(monkeypatch: pytest.MonkeyPatch) -> None:
    """When diarization is on, every word carries an S{n} speaker label."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = stt_transcribe(
        SttTranscribeInput(
            audio_gcs_uri="gs://x/y.wav",
            source_locale="en",
            enable_speaker_diarization=True,
            max_speakers=2,
        )
    )
    labels = [w.speaker for w in out.words]
    assert all(label is not None for label in labels)
    # 3 words cycling through 2 speakers → S1, S2, S1.
    assert labels == ["S1", "S2", "S1"]


def test_diarization_off_no_labels(monkeypatch: pytest.MonkeyPatch) -> None:
    """When diarization is off, every word's speaker is None."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = stt_transcribe(
        SttTranscribeInput(
            audio_gcs_uri="gs://x/y.wav",
            source_locale="ko",
            enable_speaker_diarization=False,
        )
    )
    assert all(w.speaker is None for w in out.words)


def test_max_speakers_without_diarization_rejected() -> None:
    """`max_speakers` is meaningless when diarization is off — rejected."""
    with pytest.raises(ValidationError):
        SttTranscribeInput(
            audio_gcs_uri="gs://x/y.wav",
            source_locale="en",
            enable_speaker_diarization=False,
            max_speakers=3,
        )


@pytest.mark.parametrize("bad_n", [0, 7, 100, -1])
def test_max_speakers_out_of_band_rejected(bad_n: int) -> None:
    """max_speakers outside [1, 6] rejected."""
    with pytest.raises(ValidationError):
        SttTranscribeInput(
            audio_gcs_uri="gs://x/y.wav",
            source_locale="en",
            enable_speaker_diarization=True,
            max_speakers=bad_n,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Pydantic validation.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad_url",
    [
        "https://cdn.example.com/clip.wav",
        "http://insecure.example.com/clip.wav",
        "ftp://files.example.com/clip.wav",
        "clip.wav",
        "",
    ],
)
def test_input_rejects_non_gs_url(bad_url: str) -> None:
    """audio_gcs_uri must start with gs:// (D22 — STT only reads GCS)."""
    with pytest.raises(ValidationError):
        SttTranscribeInput(
            audio_gcs_uri=bad_url,
            source_locale="en",
        )


def test_input_forbids_extra_fields() -> None:
    """Extra fields rejected."""
    with pytest.raises(ValidationError):
        SttTranscribeInput.model_validate(
            {
                "audio_gcs_uri": "gs://x/y.wav",
                "source_locale": "en",
                "rogue": "drop",
            }
        )


def test_transcribed_word_start_le_end() -> None:
    """TranscribedWord enforces start_s ≤ end_s."""
    with pytest.raises(ValidationError):
        TranscribedWord(text="x", start_s=5.0, end_s=2.0)


def test_output_words_monotonic(monkeypatch: pytest.MonkeyPatch) -> None:
    """Output words must be monotonically non-decreasing."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = stt_transcribe(
        SttTranscribeInput(audio_gcs_uri="gs://x/y.wav", source_locale="en")
    )
    starts = [w.start_s for w in out.words]
    assert starts == sorted(starts)


# ─────────────────────────────────────────────────────────────────────────────
# 5. Live mode.
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    """Until Phase 4 wires real STT, live mode MUST raise."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    payload = SttTranscribeInput(
        audio_gcs_uri="gs://x/y.wav",
        source_locale="en",
    )
    with pytest.raises(NotImplementedError) as exc:
        stt_transcribe(payload)
    assert "Phase 4" in str(exc.value) or "live mode" in str(exc.value).lower()


# ─────────────────────────────────────────────────────────────────────────────
# 6. Cost attribute.
# ─────────────────────────────────────────────────────────────────────────────


def test_capability_cost_attribute_published() -> None:
    """D41: per-tool USD cost surfaced as a function attribute."""
    cost = getattr(stt_transcribe, "__capability_cost_usd__", None)
    assert cost is not None
    assert isinstance(cost, float)
    assert 0 < cost < 0.05
