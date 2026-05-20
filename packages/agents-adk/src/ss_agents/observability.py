"""OpenTelemetry + Cloud Trace wiring for the agents package.

Per D32 (Cloud Monitoring + Chronicle SIEM) every agent invocation emits an
OTel span with:

    name        agent:{agent_id}
    attributes  agent.id, agent.model, agent.tenant_id, agent.workspace_id,
                agent.trace_id, agent.usd_spent, agent.outcome ("ok"|"escalate")
    child spans llm:{model_id} per LLM call (added by ADK callbacks in
                Phase 3), tool:{tool_name} per tool call.

This module is import-safe in environments without Cloud Trace credentials —
it falls back to a no-op tracer provider when `SS_OTEL_ENABLED=false` (the
default, so unit tests run silently).
"""
from __future__ import annotations

import contextlib
import logging
from collections.abc import Iterator
from typing import Any

from ss_agents.config import get_settings

logger = logging.getLogger(__name__)

_INITIALIZED = False
_TRACER: Any = None


def setup_observability() -> None:
    """Idempotent OTel + Cloud Trace setup.

    Call once at process startup. Safe to call again (no-op). Catches all
    exceptions because a tracing failure must not bring the agent down.
    """
    global _INITIALIZED, _TRACER
    if _INITIALIZED:
        return
    _INITIALIZED = True

    settings = get_settings()
    if not settings.otel_enabled:
        # Tests + local dev — leave _TRACER as None so spans are no-ops.
        logger.debug("observability disabled (SS_OTEL_ENABLED=false)")
        return

    try:
        from opentelemetry import trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError as exc:  # pragma: no cover — defensive
        logger.warning("opentelemetry-sdk not importable: %s — tracing disabled", exc)
        return

    resource = Resource.create(
        {
            "service.name": settings.otel_service_name,
            "service.namespace": "social-seeding",
            "deployment.environment": settings.ss_environment,
            "cloud.provider": "gcp",
            "cloud.region": settings.google_cloud_location,
            "gcp.project_id": settings.google_cloud_project,
        }
    )

    provider = TracerProvider(resource=resource)

    # Cloud Trace exporter is optional — if the GCP exporter is not installed
    # (e.g. minimal CI image) we fall back to console export.
    try:
        from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter

        exporter = CloudTraceSpanExporter(project_id=settings.google_cloud_project)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        logger.info("Cloud Trace exporter enabled (project=%s)", settings.google_cloud_project)
    except Exception as exc:  # pragma: no cover — env-dependent
        from opentelemetry.sdk.trace.export import ConsoleSpanExporter

        provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
        logger.warning("Cloud Trace exporter unavailable (%s) — using console", exc)

    trace.set_tracer_provider(provider)
    _TRACER = trace.get_tracer(__name__)


@contextlib.contextmanager
def agent_span(
    *,
    agent_id: str,
    tenant_id: str,
    workspace_id: str,
    trace_id: str,
    model: str,
) -> Iterator[Any]:
    """Context manager wrapping one agent invocation in an OTel span.

    Yields the span (or None when tracing is disabled). The caller is
    responsible for `span.set_attribute("agent.usd_spent", ...)` after the
    agent completes.
    """
    setup_observability()
    if _TRACER is None:
        # No-op path — keeps zero overhead off the hot path in tests.
        yield None
        return

    with _TRACER.start_as_current_span(f"agent:{agent_id}") as span:
        span.set_attribute("agent.id", agent_id)
        span.set_attribute("agent.tenant_id", tenant_id)
        span.set_attribute("agent.workspace_id", workspace_id)
        span.set_attribute("agent.trace_id", trace_id)
        span.set_attribute("agent.model", model)
        yield span


@contextlib.contextmanager
def llm_child_span(*, model: str, agent_id: str) -> Iterator[Any]:
    """Child span for one LLM call — `llm:{model}`, nested under `agent:{id}`.

    Per the module docstring the agent span owns a child span per LLM call. The
    live ADK path also emits its own model-call spans via callback-driven
    instrumentation that inherits this provider's context (ADK auto-instrumentation
    is GA — OpenInference `GoogleADKInstrumentor` / Phoenix `register`); this hook
    gives the stub/offline path the same minimal span tree so traces look the
    same shape in dev and prod. No-op when tracing is disabled.

    Yields the child span (or None). Must be entered *inside* an active
    `agent_span` so it parents correctly.
    """
    if _TRACER is None:
        yield None
        return
    with _TRACER.start_as_current_span(f"llm:{model}") as span:
        span.set_attribute("llm.model", model)
        span.set_attribute("agent.id", agent_id)
        yield span


def record_outcome(span: Any, *, kind: str, usd_spent: float) -> None:
    """Stamp the span with the final outcome. No-op when span is None."""
    if span is None:
        return
    span.set_attribute("agent.outcome", kind)
    span.set_attribute("agent.usd_spent", float(usd_spent))


__all__ = ["agent_span", "llm_child_span", "record_outcome", "setup_observability"]
