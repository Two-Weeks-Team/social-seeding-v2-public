# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""FastAPI entrypoint — Cloud Run public surface (port 8200).

Surfaces:
    * ``GET  /healthz``                           — liveness for Cloud Run probes
    * ``GET  /readyz``                            — readiness (checks MCP sidecar)
    * ``GET  /.well-known/agent.json``            — A2A discovery (REFACTOR-MCP §6.1)
    * ``GET  /.well-known/agent-card.json``       — alias (PROTOCOLS.md §1.3)
    * ``GET  /.well-known/jwks.json``             — public JWKS for card-signature
                                                     verification (A2A v0.3 signatures[])
    * ``GET  /.well-known/oauth-protected-resource``
                                                   — Identity Platform OAuth metadata
    * ``POST /a2a/skills/plan_creator_search``    — A2A skill invocation
    * ``POST /a2a/skills/get_brand_assets``       — DAM-style A2A skill (Build Example #2)
    * ``POST /chat``                              — conversational alias used by the demo video
    * ``POST /v1/message:send``                   — A2A v0.3 REST binding (PROTOCOLS.md §1.2);
                                                     routes to get_brand_assets when a `data`
                                                     part declares `skill="get_brand_assets"`

The HTTP layer is intentionally thin. Anything that talks to Gemini, Model
Armor, or Identity Platform lives in dedicated modules so each can be unit
tested in isolation.

Reference: REFACTOR-MCP.md §3.3 (Path A code, ~120 lines).
"""

from __future__ import annotations

import logging
import os
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import __version__
from .agent import (
    get_brand_assets,
    plan_creator_search,
    serialize,
    serialize_brand_assets,
)
from .card_signer import build_jwks, load_signing_key, sign_card
from .identity_platform import (
    IdentityClaims,
    IdentityError,
    extract_bearer,
    protected_resource_metadata,
    verify_id_token,
)

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())

# ---------------------------------------------------------------------------
# App configuration
# ---------------------------------------------------------------------------

MCP_BASE_URL = os.environ.get("MCP_BASE_URL", "http://localhost:8100")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://mcp.socialseed.ing")
AGENT_JSON_PATH = Path(__file__).parent.parent.parent.parent / "deployment" / "agent.json"

REQUIRE_AUTH = os.environ.get("REQUIRE_AUTH", "true").lower() in {"true", "1", "yes"}
ALLOW_ANONYMOUS_DISCOVERY = os.environ.get("ALLOW_ANONYMOUS_DISCOVERY", "true").lower() in {
    "true",
    "1",
    "yes",
}
# A2A v0.3 card signing (signatures[]). On by default so the served card always
# carries a verifiable JWS; set SIGN_AGENT_CARD=false to serve the raw card
# (e.g. when an upstream gateway signs). Dev key auto-managed under
# deployment/keys/ (git-ignored); production key via AGENT_CARD_SIGNING_KEY_PEM
# (Secret Manager). See AGENT-IDENTITY.md §3/§7 + card_signer.py.
SIGN_AGENT_CARD = os.environ.get("SIGN_AGENT_CARD", "true").lower() in {"true", "1", "yes"}

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="SocialSeeding Influencer Research Agent",
    description=(
        "ADK-driven A2A-compatible agent that turns a brand brief into a ranked "
        "top-10 TikTok creators list. Wraps the tiktok-mcp-server MCP toolset."
    ),
    version=__version__,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

# Tight CORS by default; the agent endpoint is server-to-server (Gemini
# Enterprise calls us from a known origin) so we don't need ``*``.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://gemini.google.com",
        "https://console.cloud.google.com",
        PUBLIC_BASE_URL,
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["authorization", "content-type", "mcp-session-id"],
)


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------


async def require_identity(authorization: str | None = Header(default=None)) -> IdentityClaims:
    """FastAPI dependency that resolves the Bearer token to ``IdentityClaims``."""
    if not REQUIRE_AUTH:
        # Dev / smoke mode — synthesize a fake identity so handlers keep
        # working without a tenant.
        return IdentityClaims(
            uid="dev-anonymous",
            email="dev@stub.socialseed.ing",
            email_verified=True,
            tenant_id="dev-tenant",
            issuer="dev",
            audience="dev",
            issued_at=0,
            expires_at=2**31 - 1,
            raw={"dev": True},
        )
    try:
        token = extract_bearer(authorization)
        return verify_id_token(token)
    except IdentityError as exc:
        raise HTTPException(
            status_code=exc.http_status,
            detail={"error": exc.code, "error_description": exc.description},
            headers={
                "WWW-Authenticate": (
                    f'Bearer error="{exc.code}", error_description="{exc.description}"'
                ),
            },
        ) from exc


# ---------------------------------------------------------------------------
# Public discovery surfaces
# ---------------------------------------------------------------------------


@app.get("/", include_in_schema=False)
@app.get("/healthz", include_in_schema=False)
@app.get("/livez", include_in_schema=False)
def healthz() -> dict[str, str]:
    # Aliased onto "/" and "/livez" as well: Google Cloud Run's HTTP frontend
    # reserves and intercepts the literal "/healthz" path before it reaches the
    # container, so a root-level liveness route is the reachable signal there.
    # Behind a custom domain / proxy that does not reserve "/healthz"
    # (e.g. mcp.socialseed.ing) the original path keeps working.
    return {"status": "ok", "service": "tiktok-orchestrator", "version": __version__}


@app.get("/readyz", include_in_schema=False)
async def readyz() -> JSONResponse:
    """Returns 200 only if the MCP sidecar's /health responds in time."""
    if not MCP_BASE_URL:
        return JSONResponse({"status": "no-mcp"}, status_code=200)
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=2.5) as client:
            resp = await client.get(f"{MCP_BASE_URL.rstrip('/')}/health")
        elapsed_ms = int((time.monotonic() - started) * 1000)
        if resp.status_code == 200:
            return JSONResponse(
                {"status": "ok", "mcp_health_ms": elapsed_ms},
                status_code=200,
            )
        return JSONResponse(
            {"status": "degraded", "mcp_status_code": resp.status_code},
            status_code=503,
        )
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            {"status": "unreachable", "error": str(exc)},
            status_code=503,
        )


def _load_card_from_disk() -> dict[str, Any]:
    """Read the on-disk canonical card, or a minimal stub for bare dev runs."""
    if AGENT_JSON_PATH.exists():
        import json as _json

        return _json.loads(AGENT_JSON_PATH.read_text(encoding="utf-8"))
    return {
        "protocolVersion": "0.3.0",
        "name": "Influencer Research Agent (TikTok)",
        "description": "Stub agent card — populate deployment/agent.json for production.",
        "url": PUBLIC_BASE_URL,
        "version": __version__,
        "capabilities": {"streaming": False, "pushNotifications": False},
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["application/json"],
        "skills": [
            {
                "id": "plan_creator_search",
                "name": "Plan and rank TikTok creators",
                "description": "Stub skill",
                "tags": ["tiktok"],
            }
        ],
    }


@lru_cache(maxsize=1)
def _signed_card_and_jwks() -> tuple[dict[str, Any], dict[str, Any]]:
    """Sign the on-disk card once and cache the (signed_card, jwks) pair.

    The agent card is static for the life of the process, so we sign on first
    request and serve the cached result thereafter. If signing is disabled or
    no key is resolvable, fall back to the raw card and an empty JWKS — the
    discovery surface must never hard-fail just because signing is off.
    """
    card = _load_card_from_disk()
    if not SIGN_AGENT_CARD:
        return card, {"keys": []}
    try:
        key = load_signing_key()
        return sign_card(card, key), build_jwks([key])
    except Exception as exc:  # noqa: BLE001 — signing is best-effort for discovery
        logger.warning("agent-card signing unavailable, serving unsigned card: %s", exc)
        return card, {"keys": []}


@app.get("/.well-known/agent.json", include_in_schema=False)
@app.get("/.well-known/agent-card.json", include_in_schema=False)
def agent_card() -> JSONResponse:
    """Serve the A2A v0.3 / Marketplace agent card.

    The on-disk ``deployment/agent.json`` is the source of truth. When card
    signing is enabled (default) we attach an A2A v0.3 ``signatures[]`` JWS
    entry (JCS-canonicalized per RFC 8785, RFC 7515 ES256) so any client can
    cryptographically verify the card's authorship against the JWKS served at
    ``/.well-known/jwks.json``. The unsigned content is otherwise byte-stable.
    """
    card, _ = _signed_card_and_jwks()
    return JSONResponse(content=card)


@app.get("/.well-known/jwks.json", include_in_schema=False)
def jwks() -> JSONResponse:
    """Public JWKS for verifying the agent card's ``signatures[]`` JWS.

    Exposes only the *public* half of the card-signing key (RFC 7517). This is
    the ``jku`` target referenced in each signature's protected header. Served
    unauthenticated (discovery posture) and cacheable.
    """
    _, jwks_doc = _signed_card_and_jwks()
    return JSONResponse(content=jwks_doc, headers={"Cache-Control": "max-age=300, public"})


@app.get("/.well-known/oauth-protected-resource", include_in_schema=False)
def well_known_oauth() -> JSONResponse:
    if not ALLOW_ANONYMOUS_DISCOVERY:
        # Some deployments want even the metadata gated behind auth.
        # We still respond, just with a 401 hint for clients.
        return JSONResponse(
            protected_resource_metadata(),
            status_code=200,
            headers={"Cache-Control": "max-age=300, public"},
        )
    return JSONResponse(
        protected_resource_metadata(),
        headers={"Cache-Control": "max-age=300, public"},
    )


# ---------------------------------------------------------------------------
# A2A skill — plan_creator_search
# ---------------------------------------------------------------------------


class BriefIn(BaseModel):
    """Input payload — matches REFACTOR-MCP §6.1 skill schema."""

    brand_brief: str = Field(
        ...,
        min_length=10,
        max_length=8_000,
        description="One or two paragraphs describing the brand + campaign goals.",
    )


@app.post("/a2a/skills/plan_creator_search")
async def a2a_plan(
    payload: BriefIn,
    identity: IdentityClaims = Depends(require_identity),
) -> dict[str, Any]:
    """A2A-callable skill — what Gemini Enterprise actually invokes.

    The response body conforms to ``RankedCreators`` and always carries
    ``source_attribution`` per the MCP licence terms (server.ts:79-93).
    """
    ranked = await plan_creator_search(payload.brand_brief, uid=identity.uid)
    return serialize(ranked)


# ---------------------------------------------------------------------------
# A2A v0.3 REST binding — minimal subset used by the demo
# ---------------------------------------------------------------------------


class A2AMessagePart(BaseModel):
    kind: str = Field(default="text")
    text: str | None = None
    # A2A v0.3 `data` part — carries a structured payload (e.g. the DAM
    # `get_brand_assets` request: {skill, brand_name, post_media_url}).
    data: dict[str, Any] | None = None


class A2AMessage(BaseModel):
    kind: str = Field(default="message")
    message_id: str | None = Field(default=None, alias="messageId")
    role: str = "user"
    parts: list[A2AMessagePart]
    context_id: str | None = Field(default=None, alias="contextId")

    model_config = {"populate_by_name": True}


class A2ASendRequest(BaseModel):
    message: A2AMessage
    configuration: dict[str, Any] | None = None


@app.post("/v1/message:send")
async def a2a_message_send(
    payload: A2ASendRequest,
    identity: IdentityClaims = Depends(require_identity),
) -> dict[str, Any]:
    """A2A v0.3 ``message/send`` REST binding (PROTOCOLS.md §1.2 table).

    The minimal binding we ship here is non-streaming (PROTOCOLS.md §1.4
    streaming is a v1.1 follow-up). Returns a ``task`` envelope with a single
    completed artifact whose ``data`` is the skill output blob.

    Skill routing: a `data` part declaring ``skill="get_brand_assets"`` routes
    to the DAM-style Build-Example-#2 skill (approved brand assets + on-brand
    verdict). Otherwise the message routes to ``plan_creator_search`` (the
    default) with the first `text` part as the brief.
    """
    text = ""
    data_part: dict[str, Any] | None = None
    for part in payload.message.parts:
        if part.kind == "text" and part.text and not text:
            text = part.text
        if part.kind == "data" and isinstance(part.data, dict) and data_part is None:
            data_part = part.data

    task_id = payload.message.message_id or f"task-{int(time.time() * 1000)}"
    context_id = payload.message.context_id or f"ctx-{int(time.time() * 1000)}"

    # ── DAM skill route (Build Example #2) ─────────────────────────────────
    if data_part is not None and data_part.get("skill") == "get_brand_assets":
        brand_name = str(data_part.get("brand_name") or "").strip()
        if not brand_name:
            raise HTTPException(
                status_code=400,
                detail="get_brand_assets requires a non-empty data.brand_name",
            )
        assets = get_brand_assets(
            brand_name, post_media_url=data_part.get("post_media_url")
        )
        artifact = serialize_brand_assets(assets)
        return {
            "kind": "task",
            "id": task_id,
            "contextId": context_id,
            "status": {"state": "completed", "timestamp": _now_iso()},
            "artifacts": [
                {
                    "artifactId": f"{task_id}-result",
                    "parts": [{"kind": "data", "data": artifact}],
                }
            ],
        }

    # ── Default route: plan_creator_search ─────────────────────────────────
    if not text:
        raise HTTPException(status_code=400, detail="message.parts[0] must be a text part")

    ranked = await plan_creator_search(text, uid=identity.uid)
    artifact = serialize(ranked)

    return {
        "kind": "task",
        "id": task_id,
        "contextId": context_id,
        "status": {"state": "completed", "timestamp": _now_iso()},
        "artifacts": [
            {
                "artifactId": f"{task_id}-result",
                "parts": [{"kind": "data", "data": artifact}],
            }
        ],
    }


# ---------------------------------------------------------------------------
# DAM-style A2A skill — get_brand_assets (Build Example #2, exposed half)
# ---------------------------------------------------------------------------


class BrandAssetsIn(BaseModel):
    """Input for the DAM `get_brand_assets` skill (Build Example #2)."""

    brand_name: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="The seeded brand whose approved assets the DAM should return.",
    )
    post_media_url: str | None = Field(
        default=None,
        max_length=2048,
        description="Optional gs:///https:// URI the on-brand verdict is computed against.",
    )


@app.post("/a2a/skills/get_brand_assets")
async def a2a_get_brand_assets(
    payload: BrandAssetsIn,
    identity: IdentityClaims = Depends(require_identity),
) -> dict[str, Any]:
    """Direct A2A skill alias for the DAM `get_brand_assets` skill.

    `designed_guide.pdf` p.7 Build Example #2 (exposed half): a marketing agent
    A2A-invokes the company's internal Digital Asset Manager (DAM) Agent to
    retrieve approved brand logos / product imagery and an on-brand compliance
    verdict. Social Seeding's `content_verify` agent is that marketing agent; it
    reaches this skill via `ss_agents.tools.dam_get_brand_assets` → `a2a_invoke`.

    Honest scope: DEMO DAM stand-in for a customer's real DAM; the A2A transport
    is genuine (A2A-INTENTS.md §5).
    """
    assets = get_brand_assets(payload.brand_name, post_media_url=payload.post_media_url)
    return serialize_brand_assets(assets)


# ---------------------------------------------------------------------------
# Demo conversational endpoint
# ---------------------------------------------------------------------------


@app.post("/chat")
async def chat(
    payload: BriefIn,
    identity: IdentityClaims = Depends(require_identity),
) -> dict[str, Any]:
    """Convenience endpoint used by the demo video — same as the A2A skill,
    but kept under a separate URL so the demo recording can target it
    directly without speaking the A2A envelope.
    """
    ranked = await plan_creator_search(payload.brand_brief, uid=identity.uid)
    return serialize(ranked)


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"error": str(exc)})


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# uvicorn entrypoint
# ---------------------------------------------------------------------------


def run() -> None:  # pragma: no cover — invoked via `python -m`
    import uvicorn

    uvicorn.run(
        "tiktok_orchestrator.main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8200")),
        log_level=os.environ.get("LOG_LEVEL", "info").lower(),
        reload=os.environ.get("RELOAD", "").lower() in {"1", "true", "yes"},
    )


if __name__ == "__main__":  # pragma: no cover
    run()
