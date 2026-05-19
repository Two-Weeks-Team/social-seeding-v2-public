"""Shared tool helpers.

Phase 2 ships stub implementations that:
  - Have proper type hints + docstrings (so ADK's schema introspection works).
  - Honor the dotted-name convention from `specs/_common/shared.schema.json#/$defs/ToolName`.
  - Return realistic-shaped responses so the agent's downstream logic can be
    tested without live infrastructure.

Phase 3 replaces these with real wrappers around:
  - 5 tiktok-* microservices (search-users, user-info, user-posts, post-detail,
    scraper-api per CLAUDE.md "TikTok scraper microservice family")
  - Gmail API (Workforce Identity Federation per D19)
  - RapidAPI (Instagram email-base study per O3)
"""
from __future__ import annotations

import hashlib
import logging
from typing import Any, TypedDict

import httpx

logger = logging.getLogger(__name__)


class UpsertResult(TypedDict):
    """Return type for `upsert_intake_form`."""

    form_id: str
    revision: int
    digest: str
    """SHA-256 of the canonicalized payload — referenced as `briefDigest`
    on the agent.t1.intake.brief_completed event (intake.spec.md §4)."""


def upsert_intake_form(workspace_id: str, payload: dict[str, Any]) -> UpsertResult:
    """Persist an in-progress intake brief to Spanner v2_briefs (D15).

    Args:
        workspace_id: v2 workspace id (`ws_…`). The brief lives under this key.
        payload:      The draft brief as a dict. Schema is governed by the
                      caller (intake.spec.md §2); this layer is content-blind
                      so re-shapes don't propagate here.

    Returns:
        UpsertResult with the persisted form id + revision + content digest.

    Notes:
        Phase 2 stub: computes the digest deterministically + echoes the
        result. Phase 3 wires this to the v2 capability layer (`forms.upsert`
        per intake.spec.md §6 table).
    """
    if not workspace_id or not workspace_id.startswith("ws_"):
        raise ValueError(f"invalid workspace_id: {workspace_id!r}")
    if not isinstance(payload, dict) or not payload:
        raise ValueError("payload must be a non-empty dict")

    canonical = _canonicalize(payload)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    form_id = f"f_{digest[:16]}"
    logger.info(
        "intake_form_upserted",
        extra={
            "workspace_id": workspace_id,
            "form_id": form_id,
            "digest": digest,
            "field_count": len(payload),
        },
    )
    return {"form_id": form_id, "revision": 1, "digest": digest}


def _canonicalize(obj: Any) -> str:
    """Deterministic JSON canonicalization for digest computation.

    Sorts dict keys recursively + uses `separators=(',', ':')`. Lists keep
    their order — list ordering is meaningful in the brief (e.g. `keyClaims`).
    """
    import json

    def _norm(x: Any) -> Any:
        if isinstance(x, dict):
            return {k: _norm(x[k]) for k in sorted(x.keys())}
        if isinstance(x, list):
            return [_norm(i) for i in x]
        return x

    return json.dumps(_norm(obj), separators=(",", ":"), ensure_ascii=False)


# ─────────────────────────────────────────────────────────────────────────────
# RapidAPI client stub — Phase 3 fills in.
# ─────────────────────────────────────────────────────────────────────────────


class _RapidApiClient:
    """Phase 2 placeholder. Phase 3 supplies a real httpx-based client.

    Kept here so the import path is stable for downstream agents.
    """

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url
        self.api_key = api_key
        self._client = httpx.Client(
            base_url=base_url,
            headers={"X-RapidAPI-Key": api_key},
            timeout=httpx.Timeout(30.0, connect=5.0),
        )

    def __enter__(self) -> "_RapidApiClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self._client.close()

    def __repr__(self) -> str:  # pragma: no cover — diagnostic only
        return f"_RapidApiClient(base_url={self.base_url!r}, api_key=***)"


def make_rapidapi_client(base_url: str, api_key: str) -> _RapidApiClient:
    """Construct a RapidAPI HTTP client (Phase 3 fills in real calls)."""
    return _RapidApiClient(base_url=base_url, api_key=api_key)


# ─────────────────────────────────────────────────────────────────────────────
# Gmail client stub — Phase 3 fills in.
# ─────────────────────────────────────────────────────────────────────────────


def gmail_send_stub(*, to: str, subject: str, body_html: str) -> dict[str, str]:
    """Phase 2 stub. Real implementation lives behind external_send policy
    gate per D27 (AP2 Intent Mandate) — never wired up here.

    Args:
        to:        Recipient email. Demo restricted to operator-owned accounts
                   (D10: e.g. `app.2weeks@gmail.com`).
        subject:   Plain-text subject line, ≤ 80 chars.
        body_html: HTML body. Unsubscribe footer + tracking pixel added by
                   the real sender (PORTING-V2.md §5 line 530).

    Returns:
        {"status": "stub_only", "to": ..., "message_id": "<stub>"}
    """
    if "@" not in to:
        raise ValueError(f"invalid recipient: {to!r}")
    if len(subject) > 80:
        raise ValueError(f"subject too long ({len(subject)} > 80)")
    logger.warning(
        "gmail_send_stub_invoked — Phase 2 placeholder, no email sent",
        extra={"to_hash": hashlib.sha256(to.encode()).hexdigest()[:12]},
    )
    return {
        "status": "stub_only",
        "to": to,
        "subject": subject,
        "message_id": "<stub-no-send>",
    }


__all__ = [
    "UpsertResult",
    "gmail_send_stub",
    "make_rapidapi_client",
    "upsert_intake_form",
]
