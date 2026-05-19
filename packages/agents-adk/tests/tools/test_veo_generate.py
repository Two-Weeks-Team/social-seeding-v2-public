"""Tests for veo.generate — the W2-B4 capability-layer tool.

Coverage matrix:
    1. Stub determinism — same input → byte-identical output; stub URI
       follows `gs://ss-creative-stub/vid_<duration>.mp4`; watermark_present
       is always True (mirrors Veo 3 GA's SynthID default).
    2. Prompt-injection guard — length cap (rejects > 2000 chars), tool-
       local ban-list (named-person likeness in motion, deepfake / face-
       swap motion, competitor logo rendering).
    3. Aspect-ratio + duration + fps validation — parametrize all 4
       supported ratios; reject `duration < 4` and `> 30`; reject fps
       other than 24 or 30.
    4. Live mode raises NotImplementedError when CAPABILITY_LAYER_MODE=live.
    5. Per-tool cost attribute is published (D41).
"""
from __future__ import annotations

import hashlib

import pytest
from pydantic import ValidationError

from ss_agents.tools.veo_generate import (
    VeoGenerateInput,
    VeoGenerateOutput,
    veo_generate,
)


def _valid_input(**overrides: object) -> VeoGenerateInput:
    defaults: dict[str, object] = {
        "prompt": "A serene morning skincare flat-lay, soft daylight, slow push-in",
        "duration_seconds": 8,
        "aspect_ratio": "9:16",
        "fps": 30,
    }
    defaults.update(overrides)
    return VeoGenerateInput(**defaults)  # type: ignore[arg-type]


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism — D41 contract.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_returns_canonical_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub returns canonical `gs://ss-creative-stub/vid_<duration>.mp4` URI."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")

    out = veo_generate(_valid_input(duration_seconds=8))

    assert isinstance(out, VeoGenerateOutput)
    assert out.gcs_uri == "gs://ss-creative-stub/vid_8.mp4"
    expected_sha = hashlib.sha256(out.gcs_uri.encode("utf-8")).hexdigest()
    assert out.sha256 == expected_sha
    assert out.duration_s == 8.0
    assert out.fps == 30
    assert out.resolution == "720x1280"  # 9:16
    assert out.watermark_present is True  # SynthID GA default


def test_stub_uri_carries_requested_duration(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stub URI suffix reflects the requested duration (sanity-checks
    the key formatting contract)."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    for dur in (4, 8, 15, 30):
        out = veo_generate(_valid_input(duration_seconds=dur))
        assert out.gcs_uri == f"gs://ss-creative-stub/vid_{dur}.mp4"
        assert out.duration_s == float(dur)


def test_stub_determinism_across_invocations(monkeypatch: pytest.MonkeyPatch) -> None:
    """Repeated calls with the same input must produce byte-identical output."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = _valid_input()
    json_outputs = {veo_generate(payload).model_dump_json() for _ in range(3)}
    assert len(json_outputs) == 1


def test_stub_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default mode (env unset) is stub."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = veo_generate(_valid_input())
    assert out.gcs_uri == "gs://ss-creative-stub/vid_8.mp4"


def test_stub_watermark_always_present(monkeypatch: pytest.MonkeyPatch) -> None:
    """SynthID watermark is non-opt-out per Veo 3 GA terms. Stub mirrors that."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = veo_generate(_valid_input())
    assert out.watermark_present is True


# ─────────────────────────────────────────────────────────────────────────────
# 2. Prompt-injection guard — length cap + ban-list.
# ─────────────────────────────────────────────────────────────────────────────


def test_prompt_length_cap_rejects_over_2000_chars() -> None:
    """Prompt > 2000 chars is rejected by Pydantic before the tool runs."""
    huge_prompt = "A" * 2001
    with pytest.raises(ValidationError) as exc:
        VeoGenerateInput(
            prompt=huge_prompt,
            duration_seconds=8,
            aspect_ratio="9:16",
            fps=30,
        )
    msg = str(exc.value)
    assert "2000" in msg or "max_length" in msg or "at most" in msg


def test_prompt_empty_or_whitespace_rejected() -> None:
    """Empty / whitespace-only prompts are rejected."""
    for bad in ("", "   ", "\t\n"):
        with pytest.raises(ValidationError):
            VeoGenerateInput(
                prompt=bad,
                duration_seconds=8,
                aspect_ratio="9:16",
                fps=30,
            )


@pytest.mark.parametrize(
    "evil_prompt",
    [
        # Named real-person likeness in motion — creative.spec.md §8 #1.
        "Generate a video of Taylor Swift drinking coffee",
        "Footage of Elon Musk in a lab coat, slow zoom-in",
        "clip of BTS dancing in the background",
        # Deepfake / face-swap / voice-clone motion synthesis.
        "Create a deepfake reel of the operator",
        "Do a face-swap onto the creator's face",
        "voice-clone the CEO over the ad",
        # Competitor logo rendering.
        "render the Nike logo on the product label",
        "generate the Coca-Cola logo in the upper-right corner",
    ],
)
def test_prompt_ban_list_rejects_policy_violations(evil_prompt: str) -> None:
    """Tool-local ban-list rejects content-policy violations BEFORE the
    Vertex Veo round-trip happens."""
    with pytest.raises(ValidationError) as exc:
        VeoGenerateInput(
            prompt=evil_prompt,
            duration_seconds=8,
            aspect_ratio="9:16",
            fps=30,
        )
    msg = str(exc.value).lower()
    assert "ban-list" in msg or "ban" in msg or "pattern" in msg


def test_prompt_clean_business_text_passes() -> None:
    """Legitimate creative prompts must NOT trip the ban-list."""
    clean_prompts = [
        "A slow push-in on a vitamin C serum bottle on marble, soft daylight",
        "한국 아침 스킨케어 루틴, 천천히 줌인",
        "Overhead flat-lay of fresh fruit, gentle camera dolly",
    ]
    for prompt in clean_prompts:
        payload = VeoGenerateInput(
            prompt=prompt,
            duration_seconds=8,
            aspect_ratio="9:16",
            fps=30,
        )
        assert payload.prompt == prompt


# ─────────────────────────────────────────────────────────────────────────────
# 3. Aspect-ratio + duration + fps validation.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("aspect", ["1:1", "16:9", "9:16", "4:3"])
def test_all_four_aspect_ratios_accepted(
    aspect: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """All 4 Veo-supported aspect ratios round-trip + yield reasonable
    resolution strings in stub mode."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = VeoGenerateInput(
        prompt="A clean product flat-lay, slow camera move",
        duration_seconds=8,
        aspect_ratio=aspect,  # type: ignore[arg-type]
        fps=30,
    )
    out = veo_generate(payload)
    # Resolution is a "WxH" string per the schema.
    w_str, h_str = out.resolution.split("x")
    w, h = int(w_str), int(h_str)
    assert w > 0 and h > 0
    if aspect == "1:1":
        assert w == h
    elif aspect == "16:9":
        assert w > h
    elif aspect == "9:16":
        assert h > w
    elif aspect == "4:3":
        assert w > h and h * 4 == w * 3


@pytest.mark.parametrize("bad_aspect", ["21:9", "3:2", "5:4", "", "1:1 "])
def test_unsupported_aspect_ratio_rejected(bad_aspect: str) -> None:
    """Aspect ratios outside the 4 supported values are rejected."""
    with pytest.raises(ValidationError):
        VeoGenerateInput(
            prompt="A clean product flat-lay, slow camera move",
            duration_seconds=8,
            aspect_ratio=bad_aspect,  # type: ignore[arg-type]
            fps=30,
        )


@pytest.mark.parametrize("bad_dur", [0, 1, 2, 3, 31, 60, -1])
def test_duration_out_of_band_rejected(bad_dur: int) -> None:
    """duration_seconds must be in [4, 30] per the task brief."""
    with pytest.raises(ValidationError):
        VeoGenerateInput(
            prompt="A clean product flat-lay, slow camera move",
            duration_seconds=bad_dur,
            aspect_ratio="9:16",
            fps=30,
        )


@pytest.mark.parametrize("dur", [4, 8, 15, 30])
def test_duration_in_band_accepted(dur: int) -> None:
    """duration_seconds in [4, 30] round-trips. Spec says Veo 3 single-clip
    cap is 8s; we still accept up to 30 — the workflow splits multi-clip."""
    payload = VeoGenerateInput(
        prompt="A clean product flat-lay, slow camera move",
        duration_seconds=dur,
        aspect_ratio="9:16",
        fps=30,
    )
    assert payload.duration_seconds == dur


@pytest.mark.parametrize("fps", [24, 30])
def test_supported_fps_accepted(fps: int) -> None:
    """Both 24 and 30 fps are accepted."""
    payload = VeoGenerateInput(
        prompt="A clean product flat-lay, slow camera move",
        duration_seconds=8,
        aspect_ratio="9:16",
        fps=fps,  # type: ignore[arg-type]
    )
    assert payload.fps == fps


@pytest.mark.parametrize("bad_fps", [0, 12, 25, 60, 120, -1])
def test_unsupported_fps_rejected(bad_fps: int) -> None:
    """fps other than 24 or 30 is rejected."""
    with pytest.raises(ValidationError):
        VeoGenerateInput(
            prompt="A clean product flat-lay, slow camera move",
            duration_seconds=8,
            aspect_ratio="9:16",
            fps=bad_fps,  # type: ignore[arg-type]
        )


def test_extra_fields_rejected() -> None:
    """Extra fields fail validation — guards against contract drift."""
    with pytest.raises(ValidationError):
        VeoGenerateInput.model_validate(
            {
                "prompt": "A clean flat-lay",
                "duration_seconds": 8,
                "aspect_ratio": "9:16",
                "fps": 30,
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
        veo_generate(payload)
    assert "Phase 4" in str(exc.value) or "live mode" in str(exc.value).lower()


# ─────────────────────────────────────────────────────────────────────────────
# 5. Cost attribute — D41 cost_watch hook.
# ─────────────────────────────────────────────────────────────────────────────


def test_capability_cost_attribute_published() -> None:
    """D41: per-tool USD cost surfaced as an attribute for cost_watch."""
    cost = getattr(veo_generate, "__capability_cost_usd__", None)
    assert cost is not None, "veo_generate missing cost attribute"
    assert isinstance(cost, float)
    # Veo 3 8s @ 720p ≈ $1.00 (median 2026 H1 list) — must be sub-$10.
    assert 0 < cost < 10.0, f"Veo 3 per-clip cost out of band: ${cost}"
