"""intervention_propose — capability layer per D41.

Maps a detected friction-signal class + severity to a concrete CS
intervention playbook. Backs the `customer_success` agent's intervention
ranking (`customer_success.spec.md §6` tool table row `intervention.propose`).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic per-`signal_type` playbook. Same `(signal_type, severity)`
    → same `intervention_kind`, `scripted_message`, `dry_run_required`
    flag, and `escalation_path`. The customer_success agent calls this
    tool once per detected signal, ranks the outputs by priority, and
    emits the top-5 as `proposed_interventions[]`.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real playbook-library lookup (probably a Spanner read against
    `v2_cs_playbooks` + Cloud Workflows runbook reference) — wired in W7
    (deploy phase) once the playbook library lands. Today raises
    NotImplementedError so the runtime converts the call into an
    `EscalateToHuman` outcome rather than crashing.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern
          (CAPABILITY_LAYER_MODE).
    D28 — Per-view pricing ($0.01/view). The agent must NEVER propose a
          discount > 25% — that's a sales decision, not a CS lever, per
          customer_success.py §Discipline + Drucker §9 (the platform
          makes its margin on viral over-delivery; aggressive discounting
          corrodes the unit economics).
    D32 — intervention-as-runbook on Cloud Workflows. The `escalation_path`
          field in the output names the runbook to invoke for `severity=high`
          + `dry_run_required=False` interventions.
    customer_success.spec.md §6 — tool table row `intervention.propose`
          (playbook library; maps signals to candidate interventions).
    ARCHITECTURE.md §3 row 16 — customer_success agent's tool list.

Per-call cost: $0.0001 (sub-cent; static-table lookup, no LLM in the loop).
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger(__name__)


# Per-invocation USD cost estimate; `cost_watch` reads this attribute via
# `getattr(intervention_propose, "usd_cost", 0.0)`. A static-table lookup
# (or Spanner read in live mode) is sub-cent.
USD_COST: float = 0.0001


# ─────────────────────────────────────────────────────────────────────────────
# Type aliases — narrow Literals so Pydantic + Gemini both enforce them.
# ─────────────────────────────────────────────────────────────────────────────


SignalType = Literal[
    "onboarding_stall",
    "churn_risk",
    "upsell_opportunity",
    "reply_rate_drop",
]
"""The 4 task-brief signal classes the stub knows about. The 10-class
friction-signal enum in `customer_success.py` is a SUPERSET — the agent
maps its detected signals to one of these 4 categories before invoking
the playbook (the mapping logic lives in the agent prompt, not here)."""


Severity = Literal["low", "medium", "high"]
"""Severity gate. `high` severity always requires `dry_run_required=False`
on the recommendation (auto-execute the runbook) — the brief's stub
encodes this as a hard rule."""


InterventionKind = Literal[
    "email",
    "call",
    "slack_ping",
    "credit_bonus",
    "feature_unlock",
]
"""The 5 task-brief intervention kinds. Distinct from the 5-kind enum
in `customer_success.py` (`in_app_nudge`, `email_followup`, …) — the
agent's output kinds are operator-facing; THESE are playbook-facing
(what the CSM tooling actually does)."""


# ─────────────────────────────────────────────────────────────────────────────
# Static playbook table — deterministic mapping signal_type → kind + script.
#
# Kept module-level so:
#   (a) tests can assert on the canonical pin without re-running the stub,
#   (b) the Phase-4 live impl can import these as fallback when Spanner
#       returns no match for a (signal_type, locale) pair.
#
# Discipline (mirrored from customer_success.py §Discipline):
#   - `csm_outreach` ⇒ `call` is reserved for genuine churn risk + complex
#      onboarding stalls. Don't burn CSM minutes on `reply_rate_drop`.
#   - `discount_offer` ⇒ `credit_bonus` is bounded by Drucker §9: never
#      offer > 25% discount equivalent. The stub's credit_bonus tier is
#      below that ceiling.
# ─────────────────────────────────────────────────────────────────────────────


_PLAYBOOK: dict[str, dict[str, str]] = {
    "onboarding_stall": {
        "kind": "call",
        "message": (
            "Hi {{first_name}}, I noticed your first campaign hit a snag at "
            "the {{stage}} stage. Could we hop on a 15-min call this week so "
            "I can walk you through the next steps?"
        ),
        "escalation_path": "cs-runbook://onboarding/csm-call",
    },
    "churn_risk": {
        "kind": "email",
        "message": (
            "Hi {{first_name}}, we want to make sure Social Seeding is working "
            "for {{workspace_name}}. Your campaigns aren't shipping the volume "
            "we'd expect — here's a 3-step recovery playbook plus a direct line "
            "to me if you'd rather just talk."
        ),
        "escalation_path": "cs-runbook://churn/recovery-email",
    },
    "upsell_opportunity": {
        "kind": "feature_unlock",
        "message": (
            "{{workspace_name}} has shipped {{campaign_count}} campaigns and is "
            "averaging strong returns. We'd like to unlock the analytics tier "
            "at no cost for the next 30 days so you can see what's possible."
        ),
        "escalation_path": "cs-runbook://growth/feature-unlock",
    },
    "reply_rate_drop": {
        "kind": "slack_ping",
        "message": (
            "Heads up — your reply rate on {{workspace_name}} dropped to "
            "{{reply_rate}} this week (baseline {{baseline_reply_rate}}). "
            "Want me to swap the outreach template or queue a review with you?"
        ),
        "escalation_path": "cs-runbook://outreach/template-swap",
    },
}
"""Per-signal playbook entries. Each row has {kind, message, escalation_path}.

Note the `escalation_path` URIs (`cs-runbook://...`) — these resolve to
Cloud Workflows runbooks (D32). Phase 4 wires the actual runbook execution;
today the stub returns the URI so the customer_success agent's output can
be inspected end-to-end."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class InterventionProposeInput(BaseModel):
    """Capability input. Mirrors customer_success.spec.md §6 `intervention.propose`.

    Attributes:
        workspace_id: v2 workspace id (`ws_…`). Interventions are scoped
            per workspace — different workspaces inside the same tenant
            can have independent CS posture.
        signal_type:  One of the 4 task-brief signal classes. The
            customer_success agent maps its 10-class internal enum to
            one of these 4 before invoking the tool.
        severity:     low / medium / high. Drives the `dry_run_required`
            flag (`high` → auto-execute) and influences `escalation_path`
            selection in live mode.
    """

    model_config = ConfigDict(extra="forbid")

    workspace_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^ws_[A-Za-z0-9_-]{8,40}$",
        description="Per shared.schema.json#/$defs/WorkspaceId.",
    )
    signal_type: SignalType
    severity: Severity


class InterventionProposeOutput(BaseModel):
    """Capability output. Drives the customer_success agent's
    `proposed_interventions[]` list.

    Attributes:
        intervention_kind: One of {email, call, slack_ping, credit_bonus,
            feature_unlock}. Distinct from the agent's operator-facing
            output enum — this names the playbook-side action.
        scripted_message:  Templated message with merge fields like
            `{{first_name}}`, `{{workspace_name}}` — passed through to the
            downstream runbook for expansion.
        dry_run_required:  True when the playbook should be queued for
            human approval before execution. `severity=high` forces this
            to False (auto-execute); `severity=low|medium` forces it to
            True (queue for CSM review). The deterministic gate is the
            "severity gates intervention_kind" invariant the brief calls
            out — `severity` is the ONLY field that flips this flag.
        escalation_path:   Optional `cs-runbook://...` URI naming the
            Cloud Workflows runbook to invoke (D32). Present for every
            signal_type in the stub; the live impl may return None when
            no playbook matches.
        fetched_via:       'stub' vs 'live' — OTel splits the two streams.
    """

    model_config = ConfigDict(extra="forbid")

    intervention_kind: InterventionKind
    scripted_message: str = Field(min_length=10, max_length=2000)
    dry_run_required: bool
    escalation_path: str | None = Field(
        default=None,
        max_length=200,
        description="cs-runbook://... URI per D32. None when no playbook matches.",
    )
    fetched_via: Literal["stub", "live"]

    @model_validator(mode="after")
    def _escalation_path_uri_shape(self) -> "InterventionProposeOutput":
        """When `escalation_path` is set, it must look like a URI (have a
        scheme + path separator). Catches accidental string-concat bugs in
        a future revision of the playbook table."""
        if self.escalation_path is not None:
            ep = self.escalation_path
            if "://" not in ep:
                raise ValueError(
                    f"escalation_path must be a URI (got {ep!r} — missing '://')"
                )
            if len(ep.split("://", 1)[0]) == 0:
                raise ValueError(
                    f"escalation_path missing scheme (got {ep!r})"
                )
        return self


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def intervention_propose(
    payload: InterventionProposeInput,
) -> InterventionProposeOutput:
    """Propose a CS intervention for the given signal + severity.

    Stub vs live is selected via the `CAPABILITY_LAYER_MODE` env var (D41).
    Stub returns the canonical per-signal playbook entry; live performs the
    real playbook-library lookup (wired in W7).

    Args:
        payload: Validated `InterventionProposeInput`.

    Returns:
        `InterventionProposeOutput` naming the intervention kind, the
        templated message, the dry-run flag, and the optional runbook URI.

    Raises:
        NotImplementedError: When `CAPABILITY_LAYER_MODE=live` — until W7
            wires the real playbook library client.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
intervention_propose.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic per-signal playbook lookup.
#
# Contract per the task brief:
#   - Same (signal_type, severity) → identical output.
#   - 4-way `signal_type` switch covers all enum cases.
#   - `severity=high` ⇒ dry_run_required=False (auto-execute).
#   - `severity=low|medium` ⇒ dry_run_required=True (CSM review).
#   - escalation_path is always present in stub mode.
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: InterventionProposeInput) -> InterventionProposeOutput:
    """Deterministic stub. Lookup the canonical playbook for the signal
    type; severity flips the dry-run flag.

    Note: `workspace_id` is NOT used by the stub (the canonical playbook
    is workspace-agnostic). The live impl will use it to:
      (a) personalize merge fields from the workspace profile, and
      (b) skip playbooks blacklisted by workspace settings.
    """
    entry = _PLAYBOOK[payload.signal_type]

    # `severity=high` ⇒ auto-execute (dry_run_required=False);
    # `severity=low|medium` ⇒ queue for CSM review (dry_run_required=True).
    # This is the deterministic severity gate the brief mandates.
    dry_run_required = payload.severity != "high"

    logger.info(
        "intervention_propose_stub",
        extra={
            "workspace_id": payload.workspace_id,
            "signal_type": payload.signal_type,
            "severity": payload.severity,
            "intervention_kind": entry["kind"],
            "dry_run_required": dry_run_required,
        },
    )

    return InterventionProposeOutput(
        intervention_kind=entry["kind"],  # type: ignore[arg-type]
        scripted_message=entry["message"],
        dry_run_required=dry_run_required,
        escalation_path=entry["escalation_path"],
        fetched_via="stub",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Raises NotImplementedError so the
# runtime converts to an `EscalateToHuman` rather than crashing.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: InterventionProposeInput) -> InterventionProposeOutput:
    """Live playbook-library lookup. Wired in W7 deploy phase.

    When wired up the live path will:
      1. Read `v2_cs_playbooks` (Spanner) keyed by (workspace_id,
         signal_type) → workspace-specific override OR fall back to the
         global playbook (effectively `_PLAYBOOK` above).
      2. Compose the scripted_message by merging workspace_profile +
         locale into the template.
      3. Resolve `escalation_path` to a Cloud Workflows runbook URI (D32).
      4. Apply the severity gate (severity=high → dry_run_required=False).
      5. Return the structured output with `fetched_via="live"`.
    """
    raise NotImplementedError(
        "intervention_propose live mode wired in W7 deploy phase "
        "(Spanner v2_cs_playbooks + Cloud Workflows runbook resolution)"
    )


__all__ = [
    "InterventionKind",
    "InterventionProposeInput",
    "InterventionProposeOutput",
    "Severity",
    "SignalType",
    "USD_COST",
    "intervention_propose",
]
