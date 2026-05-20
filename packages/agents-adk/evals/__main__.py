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


async def _run(agent: str, holdout_floor: float) -> int:
    if agent not in _REGISTRY:
        known = ", ".join(sorted(_REGISTRY))
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
    args = parser.parse_args(argv)

    # Belt-and-braces: force offline so no creds/Vertex/billing can be reached.
    os.environ.setdefault("SS_OFFLINE", "1")
    os.environ["SS_LIVE"] = "0"

    return asyncio.run(_run(args.agent, args.holdout_floor))


if __name__ == "__main__":
    raise SystemExit(main())
