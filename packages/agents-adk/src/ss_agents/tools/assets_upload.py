"""assets.upload — Cloud Storage workspace-scoped asset upload capability.

Phase 4 capability-layer tool wired into the **creative** agent
(`creative.spec.md §6`). Uploads a local file or a temporary GCS object
into the workspace-scoped creative assets bucket and returns the final
GCS URI + signed CDN URL + SHA-256 + size.

The creative workflow calls this AFTER `imagen_generate` / `veo_generate`
/ `lyria_generate` produce their initial outputs (which land in a
process-scoped staging URI) to promote them into the workspace bucket
with CMEK + the appropriate lifecycle rule.

Citations:
    D13 — Multi-region active-active. The workspace bucket is multi-
          region (US / EU / APAC); upload routes to the closest region
          per the caller's tenant.
    D20 — CMEK + DLP. Workspace buckets are encrypted with a per-tenant
          CMEK key; live wiring will pass the key ref through the upload
          call.
    D23 — Tier-1 agent #14 (creative, NEW) lists `assets.upload` as one
          of four callable capabilities.
    D33 — Asset retention via Cloud Storage lifecycle. Creative bucket
          has a 30-day lifecycle rule; the workspace_id scoping enforces
          tenant isolation.
    D41 — Capability layer ADK FunctionTool pattern. Canonical W2-A1 form;
          stub returns deterministic URLs keyed on (workspace_id, sha256,
          asset_kind), live raises NotImplementedError.

Contract (creative.spec.md §6 + task brief):

    Input:
        local_path_or_gcs_uri — source. Either a filesystem path or a
                                staging `gs://...` URI.
        workspace_id          — destination workspace scope. Must be a
                                v2 workspace id (`ws_…`).
        asset_kind            — one of "image" / "video" / "audio". Drives
                                MIME type, extension, and lifecycle rule.

    Output:
        final_gcs_uri  — `gs://ss-v2-creative/{workspace_id}/<sha>.<ext>`
                         in live mode; stub returns the same shape.
        cdn_url        — signed CDN URL valid ≤24h (creative.spec.md §2
                         Asset.publicUrl).
        sha256         — SHA-256 hex digest of the source (stub: of the
                         normalized source URI string).
        size_bytes     — size of the uploaded object.

Stub determinism (D41):
    For any valid input, the stub returns
        cdn_url = `https://stub.cdn.local/<workspace_id>/<sha256>.<ext>`
    where `<sha256>` is SHA-256(normalised_source_uri) and `<ext>` is
    derived from `asset_kind` (image → png, video → mp4, audio → mp3).
    The `final_gcs_uri` shadows `gs://ss-creative-stub/...` with the same
    relative path. `size_bytes` is a fixed 1024 in stub mode (byte-stable
    across invocations; real size requires reading the source which would
    break offline determinism). Same input → byte-identical output.

Input validation:
    * `local_path_or_gcs_uri` must be a non-empty string. Path-traversal
      patterns (`..`, leading `/`) are rejected — the workspace bucket
      MUST NOT receive inputs that escape the intended source directory.
    * `workspace_id` must match the v2 `ws_…` prefix convention. We do
      NOT enforce a downstream lookup here (the agent gateway already
      authorised the workspace); this is a syntactic guard against
      operator typos that would land assets under the wrong tenant.
    * `asset_kind` is one of the 3 supported values.

Live mode:
    Raises `NotImplementedError` with a pointer to the Phase 4 wiring task.
    The eventual implementation will use
    `google.cloud.storage.Client.bucket(...).blob(...).upload_from_*`
    with the per-tenant CMEK key + 30d lifecycle metadata, then call
    `bucket.blob(...).generate_signed_url(expiration=24h)` for the CDN
    URL.
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
            extra={"raw": raw, "fallback": "stub", "tool": "assets_upload"},
        )
        return "stub"
    return raw  # type: ignore[return-value]


# ─────────────────────────────────────────────────────────────────────────────
# Constants — workspace_id syntax, source path traversal, kind→extension.
# ─────────────────────────────────────────────────────────────────────────────


# v2 workspace ID convention: `ws_` prefix followed by 1-80 alnum / _ chars.
# The intake agent's CampaignBrief.workspaceId is the canonical source of
# this format; the regex tightens it for the syntactic guard below.
_WORKSPACE_ID_RE: Final[re.Pattern[str]] = re.compile(r"^ws_[A-Za-z0-9_-]{1,80}$")


AssetKind = Literal["image", "video", "audio"]
"""The 3 asset kinds the creative workflow produces. Drives extension,
MIME type, and lifecycle bucket selection at live wiring time."""


# Asset kind → file extension. The stub uses these to construct the CDN
# URL; live mode will use them to set Content-Type on the Cloud Storage
# blob.
_KIND_EXTENSIONS: Final[dict[str, str]] = {
    "image": "png",
    "video": "mp4",
    "audio": "mp3",
}


# Stub fixed size (in bytes). Real size requires reading the source; that
# would break offline determinism + force a filesystem dependency into
# unit tests. 1024 is conservative + obviously a placeholder.
_STUB_SIZE_BYTES: Final[int] = 1024


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic I/O schemas — the canonical D41 contract surface.
# ─────────────────────────────────────────────────────────────────────────────


class AssetsUploadInput(BaseModel):
    """Input schema for `assets_upload`.

    Validation:
        * `local_path_or_gcs_uri` non-empty; rejects path-traversal (`..`
          segments, leading `/` on a non-gs:// path) so the upload can
          never reference an unintended source.
        * `workspace_id` matches the v2 `ws_…` regex.
        * `asset_kind` is one of "image" / "video" / "audio".
    """

    model_config = ConfigDict(extra="forbid")

    local_path_or_gcs_uri: str = Field(
        min_length=1,
        max_length=2048,
        description=(
            "Source — a filesystem path or a `gs://...` staging URI. "
            "Path-traversal patterns are rejected at validation time."
        ),
    )
    workspace_id: str = Field(
        min_length=4,
        max_length=83,
        description="Destination workspace scope (`ws_...`).",
    )
    asset_kind: AssetKind = Field(
        description="One of image / video / audio — drives extension + MIME type.",
    )

    @field_validator("local_path_or_gcs_uri")
    @classmethod
    def _validate_source(cls, v: str) -> str:
        """Reject path-traversal patterns + normalise whitespace."""
        stripped = v.strip()
        if not stripped:
            raise ValueError("local_path_or_gcs_uri must be non-empty after strip")
        if stripped.startswith("gs://"):
            # gs:// URIs: reject `..` segments anywhere in the path.
            if ".." in stripped:
                raise ValueError(
                    f"gcs source URI contains path-traversal segment '..': {stripped[:64]!r}"
                )
            return stripped
        # Filesystem path: reject `..` segments AND absolute paths (we
        # treat absolute paths as suspicious here — the creative workflow
        # always supplies a path under its working dir, never under root).
        if ".." in stripped.split("/"):
            raise ValueError(
                f"local path contains path-traversal segment '..': {stripped[:64]!r}"
            )
        if stripped.startswith("/"):
            raise ValueError(
                f"local path must be relative (no leading '/'): {stripped[:64]!r}"
            )
        # Reject schemes other than gs:// (http://, file://, javascript:, …).
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", stripped):
            raise ValueError(
                f"unsupported scheme in source URI: {stripped[:64]!r} "
                "(only gs:// or relative filesystem paths are accepted)"
            )
        return stripped

    @field_validator("workspace_id")
    @classmethod
    def _validate_workspace_id(cls, v: str) -> str:
        """Enforce v2 workspace-id syntax."""
        stripped = v.strip()
        if not _WORKSPACE_ID_RE.match(stripped):
            raise ValueError(
                f"workspace_id must match ws_[A-Za-z0-9_-]{{1,80}} (got {stripped!r})"
            )
        return stripped


class AssetsUploadOutput(BaseModel):
    """Output schema for `assets_upload`."""

    model_config = ConfigDict(extra="forbid")

    final_gcs_uri: str = Field(
        pattern=r"^gs://",
        description="Final Cloud Storage URI under the workspace bucket.",
    )
    cdn_url: str = Field(
        pattern=r"^https?://",
        description=(
            "Signed CDN URL valid ≤24h (creative.spec.md §2 Asset.publicUrl). "
            "Stub returns https://stub.cdn.local/{workspace}/{sha}.{ext}."
        ),
    )
    sha256: str = Field(
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-f]{64}$",
        description="SHA-256 hex digest of the source bytes (stub: of the normalised source URI).",
    )
    size_bytes: int = Field(
        ge=0,
        description="Size of the uploaded object in bytes (stub: fixed 1024).",
    )


# ─────────────────────────────────────────────────────────────────────────────
# The capability function — what `creative.tools=[…]` receives.
# ─────────────────────────────────────────────────────────────────────────────


# Cloud Storage Class A operation (write) per 2026 H1 list — negligible
# per-call, dominated by storage + egress (which `cost_watch` aggregates
# from the bucket-level metric, not per-call). Surfaced as an attribute
# for shape parity with the other 3 capabilities.
_CAPABILITY_COST_USD: Final[float] = 0.0001


def assets_upload(input: AssetsUploadInput) -> AssetsUploadOutput:
    """Upload a creative asset to the workspace-scoped Cloud Storage bucket.

    Args:
        input: AssetsUploadInput — source + workspace + kind.

    Returns:
        AssetsUploadOutput — final_gcs_uri + cdn_url + sha256 + size_bytes.

    Behaviour by mode (CAPABILITY_LAYER_MODE env, D41):
        * ``"stub"`` (default) — returns deterministic URLs keyed on
          (workspace_id, SHA-256(source_uri), kind→ext). final_gcs_uri is
          `gs://ss-creative-stub/{workspace_id}/{sha}.{ext}`; cdn_url is
          `https://stub.cdn.local/{workspace_id}/{sha}.{ext}`. size_bytes
          is fixed at 1024 (offline determinism).
        * ``"live"`` — raises ``NotImplementedError`` until Phase 4 wires
          `google.cloud.storage.Client` with CMEK + signed URLs.

    Example:
        >>> out = assets_upload(AssetsUploadInput(
        ...     local_path_or_gcs_uri="gs://ss-creative-stub/img_1.png",
        ...     workspace_id="ws_demo_creative_1",
        ...     asset_kind="image",
        ... ))
        >>> out.cdn_url.startswith("https://stub.cdn.local/ws_demo_creative_1/")
        True
    """
    mode = _capability_mode()
    if mode == "live":
        raise NotImplementedError(
            "assets_upload live mode not yet implemented. Phase 4 will wire "
            "google.cloud.storage.Client with the per-tenant CMEK key + 30d "
            "lifecycle metadata and generate signed URLs with 24h expiration. "
            "Until then run with CAPABILITY_LAYER_MODE=stub (the default)."
        )

    ext = _KIND_EXTENSIONS[input.asset_kind]
    # Hash the normalised source URI so the output is byte-stable across
    # invocations (we never read the file in stub mode — that would force
    # a filesystem dependency into the unit tests).
    sha256 = hashlib.sha256(input.local_path_or_gcs_uri.encode("utf-8")).hexdigest()
    final_gcs_uri = f"gs://ss-creative-stub/{input.workspace_id}/{sha256}.{ext}"
    cdn_url = f"https://stub.cdn.local/{input.workspace_id}/{sha256}.{ext}"

    logger.debug(
        "assets_upload_stub_invoked",
        extra={
            "source_prefix": input.local_path_or_gcs_uri[:48],
            "workspace_id": input.workspace_id,
            "asset_kind": input.asset_kind,
        },
    )

    return AssetsUploadOutput(
        final_gcs_uri=final_gcs_uri,
        cdn_url=cdn_url,
        sha256=sha256,
        size_bytes=_STUB_SIZE_BYTES,
    )


# Per-tool USD cost surfaced as an attribute (D41 mandate).
assets_upload.__capability_cost_usd__ = _CAPABILITY_COST_USD  # type: ignore[attr-defined]


__all__ = [
    "AssetKind",
    "AssetsUploadInput",
    "AssetsUploadOutput",
    "assets_upload",
]
