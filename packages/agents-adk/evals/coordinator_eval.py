"""coordinator_eval.py — predictor + scorer for the coordinator golden eval.

D25 (Agent-Evaluation rung) · D37 (Layer-1 offline gate) · D5 (coordinator =
gemini-3.1-flash-lite; this scores its deterministic baseline, not the live call).

The predictor reproduces the coordinator's documented decision rules
(coordinator.py system prompt §"Decision rules") from the INPUT ALONE:

    1. Infer a capability-match score per candidate by keyword-matching the task
       description against each candidate's capability tags.
    2. Detect "ambiguous" tasks (very short, no capability keyword hit) → escalate.
    3. Feed the capability scores into the agent's own `pick_best_candidate`
       (which applies the hard filters: unhealthy / policy_blocked / over_budget,
       and the allow_remote / prefer_local tie-breaks).
    4. If no candidate survives, OR the task is ambiguous with ≥2 plausible
       picks → escalate (chosen = "__escalate__").

This is genuinely fallible: the keyword table is tuned on the TRAIN/DEV cases,
so its accuracy on the HOLDOUT slice (never used for tuning) is the overfit
detector. A perfect train score with a poor holdout score means the table was
memorised rather than generalised.
"""
from __future__ import annotations

import re

from evals.runner import EvalCase
from ss_agents.agents.coordinator import (
    ESCALATE_AGENT_ID,
    CoordinatorInput,
    CoordinatorOutput,
    pick_best_candidate,
)
from ss_agents.runtime import Escalation, OutcomeOk

# Capability keyword table — derived from the TRAIN/DEV cases + the 16 known
# Tier-1 task kinds (coordinator._KNOWN_TASK_KINDS). Each capability tag maps to
# the surface-text cues (across the 4 D34 locales) that imply it. The predictor
# is NOT allowed to look at the holdout cases when extending this table; that is
# the discipline the holdout slice enforces.
# Ordered MOST-SPECIFIC FIRST. The "primary capability" of a task is the first
# entry in this dict whose cues match — so a compliance / outreach / classify
# signal outranks the broad source_creators signal when both incidentally hit.
_CAPABILITY_CUES: dict[str, tuple[str, ...]] = {
    "check_compliance": (
        "compliance", "pipa", "can-spam", "canspam", "合规", "컴플라이언스",
        "consent", "동의", "개인정보", "法", "法的",
    ),
    "classify_reply": (
        "classify", "분류", "答信", "返信", "分類", "분류해",
    ),
    "draft_outreach": (
        "outreach", "アウトリーチ", "email", "メール", "邮件", "이메일",
        "draft", "下書き", "下书", "초안", "tournament", "トーナメント",
    ),
    "vet_candidate": ("vet", "평가", "vetting", "score candidate"),
    "source_creators": (
        "creator", "크리에이터", "クリエイター", "创作者",
        "find", "source", "search", "탐색", "検索", "搜索", "探",
    ),
}


def _matched_capabilities(text: str) -> set[str]:
    """The set of capability tags whose cues appear in the task text."""
    return {
        cap
        for cap, cues in _CAPABILITY_CUES.items()
        if any(cue.lower() in text for cue in cues)
    }


def _capability_scores(payload: CoordinatorInput) -> dict[str, float]:
    """Per-candidate capability match in [0, 1] from the task text alone.

    A candidate scores high when its capability tags overlap the task's matched
    capabilities. We reward SPECIFICITY: a candidate scores by the fraction of
    the task's matched capabilities it covers, with a bonus when the task's
    *primary* (first-matched-by-priority) capability is one of its tags. This
    keeps a precise single-purpose agent (e.g. outreach_writer for a 'draft
    outreach' task) ahead of a broad agent (sourcing) that only matched on an
    incidental 'creator' keyword.
    """
    text = payload.task_description.lower()
    matched = _matched_capabilities(text)
    if not matched:
        # Nothing in the task maps to a known capability — neutral baseline so
        # the hard filters + cost/latency tie-break inside pick_best decide.
        return {c.agent_id: 0.5 for c in payload.candidate_agents}

    # Primary capability = the highest-priority matched cue family. Priority
    # order is the dict insertion order in _CAPABILITY_CUES (most specific first
    # for the routing decisions we care about: a compliance/outreach/classify
    # signal should win over the broad source_creators signal).
    primary = next((cap for cap in _CAPABILITY_CUES if cap in matched), None)

    scores: dict[str, float] = {}
    for cand in payload.candidate_agents:
        caps = set(cand.capabilities)
        overlap = caps & matched
        if not overlap:
            scores[cand.agent_id] = 0.0
            continue
        # Coverage of the task's matched capabilities.
        coverage = len(overlap) / len(matched)
        # Specificity bonus: this candidate owns the task's primary capability.
        primary_bonus = 0.5 if primary in caps else 0.0
        scores[cand.agent_id] = min(1.0, 0.5 * coverage + primary_bonus)
    return scores


# Explicit vague-intent phrases ("do something with…", "관련 일 좀 해줘").
# These signal the operator did NOT name a concrete task — escalate even if a
# noun keyword (e.g. "creator") incidentally matched a capability cue.
_AMBIGUOUS_CUES = (
    "관련 일", "좀 해줘", "do something", "something with", "anything",
    "관련된 거", "뭔가",
)


def _looks_ambiguous(payload: CoordinatorInput, scores: dict[str, float]) -> bool:
    """Heuristic ambiguity detector mirroring the prompt's escalation rule:
    'task is ambiguous AND no single candidate clearly covers it'.

    An explicit vague-intent phrase is authoritative — it escalates even when a
    noun keyword incidentally produced a capability hit, because the OPERATOR's
    intent is unspecified. Otherwise we fall back to: very short task AND no
    candidate scored a strong (≥ 0.75) capability match.
    """
    text = payload.task_description.strip().lower()
    if any(cue in text for cue in _AMBIGUOUS_CUES):
        return True
    token_count = len(re.findall(r"\S+", text))
    no_strong_winner = max(scores.values(), default=0.0) < 0.75
    return token_count <= 4 and no_strong_winner


def predict_coordinator(payload: CoordinatorInput) -> CoordinatorOutput:
    """Deterministic routing predictor — the function the eval scores.

    Sees ONLY `payload` (never the expected answer). Returns a CoordinatorOutput
    that may be wrong; that fallibility is what makes the holdout meaningful.
    """
    scores = _capability_scores(payload)

    if _looks_ambiguous(payload, scores):
        return CoordinatorOutput(
            chosenAgentId=ESCALATE_AGENT_ID,
            routingRationale=(
                "Task is ambiguous and no single candidate clearly covers it "
                "(escalation rule: ambiguous task). Requesting operator triage."
            ),
            fallbackAgentId=None,
            expectedCostUsd=0.0,
            expectedLatencyMs=0,
            confidence=0.45,
        )

    best, fallback = pick_best_candidate(payload, capability_scores=scores)

    # Cost-priority override: when the operator explicitly asks for the cheapest
    # option AND preferLocal is off, the deterministic latency-weighted baseline
    # can pick a pricier-but-faster local agent. Re-rank the capability-matched
    # survivors by cost so the predictor honours the stated priority — the same
    # decision the Flash model would make from the prompt text. (Tuned on the
    # train case coord_en_02; the holdout never exercises this branch.)
    cost_priority = any(
        cue in payload.task_description.lower()
        for cue in ("cheapest", "cost is the priority", "cost matters", "lowest cost")
    )
    if best is not None and cost_priority and not payload.prefer_local:
        matched_survivors = [
            c
            for c in payload.candidate_agents
            if scores.get(c.agent_id, 0.0) > 0.0
            and not (not payload.allow_remote and c.transport != "in_process")
            and c.avg_cost_usd <= payload.workspace_policy.budget_remaining_usd
            and c.healthy
            and (
                not payload.workspace_policy.allowed_agents
                or c.agent_id in payload.workspace_policy.allowed_agents
            )
        ]
        if matched_survivors:
            matched_survivors.sort(key=lambda c: c.avg_cost_usd)
            best = matched_survivors[0]
            fallback = matched_survivors[1] if len(matched_survivors) >= 2 else None

    if best is None:
        return CoordinatorOutput(
            chosenAgentId=ESCALATE_AGENT_ID,
            routingRationale=(
                "No candidate satisfies policy (escalation rule: no candidate "
                "fits — all over_budget / policy_blocked / unhealthy)."
            ),
            fallbackAgentId=None,
            expectedCostUsd=0.0,
            expectedLatencyMs=0,
            confidence=0.5,
        )

    # Confidence proxy: capability-match strength of the pick, floored so a
    # weak-but-best pick is still surfaced (the runtime enforces the 0.6 floor).
    confidence = max(0.62, min(0.97, 0.6 + 0.37 * scores.get(best.agent_id, 0.5)))
    return CoordinatorOutput(
        chosenAgentId=best.agent_id,
        routingRationale=(
            f"Picked {best.agent_id}: best capability match for the task within "
            f"budget/SLA; fallback={fallback.agent_id if fallback else 'none'}."
        ),
        fallbackAgentId=fallback.agent_id if fallback else None,
        expectedCostUsd=best.avg_cost_usd,
        expectedLatencyMs=best.avg_latency_ms,
        confidence=confidence,
    )


def score_coordinator(
    outcome: OutcomeOk | Escalation, case: EvalCase
) -> tuple[bool, str]:
    """Score one coordinator case against its golden `metadata`.

    Pass criteria (routing_accuracy, per coordinator.evalset.json criteria):
      - When the case expects escalation, the prediction must escalate (either a
        runtime Escalation OR chosen == "__escalate__").
      - Otherwise the predicted `chosen_agent_id` must equal `expected_chosen`.
    """
    expected_chosen = case.metadata.get("expected_chosen")
    should_escalate = bool(case.metadata.get("should_escalate", False))

    # Determine what the predictor chose.
    if isinstance(outcome, Escalation):
        predicted_chosen = ESCALATE_AGENT_ID
    else:
        out: CoordinatorOutput = outcome.value
        predicted_chosen = out.chosen_agent_id

    predicted_escalate = predicted_chosen == ESCALATE_AGENT_ID

    if should_escalate:
        passed = predicted_escalate
        detail = (
            "expected=escalate "
            f"predicted={'escalate' if predicted_escalate else predicted_chosen}"
        )
        return passed, detail

    passed = (not predicted_escalate) and predicted_chosen == expected_chosen
    detail = f"expected={expected_chosen} predicted={predicted_chosen}"
    return passed, detail


__all__ = ["predict_coordinator", "score_coordinator"]
