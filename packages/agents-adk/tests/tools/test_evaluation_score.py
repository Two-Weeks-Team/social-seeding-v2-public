"""tests/tools/test_evaluation_score.py — capability-layer seam tests.

Covers:
  - Stub returns deterministic top-line score = 0.85.
  - sub_scores sum to ≤ 1.0 across small + large rubric sizes.
  - Output validator rejects sub_scores that sum > 1.0.
  - Output validator rejects out-of-range individual sub_scores.
  - Stub determinism (same input ⇒ identical JSON).
  - Live mode raises NotImplementedError.
  - Pydantic input validation.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from ss_agents.tools.evaluation_score import (
    USD_COST,
    EvaluationScoreInput,
    EvaluationScoreOutput,
    evaluation_score,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub happy path — score 0.85 + deterministic
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_returns_score_0_85(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = evaluation_score(
        EvaluationScoreInput(
            agentId="sourcing",
            agentOutput={"creators": ["@a", "@b"]},
            evaluationRubric=["recall", "precision", "freshness"],
        )
    )
    assert isinstance(out, EvaluationScoreOutput)
    assert out.score_0_1 == 0.85
    assert out.escalation_recommended is False  # 0.85 >= 0.60 floor


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = EvaluationScoreInput(
        agentId="vetting",
        agentOutput={"score": 0.9},
        evaluationRubric=["accuracy", "calibration"],
    )
    a = evaluation_score(payload)
    b = evaluation_score(payload)
    assert a.model_dump_json() == b.model_dump_json()


# ─────────────────────────────────────────────────────────────────────────────
# 2. sub_scores sum to ≤ 1.0 — across rubric sizes
# ─────────────────────────────────────────────────────────────────────────────


def test_sub_scores_sum_le_one_for_one_criterion() -> None:
    out = evaluation_score(
        EvaluationScoreInput(
            agentId="intake",
            agentOutput={"brief": {}},
            evaluationRubric=["completeness"],
        )
    )
    assert sum(out.sub_scores.values()) <= 1.0
    assert "completeness" in out.sub_scores


def test_sub_scores_sum_le_one_for_four_criteria() -> None:
    out = evaluation_score(
        EvaluationScoreInput(
            agentId="outreach_writer",
            agentOutput={"draft": "hello"},
            evaluationRubric=["clarity", "persona", "compliance", "hook"],
        )
    )
    total = sum(out.sub_scores.values())
    assert total <= 1.0 + 1e-9
    assert len(out.sub_scores) == 4


def test_sub_scores_sum_le_one_for_twelve_criteria() -> None:
    """Max rubric size — residual is split evenly across the trailing entries."""
    rubric = [f"crit_{i:02d}" for i in range(12)]
    out = evaluation_score(
        EvaluationScoreInput(
            agentId="analyst",
            agentOutput={"report": "ok"},
            evaluationRubric=rubric,
        )
    )
    total = sum(out.sub_scores.values())
    assert total <= 1.0 + 1e-6
    assert len(out.sub_scores) == 12


def test_sub_scores_individually_bounded() -> None:
    """Every sub-score lies in [0.0, 1.0]."""
    out = evaluation_score(
        EvaluationScoreInput(
            agentId="critic",
            agentOutput={},
            evaluationRubric=["a", "b", "c"],
        )
    )
    for name, score in out.sub_scores.items():
        assert 0.0 <= score <= 1.0, f"{name}={score} out of range"


# ─────────────────────────────────────────────────────────────────────────────
# 3. Output validator rejects bad sub_scores
# ─────────────────────────────────────────────────────────────────────────────


def test_output_rejects_sub_scores_sum_gt_one() -> None:
    """A direct construction with sub_scores summing > 1.0 fails validation."""
    with pytest.raises(ValidationError):
        EvaluationScoreOutput(
            score01=0.9,
            subScores={"a": 0.6, "b": 0.5},  # sum=1.1 > 1.0
            reasoning="bad",
            escalationRecommended=False,
        )


def test_output_rejects_negative_sub_score() -> None:
    with pytest.raises(ValidationError):
        EvaluationScoreOutput(
            score01=0.9,
            subScores={"a": -0.1},
            reasoning="bad",
            escalationRecommended=False,
        )


def test_output_rejects_sub_score_above_one() -> None:
    with pytest.raises(ValidationError):
        EvaluationScoreOutput(
            score01=0.9,
            subScores={"a": 1.5},
            reasoning="bad",
            escalationRecommended=False,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Live mode raises with W7 message
# ─────────────────────────────────────────────────────────────────────────────


def test_live_mode_raises_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    with pytest.raises(NotImplementedError, match=r"W7 deploy phase"):
        evaluation_score(
            EvaluationScoreInput(
                agentId="sourcing",
                agentOutput={},
                evaluationRubric=["a"],
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# 5. Input validation
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_empty_rubric() -> None:
    with pytest.raises(ValidationError):
        EvaluationScoreInput(
            agentId="sourcing", agentOutput={}, evaluationRubric=[]
        )


def test_input_rejects_too_many_rubric_entries() -> None:
    with pytest.raises(ValidationError):
        EvaluationScoreInput(
            agentId="sourcing",
            agentOutput={},
            evaluationRubric=[f"c{i}" for i in range(13)],
        )


def test_input_rejects_blank_rubric_criterion() -> None:
    with pytest.raises(ValidationError):
        EvaluationScoreInput(
            agentId="sourcing", agentOutput={}, evaluationRubric=["", "ok"]
        )


def test_input_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        EvaluationScoreInput.model_validate(
            {
                "agentId": "sourcing",
                "agentOutput": {},
                "evaluationRubric": ["a"],
                "extra": True,
            }
        )


def test_input_caps_reference_examples_at_5() -> None:
    with pytest.raises(ValidationError):
        EvaluationScoreInput(
            agentId="sourcing",
            agentOutput={},
            evaluationRubric=["a"],
            referenceExamples=[{"i": i} for i in range(6)],
        )


# ─────────────────────────────────────────────────────────────────────────────
# Cost attribute
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(evaluation_score, "usd_cost")
    assert evaluation_score.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(evaluation_score.usd_cost, float)  # type: ignore[attr-defined]
