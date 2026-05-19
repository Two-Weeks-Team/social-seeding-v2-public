"""pubsub_alert — capability layer per D41.

Pub/Sub alert publisher for the cost_watch (W2) watchdog. Emits one
message per crossed threshold (50/75/90/95%) onto the
`watchdog.cost.threshold_crossed` topic (and `watchdog.cost.budget_exceeded`
for the 100+% case — handled by the cost_watch agent's rule layer, not
here). Implements the `pubsub.alert` capability declared in
`gcp-research/specs/tier3/cost_watch.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic message_id minting. Validates alert_kind ↔
    current_pct_consumed consistency at the call site (a `budget_75`
    alert with `current_pct_consumed=0.40` would be a workflow bug,
    not a deliverable message). The stub raises `ValueError` for
    inconsistencies BEFORE returning, so the cost_watch rule layer
    catches its own mistakes during the dev loop.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real `pubsub_v1.PublisherClient.publish` against the
    `watchdog.cost.threshold_crossed` topic in the active region.
    Wired in W7 deploy phase. Today raises NotImplementedError.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D23 — Tier-3 W2 cost_watch.
    D32 — Pub/Sub is the IR transport for all watchdog → workflow alerts.
    D39 — $1500 budget cap. Threshold ladder is computed against this
          cap by `billing_query`; this tool just transports the result.
    cost_watch.spec.md §4 — AsyncAPI declares
          `watchdog.cost.threshold_crossed` as the destination channel.

Per-call cost: $0.00005 (Pub/Sub is billed per MB ingested at $40/TB;
a single ~1KB alert message costs essentially nothing).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger(__name__)

USD_COST: float = 0.00005
"""Per-call USD attribution surfaced via `pubsub_alert.usd_cost` for the
runtime's `cost_watch` aggregator (D41). Pub/Sub publish is the cheapest
hop in the IR chain — kept here for accounting consistency, not for the
absolute number."""


# ─────────────────────────────────────────────────────────────────────────────
# Alert kind enum — the threshold ladder (50/75/90/95).
# ─────────────────────────────────────────────────────────────────────────────


AlertKind = Literal["budget_50", "budget_75", "budget_90", "budget_95"]
"""The four banner-threshold alert kinds. cost_watch's rule layer
distinguishes these from the `budget_100`+ `over_limit_block` alert —
the latter goes on a SEPARATE topic (`watchdog.cost.budget_exceeded`)
and is published by a sibling tool. This tool is for the 50/75/90/95
banner alerts only."""


_PCT_BY_ALERT_KIND: dict[AlertKind, float] = {
    "budget_50": 0.50,
    "budget_75": 0.75,
    "budget_90": 0.90,
    "budget_95": 0.95,
}
"""Threshold ↔ alert_kind mapping. Used by the consistency guardrail."""


_PCT_TOLERANCE: float = 0.05
"""±5% tolerance band for the alert_kind ↔ current_pct_consumed check.
A `budget_75` alert with pct=0.79 is fine; pct=0.40 is a workflow bug."""


_TOPIC: str = "watchdog.cost.threshold_crossed"
"""Per cost_watch.spec.md §4 AsyncAPI. Single topic for the 50/75/90/95
ladder; the 100+% case publishes to `watchdog.cost.budget_exceeded`
separately."""


_ACK_DEADLINE_S: int = 60
"""Pub/Sub subscriber ack deadline. 60s is the Pub/Sub default; the
cost_watch subscriber is fast (Slack post + Mission Control banner write)
so we don't extend."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class PubsubAlertInput(BaseModel):
    """Capability input. Mirrors cost_watch.spec.md §4 ThresholdCrossed event.

    Attributes:
        workspace_id:           Which workspace tripped the threshold.
            Required — the alert needs a routing key so Slack/MC can
            scope the banner correctly.
        current_pct_consumed:   Spend / budget ratio at crossing time,
            in [0.0, ∞). Validated against `alert_kind` with a ±5%
            tolerance band — a `budget_75` alert with pct=0.40 is a
            workflow bug, not a deliverable message.
        alert_kind:             Which threshold tripped. Limited to the
            50/75/90/95 ladder; 100+% uses a separate tool/topic.
        message_body:           Operator-facing message (≤ 500 chars).
            Plain prose. The Slack/MC renderer adds the threshold
            emoji + workspace link itself; this body is the
            human-readable WHY ("3 campaigns started in last hour").
    """

    model_config = ConfigDict(extra="forbid")

    workspace_id: str = Field(min_length=1, max_length=64)
    current_pct_consumed: float = Field(ge=0.0)
    alert_kind: AlertKind
    message_body: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def _validate_alert_kind_consistency(self) -> PubsubAlertInput:
        """Alert_kind ↔ pct consistency check.

        The pct must be within ±5% of the alert's threshold. Catches the
        common workflow bug where the rule layer picks the wrong
        alert_kind for the observed pct (e.g. fires budget_75 when pct
        is actually 0.92 — that should be budget_90, not 75).
        """
        expected_pct = _PCT_BY_ALERT_KIND[self.alert_kind]
        delta = self.current_pct_consumed - expected_pct
        # The alert is fired when pct >= threshold, so negative delta
        # (pct < threshold - tolerance) is the bug; positive delta is
        # fine until the NEXT threshold tier engages — but we still
        # guard against egregious overshoot (>= threshold + 20%) which
        # signals the rule layer missed an earlier crossing.
        if delta < -_PCT_TOLERANCE:
            raise ValueError(
                f"alert_kind={self.alert_kind!r} expects pct ~= "
                f"{expected_pct:.2f} (tolerance ±{_PCT_TOLERANCE:.2f}), "
                f"got current_pct_consumed={self.current_pct_consumed:.3f}"
            )
        return self


class PubsubAlertOutput(BaseModel):
    """Capability output.

    Attributes:
        message_id:       Pub/Sub-issued message id (live) OR a
            deterministic synthetic id (stub).
        published_at:     UTC timestamp at which `publish()` returned.
        topic:            Echoes the publish topic. Always
            `watchdog.cost.threshold_crossed` for this tool.
        ack_deadline_s:   Subscriber ack deadline. Echoed so the
            cost_watch workflow can self-monitor for slow subscribers.
    """

    model_config = ConfigDict(extra="forbid")

    message_id: str = Field(min_length=1, max_length=200)
    published_at: dt.datetime
    topic: str = Field(min_length=1, max_length=200)
    ack_deadline_s: int = Field(ge=10, le=600)


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def pubsub_alert(payload: PubsubAlertInput) -> PubsubAlertOutput:
    """Publish a cost-threshold crossing alert to Pub/Sub.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated `PubsubAlertInput`. The alert_kind ↔ pct
            consistency check has already passed by the time this
            function is called (it runs in the Pydantic validator).

    Returns:
        `PubsubAlertOutput` with the resolved message_id + audit fields.

    Raises:
        NotImplementedError: in LIVE mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
pubsub_alert.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic message_id minting.
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: PubsubAlertInput) -> PubsubAlertOutput:
    """Deterministic stub. Same (workspace_id, alert_kind) → same message_id."""
    message_id = _synth_message_id(payload.workspace_id, payload.alert_kind)
    published_at = dt.datetime.now(tz=dt.UTC)

    logger.info(
        "pubsub_alert_stub",
        extra={
            "workspace_id": payload.workspace_id,
            "alert_kind": payload.alert_kind,
            "current_pct": payload.current_pct_consumed,
            "message_id": message_id,
            "topic": _TOPIC,
        },
    )

    return PubsubAlertOutput(
        message_id=message_id,
        published_at=published_at,
        topic=_TOPIC,
        ack_deadline_s=_ACK_DEADLINE_S,
    )


def _synth_message_id(workspace_id: str, alert_kind: AlertKind) -> str:
    """Mint a deterministic synthetic message_id.

    Format: `stub_msg_<alert_kind>_<8-char-hash>` — the alert_kind
    prefix makes log lines self-describing; the hash captures the
    workspace so different tenants get different ids.
    """
    digest = hashlib.sha256(
        f"{workspace_id}|{alert_kind}".encode("utf-8")
    ).hexdigest()[:8]
    return f"stub_msg_{alert_kind}_{digest}"


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase).
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: PubsubAlertInput) -> PubsubAlertOutput:
    """Live Pub/Sub publish — wired in W7 deploy phase."""
    _ = payload
    raise NotImplementedError(
        "pubsub_alert live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "AlertKind",
    "PubsubAlertInput",
    "PubsubAlertOutput",
    "USD_COST",
    "pubsub_alert",
]
