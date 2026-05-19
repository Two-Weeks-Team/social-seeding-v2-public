"""Tests for vision.brand_logo_detect — the W2-A5 capability-layer tool.

Coverage matrix:
    1. Stub determinism — same input ⇒ byte-identical output across calls
       (the contract D41 promised for CI + golden-set evals).
    2. Pydantic validation — rejects non-https/non-gs URLs (http://, ftp://,
       blank) and rejects empty / whitespace-only brand names.
    3. Live mode raises NotImplementedError when CAPABILITY_LAYER_MODE=live
       (the W2-A1 canonical guard until Phase 4 wires Cloud Vision for real).
    4. Per-tool cost attribute is published (D41 — cost_watch reads this).
    5. Output schema shape — bounding boxes are typed BoundingBox instances,
       confidence is in [0, 1], lists have the expected single canned entry.

Per `tests/conftest.py`'s `_isolate_env` fixture, SS_LIVE / SS_OFFLINE are
forced into offline mode for the run — these tool tests don't need network.
We do, however, monkeypatch CAPABILITY_LAYER_MODE explicitly per-test so the
behaviour-by-mode branch is covered deterministically (the env var is not
touched by `_isolate_env`).
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.vision_brand_logo_detect import (
    BoundingBox,
    VisionBrandLogoDetectInput,
    VisionBrandLogoDetectOutput,
    vision_brand_logo_detect,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism — D41 contract.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_returns_canonical_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stub MUST return the exact canned payload documented in the
    module docstring for ANY valid input. Golden-set evals + CI workflow
    runs depend on byte-stable output here."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = VisionBrandLogoDetectInput(
        media_url="gs://ss-v2-media/posts/post_demo_1/thumb.jpg",
        expected_brand_name="Freshly",
    )

    out = vision_brand_logo_detect(payload)

    assert out.logo_detected is True
    assert out.confidence_0_1 == 0.87
    assert out.brand_match is True
    assert out.detected_logos == ["StubBrand"]
    assert out.logo_bounding_boxes == [BoundingBox(x=100, y=100, w=200, h=200)]


def test_stub_determinism_across_invocations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Repeated calls — including with different (still valid) inputs — must
    serialise to the same JSON. This is the W2-A1 determinism guarantee."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")

    inputs = [
        VisionBrandLogoDetectInput(
            media_url="gs://ss-v2-media/posts/p1/thumb.jpg",
            expected_brand_name="Freshly",
        ),
        VisionBrandLogoDetectInput(
            media_url="https://cdn.example.com/img.jpg",
            expected_brand_name="GlowBoost",
        ),
        VisionBrandLogoDetectInput(
            media_url="gs://ss-v2-media/posts/p2/frame_3.jpg",
            expected_brand_name="비타민C 세럼",  # multilingual brand name
        ),
    ]

    json_outputs = {
        vision_brand_logo_detect(i).model_dump_json() for i in inputs
    }
    assert len(json_outputs) == 1, (
        f"stub must return byte-identical JSON across inputs; got "
        f"{len(json_outputs)} distinct shapes: {json_outputs}"
    )


def test_stub_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """When CAPABILITY_LAYER_MODE is unset, default is "stub" (D41 safety
    default — dev/CI must never accidentally hit live Cloud Vision)."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = vision_brand_logo_detect(
        VisionBrandLogoDetectInput(
            media_url="gs://ss-v2-media/x.jpg",
            expected_brand_name="Brand",
        )
    )
    assert out.logo_detected is True
    assert out.detected_logos == ["StubBrand"]


def test_stub_unknown_mode_falls_back_to_stub(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fat-fingered CAPABILITY_LAYER_MODE values fall back to stub +
    log a warning. Safer than crashing in production."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "yolo")
    out = vision_brand_logo_detect(
        VisionBrandLogoDetectInput(
            media_url="gs://x/y.jpg",
            expected_brand_name="Brand",
        )
    )
    assert out.logo_detected is True


# ─────────────────────────────────────────────────────────────────────────────
# 2. Pydantic validation — input contract enforcement.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad_url",
    [
        "http://insecure.example.com/img.jpg",  # plain HTTP rejected (D20)
        "ftp://files.example.com/img.jpg",       # FTP rejected
        "file:///etc/passwd",                    # local file rejected
        "javascript:alert(1)",                    # XSS-style rejected
        "img.jpg",                                # bare filename rejected
        "//cdn.example.com/img.jpg",             # protocol-relative rejected
        "",                                       # empty rejected (min_length)
    ],
)
def test_input_rejects_non_https_url(bad_url: str) -> None:
    """media_url must be gs:// or https://. Everything else fails Pydantic
    validation BEFORE the tool body runs (defence in depth — even if the
    stub were called, it would still reject)."""
    with pytest.raises(ValidationError) as exc:
        VisionBrandLogoDetectInput(
            media_url=bad_url,
            expected_brand_name="Freshly",
        )
    msg = str(exc.value)
    # The error message must point at media_url either by field name OR by
    # carrying the offending scheme so callers can debug fast.
    assert "media_url" in msg or "gs://" in msg or "min_length" in msg or "String should have at least 1 character" in msg


@pytest.mark.parametrize(
    "bad_brand",
    [
        "",          # empty rejected by min_length
        "   ",       # whitespace-only rejected by validator
        "\t\n",      # tab+newline rejected by validator
    ],
)
def test_input_rejects_empty_brand_name(bad_brand: str) -> None:
    """expected_brand_name must be non-empty after strip — empty brand
    guarantees a meaningless brand_match result."""
    with pytest.raises(ValidationError) as exc:
        VisionBrandLogoDetectInput(
            media_url="gs://ss-v2-media/x.jpg",
            expected_brand_name=bad_brand,
        )
    msg = str(exc.value)
    assert "expected_brand_name" in msg or "non-empty" in msg or "at least 1 character" in msg


def test_input_strips_whitespace_from_brand() -> None:
    """Surrounding whitespace on a real brand name is stripped, not rejected."""
    payload = VisionBrandLogoDetectInput(
        media_url="gs://ss-v2-media/x.jpg",
        expected_brand_name="  Freshly  ",
    )
    assert payload.expected_brand_name == "Freshly"


def test_input_accepts_https_and_gs_uris() -> None:
    """Both scheme prefixes are accepted (gs:// is canonical per D33, https
    is the RapidAPI live-CDN fallback)."""
    for url in (
        "gs://ss-v2-media/posts/p1/thumb.jpg",
        "https://cdn.example.com/img.jpg",
    ):
        payload = VisionBrandLogoDetectInput(
            media_url=url,
            expected_brand_name="Freshly",
        )
        assert payload.media_url == url


def test_input_forbids_extra_fields() -> None:
    """Extra fields are rejected — guards against contract drift."""
    with pytest.raises(ValidationError):
        VisionBrandLogoDetectInput.model_validate(
            {
                "media_url": "gs://x/y.jpg",
                "expected_brand_name": "Freshly",
                "rogue_field": "should not be accepted",
            }
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Live mode contract — D41 NotImplementedError guard.
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    """Until Phase 4 wires the real Cloud Vision client, live mode MUST
    raise NotImplementedError. This protects dev/CI from accidentally
    hitting paid Vision API quota when CAPABILITY_LAYER_MODE is set."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    payload = VisionBrandLogoDetectInput(
        media_url="gs://ss-v2-media/x.jpg",
        expected_brand_name="Freshly",
    )
    with pytest.raises(NotImplementedError) as exc:
        vision_brand_logo_detect(payload)
    # The error message points to the Phase-4 wiring task so an operator
    # who hits this in production knows what to do.
    assert "Phase 4" in str(exc.value) or "live mode" in str(exc.value).lower()


# ─────────────────────────────────────────────────────────────────────────────
# 4. Cost attribute — D41 cost_watch hook.
# ─────────────────────────────────────────────────────────────────────────────


def test_capability_cost_attribute_published() -> None:
    """D41: per-tool USD cost is surfaced as an attribute on the function so
    `cost_watch` can aggregate without re-reading the pricing page."""
    cost = getattr(vision_brand_logo_detect, "__capability_cost_usd__", None)
    assert cost is not None, "vision_brand_logo_detect missing cost attribute"
    assert isinstance(cost, float)
    assert 0 < cost < 0.01, f"Cloud Vision LOGO_DETECTION cost out of band: ${cost}"


# ─────────────────────────────────────────────────────────────────────────────
# 5. Output schema — shape + invariants.
# ─────────────────────────────────────────────────────────────────────────────


def test_output_schema_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stub output respects every schema invariant: confidence in [0,1],
    bounding boxes are typed BoundingBox instances, lists are non-empty."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = vision_brand_logo_detect(
        VisionBrandLogoDetectInput(
            media_url="gs://x/y.jpg",
            expected_brand_name="Freshly",
        )
    )
    assert isinstance(out, VisionBrandLogoDetectOutput)
    assert 0.0 <= out.confidence_0_1 <= 1.0
    assert len(out.logo_bounding_boxes) == 1
    bbox = out.logo_bounding_boxes[0]
    assert isinstance(bbox, BoundingBox)
    assert bbox.x == 100 and bbox.y == 100 and bbox.w == 200 and bbox.h == 200
    assert len(out.detected_logos) == 1
    assert out.detected_logos[0] == "StubBrand"


def test_output_rejects_invalid_confidence() -> None:
    """Confidence must stay in [0, 1]. Construct a deliberately-invalid output
    to confirm the schema rejects out-of-band values (defence in depth — a
    future live wiring that mis-normalises Vision's [0, 100] score would
    fail loudly here, not silently propagate)."""
    with pytest.raises(ValidationError):
        VisionBrandLogoDetectOutput(
            logo_detected=True,
            confidence_0_1=1.5,
            brand_match=True,
            logo_bounding_boxes=[],
            detected_logos=[],
        )
    with pytest.raises(ValidationError):
        VisionBrandLogoDetectOutput(
            logo_detected=True,
            confidence_0_1=-0.1,
            brand_match=True,
            logo_bounding_boxes=[],
            detected_logos=[],
        )


def test_output_bounding_box_validation() -> None:
    """w/h must be > 0; x/y must be >= 0."""
    BoundingBox(x=0, y=0, w=1, h=1)  # OK
    with pytest.raises(ValidationError):
        BoundingBox(x=-1, y=0, w=10, h=10)
    with pytest.raises(ValidationError):
        BoundingBox(x=0, y=0, w=0, h=10)
    with pytest.raises(ValidationError):
        BoundingBox(x=0, y=0, w=10, h=0)
