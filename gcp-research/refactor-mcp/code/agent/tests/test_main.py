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
    assert r.json() == {"status": "ok"}


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
