"""Tests for tts.synthesize — the W2-B5 capability-layer tool.

Coverage matrix:
    1. Stub determinism — same input ⇒ byte-identical output across calls.
    2. 4-locale parametrize — ko / en / ja / zh-CN each yield a locale-
       specific gs:// URI (per D34).
    3. voice_kind + speaking_rate validation.
    4. Pydantic validation — text length, gs:// URI shape on output.
    5. Live mode raises NotImplementedError when CAPABILITY_LAYER_MODE=live.
    6. Per-tool cost attribute is published (D41 — cost_watch reads this).
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.tts_synthesize import (
    TtsSynthesizeInput,
    TtsSynthesizeOutput,
    tts_synthesize,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_returns_canonical_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stub MUST return the exact canned payload for every valid input."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = TtsSynthesizeInput(
        text="Hello world",
        locale="en",
        voice_kind="neutral",
    )
    out = tts_synthesize(payload)
    assert isinstance(out, TtsSynthesizeOutput)
    assert out.audio_gcs_uri == "gs://ss-a11y-stub/tts_en.mp3"
    assert out.sample_rate_hz == 24_000
    assert out.duration_s == 4.2
    assert len(out.sha256) == 64


def test_stub_determinism_across_invocations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Repeated calls with the same input must serialise to identical JSON."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = TtsSynthesizeInput(
        text="Hello world",
        locale="en",
        voice_kind="warm",
        speaking_rate=1.1,
    )
    json_outputs = {tts_synthesize(payload).model_dump_json() for _ in range(5)}
    assert len(json_outputs) == 1


def test_stub_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """When CAPABILITY_LAYER_MODE is unset, default is "stub"."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = tts_synthesize(
        TtsSynthesizeInput(
            text="Hello world",
            locale="en",
            voice_kind="neutral",
        )
    )
    assert out.audio_gcs_uri.startswith("gs://ss-a11y-stub/")


# ─────────────────────────────────────────────────────────────────────────────
# 2. 4-locale parametrize.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("locale", "expected_uri"),
    [
        ("ko", "gs://ss-a11y-stub/tts_ko.mp3"),
        ("en", "gs://ss-a11y-stub/tts_en.mp3"),
        ("ja", "gs://ss-a11y-stub/tts_ja.mp3"),
        ("zh-CN", "gs://ss-a11y-stub/tts_zh-CN.mp3"),
    ],
)
def test_locale_produces_distinct_uri(
    locale: str, expected_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each D34 locale produces a locale-specific gs:// audio URI."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = tts_synthesize(
        TtsSynthesizeInput(
            text="hello",
            locale=locale,  # type: ignore[arg-type]
            voice_kind="neutral",
        )
    )
    assert out.audio_gcs_uri == expected_uri


def test_all_four_locales_distinct(monkeypatch: pytest.MonkeyPatch) -> None:
    """The four locales must produce four distinct audio URIs."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    uris = {
        loc: tts_synthesize(
            TtsSynthesizeInput(
                text="hello",
                locale=loc,  # type: ignore[arg-type]
                voice_kind="neutral",
            )
        ).audio_gcs_uri
        for loc in ("ko", "en", "ja", "zh-CN")
    }
    assert len(set(uris.values())) == 4


@pytest.mark.parametrize("bad_locale", ["fr", "de", "es", "EN", "", "zh"])
def test_invalid_locale_rejected(bad_locale: str) -> None:
    """Locales outside D34 fail Pydantic validation."""
    with pytest.raises(ValidationError):
        TtsSynthesizeInput(
            text="hello",
            locale=bad_locale,  # type: ignore[arg-type]
            voice_kind="neutral",
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. voice_kind + speaking_rate validation.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("voice_kind", ["neutral", "warm", "authoritative"])
def test_voice_kinds_accepted(voice_kind: str) -> None:
    """All three personas accepted."""
    payload = TtsSynthesizeInput(
        text="hello",
        locale="en",
        voice_kind=voice_kind,  # type: ignore[arg-type]
    )
    assert payload.voice_kind == voice_kind


@pytest.mark.parametrize("bad_voice", ["robot", "child", "", "Neutral"])
def test_invalid_voice_kind_rejected(bad_voice: str) -> None:
    """Voice kinds outside the persona enum rejected."""
    with pytest.raises(ValidationError):
        TtsSynthesizeInput(
            text="hello",
            locale="en",
            voice_kind=bad_voice,  # type: ignore[arg-type]
        )


@pytest.mark.parametrize("rate", [0.5, 0.75, 1.0, 1.5, 2.0])
def test_speaking_rate_in_band_accepted(rate: float) -> None:
    """speaking_rate in [0.5, 2.0] accepted."""
    payload = TtsSynthesizeInput(
        text="hello",
        locale="en",
        voice_kind="neutral",
        speaking_rate=rate,
    )
    assert payload.speaking_rate == rate


@pytest.mark.parametrize("bad_rate", [0.0, 0.49, 2.01, 5.0, -1.0])
def test_speaking_rate_out_of_band_rejected(bad_rate: float) -> None:
    """speaking_rate outside [0.5, 2.0] rejected."""
    with pytest.raises(ValidationError):
        TtsSynthesizeInput(
            text="hello",
            locale="en",
            voice_kind="neutral",
            speaking_rate=bad_rate,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Pydantic validation — text + URI shape.
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_empty_text() -> None:
    """text must be non-empty (min_length=1)."""
    with pytest.raises(ValidationError):
        TtsSynthesizeInput(
            text="",
            locale="en",
            voice_kind="neutral",
        )


def test_input_rejects_overlong_text() -> None:
    """text > 5000 chars rejected (Cloud TTS hard cap)."""
    with pytest.raises(ValidationError):
        TtsSynthesizeInput(
            text="x" * 5001,
            locale="en",
            voice_kind="neutral",
        )


def test_input_forbids_extra_fields() -> None:
    """Extra fields rejected."""
    with pytest.raises(ValidationError):
        TtsSynthesizeInput.model_validate(
            {
                "text": "hello",
                "locale": "en",
                "voice_kind": "neutral",
                "rogue": "drop",
            }
        )


def test_output_sha256_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    """sha256 must be 64 hex chars (lowercase)."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = tts_synthesize(
        TtsSynthesizeInput(text="x", locale="en", voice_kind="neutral")
    )
    assert len(out.sha256) == 64
    int(out.sha256, 16)  # parses as hex


def test_output_uri_is_gs_prefixed(monkeypatch: pytest.MonkeyPatch) -> None:
    """audio_gcs_uri MUST start with gs:// (D33)."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = tts_synthesize(
        TtsSynthesizeInput(text="x", locale="en", voice_kind="neutral")
    )
    assert out.audio_gcs_uri.startswith("gs://")


# ─────────────────────────────────────────────────────────────────────────────
# 5. Live mode.
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    """Until Phase 4 wires Cloud TTS, live mode MUST raise."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    payload = TtsSynthesizeInput(
        text="hello",
        locale="en",
        voice_kind="neutral",
    )
    with pytest.raises(NotImplementedError) as exc:
        tts_synthesize(payload)
    assert "Phase 4" in str(exc.value) or "live mode" in str(exc.value).lower()


# ─────────────────────────────────────────────────────────────────────────────
# 6. Cost attribute.
# ─────────────────────────────────────────────────────────────────────────────


def test_capability_cost_attribute_published() -> None:
    """D41: per-tool USD cost surfaced as a function attribute."""
    cost = getattr(tts_synthesize, "__capability_cost_usd__", None)
    assert cost is not None
    assert isinstance(cost, float)
    assert 0 < cost < 0.05
