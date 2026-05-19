"""chronicle_query — capability layer per D41.

Chronicle SecOps SIEM query for the security_watch (W3) watchdog.
Implements the `chronicle.query` capability declared in
`gcp-research/specs/tier3/security_watch.spec.md §6`.

CRITICAL injection guardrail:
    This tool accepts a `query_template_name` (an allow-listed lookup
    key into `_TEMPLATE_REGISTRY`) — NEVER a raw UDM query string. UDM
    is a domain-specific query language; allowing free-text queries
    over the audit log would let a compromised agent exfiltrate the
    SIEM directly. Tests assert that an unknown template_name raises
    `ValueError` BEFORE any backend call, both in stub and live mode.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic. Returns exactly 5 synthetic events for a known
    template (`recent_pi_alerts` is the canonical fixture). Unknown
    templates raise `ValueError` (same as live mode).

Live mode (CAPABILITY_LAYER_MODE=live):
    Real Chronicle SecOps API call. Wired in W7 deploy phase. Today
    raises NotImplementedError AFTER the template-name allow-list
    check (so a missing template fails LOUD before "not implemented"
    ever fires).

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D23 — Tier-3 W3 security_watch.
    D32 — Chronicle SecOps SIEM (the IR observability layer).
    D33 — 90d audit retention. Chronicle case events flow back here.
    security_watch.spec.md §6 — Tool table row for `chronicle.query`.

Per-call cost: $0.0002 (Chronicle SecOps is billed by ingestion volume,
not by query; the query cost is sub-cent for the small windows the
watchdog uses).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger(__name__)

USD_COST: float = 0.0002
"""Per-call USD attribution surfaced via `chronicle_query.usd_cost` for the
runtime's `cost_watch` aggregator (D41). Sub-cent; security_watch's
$0.10 per-signal cap easily absorbs 2-3 of these calls."""


# ─────────────────────────────────────────────────────────────────────────────
# Template registry — the closed allow-list of UDM queries.
#
# Each entry is a (name → human-readable description) pair; the actual
# UDM query lives in a SECRET (Secret Manager per D20) so an attacker
# who reads the codebase doesn't get the query body. Tests pin against
# the names, not the bodies.
# ─────────────────────────────────────────────────────────────────────────────


_TEMPLATE_REGISTRY: dict[str, str] = {
    "recent_pi_alerts": "Recent prompt-injection-correlated alerts for a tenant",
    "recent_pii_alerts": "Recent PII-leak-correlated alerts for a tenant",
    "credential_exfil_window": "Credential-exfil-pattern alerts in window",
    "abuse_pattern_burst": "High-burst block patterns (≥25 in window)",
    "cross_tenant_pattern": "Same patternFingerprint across multiple tenants",
    "agent_anomaly_signal": "Agent Anomaly Detection signal triage",
}
"""Closed set of allow-listed Chronicle UDM query templates. Adding a
new template requires (1) registering its body in Secret Manager, (2)
adding its name + description here, and (3) updating the security_watch
agent's prompt to reference it. Tests assert that an unknown name
raises `ValueError` from BOTH stub and live paths."""


def known_templates() -> frozenset[str]:
    """Public accessor used by tests + the security_watch agent's prompt
    builder. Returns the closed set of allow-listed template names."""
    return frozenset(_TEMPLATE_REGISTRY.keys())


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class ChronicleQueryInput(BaseModel):
    """Capability input. Mirrors security_watch.spec.md §6 `chronicle.query`.

    Attributes:
        query_template_name: Allow-listed name of a Chronicle UDM
            template. Raw UDM queries are NEVER accepted (injection
            guardrail). Validated against `_TEMPLATE_REGISTRY` at the
            tool entry point (both stub and live paths share the check).
        params:              Template-specific parameters (tenant_id,
            severity_floor, etc.). Free-form dict of primitives.
        time_range:          Inclusive `(start, end)` tuple. Both must
            be timezone-aware. `start < end` enforced.
    """

    model_config = ConfigDict(extra="forbid")

    query_template_name: str = Field(min_length=1, max_length=80)
    params: dict[str, Any] = Field(default_factory=dict, max_length=32)
    time_range: tuple[dt.datetime, dt.datetime]

    @model_validator(mode="after")
    def _validate_range(self) -> ChronicleQueryInput:
        start, end = self.time_range
        # Check tz-awareness BEFORE comparison — comparing a naive datetime
        # against a tz-aware one raises TypeError, which would short-circuit
        # the message we want to surface to callers.
        if start.tzinfo is None or end.tzinfo is None:
            raise ValueError("time_range timestamps must be timezone-aware")
        if start >= end:
            raise ValueError(
                f"time_range start ({start}) must be strictly before end ({end})"
            )
        return self


class ChronicleQueryOutput(BaseModel):
    """Capability output.

    Attributes:
        events:              List of UDM event dicts. Free-form schema
            per Chronicle's response; the security_watch agent's input
            model constrains the subset it actually reads.
        total:               `len(events)`.
        total_unique_actors: Distinct count of `actor.user.userid` or
            equivalent across all events. Used by the security_watch
            agent to detect the `cross_tenant_pattern` edge case.
    """

    model_config = ConfigDict(extra="forbid")

    events: list[dict[str, Any]] = Field(default_factory=list, max_length=1000)
    total: int = Field(ge=0)
    total_unique_actors: int = Field(ge=0)


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def chronicle_query(payload: ChronicleQueryInput) -> ChronicleQueryOutput:
    """Query Chronicle SecOps for SIEM events matching a named template.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`. The template-name allow-list check
    runs FIRST in both paths — an unknown name raises `ValueError`
    BEFORE any backend call would fire.

    Args:
        payload: Validated `ChronicleQueryInput`.

    Returns:
        `ChronicleQueryOutput` with events + counts.

    Raises:
        ValueError: when `query_template_name` is not in the closed
            allow-list. Injection guardrail.
        NotImplementedError: in LIVE mode after the allow-list check
            clears — wired in W7 deploy phase.
    """
    # Allow-list check runs FIRST, regardless of mode. An unknown
    # template_name is a workflow bug, not a "feature behind a flag" —
    # both stub and live paths reject it identically.
    if payload.query_template_name not in _TEMPLATE_REGISTRY:
        raise ValueError(
            f"chronicle_query: unknown query_template_name "
            f"{payload.query_template_name!r}. Allow-listed templates: "
            f"{sorted(_TEMPLATE_REGISTRY.keys())!r}. Raw UDM queries are "
            "NOT supported (injection guardrail)."
        )

    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
chronicle_query.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic 5-event synthesis.
#
# Algorithm:
#   1. Allow-listed template_name → 5 synthetic events deterministically
#      derived from (template_name, sorted(params)).
#   2. unique_actors = 3 — exercises the "≥3 distinct tenants" check in
#      the security_watch cross_tenant_pattern edge case.
# ─────────────────────────────────────────────────────────────────────────────


_STUB_TOTAL_EVENTS: int = 5
_STUB_UNIQUE_ACTORS: int = 3


def _stub(payload: ChronicleQueryInput) -> ChronicleQueryOutput:
    """Deterministic stub. Same input → byte-identical output (modulo
    timestamps derived from the input window)."""
    start, end = payload.time_range
    seed_text = (
        f"{payload.query_template_name}|"
        + "|".join(f"{k}={v}" for k, v in sorted(payload.params.items()))
    )
    seed_hash = hashlib.sha256(seed_text.encode("utf-8")).hexdigest()

    events: list[dict[str, Any]] = []
    interval = (end - start) / max(1, _STUB_TOTAL_EVENTS)
    for i in range(_STUB_TOTAL_EVENTS):
        events.append(
            {
                "event_id": f"stub_evt_{seed_hash[:8]}_{i:03d}",
                "timestamp": (start + interval * (i + 1)).isoformat(),
                "rule": f"ss.{payload.query_template_name}.v1",
                "severity": "high" if i % 2 == 0 else "medium",
                "actor_id": f"actor_{i % _STUB_UNIQUE_ACTORS:03d}",
                "template": payload.query_template_name,
            }
        )

    logger.debug(
        "chronicle_query_stub",
        extra={
            "template_name": payload.query_template_name,
            "total_events": len(events),
            "unique_actors": _STUB_UNIQUE_ACTORS,
        },
    )

    return ChronicleQueryOutput(
        events=events,
        total=len(events),
        total_unique_actors=_STUB_UNIQUE_ACTORS,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase).
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: ChronicleQueryInput) -> ChronicleQueryOutput:
    """Live Chronicle SecOps query — wired in W7 deploy phase."""
    _ = payload
    raise NotImplementedError(
        "chronicle_query live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "ChronicleQueryInput",
    "ChronicleQueryOutput",
    "USD_COST",
    "chronicle_query",
    "known_templates",
]
