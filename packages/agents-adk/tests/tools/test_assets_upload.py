"""Tests for assets.upload — the W2-B4 capability-layer tool.

Coverage matrix:
    1. Stub determinism — same input → byte-identical output; cdn_url
       follows `https://stub.cdn.local/<workspace_id>/<sha256>.<ext>`;
       final_gcs_uri shadows the same path layout.
    2. Input-injection guard — path-traversal rejection (`..` segments,
       leading `/`, other schemes like `file://`/`javascript:`);
       workspace_id regex enforcement; asset_kind enum enforcement.
    3. asset_kind validation — parametrize all 3 supported kinds
       (image / video / audio) and the 4 image/video aspect-ratio
       strings as rogue `aspect_ratio` fields (extra-fields rejection).
    4. Live mode raises NotImplementedError when CAPABILITY_LAYER_MODE=live.
    5. Per-tool cost attribute is published (D41).
"""
from __future__ import annotations

import hashlib

import pytest
from pydantic import ValidationError

from ss_agents.tools.assets_upload import (
    AssetsUploadInput,
    AssetsUploadOutput,
    assets_upload,
)


def _valid_input(**overrides: object) -> AssetsUploadInput:
    defaults: dict[str, object] = {
        "local_path_or_gcs_uri": "gs://ss-creative-stub/img_1.png",
        "workspace_id": "ws_demo_creative_1",
        "asset_kind": "image",
    }
    defaults.update(overrides)
    return AssetsUploadInput(**defaults)  # type: ignore[arg-type]


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub determinism — D41 contract.
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_returns_canonical_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub returns canonical workspace-scoped URLs."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = _valid_input()

    out = assets_upload(payload)

    assert isinstance(out, AssetsUploadOutput)
    expected_sha = hashlib.sha256(
        payload.local_path_or_gcs_uri.encode("utf-8")
    ).hexdigest()
    assert out.sha256 == expected_sha
    assert out.final_gcs_uri == (
        f"gs://ss-creative-stub/ws_demo_creative_1/{expected_sha}.png"
    )
    assert out.cdn_url == (
        f"https://stub.cdn.local/ws_demo_creative_1/{expected_sha}.png"
    )
    assert out.size_bytes == 1024  # documented stub fixed size


def test_stub_determinism_across_invocations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Repeated calls with the same input must produce byte-identical output."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = _valid_input()
    json_outputs = {assets_upload(payload).model_dump_json() for _ in range(3)}
    assert len(json_outputs) == 1


def test_stub_extensions_match_asset_kind(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The cdn_url extension is derived from asset_kind:
    image→png, video→mp4, audio→mp3."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    cases = [
        ("image", "gs://ss-creative-stub/img_1.png", "png"),
        ("video", "gs://ss-creative-stub/vid_8.mp4", "mp4"),
        ("audio", "gs://ss-creative-stub/audio_8.mp3", "mp3"),
    ]
    for kind, source, ext in cases:
        out = assets_upload(
            AssetsUploadInput(
                local_path_or_gcs_uri=source,
                workspace_id="ws_demo_creative_1",
                asset_kind=kind,  # type: ignore[arg-type]
            )
        )
        assert out.cdn_url.endswith(f".{ext}")
        assert out.final_gcs_uri.endswith(f".{ext}")


def test_stub_default_mode_is_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default mode (env unset) is stub."""
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = assets_upload(_valid_input())
    assert out.cdn_url.startswith("https://stub.cdn.local/ws_demo_creative_1/")


def test_stub_accepts_relative_filesystem_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Relative filesystem paths are accepted (the workflow staging
    directory passes them through to the upload tool)."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    out = assets_upload(
        AssetsUploadInput(
            local_path_or_gcs_uri="staging/img_1.png",
            workspace_id="ws_demo_creative_1",
            asset_kind="image",
        )
    )
    assert out.final_gcs_uri.startswith("gs://ss-creative-stub/ws_demo_creative_1/")


# ─────────────────────────────────────────────────────────────────────────────
# 2. Input-injection guard — path traversal + scheme + workspace regex.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad_source",
    [
        "../../etc/passwd",                  # filesystem path traversal
        "staging/../../secret.png",          # mid-path traversal
        "gs://ss-creative-stub/../leak.png",  # gs:// traversal
        "/etc/passwd",                        # absolute path
        "/var/log/syslog",                    # absolute log path
        "file:///etc/passwd",                 # file:// scheme
        "http://attacker.example.com/x.png",  # http (no TLS) — wrong scheme
        "javascript:alert(1)",                # XSS-style
        "ftp://files.example.com/x.png",      # ftp scheme
        "",                                   # empty
        "   ",                                # whitespace-only
    ],
)
def test_source_uri_rejects_traversal_and_bad_schemes(bad_source: str) -> None:
    """Path-traversal segments + absolute paths + non-gs schemes are
    rejected. Workspace buckets must NEVER receive inputs that escape
    the intended source directory."""
    with pytest.raises(ValidationError) as exc:
        AssetsUploadInput(
            local_path_or_gcs_uri=bad_source,
            workspace_id="ws_demo_creative_1",
            asset_kind="image",
        )
    msg = str(exc.value)
    # Error must point at the source field OR the offending pattern.
    assert (
        "local_path_or_gcs_uri" in msg
        or "traversal" in msg.lower()
        or "scheme" in msg.lower()
        or "relative" in msg.lower()
        or "non-empty" in msg.lower()
        or "min_length" in msg
        or "at least 1 character" in msg
    )


@pytest.mark.parametrize(
    "bad_workspace",
    [
        "",                          # empty
        "demo_creative_1",           # missing ws_ prefix
        "WS_demo_creative_1",        # wrong case
        "ws_",                       # missing suffix
        "ws_demo creative 1",        # whitespace in id
        "ws_demo/creative",          # slash injection
        "ws_demo..creative",         # path-traversal-looking
        "ws_" + "a" * 81,            # too long (over 80 suffix chars)
    ],
)
def test_workspace_id_regex_enforced(bad_workspace: str) -> None:
    """workspace_id must match ws_[A-Za-z0-9_-]{1,80}."""
    with pytest.raises(ValidationError):
        AssetsUploadInput(
            local_path_or_gcs_uri="gs://ss-creative-stub/img_1.png",
            workspace_id=bad_workspace,
            asset_kind="image",
        )


@pytest.mark.parametrize(
    "good_workspace",
    [
        "ws_demo_creative_1",
        "ws_a",
        "ws_2026-05-19",
        "ws_" + "x" * 80,           # max length suffix
        "ws_Multi-Case_ID",
    ],
)
def test_workspace_id_regex_accepts_valid(good_workspace: str) -> None:
    """Legitimate workspace IDs round-trip."""
    payload = AssetsUploadInput(
        local_path_or_gcs_uri="gs://ss-creative-stub/img_1.png",
        workspace_id=good_workspace,
        asset_kind="image",
    )
    assert payload.workspace_id == good_workspace


# ─────────────────────────────────────────────────────────────────────────────
# 3. asset_kind + parametrized aspect-ratio rogue-field rejection.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("kind", ["image", "video", "audio"])
def test_all_three_asset_kinds_accepted(
    kind: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """All 3 supported asset kinds round-trip + map to the expected
    extension."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = AssetsUploadInput(
        local_path_or_gcs_uri="gs://ss-creative-stub/sample",
        workspace_id="ws_demo_creative_1",
        asset_kind=kind,  # type: ignore[arg-type]
    )
    out = assets_upload(payload)
    expected_ext = {"image": "png", "video": "mp4", "audio": "mp3"}[kind]
    assert out.cdn_url.endswith(f".{expected_ext}")


@pytest.mark.parametrize(
    "bad_kind",
    ["text", "pdf", "model", "", "IMAGE", "Image", "videoclip"],
)
def test_unsupported_asset_kind_rejected(bad_kind: str) -> None:
    """asset_kind outside the 3 supported values is rejected."""
    with pytest.raises(ValidationError):
        AssetsUploadInput(
            local_path_or_gcs_uri="gs://ss-creative-stub/img_1.png",
            workspace_id="ws_demo_creative_1",
            asset_kind=bad_kind,  # type: ignore[arg-type]
        )


@pytest.mark.parametrize("aspect_ratio", ["1:1", "16:9", "9:16", "4:3"])
def test_extra_aspect_ratio_field_rejected(aspect_ratio: str) -> None:
    """assets_upload doesn't take aspect_ratio (it's a property of the
    upstream generation tool). Passing one MUST fail — parametrize all
    4 image/video ratios to confirm the schema fences out contract drift
    in either direction."""
    with pytest.raises(ValidationError):
        AssetsUploadInput.model_validate(
            {
                "local_path_or_gcs_uri": "gs://ss-creative-stub/img_1.png",
                "workspace_id": "ws_demo_creative_1",
                "asset_kind": "image",
                "aspect_ratio": aspect_ratio,  # rogue field
            }
        )


def test_extra_fields_rejected() -> None:
    """Extra fields fail validation — guards against contract drift."""
    with pytest.raises(ValidationError):
        AssetsUploadInput.model_validate(
            {
                "local_path_or_gcs_uri": "gs://ss-creative-stub/img_1.png",
                "workspace_id": "ws_demo_creative_1",
                "asset_kind": "image",
                "rogue_field": "should not be accepted",
            }
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Live mode — D41 NotImplementedError guard.
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    """Live mode MUST raise NotImplementedError until Phase 4 wires
    google.cloud.storage.Client with CMEK + signed URLs."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    payload = _valid_input()
    with pytest.raises(NotImplementedError) as exc:
        assets_upload(payload)
    assert "Phase 4" in str(exc.value) or "live mode" in str(exc.value).lower()


# ─────────────────────────────────────────────────────────────────────────────
# 5. Cost attribute — D41 cost_watch hook.
# ─────────────────────────────────────────────────────────────────────────────


def test_capability_cost_attribute_published() -> None:
    """D41: per-tool USD cost surfaced as an attribute for cost_watch."""
    cost = getattr(assets_upload, "__capability_cost_usd__", None)
    assert cost is not None, "assets_upload missing cost attribute"
    assert isinstance(cost, float)
    # Cloud Storage Class A op is sub-cent.
    assert 0 < cost < 0.01, f"assets_upload per-call cost out of band: ${cost}"
