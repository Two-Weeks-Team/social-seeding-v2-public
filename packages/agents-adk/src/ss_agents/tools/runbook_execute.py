"""runbook_execute — capability layer per D41.

Cloud Workflows runbook invocation for the anomaly_watch (W1) watchdog.
Implements the `runbook.execute` capability declared in
`gcp-research/specs/tier3/anomaly_watch.spec.md §6` and the IR auto-runbook
chain in D32 (Cloud Monitoring → PagerDuty → Slack → Auto-runbook).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic execution-id minting + queued status. The stub FORCES
    `dry_run=True` for every mutating runbook_kind (scale_up, rollback,
    quarantine, circuit_breaker) so a misconfigured local run can NEVER
    flip production traffic. The stub mirrors the live path's input
    contract exactly so the anomaly_watch agent's tool-call shape is
    identical between dev/CI and prod.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real `workflows_v1.ExecutionsClient.create_execution` against the
    pre-deployed Cloud Workflow per runbook_kind. Wired in W7 deploy
    phase. Today raises NotImplementedError AFTER the dry_run guardrail
    check (so a missing opt-in fails LOUD before the live-mode "not
    implemented" message ever fires).

Demo-safety contract (this tool's contribution to D10):
    Production-mutating runbook_kinds (scale_up, rollback, quarantine,
    circuit_breaker) require an explicit `dry_run=False` opt-in. The
    stub IGNORES the opt-in (always dry_run); the live path enforces it
    BEFORE constructing any Workflows client. A demo run that forgets
    to set the flag gets a clear `ValueError`, not a silent rollback of
    the production fleet.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D23 — Tier-3 W1 anomaly_watch.
    D32 — Auto-runbook (Cloud Workflows) is the IR mechanism this tool
          invokes; PagerDuty + Slack + Chronicle SIEM are sibling
          downstreams in the IR chain.
    D31 — 99.99% SLO. mean_time_to_action <= 60s. The live path's P95
          end-to-end (create_execution → workflow first step) must
          stay under 5s for the SLO budget to hold.
    anomaly_watch.spec.md §6 — Tool table row for `runbook.execute`.

Per-call cost: $0.0001 (Cloud Workflows is billed per step-execution,
not per create_execution call; the call itself is essentially free).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `runbook_execute.usd_cost` for the
runtime's `cost_watch` aggregator (D41). Cloud Workflows charges for steps,
not for create_execution invocations — the actual cost lands on the runbook
itself, not this seam."""


# ─────────────────────────────────────────────────────────────────────────────
# Runbook kind enum — the closed set of pre-registered Cloud Workflows.
# ─────────────────────────────────────────────────────────────────────────────


RunbookKind = Literal[
    "scale_up", "scale_down", "rollback", "quarantine", "circuit_breaker"
]
"""The five production-mutating runbook kinds. Each maps to a distinct
Cloud Workflow deployed by W7. All five are MUTATING — the stub enforces
`dry_run=True` for every kind, and the live path requires explicit
`dry_run=False` opt-in before any side effect.

`scale_down` is the D46 cost-guard lever: when `cost_watch` crosses the 90%
budget threshold it triggers `runbook_execute("scale_down")`, which forces
every essential Cloud Run service back to `min=0` (the runbook wraps
`scripts/ops/scale-down.sh`). It is mutating — pinning min back to 0 changes
live serving capacity — so it carries the same `dry_run=False` opt-in
guardrail as the other kinds."""


ExecutionStatus = Literal["queued", "running", "succeeded", "failed"]
"""Mirrors `google.cloud.workflows.executions_v1.Execution.State`. The
stub returns `queued` because no actual workflow has started; the live
path returns the real state from the Cloud Workflows response."""


# All known runbook_kinds are mutating today. Kept as a frozenset so the
# guardrail can be extended (or read-only kinds added) without touching
# the enforcement code.
MUTATING_KINDS: frozenset[RunbookKind] = frozenset(
    {"scale_up", "scale_down", "rollback", "quarantine", "circuit_breaker"}
)
"""Production-mutating runbook kinds — require explicit `dry_run=False`
in live mode. Stub mode forces `dry_run=True` regardless. `scale_down` is
the D46 cost-guard kind (forces Cloud Run min=0)."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class RunbookExecuteInput(BaseModel):
    """Capability input. Mirrors anomaly_watch.spec.md §6 `runbook.execute`.

    Attributes:
        runbook_name:    Pre-registered runbook id (e.g. `rb_scale_up_v1`).
            Validated by the live path against the Cloud Workflows
            registry; the stub accepts any non-empty string so tests
            can pin against synthetic ids.
        params:          Runbook-specific parameters (target service,
            scale factor, quarantine TTL hours, etc.). Validated by the
            runbook itself, not by this seam. Empty dict allowed.
        dry_run:         When True, simulates the execution without
            applying side effects. The stub IGNORES this and forces
            dry_run; the live path REQUIRES dry_run=False for mutating
            kinds before any Workflows call is made.
        executing_user:  Operator identifier (email or system id). Audit
            trail per D33 14d session retention. Required so the audit
            log always carries a clear "who pressed the button" line.
        runbook_kind:    Which class of action this runbook performs.
            Used purely by the demo-safety guardrail in live mode.
    """

    model_config = ConfigDict(extra="forbid")

    runbook_name: str = Field(min_length=1, max_length=80)
    params: dict[str, str | int | float | bool] = Field(
        default_factory=dict, max_length=32
    )
    dry_run: bool
    executing_user: str = Field(min_length=1, max_length=200)
    runbook_kind: RunbookKind


class RunbookExecuteOutput(BaseModel):
    """Capability output.

    Attributes:
        execution_id:    Cloud Workflows execution name (live) OR a
            deterministic synthetic id (stub).
        status:          Execution state at the time of return. The
            stub always returns `queued` because nothing has actually
            started; the live path returns the real state.
        started_at:      UTC timestamp at which the execution was
            enqueued (stub) or created (live).
        runbook_kind:    Echoes the input kind. Audit-only.
        dry_run_applied: True iff side effects were skipped. ALWAYS
            True in stub mode; tracks `dry_run` input in live mode
            (after the mutating-kind opt-in check).
    """

    model_config = ConfigDict(extra="forbid")

    execution_id: str = Field(min_length=1, max_length=200)
    status: ExecutionStatus
    started_at: dt.datetime
    runbook_kind: RunbookKind
    dry_run_applied: bool


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def runbook_execute(payload: RunbookExecuteInput) -> RunbookExecuteOutput:
    """Invoke a registered Cloud Workflows runbook.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`. The mutating-kind opt-in guardrail
    runs FIRST in live mode — before any Workflows client is built.

    Args:
        payload: Validated `RunbookExecuteInput`.

    Returns:
        `RunbookExecuteOutput` with the resolved execution_id, status,
        started_at, runbook_kind, and `dry_run_applied` audit flag.

    Raises:
        ValueError: in LIVE mode when `runbook_kind` is mutating AND
            `dry_run` is not explicitly False. The error message names
            the violated kind so the operator can diagnose without
            re-reading this docstring.
        NotImplementedError: in LIVE mode when the opt-in clears but
            the W7 deploy-phase Workflows client is not yet wired. The
            runtime converts to a typed `EscalateToHuman`.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
runbook_execute.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic, NEVER mutates. dry_run_applied is forced True.
#
# Algorithm:
#   1. Force `dry_run_applied = True` regardless of input. Mutating
#      runbook_kinds CANNOT execute side effects through the stub.
#   2. Mint a deterministic execution_id from
#      `runbook_name + runbook_kind + sorted(params)` so /goal + replay
#      tests see byte-identical output.
#   3. Status is always `queued` — nothing actually starts.
#   4. started_at uses current UTC wall clock (determinism is on
#      execution_id, not on this field).
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: RunbookExecuteInput) -> RunbookExecuteOutput:
    """Deterministic stub. Same input shape → same execution_id."""
    execution_id = _synth_execution_id(
        payload.runbook_name, payload.runbook_kind, payload.params
    )
    started_at = dt.datetime.now(tz=dt.UTC)

    logger.info(
        "runbook_execute_stub",
        extra={
            "runbook_name": payload.runbook_name,
            "runbook_kind": payload.runbook_kind,
            "execution_id": execution_id,
            "dry_run_input": payload.dry_run,
            "dry_run_applied": True,
            "executing_user": payload.executing_user,
        },
    )

    return RunbookExecuteOutput(
        execution_id=execution_id,
        status="queued",
        started_at=started_at,
        runbook_kind=payload.runbook_kind,
        dry_run_applied=True,
    )


def _synth_execution_id(
    runbook_name: str,
    runbook_kind: RunbookKind,
    params: dict[str, str | int | float | bool],
) -> str:
    """Mint a deterministic execution_id.

    Format: `stub_exec_<runbook_kind>_<8-char-hash>` — the kind prefix
    makes it obvious from a log line which runbook was invoked, and the
    hash captures (runbook_name, kind, sorted params) so different
    inputs hash to different ids.
    """
    canonical = (
        f"{runbook_name}|{runbook_kind}|"
        + "|".join(f"{k}={v}" for k, v in sorted(params.items()))
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:8]
    return f"stub_exec_{runbook_kind}_{digest}"


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase).
#
# The mutating-kind opt-in check runs HERE — before any Workflows client
# is built. A misconfigured demo run that asks for a mutating runbook
# without explicit dry_run=False gets a clear ValueError, not a generic
# NotImplementedError or (much worse) a real production rollback.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: RunbookExecuteInput) -> RunbookExecuteOutput:
    """Live Cloud Workflows execute — wired in W7 deploy phase.

    Raises:
        ValueError: if `runbook_kind` is mutating AND `dry_run` is True.
            Demo-safety guardrail: a mutating runbook in live mode must
            be invoked with an explicit `dry_run=False` opt-in.
        NotImplementedError: if opt-in cleared but the Workflows client
            is not yet wired (W7).
    """
    if payload.runbook_kind in MUTATING_KINDS and payload.dry_run:
        raise ValueError(
            f"runbook_execute live mode: runbook_kind "
            f"{payload.runbook_kind!r} is production-mutating; explicit "
            f"dry_run=False opt-in is required (got dry_run=True). "
            "Mutating kinds: " + ", ".join(sorted(MUTATING_KINDS))
        )
    raise NotImplementedError(
        "runbook_execute live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "ExecutionStatus",
    "MUTATING_KINDS",
    "RunbookExecuteInput",
    "RunbookExecuteOutput",
    "RunbookKind",
    "USD_COST",
    "runbook_execute",
]
