"""a2a_invoke — capability layer per D41.

Invoke a remote A2A v0.3 agent. Implements the `a2a.invoke` capability from
`coordinator.spec.md §6` (Tier-2 M1 coordinator, D23 + D24).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic success for endpoints under `https://stub.local/agent/<id>`.
    The stub:
      - Echoes the input task_payload back under `response_payload.echo`.
      - Derives the agent id from the last URL path segment.
      - Records the supplied `correlation_id` so downstream Workflows replay
        matches the in-process path's response shape.
    Other endpoints raise `ValueError` so tests catch typos early.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real outbound A2A v0.3 invocation through Agent Gateway (D44). Wired in
    W7 deploy phase — raises `NotImplementedError` until then.

Citations:
    D23 — Tier-2 M1 coordinator picks local-or-remote per task.
    D24 — Phased coordination: 1→100 RemoteA2AAgent fan-out.
    D41 — Capability-layer ADK FunctionTool stub/live pattern.
    coordinator.spec.md §6 — Tool table row for `a2a.invoke`.
"""
from __future__ import annotations

import logging
import os
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator

logger = logging.getLogger(__name__)

USD_COST: float = 0.0005
"""A2A invocation cost is the network hop + Agent Gateway fee (not the remote
agent's own LLM cost — that's billed against the remote tenant's budget).
Surfaced via `a2a_invoke.usd_cost` for `cost_watch` (D41)."""


_STUB_ENDPOINT_PREFIX: str = "https://stub.local/agent/"
"""Endpoints under this prefix MUST succeed deterministically in stub mode.
Anything else raises so tests fail fast on typos."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class A2AInvokeInput(BaseModel):
    """Input contract — `a2a.invoke` per coordinator.spec.md §6.

    Attributes:
        remote_agent_endpoint: HTTPS URL of the A2A endpoint. Must use the
            `https` scheme — A2A v0.3 mandates TLS (D44 Agent Gateway).
        task_payload: Free-form task envelope. The coordinator owns the shape;
            this layer is content-blind so contract drifts don't propagate.
        timeout_s: Per-invocation timeout in seconds (1-120). Live mode uses
            this as the HTTP read timeout; stub returns the value in
            `latency_ms` for assertion convenience (multiplied to ms).
        correlation_id: OTel trace correlation. Echoed in `response_payload`
            so the coordinator can pair the response with its original task.
    """

    model_config = ConfigDict(extra="forbid")

    remote_agent_endpoint: HttpUrl = Field(alias="remoteAgentEndpoint")
    task_payload: dict[str, Any] = Field(default_factory=dict, alias="taskPayload")
    timeout_s: int = Field(ge=1, le=120, alias="timeoutS")
    correlation_id: str = Field(
        min_length=1,
        max_length=128,
        alias="correlationId",
    )

    @field_validator("remote_agent_endpoint")
    @classmethod
    def _require_https(cls, v: HttpUrl) -> HttpUrl:
        """A2A v0.3 mandates TLS — reject http:// outright."""
        if v.scheme != "https":
            raise ValueError(
                f"remote_agent_endpoint must use https, got scheme={v.scheme!r}"
            )
        return v


class A2AInvokeOutput(BaseModel):
    """Output contract — invocation outcome.

    Attributes:
        response_payload: Free-form remote response. Stub returns
            `{"echo": <task_payload>, "agent_id": <derived>, "correlation_id": ...}`.
        latency_ms: Round-trip latency (stub returns `timeout_s * 10` ms as a
            stable, deterministic value — the test asserts on the multiplier).
        succeeded: True when the remote returned a 2xx response.
        error: Set ONLY when `succeeded is False`. Stub never sets this; live
            mode populates with the upstream error code/message.
    """

    model_config = ConfigDict(extra="forbid")

    response_payload: dict[str, Any] = Field(default_factory=dict, alias="responsePayload")
    latency_ms: int = Field(ge=0, alias="latencyMs")
    succeeded: bool
    error: str | None = Field(default=None, max_length=500)


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def a2a_invoke(payload: A2AInvokeInput) -> A2AInvokeOutput:
    """Invoke a remote A2A agent.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated invocation request.

    Returns:
        `A2AInvokeOutput` with the remote response payload, latency, and
        success flag.

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
        ValueError: stub mode, endpoint outside `https://stub.local/agent/`.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
a2a_invoke.usd_cost = USD_COST  # type: ignore[attr-defined]


def _stub(payload: A2AInvokeInput) -> A2AInvokeOutput:
    """Deterministic success for `https://stub.local/agent/<id>` endpoints.

    Anything outside the allow-listed prefix raises ValueError — surface typos
    in the test fixtures rather than silently succeeding with a wrong shape.
    """
    endpoint_str = str(payload.remote_agent_endpoint)
    if not endpoint_str.startswith(_STUB_ENDPOINT_PREFIX):
        raise ValueError(
            f"a2a_invoke stub only accepts endpoints under "
            f"{_STUB_ENDPOINT_PREFIX!r}, got {endpoint_str!r}"
        )

    # Derive the agent id from the URL path. urlparse normalises trailing
    # slashes; we slice off the prefix and trim any leftover.
    parsed = urlparse(endpoint_str)
    raw_path = parsed.path.lstrip("/")  # 'agent/<id>'
    parts = [p for p in raw_path.split("/") if p]
    derived_agent_id = parts[-1] if len(parts) >= 2 else "unknown"

    # Stub latency = timeout * 10 (ms). Deterministic + bounded by input.
    latency_ms = payload.timeout_s * 10

    response_payload = {
        "echo": dict(payload.task_payload),
        "agent_id": derived_agent_id,
        "correlation_id": payload.correlation_id,
    }
    logger.debug(
        "a2a_invoke_stub",
        extra={
            "endpoint": endpoint_str,
            "agent_id": derived_agent_id,
            "correlation_id": payload.correlation_id,
            "latency_ms": latency_ms,
        },
    )
    return A2AInvokeOutput(
        responsePayload=response_payload,
        latencyMs=latency_ms,
        succeeded=True,
        error=None,
    )


def _live(payload: A2AInvokeInput) -> A2AInvokeOutput:
    """Live A2A v0.3 invocation — wired in W7 deploy phase.

    The live impl will:
      1. Acquire a SPIFFE identity token (D44 Agent Identity).
      2. POST through Agent Gateway with the task_payload + correlation_id.
      3. Honor `timeout_s` as the read timeout + apply exponential backoff
         (3 attempts max — coordinator retries on the next invocation).
      4. Surface remote 4xx/5xx as `succeeded=False, error="<code>: <msg>"`.
    """
    raise NotImplementedError(
        "a2a_invoke live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "A2AInvokeInput",
    "A2AInvokeOutput",
    "USD_COST",
    "a2a_invoke",
]
