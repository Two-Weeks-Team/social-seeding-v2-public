"""gate_approveOutreachSend — capability layer per D41.

Route an AP2 v0.2 Intent Mandate through Mission Control's human approval
gate. Implements the `gate.approveOutreachSend` capability declared in
`gcp-research/specs/tier1/payment_mandate.spec.md §6` (ARCHITECTURE.md §3
row 12).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic in-memory gate. Every mandate routes to `gate_status="pending"`
    with a synthetic `stub.local` approval URL keyed by `mandate_id` — the
    human approval ceremony (WebAuthn passkey) is out-of-scope for the in-process
    capability per D27, so the stub never returns `approved`/`denied` directly.

    The `action_payload` is scanned by `prompt_guard.guard_payload` BEFORE the
    gate composes its response so adversarial outreach text trips here instead
    of being smuggled past the gate. D40 ships the particle-rich CJK regex that
    catches Korean/Japanese/Chinese injection variants with topic/object
    particles ("이전 지시는 모두 무시해주세요").

Live mode (CAPABILITY_LAYER_MODE=live):
    Real Mission Control approval write (Firestore `approval/requested`
    document + Pub/Sub `approval.requested` event per
    payment_mandate.spec.md §4 AsyncAPI). Wired in W7 deploy phase. Today
    raises NotImplementedError so callers route to the human queue rather
    than silently approving.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern (CAPABILITY_LAYER_MODE).
    D27 — AP2 scope: Intent Mandate only — **agent plans, human approves payment**.
    D40 — `prompt_guard` regex covers particle-rich CJK injection variants per
          BN-9 (KO/JA/ZH alternation gaps relaxed from `\\s*` to particle-aware
          character classes). KR particle-rich injection text in `action_payload`
          must be blocked here.
    payment_mandate.spec.md §4 — AsyncAPI `approval.requested` event shape.
    payment_mandate.spec.md §6 — Tool table row for `gate.approveOutreachSend`.

Per-call cost: $0.0001 (sub-cent — keeps payment_mandate's $0.01 per-mandate
cap intact even with both tools invoked in a single turn).
"""
from __future__ import annotations

import datetime as dt
import logging
import os
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ss_agents.runtime import PromptGuardBlocked
from ss_agents.tools.prompt_guard import scan_text

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `gate_approveOutreachSend.usd_cost`
for the runtime's `cost_watch` aggregator (D41)."""


# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────


_STUB_APPROVAL_BASE: str = "https://stub.local/approve/"
"""Synthetic approval URL prefix surfaced by the stub. /goal evaluator
recognises this prefix as 'unsigned stub mandate, do not actually navigate'."""

_DEFAULT_APPROVAL_TTL_HOURS: int = 24
"""How long stub-mode approval URLs are nominally valid before a re-issue is
required. Mirrors `expires_in_hours` default on `PaymentMandateInput`."""

Locale = Literal["ko", "en", "ja", "zh-CN"]
"""D34 — 4-locale set. Used to localise the optional `reason` field."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class GateApproveOutreachSendInput(BaseModel):
    """Capability input. Mirrors payment_mandate.spec.md §6
    (`gate.approveOutreachSend`).

    Attributes:
        mandate_id:        AP2 Intent Mandate id produced by
            `ap2_compose_intent_mandate`. The gate routes approval requests
            keyed by this id (Firestore primary key in live mode).
        action_payload:    Free-form dict describing the action being gated
            (e.g. `{"to": "creator@example.com", "subject": "...", "body": "..."}`
            for outreach). Scanned by `prompt_guard` BEFORE the gate runs so
            adversarial text trips here, not in the approval card the human
            reviews.
        requester_user_id: Operator user id who triggered the underlying
            agent run. Recorded for audit + so the approval card can attribute
            "Y triggered this on your behalf" in the operator inbox.
        locale:            Operator locale (D34 — 한국어 / English / 日本語 /
            简体中文). Drives the optional `reason` text on the response.
    """

    model_config = ConfigDict(extra="forbid")

    mandate_id: str = Field(
        min_length=1,
        max_length=80,
        description="AP2 Intent Mandate id keyed by ap2_compose_intent_mandate output.",
    )
    action_payload: dict[str, Any] = Field(
        description="Free-form dict describing the action being gated.",
    )
    requester_user_id: str = Field(
        min_length=1,
        max_length=200,
        description="Operator id who triggered the underlying agent run.",
    )
    locale: Locale = Field(
        default="ko",
        description="Operator locale (D34) — drives the optional reason text.",
    )

    @field_validator("mandate_id")
    @classmethod
    def _trim_mandate_id(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("mandate_id must be non-empty")
        return stripped

    @field_validator("action_payload")
    @classmethod
    def _scan_action_payload(cls, v: dict[str, Any]) -> dict[str, Any]:
        """Scan every string in `action_payload` for prompt-injection patterns
        per D40. Raises `PromptGuardBlocked` (an `EscalateToHuman` subclass)
        when a block-severity hit is found so the runtime converts it to an
        `Escalation` outcome — the gate NEVER fires when adversarial text is
        present in the payload.

        We do not validate via Pydantic-`ValidationError` on purpose: the
        runtime's `EscalateToHuman` path is the correct exit for
        security-policy violations (PromptGuardBlocked is a subclass).
        """
        for path, hit in _scan_dict_for_block_hits(v):
            raise PromptGuardBlocked(
                f"action_payload prompt-injection blocked at {path}: {hit['label']}",
                partial={"hits": [{**hit, "path": path}]},
            )
        return v


def _scan_dict_for_block_hits(
    payload: dict[str, Any], path: str = "action_payload"
) -> list[tuple[str, dict[str, str]]]:
    """Recursively scan a dict for block-severity prompt_guard hits.

    Returns:
        Empty list when nothing tripped. Otherwise a list of
        (json_path, hit_dict) tuples, capped at 5 — the caller raises on
        the first one.
    """
    hits: list[tuple[str, dict[str, str]]] = []
    _walk(payload, hits, path)
    return hits[:5]


def _walk(value: Any, hits: list[tuple[str, dict[str, str]]], path: str) -> None:
    if isinstance(value, str):
        for hit in scan_text(value):
            if hit["severity"] == "block":
                hits.append((path, hit))
        return
    if isinstance(value, dict):
        for k, v in value.items():
            _walk(v, hits, f"{path}.{k}")
        return
    if isinstance(value, (list, tuple)):
        for i, item in enumerate(value):
            _walk(item, hits, f"{path}[{i}]")
        return
    # int / float / bool / None / datetime → nothing to scan.


class GateApproveOutreachSendOutput(BaseModel):
    """Capability output — gate decision + approval routing.

    `gate_status` semantics:
        - `pending`     — awaiting human review (stub default; the only path
                          that emits an `approval_url`).
        - `approved`    — auto-approved by policy (live mode only; e.g. within
                          per-workspace `maxUsdPerCampaign` cap).
        - `denied`      — policy-blocked (live mode only; e.g. tenant in
                          quarantine per security_watch W3).
        - `escalated`   — human escalation queued via the approval inbox.
    """

    model_config = ConfigDict(extra="forbid")

    gate_status: Literal["pending", "approved", "denied", "escalated"]
    approval_url: str = Field(
        min_length=1,
        max_length=500,
        description="URL the operator visits to perform the WebAuthn ceremony.",
    )
    deadline_at: dt.datetime = Field(
        description="UTC timestamp at which the approval link expires.",
    )
    reason: str | None = Field(
        default=None,
        max_length=500,
        description="Optional locale-aware rationale (denied/escalated only).",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Locale-aware reason text (D34). Only emitted for non-pending decisions in
# live mode; stub mode returns `reason=None` for the default `pending` flow.
# ─────────────────────────────────────────────────────────────────────────────


_PENDING_REASON: dict[Locale, str] = {
    "ko": "사람 승인 대기 중 — Mission Control 승인 화면에서 WebAuthn 인증을 완료해 주세요.",
    "en": "Awaiting human approval — complete the WebAuthn ceremony in Mission Control.",
    "ja": "人による承認待ち — Mission Control の承認画面で WebAuthn 認証を完了してください。",
    "zh-CN": "等待人工审核 — 请在 Mission Control 完成 WebAuthn 验证。",
}


# ─────────────────────────────────────────────────────────────────────────────
# Stub state — no mutable state today, but symmetric with `forms_upsert` /
# `ap2_compose_intent_mandate` for test-fixture uniformity.
# ─────────────────────────────────────────────────────────────────────────────


def _reset_stub_state() -> None:
    """Reset module-level stub state. No-op today — the stub is purely a
    function of its input. Exposed for parity with the rest of the capability
    layer so test fixtures stay uniform (D41 canonical pattern)."""


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def gate_approveOutreachSend(
    payload: GateApproveOutreachSendInput,
) -> GateApproveOutreachSendOutput:
    """Route an AP2 Intent Mandate through Mission Control's approval gate.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated `GateApproveOutreachSendInput`. The
            `action_payload` is scanned for prompt-injection patterns at
            Pydantic validation time — adversarial text raises
            `PromptGuardBlocked` (an `EscalateToHuman` subclass) BEFORE this
            function body runs.

    Returns:
        `GateApproveOutreachSendOutput` with `gate_status="pending"` and a
        `stub.local` approval URL in stub mode.

    Raises:
        NotImplementedError: If `CAPABILITY_LAYER_MODE=live` — until W7 wires
            Mission Control's Firestore + Pub/Sub approval surface.
        PromptGuardBlocked: When `action_payload` contains a block-severity
            prompt-injection pattern (D40). Raised at input-validation time
            via `_scan_action_payload`; never reaches this function body.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
gate_approveOutreachSend.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic pending response.
#
# Contract per the task brief:
#   gate_status = "pending"
#   approval_url = f"https://stub.local/approve/{mandate_id}"
#   deadline_at  = now + 24h (UTC)
#   reason       = locale-appropriate "awaiting human approval" string.
# ─────────────────────────────────────────────────────────────────────────────


def _stub(payload: GateApproveOutreachSendInput) -> GateApproveOutreachSendOutput:
    """Deterministic stub — always returns `pending` with a stub.local URL."""
    deadline = dt.datetime.now(tz=dt.UTC) + dt.timedelta(
        hours=_DEFAULT_APPROVAL_TTL_HOURS
    )
    approval_url = f"{_STUB_APPROVAL_BASE}{payload.mandate_id}"
    reason = _PENDING_REASON.get(payload.locale, _PENDING_REASON["en"])

    logger.info(
        "gate_approveOutreachSend_stub",
        extra={
            "mandate_id": payload.mandate_id,
            "requester_user_id": payload.requester_user_id,
            "locale": payload.locale,
            "gate_status": "pending",
        },
    )
    return GateApproveOutreachSendOutput(
        gate_status="pending",
        approval_url=approval_url,
        deadline_at=deadline,
        reason=reason,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Today raises NotImplementedError; the
# runtime converts that to an `EscalateToHuman` so the workflow routes to the
# human queue rather than crashing.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: GateApproveOutreachSendInput) -> GateApproveOutreachSendOutput:
    """Live Mission Control approval write. Wired in W7 deploy phase."""
    raise NotImplementedError(
        "gate_approveOutreachSend live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


__all__ = [
    "GateApproveOutreachSendInput",
    "GateApproveOutreachSendOutput",
    "Locale",
    "USD_COST",
    "gate_approveOutreachSend",
]
