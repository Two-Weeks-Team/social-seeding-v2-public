"""evals/__main__.py — CLI entry for the offline golden-eval runner.

    cd packages/agents-adk
    SS_OFFLINE=1 uv run python -m evals --agent coordinator

Drives the chosen agent's deterministic predictor against its evalset, splits by
holdout, prints the pass/score summary, and exits non-zero when the holdout slice
misses the floor (so CI can gate on it).

D25 (Agent-Evaluation rung) · D37 (Layer-1 offline gate) · D5 (Flash agent,
deterministic scored predictor). Honest scope: thin runner, not live `adk eval`
— see evals/README.md.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path
from typing import Any, NamedTuple

from evals.runner import (
    PredictorFn,
    ScorerFn,
    format_report,
    load_evalset,
    load_holdout_split,
    report_passed,
    run_eval,
)
from ss_agents.runtime import AgentDef

_EVALS_DIR = Path(__file__).resolve().parent


class AgentEvalSpec(NamedTuple):
    agent_def: AgentDef[Any, Any]
    predictor: PredictorFn
    scorer: ScorerFn
    evalset_path: Path
    holdout_path: Path


def _coordinator_spec() -> AgentEvalSpec:
    from evals.coordinator_eval import predict_coordinator, score_coordinator
    from ss_agents.agents.coordinator import coordinator_agent_def

    return AgentEvalSpec(
        agent_def=coordinator_agent_def,
        predictor=predict_coordinator,
        scorer=score_coordinator,
        evalset_path=_EVALS_DIR / "datasets" / "coordinator.evalset.json",
        holdout_path=_EVALS_DIR / "holdout" / "coordinator.holdout.json",
    )


# Registry of agents with a wired offline eval. Extend here as more agents get
# a deterministic predictor.
_REGISTRY: dict[str, Any] = {
    "coordinator": _coordinator_spec,
}

# The full fleet, for the per-agent coverage surface (`--all`). Each agent has a
# per-agent CONTRACT suite under `tests/agents/test_<agent>.py` (input schema,
# prompt-guard, output schema, escalation, integration). A subset additionally
# has an ACCURACY gate (a deterministic golden predictor + holdout floor).
#
# Honesty (matches HONEST-SCOPE §4 "eval coverage"): full 22/22 *accuracy*
# gating needs a hand-built deterministic baseline per agent (a multi-day P3
# effort) — replaying each evalset's golden `final_response` would score 100% by
# construction, the exact overfit `runner.py` is designed to prevent. So `--all`
# reports both layers truthfully rather than faking accuracy for all 22.
_FLEET_AGENTS: tuple[str, ...] = (
    "coordinator", "sourcing", "vetting", "outreach_writer", "conversation",
    "conversation_responder", "logistics", "content_verify", "analyst",
    "research", "intake", "lead_outreach_writer", "payment_mandate",
    "compliance", "creative", "a11y", "customer_success",
    "critic", "optimizer", "anomaly_watch", "cost_watch", "security_watch",
)
# Agents with a wired ACCURACY gate (deterministic predictor + holdout floor).
_ACCURACY_GATED: frozenset[str] = frozenset({"coordinator", "conversation_responder"})


async def _run_all(holdout_floor: float) -> int:
    """Per-agent evaluation surface. Prints a coverage table for the whole fleet,
    runs every wired ACCURACY gate live, and returns non-zero if any fails.
    """
    print("=" * 68)
    print("  PER-AGENT EVALUATION — fleet coverage surface")
    print("=" * 68)
    print(f"  {'agent':<24} {'gate':<10} where")
    print("  " + "-" * 64)
    for name in _FLEET_AGENTS:
        if name in _ACCURACY_GATED:
            gate, where = "accuracy", f"python -m evals --agent {name}"
        else:
            gate, where = "contract", f"pytest tests/agents/test_{name}.py"
        print(f"  {name:<24} {gate:<10} {where}")
    print("  " + "-" * 64)
    print(f"  fleet={len(_FLEET_AGENTS)}  accuracy-gated={len(_ACCURACY_GATED)}  "
          f"contract-gated={len(_FLEET_AGENTS) - len(_ACCURACY_GATED)}")
    print("=" * 68)

    rc = 0
    for name in sorted(_ACCURACY_GATED):
        print(f"\n>>> ACCURACY gate: {name}")
        rc |= await _run(name, holdout_floor)
    return rc


async def _run(agent: str, holdout_floor: float) -> int:
    # A8 (P1 Sub-1.3) — conversation_responder uses the triage_sim simulator
    # directly because its hardening artefact IS the optimized triage rule set
    # (not an LLM call); the runner.py protocol assumes a model client.
    if agent == "conversation_responder" or agent == "conversation":
        from evals.conversation_responder_eval import run_conversation_responder_eval

        return run_conversation_responder_eval(holdout_floor=holdout_floor)

    if agent not in _REGISTRY:
        known = ", ".join(sorted(_REGISTRY) + ["conversation_responder", "conversation"])
        print(f"[golden-eval] unknown agent {agent!r}. Known: {known}", file=sys.stderr)
        return 4
    spec: AgentEvalSpec = _REGISTRY[agent]()
    evalset = load_evalset(spec.evalset_path)
    split = load_holdout_split(spec.holdout_path)
    report = await run_eval(
        agent_def=spec.agent_def,
        evalset=evalset,
        split=split,
        predictor=spec.predictor,
        scorer=spec.scorer,
    )
    print(format_report(report, holdout_floor=holdout_floor))
    return 0 if report_passed(report, holdout_floor=holdout_floor) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m evals",
        description="Offline golden-eval runner (H5 — D25/D37).",
    )
    parser.add_argument(
        "--agent",
        default="coordinator",
        help="Agent to evaluate (default: coordinator).",
    )
    parser.add_argument(
        "--holdout-floor",
        type=float,
        default=0.7,
        help="Minimum holdout accuracy to PASS (default: 0.70).",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Per-agent evaluation surface: fleet coverage table + run every "
        "wired accuracy gate.",
    )
    args = parser.parse_args(argv)

    # Belt-and-braces: force offline so no creds/Vertex/billing can be reached.
    os.environ.setdefault("SS_OFFLINE", "1")
    os.environ["SS_LIVE"] = "0"

    if args.all:
        return asyncio.run(_run_all(args.holdout_floor))
    return asyncio.run(_run(args.agent, args.holdout_floor))


if __name__ == "__main__":
    raise SystemExit(main())
