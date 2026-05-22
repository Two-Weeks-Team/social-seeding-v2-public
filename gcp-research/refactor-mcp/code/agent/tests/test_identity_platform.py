"""Unit tests for ``identity_platform.py`` — stub mode only.

Live verification against a real Identity Platform tenant requires Google
Application Default Credentials and is exercised in the integration test
harness (Phase 5 §5.4 Enterprise Standards eval).
"""

from __future__ import annotations

import base64
import json

import pytest

from tiktok_orchestrator import identity_platform as idp
from tiktok_orchestrator.identity_platform import (
    IdentityError,
    extract_bearer,
    protected_resource_metadata,
    verify_id_token,
)


# ---------------------------------------------------------------------------
# Helpers for the S2S (Google service-identity) path
# ---------------------------------------------------------------------------

_SA = "ss-agents@ss-v2-prod.iam.gserviceaccount.com"
_AUD = "https://mcp.socialseed.ing"


def _fake_jwt(claims: dict) -> str:
    """Build a routing-only JWT whose middle segment encodes ``claims``.

    The signature is not validated by ``_peek_issuer`` — these tokens exist
    only to exercise issuer routing; the verification seam is monkeypatched.
    """
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"hdr.{payload}.sig"


def _google_payload(**overrides: object) -> dict:
    payload = {
        "iss": "https://accounts.google.com",
        "aud": _AUD,
        "email": _SA,
        "email_verified": True,
        "sub": "100000000000000000001",
        "iat": 1,
        "exp": 2**31 - 1,
    }
    payload.update(overrides)
    return payload


def test_verify_id_token_stub_returns_claims() -> None:
    claims = verify_id_token("any-bearer-token-12345")
    assert claims.uid.startswith("stub-")
    assert claims.email and "@" in claims.email
    assert claims.email_verified is True


def test_verify_id_token_empty_raises() -> None:
    with pytest.raises(IdentityError) as ei:
        verify_id_token("")
    assert ei.value.code == "invalid_request"


def test_extract_bearer_happy_path() -> None:
    token = extract_bearer("Bearer eyJhbGciOi...")
    assert token == "eyJhbGciOi..."


def test_extract_bearer_rejects_missing_header() -> None:
    with pytest.raises(IdentityError) as ei:
        extract_bearer(None)
    assert ei.value.code == "invalid_request"


def test_extract_bearer_rejects_wrong_scheme() -> None:
    with pytest.raises(IdentityError) as ei:
        extract_bearer("Basic dXNlcjpwYXNz")
    assert ei.value.code == "invalid_request"


def test_extract_bearer_rejects_empty_token() -> None:
    with pytest.raises(IdentityError):
        extract_bearer("Bearer    ")


def test_protected_resource_metadata_shape() -> None:
    body = protected_resource_metadata()
    assert "resource" in body
    assert isinstance(body["authorization_servers"], list)
    assert body["scopes_supported"] == ["tiktok:read"]


def test_different_tokens_map_to_different_uids() -> None:
    a = verify_id_token("alpha-token-distinct")
    b = verify_id_token("beta-token-distinct")
    assert a.uid != b.uid


# ---------------------------------------------------------------------------
# Service-to-service (Google service-identity OIDC) path
# ---------------------------------------------------------------------------


def test_service_token_disabled_when_no_allowlist(monkeypatch) -> None:
    """Fail-closed: with no allowlist, the S2S path is off (Firebase-only)."""
    monkeypatch.setattr(idp, "ALLOWED_CALLER_SERVICE_ACCOUNTS", set())
    with pytest.raises(IdentityError) as ei:
        idp.verify_service_token("ya29.whatever")
    assert ei.value.code == "invalid_token"
    assert "not configured" in ei.value.description


def test_service_token_valid(monkeypatch) -> None:
    monkeypatch.setattr(idp, "ALLOWED_CALLER_SERVICE_ACCOUNTS", {_SA})
    monkeypatch.setattr(idp, "SERVICE_IDENTITY_AUDIENCES", {_AUD})
    monkeypatch.setattr(idp, "_verify_google_oidc", lambda _t: _google_payload())
    claims = idp.verify_service_token("token")
    assert claims.email == _SA
    assert claims.uid == "100000000000000000001"
    assert claims.tenant_id is None  # service identity, not a tenant user


def test_service_token_rejects_unallowlisted_sa(monkeypatch) -> None:
    monkeypatch.setattr(idp, "ALLOWED_CALLER_SERVICE_ACCOUNTS", {"someone-else@p.iam.gserviceaccount.com"})
    monkeypatch.setattr(idp, "SERVICE_IDENTITY_AUDIENCES", {_AUD})
    monkeypatch.setattr(idp, "_verify_google_oidc", lambda _t: _google_payload())
    with pytest.raises(IdentityError) as ei:
        idp.verify_service_token("token")
    assert "not allowlisted" in ei.value.description


def test_service_token_rejects_audience_mismatch(monkeypatch) -> None:
    monkeypatch.setattr(idp, "ALLOWED_CALLER_SERVICE_ACCOUNTS", {_SA})
    monkeypatch.setattr(idp, "SERVICE_IDENTITY_AUDIENCES", {"https://other.example"})
    monkeypatch.setattr(idp, "_verify_google_oidc", lambda _t: _google_payload())
    with pytest.raises(IdentityError) as ei:
        idp.verify_service_token("token")
    assert "audience" in ei.value.description


def test_service_token_rejects_non_google_issuer(monkeypatch) -> None:
    monkeypatch.setattr(idp, "ALLOWED_CALLER_SERVICE_ACCOUNTS", {_SA})
    monkeypatch.setattr(idp, "SERVICE_IDENTITY_AUDIENCES", {_AUD})
    monkeypatch.setattr(
        idp, "_verify_google_oidc", lambda _t: _google_payload(iss="https://evil.example")
    )
    with pytest.raises(IdentityError) as ei:
        idp.verify_service_token("token")
    assert "issuer" in ei.value.description


def test_service_token_rejects_unverified_email(monkeypatch) -> None:
    monkeypatch.setattr(idp, "ALLOWED_CALLER_SERVICE_ACCOUNTS", {_SA})
    monkeypatch.setattr(idp, "SERVICE_IDENTITY_AUDIENCES", {_AUD})
    monkeypatch.setattr(
        idp, "_verify_google_oidc", lambda _t: _google_payload(email_verified=False)
    )
    with pytest.raises(IdentityError):
        idp.verify_service_token("token")


def test_service_token_verification_failure_maps_to_401(monkeypatch) -> None:
    def _boom(_t: str) -> dict:
        raise ValueError("bad signature")

    monkeypatch.setattr(idp, "ALLOWED_CALLER_SERVICE_ACCOUNTS", {_SA})
    monkeypatch.setattr(idp, "_verify_google_oidc", _boom)
    with pytest.raises(IdentityError) as ei:
        idp.verify_service_token("token")
    assert ei.value.code == "invalid_token"
    assert ei.value.http_status == 401


def test_resolve_identity_routes_google_issuer_to_service(monkeypatch) -> None:
    monkeypatch.setattr(idp, "STUB_MODE", False)
    monkeypatch.setattr(idp, "ALLOWED_CALLER_SERVICE_ACCOUNTS", {_SA})
    monkeypatch.setattr(idp, "SERVICE_IDENTITY_AUDIENCES", {_AUD})
    monkeypatch.setattr(idp, "_verify_google_oidc", lambda _t: _google_payload())
    token = _fake_jwt({"iss": "https://accounts.google.com"})
    claims = idp.resolve_identity(token)
    assert claims.email == _SA


def test_resolve_identity_routes_firebase_issuer_to_firebase(monkeypatch) -> None:
    """A non-Google issuer must NOT take the service path even when configured."""
    monkeypatch.setattr(idp, "STUB_MODE", False)
    monkeypatch.setattr(idp, "ALLOWED_CALLER_SERVICE_ACCOUNTS", {_SA})

    called = {"firebase": False}

    def _fake_firebase(_t: str):
        called["firebase"] = True
        raise IdentityError("invalid_token", "firebase path taken")

    monkeypatch.setattr(idp, "verify_id_token", _fake_firebase)
    token = _fake_jwt({"iss": "https://securetoken.google.com/ss-v2-prod"})
    with pytest.raises(IdentityError):
        idp.resolve_identity(token)
    assert called["firebase"] is True


def test_resolve_identity_stub_short_circuits() -> None:
    # conftest sets IDENTITY_PLATFORM_STUB=1 → STUB_MODE True → canned claims.
    claims = idp.resolve_identity("anything-at-all")
    assert claims.uid.startswith("stub-")
