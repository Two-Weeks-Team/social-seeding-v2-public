"""tests/hardening/test_triage_sim.py — H2/H3/H4 measurement toolchain.

Verifies the deterministic, offline hardening pass:
  · the synthetic case set loads + every case validates against the contracts,
  · the BASELINE pass-rate is strictly LOWER than the OPTIMIZED pass-rate (the
    chapter's whole claim — if this ever stops being true, the fix regressed),
  · the OPTIMIZED triage passes EVERY synthetic case,
  · the canonical stall case fails under baseline + passes under optimized,
  · the ObservedFailure builder emits the agent_optimizer_tune contract shape,
  · the H3 trace artifacts carry the span attributes + a stall/repair marker.

Cites GRAND-NARRATIVE-PLAN §5-1; D23/D25/D32/D5. All offline (conftest SS_OFFLINE).
"""
from __future__ import annotations

from ss_agents.agents.conversation_responder import (
    ConversationTurnInput,
    OutreachFacts,
)
from ss_agents.hardening.optimizer_pass import (
    STALL_CASE_ID,
    build_trace_artifacts,
    queue_live_optimizer,
    run_optimizer_pass,
)
from ss_agents.hardening.triage_sim import (
    build_observed_failures,
    load_cases,
    run_simulation,
)
from ss_agents.tools.agent_optimizer_tune import ObservedFailure


class TestSyntheticSet:
    """The hand-authored edge-case set is itself a contract."""

    def test_set_loads_and_has_enough_cases(self) -> None:
        cases = load_cases()
        assert len(cases) >= 24, "brief requires ≥ 24 synthetic cases"

    def test_every_case_validates_against_contracts(self) -> None:
        """Each case input must be a valid ConversationResponderInput surface —
        catches drift between the synthetic set and the Pydantic models."""
        for case in load_cases():
            payload = case["input"]
            ConversationTurnInput.model_validate(payload["turn"])
            OutreachFacts.model_validate(payload["facts"])
            assert case["expected_decision"] in {"respond", "escalate"}
            assert isinstance(case["expected_reason_tag"], str)

    def test_set_covers_required_categories(self) -> None:
        cats = {c["category"] for c in load_cases()}
        for required in (
            "clean_interested",
            "interest_with_rate",
            "explicit_negotiation",
            "decline_disguised_as_interest",
            "missing_context",
            "mixed_emotion",
        ):
            assert required in cats, f"missing category coverage: {required}"

    def test_set_covers_four_locales(self) -> None:
        locales = {c["input"].get("locale") for c in load_cases()}
        assert {"ko", "en", "ja", "zh-CN"} <= locales


class TestBeforeAfter:
    """The core claim: optimized > baseline, optimized passes everything."""

    def test_baseline_lower_than_optimized(self) -> None:
        before = run_simulation("baseline")
        after = run_simulation("optimized")
        assert before.pass_rate < after.pass_rate

    def test_optimized_passes_every_case(self) -> None:
        after = run_simulation("optimized")
        assert after.passed == after.total, (
            f"optimized triage must pass all cases; failures: "
            f"{[r.case_id for r in after.failures]}"
        )

    def test_baseline_fails_the_stall_case(self) -> None:
        before = run_simulation("baseline")
        stall = next(r for r in before.results if r.case_id == STALL_CASE_ID)
        assert not stall.passed
        assert stall.actual_decision == "respond"  # the bug
        assert stall.expected_decision == "escalate"

    def test_optimized_repairs_the_stall_case(self) -> None:
        after = run_simulation("optimized")
        stall = next(r for r in after.results if r.case_id == STALL_CASE_ID)
        assert stall.passed
        assert stall.actual_decision == "escalate"
        assert stall.actual_reason_tag == "rate_signal_on_positive"

    def test_pass_requires_reason_match_not_just_action(self) -> None:
        """A case passes only when BOTH action and reason match — guards against
        a right-answer-for-the-wrong-reason slipping through."""
        after = run_simulation("optimized")
        for r in after.results:
            assert r.passed
            assert r.actual_decision == r.expected_decision
            assert r.actual_reason_tag == r.expected_reason_tag


class TestObservedFailures:
    """The optimizer input must match the agent_optimizer_tune contract."""

    def test_builds_observed_failures_from_baseline(self) -> None:
        before = run_simulation("baseline")
        failures = build_observed_failures(before)
        assert failures, "baseline has failures to learn from"
        for f in failures:
            assert isinstance(f, ObservedFailure)
            assert f.sample_count >= 1
            assert f.kind.startswith("misrouted:")
            assert "example_case_ids" in f.payload

    def test_observed_failures_total_matches_baseline_failure_count(self) -> None:
        before = run_simulation("baseline")
        failures = build_observed_failures(before)
        assert sum(f.sample_count for f in failures) == len(before.failures)

    def test_rate_signal_failure_family_present(self) -> None:
        before = run_simulation("baseline")
        kinds = {f.kind for f in build_observed_failures(before)}
        assert "misrouted:rate_signal_on_positive" in kinds


class TestLiveOptimizerSurface:
    """The live optimizer is queued via the real capability surface (stub)."""

    def test_queue_returns_stub_receipt(self) -> None:
        before = run_simulation("baseline")
        failures = build_observed_failures(before)
        receipt = queue_live_optimizer(failures)
        # Default CAPABILITY_LAYER_MODE=stub → deterministic queued receipt.
        assert receipt.status == "queued"
        assert receipt.job_id == "opt-conversation-responder-001"


class TestOptimizerPassMetrics:
    """run_optimizer_pass produces the committed metrics shape."""

    def test_metrics_headline_and_delta(self) -> None:
        metrics = run_optimizer_pass()
        assert metrics["before"]["pass_rate"] < metrics["after"]["pass_rate"]
        assert metrics["after"]["pass_rate"] == 1.0
        assert metrics["delta_pp"] > 0
        # headline is "<before>% → <after>%" and agrees with the fields.
        assert (
            metrics["headline"]
            == f"{metrics['before']['pass_rate_pct']}% → {metrics['after']['pass_rate_pct']}%"
        )

    def test_metrics_disclose_live_stub(self) -> None:
        metrics = run_optimizer_pass()
        note = metrics["live_optimizer"]["note"].lower()
        assert "stub" in note
        assert "notimplementederror" in metrics["_meta"]["honesty_note"].lower()

    def test_metrics_quote_the_fix_rule(self) -> None:
        metrics = run_optimizer_pass()
        assert "proposed_rate_usd" in metrics["triage_fix_rule"]
        assert "escalate" in metrics["triage_fix_rule"]


class TestTraceArtifacts:
    """H3 — the stalled + repaired Observability traces (demo scene #1)."""

    def test_traces_built_for_stall_case(self) -> None:
        traces = build_trace_artifacts()
        assert set(traces) == {"stalled", "repaired"}
        for t in traces.values():
            assert t["case"]["id"] == STALL_CASE_ID

    def test_stalled_trace_marks_the_stall(self) -> None:
        stalled = build_trace_artifacts()["stalled"]
        assert stalled["span"]["attributes"]["triage.action"] == "respond"
        assert stalled["span"]["attributes"]["agent.outcome"] == "ok"
        # Some step is flagged as the stall point.
        assert any(step.get("stall") for step in stalled["reasoning_path"])

    def test_repaired_trace_escalates(self) -> None:
        repaired = build_trace_artifacts()["repaired"]
        attrs = repaired["span"]["attributes"]
        assert attrs["triage.action"] == "escalate"
        assert attrs["triage.reason_tag"] == "rate_signal_on_positive"
        assert attrs["agent.outcome"] == "escalate"
        assert any(step.get("repaired") for step in repaired["reasoning_path"])

    def test_trace_span_carries_observability_attributes(self) -> None:
        """Attribute names mirror observability.agent_span / record_outcome (D32)."""
        attrs = build_trace_artifacts()["stalled"]["span"]["attributes"]
        for key in ("agent.id", "agent.model", "agent.trace_id", "agent.outcome"):
            assert key in attrs
        assert attrs["agent.id"] == "conversation-responder"
        assert attrs["agent.model"] == "gemini-2.5-pro"
