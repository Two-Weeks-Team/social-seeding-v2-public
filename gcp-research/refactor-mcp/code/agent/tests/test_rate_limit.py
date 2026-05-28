# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""A2 (P1 Sub-1.2) — unit + behavioural tests for tiktok_orchestrator.rate_limit.

Covers the IPBucketLimiter token math (per-IP, refill rate, burst) and the
RateLimitMiddleware end-to-end via FastAPI's TestClient (429 + Retry-After +
exempt paths + X-Forwarded-For).
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tiktok_orchestrator import rate_limit
from tiktok_orchestrator.rate_limit import IPBucketLimiter, RateLimitMiddleware


def _fake_clock(t: list[float]):
    """Return a closure that reads the head of ``t`` and lets callers tick it."""

    def now() -> float:
        return t[0]

    return now


def test_first_request_consumes_one_token() -> None:
    t = [0.0]
    limiter = IPBucketLimiter(rpm=60, burst=0, clock=_fake_clock(t))
    allowed, retry = limiter.acquire("1.2.3.4")
    assert allowed is True
    assert retry == 0.0


def test_capacity_exhausts_after_rpm_plus_burst() -> None:
    t = [0.0]
    limiter = IPBucketLimiter(rpm=10, burst=5, clock=_fake_clock(t))
    # Capacity = rpm + burst = 15
    for _ in range(15):
        allowed, _ = limiter.acquire("ip")
        assert allowed
    # 16th in the same tick is rate-limited
    allowed, retry = limiter.acquire("ip")
    assert allowed is False
    assert retry > 0


def test_per_ip_isolation() -> None:
    t = [0.0]
    limiter = IPBucketLimiter(rpm=5, burst=0, clock=_fake_clock(t))
    for _ in range(5):
        assert limiter.acquire("a")[0]
    # ip "a" exhausted; ip "b" should still get a full bucket
    assert limiter.acquire("a")[0] is False
    assert limiter.acquire("b")[0] is True


def test_tokens_refill_over_time() -> None:
    t = [0.0]
    limiter = IPBucketLimiter(rpm=60, burst=0, clock=_fake_clock(t))  # 1 token / sec
    for _ in range(60):
        assert limiter.acquire("ip")[0]
    assert limiter.acquire("ip")[0] is False
    # Advance 2 seconds → 2 tokens refilled
    t[0] = 2.0
    assert limiter.acquire("ip")[0]
    assert limiter.acquire("ip")[0]
    assert limiter.acquire("ip")[0] is False


def test_refill_caps_at_capacity() -> None:
    t = [0.0]
    limiter = IPBucketLimiter(rpm=60, burst=10, clock=_fake_clock(t))
    limiter.acquire("ip")
    # Wait 24 hours; refill must cap at capacity (rpm + burst = 70)
    t[0] = 86400.0
    for _ in range(70):
        assert limiter.acquire("ip")[0]
    assert limiter.acquire("ip")[0] is False


def test_retry_after_is_under_a_minute_for_default_rpm() -> None:
    t = [0.0]
    limiter = IPBucketLimiter(rpm=60, burst=0, clock=_fake_clock(t))
    for _ in range(60):
        limiter.acquire("ip")
    allowed, retry = limiter.acquire("ip")
    assert not allowed
    assert 0 < retry <= 1.5  # 1 token / sec refill → ~1s


# ----- middleware level ------------------------------------------------------


def _make_app(monkeypatch, limiter: IPBucketLimiter):
    """Build a tiny FastAPI app wired to a custom limiter (deterministic clock)."""
    # Make sure the disabled flag doesn't leak in via env.
    monkeypatch.setattr(rate_limit, "RATE_LIMIT_DISABLED", False)
    monkeypatch.setattr(rate_limit, "RATE_LIMIT_EXEMPT_PATHS", ("/livez", "/healthz", "/readyz", "/"))
    app = FastAPI()
    app.add_middleware(RateLimitMiddleware, limiter=limiter)

    @app.get("/livez")
    def livez():
        return {"status": "ok"}

    @app.post("/api/echo")
    def echo():
        return {"ok": True}

    return app


def test_middleware_blocks_with_429_after_capacity(monkeypatch) -> None:
    t = [0.0]
    limiter = IPBucketLimiter(rpm=3, burst=0, clock=_fake_clock(t))
    app = _make_app(monkeypatch, limiter)
    client = TestClient(app)

    for _ in range(3):
        r = client.post("/api/echo")
        assert r.status_code == 200
    r = client.post("/api/echo")
    assert r.status_code == 429
    assert r.headers["Retry-After"]
    body = r.json()
    assert body["error"] == "rate_limited"
    assert "per-IP" in body["error_description"]


def test_middleware_exempts_liveness_paths(monkeypatch) -> None:
    t = [0.0]
    limiter = IPBucketLimiter(rpm=1, burst=0, clock=_fake_clock(t))
    app = _make_app(monkeypatch, limiter)
    client = TestClient(app)
    # Exhaust the bucket on the API path
    assert client.post("/api/echo").status_code == 200
    assert client.post("/api/echo").status_code == 429
    # Liveness paths must still be reachable for Cloud Run probes
    for _ in range(5):
        assert client.get("/livez").status_code == 200


def test_middleware_uses_xff_left_most(monkeypatch) -> None:
    t = [0.0]
    limiter = IPBucketLimiter(rpm=2, burst=0, clock=_fake_clock(t))
    app = _make_app(monkeypatch, limiter)
    client = TestClient(app)
    # Two requests from one IP exhaust the bucket
    h1 = {"x-forwarded-for": "9.9.9.9, 10.0.0.1"}
    assert client.post("/api/echo", headers=h1).status_code == 200
    assert client.post("/api/echo", headers=h1).status_code == 200
    assert client.post("/api/echo", headers=h1).status_code == 429
    # A different XFF IP should still be allowed
    h2 = {"x-forwarded-for": "8.8.8.8"}
    assert client.post("/api/echo", headers=h2).status_code == 200


def test_middleware_respects_disabled_flag(monkeypatch) -> None:
    t = [0.0]
    limiter = IPBucketLimiter(rpm=1, burst=0, clock=_fake_clock(t))
    monkeypatch.setattr(rate_limit, "RATE_LIMIT_DISABLED", True)
    app = FastAPI()
    app.add_middleware(RateLimitMiddleware, limiter=limiter)

    @app.post("/api/echo")
    def echo():
        return {"ok": True}

    client = TestClient(app)
    for _ in range(10):
        assert client.post("/api/echo").status_code == 200
