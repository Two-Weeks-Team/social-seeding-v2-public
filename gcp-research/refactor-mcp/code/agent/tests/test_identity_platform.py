"""Unit tests for ``identity_platform.py`` — stub mode only.

Live verification against a real Identity Platform tenant requires Google
Application Default Credentials and is exercised in the integration test
harness (Phase 5 §5.4 Enterprise Standards eval).
"""

from __future__ import annotations

import pytest

from tiktok_orchestrator.identity_platform import (
    IdentityError,
    extract_bearer,
    protected_resource_metadata,
    verify_id_token,
)


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
