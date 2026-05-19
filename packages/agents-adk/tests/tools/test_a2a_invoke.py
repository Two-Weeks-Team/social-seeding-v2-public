"""tests/tools/test_a2a_invoke.py — capability-layer seam tests.

Covers:
  - Stub determinism for `https://stub.local/agent/<id>` endpoints.
  - Timeout edge: timeout_s=1 (min), timeout_s=120 (max), out-of-range rejection.
  - Stub rejects non-allow-listed endpoints with ValueError.
  - Live mode raises NotImplementedError.
  - Pydantic validation: http:// scheme rejected, unknown field rejected.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.a2a_invoke import (
    USD_COST,
    A2AInvokeInput,
    A2AInvokeOutput,
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
# 4. Live mode raises with W7 message
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        a2a_invoke(
            A2AInvokeInput(
                remoteAgentEndpoint="https://stub.local/agent/sourcing",
                taskPayload={},
                timeoutS=5,
                correlationId="trace",
            )
        )


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
