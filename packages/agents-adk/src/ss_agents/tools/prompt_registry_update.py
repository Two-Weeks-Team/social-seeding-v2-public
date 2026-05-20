"""prompt_registry_update — capability layer per D41.

Persist an optimized prompt to the versioned prompt registry. Implements the
`prompt_registry.update` capability from `optimizer.spec.md §6` for the
Tier-2 M3 optimizer agent (D23, D25 learning loop).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic version assignment via a per-agent monotonic counter.
    Format: `v<n>` (v1, v2, v3, ...). The first call for a given agent_id
    returns v1 with `previous_version_id=None`; subsequent calls return v2,
    v3, ... with the prior version id surfaced for rollback.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real write to the Spanner-backed prompt registry + Cloud Storage object
    write for the prompt body. Wired in W7 deploy phase — raises
    `NotImplementedError` until then.

Citations:
    D23 — Tier-2 M3 optimizer.
    D25 — Learning loop (prompt registry is the durable home for tuned prompts).
    D41 — Capability-layer ADK FunctionTool stub/live pattern.
    optimizer.spec.md §6 — Tool table row for `prompt_registry.update`.
"""
from __future__ import annotations

import logging
import os
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Spanner row write + GCS object put — sub-cent. Surfaced via
`prompt_registry_update.usd_cost` for `cost_watch` (D41)."""


# ─────────────────────────────────────────────────────────────────────────────
# Stub state — module-level, reset between tests via `_reset_stub_state`.
# ─────────────────────────────────────────────────────────────────────────────


_VERSIONS: dict[str, list[str]] = {}
"""Per-agent version list (ordered by registration). `{agent_id: [v1, v2, ...]}`.
Drives the monotonic version counter + the `previous_version_id` lookup."""


def _reset_stub_state() -> None:
    """Reset module-level stub state. Used by tests via fixture / `monkeypatch`.

    Production code does not call this — the live mode owns its own state in
    Spanner + Cloud Storage.
    """
    _VERSIONS.clear()


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class PromptRegistryUpdateInput(BaseModel):
    """Input contract — `prompt_registry.update` per optimizer.spec.md §6.

    Attributes:
        agent_id: The agent whose prompt is being versioned.
        new_prompt: The optimized prompt text. Capped at 60_000 chars
            (matches `agent_optimizer_tune.current_prompt` cap so a tuned
            prompt always fits the registry).
        version_label: Operator-readable label (e.g. `"tournament-2026Q2"`,
            `"locale-ko-rev3"`). Free-form ≤ 80 chars; surfaced in the PR
            review UI.
        optimizer_job_id: Provenance: which Vertex AI Prompt Optimizer
            (data-driven) job produced this prompt. Foreign key into Vertex
            AI's job log.
        performance_delta_0_1: Simulation lift vs the previous version,
            normalized to [0.0, 1.0]. The PR review UI shows this prominently.
    """

    model_config = ConfigDict(extra="forbid")

    agent_id: str = Field(min_length=1, max_length=64, alias="agentId")
    new_prompt: str = Field(min_length=1, max_length=60_000, alias="newPrompt")
    version_label: str = Field(min_length=1, max_length=80, alias="versionLabel")
    optimizer_job_id: str = Field(
        min_length=1,
        max_length=80,
        alias="optimizerJobId",
    )
    performance_delta_0_1: float = Field(
        ge=0.0,
        le=1.0,
        alias="performanceDelta01",
    )


class PromptRegistryUpdateOutput(BaseModel):
    """Output contract — registration receipt.

    Attributes:
        version_id: Newly registered version id (`v1`, `v2`, ...). The
            optimizer agent surfaces this in the PR body for human review.
        registered_at: UTC timestamp of registration.
        previous_version_id: Prior version's id, or None when this is v1.
            The PR rolls forward from this version on merge.
        rollback_url: Operator dashboard deep-link to roll the agent back
            to `previous_version_id`. None-friendly (string, not URL) so
            we can express "no prior version, no rollback" cleanly.
    """

    model_config = ConfigDict(extra="forbid")

    version_id: str = Field(min_length=1, max_length=24, alias="versionId")
    registered_at: datetime = Field(alias="registeredAt")
    previous_version_id: str | None = Field(
        default=None,
        max_length=24,
        alias="previousVersionId",
    )
    rollback_url: str = Field(min_length=1, max_length=500, alias="rollbackUrl")


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def prompt_registry_update(
    payload: PromptRegistryUpdateInput,
) -> PromptRegistryUpdateOutput:
    """Register a new prompt version in the prompt registry.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated registration request.

    Returns:
        `PromptRegistryUpdateOutput` with the newly assigned version id,
        registration timestamp, prior version id (for rollback), and the
        operator dashboard rollback URL.

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
prompt_registry_update.usd_cost = USD_COST  # type: ignore[attr-defined]


def _stub(payload: PromptRegistryUpdateInput) -> PromptRegistryUpdateOutput:
    """Deterministic version assignment.

    Behavior:
      - First call for an agent → v1, previous_version_id=None.
      - Subsequent calls → v2, v3, ... with the prior version id surfaced.
      - rollback_url always points at the dashboard; when there is no prior
        version, the URL appends `?confirm=initial` so the dashboard can
        render a "no rollback available" notice instead of erroring.
    """
    versions = _VERSIONS.setdefault(payload.agent_id, [])
    next_seq = len(versions) + 1
    version_id = f"v{next_seq}"
    previous_version_id = versions[-1] if versions else None
    versions.append(version_id)

    if previous_version_id is None:
        rollback_url = (
            f"https://dashboard.stub.local/prompts/{payload.agent_id}/"
            f"{version_id}?confirm=initial"
        )
    else:
        rollback_url = (
            f"https://dashboard.stub.local/prompts/{payload.agent_id}/"
            f"{version_id}/rollback-to/{previous_version_id}"
        )

    registered_at = datetime.now(tz=UTC)
    logger.info(
        "prompt_registry_update_stub",
        extra={
            "agent_id": payload.agent_id,
            "version_id": version_id,
            "previous_version_id": previous_version_id,
            "optimizer_job_id": payload.optimizer_job_id,
        },
    )
    return PromptRegistryUpdateOutput(
        versionId=version_id,
        registeredAt=registered_at,
        previousVersionId=previous_version_id,
        rollbackUrl=rollback_url,
    )


def _live(payload: PromptRegistryUpdateInput) -> PromptRegistryUpdateOutput:
    """Live prompt-registry write — wired in W7 deploy phase.

    The live impl will:
      1. Allocate the next version id (Spanner row-level lock per agent_id).
      2. Write the prompt body to a Cloud Storage object
         (`gs://ss-prompt-registry/<agent_id>/<version_id>.txt`).
      3. Insert the row into `v2_prompt_registry` with the GCS object URI,
         label, optimizer_job_id, and performance_delta.
      4. Return the version id + Spanner commit timestamp + rollback URL.
      5. Reject duplicate `optimizer_job_id` writes (idempotency key).
    """
    # Touch `Any` so static checkers keep the import live for the future
    # generic-payload helper used by the live writer.
    _: Any = None
    raise NotImplementedError(
        "prompt_registry_update live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "PromptRegistryUpdateInput",
    "PromptRegistryUpdateOutput",
    "USD_COST",
    "prompt_registry_update",
]
