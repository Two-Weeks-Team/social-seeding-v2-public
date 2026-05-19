"""forms_upsert — capability layer per D41.

Persist a `CampaignBrief` to the v2_briefs Spanner table (D15). Implements the
`forms.upsert` capability declared in
`gcp-research/specs/tier1/intake.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic in-memory upsert. The first time a (synthesized) brief_id is
    seen, `created=True`; subsequent upserts of the same id return `created=False`
    with the version bumped. When the caller does not supply `brief_id`, the stub
    emits a canonical demo id (`brief_demo_001`) so /goal evaluator + golden
    tests can pin against a stable surface.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real Spanner upsert wired by the W7 deploy phase (NotImplementedError
    today — surfacing a typed escalation rather than silently writing).

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern (CAPABILITY_LAYER_MODE).
    D15 — Hybrid OLTP: Spanner for tenant/billing core. v2_briefs lives in Spanner.
    intake.spec.md §6 — Tool table row for `forms.upsert`.
    BUILD-NOTES.md — UUIDv7 (time-ordered, replay-resistant) is the canonical
        id format for v2 entities; the generator is the one already implemented
        in `ss_agents.agents.payment_mandate.uuidv7`.

Per-call cost: $0.0001 (sub-cent — keeps intake's $0.20 multi-turn cap intact
even if the agent upserts on every turn).
"""
from __future__ import annotations

import logging
import os
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ss_agents.agents.payment_mandate import uuidv7

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `forms_upsert.usd_cost` for the
runtime's `cost_watch` aggregator (D41)."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class FormsUpsertInput(BaseModel):
    """Capability input. Mirrors intake.spec.md §6 `forms.upsert`.

    Attributes:
        brief_id:      Optional id of an existing brief. When None, a fresh
            UUIDv7 is minted in live mode (BUILD-NOTES.md), or the canonical
            stub id is returned in stub mode.
        brief_payload: Validated `CampaignBrief` (intake.spec.md §6 + the
            Pydantic mirror in `ss_agents.agents.intake`). Invalid payloads
            are rejected at Pydantic validation time — this is the contract
            between the intake agent's `done` turn and the persistence layer.

            Declared as `Any` here (rather than the concrete `CampaignBrief`
            class) to avoid a module-load cycle with `ss_agents.agents.intake`
            — intake.py imports this module to wire `forms_upsert` into its
            tool list. A `field_validator` performs the equivalent
            `CampaignBrief.model_validate(...)` step at validation time via a
            local import; from a contract perspective the rejection behavior is
            identical to a direct field-type annotation.
        workspace_id:  v2 workspace id (`ws_…`); the brief lives under this key.
        created_by:    Operator identifier (email or system id); recorded for
            audit + the AsyncAPI `agent.t1.intake.brief_completed` event.
    """

    model_config = ConfigDict(extra="forbid")

    brief_id: str | None = Field(default=None, max_length=80)
    brief_payload: Any
    workspace_id: str = Field(min_length=1)
    created_by: str = Field(min_length=1)

    @field_validator("brief_payload", mode="before")
    @classmethod
    def _coerce_campaign_brief(cls, v: Any) -> Any:
        """Validate `brief_payload` against `CampaignBrief`.

        Imports `CampaignBrief` lazily to break the module-load cycle with
        `ss_agents.agents.intake`. Behavior is equivalent to typing the field
        as `brief_payload: CampaignBrief`: any payload that does not pass
        `CampaignBrief.model_validate(...)` raises `pydantic.ValidationError`
        and is rejected upstream by the runtime.
        """
        from ss_agents.agents.intake import CampaignBrief

        if isinstance(v, CampaignBrief):
            return v
        # `model_validate` raises pydantic.ValidationError on bad shapes,
        # which Pydantic surfaces as a field-level error on `brief_payload`.
        return CampaignBrief.model_validate(v)


class FormsUpsertOutput(BaseModel):
    """Capability output. Mirrors intake.spec.md §4 `BriefCompleted`-shaped fields.

    Attributes:
        brief_id:    Final id of the persisted brief (input id or freshly minted).
        created:     True on insert, False on update of an existing brief.
        version:     Monotonically increasing per (brief_id) — 1 on insert,
            bumped on every subsequent upsert (Spanner-backed in live mode;
            module-level dict in stub mode).
        persisted_at: UTC timestamp at which the row was written.
    """

    model_config = ConfigDict(extra="forbid")

    brief_id: str = Field(min_length=1, max_length=80)
    created: bool
    version: int = Field(ge=1)
    persisted_at: datetime


# ─────────────────────────────────────────────────────────────────────────────
# Stub state — module-level, reset between tests via the `_reset_stub_state`
# escape hatch (kept private; tests import it directly).
# ─────────────────────────────────────────────────────────────────────────────


_SEEN: set[str] = set()
"""Set of brief_ids the stub has previously written. Drives the `created` flag
and the version counter — first-write → created=True/version=1; subsequent
writes → created=False with version bumped from `_VERSIONS`."""

_VERSIONS: dict[str, int] = {}
"""Per-brief_id version counter. Tracks the last-written version so successive
upserts of the same id surface a strictly-monotonic version number."""

_STUB_DEMO_BRIEF_ID: str = "brief_demo_001"
"""Canonical id returned by stub mode when the caller does not supply one.
Lets /goal evaluator + smoke tests pin to a stable surface (intake.spec.md §5
Mermaid happy-path)."""


def _reset_stub_state() -> None:
    """Reset module-level stub state. Used by tests via fixture / `monkeypatch`.

    Production code does not call this — the live mode owns its own state in
    Spanner.
    """
    _SEEN.clear()
    _VERSIONS.clear()


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def forms_upsert(payload: FormsUpsertInput) -> FormsUpsertOutput:
    """Persist (insert or update) a CampaignBrief to v2_briefs (Spanner).

    The runtime selects stub vs live via the `CAPABILITY_LAYER_MODE` env var
    (D41). Stub mode is deterministic + in-memory; live mode performs the
    real Spanner upsert (wired in W7).

    Args:
        payload: Validated `FormsUpsertInput`. Pydantic enforces that
            `brief_payload` is a valid `CampaignBrief` — invalid briefs
            cannot reach this function.

    Returns:
        `FormsUpsertOutput` with the resolved brief_id, created flag,
        version, and persisted_at timestamp.

    Raises:
        NotImplementedError: If `CAPABILITY_LAYER_MODE=live` — until W7 wires
            the real Spanner client. Caller surfaces as `EscalateToHuman`.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
forms_upsert.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic in-memory upsert.
#
# Behavior per the task brief:
#   - No brief_id supplied → return canonical `brief_demo_001` (stable across
#     tests + /goal runs).
#   - brief_id supplied → echo it back.
#   - First time a given brief_id is seen in this process → created=True,
#     version=1. Subsequent calls → created=False, version=prev+1.
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: FormsUpsertInput) -> FormsUpsertOutput:
    """Deterministic stub. In-memory `(brief_id) → version` ledger."""
    if payload.brief_id is None:
        brief_id = _STUB_DEMO_BRIEF_ID
    else:
        brief_id = payload.brief_id

    if brief_id in _SEEN:
        version = _VERSIONS.get(brief_id, 1) + 1
        created = False
    else:
        version = 1
        created = True
        _SEEN.add(brief_id)
    _VERSIONS[brief_id] = version

    persisted_at = datetime.now(tz=UTC)
    logger.info(
        "forms_upsert_stub",
        extra={
            "brief_id": brief_id,
            "workspace_id": payload.workspace_id,
            "created": created,
            "version": version,
        },
    )
    return FormsUpsertOutput(
        brief_id=brief_id,
        created=created,
        version=version,
        persisted_at=persisted_at,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Today raises NotImplementedError; the
# runtime converts that to an `EscalateToHuman` so the workflow routes to the
# human queue rather than crashing.
#
# When wired up the live path will:
#   1. If `brief_id is None`, mint a fresh UUIDv7 (BUILD-NOTES.md) so the new
#      row's primary key is time-ordered + replay-resistant.
#   2. Perform a Spanner read-modify-write of `v2_briefs` keyed by brief_id.
#   3. Return the resolved id + `created` flag (computed from existence prior
#      to the write) + post-write version + commit timestamp.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: FormsUpsertInput) -> FormsUpsertOutput:
    """Live Spanner upsert. Wired in W7 deploy phase."""
    # `uuidv7` is imported eagerly so any breakage in the shared generator
    # surfaces at import time rather than at the first live call. We DO NOT
    # invoke it here — `NotImplementedError` is the contract until W7.
    _ = uuidv7  # touch — keeps the import live for static checkers.
    raise NotImplementedError("live mode wired in W7 deploy phase")


__all__ = [
    "FormsUpsertInput",
    "FormsUpsertOutput",
    "USD_COST",
    "forms_upsert",
]
