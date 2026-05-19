"""Tests for vision.describe — the W2-B5 capability-layer tool.

Coverage matrix:
    1. Stub determinism — same input ⇒ byte-identical output across calls
       (the contract D41 promised for CI + golden-set evals).
    2. 4-locale parametrize — ko / en / ja / zh-CN each yield distinct
       locale-specific alt-text (per D34) while every other output field
       stays byte-identical.
    3. max_length validation — clamped to [50, 300] band per WCAG SC 1.1.1.
    4. Pydantic validation — rejects non-https/non-gs URLs (http://, ftp://,
       blank).
    5. Live mode raises NotImplementedError when CAPABILITY_LAYER_MODE=live.
    6. Per-tool cost attribute is published (D41 — cost_watch reads this).
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.vision_describe import (
    VisionDescribeInput,
    VisionDescribeOutput,
    vision_describe,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism — D41 contract.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_returns_canonical_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stub MUST return the exact canned payload documented in the
    module docstring for ANY valid input + a given locale. Golden-set evals
    + CI workflow runs depend on byte-stable output here."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = VisionDescribeInput(
        gcs_uri_or_https_url="gs://ss-v2-media/demo/img-001.jpg",
        locale="en",
        max_length=200,
    )

    out = vision_describe(payload)

    assert isinstance(out, VisionDescribeOutput)
    assert "vitamin c serum" in out.alt_text.lower()
    assert out.detected_objects == ["bottle", "shelf", "plant", "tile"]
    assert out.confidence_0_1 == 0.92
    assert "bathroom" in out.scene_description.lower()


def test_stub_determinism_across_invocations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Repeated calls with the SAME input must serialise to identical JSON."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = VisionDescribeInput(
        gcs_uri_or_https_url="gs://ss-v2-media/demo/img-001.jpg",
        locale="ko",
        max_length=125,
    )
    json_outputs = {vision_describe(payload).model_dump_json() for _ in range(5)}
    assert len(json_outputs) == 1


def test_stub_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """When CAPABILITY_LAYER_MODE is unset, default is "stub" (D41 safety
    default — dev/CI must never accidentally hit live Gemini multimodal)."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = vision_describe(
        VisionDescribeInput(
            gcs_uri_or_https_url="gs://ss-v2-media/x.jpg",
            locale="en",
        )
    )
    assert out.alt_text != ""
    assert 0.0 <= out.confidence_0_1 <= 1.0


def test_stub_unknown_mode_falls_back_to_stub(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fat-fingered CAPABILITY_LAYER_MODE values fall back to stub +
    log a warning. Safer than crashing in production."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "yolo")
    out = vision_describe(
        VisionDescribeInput(
            gcs_uri_or_https_url="gs://x/y.jpg",
            locale="ko",
        )
    )
    assert out.alt_text != ""


# ─────────────────────────────────────────────────────────────────────────────
# 2. 4-locale parametrize — D34 contract.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("locale", "marker"),
    [
        ("ko", "비타민C"),
        ("en", "vitamin C"),
        ("ja", "ビタミンC"),
        ("zh-CN", "维生素C"),
    ],
)
def test_locale_produces_distinct_alt_text(
    locale: str, marker: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each D34 locale produces alt-text containing a locale-specific
    marker phrase. Confirms the stub honours the locale field rather than
    always returning English."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = vision_describe(
        VisionDescribeInput(
            gcs_uri_or_https_url="gs://ss-v2-media/img.jpg",
            locale=locale,  # type: ignore[arg-type]
            max_length=300,
        )
    )
    assert marker in out.alt_text, (
        f"locale={locale} alt_text missing marker {marker!r}: {out.alt_text!r}"
    )
    assert marker in out.scene_description


def test_all_four_locales_distinct(monkeypatch: pytest.MonkeyPatch) -> None:
    """The four locales must produce four distinct alt-text strings —
    proves the stub is not returning a single canned English value."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    alts = {
        loc: vision_describe(
            VisionDescribeInput(
                gcs_uri_or_https_url="gs://x/y.jpg",
                locale=loc,  # type: ignore[arg-type]
                max_length=300,
            )
        ).alt_text
        for loc in ("ko", "en", "ja", "zh-CN")
    }
    assert len(set(alts.values())) == 4, (
        f"expected 4 distinct alt-texts, got {len(set(alts.values()))}: {alts}"
    )


@pytest.mark.parametrize("bad_locale", ["fr", "de", "es", "EN", "", "zh"])
def test_invalid_locale_rejected(bad_locale: str) -> None:
    """Locales outside the D34 set fail Pydantic validation before the
    tool body runs."""
    with pytest.raises(ValidationError):
        VisionDescribeInput(
            gcs_uri_or_https_url="gs://x/y.jpg",
            locale=bad_locale,  # type: ignore[arg-type]
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. max_length validation — 50-300 band.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("good_len", [50, 75, 125, 200, 300])
def test_max_length_in_band_accepted(good_len: int) -> None:
    """max_length in [50, 300] is accepted."""
    payload = VisionDescribeInput(
        gcs_uri_or_https_url="gs://x/y.jpg",
        locale="en",
        max_length=good_len,
    )
    assert payload.max_length == good_len


@pytest.mark.parametrize("bad_len", [0, 1, 49, 301, 1000, -10])
def test_max_length_out_of_band_rejected(bad_len: int) -> None:
    """max_length outside [50, 300] fails Pydantic validation."""
    with pytest.raises(ValidationError):
        VisionDescribeInput(
            gcs_uri_or_https_url="gs://x/y.jpg",
            locale="en",
            max_length=bad_len,
        )


def test_max_length_clips_long_alt_text(monkeypatch: pytest.MonkeyPatch) -> None:
    """When the canned stub alt-text exceeds max_length, the output is
    truncated to ≤ max_length chars."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = vision_describe(
        VisionDescribeInput(
            gcs_uri_or_https_url="gs://x/y.jpg",
            locale="en",
            max_length=50,
        )
    )
    assert len(out.alt_text) <= 50


# ─────────────────────────────────────────────────────────────────────────────
# 4. Pydantic validation — input contract enforcement.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad_url",
    [
        "http://insecure.example.com/img.jpg",
        "ftp://files.example.com/img.jpg",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "img.jpg",
        "//cdn.example.com/img.jpg",
        "",
    ],
)
def test_input_rejects_non_https_url(bad_url: str) -> None:
    """gcs_uri_or_https_url must be gs:// or https://."""
    with pytest.raises(ValidationError):
        VisionDescribeInput(
            gcs_uri_or_https_url=bad_url,
            locale="en",
        )


def test_input_accepts_both_schemes() -> None:
    """gs:// (canonical) + https:// (RapidAPI CDN fallback) both work."""
    for url in (
        "gs://ss-v2-media/posts/p1/thumb.jpg",
        "https://cdn.example.com/img.jpg",
    ):
        payload = VisionDescribeInput(
            gcs_uri_or_https_url=url,
            locale="en",
        )
        assert payload.gcs_uri_or_https_url == url


def test_input_forbids_extra_fields() -> None:
    """Extra fields rejected — guards against contract drift."""
    with pytest.raises(ValidationError):
        VisionDescribeInput.model_validate(
            {
                "gcs_uri_or_https_url": "gs://x/y.jpg",
                "locale": "en",
                "rogue": "drop",
            }
        )


# ─────────────────────────────────────────────────────────────────────────────
# 5. Live mode — D41 NotImplementedError guard.
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    """Until Phase 4 wires real Gemini multimodal, live mode MUST raise."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    payload = VisionDescribeInput(
        gcs_uri_or_https_url="gs://x/y.jpg",
        locale="en",
    )
    with pytest.raises(NotImplementedError) as exc:
        vision_describe(payload)
    assert "Phase 4" in str(exc.value) or "live mode" in str(exc.value).lower()


# ─────────────────────────────────────────────────────────────────────────────
# 6. Cost attribute — D41 cost_watch hook.
# ─────────────────────────────────────────────────────────────────────────────


def test_capability_cost_attribute_published() -> None:
    """D41: per-tool USD cost surfaced as a function attribute."""
    cost = getattr(vision_describe, "__capability_cost_usd__", None)
    assert cost is not None
    assert isinstance(cost, float)
    assert 0 < cost < 0.01
