"""triage_sim.py — H2 Agent Simulation over the conversation_responder triage.

Loads the hand-authored synthetic edge-case set (test-harness/hardening/
synthetic_cases.json), runs a triage rule set against every case, and scores the
pass-rate. A "pass" is: the triage's `action` matches the case's
`expected_decision` AND the `reason` matches `expected_reason_tag`.

This is the deterministic, offline analogue of Vertex AI Agent Simulation
(D25 learning loop); it runs with no LLM, no GCP credentials, no billing — it
only invokes the pure `triage_inbound` / `_baseline_triage` / `_optimized_triage`
functions in `ss_agents.agents.conversation_responder`. It is NOT the GA Vertex
AI Prompt Optimizer (that is the production path; see optimizer_pass.py).

Pass either rule set:
    · "baseline"  → `_baseline_triage` (the prompt-only era; misses the stall).
    · "optimized" → `_optimized_triage` (the live `triage_inbound` behavior).

The failing cases from the baseline run are turned into
`agent_optimizer_tune.ObservedFailure` records so the Optimizer pass (H4) can
consume the SAME failure shape the live Vertex AI Prompt Optimizer
(data-driven) would (those become its labeled examples).

Citations: D23, D25, D32, D5. GRAND-NARRATIVE-PLAN §5-1 (H2).
"""
from __future__ import annotations

import json
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from ss_agents.agents.conversation_responder import (
    ConversationTurnInput,
    OutreachFacts,
    TriageAction,
    TriageDecision,
    TriageReasonTag,
    _baseline_triage,
    triage_inbound,
)
from ss_agents.tools.agent_optimizer_tune import ObservedFailure

RuleSet = Literal["baseline", "optimized"]
"""Which triage to run. `optimized` exercises the agent's LIVE behavior
(`triage_inbound` delegates to `_optimized_triage`)."""

Subset = Literal["all", "train", "holdout"]
"""Which slice of the synthetic set to score (D25, D37):

  · train    → the cases the `_optimized_triage` rules were authored against.
  · holdout  → the ADVERSARIAL slice carved out AFTER the rules were written and
               NOT used to design them. Measures GENERALIZATION (not memorization);
               the optimized triage does well but NOT perfectly here, on purpose.
  · all      → train + holdout (the full set).

A case's slice is its `split` field (default "train" when absent — the original
26 cases predate the split and are all train)."""

DEFAULT_SPLIT = "train"
"""Cases without an explicit `split` are treated as train (the original set)."""

# Map a rule-set name to its pure triage function. `optimized` points at the
# public `triage_inbound` to prove the measured "after" IS the live behavior.
_RULE_SETS: dict[RuleSet, Callable[[ConversationTurnInput, OutreachFacts], TriageDecision]] = {
    "baseline": _baseline_triage,
    "optimized": triage_inbound,
}


# Resolve the synthetic set relative to the repo root. The package lives at
# packages/agents-adk/src/ss_agents/hardening; the set lives at
# test-harness/hardening/synthetic_cases.json (5 parents up to repo root).
_REPO_ROOT = Path(__file__).resolve().parents[5]
DEFAULT_CASES_PATH = _REPO_ROOT / "test-harness" / "hardening" / "synthetic_cases.json"


@dataclass(frozen=True)
class CaseResult:
    """One synthetic case scored against a triage rule set."""

    case_id: str
    category: str
    locale: str
    split: str
    expected_decision: TriageAction
    expected_reason_tag: TriageReasonTag
    actual_decision: TriageAction
    actual_reason_tag: str
    passed: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "case_id": self.case_id,
            "category": self.category,
            "locale": self.locale,
            "split": self.split,
            "expected_decision": self.expected_decision,
            "expected_reason_tag": self.expected_reason_tag,
            "actual_decision": self.actual_decision,
            "actual_reason_tag": self.actual_reason_tag,
            "passed": self.passed,
        }


@dataclass(frozen=True)
class SimReport:
    """Aggregate of one full simulation pass over the synthetic set."""

    rule_set: RuleSet
    total: int
    passed: int
    subset: Subset = "all"
    results: list[CaseResult] = field(default_factory=list)

    @property
    def pass_rate(self) -> float:
        return (self.passed / self.total) if self.total else 0.0

    @property
    def failures(self) -> list[CaseResult]:
        return [r for r in self.results if not r.passed]

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_set": self.rule_set,
            "subset": self.subset,
            "total": self.total,
            "passed": self.passed,
            "pass_rate": round(self.pass_rate, 4),
            "pass_rate_pct": round(self.pass_rate * 100, 1),
            "by_category_failures": dict(
                Counter(r.category for r in self.failures)
            ),
            "results": [r.to_dict() for r in self.results],
        }


def case_split(case: dict[str, Any]) -> str:
    """Return a case's slice (`train`/`holdout`), defaulting to train when the
    `split` field is absent (the original 26 cases predate the split)."""
    return str(case.get("split", DEFAULT_SPLIT))


def load_cases(
    path: str | Path = DEFAULT_CASES_PATH, *, subset: Subset = "all"
) -> list[dict[str, Any]]:
    """Load the synthetic edge-case set, optionally filtered to one slice.

    Raises if malformed or if the requested `subset` is empty (so a typo / a
    dropped holdout block fails loudly instead of silently scoring 0 cases)."""
    p = Path(path)
    with p.open("r", encoding="utf-8") as f:
        doc = json.load(f)
    if not isinstance(doc, dict) or "cases" not in doc:
        raise ValueError(f"{p}: missing top-level `cases` list")
    cases = doc["cases"]
    if not isinstance(cases, list) or not cases:
        raise ValueError(f"{p}: `cases` must be a non-empty list")
    if subset != "all":
        cases = [c for c in cases if case_split(c) == subset]
        if not cases:
            raise ValueError(f"{p}: no cases in subset {subset!r}")
    return cases


def _decide(
    rule_fn: Callable[[ConversationTurnInput, OutreachFacts], TriageDecision],
    case: dict[str, Any],
) -> TriageDecision:
    """Parse a single case's input and run the triage. Pydantic validation here
    doubles as a contract check on the synthetic set."""
    payload = case["input"]
    turn = ConversationTurnInput.model_validate(payload["turn"])
    facts = OutreachFacts.model_validate(payload["facts"])
    return rule_fn(turn, facts)


def run_simulation(
    rule_set: RuleSet,
    cases: list[dict[str, Any]] | None = None,
    *,
    subset: Subset = "all",
    cases_path: str | Path = DEFAULT_CASES_PATH,
) -> SimReport:
    """Run `rule_set` over a `subset` of the synthetic set and score it.

    A case passes iff BOTH the action and the reason tag match the expected
    values. (Matching only the action would let a right-answer-for-the-wrong-
    reason slip through — a real risk for the rate-signal cases.)

    `subset` selects the slice (D25, D37):
      · "all"     → train + holdout (the full set; default).
      · "train"   → the cases the optimized rules were authored against.
      · "holdout" → the adversarial generalization slice (NOT used to design the
                    rules). The optimized triage scores < 100% here on purpose.

    When `cases` is passed explicitly the caller owns the slicing and `subset`
    only labels the report (no re-filtering — so a pre-filtered list isn't
    double-filtered).
    """
    if rule_set not in _RULE_SETS:
        raise ValueError(f"unknown rule_set {rule_set!r}; expected one of {list(_RULE_SETS)}")
    rule_fn = _RULE_SETS[rule_set]
    if cases is not None:
        raw_cases = cases
    else:
        raw_cases = load_cases(cases_path, subset=subset)

    results: list[CaseResult] = []
    for case in raw_cases:
        decision = _decide(rule_fn, case)
        expected_decision: TriageAction = case["expected_decision"]
        expected_reason: TriageReasonTag = case["expected_reason_tag"]
        passed = (
            decision.action == expected_decision
            and decision.reason == expected_reason
        )
        results.append(
            CaseResult(
                case_id=case["id"],
                category=case.get("category", "uncategorized"),
                locale=case["input"].get("locale", "?"),
                split=case_split(case),
                expected_decision=expected_decision,
                expected_reason_tag=expected_reason,
                actual_decision=decision.action,
                actual_reason_tag=decision.reason,
                passed=passed,
            )
        )

    return SimReport(
        rule_set=rule_set,
        total=len(results),
        passed=sum(1 for r in results if r.passed),
        subset=subset,
        results=results,
    )


def build_observed_failures(report: SimReport) -> list[ObservedFailure]:
    """Turn a simulation report's failures into the SAME `ObservedFailure`
    shape the live Vertex AI Prompt Optimizer (data-driven) would consume as
    labeled examples (H4 input).

    Groups failures by the EXPECTED reason tag they should have produced — that
    is the failure family the optimizer needs to learn to handle. The `payload`
    carries a redacted exemplar (the misrouted case id + actual vs expected) so
    the Observability trace can render it.
    """
    by_expected: dict[str, list[CaseResult]] = {}
    for r in report.failures:
        by_expected.setdefault(r.expected_reason_tag, []).append(r)

    failures: list[ObservedFailure] = []
    for expected_tag, group in sorted(by_expected.items()):
        exemplar = group[0]
        failures.append(
            ObservedFailure(
                kind=f"misrouted:{expected_tag}",
                sampleCount=len(group),
                payload={
                    "expected_decision": exemplar.expected_decision,
                    "expected_reason_tag": expected_tag,
                    "observed_decision": exemplar.actual_decision,
                    "observed_reason_tag": exemplar.actual_reason_tag,
                    "example_case_ids": [r.case_id for r in group][:5],
                },
            )
        )
    return failures


__all__ = [
    "DEFAULT_CASES_PATH",
    "DEFAULT_SPLIT",
    "CaseResult",
    "RuleSet",
    "SimReport",
    "Subset",
    "build_observed_failures",
    "case_split",
    "load_cases",
    "run_simulation",
]
