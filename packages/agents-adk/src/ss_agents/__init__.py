"""ss_agents — social-seeding-v2 ADK Python agents.

Per DECISIONS.md D35 (hybrid codebase) + D17 (Vertex AI Agent Runtime).

Public surface:
    AgentDef         — Pydantic config mirroring v2 AgentDef<I,O>
    AgentOutcome     — discriminated union {ok, escalate}
    RunContext       — per-invocation context (tenant, workspace, trace)
    run_agent        — the one place an LLM is called
    BudgetExceeded   — raised when USD cap is hit
    EscalateToHuman  — raised when the agent cannot continue safely
"""
from __future__ import annotations

from ss_agents.runtime import (
    AgentDef,
    AgentOutcome,
    BudgetExceeded,
    EscalateToHuman,
    Escalation,
    OutcomeOk,
    RunContext,
    run_agent,
)

__all__ = [
    "AgentDef",
    "AgentOutcome",
    "BudgetExceeded",
    "EscalateToHuman",
    "Escalation",
    "OutcomeOk",
    "RunContext",
    "run_agent",
]

__version__ = "0.1.0"
