"""FastAPI surface tests — no Vertex AI, no Identity Platform, no MCP server.

What's verified:
    * /healthz responds 200.
    * /.well-known/agent.json validates as A2A v0.3 (required fields + skill).
    * /.well-known/oauth-protected-resource carries the Identity Platform
      authorization-server URL.
    * /a2a/skills/plan_creator_search returns a well-formed RankedCreators
      envelope with the mandatory source_attribution string.
    * /v1/message:send (A2A v0.3 REST binding) returns a `task` artifact.
    * Auth-disabled mode (REQUIRE_AUTH=false) doesn't 401 callers.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tiktok_orchestrator.main import app


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


def test_healthz(client: TestClient) -> None:
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    # The handler also reports service identity for ops dashboards.
    assert body["service"] == "tiktok-orchestrator"
    assert "version" in body


def test_well_known_agent_card_required_fields(client: TestClient) -> None:
    r = client.get("/.well-known/agent.json")
    assert r.status_code == 200
    card = r.json()

    # PROTOCOLS.md §1.3 required fields
    required = {
        "name",
        "description",
        "url",
        "version",
        "capabilities",
        "defaultInputModes",
        "defaultOutputModes",
        "skills",
    }
    missing = required - set(card.keys())
    assert not missing, f"agent card missing required fields: {missing}"

    # At least one skill, and it must declare id/name/description/tags.
    assert isinstance(card["skills"], list) and card["skills"], "skills empty"
    first = card["skills"][0]
    for field in ("id", "name", "description", "tags"):
        assert field in first, f"skill missing {field}: {first.keys()}"

    # Marketplace agent.json (PROTOCOLS.md §3.1) wants provider + securitySchemes.
    # If present, the shape must hold; if missing we accept (stub card).
    if "securitySchemes" in card:
        for scheme in card["securitySchemes"].values():
            assert "type" in scheme

    # plan_creator_search MUST be the headline skill per REFACTOR-MCP §6.1.
    assert first["id"] == "plan_creator_search"


def test_well_known_oauth_protected_resource(client: TestClient) -> None:
    r = client.get("/.well-known/oauth-protected-resource")
    assert r.status_code == 200
    body = r.json()
    assert body["resource"]
    assert isinstance(body["authorization_servers"], list)
    assert body["scopes_supported"] == ["tiktok:read"]


def test_a2a_plan_returns_ranked_creators(client: TestClient) -> None:
    brief = "We are launching a vegan skincare line in Korea targeting Gen-Z."
    r = client.post(
        "/a2a/skills/plan_creator_search",
        json={"brand_brief": brief},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["brief"] == brief
    assert "Source: Social Seeding" in body["source_attribution"]
    assert isinstance(body["creators"], list)
    assert body["creators"], "Expected at least one ranked creator"

    for creator in body["creators"]:
        assert {"unique_id", "follower_count", "engagement_rate", "fit_score", "reasoning"} <= set(
            creator.keys()
        )
        assert 0.0 <= creator["engagement_rate"] <= 1.0
        assert 0.0 <= creator["fit_score"] <= 1.0
        assert creator["follower_count"] >= 5_000  # spam threshold (REFACTOR-MCP §3.3)


def test_a2a_plan_rejects_empty_brief(client: TestClient) -> None:
    r = client.post("/a2a/skills/plan_creator_search", json={"brand_brief": ""})
    assert r.status_code == 422  # FastAPI/Pydantic validation


def test_v1_message_send_returns_task_artifact(client: TestClient) -> None:
    r = client.post(
        "/v1/message:send",
        json={
            "message": {
                "kind": "message",
                "messageId": "msg-test-1",
                "role": "user",
                "parts": [{"kind": "text", "text": "Find KR pet creators 50-300k followers."}],
                "contextId": "ctx-test-1",
            }
        },
    )
    assert r.status_code == 200, r.text
    task = r.json()
    assert task["kind"] == "task"
    assert task["status"]["state"] == "completed"
    assert task["id"] == "msg-test-1"
    assert task["contextId"] == "ctx-test-1"
    assert task["artifacts"] and task["artifacts"][0]["parts"][0]["kind"] == "data"


def test_chat_endpoint_alias(client: TestClient) -> None:
    r = client.post("/chat", json={"brand_brief": "Fitness brand for Korean Gen-Z"})
    assert r.status_code == 200
    body = r.json()
    assert "creators" in body and body["source_attribution"].startswith("Source: Social Seeding")


def test_served_card_carries_verifiable_signature(client: TestClient) -> None:
    """The served /.well-known/agent.json must carry an A2A v0.3 signatures[]
    JWS that verifies against the JWKS the same service publishes."""
    from tiktok_orchestrator.card_signer import b64url_decode, verify_card_with_jwks

    card = client.get("/.well-known/agent.json").json()
    jwks = client.get("/.well-known/jwks.json").json()

    assert card.get("signatures"), "served card has no signatures[]"
    entry = card["signatures"][0]
    assert {"protected", "signature"} <= set(entry)

    import json as _json

    protected = _json.loads(b64url_decode(entry["protected"]))
    assert protected["alg"] == "ES256"
    assert protected["kid"] and protected["jku"].endswith("/.well-known/jwks.json")

    # JWKS publishes the matching EC/P-256 public key, and the card verifies.
    assert jwks["keys"] and jwks["keys"][0]["kty"] == "EC"
    assert verify_card_with_jwks(card, jwks) is True


def test_jwks_endpoint_shape(client: TestClient) -> None:
    r = client.get("/.well-known/jwks.json")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["keys"], list) and body["keys"]
    jwk = body["keys"][0]
    for field in ("kty", "crv", "x", "y", "kid", "use"):
        assert field in jwk
    # Only the public half is ever published — no private scalar 'd'.
    assert "d" not in jwk


# ---------------------------------------------------------------------------
# DAM-style A2A skill — get_brand_assets (Build Example #2, exposed half)
# ---------------------------------------------------------------------------


def test_agent_card_advertises_get_brand_assets_skill(client: TestClient) -> None:
    """The DAM-style skill must be discoverable on the agent card so the
    content_verify marketing agent can reach it over A2A (Build Example #2)."""
    card = client.get("/.well-known/agent.json").json()
    skill_ids = {s["id"] for s in card["skills"]}
    assert "plan_creator_search" in skill_ids
    assert "get_brand_assets" in skill_ids
    dam = next(s for s in card["skills"] if s["id"] == "get_brand_assets")
    for field in ("id", "name", "description", "tags"):
        assert field in dam


def test_a2a_get_brand_assets_alias_returns_brand_assets(client: TestClient) -> None:
    r = client.post(
        "/a2a/skills/get_brand_assets",
        json={
            "brand_name": "Freshly",
            "post_media_url": "gs://ss-v2-media/posts/p1/thumb.jpg",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["brand_name"] == "Freshly"
    assert isinstance(body["brand_assets"], list) and body["brand_assets"]
    asset = body["brand_assets"][0]
    assert {"asset_id", "kind", "uri"} <= set(asset.keys())
    assert body["on_brand"] is True
    assert body["logo_detected"] is True  # post media supplied
    assert 0.0 <= body["confidence_0_1"] <= 1.0
    assert "Source: Social Seeding" in body["source_attribution"]


def test_a2a_get_brand_assets_alias_rejects_empty_brand(client: TestClient) -> None:
    r = client.post("/a2a/skills/get_brand_assets", json={"brand_name": ""})
    assert r.status_code == 422  # Pydantic min_length=1


def test_v1_message_send_routes_to_get_brand_assets(client: TestClient) -> None:
    """A data part declaring skill=get_brand_assets routes to the DAM skill and
    returns a valid A2A task envelope whose data artifact is a BrandAssets blob.
    This is the exact shape ss_agents.tools.dam_get_brand_assets posts + parses."""
    r = client.post(
        "/v1/message:send",
        json={
            "message": {
                "kind": "message",
                "messageId": "msg-dam-1",
                "role": "user",
                "contextId": "ctx-dam-1",
                "parts": [
                    {
                        "kind": "text",
                        "text": "Retrieve approved brand assets for 'Freshly'.",
                    },
                    {
                        "kind": "data",
                        "data": {
                            "skill": "get_brand_assets",
                            "brand_name": "Freshly",
                            "post_media_url": "gs://ss-v2-media/posts/p1/thumb.jpg",
                        },
                    },
                ],
            }
        },
    )
    assert r.status_code == 200, r.text
    task = r.json()
    assert task["kind"] == "task"
    assert task["status"]["state"] == "completed"
    assert task["id"] == "msg-dam-1"
    data_part = task["artifacts"][0]["parts"][0]
    assert data_part["kind"] == "data"
    assets = data_part["data"]
    assert assets["brand_name"] == "Freshly"
    assert assets["on_brand"] is True
    assert assets["brand_assets"]


def test_v1_message_send_get_brand_assets_requires_brand_name(client: TestClient) -> None:
    r = client.post(
        "/v1/message:send",
        json={
            "message": {
                "kind": "message",
                "role": "user",
                "parts": [{"kind": "data", "data": {"skill": "get_brand_assets"}}],
            }
        },
    )
    assert r.status_code == 400


def test_v1_message_send_default_route_unaffected_by_data_part(client: TestClient) -> None:
    """A data part WITHOUT the DAM skill marker must not hijack the default
    plan_creator_search route — the text part still drives the creator search."""
    r = client.post(
        "/v1/message:send",
        json={
            "message": {
                "kind": "message",
                "role": "user",
                "parts": [
                    {"kind": "text", "text": "Find KR fitness creators 50-200k followers."},
                    {"kind": "data", "data": {"some": "unrelated"}},
                ],
            }
        },
    )
    assert r.status_code == 200, r.text
    task = r.json()
    artifact = task["artifacts"][0]["parts"][0]["data"]
    # plan_creator_search shape, not BrandAssets.
    assert "creators" in artifact


def test_get_brand_assets_unit_blank_brand_not_on_brand() -> None:
    """A blank brand name yields an empty, NOT-on-brand verdict so a mis-routed
    call can never pass as compliant."""
    from tiktok_orchestrator.agent import get_brand_assets

    out = get_brand_assets("   ")
    assert out.on_brand is False
    assert out.brand_assets == []


def test_get_brand_assets_unit_with_media_detects_logo() -> None:
    from tiktok_orchestrator.agent import get_brand_assets

    out = get_brand_assets("Freshly", post_media_url="gs://b/p.jpg")
    assert out.on_brand is True
    assert out.logo_detected is True
    assert out.confidence_0_1 > 0.0
    assert out.brand_assets and out.brand_assets[0].kind == "logo"
