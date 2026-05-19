"""model_armor_query_blocks — capability layer per D41.

Model Armor block-history query for the security_watch (W3) watchdog.
Implements the `model_armor.query_blocks` capability declared in
`gcp-research/specs/tier3/security_watch.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic. The canonical demo tenant (`workspace_id="ws_demo"`)
    returns exactly 2 blocks — one Prompt-Injection (PI) and one PII —
    matching the spec §5 happy-path. Other workspace_ids return an
    empty list (no historical activity → no blocks). Filtering by
    `block_kind` narrows the result to the matching kind.

    Snippets are DLP-redacted per D20 — raw text NEVER appears in the
    `redacted_snippet` field. Audit log retention (D33 90d) must not
    become a PII honeypot.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real Model Armor API call against the per-tenant block-history
    endpoint. Wired in W7 deploy phase. Today raises NotImplementedError.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D21 — Model Armor MAX policy (PI+JB + PII + RAI + custom regex +
          Agent Anomaly Detection + real-time alerting + auto-block).
          This tool reads the block stream that policy generates.
    D23 — Tier-3 W3 security_watch.
    D32 — Chronicle SecOps SIEM. Cross-correlated alerts are pulled by
          a SIBLING tool (`chronicle.query`); this tool covers the
          Model Armor stream only.
    D33 — Audit retention 90d. Redacted snippets only.
    security_watch.spec.md §6 — Tool table row for `model_armor.query_blocks`.

Per-call cost: $0.0001 (Model Armor block-history queries are billed per
1k blocks scanned; the 1h windows the watchdog uses are sub-cent).
"""
from __future__ import annotations

import datetime as dt
import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `model_armor_query_blocks.usd_cost`
for the runtime's `cost_watch` aggregator (D41). Sub-cent; security_watch's
$0.10 per-signal cap (spec §6) easily absorbs 2-3 of these calls."""


# ─────────────────────────────────────────────────────────────────────────────
# Block kind enum — mirrors Model Armor's filter taxonomy.
# ─────────────────────────────────────────────────────────────────────────────


BlockKind = Literal["PI", "JB", "PII", "RAI", "custom", "anomaly"]
"""Block kinds per D21 Model Armor MAX policy:
    PI:      Prompt-injection
    JB:      Jailbreak attempt
    PII:     PII leak (overlaps with DLP — Armor catches model OUTPUT side)
    RAI:     Responsible AI (toxicity, hate, harassment, …)
    custom:  Per-tenant custom regex (brand, competitor, handle)
    anomaly: Agent Anomaly Detection signal
"""


BlockSeverity = Literal["info", "warn", "critical"]
"""Mirrors security_watch.spec.md Severity. The agent's decision
combines block severity + count, so the live path must propagate the
real severity (not collapse to a single tier)."""


# Stub fixture — the canonical demo tenant.
_STUB_DEMO_WORKSPACE: str = "ws_demo"


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class ModelArmorQueryBlocksInput(BaseModel):
    """Capability input. Mirrors security_watch.spec.md §6
    `model_armor.query_blocks`.

    Attributes:
        workspace_id:  Optional workspace scope. None → tenant-wide
            query across all workspaces. When set, narrows to one
            workspace.
        time_range:    Inclusive `(start, end)` tuple, timezone-aware.
            `start < end` enforced.
        block_kind:    Optional filter — only blocks of this kind. None
            means "any kind". The live path passes this through as a
            Model Armor server-side filter; the stub filters in-process.
    """

    model_config = ConfigDict(extra="forbid")

    workspace_id: str | None = Field(default=None, max_length=64)
    time_range: tuple[dt.datetime, dt.datetime]
    block_kind: BlockKind | None = Field(default=None)

    @model_validator(mode="after")
    def _validate_range(self) -> ModelArmorQueryBlocksInput:
        start, end = self.time_range
        # Check tz-awareness BEFORE comparison — comparing a naive datetime
        # against a tz-aware one raises TypeError, which would short-circuit
        # the message we want to surface to callers.
        if start.tzinfo is None or end.tzinfo is None:
            raise ValueError("time_range timestamps must be timezone-aware")
        if start >= end:
            raise ValueError(
                f"time_range start ({start}) must be strictly before end ({end})"
            )
        return self


class ArmorBlockRecord(BaseModel):
    """One Model Armor block record.

    Mirrors `security_watch.spec.md §2 ArmorBlockRef` but as a tool
    output (canonical) — the agent's input model is reconstructed from
    this shape upstream by the security-handler workflow.
    """

    model_config = ConfigDict(extra="forbid")

    block_id: str = Field(min_length=1, max_length=128)
    kind: BlockKind
    tenant_id: str = Field(min_length=1, max_length=128)
    timestamp: dt.datetime
    severity: BlockSeverity
    redacted_snippet: str = Field(
        min_length=1,
        max_length=500,
        description=(
            "DLP-redacted snippet. NEVER the raw blocked content — D33 "
            "90d audit retention must not become a PII honeypot."
        ),
    )


class ModelArmorQueryBlocksOutput(BaseModel):
    """Capability output.

    Attributes:
        blocks:  Matching block records. Empty list when the workspace
            has no historical blocks in the window (or when the filter
            kind doesn't match any block).
        total:   `len(blocks)`. Echoed at the top level for fast triage.
    """

    model_config = ConfigDict(extra="forbid")

    blocks: list[ArmorBlockRecord] = Field(default_factory=list, max_length=500)
    total: int = Field(ge=0)


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def model_armor_query_blocks(
    payload: ModelArmorQueryBlocksInput,
) -> ModelArmorQueryBlocksOutput:
    """Query Model Armor for recent blocks per (workspace, window).

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated `ModelArmorQueryBlocksInput`.

    Returns:
        `ModelArmorQueryBlocksOutput` with matching records + count.

    Raises:
        NotImplementedError: in LIVE mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
model_armor_query_blocks.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic per-workspace block synthesis.
#
# Algorithm:
#   1. ws_demo → 2 blocks (1 PI at "warn", 1 PII at "warn"). Mirrors
#      security_watch.spec.md §5 happy-path.
#   2. Other workspace_ids → empty list. Lets multi-tenant tests assert
#      isolation without enumerating fixtures.
#   3. None (tenant-wide) → same as ws_demo.
#   4. If `block_kind` is set, filter the synthesized list in-process.
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: ModelArmorQueryBlocksInput) -> ModelArmorQueryBlocksOutput:
    """Deterministic stub. Same input → byte-identical output (modulo
    timestamps derived from the input window)."""
    start, end = payload.time_range
    target_ws = payload.workspace_id

    # Demo fixture: the canonical 2-block surface.
    if target_ws is None or target_ws == _STUB_DEMO_WORKSPACE:
        midpoint = start + (end - start) / 2
        all_blocks = [
            ArmorBlockRecord(
                block_id="stub_blk_pi_001",
                kind="PI",
                tenant_id="t_demo000000000000",
                timestamp=midpoint - dt.timedelta(minutes=5),
                severity="warn",
                redacted_snippet="ignore prev[**REDACTED**]",
            ),
            ArmorBlockRecord(
                block_id="stub_blk_pii_001",
                kind="PII",
                tenant_id="t_demo000000000000",
                timestamp=midpoint + dt.timedelta(minutes=2),
                severity="warn",
                redacted_snippet="contact: [**REDACTED-PII**]",
            ),
        ]
    else:
        all_blocks = []

    # In-process filter on `block_kind`.
    if payload.block_kind is not None:
        filtered = [b for b in all_blocks if b.kind == payload.block_kind]
    else:
        filtered = all_blocks

    logger.debug(
        "model_armor_query_blocks_stub",
        extra={
            "workspace_id": target_ws,
            "block_kind_filter": payload.block_kind,
            "total": len(filtered),
        },
    )

    return ModelArmorQueryBlocksOutput(blocks=filtered, total=len(filtered))


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase).
# ─────────────────────────────────────────────────────────────────────────────


def _live(
    payload: ModelArmorQueryBlocksInput,
) -> ModelArmorQueryBlocksOutput:
    """Live Model Armor query — wired in W7 deploy phase."""
    _ = payload
    raise NotImplementedError(
        "model_armor_query_blocks live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "ArmorBlockRecord",
    "BlockKind",
    "BlockSeverity",
    "ModelArmorQueryBlocksInput",
    "ModelArmorQueryBlocksOutput",
    "USD_COST",
    "model_armor_query_blocks",
]
