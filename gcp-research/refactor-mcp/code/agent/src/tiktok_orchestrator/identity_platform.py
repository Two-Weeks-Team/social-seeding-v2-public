# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""Identity Platform OAuth verification (D19).

Replaces the SQLite-backed OAuth 2.1 server at
``microservices/tiktok-mcp-server/src/auth/oauth.ts``.

Rationale (REFACTOR-MCP §4.1):
    * In-container SQLite at ``/data/oauth.db`` does not survive Cloud Run
      autoscaling — every instance would have its own OAuth state.
    * Auto-approve ``/oauth/authorize`` ships no user identity → Marketplace
      review (Track 3 Phase 5 §5.4 Enterprise Standards) blocks anonymous
      flows for agent listings.
    * Custom DCR (`POST /oauth/register`) is superseded by Identity
      Platform's OIDC OP — clients self-register against Identity Platform
      directly, the agent only verifies tokens.

This module provides:

    * ``verify_id_token``  — async ID-token verifier (Firebase Admin SDK).
    * ``IdentityClaims``   — typed claim bundle returned to callers.
    * ``require_identity`` — FastAPI dependency that 401s on missing/invalid
                              Bearer tokens and exposes ``IdentityClaims``.

The MCP tool layer in the Node sidecar continues to enforce per-tool quotas
via ``withLimit()`` (``src/server.ts:22-69``); the migration plan in
REFACTOR-MCP §4.4 moves the quota key from a global ``(date, tool)`` row to a
per-uid ``(date, tool, uid)`` row backed by Firestore — that change happens
on the Node side and is patched separately (``ts-patches/``).

Authentication shape (matches REFACTOR-MCP §4.5 sketch):

    GET /.well-known/oauth-protected-resource
        -> {
            "resource": "...",
            "authorization_servers": [
                "https://identitytoolkit.googleapis.com/v1/projects/{project}"
                "/tenants/{tenant_id}"
            ],
            "scopes_supported": ["tiktok:read"]
           }

    Every /mcp call:
        Authorization: Bearer <Firebase ID token>

Failures return RFC 6750-compliant 401s:
    WWW-Authenticate: Bearer error="invalid_token", error_description="..."

The verifier supports two modes:
    * **production**  — uses ``firebase-admin``. Requires either
                         ``GOOGLE_APPLICATION_CREDENTIALS`` (path to JSON) or
                         ``GOOGLE_APPLICATION_CREDENTIALS_JSON`` (raw JSON).
    * **test / stub** — if ``IDENTITY_PLATFORM_STUB=1``, accept any Bearer
                         token and return a fixed claims bundle. Used by the
                         smoke-test harness so we don't need a live tenant.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration knobs
# ---------------------------------------------------------------------------

PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
TENANT_ID = os.environ.get("IDENTITY_PLATFORM_TENANT_ID", "")
STUB_MODE = os.environ.get("IDENTITY_PLATFORM_STUB", "").lower() in {"1", "true", "yes"}
CREDENTIALS_PATH = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")
CREDENTIALS_JSON = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON", "")

# Marketplace metadata
MCP_RESOURCE = os.environ.get("MCP_RESOURCE", "https://mcp.socialseed.ing")


# ---------------------------------------------------------------------------
# Service-to-service (S2S) identity — Google OIDC for the internal A2A hop (D44)
# ---------------------------------------------------------------------------
#
# Besides Firebase ID tokens (external / marketplace callers), the server also
# accepts a Google-signed service-identity OIDC token for the INTERNAL A2A hop.
# The ADK fleet's `ss_agents.tools.a2a_invoke` with `A2A_FETCH_ID_TOKEN=1` mints
# exactly this token (Google ID token, `aud` = this service's URL). This is the
# standard Cloud Run service-to-service auth pattern, and it avoids the 1-hour
# Firebase-token expiry problem on the internal path.
#
# Fail-closed: the S2S path is DISABLED unless ``ALLOWED_CALLER_SERVICE_ACCOUNTS``
# is set, so an unconfigured deploy only ever honours Firebase tokens. The token
# is accepted only when (1) it is Google-signed, (2) its ``aud`` is one of this
# service's URLs (``SERVICE_IDENTITY_AUDIENCES``), and (3) the caller's service
# account email is on the allowlist.
_GOOGLE_ISSUERS: frozenset[str] = frozenset(
    {"https://accounts.google.com", "accounts.google.com"}
)


def _csv_env(name: str) -> set[str]:
    raw = os.environ.get(name, "")
    return {item.strip() for item in raw.split(",") if item.strip()}


ALLOWED_CALLER_SERVICE_ACCOUNTS: set[str] = _csv_env("ALLOWED_CALLER_SERVICE_ACCOUNTS")
# Audiences this service accepts on an S2S token = its own public URL(s). The
# caller derives `aud` from the endpoint it POSTs to (run.app URL and/or the
# custom domain), so operators list every URL clients reach us on. Defaults to
# the marketplace resource URL.
SERVICE_IDENTITY_AUDIENCES: set[str] = _csv_env("SERVICE_IDENTITY_AUDIENCES") or {MCP_RESOURCE}


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class IdentityClaims:
    """Strictly-typed claim bundle extracted from a verified ID token."""

    uid: str
    email: str | None
    email_verified: bool
    tenant_id: str | None
    issuer: str
    audience: str
    issued_at: int
    expires_at: int
    raw: dict[str, Any]

    @property
    def is_anonymous(self) -> bool:
        return not self.email and self.uid.startswith("anon-")


class IdentityError(Exception):
    """Raised for any token-verification failure.

    The ``description`` is safe to surface to the caller in a
    ``WWW-Authenticate`` header per RFC 6750.
    """

    def __init__(self, code: str, description: str, *, http_status: int = 401) -> None:
        super().__init__(f"{code}: {description}")
        self.code = code
        self.description = description
        self.http_status = http_status


# ---------------------------------------------------------------------------
# Firebase admin lazy init
# ---------------------------------------------------------------------------

_firebase_app: Any = None


def _ensure_firebase_app() -> None:
    """Initialize the Firebase Admin SDK on first use.

    We import lazily so unit tests that run in stub mode never have to
    install or configure ``firebase-admin``.
    """
    global _firebase_app
    if _firebase_app is not None:
        return
    try:
        import firebase_admin  # type: ignore[import-not-found]
        from firebase_admin import credentials  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover — covered by CI
        raise IdentityError(
            "server_error",
            "firebase-admin not installed",
            http_status=500,
        ) from exc

    cred: Any | None = None
    if CREDENTIALS_JSON:
        try:
            cred = credentials.Certificate(json.loads(CREDENTIALS_JSON))
        except json.JSONDecodeError as exc:
            raise IdentityError(
                "server_error",
                "GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON",
                http_status=500,
            ) from exc
    elif CREDENTIALS_PATH:
        cred = credentials.Certificate(CREDENTIALS_PATH)
    # If neither is set, the SDK falls back to ADC (e.g. Cloud Run runtime SA).

    _firebase_app = firebase_admin.initialize_app(
        cred,
        {"projectId": PROJECT_ID} if PROJECT_ID else None,
        name="tiktok-orchestrator",
    )
    logger.info("firebase-admin initialized (project=%s, tenant=%s)", PROJECT_ID, TENANT_ID)


# ---------------------------------------------------------------------------
# Token verification
# ---------------------------------------------------------------------------


def verify_id_token(token: str) -> IdentityClaims:
    """Verify an Identity Platform ID token.

    Returns ``IdentityClaims`` on success, raises ``IdentityError`` otherwise.

    Stub mode (``IDENTITY_PLATFORM_STUB=1``):
        Accepts any non-empty token and returns a canned identity. Tests use
        this so they don't need a live tenant.
    """
    if not token:
        raise IdentityError("invalid_request", "Bearer token missing")

    if STUB_MODE:
        return _stub_claims(token)

    _ensure_firebase_app()
    from firebase_admin import auth as fb_auth  # type: ignore[import-not-found]

    try:
        decoded = fb_auth.verify_id_token(token, app=_firebase_app, check_revoked=False)
    except fb_auth.RevokedIdTokenError as exc:
        raise IdentityError("invalid_token", "token revoked") from exc
    except fb_auth.ExpiredIdTokenError as exc:
        raise IdentityError("invalid_token", "token expired") from exc
    except fb_auth.InvalidIdTokenError as exc:
        raise IdentityError("invalid_token", str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        # Defensive: any unexpected SDK error becomes a 401, not a 500 leak.
        logger.warning("verify_id_token unexpected failure", exc_info=True)
        raise IdentityError("invalid_token", "verification failed") from exc

    # Multi-tenant projects MUST also pin the tenant claim — otherwise a
    # token minted in tenant A could be replayed against tenant B. The
    # Firebase SDK's tenant-scoped client guards this automatically when
    # callers use `auth.tenant_manager.auth_for_tenant(tenant_id)`; we
    # additionally assert in code so the test path is explicit.
    decoded_tenant = decoded.get("firebase", {}).get("tenant")
    if TENANT_ID and decoded_tenant and decoded_tenant != TENANT_ID:
        raise IdentityError(
            "invalid_token", f"tenant mismatch (expected {TENANT_ID}, got {decoded_tenant})"
        )

    return IdentityClaims(
        uid=decoded["uid"],
        email=decoded.get("email"),
        email_verified=bool(decoded.get("email_verified")),
        tenant_id=decoded_tenant,
        issuer=str(decoded.get("iss", "")),
        audience=str(decoded.get("aud", "")),
        issued_at=int(decoded.get("iat", 0)),
        expires_at=int(decoded.get("exp", 0)),
        raw=dict(decoded),
    )


# ---------------------------------------------------------------------------
# Service-to-service token verification (Google OIDC) + issuer-routed resolver
# ---------------------------------------------------------------------------


def _peek_issuer(token: str) -> str:
    """Best-effort UNVERIFIED read of the JWT ``iss`` claim, for routing only.

    This does NOT validate the signature — it only decides which verifier to
    run. The selected verifier (Firebase or Google OIDC) then performs full
    cryptographic validation. A malformed token returns ``""`` and routes to
    the Firebase verifier, which rejects it.
    """
    try:
        payload_segment = token.split(".")[1]
        padded = payload_segment + "=" * (-len(payload_segment) % 4)
        claims = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
        return str(claims.get("iss", ""))
    except Exception:  # noqa: BLE001 — routing only; any failure → Firebase path
        return ""


def _verify_google_oidc(token: str) -> dict[str, Any]:
    """Cryptographically verify a Google-signed OIDC ID token.

    Network seam (tests monkeypatch this): fetches Google's public certs and
    validates the signature, the ``accounts.google.com`` issuer, and expiry.
    Audience is checked by the caller against ``SERVICE_IDENTITY_AUDIENCES`` so
    more than one accepted URL (run.app + custom domain) is supported.
    """
    import google.auth.transport.requests as ga_requests
    from google.oauth2 import id_token as ga_id_token

    return dict(ga_id_token.verify_oauth2_token(token, ga_requests.Request()))


def verify_service_token(token: str) -> IdentityClaims:
    """Verify a Google service-identity OIDC token for the internal A2A hop.

    Fail-closed: raises ``IdentityError`` unless an allowlist is configured AND
    the token is Google-signed AND its audience is one of this service's URLs
    AND the caller's service-account email is allowlisted + verified.
    """
    if not token:
        raise IdentityError("invalid_request", "Bearer token missing")
    if not ALLOWED_CALLER_SERVICE_ACCOUNTS:
        raise IdentityError("invalid_token", "service-identity path not configured")

    try:
        decoded = _verify_google_oidc(token)
    except IdentityError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise IdentityError("invalid_token", "google id token verification failed") from exc

    issuer = str(decoded.get("iss", ""))
    if issuer not in _GOOGLE_ISSUERS:
        raise IdentityError("invalid_token", f"unexpected issuer {issuer!r}")

    audience = str(decoded.get("aud", ""))
    if audience not in SERVICE_IDENTITY_AUDIENCES:
        raise IdentityError("invalid_token", "audience not accepted for this service")

    email = decoded.get("email")
    if not email or not bool(decoded.get("email_verified")):
        raise IdentityError("invalid_token", "service account email unverified")
    if email not in ALLOWED_CALLER_SERVICE_ACCOUNTS:
        raise IdentityError("invalid_token", "caller service account not allowlisted")

    return IdentityClaims(
        uid=str(decoded.get("sub") or email),
        email=str(email),
        email_verified=True,
        tenant_id=None,
        issuer=issuer,
        audience=audience,
        issued_at=int(decoded.get("iat", 0)),
        expires_at=int(decoded.get("exp", 0)),
        raw=dict(decoded),
    )


def resolve_identity(token: str) -> IdentityClaims:
    """Resolve a Bearer token to ``IdentityClaims``, routing by issuer.

    * Stub mode short-circuits (tests / smoke) — any token → canned claims.
    * Google-issued tokens (``accounts.google.com``) → the S2S service-identity
      path, but only when ``ALLOWED_CALLER_SERVICE_ACCOUNTS`` is configured.
    * Everything else (incl. Firebase ``securetoken`` tokens) → Firebase
      Identity Platform verification.
    """
    if not token:
        raise IdentityError("invalid_request", "Bearer token missing")
    if STUB_MODE:
        return _stub_claims(token)
    if ALLOWED_CALLER_SERVICE_ACCOUNTS and _peek_issuer(token) in _GOOGLE_ISSUERS:
        return verify_service_token(token)
    return verify_id_token(token)


# ---------------------------------------------------------------------------
# FastAPI helpers
# ---------------------------------------------------------------------------


def extract_bearer(authorization_header: str | None) -> str:
    """Return the bare token from an ``Authorization: Bearer ...`` header.

    Raises ``IdentityError(invalid_request)`` if missing or malformed so the
    caller can map directly to a 401 + WWW-Authenticate.
    """
    if not authorization_header:
        raise IdentityError("invalid_request", "Authorization header missing")
    parts = authorization_header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise IdentityError("invalid_request", "Authorization must use Bearer scheme")
    token = parts[1].strip()
    if not token:
        raise IdentityError("invalid_request", "Bearer token empty")
    return token


def protected_resource_metadata() -> dict[str, Any]:
    """``/.well-known/oauth-protected-resource`` body.

    Mirrors REFACTOR-MCP §4.5 sketch; the authorization server points at
    the Identity Platform tenant.
    """
    auth_server = (
        f"https://identitytoolkit.googleapis.com/v1/projects/{PROJECT_ID}"
        f"/tenants/{TENANT_ID}"
        if PROJECT_ID and TENANT_ID
        else f"{MCP_RESOURCE}/.well-known/oauth-authorization-server"
    )
    return {
        "resource": MCP_RESOURCE,
        "authorization_servers": [auth_server],
        "scopes_supported": ["tiktok:read"],
        "resource_documentation": "https://docs.socialseed.ing/agent",
    }


# ---------------------------------------------------------------------------
# Stub mode helpers
# ---------------------------------------------------------------------------


def _stub_claims(token: str) -> IdentityClaims:
    """Construct a deterministic claims bundle for tests.

    The token's first 12 chars are used as the uid suffix so different test
    tokens map to different uids (so per-uid quota tests work).
    """
    suffix = token[:12].replace(".", "_").replace("-", "_") or "stubuser"
    return IdentityClaims(
        uid=f"stub-{suffix}",
        email=f"{suffix}@stub.socialseed.ing",
        email_verified=True,
        tenant_id=TENANT_ID or "stub-tenant",
        issuer="https://identitytoolkit.googleapis.com/stub",
        audience=PROJECT_ID or "stub-project",
        issued_at=0,
        expires_at=2**31 - 1,
        raw={"stub": True, "token_prefix": token[:8]},
    )


__all__ = [
    "IdentityClaims",
    "IdentityError",
    "verify_id_token",
    "verify_service_token",
    "resolve_identity",
    "extract_bearer",
    "protected_resource_metadata",
    "STUB_MODE",
    "TENANT_ID",
    "PROJECT_ID",
    "MCP_RESOURCE",
    "ALLOWED_CALLER_SERVICE_ACCOUNTS",
    "SERVICE_IDENTITY_AUDIENCES",
]
