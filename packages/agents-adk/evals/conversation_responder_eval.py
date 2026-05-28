"""conversation_responder_eval.py — A8 (P1 Sub-1.3) — offline triage eval.

Wires the existing `triage_sim` simulator (the H2 deterministic analogue of
Vertex AI Agent Simulation; see `ss_agents.hardening.triage_sim`) into the
shared `python -m evals` entry point so the 22-agent-fleet claim has a SECOND
formally-gated eval beside `coordinator`. That moves the disclosed coverage
from 1/22 to 2/22 (HONEST-SCOPE row, X1).

This file deliberately bypasses `evals.runner` because the `conversation_responder`
hardening artefact is the optimized triage function itself (a pure rule set),
not an LLM call routed through a stub model client. The simulator already
splits train/holdout (D25 / D37), so the same gate semantics apply:

    HOLDOUT accuracy ≥ floor      → exit 0 (PASS)
    HOLDOUT accuracy < floor      → exit 1 (FAIL)

The PR #__ hardening baseline (memory: 40.5% → 100% train, 71.4% holdout)
is exactly the train↔holdout gap honestly disclosed in HONEST-SCOPE / D52.
"""
from __future__ import annotations

import sys
from typing import Final

from ss_agents.hardening.triage_sim import (
    RuleSet,
    SimReport,
    case_split,
    load_cases,
    run_simulation,
)

_DEFAULT_RULE_SET: Final[RuleSet] = "optimized"


def _split_accuracy(report: SimReport, split: str) -> tuple[int, int, float]:
    """Return (passed, total, accuracy) for a single split label."""
    cases = [r for r in report.results if r.split == split]
    if not cases:
        return 0, 0, 0.0
    passed = sum(1 for r in cases if r.passed)
    return passed, len(cases), passed / len(cases)


def run_conversation_responder_eval(
    *,
    rule_set: RuleSet = _DEFAULT_RULE_SET,
    holdout_floor: float = 0.7,
    out_stream=sys.stdout,
) -> int:
    """Execute the offline triage eval and print a runner-shaped report.

    Returns the process exit code (0 on PASS, 1 on FAIL) so the
    `python -m evals --agent conversation` invocation can exit honestly.
    """
    all_cases = load_cases(subset="all")
    report = run_simulation(rule_set=rule_set, cases=all_cases, subset="all")

    train_p, train_n, train_acc = _split_accuracy(report, "train")
    holdout_p, holdout_n, holdout_acc = _split_accuracy(report, "holdout")

    out_stream.write("=" * 68 + "\n")
    out_stream.write(
        f"  conversation_responder · rule_set={rule_set} · D25/D37 offline gate\n"
    )
    out_stream.write("-" * 68 + "\n")
    # Per-case lines so a judge can scan + diff. Train/holdout interleaved by
    # category to keep the per-bucket pass-pattern visible.
    for r in report.results:
        flag = "PASS" if r.passed else "FAIL"
        out_stream.write(
            f"  [{flag}] {r.split:<7} {r.case_id:<48} "
            f"expected={r.expected_decision} predicted={r.actual_decision}\n"
        )
    out_stream.write("-" * 68 + "\n")
    out_stream.write(
        f"  train     {train_p}/{train_n}  accuracy={train_acc * 100:.2f}%\n"
    )
    out_stream.write(
        f"  holdout   {holdout_p}/{holdout_n}  accuracy={holdout_acc * 100:.2f}%\n"
    )
    overall_p = train_p + holdout_p
    overall_n = train_n + holdout_n
    overall_acc = overall_p / overall_n if overall_n else 0.0
    out_stream.write(
        f"  overall  {overall_p}/{overall_n} accuracy={overall_acc * 100:.2f}%\n"
    )
    out_stream.write("-" * 68 + "\n")

    if holdout_n == 0:
        out_stream.write(
            "  RESULT: FAIL — holdout slice empty; expected ≥ 1 holdout case.\n"
        )
        out_stream.write("=" * 68 + "\n")
        return 1

    gap = train_acc - holdout_acc
    if holdout_acc >= holdout_floor:
        out_stream.write(
            f"  RESULT: PASS — holdout {holdout_acc * 100:.2f}% ≥ floor "
            f"{holdout_floor * 100:.0f}%; train↔holdout gap {gap * 100:+.2f}%\n"
        )
        out_stream.write("=" * 68 + "\n")
        return 0
    out_stream.write(
        f"  RESULT: FAIL — holdout {holdout_acc * 100:.2f}% < floor "
        f"{holdout_floor * 100:.0f}%; train↔holdout gap {gap * 100:+.2f}%\n"
    )
    out_stream.write("=" * 68 + "\n")
    return 1


__all__ = ["run_conversation_responder_eval"]
