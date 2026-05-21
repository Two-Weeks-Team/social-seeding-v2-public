"""agent_registry_list — capability layer per D41.

List agents registered with the Agent Registry (local + remote A2A). Implements
the `agent_registry.list` capability declared in
`gcp-research/specs/tier2/coordinator.spec.md §6` for the Tier-2 M1 coordinator
agent (D23).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Returns a deterministic snapshot of the 22-agent production fleet per D23
    fleet inventory (16 Tier-1 domain + 3 Tier-2 meta + 3 Tier-3 watchdog).
    The agents are listed in stable insertion order; the snapshot is built
    once at module import and returned (filtered) on every call.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real read against the Agent Registry (D23 watchdog data plane —
    Cloud Monitoring-backed agent inventory + A2A discovery). Wired in W7
    deploy phase — raises `NotImplementedError` until then.

Citations:
    D23 — Fleet topology (22 agents) + watchdog. The fleet snapshot returned
          by `_stub` is the authoritative inventory from §4 of DECISIONS.md.
    D24 — Phased coordination: 0→1 in-process, 1→100 RemoteA2AAgent fan-out.
          `tier` + `model` fields let the coordinator score in_process vs A2A.
    D41 — Capability-layer ADK FunctionTool stub/live pattern.
    coordinator.spec.md §6 — Tool table row for `agent_registry.list`.
"""
from __future__ import annotations

import logging
import os
from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Agent Registry reads are sub-cent — single Cloud Monitoring point read.

Per-call USD attribution surfaced via `agent_registry_list.usd_cost` for the
runtime's `cost_watch` aggregator (D41)."""


AgentTier = Literal[1, 2, 3]
"""D23 fleet hierarchy: 1=domain, 2=meta (coordinator/critic/optimizer),
3=watchdog (anomaly/cost/security)."""


AgentStatus = Literal["healthy", "degraded", "down"]
"""Registry health — Cloud Monitoring uptime + Agent Sessions heartbeat blend.

  - healthy   → recent heartbeat + eval baseline OK + no Model Armor block.
  - degraded  → stale heartbeat OR p95 latency above SLO OR eval drift.
  - down      → no heartbeat for > 5min OR security quarantine active.
"""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class AgentRegistryListInput(BaseModel):
    """Input contract — `agent_registry.list` per coordinator.spec.md §6.

    Attributes:
        filter_tier:   Optional — restrict to one of the three D23 tiers.
            None ⇒ return every tier.
        filter_status: Optional — restrict by current Cloud Monitoring health.
            None ⇒ return every status.
    """

    model_config = ConfigDict(extra="forbid")

    filter_tier: AgentTier | None = Field(default=None, alias="filterTier")
    filter_status: AgentStatus | None = Field(default=None, alias="filterStatus")


class RegisteredAgent(BaseModel):
    """One row from the Agent Registry snapshot.

    Mirrors the D23 fleet inventory (DECISIONS.md §4) plus the live-status
    fields the coordinator needs to score routing candidates.
    """

    model_config = ConfigDict(extra="forbid")

    agent_id: str = Field(min_length=1, max_length=64, alias="agentId")
    tier: AgentTier
    model: str = Field(min_length=1, max_length=64)
    """Gemini model id (e.g. 'gemini-3.5-flash'). The coordinator's scorer
    consults this to estimate cost + latency."""

    current_status: AgentStatus = Field(alias="currentStatus")
    last_heartbeat: datetime = Field(alias="lastHeartbeat")
    """UTC. Drives `current_status='degraded'|'down'` in live mode."""


class AgentRegistryListOutput(BaseModel):
    """Output contract — `agents[]` (filtered subset) + `total` (post-filter).

    `total` equals `len(agents)`; redundant on the wire but reflects v2's
    typed-pagination habit + lets the coordinator cheap-check empty results
    without iterating the list.
    """

    model_config = ConfigDict(extra="forbid")

    agents: list[RegisteredAgent] = Field(default_factory=list, max_length=64)
    total: int = Field(ge=0)


# ─────────────────────────────────────────────────────────────────────────────
# Stub fleet snapshot — 22 deterministic agents per D23 (DECISIONS.md §4).
#
# Ordering is stable (Tier-1 domain in spec order, Tier-2 in M1→M3, Tier-3 in
# W1→W3) so coordinator routing tests can assert on positional behavior.
# Heartbeats are deterministic offsets from a fixed epoch so the stub returns
# the same bytes every call (no `datetime.now()` drift).
# ─────────────────────────────────────────────────────────────────────────────


_STUB_EPOCH: datetime = datetime(2026, 5, 19, 12, 0, 0, tzinfo=UTC)
"""Anchor for deterministic heartbeats. Chosen as the task brief date so the
stub remains stable across re-runs."""


def _hb(seconds_offset: int) -> datetime:
    """Compose a deterministic heartbeat (epoch - offset).

    All offsets are NEGATIVE so the snapshot reads as "this many seconds ago"
    relative to the stub epoch — matches the live shape (Cloud Monitoring
    returns past timestamps)."""
    return _STUB_EPOCH - timedelta(seconds=seconds_offset)


_STUB_FLEET: tuple[RegisteredAgent, ...] = (
    # ── Tier 1: 16 domain agents (DECISIONS.md §4) ───────────────────────────
    RegisteredAgent(agentId="sourcing", tier=1, model="gemini-3.5-flash",
                    currentStatus="healthy", lastHeartbeat=_hb(15)),
    RegisteredAgent(agentId="vetting", tier=1, model="gemini-3.5-flash",
                    currentStatus="healthy", lastHeartbeat=_hb(18)),
    RegisteredAgent(agentId="outreach_writer", tier=1, model="gemini-3.5-flash",
                    currentStatus="healthy", lastHeartbeat=_hb(22)),
    RegisteredAgent(agentId="conversation", tier=1, model="gemini-3.1-flash-lite",
                    currentStatus="healthy", lastHeartbeat=_hb(11)),
    RegisteredAgent(agentId="conversation_responder", tier=1, model="gemini-3.5-flash",
                    currentStatus="healthy", lastHeartbeat=_hb(25)),
    RegisteredAgent(agentId="logistics", tier=1, model="gemini-3.1-flash-lite",
                    currentStatus="healthy", lastHeartbeat=_hb(13)),
    RegisteredAgent(agentId="content_verify", tier=1, model="gemini-3.1-flash-lite",
                    currentStatus="healthy", lastHeartbeat=_hb(17)),
    RegisteredAgent(agentId="analyst", tier=1, model="gemini-3.5-flash",
                    currentStatus="healthy", lastHeartbeat=_hb(31)),
    RegisteredAgent(agentId="research", tier=1, model="gemini-3.5-flash",
                    currentStatus="healthy", lastHeartbeat=_hb(24)),
    RegisteredAgent(agentId="intake", tier=1, model="gemini-3.1-flash-lite",
                    currentStatus="healthy", lastHeartbeat=_hb(9)),
    RegisteredAgent(agentId="lead_outreach_writer", tier=1, model="gemini-3.5-flash",
                    currentStatus="healthy", lastHeartbeat=_hb(28)),
    RegisteredAgent(agentId="payment_mandate", tier=1, model="gemini-3.1-flash-lite",
                    currentStatus="healthy", lastHeartbeat=_hb(20)),
    RegisteredAgent(agentId="compliance", tier=1, model="gemini-3.5-flash",
                    currentStatus="degraded", lastHeartbeat=_hb(95)),
    RegisteredAgent(agentId="creative", tier=1, model="gemini-3.5-flash",
                    currentStatus="healthy", lastHeartbeat=_hb(34)),
    RegisteredAgent(agentId="a11y", tier=1, model="gemini-3.1-flash-lite",
                    currentStatus="healthy", lastHeartbeat=_hb(12)),
    RegisteredAgent(agentId="customer_success", tier=1, model="gemini-3.5-flash",
                    currentStatus="healthy", lastHeartbeat=_hb(40)),
    # ── Tier 2: 3 meta agents (coordinator/critic/optimizer) ─────────────────
    RegisteredAgent(agentId="coordinator", tier=2, model="gemini-3.1-flash-lite",
                    currentStatus="healthy", lastHeartbeat=_hb(7)),
    RegisteredAgent(agentId="critic", tier=2, model="gemini-3.5-flash",
                    currentStatus="healthy", lastHeartbeat=_hb(19)),
    RegisteredAgent(agentId="optimizer", tier=2, model="gemini-3.5-flash",
                    currentStatus="healthy", lastHeartbeat=_hb(45)),
    # ── Tier 3: 3 watchdog agents (D23) ──────────────────────────────────────
    RegisteredAgent(agentId="anomaly_watch", tier=3, model="gemini-3.1-flash-lite",
                    currentStatus="healthy", lastHeartbeat=_hb(10)),
    RegisteredAgent(agentId="cost_watch", tier=3, model="gemini-3.1-flash-lite",
                    currentStatus="healthy", lastHeartbeat=_hb(8)),
    RegisteredAgent(agentId="security_watch", tier=3, model="gemini-3.1-flash-lite",
                    currentStatus="down", lastHeartbeat=_hb(400)),
)


# Sanity assertion — the fleet snapshot MUST contain exactly 22 entries (D23).
assert len(_STUB_FLEET) == 22, (
    f"agent_registry_list stub fleet should be 22 agents per D23, "
    f"got {len(_STUB_FLEET)}"
)


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def agent_registry_list(payload: AgentRegistryListInput) -> AgentRegistryListOutput:
    """List agents registered with the Agent Registry.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated filter request.

    Returns:
        `AgentRegistryListOutput` with filtered `agents` + `total` count.

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
agent_registry_list.usd_cost = USD_COST  # type: ignore[attr-defined]


def _stub(payload: AgentRegistryListInput) -> AgentRegistryListOutput:
    """Return the deterministic fleet snapshot, filtered by tier + status."""
    filtered = [
        agent
        for agent in _STUB_FLEET
        if (payload.filter_tier is None or agent.tier == payload.filter_tier)
        and (
            payload.filter_status is None
            or agent.current_status == payload.filter_status
        )
    ]
    logger.debug(
        "agent_registry_list_stub",
        extra={
            "filter_tier": payload.filter_tier,
            "filter_status": payload.filter_status,
            "returned": len(filtered),
        },
    )
    return AgentRegistryListOutput(agents=filtered, total=len(filtered))


def _live(payload: AgentRegistryListInput) -> AgentRegistryListOutput:
    """Live Agent Registry read — wired in W7 deploy phase.

    The live impl will:
      1. Query the Agent Registry (Cloud Monitoring-backed) for the fleet.
      2. Cross-reference Agent Sessions for current heartbeat freshness.
      3. Apply tier/status filter server-side (one MQL query per filter combo).
    """
    raise NotImplementedError(
        "agent_registry_list live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "AgentRegistryListInput",
    "AgentRegistryListOutput",
    "AgentStatus",
    "AgentTier",
    "RegisteredAgent",
    "USD_COST",
    "agent_registry_list",
]
