# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""A2 (P1 Sub-1.2) — per-IP rate limiting at the FastAPI layer.

Why not Cloud Armor: ss-mcp-server is exposed via Cloud Run's *.run.app
ingress (run.googleapis.com/ingress: all). Putting Cloud Armor in front
of Cloud Run requires standing up a Serverless NEG + Global HTTPS LB +
moving the public URL away from *.run.app. That migration is real but
breaks every live-evidence reference (HONEST-SCOPE rows, README, demo
script) and is out of scope for the D-8 sprint — it's tracked as P4 work
in docs/IMPROVEMENT-MASTER-PLAN.md.

What this provides instead: an in-memory token-bucket per remote IP. It
caps the damage one attacker can do per Cloud Run instance per minute
without needing any external state. Combined with `containerConcurrency`
+ `maxScale` caps in cloud-run-service.yaml, total fan-out under attack
is bounded. Not a substitute for Cloud Armor at scale (no cross-instance
state, no IP allow/deny lists), so it ships with a clear disclosure in
HONEST-SCOPE.

Tunables (env, with sensible defaults):
    RATE_LIMIT_RPM         requests per minute per IP (default 100)
    RATE_LIMIT_BURST       burst tokens above steady state (default 50)
    RATE_LIMIT_DISABLED    set "true"/"1" to disable (tests, local dev)
    RATE_LIMIT_EXEMPT_PATHS comma-separated path prefixes that bypass
                          (default: "/healthz,/livez,/readyz,/,/docs,
                          /redoc,/openapi.json,/.well-known/")
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("rate_limit: ignoring non-integer %s=%r, using %d", name, raw, default)
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).lower() in {"true", "1", "yes"}


RATE_LIMIT_RPM = _env_int("RATE_LIMIT_RPM", 100)
RATE_LIMIT_BURST = _env_int("RATE_LIMIT_BURST", 50)
RATE_LIMIT_DISABLED = _env_bool("RATE_LIMIT_DISABLED", False)
_DEFAULT_EXEMPT = "/healthz,/livez,/readyz,/,/docs,/redoc,/openapi.json,/.well-known/"
RATE_LIMIT_EXEMPT_PATHS = tuple(
    p.strip() for p in os.environ.get("RATE_LIMIT_EXEMPT_PATHS", _DEFAULT_EXEMPT).split(",") if p.strip()
)


@dataclass
class _Bucket:
    """Token bucket. ``tokens`` floats so the steady-state refill is smooth."""

    tokens: float
    updated_at: float


class IPBucketLimiter:
    """Thread-safe in-memory token bucket keyed by client IP.

    Token refill rate = RATE_LIMIT_RPM tokens per 60 seconds.
    Bucket capacity   = RATE_LIMIT_RPM + RATE_LIMIT_BURST (steady + burst).

    Each request consumes one token. If the bucket has none, the request is
    rejected with 429 + Retry-After. Buckets are kept in a dict; we GC stale
    ones lazily on access (any bucket idle > 10 minutes is dropped on the
    next touch of the same IP — keeps memory bounded under spray).
    """

    _GC_IDLE_SECONDS = 600

    def __init__(
        self,
        rpm: int = RATE_LIMIT_RPM,
        burst: int = RATE_LIMIT_BURST,
        clock: callable = time.monotonic,
    ) -> None:
        self.rpm = max(1, int(rpm))
        self.burst = max(0, int(burst))
        self.capacity = float(self.rpm + self.burst)
        self.refill_per_sec = self.rpm / 60.0
        self._clock = clock
        self._buckets: dict[str, _Bucket] = {}
        self._lock = threading.Lock()

    def _gc_locked(self, now: float) -> None:
        # O(stale) sweep instead of O(N): buckets are held in LRU order (a
        # touched bucket is moved to the end on access), so the oldest live at
        # the front. Drop expired buckets from the front and stop at the first
        # live one — avoids a full scan under the global lock when _buckets
        # grows large (IP spray / DoS).
        while self._buckets:
            ip = next(iter(self._buckets))
            bucket = self._buckets[ip]
            if (now - bucket.updated_at) > self._GC_IDLE_SECONDS:
                del self._buckets[ip]
            else:
                break

    def acquire(self, ip: str) -> tuple[bool, float]:
        """Try to consume one token for ``ip``.

        Returns ``(allowed, retry_after_seconds)``. When ``allowed`` is True,
        retry_after_seconds is 0. When False, it is the wall time the caller
        should wait before retrying.
        """
        now = self._clock()
        with self._lock:
            bucket = self._buckets.get(ip)
            if bucket is None:
                bucket = _Bucket(tokens=self.capacity, updated_at=now)
                self._buckets[ip] = bucket
                # Cheap occasional GC.
                if len(self._buckets) % 256 == 0:
                    self._gc_locked(now)
            else:
                elapsed = max(0.0, now - bucket.updated_at)
                bucket.tokens = min(self.capacity, bucket.tokens + elapsed * self.refill_per_sec)
                bucket.updated_at = now
                # Keep LRU order for _gc_locked: move the just-touched bucket to
                # the end so the front always holds the least-recently-used IP.
                del self._buckets[ip]
                self._buckets[ip] = bucket

            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                return True, 0.0
            # Compute how long until 1 token refills.
            deficit = 1.0 - bucket.tokens
            retry_after = deficit / self.refill_per_sec if self.refill_per_sec > 0 else 60.0
            return False, retry_after


# Module-level singleton — one bucket per Cloud Run instance.
_limiter = IPBucketLimiter()


def _is_exempt(path: str) -> bool:
    """Exact match for every entry; entries ending with ``/`` (other than
    ``/`` itself) additionally match every descendant path. Using prefix
    matching for ``/`` would shadow every request — guard against it."""
    for p in RATE_LIMIT_EXEMPT_PATHS:
        if path == p:
            return True
        if len(p) > 1 and p.endswith("/") and path.startswith(p):
            return True
    return False


def _client_ip(request: Request) -> str:
    # On Cloud Run, the real client IP is on X-Forwarded-For (left-most entry).
    # Fall back to the direct peer for local dev.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class RateLimitMiddleware(BaseHTTPMiddleware):
    """FastAPI middleware that gates non-exempt routes through ``IPBucketLimiter``."""

    def __init__(self, app, limiter: IPBucketLimiter | None = None) -> None:
        super().__init__(app)
        self.limiter = limiter or _limiter

    async def dispatch(self, request: Request, call_next):
        if RATE_LIMIT_DISABLED:
            return await call_next(request)
        if _is_exempt(request.url.path):
            return await call_next(request)
        ip = _client_ip(request)
        allowed, retry_after = self.limiter.acquire(ip)
        if not allowed:
            logger.warning(
                "rate_limit_block ip=%s path=%s retry_after=%.1fs", ip, request.url.path, retry_after
            )
            return JSONResponse(
                {
                    "error": "rate_limited",
                    "error_description": (
                        f"per-IP cap of {self.limiter.rpm} req/min reached; "
                        f"retry in {retry_after:.1f}s"
                    ),
                },
                status_code=429,
                headers={"Retry-After": str(max(1, int(retry_after)))},
            )
        return await call_next(request)


__all__ = ["IPBucketLimiter", "RateLimitMiddleware"]
