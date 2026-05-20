"""tests/tools/test_a2a_invoke.py — capability-layer seam tests.

Covers:
  - Stub determinism for `https://stub.local/agent/<id>` endpoints.
  - Timeout edge: timeout_s=1 (min), timeout_s=120 (max), out-of-range rejection.
  - Stub rejects non-allow-listed endpoints with ValueError.
  - Live mode (mocked httpx): A2A v0.3 message/send envelope build, task-envelope
    parse, success/failure mapping, retry on 5xx, identity-token header.
  - Pydantic validation: http:// scheme rejected, unknown field rejected.

The live tests mock `httpx.post` so the suite stays offline + deterministic.
The REAL cross-component hop (coordinator → a2a_invoke → ss-mcp-server) is
exercised by `scripts/smoke-test/run-integration-a2a.sh` (D45 proof).
"""
from __future__ import annotations

from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from ss_agents.tools.a2a_invoke import (
    USD_COST,
    A2AInvokeInput,
    A2AInvokeOutput,
    _build_a2a_message,
    _extract_response_payload,
    a2a_invoke,
)

# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub happy path — deterministic success
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_deterministic_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://stub.local/agent/sourcing",
            taskPayload={"kind": "source_creators", "n": 20},
            timeoutS=10,
            correlationId="trace-001",
        )
    )
    assert isinstance(out, A2AInvokeOutput)
    assert out.succeeded is True
    assert out.error is None
    assert out.latency_ms == 100  # timeout_s (10) * 10
    assert out.response_payload["agent_id"] == "sourcing"
    assert out.response_payload["correlation_id"] == "trace-001"
    assert out.response_payload["echo"] == {"kind": "source_creators", "n": 20}


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = A2AInvokeInput(
        remoteAgentEndpoint="https://stub.local/agent/vetting",
        taskPayload={"k": "v"},
        timeoutS=5,
        correlationId="trace-002",
    )
    a = a2a_invoke(payload)
    b = a2a_invoke(payload)
    assert a.model_dump_json() == b.model_dump_json()


def test_stub_derives_distinct_agent_ids() -> None:
    """Two different stub endpoints ⇒ two different derived agent_ids."""
    a = a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://stub.local/agent/sourcing",
            taskPayload={},
            timeoutS=5,
            correlationId="c1",
        )
    )
    b = a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://stub.local/agent/critic",
            taskPayload={},
            timeoutS=5,
            correlationId="c2",
        )
    )
    assert a.response_payload["agent_id"] == "sourcing"
    assert b.response_payload["agent_id"] == "critic"


# ─────────────────────────────────────────────────────────────────────────────
# 2. Timeout edge cases
# ─────────────────────────────────────────────────────────────────────────────


def test_timeout_edge_min() -> None:
    """timeout_s=1 is the minimum allowed value."""
    out = a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://stub.local/agent/intake",
            taskPayload={},
            timeoutS=1,
            correlationId="trace-min",
        )
    )
    assert out.latency_ms == 10


def test_timeout_edge_max() -> None:
    """timeout_s=120 is the maximum allowed value."""
    out = a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://stub.local/agent/intake",
            taskPayload={},
            timeoutS=120,
            correlationId="trace-max",
        )
    )
    assert out.latency_ms == 1200


def test_timeout_below_min_rejected() -> None:
    """timeout_s=0 fails Pydantic ge=1."""
    with pytest.raises(ValidationError):
        A2AInvokeInput(
            remoteAgentEndpoint="https://stub.local/agent/intake",
            taskPayload={},
            timeoutS=0,
            correlationId="trace",
        )


def test_timeout_above_max_rejected() -> None:
    """timeout_s=121 fails Pydantic le=120."""
    with pytest.raises(ValidationError):
        A2AInvokeInput(
            remoteAgentEndpoint="https://stub.local/agent/intake",
            taskPayload={},
            timeoutS=121,
            correlationId="trace",
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Stub allow-list — non-stub endpoints raise ValueError
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_rejects_non_allow_listed_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    with pytest.raises(ValueError, match=r"stub only accepts endpoints under"):
        a2a_invoke(
            A2AInvokeInput(
                remoteAgentEndpoint="https://example.com/agent/sourcing",
                taskPayload={},
                timeoutS=5,
                correlationId="trace",
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Live mode — A2A v0.3 message/send hop (httpx mocked)
# ─────────────────────────────────────────────────────────────────────────────


# A2A v0.3 `task/completed` envelope matching the live ss-mcp-server response
# shape (A2A-INTENTS.md §2.1) — used as the mocked HTTP body.
_TASK_ENVELOPE: dict[str, Any] = {
    "kind": "task",
    "id": "task-1779256738328",
    "contextId": "ctx-1779256738328",
    "status": {"state": "completed", "timestamp": "2026-05-20T05:58:58.328650Z"},
    "artifacts": [
        {
            "artifactId": "task-1779256738328-result",
            "parts": [
                {
                    "kind": "data",
                    "data": {
                        "brief": "Find 5 vegan-skincare TikTok creators in Korea.",
                        "creators": [
                            {
                                "unique_id": "kr_vegan_beauty",
                                "follower_count": 412000,
                                "engagement_rate": 0.0923,
                                "fit_score": 0.91,
                                "reasoning": "@kr_vegan_beauty has 412,000 followers …",
                            }
                        ],
                        "source_attribution": "Source: Social Seeding — https://socialseed.ing",
                        "trace": {"path": "heuristic", "keywords": ["vegan", "비건"]},
                    },
                }
            ],
        }
    ],
}


class _CapturingTransport:
    """Records the request `httpx.post` would have made + returns a scripted
    response. Lets the live tests assert on the A2A v0.3 envelope without a
    network call.
    """

    def __init__(self, *, status_code: int = 200, body: Any = None) -> None:
        self.status_code = status_code
        self._body = _TASK_ENVELOPE if body is None else body
        self.calls: list[dict[str, Any]] = []

    def __call__(self, url: str, **kwargs: Any) -> httpx.Response:
        self.calls.append({"url": url, **kwargs})
        request = httpx.Request("POST", url)
        if isinstance(self._body, (dict, list)):
            return httpx.Response(self.status_code, json=self._body, request=request)
        return httpx.Response(self.status_code, text=str(self._body), request=request)


def test_live_posts_a2a_v03_envelope(monkeypatch: pytest.MonkeyPatch) -> None:
    """Live mode posts the A2A v0.3 message/send envelope to /v1/message:send
    and parses the task/completed response into creators."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    transport = _CapturingTransport()
    monkeypatch.setattr(httpx, "post", transport)

    out = a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://ss-mcp.example.run.app",
            taskPayload={"brand_brief": "Find 5 vegan-skincare TikTok creators in Korea."},
            timeoutS=60,
            correlationId="trace-live-001",
        )
    )

    # ── Request side: correct URL + A2A v0.3 envelope + version header ──────
    assert len(transport.calls) == 1
    call = transport.calls[0]
    assert call["url"] == "https://ss-mcp.example.run.app/v1/message:send"
    assert call["headers"]["A2A-Version"] == "0.3"
    body = call["json"]
    assert body["message"]["role"] == "user"
    assert body["message"]["messageId"] == "trace-live-001"
    assert body["message"]["parts"] == [
        {"kind": "text", "text": "Find 5 vegan-skincare TikTok creators in Korea."}
    ]

    # ── Response side: task/completed parsed into creators ──────────────────
    assert out.succeeded is True
    assert out.error is None
    assert out.response_payload["kind"] == "task"
    assert out.response_payload["state"] == "completed"
    assert out.response_payload["task_id"] == "task-1779256738328"
    assert out.response_payload["correlation_id"] == "trace-live-001"
    creators = out.response_payload["data"]["creators"]
    assert len(creators) == 1
    assert creators[0]["unique_id"] == "kr_vegan_beauty"


def test_live_forwards_explicit_message_envelope(monkeypatch: pytest.MonkeyPatch) -> None:
    """A task_payload that already carries an A2A `message` is forwarded verbatim."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    transport = _CapturingTransport()
    monkeypatch.setattr(httpx, "post", transport)

    a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://ss-mcp.example.run.app/",
            taskPayload={
                "message": {
                    "role": "user",
                    "parts": [{"kind": "text", "text": "explicit envelope"}],
                }
            },
            timeoutS=30,
            correlationId="trace-live-002",
        )
    )
    body = transport.calls[0]["json"]
    assert body["message"]["parts"][0]["text"] == "explicit envelope"
    # messageId is defaulted from correlation_id when the caller omits it.
    assert body["message"]["messageId"] == "trace-live-002"


def test_live_attaches_identity_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """When A2A_IDENTITY_TOKEN is set, the hop carries a Bearer header (D44)."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    monkeypatch.setenv("A2A_IDENTITY_TOKEN", "spiffe-test-token")
    transport = _CapturingTransport()
    monkeypatch.setattr(httpx, "post", transport)

    a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://ss-mcp.example.run.app",
            taskPayload={"brand_brief": "brief"},
            timeoutS=10,
            correlationId="trace-live-003",
        )
    )
    assert transport.calls[0]["headers"]["Authorization"] == "Bearer spiffe-test-token"


def test_live_no_identity_token_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """No token configured ⇒ no Authorization header (Cloud Run unauthenticated)."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    monkeypatch.delenv("A2A_IDENTITY_TOKEN", raising=False)
    monkeypatch.delenv("A2A_FETCH_ID_TOKEN", raising=False)
    transport = _CapturingTransport()
    monkeypatch.setattr(httpx, "post", transport)

    a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://ss-mcp.example.run.app",
            taskPayload={"brand_brief": "brief"},
            timeoutS=10,
            correlationId="trace-live-004",
        )
    )
    assert "Authorization" not in transport.calls[0]["headers"]


def test_live_4xx_is_terminal_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 4xx response is surfaced as succeeded=False without retry."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    transport = _CapturingTransport(status_code=401, body="unauthorized")
    monkeypatch.setattr(httpx, "post", transport)

    out = a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://ss-mcp.example.run.app",
            taskPayload={"brand_brief": "brief"},
            timeoutS=10,
            correlationId="trace-live-005",
        )
    )
    assert out.succeeded is False
    assert out.error is not None
    assert out.error.startswith("401:")
    assert len(transport.calls) == 1  # no retry on 4xx


def test_live_5xx_retries_then_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """A persistent 5xx is retried (3 attempts total) then fails."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    monkeypatch.setattr("ss_agents.tools.a2a_invoke.time.sleep", lambda _s: None)
    transport = _CapturingTransport(status_code=503, body="overloaded")
    monkeypatch.setattr(httpx, "post", transport)

    out = a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://ss-mcp.example.run.app",
            taskPayload={"brand_brief": "brief"},
            timeoutS=10,
            correlationId="trace-live-006",
        )
    )
    assert out.succeeded is False
    assert out.error is not None
    assert out.error.startswith("503:")
    assert len(transport.calls) == 3  # retried up to the cap


def test_live_transport_error_returns_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """An httpx transport error degrades to succeeded=False (never raises)."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    monkeypatch.setattr("ss_agents.tools.a2a_invoke.time.sleep", lambda _s: None)

    def _boom(url: str, **kwargs: Any) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "post", _boom)

    out = a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://ss-mcp.example.run.app",
            taskPayload={"brand_brief": "brief"},
            timeoutS=10,
            correlationId="trace-live-007",
        )
    )
    assert out.succeeded is False
    assert out.error is not None
    assert "transport_error" in out.error


def test_live_non_completed_task_is_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 200 with a non-completed task state ⇒ succeeded=False."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    failed_task = {
        "kind": "task",
        "id": "task-x",
        "contextId": "ctx-x",
        "status": {"state": "failed"},
        "artifacts": [],
    }
    transport = _CapturingTransport(body=failed_task)
    monkeypatch.setattr(httpx, "post", transport)

    out = a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint="https://ss-mcp.example.run.app",
            taskPayload={"brand_brief": "brief"},
            timeoutS=10,
            correlationId="trace-live-008",
        )
    )
    assert out.succeeded is False
    assert out.error == "task_state: 'failed'"


# ─────────────────────────────────────────────────────────────────────────────
# 4b. Live helpers — message build + envelope parse (pure functions)
# ─────────────────────────────────────────────────────────────────────────────


def test_build_message_from_brief_key() -> None:
    payload = A2AInvokeInput(
        remoteAgentEndpoint="https://ss-mcp.example.run.app",
        taskPayload={"brand_brief": "hello brief"},
        timeoutS=10,
        correlationId="c-1",
    )
    msg = _build_a2a_message(payload)
    assert msg == {
        "message": {
            "role": "user",
            "messageId": "c-1",
            "parts": [{"kind": "text", "text": "hello brief"}],
        }
    }


def test_build_message_from_bare_parts() -> None:
    payload = A2AInvokeInput(
        remoteAgentEndpoint="https://ss-mcp.example.run.app",
        taskPayload={"role": "user", "parts": [{"kind": "text", "text": "bare"}]},
        timeoutS=10,
        correlationId="c-2",
    )
    msg = _build_a2a_message(payload)
    assert msg["message"]["parts"] == [{"kind": "text", "text": "bare"}]
    assert msg["message"]["messageId"] == "c-2"


def test_extract_response_payload_pulls_first_data_part() -> None:
    parsed = _extract_response_payload(_TASK_ENVELOPE)
    assert parsed["kind"] == "task"
    assert parsed["state"] == "completed"
    assert parsed["task_id"] == "task-1779256738328"
    assert parsed["data"]["creators"][0]["unique_id"] == "kr_vegan_beauty"


def test_extract_response_payload_tolerates_malformed_envelope() -> None:
    """A malformed envelope yields a thin payload, never raises."""
    parsed = _extract_response_payload({"unexpected": True})
    assert parsed["kind"] is None
    assert "data" not in parsed


# ─────────────────────────────────────────────────────────────────────────────
# 5. Input validation — TLS only + extra fields forbidden
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_http_scheme() -> None:
    """A2A v0.3 mandates TLS — http:// is rejected."""
    with pytest.raises(ValidationError):
        A2AInvokeInput(
            remoteAgentEndpoint="http://stub.local/agent/sourcing",
            taskPayload={},
            timeoutS=5,
            correlationId="trace",
        )


def test_input_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        A2AInvokeInput.model_validate(
            {
                "remoteAgentEndpoint": "https://stub.local/agent/sourcing",
                "taskPayload": {},
                "timeoutS": 5,
                "correlationId": "trace",
                "extra": True,
            }
        )


def test_input_rejects_empty_correlation_id() -> None:
    with pytest.raises(ValidationError):
        A2AInvokeInput(
            remoteAgentEndpoint="https://stub.local/agent/sourcing",
            taskPayload={},
            timeoutS=5,
            correlationId="",
        )


# ─────────────────────────────────────────────────────────────────────────────
# Cost attribute
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(a2a_invoke, "usd_cost")
    assert a2a_invoke.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(a2a_invoke.usd_cost, float)  # type: ignore[attr-defined]
