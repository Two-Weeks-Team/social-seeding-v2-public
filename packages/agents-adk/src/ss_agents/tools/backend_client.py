"""backend_client — authenticated client for the v1 `backend.socialseed.ing`
proxy, with X-API-Key rotation (v1 `lib/api-key-rotation.ts` parity).

The ADK fleet does NOT call RapidAPI directly. Like v1 + the TS stack, it goes
through the Go backend proxy (which owns the fixed RapidAPI key + the
DB-cache → pool → RapidAPI fallback). The backend's X-API-Key is SHORT-LIVED
(~1h): we mint it via `POST {SS_BACKEND_URL}/auth/login` ({email,password} →
{success, api_key, api_key_expires_at}), cache it, and **auto-renew within the
hour** — refreshing proactively ≤60s before the key expires (and re-minting
once the 5-min cache lapses), so a long-running agent never sends a stale key.

Env:
    SS_BACKEND_URL            base (default https://backend.socialseed.ing)
    SS_BACKEND_API_KEY        static key (fixed-key/dev) — short-circuits login
    BACKEND_DASHBOARD_EMAIL   /auth/login email (e.g. sejun@2weeks.co)
    BACKEND_DASHBOARD_PASSWORD
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone
from urllib.parse import quote

import httpx

DEFAULT_BACKEND_URL = "https://backend.socialseed.ing"
_KEY_CACHE_TTL = 5 * 60.0        # re-check the key every 5 min
_KEY_REFRESH_AHEAD = 60.0        # ...and refresh ≥60s before it actually expires
_HTTP_TIMEOUT = 15.0

_lock = threading.Lock()
_key: str | None = None
_key_expires_at = 0.0  # epoch seconds the key itself expires
_key_cached_at = 0.0   # epoch seconds we last minted/checked


def base_url() -> str:
    return os.getenv("SS_BACKEND_URL", DEFAULT_BACKEND_URL).rstrip("/")


def reset_key_cache() -> None:
    """Drop the cached key — tests call this between cases."""
    global _key, _key_expires_at, _key_cached_at
    with _lock:
        _key = None
        _key_expires_at = 0.0
        _key_cached_at = 0.0


def _parse_expiry(value: object, now: float) -> float:
    """ISO-8601 → epoch seconds; fall back to now + cache TTL when unusable."""
    if isinstance(value, str) and value:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            ts = dt.timestamp()
            if ts > now:
                return ts
        except ValueError:
            pass
    return now + _KEY_CACHE_TTL


def _login_for_key(base: str) -> tuple[str, float]:
    email = os.getenv("BACKEND_DASHBOARD_EMAIL")
    password = os.getenv("BACKEND_DASHBOARD_PASSWORD")
    if not email or not password:
        raise RuntimeError(
            "SS_BACKEND_API_KEY unset and BACKEND_DASHBOARD_EMAIL/BACKEND_DASHBOARD_PASSWORD "
            "not set — cannot mint a backend.socialseed.ing key"
        )
    resp = httpx.post(
        f"{base}/auth/login",
        json={"email": email, "password": password},
        headers={"accept": "application/json"},
        timeout=_HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    if not data.get("success") or not data.get("api_key"):
        raise RuntimeError("backend.socialseed.ing /auth/login: response had no api_key")
    now = time.time()
    return str(data["api_key"]), _parse_expiry(data.get("api_key_expires_at"), now)


def get_active_backend_key(base: str | None = None) -> str:
    """Return a valid X-API-Key — static override, cached, or freshly minted.

    Auto-renews within the hour: re-mints once the 5-min cache lapses OR when
    the key is within 60s of its own expiry.
    """
    fixed = os.getenv("SS_BACKEND_API_KEY")
    if fixed:
        return fixed
    base = base or base_url()
    now = time.time()
    global _key, _key_expires_at, _key_cached_at
    with _lock:
        fresh_cache = now - _key_cached_at < _KEY_CACHE_TTL
        not_expiring = _key_expires_at - now > _KEY_REFRESH_AHEAD
        if _key and fresh_cache and not_expiring:
            return _key
        _key, _key_expires_at = _login_for_key(base)
        _key_cached_at = now
        return _key


def _get(path_with_query: str) -> dict:
    base = base_url()
    key = get_active_backend_key(base)
    resp = httpx.get(
        f"{base}{path_with_query}",
        headers={"X-API-Key": key, "accept": "application/json"},
        timeout=_HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_user_info(unique_id: str) -> dict:
    """GET /api/v1/user/info → normalized {user, stats}.

    The live envelope is `{ userInfo: { user, stats } }` (verified 2026-06-01);
    older/raw shapes nest under `user`/`data.user`. Return a flat
    `{"user": {...}, "stats": {...}}` for the mapper.
    """
    handle = unique_id.lstrip("@")
    body = _get(f"/api/v1/user/info?uniqueId={quote(handle, safe='')}")
    info = body.get("userInfo") or body.get("data") or body
    user = info.get("user") or info
    stats = info.get("stats") or user.get("stats") or {}
    return {"user": user, "stats": stats}


def fetch_user_posts(unique_id: str, count: int | None = None) -> list[dict]:
    """GET /api/v1/user/posts?preferRapidAPI=true → list of post dicts."""
    handle = unique_id.lstrip("@")
    q = f"uniqueId={quote(handle, safe='')}&preferRapidAPI=true"
    if count and count > 0:
        q += f"&count={min(count, 50)}"
    body = _get(f"/api/v1/user/posts?{q}")
    posts = body.get("posts")
    if posts is None and isinstance(body.get("data"), dict):
        posts = body["data"].get("posts")
    return list(posts) if isinstance(posts, list) else []


def fetch_gmail_token(email: str) -> dict:
    """GET /api/v1/user-tokens/{email} → the connected Gmail OAuth token.

    Returns the inner ``data`` object: ``{accessToken, refreshToken, expiresAt,
    scope, ...}``. The token is populated by the reusable connect flow
    (apps/web ``/api/auth/gmail/start`` → callback) — the same shared store v1
    uses. Raises if the account is not connected.
    """
    body = _get(f"/api/v1/user-tokens/{quote(email, safe='')}")
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict) or not (data.get("refreshToken") or data.get("accessToken")):
        raise RuntimeError(
            f"no connected Gmail token for {email!r} — connect it via "
            "apps/web /api/auth/gmail/start first"
        )
    return data
