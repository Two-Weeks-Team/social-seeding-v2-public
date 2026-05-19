"""agent_optimizer_tune — capability layer per D41.

Request a Vertex AI Agent Optimizer prompt-tuning job. Implements the
`agent_optimizer.tune` capability from `optimizer.spec.md §6` for the
Tier-2 M3 optimizer agent (D23, D25 learning loop).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic queue receipt: `job_id=opt-<agent_id>-001`, `eta_minutes=30`,
    `status="queued"`. Per the task brief, the canonical stub response is
    pinned so the optimizer's downstream "watch for completion" loop can
    exercise its happy path without a live Vertex client.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real Vertex AI Agent Optimizer invocation. Wired in W7 deploy phase —
    raises `NotImplementedError` until then.

Citations:
    D23 — Tier-2 M3 optimizer.
    D25 — Learning loop (Vertex AI Agent Optimizer powers the prompt-rewrite
          half of the loop).
    D41 — Capability-layer ADK FunctionTool stub/live pattern.
    optimizer.spec.md §6 — Tool table row for `agent_optimizer.tune`.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0500
"""Vertex AI Agent Optimizer list price (2026 H1): ~$0.05 per tune request
(the optimizer.spec.md §6 USD cap is $5.00 across ≤22 agents). Surfaced via
`agent_optimizer_tune.usd_cost` for `cost_watch` (D41)."""


OptimizerJobStatus = Literal["queued", "running", "done"]
"""Lifecycle of an Agent Optimizer job:
  - queued  → accepted by Vertex; awaiting a worker.
  - running → worker has started; partial progress observable.
  - done    → terminal; the optimizer agent reads the diff via a follow-up.
"""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class ObservedFailure(BaseModel):
    """One observed failure pattern from Agent Observability + Evaluation.

    Free-form `payload` so the optimizer agent stays content-blind — this
    layer treats failures as opaque dicts so contract drift in the upstream
    Observability schema doesn't propagate here.

    Attributes:
        kind: Failure family tag (e.g. `"timeout"`, `"validation_error"`,
            `"escalation"`). Surfaced in the tuner's prompt so it can focus on
            the failure mode.
        sample_count: Number of traces that exhibited this failure pattern in
            the lookback window (used by the tuner to weight criticality).
        payload: Free-form failure context (the trace's `Escalation.partial`
            or a redacted output snippet).
    """

    model_config = ConfigDict(extra="forbid")

    kind: str = Field(min_length=1, max_length=64)
    sample_count: int = Field(ge=1, alias="sampleCount")
    payload: dict[str, Any] = Field(default_factory=dict)


class AgentOptimizerTuneInput(BaseModel):
    """Input contract — `agent_optimizer.tune` per optimizer.spec.md §6.

    Attributes:
        agent_id: The agent being tuned. Forms the deterministic stub job id.
        current_prompt: The prompt text to rewrite. Capped at 60_000 chars
            (Gemini 2.5 Pro context-window leeway accounting for trace data).
        observed_failures: List of failure patterns from Agent Observability.
        target_metric: The metric the tuner should optimize against
            (e.g. `"routing_accuracy"`, `"latency_p95_ms"`, `"escalation_rate"`).
    """

    model_config = ConfigDict(extra="forbid")

    agent_id: str = Field(min_length=1, max_length=64, alias="agentId")
    current_prompt: str = Field(
        min_length=1,
        max_length=60_000,
        alias="currentPrompt",
    )
    observed_failures: list[ObservedFailure] = Field(
        default_factory=list,
        max_length=200,
        alias="observedFailures",
    )
    target_metric: str = Field(min_length=1, max_length=64, alias="targetMetric")


class AgentOptimizerTuneOutput(BaseModel):
    """Output contract — queued job receipt.

    Attributes:
        job_id: Vertex AI Agent Optimizer job id. Stub format:
            `opt-<agent_id>-001`. Live mode mints a Vertex-allocated id.
        eta_minutes: Caller-facing ETA for completion (≤ 240 min). Stub always
            returns 30; live mode echoes Vertex's queue depth signal.
        status: One of queued/running/done (D25 lifecycle).
    """

    model_config = ConfigDict(extra="forbid")

    job_id: str = Field(min_length=1, max_length=80, alias="jobId")
    eta_minutes: int = Field(ge=0, le=240, alias="etaMinutes")
    status: OptimizerJobStatus


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def agent_optimizer_tune(payload: AgentOptimizerTuneInput) -> AgentOptimizerTuneOutput:
    """Queue a Vertex AI Agent Optimizer tuning job.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated tuning request.

    Returns:
        `AgentOptimizerTuneOutput` with the queued job id, ETA, and status.

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
agent_optimizer_tune.usd_cost = USD_COST  # type: ignore[attr-defined]


def _stub(payload: AgentOptimizerTuneInput) -> AgentOptimizerTuneOutput:
    """Deterministic queued receipt.

    Per the task brief: job_id=`opt-<agent_id>-001`, eta_minutes=30,
    status="queued"."""
    job_id = f"opt-{payload.agent_id}-001"
    logger.info(
        "agent_optimizer_tune_stub",
        extra={
            "agent_id": payload.agent_id,
            "job_id": job_id,
            "target_metric": payload.target_metric,
            "failure_samples": sum(f.sample_count for f in payload.observed_failures),
        },
    )
    return AgentOptimizerTuneOutput(
        jobId=job_id,
        etaMinutes=30,
        status="queued",
    )


def _live(payload: AgentOptimizerTuneInput) -> AgentOptimizerTuneOutput:
    """Live Vertex AI Agent Optimizer invocation — wired in W7 deploy phase.

    The live impl will:
      1. Compose the tuning request envelope (current_prompt + observed
         failures + target_metric + the workspace's eval golden set).
      2. POST to Vertex AI Agent Optimizer via the google-cloud-aiplatform
         client.
      3. Echo Vertex's job id + queue ETA + status back to the caller.
      4. The optimizer agent then polls for completion via a follow-up tool
         (not part of this capability — `agent_optimizer.get_job` is the
         companion read).
    """
    raise NotImplementedError(
        "agent_optimizer_tune live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "AgentOptimizerTuneInput",
    "AgentOptimizerTuneOutput",
    "ObservedFailure",
    "OptimizerJobStatus",
    "USD_COST",
    "agent_optimizer_tune",
]
