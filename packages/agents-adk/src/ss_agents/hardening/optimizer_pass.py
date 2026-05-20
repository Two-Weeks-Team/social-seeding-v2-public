"""optimizer_pass.py — H4 Agent Optimizer (local pass) + H3 Observability traces.

The "we hardened it" measurement (GRAND-NARRATIVE-PLAN §5-1, D50). End to end:

  1. H2 — run the BASELINE triage over the synthetic set → `before` pass-rate.
  2. H3 — capture a "stalled reasoning" Observability trace for the canonical
     stall case under the baseline, shaped on `observability.py` span attributes
     (D32).
  3. H4 — build the `ObservedFailure` list from the baseline failures and feed
     it to the optimizer. Locally we apply the deterministic OPTIMIZED rule set
     (the live behavior); we also queue the live Vertex Agent Optimizer
     capability to surface the production path (it returns a stub receipt today
     — W7-deferred — and we record that honestly).
  4. Re-run the OPTIMIZED triage → `after` pass-rate; capture the "repaired"
     trace for the same case.

HONEST SCOPE (RULES.md §Professional Honesty, GRAND-NARRATIVE-PLAN §7):
    The before/after numbers come from THIS in-process pass over the synthetic
    set, NOT from the live Vertex AI Agent Optimizer. The live optimizer
    (`agent_optimizer_tune` CAPABILITY_LAYER_MODE=live) raises NotImplementedError
    (W7-deferred); its STUB queues a deterministic receipt. The capability
    surface + the ObservedFailure contract are real; the GCP backend is staged.

Citations: D23 (Tier-2 M3 optimizer), D25 (learning loop), D32 (observability),
D5 (models). Uses `agent_optimizer_tune.ObservedFailure` (the optimizer input
contract) and the `observability.agent_span` attribute shape.
"""
from __future__ import annotations

import datetime as dt
import os
from pathlib import Path
from typing import Any

from ss_agents.agents.conversation_responder import (
    RESPONDER_MODEL,
    ConversationTurnInput,
    OutreachFacts,
    _baseline_triage,
    _optimized_triage,
)
from ss_agents.hardening.triage_sim import (
    DEFAULT_CASES_PATH,
    SimReport,
    build_observed_failures,
    load_cases,
    run_simulation,
)
from ss_agents.tools.agent_optimizer_tune import (
    AgentOptimizerTuneInput,
    AgentOptimizerTuneOutput,
    ObservedFailure,
    agent_optimizer_tune,
)

# The canonical stall case id (the demo scene #1 subject). Declared in the
# synthetic set `_meta.stall_case_id`. interested + proposed_rate_usd present.
STALL_CASE_ID = "rate-positive-en-01"

# The triage rule (the fix) the chapter quotes — kept as a constant so the
# metrics artifact and the report agree verbatim.
TRIAGE_FIX_RULE = (
    "interested/needs_info + extracted.proposed_rate_usd is not None "
    "→ escalate (reason=rate_signal_on_positive)"
)

_AGENT_ID = "conversation-responder"
_TARGET_METRIC = "triage_routing_accuracy"


# ─────────────────────────────────────────────────────────────────────────────
# H3 — Observability trace artifacts (shaped on observability.py span attributes).
# ─────────────────────────────────────────────────────────────────────────────


def _find_case(cases: list[dict[str, Any]], case_id: str) -> dict[str, Any]:
    for c in cases:
        if c["id"] == case_id:
            return c
    raise KeyError(f"stall case {case_id!r} not found in the synthetic set")


def _trace_for_case(
    case: dict[str, Any], *, rule_set: str, status: str
) -> dict[str, Any]:
    """Build a structured trace artifact for ONE case under a rule set.

    The span attribute names mirror `observability.agent_span` /
    `record_outcome` (D32): agent.id, agent.model, agent.trace_id,
    agent.outcome. We add a `triage.*` namespace for the decision-path detail
    and a `steps[]` reasoning path so the demo can render the stall point (the
    step where the baseline halts/loops at the auto-respond ↔ escalate
    boundary) vs the repaired flow.
    """
    payload = case["input"]
    turn = ConversationTurnInput.model_validate(payload["turn"])
    facts = OutreachFacts.model_validate(payload["facts"])
    rule_fn = _baseline_triage if rule_set == "baseline" else _optimized_triage
    decision = rule_fn(turn, facts)

    rate = turn.extracted.proposed_rate_usd
    has_ctx = facts.has_minimum_context

    if rule_set == "baseline":
        steps = [
            {"n": 1, "check": "facts.has_minimum_context", "value": has_ctx,
             "branch": "escalate" if not has_ctx else "continue"},
            {"n": 2, "check": "classification == 'negotiating'",
             "value": turn.classification == "negotiating",
             "branch": "escalate" if turn.classification == "negotiating" else "continue"},
            {"n": 3, "check": "(no rate-signal rule exists)",
             "value": None,
             "branch": "fallthrough → respond",
             "stall": rate is not None,
             "stall_note": (
                 "STALL: a proposed rate of USD "
                 f"{rate} is present, but the baseline has no rule to read it. "
                 "The turn is routed to `respond`, then the Pro drafter is told "
                 "in prompt step 7 to escalate negotiations — it has already "
                 "been sent down the drafting path with no rate-handling fact, "
                 "so it oscillates at the auto-respond ↔ escalate boundary."
             ) if rate is not None else None},
        ]
    else:
        steps = [
            {"n": 1, "check": "facts.has_minimum_context", "value": has_ctx,
             "branch": "escalate" if not has_ctx else "continue"},
            {"n": 2, "check": "classification in {declined, unsubscribe}",
             "value": turn.classification in {"declined", "unsubscribe"},
             "branch": "escalate(hard_no)" if turn.classification in {"declined", "unsubscribe"} else "continue"},
            {"n": 3, "check": "classification == 'negotiating'",
             "value": turn.classification == "negotiating",
             "branch": "escalate(negotiation_class)" if turn.classification == "negotiating" else "continue"},
            {"n": 4, "check": "classification in {interested, needs_info} AND proposed_rate_usd is not None",
             "value": rate is not None and turn.classification in {"interested", "needs_info"},
             "branch": "escalate(rate_signal_on_positive)" if (rate is not None and turn.classification in {"interested", "needs_info"}) else "continue",
             "repaired": rate is not None,
             "repaired_note": (
                 "REPAIRED: the new rate-signal rule reads "
                 f"proposed_rate_usd=USD {rate} on an interested turn and "
                 "escalates as a negotiation (D27) — no Pro draft is spent, no "
                 "stall."
             ) if rate is not None else None},
            {"n": 5, "check": "fallthrough → respond / soft_no / out_of_scope",
             "value": decision.reason, "branch": decision.action},
        ]

    return {
        "_meta": {
            "purpose": (
                f"H3 Observability trace ({status}) — conversation_responder "
                f"triage on the stall case under the {rule_set} rule set."
            ),
            "authority": "GRAND-NARRATIVE-PLAN.md §5-1 (H3) + §4 wow scene #1; D32.",
            "honesty_note": (
                "Span attributes mirror ss_agents.observability.agent_span "
                "(D32). This is a deterministic, offline trace of the pure "
                "triage decision path — not a captured live Cloud Trace span."
            ),
            "rule_set": rule_set,
            "status": status,
            "generated_at_utc": dt.datetime.now(dt.UTC).isoformat(),
        },
        "span": {
            "name": f"agent:{_AGENT_ID}",
            "attributes": {
                "agent.id": _AGENT_ID,
                "agent.model": RESPONDER_MODEL,
                "agent.trace_id": f"trace-hardening-{case['id']}-{rule_set}",
                "agent.outcome": "escalate" if decision.action == "escalate" else "ok",
                "triage.action": decision.action,
                "triage.reason_tag": decision.reason,
                "triage.detail": decision.detail,
                "triage.rule_set": rule_set,
                "turn.classification": turn.classification,
                "turn.proposed_rate_usd": rate,
                "facts.has_minimum_context": has_ctx,
            },
        },
        "reasoning_path": steps,
        "case": {
            "id": case["id"],
            "category": case["category"],
            "locale": payload.get("locale"),
            "incoming_message": turn.extracted.question or turn.extracted.shipping_address or "(no extracted text)",
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# H4 — the optimizer pass: before → after.
# ─────────────────────────────────────────────────────────────────────────────


def queue_live_optimizer(
    baseline_failures: list[ObservedFailure],
) -> AgentOptimizerTuneOutput:
    """Queue the live Vertex AI Agent Optimizer via the capability surface.

    This proves the production path exists + accepts the SAME `ObservedFailure`
    shape our local pass produces. In stub mode (default) it returns a
    deterministic queued receipt; in live mode it raises NotImplementedError
    (W7-deferred). We never depend on its OUTPUT for the before/after numbers —
    those come from the local OPTIMIZED rule set.
    """
    current_prompt = (
        "conversation_responder system prompt (triage gate). "
        "Baseline missed: interested/needs_info turns carrying a proposed rate."
    )
    tune_input = AgentOptimizerTuneInput(
        agentId=_AGENT_ID,
        currentPrompt=current_prompt,
        observedFailures=baseline_failures,
        targetMetric=_TARGET_METRIC,
    )
    return agent_optimizer_tune(tune_input)


def run_optimizer_pass(
    *, cases_path: str | Path = DEFAULT_CASES_PATH
) -> dict[str, Any]:
    """Run the full before/after measurement. Returns the metrics dict that is
    serialized to scripts/demo/assets/hardening-before-after.json.

    No LLM, no GCP, no billing — pure functions over the synthetic set.
    """
    cases = load_cases(cases_path)

    # 1. H2 — baseline pass-rate (the "before").
    before: SimReport = run_simulation("baseline", cases)
    # 4. re-measure with the optimized (live) rule set (the "after").
    after: SimReport = run_simulation("optimized", cases)

    # 3. H4 — build the optimizer input from baseline failures, queue live stub.
    observed_failures = build_observed_failures(before)
    live_receipt = queue_live_optimizer(observed_failures)
    optimizer_live_mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")

    delta_pp = round((after.pass_rate - before.pass_rate) * 100, 1)

    return {
        "_meta": {
            "purpose": (
                "H4 before/after metrics — conversation_responder triage "
                "hardening. Produced by ss_agents.hardening.optimizer_pass; "
                "re-run via scripts/smoke-test/run-hardening-measure.sh."
            ),
            "authority": "GRAND-NARRATIVE-PLAN.md §5-1 (H4) + §2 arc; D50.",
            "honesty_note": (
                "before/after produced by a LOCAL deterministic optimization "
                "pass over the synthetic set (test-harness/hardening/"
                "synthetic_cases.json). The live Vertex AI Agent Optimizer is "
                "the production path and is STUBBED today "
                "(agent_optimizer_tune live = NotImplementedError, W7-deferred). "
                "No fabricated metrics: every number here is printed by the "
                "re-runnable smoke script."
            ),
            "agent_id": _AGENT_ID,
            "model": RESPONDER_MODEL,
            "target_metric": _TARGET_METRIC,
            "generated_at_utc": dt.datetime.now(dt.UTC).isoformat(),
        },
        "before": {
            "rule_set": "baseline",
            "total": before.total,
            "passed": before.passed,
            "pass_rate": round(before.pass_rate, 4),
            "pass_rate_pct": round(before.pass_rate * 100, 1),
            "failed_case_ids": [r.case_id for r in before.failures],
            "by_category_failures": dict(before.to_dict()["by_category_failures"]),
        },
        "after": {
            "rule_set": "optimized",
            "total": after.total,
            "passed": after.passed,
            "pass_rate": round(after.pass_rate, 4),
            "pass_rate_pct": round(after.pass_rate * 100, 1),
            "failed_case_ids": [r.case_id for r in after.failures],
            "by_category_failures": dict(after.to_dict()["by_category_failures"]),
        },
        "delta_pp": delta_pp,
        "headline": (
            f"{round(before.pass_rate * 100, 1)}% → {round(after.pass_rate * 100, 1)}%"
        ),
        "triage_fix_rule": TRIAGE_FIX_RULE,
        "stall_case_id": STALL_CASE_ID,
        "optimizer_input": {
            "observed_failures": [f.model_dump(by_alias=True) for f in observed_failures],
            "target_metric": _TARGET_METRIC,
        },
        "live_optimizer": {
            "capability_layer_mode": optimizer_live_mode,
            "queued_receipt": live_receipt.model_dump(by_alias=True),
            "note": (
                "Production path = Vertex AI Agent Optimizer. The receipt above "
                "is the deterministic STUB (W7-deferred); live mode raises "
                "NotImplementedError. Disclosed per RULES.md + §7."
            ),
        },
    }


def build_trace_artifacts(
    *, cases_path: str | Path = DEFAULT_CASES_PATH
) -> dict[str, dict[str, Any]]:
    """Build the H3 stalled + repaired Observability trace artifacts for the
    canonical stall case. Returns {"stalled": {...}, "repaired": {...}}."""
    cases = load_cases(cases_path)
    stall_case = _find_case(cases, STALL_CASE_ID)
    return {
        "stalled": _trace_for_case(stall_case, rule_set="baseline", status="stalled"),
        "repaired": _trace_for_case(stall_case, rule_set="optimized", status="repaired"),
    }


__all__ = [
    "STALL_CASE_ID",
    "TRIAGE_FIX_RULE",
    "build_trace_artifacts",
    "queue_live_optimizer",
    "run_optimizer_pass",
]
