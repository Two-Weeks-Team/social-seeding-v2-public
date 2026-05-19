"""evaluation_score — capability layer per D41.

LLM-as-judge score per the D25 learning loop (Prompt + Agent Evaluation + SFT
+ Distillation + RLHF on Simulation). Implements the `agent_evaluation.score`
capability that the Tier-2 M2 critic (D23) consumes from
`critic.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Returns a deterministic score of 0.85 with stable per-rubric sub-scores
    that sum to ≤ 1.0. Reasoning text echoes the agent_id + the first rubric
    criterion so test assertions can pin to a stable surface.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real Vertex AI Agent Evaluation invocation against an LLM-as-judge
    template. Wired in W7 deploy phase — raises `NotImplementedError`
    until then.

Citations:
    D23 — Tier-2 M2 critic.
    D25 — Learning loop (Agent Evaluation as the scoring substrate).
    D41 — Capability-layer ADK FunctionTool stub/live pattern.
    critic.spec.md §6 — Tool table row for `agent_evaluation.score`.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

logger = logging.getLogger(__name__)

USD_COST: float = 0.0050
"""Vertex AI Agent Evaluation list price (2026 H1): ~$5 / 1k evaluations.
Surfaced via `evaluation_score.usd_cost` for `cost_watch` (D41)."""


# Stub score constants — task brief pins these so /goal evaluator + golden
# tests can assert on stable numbers.
_STUB_SCORE: float = 0.85
"""Deterministic top-line score returned by stub mode."""

_STUB_SUB_SCORES_BASE: tuple[float, ...] = (0.25, 0.25, 0.20, 0.15)
"""Sub-score weights applied across the rubric criteria.

Per the task brief sub_scores MUST sum to ≤ 1.0. We pre-allocate weights for
up to 4 criteria; for shorter rubrics we slice; for longer rubrics we
distribute the residual evenly. See `_compute_sub_scores`."""

_STUB_ESCALATION_THRESHOLD: float = 0.60
"""Stub escalates when score < 0.60. Stub default score (0.85) never trips
this; tests that need an escalation override the score via monkeypatch."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class EvaluationScoreInput(BaseModel):
    """Input contract — `agent_evaluation.score` per critic.spec.md §6.

    Attributes:
        agent_id: The agent under evaluation (e.g. `"sourcing"`). Echoed in
            the `reasoning` field so the critic can attribute the score.
        agent_output: The candidate output to score. Content-blind dict —
            the critic owns the shape via its rubric.
        evaluation_rubric: List of criterion names (1-12). Each criterion
            gets its own sub-score; the top-line score is the weighted mean.
        reference_examples: Optional list of "gold" examples for few-shot
            grounding (capped at 5 to bound prompt cost).
    """

    model_config = ConfigDict(extra="forbid")

    agent_id: str = Field(min_length=1, max_length=64, alias="agentId")
    agent_output: dict[str, Any] = Field(alias="agentOutput")
    evaluation_rubric: list[str] = Field(
        min_length=1,
        max_length=12,
        alias="evaluationRubric",
    )
    reference_examples: list[dict[str, Any]] | None = Field(
        default=None,
        max_length=5,
        alias="referenceExamples",
    )

    @field_validator("evaluation_rubric")
    @classmethod
    def _rubric_entries_nonempty(cls, v: list[str]) -> list[str]:
        for criterion in v:
            if not criterion or not criterion.strip():
                raise ValueError("rubric criteria must be non-empty strings")
        return v


class EvaluationScoreOutput(BaseModel):
    """Output contract — top-line score + per-criterion breakdown + reasoning.

    Attributes:
        score_0_1: Weighted top-line in [0.0, 1.0]. The critic gates human
            approval on this.
        sub_scores: Map of criterion name → score in [0.0, 1.0]. Sum MUST be
            ≤ 1.0 (these are weighted contributions, not independent grades).
        reasoning: ≤ 1000 chars. Free-form prose explaining the score; the
            critic surfaces this in the human-review queue.
        escalation_recommended: True when the score is below the published
            quality floor (0.60 stub default). The critic uses this as a
            tie-breaker when its own rubric flags are silent.
    """

    model_config = ConfigDict(extra="forbid")

    score_0_1: float = Field(ge=0.0, le=1.0, alias="score01")
    sub_scores: dict[str, float] = Field(default_factory=dict, alias="subScores")
    reasoning: str = Field(min_length=1, max_length=1_000)
    escalation_recommended: bool = Field(alias="escalationRecommended")

    @model_validator(mode="after")
    def _sub_scores_sum_le_one(self) -> EvaluationScoreOutput:
        """Per the task brief: sub_scores MUST sum to ≤ 1.0.

        A small epsilon absorbs float rounding noise; anything genuinely above
        1.0 is a programming error and we want the validator to catch it.
        """
        total = sum(self.sub_scores.values())
        # 1e-6 epsilon — well below any meaningful sub-score precision.
        if total > 1.0 + 1e-6:
            raise ValueError(
                f"sub_scores sum to {total:.6f} > 1.0 (must be ≤ 1.0)"
            )
        for name, score in self.sub_scores.items():
            if not (0.0 <= score <= 1.0):
                raise ValueError(
                    f"sub_score {name!r}={score} outside [0.0, 1.0]"
                )
        return self


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def evaluation_score(payload: EvaluationScoreInput) -> EvaluationScoreOutput:
    """Run an LLM-as-judge evaluation against the supplied rubric.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated evaluation request.

    Returns:
        `EvaluationScoreOutput` with the top-line score, sub-scores, reasoning,
        and an escalation recommendation.

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
evaluation_score.usd_cost = USD_COST  # type: ignore[attr-defined]


def _compute_sub_scores(rubric: list[str]) -> dict[str, float]:
    """Distribute base weights across rubric criteria.

    Behavior:
      - len(rubric) ≤ 4 → use prefix slice of `_STUB_SUB_SCORES_BASE`.
      - len(rubric) > 4 → first 4 use base weights, remaining criteria split
        the residual (`1.0 - sum(base)`) evenly so the total stays ≤ 1.0.

    The residual after the base 4 weights is `1.0 - 0.85 = 0.15` — comfortably
    leaves headroom for up to 8 additional criteria (12 max per Pydantic cap).
    """
    if len(rubric) <= len(_STUB_SUB_SCORES_BASE):
        weights = list(_STUB_SUB_SCORES_BASE[: len(rubric)])
    else:
        base = list(_STUB_SUB_SCORES_BASE)
        residual = 1.0 - sum(base)
        extras = len(rubric) - len(base)
        per_extra = residual / extras if extras > 0 else 0.0
        weights = base + [per_extra] * extras

    return {name: round(weight, 6) for name, weight in zip(rubric, weights, strict=True)}


def _stub(payload: EvaluationScoreInput) -> EvaluationScoreOutput:
    """Deterministic LLM-as-judge stub.

    Always returns score=0.85; sub-scores computed deterministically from
    the rubric so tests can assert on stable values. Escalation is False
    (0.85 > 0.60 threshold)."""
    sub_scores = _compute_sub_scores(payload.evaluation_rubric)
    first_criterion = payload.evaluation_rubric[0]
    reasoning = (
        f"agent={payload.agent_id!r} scored {_STUB_SCORE:.2f} against the "
        f"published rubric. Primary criterion {first_criterion!r} met; "
        "remaining criteria balanced per D25 LLM-as-judge template."
    )
    escalation = _STUB_SCORE < _STUB_ESCALATION_THRESHOLD

    logger.debug(
        "evaluation_score_stub",
        extra={
            "agent_id": payload.agent_id,
            "score": _STUB_SCORE,
            "rubric_size": len(payload.evaluation_rubric),
            "escalation": escalation,
        },
    )
    return EvaluationScoreOutput(
        score01=_STUB_SCORE,
        subScores=sub_scores,
        reasoning=reasoning,
        escalationRecommended=escalation,
    )


def _live(payload: EvaluationScoreInput) -> EvaluationScoreOutput:
    """Live Vertex AI Agent Evaluation invocation — wired in W7 deploy phase.

    The live impl will:
      1. Build an LLM-as-judge prompt from the rubric + reference examples.
      2. Invoke Vertex AI Agent Evaluation with the candidate `agent_output`.
      3. Parse the judge's structured response (score + sub-scores + prose).
      4. Surface `escalation_recommended` per the workspace-configured
         quality floor (default 0.60).
    """
    raise NotImplementedError(
        "evaluation_score live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "EvaluationScoreInput",
    "EvaluationScoreOutput",
    "USD_COST",
    "evaluation_score",
]
