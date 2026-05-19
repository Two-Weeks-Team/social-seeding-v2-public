"""canspam_check_unsubscribe — capability layer per D41.

Verify a drafted commercial email satisfies the US CAN-SPAM Act (15 USC § 7704)
requirements before any outbound send. Implements the
`canspam.check_unsubscribe` capability declared in
`gcp-research/specs/tier1/compliance.spec.md §6`.

Three deterministic gates fire per call:
  1. **Unsubscribe link present**     — § 7704(a)(3): "clear and conspicuous"
     opt-out mechanism. We require both an unsubscribe keyword AND a working
     URL in the body.
  2. **Physical address present**     — § 7704(a)(5): valid postal address of
     the sender (≥ 10 chars heuristic; live mode validates format).
  3. **Non-deceptive subject**        — § 7704(a)(2): false/misleading subject
     headers prohibited. We score deceptiveness 0.0-1.0 from a token + heuristic
     panel (Re:/Fwd: on cold mail, bait-and-switch phrases, ALL CAPS density).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic three-gate check over the input strings; no external I/O.
    `compliant=True` only when ALL three gates pass (unsubscribe link present
    AND physical address present AND deceptive_subject_score < 0.5).

Live mode (CAPABILITY_LAYER_MODE=live):
    Promotes the unsubscribe gate to a DOM/HTTP probe of the linked URL (does
    it actually 200 and surface a manageable form?) + verifies the physical
    address against the workspace's CRM record. Wired in W7 deploy phase.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern (CAPABILITY_LAYER_MODE).
    D22 — PIPA + Marketplace minimal day-1; CAN-SPAM is the US-jurisdiction
          counterpart and is checked deterministically on every outbound.
    compliance.spec.md §6 — tool table row `canspam.check_unsubscribe`.

Per-call cost: $0.0001 (pure regex over in-memory strings; sub-cent so the
compliance agent's $0.03 cap is untouched).
"""
from __future__ import annotations

import logging
import os
import re

from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `canspam_check_unsubscribe.usd_cost`
for the runtime's `cost_watch` aggregator (D41)."""


# ─────────────────────────────────────────────────────────────────────────────
# Deterministic gate helpers — same regex set as the inline compliance.py
# helpers, but exposed as a tool so the workflow can call them independently
# of the LLM-driven agent (e.g. shadow checks, deterministic regression runs).
# ─────────────────────────────────────────────────────────────────────────────


_UNSUBSCRIBE_KEYWORD_RE = re.compile(
    r"(unsubscribe|opt[- ]?out|수신\s*거부|수신거부|配信\s*停止|退订)",
    re.I,
)
"""Multilingual unsubscribe keyword set."""

_URL_RE = re.compile(r"https?://[^\s<>\"'\]]+", re.I)
"""Plain-text URL extractor."""

_DECEPTIVE_PREFIX_TOKENS = (
    "re:", "fwd:", "fw:", "회신:", "전달:",
)
"""Common deceptive prefixes faking a reply chain (CAN-SPAM §7704(a)(2))."""

_DECEPTIVE_BAIT_PATTERNS = (
    re.compile(r"\byou\s+(?:have\s+)?won\b", re.I),
    re.compile(r"\bclaim\s+your\s+prize\b", re.I),
    re.compile(r"\bact\s+now\b", re.I),
    re.compile(r"\burgent\s*(?:!|response\s+required)\b", re.I),
    re.compile(r"\bfree\s+(?:gift|money|iphone)\b", re.I),
)
"""Bait-and-switch phrase set — each match adds 0.25 to the deceptive score."""


# Prompt-injection patterns in the subject line are weighted HIGHER than
# bait phrases (+0.5 each) — a subject crafted to override the agent's
# system prompt is an extreme-severity deception signal. CJK particle-rich
# variants are listed so the W2-B3 brief's "이전 지시를 모두 무시" surface
# trips a single-pattern match above the 0.5 compliance threshold.
_INJECTION_SUBJECT_PATTERNS = (
    re.compile(
        r"(이전|위의|상위)[\s　을를은는의에이가도모두]*"
        r"(지시|명령|프롬프트)[\s　을를은는의에이가도모두]*"
        r"(무시|버려|취소|덮어)?",
    ),
    re.compile(
        r"(以前|上記|前述|先の|前)[\s　をにへでがのは]*"
        r"(指示|プロンプト|システム)",
    ),
    re.compile(
        r"(忽略|无视|忘记)[\s　的了也]*(之前|上面|以上|前面)"
    ),
    re.compile(r"\bignore\s+(?:all\s+)?(?:prior|previous|above)\s+instructions?\b", re.I),
)


def _has_unsubscribe_link(body_html: str) -> bool:
    """Body MUST carry BOTH an unsubscribe keyword AND a URL.

    The two-signal rule guards against (a) the keyword without a working link
    and (b) a stray URL without the recipient understanding it's an opt-out.
    Phase 4 promotes this to a DOM/HTTP probe of the linked URL.
    """
    if _UNSUBSCRIBE_KEYWORD_RE.search(body_html) is None:
        return False
    return _URL_RE.search(body_html) is not None


def _has_physical_address(body_html: str, sender_address: str) -> bool:
    """§ 7704(a)(5): valid postal address of the sender must appear in the
    message OR be supplied via the sender_address field (which the workflow
    pre-fills from the workspace settings).

    We accept BOTH paths: either the body already embeds the address, OR the
    sender_address field carries a non-empty string of reasonable length
    (≥ 10 chars heuristic; live mode validates a full postal-format match).
    """
    if sender_address and sender_address.strip() and len(sender_address.strip()) >= 10:
        return True
    # Fallback: body contains a line that looks like an address. A real
    # impl would use libpostal — here we apply a coarse line-level heuristic
    # that catches the v1 outreach templates' "회사주소: …" / "Address: …"
    # pattern. We accept any line whose total length after the keyword is
    # ≥ 10 chars (postal addresses always span more than a token or two).
    addr_keyword = re.compile(
        r"(address|주소|住所|地址)\s*[:：]\s*(.{10,})",
        re.I,
    )
    return addr_keyword.search(body_html) is not None


def _score_deceptive_subject(subject: str) -> float:
    """Compute a 0.0-1.0 deceptiveness score for the subject line.

    Sources of score:
      - leading deceptive prefix (Re:/Fwd:/회신:/전달:)   → +0.5
      - bait-and-switch phrase match                       → +0.25 each (capped)
      - prompt-injection phrasing (CJK + EN)               → +0.5 each (capped)
      - ALL-CAPS density > 60% over ≥ 5 alpha chars        → +0.25
    """
    if not subject:
        return 0.0

    lowered = subject.strip().lower()
    score = 0.0

    # Leading deceptive prefix.
    if any(lowered.startswith(tok) for tok in _DECEPTIVE_PREFIX_TOKENS):
        score += 0.5

    # Bait phrases.
    for pat in _DECEPTIVE_BAIT_PATTERNS:
        if pat.search(subject):
            score += 0.25
            if score >= 1.0:
                break

    # Prompt-injection phrasing in the SUBJECT line is extreme-severity
    # (CAN-SPAM § 7704(a)(2) treats subject manipulation as deceptive); each
    # injection match adds +0.5 so a single hit clears the 0.5 compliance
    # threshold by itself. The body-level prompt-injection check is the
    # responsibility of `prompt_guard` upstream — this rule is subject-only.
    for pat in _INJECTION_SUBJECT_PATTERNS:
        if pat.search(subject):
            score += 0.5
            if score >= 1.0:
                break

    # ALL-CAPS density.
    alpha = [c for c in subject if c.isalpha() and c.isascii()]
    if alpha:
        upper_density = sum(1 for c in alpha if c.isupper()) / len(alpha)
        if upper_density > 0.6 and len(alpha) >= 5:
            score += 0.25

    return min(1.0, round(score, 4))


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class CanspamCheckUnsubscribeInput(BaseModel):
    """Capability input. Mirrors compliance.spec.md §6 `canspam.check_unsubscribe`.

    Attributes:
        email_subject:    Drafted subject line (CAN-SPAM § 7704(a)(2)).
        email_body_html:  Drafted body — HTML or plain text. Scanned as-is
            for the unsubscribe keyword + URL; the agent treats it as data.
        sender_address:   Sender's "From:" header email address (RFC 5321
            shape).
        physical_address: Sender's postal address. Required per § 7704(a)(5)
            when the body does not already embed it.
    """

    model_config = ConfigDict(extra="forbid")

    email_subject: str = Field(
        min_length=1,
        max_length=300,
        alias="emailSubject",
    )
    email_body_html: str = Field(
        min_length=1,
        max_length=200_000,
        alias="emailBodyHtml",
    )
    sender_address: str = Field(
        min_length=3,
        max_length=320,
        alias="senderAddress",
        description="RFC 5321 'From:' email shape.",
    )
    physical_address: str = Field(
        min_length=0,
        max_length=400,
        default="",
        alias="physicalAddress",
        description="Sender's postal address (§ 7704(a)(5)).",
    )

    @field_validator("sender_address")
    @classmethod
    def _email_shape(cls, v: str) -> str:
        """Light regex — exactly one `@`, non-empty local + domain w/ `.`."""
        if v.count("@") != 1:
            raise ValueError(f"invalid sender_address shape: {v!r}")
        local, _, domain = v.partition("@")
        if not local or not domain or "." not in domain:
            raise ValueError(f"invalid sender_address shape: {v!r}")
        return v


class CanspamCheckUnsubscribeOutput(BaseModel):
    """Capability output. Mirrors compliance.spec.md §6
    `canspam.check_unsubscribe` + the deliverable's expanded gate breakdown.
    """

    model_config = ConfigDict(extra="forbid")

    compliant: bool
    """True only when ALL three gates pass: unsubscribe link present AND
    physical address present AND deceptive_subject_score_0_1 < 0.5."""

    missing_requirements: list[str] = Field(
        default_factory=list,
        alias="missingRequirements",
        max_length=8,
    )
    """Operator-readable list of gate IDs that FAILED. Empty when compliant.

    Members ∈ {
      'unsubscribe_link', 'physical_address', 'non_deceptive_subject',
    }
    """

    unsubscribe_link_present: bool = Field(alias="unsubscribeLinkPresent")
    physical_address_present: bool = Field(alias="physicalAddressPresent")
    deceptive_subject_score_0_1: float = Field(
        ge=0.0,
        le=1.0,
        alias="deceptiveSubjectScore01",
        description="0.0 = clean; 1.0 = certain deception. ≥ 0.5 fails the gate.",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Tool entry point — D41 stub/live dispatch.
# ─────────────────────────────────────────────────────────────────────────────


def canspam_check_unsubscribe(
    payload: CanspamCheckUnsubscribeInput,
) -> CanspamCheckUnsubscribeOutput:
    """CAN-SPAM (15 USC § 7704) compliance check.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated email + sender metadata.

    Returns:
        Three-gate verdict. `compliant=True` only when all three gates pass.

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


def _stub(
    payload: CanspamCheckUnsubscribeInput,
) -> CanspamCheckUnsubscribeOutput:
    """Deterministic three-gate scan over the input strings.

    `compliant=True` only when:
      - body contains an unsubscribe keyword + URL, AND
      - physical address is supplied (either field or embedded in body), AND
      - subject deceptive score is below the 0.5 threshold.
    """
    unsubscribe_ok = _has_unsubscribe_link(payload.email_body_html)
    address_ok = _has_physical_address(
        body_html=payload.email_body_html,
        sender_address=payload.physical_address,
    )
    deception = _score_deceptive_subject(payload.email_subject)
    subject_ok = deception < 0.5

    missing: list[str] = []
    if not unsubscribe_ok:
        missing.append("unsubscribe_link")
    if not address_ok:
        missing.append("physical_address")
    if not subject_ok:
        missing.append("non_deceptive_subject")

    compliant = unsubscribe_ok and address_ok and subject_ok

    logger.debug(
        "canspam_check_unsubscribe_stub",
        extra={
            "compliant": compliant,
            "missing_count": len(missing),
            "deception_score": deception,
        },
    )

    return CanspamCheckUnsubscribeOutput(
        compliant=compliant,
        missingRequirements=missing,
        unsubscribeLinkPresent=unsubscribe_ok,
        physicalAddressPresent=address_ok,
        deceptiveSubjectScore01=deception,
    )


def _live(
    payload: CanspamCheckUnsubscribeInput,
) -> CanspamCheckUnsubscribeOutput:
    """Live CAN-SPAM probe — wired in W7 deploy phase.

    The live path will:
      1. HEAD the unsubscribe URL → expect 200 + a manage-preferences form
         (caches per-URL for 24h to keep cost flat).
      2. Validate the physical_address against libpostal + the workspace's
         registered business address (CRM cross-check).
      3. Run the deceptive-subject scorer against the workspace-tuned model
         (Vertex AI Text Classification + Model Armor signal feed).
    """
    raise NotImplementedError(
        "canspam_check_unsubscribe live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


# Per-invocation cost attribute (D41 pattern).
canspam_check_unsubscribe.usd_cost = USD_COST  # type: ignore[attr-defined]


__all__ = [
    "CanspamCheckUnsubscribeInput",
    "CanspamCheckUnsubscribeOutput",
    "USD_COST",
    "canspam_check_unsubscribe",
]
