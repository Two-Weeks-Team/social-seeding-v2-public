"""Tests for lyria.generate — the W2-B4 capability-layer tool.

Coverage matrix:
    1. Stub determinism — same input → byte-identical output; stub URI
       follows `gs://ss-creative-stub/audio_<duration>.mp3`.
    2. Prompt-injection guard — length cap (rejects > 600 chars), Lyria
       copyright-filter ban-list (named artists, 'in the style of X',
       'cover of "song"', 'sample of <Artist>').
    3. Duration validation — parametrize valid + out-of-band values
       (4-60 sec); aspect_ratio is N/A for Lyria so we parametrize the
       4 image/video aspect-ratio strings to confirm Lyria's separate
       schema (no aspect_ratio field) accepts no extra fields.
    4. Live mode raises NotImplementedError when CAPABILITY_LAYER_MODE=live.
    5. Per-tool cost attribute is published (D41).
"""
from __future__ import annotations

import hashlib

import pytest
from pydantic import ValidationError

from ss_agents.tools.lyria_generate import (
    LyriaGenerateInput,
    LyriaGenerateOutput,
    lyria_generate,
)


def _valid_input(**overrides: object) -> LyriaGenerateInput:
    defaults: dict[str, object] = {
        "prompt": "Soft lo-fi morning beat, 80 bpm, gentle piano + warm pad",
        "duration_seconds": 8,
        "instrumental_only": True,
    }
    defaults.update(overrides)
    return LyriaGenerateInput(**defaults)  # type: ignore[arg-type]


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism — D41 contract.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_returns_canonical_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub returns canonical `gs://ss-creative-stub/audio_<duration>.mp3`."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = lyria_generate(_valid_input(duration_seconds=8))

    assert isinstance(out, LyriaGenerateOutput)
    assert out.gcs_uri == "gs://ss-creative-stub/audio_8.mp3"
    expected_sha = hashlib.sha256(out.gcs_uri.encode("utf-8")).hexdigest()
    assert out.sha256 == expected_sha
    assert out.duration_s == 8.0
    assert out.sample_rate_hz == 44_100  # Lyria GA default


def test_stub_uri_carries_requested_duration(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stub URI suffix reflects the requested duration."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    for dur in (4, 8, 15, 30, 60):
        out = lyria_generate(_valid_input(duration_seconds=dur))
        assert out.gcs_uri == f"gs://ss-creative-stub/audio_{dur}.mp3"
        assert out.duration_s == float(dur)


def test_stub_determinism_across_invocations(monkeypatch: pytest.MonkeyPatch) -> None:
    """Repeated calls with the same input must produce byte-identical output."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = _valid_input()
    json_outputs = {lyria_generate(payload).model_dump_json() for _ in range(3)}
    assert len(json_outputs) == 1


def test_stub_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default mode (env unset) is stub."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = lyria_generate(_valid_input())
    assert out.gcs_uri == "gs://ss-creative-stub/audio_8.mp3"


def test_stub_optional_genre_hint_normalised(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Optional genre_hint round-trips; whitespace-only normalises to None."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    p1 = LyriaGenerateInput(
        prompt="Soft lo-fi morning beat",
        duration_seconds=8,
        genre_hint="ambient electronic",
        instrumental_only=True,
    )
    assert p1.genre_hint == "ambient electronic"
    p2 = LyriaGenerateInput(
        prompt="Soft lo-fi morning beat",
        duration_seconds=8,
        genre_hint="   ",
        instrumental_only=True,
    )
    assert p2.genre_hint is None


# ─────────────────────────────────────────────────────────────────────────────
# 2. Prompt-injection guard — length cap + Lyria copyright ban-list.
# ─────────────────────────────────────────────────────────────────────────────


def test_prompt_length_cap_rejects_over_600_chars() -> None:
    """Prompt > 600 chars is rejected by Pydantic (creative.spec.md §6
    constraint on lyria_music_prompt)."""
    huge_prompt = "A" * 601
    with pytest.raises(ValidationError) as exc:
        LyriaGenerateInput(
            prompt=huge_prompt,
            duration_seconds=8,
            instrumental_only=True,
        )
    msg = str(exc.value)
    assert "600" in msg or "max_length" in msg or "at most" in msg


def test_prompt_empty_or_whitespace_rejected() -> None:
    """Empty / whitespace-only prompts are rejected."""
    for bad in ("", "   ", "\t\n"):
        with pytest.raises(ValidationError):
            LyriaGenerateInput(
                prompt=bad,
                duration_seconds=8,
                instrumental_only=True,
            )


@pytest.mark.parametrize(
    "evil_prompt",
    [
        # Named artist (Lyria copyright filter — agent-level mirror).
        "Morning beat in the style of Taylor Swift",
        "Lo-fi instrumental in the style of Drake",
        "Upbeat track in the style of Beyoncé",
        # Explicit cover / sample requests.
        'Make a cover of "Shake It Off"',
        "sample of BTS dynamite",
        # High-risk explicit artist list.
        "An energetic beat featuring BTS",
        "Smooth track inspired by Blackpink",
    ],
)
def test_prompt_lyria_ban_list_rejects_copyright_violations(
    evil_prompt: str,
) -> None:
    """Lyria copyright filter mirror rejects named-artist style transfer
    + 'cover of'/'sample of' patterns BEFORE the Vertex round-trip."""
    with pytest.raises(ValidationError) as exc:
        LyriaGenerateInput(
            prompt=evil_prompt,
            duration_seconds=8,
            instrumental_only=True,
        )
    msg = str(exc.value).lower()
    assert (
        "copyright" in msg
        or "lyria" in msg
        or "ban" in msg
        or "pattern" in msg
    )


def test_prompt_clean_descriptive_text_passes() -> None:
    """Generic genre/tempo/mood descriptors must NOT trip the filter."""
    clean_prompts = [
        "Soft lo-fi morning beat, 80 bpm, gentle piano + warm pad",
        "Ambient electronic, 60 bpm, airy synths, no vocals",
        "Upbeat k-pop-adjacent pop instrumental, 110 bpm, bright pluck synth",
        "차분한 모닝 비트, 80 bpm, 부드러운 피아노",  # Korean clean
    ]
    for prompt in clean_prompts:
        payload = LyriaGenerateInput(
            prompt=prompt,
            duration_seconds=8,
            instrumental_only=True,
        )
        assert payload.prompt == prompt


# ─────────────────────────────────────────────────────────────────────────────
# 3. Duration validation + (no aspect_ratio) field shape.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("dur", [4, 8, 15, 30, 60])
def test_duration_in_band_accepted(dur: int) -> None:
    """duration_seconds in [4, 60] round-trips."""
    payload = LyriaGenerateInput(
        prompt="Soft lo-fi morning beat",
        duration_seconds=dur,
        instrumental_only=True,
    )
    assert payload.duration_seconds == dur


@pytest.mark.parametrize("bad_dur", [0, 1, 3, 61, 120, -1])
def test_duration_out_of_band_rejected(bad_dur: int) -> None:
    """duration_seconds must be in [4, 60] per the task brief."""
    with pytest.raises(ValidationError):
        LyriaGenerateInput(
            prompt="Soft lo-fi morning beat",
            duration_seconds=bad_dur,
            instrumental_only=True,
        )


@pytest.mark.parametrize("aspect_ratio", ["1:1", "16:9", "9:16", "4:3"])
def test_extra_aspect_ratio_field_rejected(aspect_ratio: str) -> None:
    """Lyria has no aspect_ratio (audio-only). Passing one MUST fail
    validation — parametrize all 4 image/video ratios to confirm Lyria's
    schema fences out video-shape contract drift."""
    with pytest.raises(ValidationError):
        LyriaGenerateInput.model_validate(
            {
                "prompt": "Soft lo-fi morning beat",
                "duration_seconds": 8,
                "instrumental_only": True,
                "aspect_ratio": aspect_ratio,  # rogue field
            }
        )


def test_extra_fields_rejected() -> None:
    """Extra fields fail validation — guards against contract drift."""
    with pytest.raises(ValidationError):
        LyriaGenerateInput.model_validate(
            {
                "prompt": "Soft lo-fi morning beat",
                "duration_seconds": 8,
                "instrumental_only": True,
                "rogue_field": "should not be accepted",
            }
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Live mode — D41 NotImplementedError guard.
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    """Live mode MUST raise NotImplementedError until Phase 4."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    payload = _valid_input()
    with pytest.raises(NotImplementedError) as exc:
        lyria_generate(payload)
    assert "Phase 4" in str(exc.value) or "live mode" in str(exc.value).lower()


# ─────────────────────────────────────────────────────────────────────────────
# 5. Cost attribute — D41 cost_watch hook.
# ─────────────────────────────────────────────────────────────────────────────


def test_capability_cost_attribute_published() -> None:
    """D41: per-tool USD cost surfaced as an attribute for cost_watch."""
    cost = getattr(lyria_generate, "__capability_cost_usd__", None)
    assert cost is not None, "lyria_generate missing cost attribute"
    assert isinstance(cost, float)
    # Lyria ≈ $0.10 per 8s sting — must be sub-dollar.
    assert 0 < cost < 1.0, f"Lyria per-call cost out of band: ${cost}"
