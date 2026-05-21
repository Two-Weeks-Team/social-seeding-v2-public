"""runner.py — reproducible OFFLINE golden-eval runner for ss_agents.

Drives a chosen ADK agent through the SUPPORTED offline seam (`run_agent` with an
injected deterministic model client) against an ADK-compatible `.evalset.json`,
scores each case against the case's `metadata` expected fields, splits the result
into train/dev vs holdout slices, and prints a pass/score summary.

D25 (Agent-Evaluation rung of the learning loop) · D37 (Layer-1 of the TDD
pyramid, run offline) · D5 (coordinator = gemini-3.1-flash-lite; scored predictor is
deterministic so the gate is free + reproducible).

──────────────────────────────────────────────────────────────────────────────
WHY A DETERMINISTIC PREDICTOR (the anti-overfit core)
──────────────────────────────────────────────────────────────────────────────
The stored `.evalset.json` files put the golden answer in `final_response`
(expected == answer). Replaying that answer through a stub would score 100% by
construction — the overfit the 4-expert review flagged.

Instead, the runner scores a PREDICTOR that sees ONLY the case input
(`user_content`), never the expected `final_response`. For the coordinator the
predictor is its own deterministic baseline (`pick_best_candidate` + a
keyword→capability matcher + the brief's escalation rules). The predictor can be
WRONG, so the score is meaningful — and a holdout slice it was never tuned on
makes overfit detectable (high train accuracy + low holdout accuracy ⇒ the
keyword table was over-fitted to the visible cases).

The predictor is wrapped in a `PredictorModelClient` that satisfies the runtime's
`StubModelClient` protocol, so the FULL `run_agent` path (input validation,
prompt-guard, USD cap, output validation) is exercised exactly as in production —
only the model call itself is replaced by the deterministic predictor.
"""
from __future__ import annotations

import dataclasses
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from ss_agents.runtime import (
    AgentDef,
    Escalation,
    OutcomeOk,
    RunContext,
    run_agent,
)

# ─────────────────────────────────────────────────────────────────────────────
# Evalset loading — ADK `.evalset.json` shape (eval_set_id / eval_cases[] with
# conversation[].user_content + .final_response + per-case .metadata).
# ─────────────────────────────────────────────────────────────────────────────


@dataclasses.dataclass(frozen=True)
class EvalCase:
    """One scoreable case parsed out of an ADK `.evalset.json` entry."""

    eval_id: str
    input_payload: dict[str, Any]
    """Parsed JSON from conversation[0].user_content.parts[0].text."""

    metadata: dict[str, Any]
    """Per-case metadata — the EXPECTED fields the predictor is scored against
    (e.g. expected_chosen, should_escalate). Never fed to the predictor."""

    expected_response: dict[str, Any] | None
    """Parsed JSON from conversation[0].final_response (the golden answer). Held
    out from the predictor; available to scorers that want exact-match grading."""


@dataclasses.dataclass(frozen=True)
class EvalSet:
    eval_set_id: str
    name: str
    cases: list[EvalCase]
    criteria_overrides: dict[str, float]


def _first_text_part(content: dict[str, Any] | None) -> str | None:
    if not content:
        return None
    parts = content.get("parts") or []
    for part in parts:
        text = part.get("text")
        if isinstance(text, str):
            return text
    return None


def load_evalset(path: str | Path) -> EvalSet:
    """Parse an ADK `.evalset.json` file into an `EvalSet`.

    Tolerant of the two ADK schema variants — the legacy `eval_cases` array used
    by the ss_agents goldens, where each case carries a single-turn
    `conversation` with `user_content` + `final_response`.
    """
    path = Path(path)
    raw = json.loads(path.read_text(encoding="utf-8"))
    cases: list[EvalCase] = []
    for entry in raw.get("eval_cases", []):
        conversation = entry.get("conversation") or []
        if not conversation:
            continue
        turn = conversation[0]
        user_text = _first_text_part(turn.get("user_content"))
        if user_text is None:
            continue
        try:
            input_payload = json.loads(user_text)
        except json.JSONDecodeError:
            # Free-text inputs (some agents) — wrap so the agent's input schema
            # can still coerce it if it expects a single string field.
            input_payload = {"text": user_text}
        final_text = _first_text_part(turn.get("final_response"))
        expected_response: dict[str, Any] | None = None
        if final_text is not None:
            try:
                expected_response = json.loads(final_text)
            except json.JSONDecodeError:
                expected_response = {"text": final_text}
        cases.append(
            EvalCase(
                eval_id=entry.get("eval_id", f"case_{len(cases)}"),
                input_payload=input_payload,
                metadata=entry.get("metadata", {}),
                expected_response=expected_response,
            )
        )
    return EvalSet(
        eval_set_id=raw.get("eval_set_id", path.stem),
        name=raw.get("name", path.stem),
        cases=cases,
        criteria_overrides=raw.get("criteria_overrides", {}),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Holdout split — a frozen manifest names which eval_ids are holdout. Anything
# not named is train/dev (visible, used to tune the predictor / prompt). The
# split lives in a SEPARATE file so the boundary is auditable in git history.
# ─────────────────────────────────────────────────────────────────────────────


@dataclasses.dataclass(frozen=True)
class HoldoutSplit:
    """train/dev vs holdout partition for a single agent's evalset."""

    train_ids: frozenset[str]
    dev_ids: frozenset[str]
    holdout_ids: frozenset[str]

    def slice_of(self, eval_id: str) -> str:
        if eval_id in self.holdout_ids:
            return "holdout"
        if eval_id in self.dev_ids:
            return "dev"
        return "train"


def load_holdout_split(path: str | Path) -> HoldoutSplit:
    """Load a holdout manifest JSON: {"train":[...],"dev":[...],"holdout":[...]}.

    A missing file means "no split" — every case is treated as train, and the
    runner prints a warning. The holdout slice is the one the predictor is NEVER
    tuned against, so it is the overfit detector.
    """
    path = Path(path)
    if not path.exists():
        return HoldoutSplit(frozenset(), frozenset(), frozenset())
    raw = json.loads(path.read_text(encoding="utf-8"))
    return HoldoutSplit(
        train_ids=frozenset(raw.get("train", [])),
        dev_ids=frozenset(raw.get("dev", [])),
        holdout_ids=frozenset(raw.get("holdout", [])),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Predictor model client — satisfies StubModelClient. Produces a REAL prediction
# from the input alone (no peek at expected). One predictor per agent.
# ─────────────────────────────────────────────────────────────────────────────


PredictorFn = Callable[[BaseModel], BaseModel]
"""input_model → output_model. Pure, deterministic, sees no expected answer."""


class PredictorModelClient:
    """Wraps a deterministic `PredictorFn` as a StubModelClient.

    `run_agent` will call `.generate(...)` and we route to the predictor. We
    declare a tiny `_stub_usd` so the runtime's USD-cap path stays exercised but
    the eval is free.
    """

    def __init__(self, predictor: PredictorFn, *, stub_usd: float = 0.0) -> None:
        self._predictor = predictor
        self._stub_usd = stub_usd

    async def generate(
        self,
        *,
        agent_id: str,
        system_prompt: str,
        input_payload: BaseModel,
        output_schema: type[BaseModel],
    ) -> BaseModel:
        # The predictor sees ONLY the validated input — never the expected
        # output. This is what makes the score (and the holdout) meaningful.
        return self._predictor(input_payload)


# ─────────────────────────────────────────────────────────────────────────────
# Scoring — a Scorer maps (predicted_outcome, EvalCase) → bool pass + detail.
# ─────────────────────────────────────────────────────────────────────────────


@dataclasses.dataclass(frozen=True)
class CaseResult:
    eval_id: str
    slice_name: str
    passed: bool
    predicted: dict[str, Any]
    detail: str


ScorerFn = Callable[[OutcomeOk | Escalation, EvalCase], tuple[bool, str]]
"""(outcome, case) → (passed, human-readable detail)."""


@dataclasses.dataclass(frozen=True)
class SliceReport:
    slice_name: str
    total: int
    passed: int

    @property
    def accuracy(self) -> float:
        return (self.passed / self.total) if self.total else 0.0


@dataclasses.dataclass(frozen=True)
class EvalReport:
    eval_set_id: str
    agent_id: str
    case_results: list[CaseResult]
    slices: dict[str, SliceReport]

    @property
    def overall(self) -> SliceReport:
        total = len(self.case_results)
        passed = sum(1 for r in self.case_results if r.passed)
        return SliceReport("overall", total, passed)


async def run_eval(
    *,
    agent_def: AgentDef[Any, Any],
    evalset: EvalSet,
    split: HoldoutSplit,
    predictor: PredictorFn,
    scorer: ScorerFn,
    run_context_factory: Callable[[], RunContext] | None = None,
    predictor_usd: float = 0.0,
) -> EvalReport:
    """Run every case through `run_agent` with the predictor injected, score it,
    and bucket the results by holdout slice.

    Returns an `EvalReport`. Never raises on a case failure — a failing case is
    recorded as `passed=False`, mirroring how a real eval surfaces regressions.
    """

    def _default_ctx() -> RunContext:
        return RunContext(
            tenant_id="t_eval000000000001",
            workspace_id="ws_eval_golden_run",
            trace_id=f"eval-{evalset.eval_set_id}",
            invoked_by="golden-eval@social-seeding.test",
        )

    ctx_factory = run_context_factory or _default_ctx
    client = PredictorModelClient(predictor, stub_usd=predictor_usd)

    results: list[CaseResult] = []
    for case in evalset.cases:
        ctx = ctx_factory()
        ctx.model_client = client
        outcome = await run_agent(agent_def, case.input_payload, ctx)
        passed, detail = scorer(outcome, case)
        if isinstance(outcome, OutcomeOk):
            predicted = outcome.value.model_dump(by_alias=True)
        else:
            predicted = {"escalation_reason": outcome.reason}
        results.append(
            CaseResult(
                eval_id=case.eval_id,
                slice_name=split.slice_of(case.eval_id),
                passed=passed,
                predicted=predicted,
                detail=detail,
            )
        )

    slices: dict[str, SliceReport] = {}
    for slice_name in ("train", "dev", "holdout"):
        bucket = [r for r in results if r.slice_name == slice_name]
        if bucket:
            slices[slice_name] = SliceReport(
                slice_name,
                total=len(bucket),
                passed=sum(1 for r in bucket if r.passed),
            )

    return EvalReport(
        eval_set_id=evalset.eval_set_id,
        agent_id=agent_def.id,
        case_results=results,
        slices=slices,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Reporting — a deterministic, copy-pasteable stdout summary.
# ─────────────────────────────────────────────────────────────────────────────


def format_report(report: EvalReport, *, holdout_floor: float = 0.7) -> str:
    """Render the report as a stable text block.

    The holdout accuracy is the headline number. If it falls below
    `holdout_floor` the runner treats the eval as a FAIL (overfit / regression
    signal), regardless of how high the train accuracy is.
    """
    lines: list[str] = []
    lines.append("=" * 68)
    lines.append(f"GOLDEN EVAL — {report.agent_id}  ({report.eval_set_id})")
    lines.append("=" * 68)
    for r in report.case_results:
        mark = "PASS" if r.passed else "FAIL"
        lines.append(f"  [{mark}] {r.slice_name:<7} {r.eval_id:<42} {r.detail}")
    lines.append("-" * 68)
    for slice_name in ("train", "dev", "holdout"):
        s = report.slices.get(slice_name)
        if s is None:
            continue
        lines.append(
            f"  {slice_name:<8} {s.passed:>2}/{s.total:<2} "
            f"accuracy={s.accuracy:.2%}"
        )
    overall = report.overall
    lines.append(
        f"  {'overall':<8} {overall.passed:>2}/{overall.total:<2} "
        f"accuracy={overall.accuracy:.2%}"
    )
    lines.append("-" * 68)

    holdout = report.slices.get("holdout")
    if holdout is None:
        lines.append("  RESULT: WARN — no holdout slice defined (overfit undetectable)")
    elif holdout.accuracy < holdout_floor:
        lines.append(
            f"  RESULT: FAIL — holdout accuracy {holdout.accuracy:.2%} "
            f"< floor {holdout_floor:.0%} (overfit/regression)"
        )
    else:
        # Overfit gap = train accuracy minus holdout accuracy.
        train = report.slices.get("train")
        gap = (train.accuracy - holdout.accuracy) if train else 0.0
        lines.append(
            f"  RESULT: PASS — holdout {holdout.accuracy:.2%} ≥ floor "
            f"{holdout_floor:.0%}; train↔holdout gap {gap:+.2%}"
        )
    lines.append("=" * 68)
    return "\n".join(lines)


def report_passed(report: EvalReport, *, holdout_floor: float = 0.7) -> bool:
    """The eval gate: holdout slice must exist AND meet the floor."""
    holdout = report.slices.get("holdout")
    if holdout is None:
        return False
    return holdout.accuracy >= holdout_floor


__all__ = [
    "CaseResult",
    "EvalCase",
    "EvalReport",
    "EvalSet",
    "HoldoutSplit",
    "PredictorFn",
    "PredictorModelClient",
    "ScorerFn",
    "SliceReport",
    "format_report",
    "load_evalset",
    "load_holdout_split",
    "report_passed",
    "run_eval",
]
