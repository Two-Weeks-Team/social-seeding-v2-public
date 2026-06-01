"""rapidapi_get_user_info — capability layer per D41.

Fetches a TikTok creator's full profile (followers, engagement_rate, recent
posts, public contact email if discoverable) via a RapidAPI-mediated source
per D14.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev):
    Deterministic canned data — the same input always produces the same
    output. Used in unit tests, /goal evaluator runs, and local agent dev.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real RapidAPI call wired by the W7 deploy phase (NotImplementedError
    today — surfacing a typed escalation rather than silently calling out).

Citations:
    D41 — Capability layer ADK FunctionTool pattern (stub/live env switch +
          per-tool USD cost attribute).
    D14 — TikTok sourcing remains RapidAPI-mediated.
    vetting.spec.md §6 — Tool table row for `rapidapi.get_user_info`.

Per-call cost: $0.0001 (sub-cent — keeps a 50-candidate vetting batch under
the $0.10/candidate USD cap stated in vetting.spec.md §6).
"""
from __future__ import annotations

import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `rapidapi_get_user_info.usd_cost`
for the runtime's `cost_watch` aggregator (D41)."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class RapidApiUserInfoInput(BaseModel):
    """Capability input. Mirrors vetting.spec.md §5 (sequence: `getUser(uniqueId)`).

    Attributes:
        creator_id: TikTok handle (`uniqueId`, e.g. `tt_001`, `beautyguru_kr`).
            Validated as a non-empty short string — full handle hygiene happens
            upstream in the sourcing agent.
        platform: Platform identifier. Currently only `tiktok` is wired; the
            field is present so adding `instagram` per O3 (Instagram email-base
            feasibility) does not break callers.
    """

    model_config = ConfigDict(extra="forbid")

    creator_id: str = Field(min_length=1, max_length=80)
    platform: Literal["tiktok", "instagram"] = "tiktok"


class RecentPost(BaseModel):
    """One recent post — minimal shape needed by `ranking.score` downstream."""

    model_config = ConfigDict(extra="forbid")

    post_id: str = Field(min_length=1, max_length=64)
    views: int = Field(ge=0)
    likes: int = Field(ge=0)
    comments: int = Field(ge=0)
    shares: int = Field(ge=0)


class RapidApiUserInfoOutput(BaseModel):
    """Capability output. Mirrors vetting.spec.md §5 sequence shape
    `{profile, recentPosts[]}` and the v2 contract at
    `packages/contracts/src/creator.ts` (TikTokCreatorSchema subset).
    """

    model_config = ConfigDict(extra="forbid")

    creator_id: str = Field(min_length=1, max_length=80)
    platform: Literal["tiktok", "instagram"]
    nickname: str = Field(default="", max_length=200)
    followers: int = Field(ge=0)
    following: int = Field(ge=0)
    video_count: int = Field(ge=0)
    engagement_rate: float = Field(ge=0.0, le=1.0)
    """0-1 ratio. vetting.spec.md §6 uses `minEngagementRate` ∈ [0,1]."""
    recent_posts: list[RecentPost] = Field(default_factory=list, max_length=50)
    public_email: str | None = Field(
        default=None,
        description=(
            "Contact email IF discoverable from the public bio / signature. "
            "Often None — D8 keeps the framing 'public data only'."
        ),
    )
    fetched_via: Literal["stub", "live"]
    """Which mode produced this row — included so downstream OTel traces can
    distinguish stubbed dev traffic from real RapidAPI traffic."""


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def rapidapi_get_user_info(payload: RapidApiUserInfoInput) -> RapidApiUserInfoOutput:
    """Fetch a creator's full profile + recent posts + public email if any.

    The runtime selects stub vs live via the `CAPABILITY_LAYER_MODE` env var
    (D41). Stub mode returns deterministic canned data; live mode performs
    the real RapidAPI HTTP call (wired in W7).

    Args:
        payload: Validated `RapidApiUserInfoInput`.

    Returns:
        `RapidApiUserInfoOutput` with the creator's metrics + recent posts.

    Raises:
        NotImplementedError: If `CAPABILITY_LAYER_MODE=live` — until W7 wires
            the real client. Caller surfaces as `EscalateToHuman`.
    """
    # SS_TIKTOK_LIVE=1 forces THIS tool live independent of the global
    # CAPABILITY_LAYER_MODE — so a deploy can turn TikTok fetching live (via
    # the backend.socialseed.ing proxy) without flipping the still-stubbed W7
    # tools (gmail/imagen/…) to live and breaking them.
    tiktok_live = os.getenv("SS_TIKTOK_LIVE") == "1"
    mode = "live" if tiktok_live else os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
rapidapi_get_user_info.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic canned data.
#
# Contract per the task brief:
#   for tt_001-style IDs:
#     followers=100000, engagement_rate=0.045, recent_posts (10 entries),
#     public_email=None.
#
# We honor the contract for the canonical `tt_001`-style ID and also produce
# stable, deterministic values for any other input (input → output is a pure
# function of `creator_id` + `platform` so golden tests stay reproducible).
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: RapidApiUserInfoInput) -> RapidApiUserInfoOutput:
    """Deterministic stub. Same input → same output, always."""
    canonical = _is_canonical_id(payload.creator_id)
    if canonical:
        followers = 100_000
        engagement_rate = 0.045
        recent_posts = _canonical_recent_posts()
        public_email = None
    else:
        # Stable derived values from the id — sufficient for tests of
        # non-canonical creators. Determinism comes from a tiny FNV-ish hash.
        h = _stable_hash(payload.creator_id)
        followers = 5_000 + (h % 9_000_000)  # 5k - ~9M
        engagement_rate = round(0.005 + ((h >> 8) % 1000) / 10_000.0, 4)  # 0.005-0.105
        recent_posts = _derived_recent_posts(payload.creator_id, h)
        public_email = None

    return RapidApiUserInfoOutput(
        creator_id=payload.creator_id,
        platform=payload.platform,
        nickname=f"@{payload.creator_id}",
        followers=followers,
        following=max(1, followers // 200),
        video_count=len(recent_posts) * 4,
        engagement_rate=engagement_rate,
        recent_posts=recent_posts,
        public_email=public_email,
        fetched_via="stub",
    )


def _is_canonical_id(creator_id: str) -> bool:
    """True for `tt_001`-style IDs per the task brief.

    Pattern: `tt_` prefix + 1-6 digits (e.g. `tt_001`, `tt_42`).
    """
    if not creator_id.startswith("tt_"):
        return False
    suffix = creator_id[3:]
    return bool(suffix) and suffix.isdigit() and len(suffix) <= 6


def _canonical_recent_posts() -> list[RecentPost]:
    """10 deterministic recent posts for `tt_001`-style IDs.

    Numbers chosen so engagement_rate ≈ 0.045 across the set (matches the
    canonical output the task brief specifies).
    """
    return [
        RecentPost(
            post_id=f"p_{i:03d}",
            views=10_000 + (i * 137),
            likes=400 + (i * 6),
            comments=20 + (i * 1),
            shares=10 + (i * 1),
        )
        for i in range(10)
    ]


def _derived_recent_posts(creator_id: str, h: int) -> list[RecentPost]:
    """Deterministic recent posts for non-canonical IDs.

    Derivation is purely a function of `creator_id` so two test runs against
    the same creator yield byte-identical outputs.
    """
    n = 5 + (h % 6)  # 5-10 posts
    return [
        RecentPost(
            post_id=f"p_{creator_id}_{i}",
            views=1000 + ((h * (i + 1)) % 50_000),
            likes=50 + ((h * (i + 2)) % 2_000),
            comments=2 + ((h * (i + 3)) % 200),
            shares=1 + ((h * (i + 4)) % 100),
        )
        for i in range(n)
    ]


def _stable_hash(s: str) -> int:
    """Tiny FNV-style 32-bit hash. Deterministic across Python versions
    (unlike `hash()`, which is salted per-process)."""
    h = 0x811C9DC5
    for ch in s.encode("utf-8"):
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


# ─────────────────────────────────────────────────────────────────────────────
# Live — fetch via the backend.socialseed.ing proxy (v1 parity; NOT RapidAPI
# directly). Auth uses a short-lived, auto-renewed X-API-Key (backend_client).
# ─────────────────────────────────────────────────────────────────────────────


def _to_int(value: object) -> int:
    try:
        n = int(float(value))  # tolerate "12345" / 12345.0
        return n if n >= 0 else 0
    except (TypeError, ValueError):
        return 0


def _live(payload: RapidApiUserInfoInput) -> RapidApiUserInfoOutput:
    """Live fetch via the backend.socialseed.ing proxy.

    The backend owns the fixed RapidAPI key + key-rotation; this tool
    authenticates with a short-lived, auto-renewed X-API-Key (see
    `backend_client`). Maps /user/info + /user/posts → the capability output.
    """
    if payload.platform != "tiktok":
        raise NotImplementedError(f"live mode: platform '{payload.platform}' not wired (tiktok only)")

    # Imported lazily so stub mode + offline tests never touch the HTTP client.
    from . import backend_client

    info = backend_client.fetch_user_info(payload.creator_id)
    user = info.get("user") or {}
    stats = info.get("stats") or {}
    raw_posts = backend_client.fetch_user_posts(payload.creator_id, count=20)

    recent_posts: list[RecentPost] = []
    for p in raw_posts:
        if not isinstance(p, dict):
            continue
        pid = p.get("id") or p.get("video_id") or p.get("aweme_id")
        if not pid:
            continue
        s = p.get("stats") if isinstance(p.get("stats"), dict) else p
        recent_posts.append(
            RecentPost(
                post_id=str(pid)[:64],
                views=_to_int(s.get("playCount") or s.get("play_count")),
                likes=_to_int(s.get("diggCount") or s.get("digg_count")),
                comments=_to_int(s.get("commentCount") or s.get("comment_count")),
                shares=_to_int(s.get("shareCount") or s.get("share_count")),
            )
        )
        if len(recent_posts) >= 50:
            break

    # engagement_rate ∈ [0,1]: Σ(likes+comments+shares) / Σ(views).
    total_views = sum(rp.views for rp in recent_posts)
    total_eng = sum(rp.likes + rp.comments + rp.shares for rp in recent_posts)
    engagement_rate = round(min(1.0, total_eng / total_views), 4) if total_views > 0 else 0.0

    followers = _to_int(stats.get("followerCount") or stats.get("follower_count") or user.get("followerCount"))
    following = _to_int(stats.get("followingCount") or stats.get("following_count") or user.get("followingCount"))
    video_count = _to_int(stats.get("videoCount") or stats.get("video_count") or user.get("videoCount"))
    nickname = str(user.get("nickname") or user.get("uniqueId") or payload.creator_id)[:200]

    return RapidApiUserInfoOutput(
        creator_id=payload.creator_id,
        platform=payload.platform,
        nickname=nickname,
        followers=followers,
        following=following,
        video_count=video_count,
        engagement_rate=engagement_rate,
        recent_posts=recent_posts,
        public_email=None,  # D8: only if discoverable from public bio; backend doesn't surface it
        fetched_via="live",
    )


__all__ = [
    "RapidApiUserInfoInput",
    "RapidApiUserInfoOutput",
    "RecentPost",
    "USD_COST",
    "rapidapi_get_user_info",
]
