"""Smoke tests for serve.py — the HTTP front the brand-campaign Cloud Workflow
calls (Wave 3 / Track 3).

These run fully offline (SS_OFFLINE=1 via conftest._isolate_env). run_agent's
offline path dispatches to `_run_with_stub`, which requires a `model_client` on
the RunContext. serve.py builds its own RunContext (production-honest — no test
hooks baked in), so we patch `serve._derive_run_context` to attach a
`ScriptedStub` carrying the agent's scripted output. This exercises the REAL
route handler, input validation, run_agent dispatch, and response shaping —
only the LLM call itself is stubbed.

Assertions mirror exactly what brand-campaign.workflows.yaml reads off each
response body:
    coordinator → `.body.chosenAgentId`               (bare CoordinatorOutput)
    sourcing    → `.body.kind` then `.body.value.candidates`  (Outcome envelope)
    vetting     → `.body.kind` then `.body.value`             (Outcome envelope)
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest
from fastapi.testclient import TestClient

import serve
from ss_agents.agents.coordinator import CoordinatorOutput
from ss_agents.agents.intake import (
    BrandProduct,
    CampaignBrief,
    Goals,
    Logistics,
    Targeting,
)
from ss_agents.agents.sourcing import (
    CandidateProposal,
    SourcingCreator,
    SourcingOutput,
)
from ss_agents.agents.vetting import TikTokCreator, VettedCandidate
from ss_agents.runtime import RunContext
from tests.conftest import ScriptedStub


@pytest.fixture
def client() -> TestClient:
    return TestClient(serve.app)


def _patch_stub(monkeypatch: pytest.MonkeyPatch, scripted_output: Any) -> ScriptedStub:
    """Replace serve._derive_run_context with one that attaches a ScriptedStub
    returning `scripted_output`, so run_agent's offline stub path produces a
    deterministic, valid result without a live Vertex call."""
    stub = ScriptedStub(turns=[scripted_output], usd_per_call=0.004)

    def _ctx_with_stub(body: dict[str, Any], **_kwargs: Any) -> RunContext:
        return RunContext(
            tenant_id="t_demo000000000000",
            workspace_id="ws_demo_serve_0001",
            trace_id="trace-serve-test",
            campaign_id=str(body.get("campaignId") or "") or None,
            invoked_by="pytest",
            model_client=stub,
        )

    monkeypatch.setattr(serve, "_derive_run_context", _ctx_with_stub)
    return stub


def _example_brief() -> dict[str, Any]:
    """The Hydra/Vitamin-C brief, camelCase JSON the workflow sends."""
    brief = CampaignBrief(
        workspaceId="ws_demo_serve_0001",
        createdBy="op@social-seeding.test",
        brandProduct=BrandProduct(
            name="Freshly Vitamin C Serum",
            category="skincare/serum",
            description="Brightening Vitamin C serum with hyaluronic acid.",
            keyClaims=["10% vitamin C", "fragrance-free", "vegan"],
        ),
        targeting=Targeting(
            creatorCount=20,
            minEngagementRate=0.03,
            languages=["ko"],
            hashtags=["스킨케어", "비타민C"],
        ),
        logistics=Logistics(shipsSamples=True),
        goals=Goals(
            targetLivePosts=15,
            deadline=dt.datetime(2026, 6, 30, 23, 59, tzinfo=dt.UTC),
        ),
    )
    return brief.model_dump(by_alias=True, mode="json")


# ─────────────────────────────────────────────────────────────────────────────
# Health / discovery
# ─────────────────────────────────────────────────────────────────────────────


def test_healthz_lists_agents(client: TestClient) -> None:
    resp = client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "ss-agents-adk"
    assert set(body["agents"]) == {"coordinator", "sourcing", "vetting"}


def test_root_and_livez_alias_healthz(client: TestClient) -> None:
    # Cloud Run reserves /healthz at the frontend, so "/" + "/livez" must answer.
    assert client.get("/").status_code == 200
    assert client.get("/livez").status_code == 200


def test_readyz_reports_offline_posture(client: TestClient) -> None:
    resp = client.get("/readyz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    # conftest forces SS_LIVE=0 + SS_OFFLINE=1.
    assert body["ss_live"] is False
    assert body["offline"] is True
    assert "model_garden_routing" in body


# ─────────────────────────────────────────────────────────────────────────────
# THE primary assertion: POST /coordinator returns a valid routing decision JSON
# the workflow's branch_on_route step switches on.
# ─────────────────────────────────────────────────────────────────────────────


def test_post_coordinator_returns_routing_decision(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    decision = CoordinatorOutput(
        chosenAgentId="tiktok-mcp-search",
        routingRationale="Remote A2A node best matches source_creators with lowest cost.",
        fallbackAgentId="sourcing",
        expectedCostUsd=0.012,
        expectedLatencyMs=3100,
        confidence=0.82,
    )
    _patch_stub(monkeypatch, decision)

    payload = {
        "taskDescription": "Source creators for brand campaign cmp_demo_001 — targeting Korean skincare.",
        "workspacePolicy": {
            "allowedAgents": [],
            "budgetRemainingUsd": 2.50,
            "slaTargetMs": 4000,
        },
        "candidateAgents": [
            {
                "agentId": "sourcing",
                "capabilities": ["source_creators", "tiktok", "rapidapi"],
                "avgLatencyMs": 2400,
                "avgCostUsd": 0.018,
                "transport": "in_process",
            },
            {
                "agentId": "tiktok-mcp-search",
                "capabilities": ["source_creators", "tiktok", "remote", "a2a"],
                "avgLatencyMs": 3100,
                "avgCostUsd": 0.012,
                "transport": "a2a_grpc",
            },
        ],
        "locale": "en",
        "allowRemote": True,
        "preferLocal": True,
    }
    resp = client.post("/coordinator", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # The workflow reads exactly this field in branch_on_route.
    assert body["chosenAgentId"] == "tiktok-mcp-search"
    assert body["fallbackAgentId"] == "sourcing"
    assert 0.0 <= body["confidence"] <= 1.0
    assert isinstance(body["routingRationale"], str) and body["routingRationale"]


def test_post_coordinator_escalation_still_has_chosen_agent_id(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # When run_agent escalates (here: the stubbed call costs more than the
    # coordinator's $0.005 cap → BudgetExceeded → Escalation), the bare-mode
    # response must STILL carry chosenAgentId="__escalate__" so the workflow's
    # branch_on_route can route to the HITL gate path, not crash on a missing
    # field.
    decision = CoordinatorOutput(
        chosenAgentId="sourcing",
        routingRationale="would have picked local sourcing",
        fallbackAgentId=None,
        expectedCostUsd=0.018,
        expectedLatencyMs=2400,
        confidence=0.7,
    )
    stub = ScriptedStub(turns=[decision], usd_per_call=5.0)  # >> $0.005 cap

    def _ctx_with_stub(body: dict[str, Any], **_kwargs: Any) -> RunContext:
        return RunContext(
            tenant_id="t_demo000000000000",
            workspace_id="ws_demo_serve_0001",
            trace_id="trace-serve-test",
            invoked_by="pytest",
            model_client=stub,
        )

    monkeypatch.setattr(serve, "_derive_run_context", _ctx_with_stub)

    payload = {
        "taskDescription": "route something",
        "workspacePolicy": {
            "allowedAgents": [],
            "budgetRemainingUsd": 1.0,
            "slaTargetMs": 4000,
        },
        "candidateAgents": [
            {
                "agentId": "sourcing",
                "capabilities": ["source_creators"],
                "avgLatencyMs": 2400,
                "avgCostUsd": 0.018,
                "transport": "in_process",
            }
        ],
    }
    resp = client.post("/coordinator", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["chosenAgentId"] == "__escalate__"
    assert "confidence" in body


# ─────────────────────────────────────────────────────────────────────────────
# Sourcing / vetting return the Outcome envelope the workflow reads via .kind.
# ─────────────────────────────────────────────────────────────────────────────


def test_post_sourcing_returns_outcome_envelope(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sourcing_out = SourcingOutput(
        candidates=[
            CandidateProposal(
                creator=SourcingCreator(
                    id="708",
                    uniqueId="skincare_kr",
                    nickname="K Skincare",
                    followerCount=82000,
                    followingCount=300,
                    videoCount=410,
                ),
                matchReasons=["bio mentions vitamin C serums and hyaluronic acid"],
                flags=[],
            )
        ],
        queriesUsed=["스킨케어 비타민C", "korean skincare serum"],
        coverageNote="found 1 in-range demo candidate",
    )
    _patch_stub(monkeypatch, sourcing_out)
    payload = {
        "brief": _example_brief(),
        "campaignId": "cmp_demo_001",
        "campaignBudgetUsd": 25.0,
        "excludeCreatorIds": [],
        "locale": "ko",
    }
    resp = client.post("/sourcing", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # The workflow reads .body.kind then .body.value.candidates.
    assert body["kind"] == "ok"
    assert isinstance(body["value"]["candidates"], list)
    assert body["value"]["candidates"][0]["creator"]["uniqueId"] == "skincare_kr"


def test_post_vetting_returns_outcome_envelope(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    vetted = VettedCandidate(
        creator=TikTokCreator(
            id="708",
            uniqueId="skincare_kr",
            nickname="K Skincare",
            followerCount=82000,
            followingCount=300,
            videoCount=410,
            engagementRate=0.05,
            language="ko",
        ),
        fitScore=0.78,
        flags=[],
        matchReasons=[
            "Content overlaps with skincare/serum category",
            "Engagement rate 5% clears the 3% floor",
            "Korean-language audience matches targeting",
        ],
        recommendedAction="shortlist",
        vettedAt=dt.datetime(2026, 5, 20, 12, 0, tzinfo=dt.UTC),
    )
    _patch_stub(monkeypatch, vetted)
    payload = {
        "brief": _example_brief(),
        "candidate": {
            "creator": {
                "id": "708",
                "uniqueId": "skincare_kr",
                "nickname": "K Skincare",
                "followerCount": 82000,
                "followingCount": 300,
                "videoCount": 410,
            },
            "matchReasons": ["bio mentions vitamin C serums"],
            "flags": [],
        },
        "campaignId": "cmp_demo_001",
    }
    resp = client.post("/vetting", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "ok"
    assert body["value"]["recommendedAction"] == "shortlist"
    assert 0.0 <= body["value"]["fitScore"] <= 1.0


# ─────────────────────────────────────────────────────────────────────────────
# Error contracts
# ─────────────────────────────────────────────────────────────────────────────


def test_unknown_agent_returns_404(client: TestClient) -> None:
    resp = client.post("/does-not-exist", json={"foo": "bar"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "unknown_agent"


def test_malformed_input_returns_422(client: TestClient) -> None:
    # Missing required CoordinatorInput fields → 422 (a workflow bug), not a
    # burned LLM call.
    resp = client.post("/coordinator", json={"taskDescription": "x"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "input_validation_failed"


def test_non_object_body_returns_400(client: TestClient) -> None:
    resp = client.post(
        "/coordinator", content="[]", headers={"content-type": "application/json"}
    )
    assert resp.status_code == 400
