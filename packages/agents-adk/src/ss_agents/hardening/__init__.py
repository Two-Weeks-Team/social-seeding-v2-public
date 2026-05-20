"""ss_agents.hardening — the "we hardened it" chapter (GRAND-NARRATIVE-PLAN §5-1).

This package is the Technical-30% evidence + Demo-20% "stall→repair" scene for
the single grand-narrative Track 3 submission (D50). It is the deterministic,
offline, locally-runnable analogue of the Vertex AI Agent Simulation +
Observability + Optimizer toolchain (D25 learning loop):

    triage_sim.py    — H2 Agent Simulation. Loads the synthetic edge-case set,
                       runs a triage rule set over it, scores pass-rate, and
                       builds the ObservedFailure list (for the Optimizer).
    optimizer_pass.py — H4 Agent Optimizer. Consumes the baseline failures and
                       re-measures with the optimized rule set; emits the
                       before/after metrics + the Observability trace artifacts.

Honest scope (RULES.md §Professional Honesty, GRAND-NARRATIVE-PLAN §7): the
before/after numbers come from THIS in-process pass over the synthetic set. The
live Vertex AI Agent Optimizer (`ss_agents.tools.agent_optimizer_tune` live
mode) is the production path and is stubbed today (W7-deferred,
NotImplementedError). The capability surface is real; the GCP backend is staged.

Citations: D23 (Tier-1 #5 / Tier-2 M3), D25 (learning loop), D32 (observability),
D5 (models).
"""
from __future__ import annotations

__all__ = []
