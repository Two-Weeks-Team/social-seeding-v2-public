"""Offline, deterministic tests proving `run_agent` emits OTel spans.

Closes the Wave-2 "Agent Observability built-but-unwired" gap (D31 SLO + D32
Cloud Monitoring + Chronicle SIEM): `observability.agent_span` / `record_outcome`
existed but `runtime.run_agent` never called them, so no span was ever produced.

These tests inject an in-memory OTel exporter (no GCP creds, no network) and a
synchronous `SimpleSpanProcessor` so finished spans are readable immediately,
then assert:

  (a) one `agent:{id}` span per invocation carrying the documented attributes
      (agent.id / model / tenant_id / workspace_id / trace_id / usd_spent / outcome),
  (b) outcome == "ok" on success, "escalate" on every escalation path,
  (c) with SS_OTEL_ENABLED=false (the conftest default) the no-op path is taken
      and nothing breaks — `run_agent` still returns a valid outcome.

Honest scoping: this proves the spans are produced and Cloud-Trace-*exportable*
(the exporter API is the same `BatchSpanProcessor(CloudTraceSpanExporter)` wired
in `setup_observability`). Capturing a LIVE trace in Cloud Trace is the
operator-gated step (SS_OTEL_ENABLED=true + ADC); see README.md
"Capturing a LIVE trace".
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

import ss_agents.observability as obs
from ss_agents.agents.intake import (
    IntakeInput,
    IntakeMessage,
    IntakeOutputWrapper,
    intake_agent_def,
)
from ss_agents.runtime import Escalation, OutcomeOk, RunContext, run_agent

# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def recording_tracer(monkeypatch: pytest.MonkeyPatch) -> Iterator[InMemorySpanExporter]:
    """Inject an in-memory tracer into the observability module.

    We set `obs._INITIALIZED = True` and `obs._TRACER = <recording tracer>` so
    `setup_observability()` (called from inside `agent_span`) is a no-op and does
    not overwrite our recorder. `SimpleSpanProcessor` exports synchronously on
    span end, so `exporter.get_finished_spans()` is immediately readable.
    """
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("ss-agents-test")

    monkeypatch.setattr(obs, "_INITIALIZED", True)
    monkeypatch.setattr(obs, "_TRACER", tracer)
    yield exporter
    exporter.clear()


def _intake_input() -> IntakeInput:
    return IntakeInput(
        messages=[IntakeMessage(role="user", content="Run a skincare campaign.")],
        workspaceId="ws_test_intake_001",
        createdBy="op@social-seeding.test",
        locale="en",
    )


def _ctx(model_client: Any) -> RunContext:
    return RunContext(
        tenant_id="t_test000000000001",
        workspace_id="ws_test_intake_001",
        trace_id="trace-obs-001",
        invoked_by="pytest@social-seeding.test",
        model_client=model_client,
    )


def _agent_spans(exporter: InMemorySpanExporter) -> list[Any]:
    return [s for s in exporter.get_finished_spans() if s.name.startswith("agent:")]


# ─────────────────────────────────────────────────────────────────────────────
# (a) + (b) success path
# ─────────────────────────────────────────────────────────────────────────────


async def test_run_agent_emits_one_agent_span_with_documented_attributes(
    recording_tracer: InMemorySpanExporter,
    make_stub: Any,
    asking_turn: IntakeOutputWrapper,
) -> None:
    stub = make_stub(turns=[asking_turn], usd_per_call=0.004)
    outcome = await run_agent(intake_agent_def, _intake_input(), _ctx(stub))

    assert isinstance(outcome, OutcomeOk)

    spans = _agent_spans(recording_tracer)
    assert len(spans) == 1, "exactly one agent:<id> span per invocation"
    span = spans[0]
    assert span.name == f"agent:{intake_agent_def.id}"

    attrs = dict(span.attributes)
    assert attrs["agent.id"] == intake_agent_def.id
    assert attrs["agent.model"] == intake_agent_def.model
    assert attrs["agent.tenant_id"] == "t_test000000000001"
    assert attrs["agent.workspace_id"] == "ws_test_intake_001"
    assert attrs["agent.trace_id"] == "trace-obs-001"
    assert attrs["agent.outcome"] == "ok"
    # usd_spent recorded from the stub's per-call cost.
    assert attrs["agent.usd_spent"] == pytest.approx(0.004)
    assert outcome.usd_spent == pytest.approx(0.004)


async def test_success_emits_llm_child_span_under_agent_span(
    recording_tracer: InMemorySpanExporter,
    make_stub: Any,
    asking_turn: IntakeOutputWrapper,
) -> None:
    """The stub LLM call emits an `llm:{model}` child parented by the agent span."""
    stub = make_stub(turns=[asking_turn], usd_per_call=0.004)
    await run_agent(intake_agent_def, _intake_input(), _ctx(stub))

    finished = recording_tracer.get_finished_spans()
    agent_spans = [s for s in finished if s.name.startswith("agent:")]
    llm_spans = [s for s in finished if s.name.startswith("llm:")]
    assert len(agent_spans) == 1
    assert len(llm_spans) == 1
    assert llm_spans[0].name == f"llm:{intake_agent_def.model}"
    # Child shares the agent span's trace and points at it as parent.
    agent_span = agent_spans[0]
    llm_span = llm_spans[0]
    assert llm_span.context.trace_id == agent_span.context.trace_id
    assert llm_span.parent is not None
    assert llm_span.parent.span_id == agent_span.context.span_id


async def test_each_invocation_emits_its_own_span(
    recording_tracer: InMemorySpanExporter,
    make_stub: Any,
    asking_turn: IntakeOutputWrapper,
    done_turn: IntakeOutputWrapper,
) -> None:
    stub = make_stub(turns=[asking_turn, done_turn], usd_per_call=0.004)
    await run_agent(intake_agent_def, _intake_input(), _ctx(stub))
    await run_agent(intake_agent_def, _intake_input(), _ctx(stub))

    assert len(_agent_spans(recording_tracer)) == 2


# ─────────────────────────────────────────────────────────────────────────────
# (b) escalation paths → outcome == "escalate"
# ─────────────────────────────────────────────────────────────────────────────


async def test_budget_exceeded_escalation_stamps_escalate(
    recording_tracer: InMemorySpanExporter,
    make_stub: Any,
    asking_turn: IntakeOutputWrapper,
) -> None:
    # Stub cost (0.50) blows past the intake agent's $0.20 cap → BudgetExceeded.
    stub = make_stub(turns=[asking_turn], usd_per_call=0.50)
    outcome = await run_agent(intake_agent_def, _intake_input(), _ctx(stub))

    assert isinstance(outcome, Escalation)
    spans = _agent_spans(recording_tracer)
    assert len(spans) == 1
    attrs = dict(spans[0].attributes)
    assert attrs["agent.outcome"] == "escalate"
    assert attrs["agent.usd_spent"] == pytest.approx(0.50)


async def test_vertex_failure_escalation_stamps_escalate(
    recording_tracer: InMemorySpanExporter,
    make_stub: Any,
    asking_turn: IntakeOutputWrapper,
) -> None:
    # error_on_call=1 makes the stub raise on the first generate() → caught by
    # the generic handler → Escalation, and the span is still stamped "escalate".
    stub = make_stub(turns=[asking_turn], usd_per_call=0.004, error_on_call=1)
    outcome = await run_agent(intake_agent_def, _intake_input(), _ctx(stub))

    assert isinstance(outcome, Escalation)
    spans = _agent_spans(recording_tracer)
    assert len(spans) == 1
    assert dict(spans[0].attributes)["agent.outcome"] == "escalate"


async def test_input_validation_failure_does_not_open_agent_span(
    recording_tracer: InMemorySpanExporter,
    make_stub: Any,
    asking_turn: IntakeOutputWrapper,
) -> None:
    """Pre-dispatch failures (bad input) escalate *before* the span opens.

    The span wraps steps 4-6 (build prompt → dispatch → validate) per spec, so
    an input that fails Pydantic validation returns an Escalation without ever
    emitting an `agent:` span. This is the intended scope (no half-open spans).
    """
    stub = make_stub(turns=[asking_turn], usd_per_call=0.004)
    outcome = await run_agent(
        intake_agent_def, {"messages": "not-a-list"}, _ctx(stub)
    )
    assert isinstance(outcome, Escalation)
    assert _agent_spans(recording_tracer) == []


# ─────────────────────────────────────────────────────────────────────────────
# (c) no-op path when SS_OTEL_ENABLED=false (conftest default)
# ─────────────────────────────────────────────────────────────────────────────


async def test_noop_path_when_otel_disabled(
    monkeypatch: pytest.MonkeyPatch,
    make_stub: Any,
    asking_turn: IntakeOutputWrapper,
) -> None:
    """With tracing disabled, run_agent still works and emits no spans.

    The conftest autouse fixture sets SS_OTEL_ENABLED=false. We force the
    observability module back to its uninitialized no-op state so `agent_span`
    yields None and `record_outcome(None, ...)` is a no-op — the path the 2832
    existing tests exercise.
    """
    monkeypatch.setattr(obs, "_INITIALIZED", False)
    monkeypatch.setattr(obs, "_TRACER", None)

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    # Register a global provider so we'd catch any accidental span creation; the
    # no-op path must NOT touch it.
    monkeypatch.setattr(trace, "_TRACER_PROVIDER", provider, raising=False)

    stub = make_stub(turns=[asking_turn], usd_per_call=0.004)
    outcome = await run_agent(intake_agent_def, _intake_input(), _ctx(stub))

    assert isinstance(outcome, OutcomeOk)
    assert outcome.usd_spent == pytest.approx(0.004)
    # _TRACER stayed None ⇒ no-op ⇒ no spans recorded anywhere.
    assert obs._TRACER is None
    assert exporter.get_finished_spans() == ()
