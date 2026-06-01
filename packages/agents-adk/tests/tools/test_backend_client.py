"""Tests for `backend_client` — backend.socialseed.ing auth + X-API-Key rotation.

Offline: httpx is monkeypatched, no network. Covers:
    · static SS_BACKEND_API_KEY short-circuits /auth/login
    · /auth/login mints a key and caches it (one login across two calls)
    · missing creds → RuntimeError
    · proactive renewal: a key near expiry triggers a fresh /auth/login
"""
from __future__ import annotations

import time

import pytest

from ss_agents.tools import backend_client


@pytest.fixture(autouse=True)
def _reset(monkeypatch: pytest.MonkeyPatch):
    backend_client.reset_key_cache()
    for k in ("SS_BACKEND_API_KEY", "BACKEND_DASHBOARD_EMAIL", "BACKEND_DASHBOARD_PASSWORD", "SS_BACKEND_URL"):
        monkeypatch.delenv(k, raising=False)
    yield
    backend_client.reset_key_cache()


class _Resp:
    def __init__(self, payload: dict, status: int = 200) -> None:
        self._payload = payload
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict:
        return self._payload


def test_static_key_short_circuits_login(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SS_BACKEND_API_KEY", "fixed_key_123")
    calls = {"login": 0}

    def _post(*a, **k):  # pragma: no cover - must NOT be hit
        calls["login"] += 1
        return _Resp({"success": True, "api_key": "x"})

    monkeypatch.setattr(backend_client.httpx, "post", _post)
    assert backend_client.get_active_backend_key() == "fixed_key_123"
    assert calls["login"] == 0


def test_login_mints_and_caches_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BACKEND_DASHBOARD_EMAIL", "sejun@2weeks.co")
    monkeypatch.setenv("BACKEND_DASHBOARD_PASSWORD", "pw")
    logins = {"n": 0}

    def _post(url, json=None, headers=None, timeout=None):
        logins["n"] += 1
        assert url.endswith("/auth/login")
        assert json == {"email": "sejun@2weeks.co", "password": "pw"}
        # expires well in the future so the cache holds
        return _Resp({"success": True, "api_key": "rotated_abc", "api_key_expires_at": "2099-01-01T00:00:00Z"})

    monkeypatch.setattr(backend_client.httpx, "post", _post)
    k1 = backend_client.get_active_backend_key("https://backend.socialseed.ing")
    k2 = backend_client.get_active_backend_key("https://backend.socialseed.ing")
    assert k1 == k2 == "rotated_abc"
    assert logins["n"] == 1  # cached across the two calls


def test_missing_credentials_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(RuntimeError, match="BACKEND_DASHBOARD_EMAIL"):
        backend_client.get_active_backend_key("https://backend.socialseed.ing")


def test_proactive_renewal_near_expiry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BACKEND_DASHBOARD_EMAIL", "sejun@2weeks.co")
    monkeypatch.setenv("BACKEND_DASHBOARD_PASSWORD", "pw")
    logins = {"n": 0}
    # First login returns a key that expires within the 60s refresh window.
    seq = [
        {"success": True, "api_key": "k_old", "api_key_expires_at": _iso(time.time() + 30)},
        {"success": True, "api_key": "k_new", "api_key_expires_at": _iso(time.time() + 3600)},
    ]

    def _post(*a, **k):
        i = min(logins["n"], len(seq) - 1)
        logins["n"] += 1
        return _Resp(seq[i])

    monkeypatch.setattr(backend_client.httpx, "post", _post)
    first = backend_client.get_active_backend_key("https://backend.socialseed.ing")
    second = backend_client.get_active_backend_key("https://backend.socialseed.ing")
    # near-expiry key is NOT reused — a fresh login mints k_new
    assert first == "k_old"
    assert second == "k_new"
    assert logins["n"] == 2


def _iso(epoch: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")
