"""tests/evals/test_eval_runner.py — coverage for the H5 golden-eval runner.

Verifies the OFFLINE runner machinery itself (not the agent under test):
  - evalset / holdout parsing from the ADK `.evalset.json` shape;
  - the predictor sees ONLY the input (the anti-overfit invariant);
  - run_eval drives run_agent offline and buckets results by slice;
  - format_report / report_passed apply the holdout floor correctly;
  - the shipped coordinator eval clears its floor and the holdout is non-empty.

D25 (Agent-Evaluation rung) · D37 (Layer-1 offline gate) · D5 (deterministic
predictor scored, not a live Flash call).
"""
from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import BaseModel

from evals.coordinator_eval import predict_coordinator, score_coordinator
from evals.runner import (
    CaseResult,
    EvalCase,
    HoldoutSplit,
    PredictorModelClient,
    SliceReport,
    format_report,
    load_evalset,
    load_holdout_split,
    report_passed,
    run_eval,
)
from ss_agents.agents.coordinator import (
    ESCALATE_AGENT_ID,
    CoordinatorInput,
    CoordinatorOutput,
    coordinator_agent_def,
)
from ss_agents.runtime import Escalation, OutcomeOk

_EVALS_DIR = Path(__file__).resolve().parents[2] / "evals"
_COORD_EVALSET = _EVALS_DIR / "datasets" / "coordinator.evalset.json"
_COORD_HOLDOUT = _EVALS_DIR / "holdout" / "coordinator.holdout.json"


# ═════════════════════════════════════════════════════════════════════════════
# 1. Evalset + holdout parsing.
# ═════════════════════════════════════════════════════════════════════════════


class TestEvalsetLoading:
    def test_loads_coordinator_evalset(self) -> None:
        es = load_evalset(_COORD_EVALSET)
        assert es.eval_set_id == "ss_coordinator_h5_v1"
        # At least 12 cases per the H5 deliverable.
        assert len(es.cases) >= 12

    def test_cases_parse_input_and_metadata(self) -> None:
        es = load_evalset(_COORD_EVALSET)
        case = next(c for c in es.cases if c.eval_id == "coord_en_01_pick_local_sourcing")
        # Input is the parsed user_content JSON — the predictor's only view.
        assert case.input_payload["taskDescription"].startswith("Find 20 Korean")
        # Metadata carries the expected answer used by the scorer.
        assert case.metadata["expected_chosen"] == "sourcing"
        assert case.metadata["should_escalate"] is False
        # The golden final_response is parsed but kept separate (not fed in).
        assert case.expected_response is not None
        assert case.expected_response["chosenAgentId"] == "sourcing"

    def test_missing_evalset_is_explicit(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            load_evalset(tmp_path / "nope.evalset.json")

    def test_free_text_input_falls_back_to_text_wrapper(self, tmp_path: Path) -> None:
        p = tmp_path / "freetext.evalset.json"
        p.write_text(
            '{"eval_set_id":"x","eval_cases":[{"eval_id":"a","conversation":'
            '[{"user_content":{"parts":[{"text":"not json at all"}]}}]}]}',
            encoding="utf-8",
        )
        es = load_evalset(p)
        assert es.cases[0].input_payload == {"text": "not json at all"}


class TestHoldoutSplit:
    def test_loads_split(self) -> None:
        split = load_holdout_split(_COORD_HOLDOUT)
        # Holdout slice MUST be non-empty — it is the overfit detector.
        assert len(split.holdout_ids) >= 1
        assert len(split.train_ids) >= 1

    def test_slice_of_classifies(self) -> None:
        split = HoldoutSplit(
            train_ids=frozenset({"a"}),
            dev_ids=frozenset({"b"}),
            holdout_ids=frozenset({"c"}),
        )
        assert split.slice_of("a") == "train"
        assert split.slice_of("b") == "dev"
        assert split.slice_of("c") == "holdout"
        # Unknown ids default to train (the visible pool).
        assert split.slice_of("z") == "train"

    def test_missing_manifest_yields_empty_split(self, tmp_path: Path) -> None:
        split = load_holdout_split(tmp_path / "absent.json")
        assert split.holdout_ids == frozenset()
        assert split.slice_of("anything") == "train"

    def test_every_case_is_in_exactly_one_slice(self) -> None:
        es = load_evalset(_COORD_EVALSET)
        split = load_holdout_split(_COORD_HOLDOUT)
        all_ids = {c.eval_id for c in es.cases}
        slotted = split.train_ids | split.dev_ids | split.holdout_ids
        # No case is unaccounted for, and no manifest id is a typo.
        assert all_ids == slotted
        # Slices are disjoint.
        assert not (split.train_ids & split.holdout_ids)
        assert not (split.dev_ids & split.holdout_ids)


# ═════════════════════════════════════════════════════════════════════════════
# 2. Predictor invariant — sees ONLY the input, never the expected answer.
# ═════════════════════════════════════════════════════════════════════════════


class TestPredictorModelClient:
    async def test_client_routes_to_predictor(self) -> None:
        seen: list[BaseModel] = []

        def predictor(payload: BaseModel) -> BaseModel:
            seen.append(payload)
            return CoordinatorOutput(
                chosenAgentId="sourcing",
                routingRationale="stub prediction for the test",
                expectedCostUsd=0.01,
                expectedLatencyMs=1000,
                confidence=0.8,
            )

        client = PredictorModelClient(predictor, stub_usd=0.0)
        payload = CoordinatorInput.model_validate(
            {
                "taskDescription": "find creators",
                "workspacePolicy": {
                    "allowedAgents": [],
                    "budgetRemainingUsd": 2.0,
                    "slaTargetMs": 4000,
                },
                "candidateAgents": [
                    {
                        "agentId": "sourcing",
                        "capabilities": ["source_creators"],
                        "avgLatencyMs": 2000,
                        "avgCostUsd": 0.01,
                    }
                ],
            }
        )
        out = await client.generate(
            agent_id="coordinator",
            system_prompt="…",
            input_payload=payload,
            output_schema=CoordinatorOutput,
        )
        assert isinstance(out, CoordinatorOutput)
        # The predictor received the INPUT model and nothing else.
        assert seen == [payload]

    def test_predictor_signature_takes_only_input(self) -> None:
        """Static guard: predict_coordinator is unary (input → output). If a
        future edit adds an 'expected' parameter the contract breaks loudly."""
        import inspect

        params = list(inspect.signature(predict_coordinator).parameters)
        assert params == ["payload"]


# ═════════════════════════════════════════════════════════════════════════════
# 3. run_eval — end-to-end offline drive + slice bucketing.
# ═════════════════════════════════════════════════════════════════════════════


class TestRunEval:
    async def test_perfect_predictor_scores_all_pass(self) -> None:
        """A predictor that always returns each case's golden answer scores
        100% — confirms the scoring plumbing is correct (this is the trivial
        overfit baseline; the SHIPPED predictor is fallible, see below)."""
        es = load_evalset(_COORD_EVALSET)
        split = load_holdout_split(_COORD_HOLDOUT)

        by_id = {c.eval_id: c for c in es.cases}

        def oracle(payload: BaseModel) -> BaseModel:
            # Reconstruct the expected answer from the matching case's golden
            # final_response. Allowed ONLY in this test to validate the harness.
            assert isinstance(payload, CoordinatorInput)
            for case in by_id.values():
                if case.input_payload.get("taskDescription") == payload.task_description:
                    exp = case.expected_response
                    assert exp is not None
                    return CoordinatorOutput.model_validate(exp)
            raise AssertionError("no matching case")

        report = await run_eval(
            agent_def=coordinator_agent_def,
            evalset=es,
            split=split,
            predictor=oracle,
            scorer=score_coordinator,
        )
        assert report.overall.total == len(es.cases)
        assert report.overall.passed == len(es.cases)
        assert report_passed(report, holdout_floor=0.7)

    async def test_shipped_predictor_is_fallible_but_passes_floor(self) -> None:
        """The REAL deterministic predictor is not perfect — that fallibility is
        what makes the holdout a genuine test. It must still clear the floor."""
        es = load_evalset(_COORD_EVALSET)
        split = load_holdout_split(_COORD_HOLDOUT)
        report = await run_eval(
            agent_def=coordinator_agent_def,
            evalset=es,
            split=split,
            predictor=predict_coordinator,  # type: ignore[arg-type]
            scorer=score_coordinator,
        )
        # Holdout slice exists and the gate passes.
        assert "holdout" in report.slices
        assert report_passed(report, holdout_floor=0.7)
        # The predictor is genuinely fallible somewhere across the set OR the
        # train↔holdout gap is non-trivial — i.e. NOT a 100%/100% overfit.
        overall = report.overall
        train = report.slices["train"]
        holdout = report.slices["holdout"]
        not_overfit = (overall.passed < overall.total) or (
            train.accuracy - holdout.accuracy > 0.0
        )
        assert not_overfit, "a 100%/100% result would mean the eval is overfit"

    async def test_run_eval_buckets_by_slice(self) -> None:
        es = load_evalset(_COORD_EVALSET)
        split = load_holdout_split(_COORD_HOLDOUT)
        report = await run_eval(
            agent_def=coordinator_agent_def,
            evalset=es,
            split=split,
            predictor=predict_coordinator,  # type: ignore[arg-type]
            scorer=score_coordinator,
        )
        # Each case is recorded with the slice the manifest assigns.
        for r in report.case_results:
            assert r.slice_name == split.slice_of(r.eval_id)
        total_in_slices = sum(s.total for s in report.slices.values())
        assert total_in_slices == len(es.cases)

    async def test_failing_predictor_does_not_raise(self) -> None:
        """A predictor that returns an out-of-pool choice surfaces as a FAILED
        case (Escalation from the runtime cross-check), never an exception."""
        es = load_evalset(_COORD_EVALSET)
        split = load_holdout_split(_COORD_HOLDOUT)

        def bad(payload: BaseModel) -> BaseModel:
            return CoordinatorOutput(
                chosenAgentId="sourcing",
                routingRationale="always picks sourcing regardless of task",
                expectedCostUsd=0.018,
                expectedLatencyMs=2400,
                confidence=0.9,
            )

        report = await run_eval(
            agent_def=coordinator_agent_def,
            evalset=es,
            split=split,
            predictor=bad,
            scorer=score_coordinator,
        )
        # Some cases necessarily fail (escalation / non-sourcing expectations).
        assert report.overall.passed < report.overall.total


# ═════════════════════════════════════════════════════════════════════════════
# 4. Scorer logic.
# ═════════════════════════════════════════════════════════════════════════════


class TestScorer:
    def _case(self, **md: object) -> EvalCase:
        return EvalCase(
            eval_id="t",
            input_payload={},
            metadata=dict(md),
            expected_response=None,
        )

    def _ok(self, chosen: str) -> OutcomeOk:
        return OutcomeOk(
            value=CoordinatorOutput(
                chosenAgentId=chosen,
                routingRationale="rationale for the scorer test path",
                expectedCostUsd=0.01,
                expectedLatencyMs=1000,
                confidence=0.8,
            ),
            usdSpent=0.0,
        )

    def test_correct_pick_passes(self) -> None:
        passed, _ = score_coordinator(
            self._ok("sourcing"),
            self._case(expected_chosen="sourcing", should_escalate=False),
        )
        assert passed

    def test_wrong_pick_fails(self) -> None:
        passed, detail = score_coordinator(
            self._ok("vetting"),
            self._case(expected_chosen="sourcing", should_escalate=False),
        )
        assert not passed
        assert "expected=sourcing" in detail

    def test_self_escalation_matches_expected_escalate(self) -> None:
        passed, _ = score_coordinator(
            self._ok(ESCALATE_AGENT_ID),
            self._case(expected_chosen="__escalate__", should_escalate=True),
        )
        assert passed

    def test_runtime_escalation_matches_expected_escalate(self) -> None:
        esc = Escalation(reason="budget exhausted", usdSpent=0.0)
        passed, _ = score_coordinator(
            esc, self._case(expected_chosen="__escalate__", should_escalate=True)
        )
        assert passed

    def test_pick_when_escalation_expected_fails(self) -> None:
        passed, _ = score_coordinator(
            self._ok("sourcing"),
            self._case(expected_chosen="__escalate__", should_escalate=True),
        )
        assert not passed


# ═════════════════════════════════════════════════════════════════════════════
# 5. Reporting + gate.
# ═════════════════════════════════════════════════════════════════════════════


class TestReporting:
    def _report(self, holdout_passed: int, holdout_total: int) -> object:
        from evals.runner import EvalReport

        results = [
            CaseResult(
                eval_id=f"h{i}",
                slice_name="holdout",
                passed=i < holdout_passed,
                predicted={},
                detail="",
            )
            for i in range(holdout_total)
        ]
        slices = {
            "holdout": SliceReport("holdout", holdout_total, holdout_passed),
        }
        return EvalReport(
            eval_set_id="x",
            agent_id="coordinator",
            case_results=results,
            slices=slices,
        )

    def test_report_passes_above_floor(self) -> None:
        report = self._report(holdout_passed=3, holdout_total=4)  # 75%
        assert report_passed(report, holdout_floor=0.7)  # type: ignore[arg-type]

    def test_report_fails_below_floor(self) -> None:
        report = self._report(holdout_passed=2, holdout_total=4)  # 50%
        assert not report_passed(report, holdout_floor=0.7)  # type: ignore[arg-type]

    def test_no_holdout_fails_gate(self) -> None:
        from evals.runner import EvalReport

        report = EvalReport(
            eval_set_id="x", agent_id="c", case_results=[], slices={}
        )
        assert not report_passed(report, holdout_floor=0.7)

    def test_format_report_renders_result_line(self) -> None:
        report = self._report(holdout_passed=3, holdout_total=4)
        text = format_report(report, holdout_floor=0.7)  # type: ignore[arg-type]
        assert "GOLDEN EVAL" in text
        assert "holdout" in text
        assert "RESULT: PASS" in text

    def test_format_report_flags_overfit_below_floor(self) -> None:
        report = self._report(holdout_passed=1, holdout_total=4)  # 25%
        text = format_report(report, holdout_floor=0.7)  # type: ignore[arg-type]
        assert "RESULT: FAIL" in text
