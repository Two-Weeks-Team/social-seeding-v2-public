"""dlp_inspect — capability layer per D41.

Scan a text payload for PII info-types before it leaves the trust boundary.
Implements the `dlp.inspect` capability declared in
`gcp-research/specs/tier1/compliance.spec.md §6`.

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic regex panel over the requested info_types. Findings are
    redacted in `quote_redacted` (only the type + byte offsets are surfaced;
    the raw PII never lands in the result) so the compliance audit log
    (D33 90d retention) does not become a PII honeypot.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real Google Cloud Sensitive Data Protection (SDP / DLP) inspect with
    CMEK-encrypted inspect templates per D20. Wired in W7 deploy phase.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern (CAPABILITY_LAYER_MODE).
    D20 — CMEK + Secret Manager + DLP automatic redaction across stores;
          inspect templates are the canonical surface. This tool is the
          dev-mode counterpart that exercises the same caller contract.
    D22 — PIPA + Marketplace minimal day-1. KR_RRN is the critical info-type
          for KR jurisdiction; CREDIT_CARD + US_SSN are critical globally.
    compliance.spec.md §6 — tool table row `dlp.inspect`.

Per-call cost: $0.0005 (regex panel; the live SDP path costs ~$0.001 per
1KB scanned, so dev/stub stays under the live budget by an order of
magnitude). Sub-cent so the compliance agent's $0.03 cap is untouched.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0005
"""Per-call USD attribution surfaced via `dlp_inspect.usd_cost` for the
runtime's `cost_watch` aggregator (D41). Order-of-magnitude under the live
SDP per-1KB price so dev/CI runs stay cheap."""


# ─────────────────────────────────────────────────────────────────────────────
# Likelihood ordering — mirrors google.cloud.dlp_v2.Likelihood.
# https://cloud.google.com/dlp/docs/reference/rest/v2/Likelihood
# ─────────────────────────────────────────────────────────────────────────────


Likelihood = Literal[
    "VERY_UNLIKELY", "UNLIKELY", "POSSIBLE", "LIKELY", "VERY_LIKELY",
]
"""Cloud DLP's standard likelihood ladder, in ascending order."""


_LIKELIHOOD_RANK = {
    "VERY_UNLIKELY": 0,
    "UNLIKELY": 1,
    "POSSIBLE": 2,
    "LIKELY": 3,
    "VERY_LIKELY": 4,
}


# Info-type families we deterministically detect in stub mode. Mirrors the
# critical set from compliance.spec.md §6 + the live SDP info-type catalog.
DlpInfoType = Literal[
    "KR_RRN",           # 주민등록번호: \d{6}-\d{7} (second half starts 1-4)
    "US_SSN",           # 3-2-4 digits, with reserved-block exclusions
    "CREDIT_CARD",      # 13-19 digit luhn-passing string
    "EMAIL_ADDRESS",    # RFC 5322-lite shape
    "KR_PHONE_NUMBER",  # 010-XXXX-XXXX (KR mobile canonical form)
    "PHONE_NUMBER",     # generic international/local phone
    "PASSPORT_NUMBER",  # capital letter + 7-9 digits
]
"""Info-type set supported by the stub regex panel. The live SDP path
supports the full Google catalog; this is the day-1 dev/CI subset."""


# ─────────────────────────────────────────────────────────────────────────────
# Per-info-type regex panel — deterministic, no I/O.
# ─────────────────────────────────────────────────────────────────────────────


_PATTERNS: dict[DlpInfoType, tuple[re.Pattern[str], Likelihood]] = {
    # 주민등록번호 (KR RRN) — 13 digits with hyphen, second half starts 1-4.
    # VERY_LIKELY: the format is structurally rare outside RRNs.
    "KR_RRN": (
        re.compile(r"\b\d{6}\s*-\s*[1-4]\d{6}\b"),
        "VERY_LIKELY",
    ),
    # US SSN — 3-2-4 digits with the usual reserved-block exclusions.
    "US_SSN": (
        re.compile(r"\b(?!000)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b"),
        "VERY_LIKELY",
    ),
    # Credit card — 13-19 digit string. We accept hyphens/spaces; Luhn is
    # applied below as a confidence multiplier (LIKELY → VERY_LIKELY).
    "CREDIT_CARD": (
        re.compile(r"\b(?:\d[ -]?){12,18}\d\b"),
        "LIKELY",
    ),
    # Email — RFC 5322-lite. POSSIBLE because emails are common in
    # legitimate outreach body (recipient + sender signature).
    "EMAIL_ADDRESS": (
        re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b"),
        "POSSIBLE",
    ),
    # KR mobile — 010-XXXX-XXXX (the canonical form post-2011 reform).
    "KR_PHONE_NUMBER": (
        re.compile(r"\b010-\d{4}-\d{4}\b"),
        "VERY_LIKELY",
    ),
    # Generic phone — international/local. LIKELY because false-positive
    # rate is non-trivial on numeric-heavy strings.
    "PHONE_NUMBER": (
        re.compile(
            r"(?:(?<!\d)(?:\+?\d{1,3}[- .]?)?(?:\(?\d{2,4}\)?[- .]?){2,4}\d{2,4}(?!\d))"
        ),
        "LIKELY",
    ),
    # Passport — uppercase + 7-9 digits. POSSIBLE (collides with serial nos).
    "PASSPORT_NUMBER": (
        re.compile(r"\b[A-Z][0-9]{7,9}\b"),
        "POSSIBLE",
    ),
}


def _luhn_ok(digits: str) -> bool:
    """Standard mod-10 Luhn check. Used to upgrade CREDIT_CARD likelihood."""
    nums = [int(c) for c in digits if c.isdigit()]
    if not 13 <= len(nums) <= 19:
        return False
    checksum = 0
    parity = len(nums) % 2
    for i, n in enumerate(nums):
        if i % 2 == parity:
            n *= 2
            if n > 9:
                n -= 9
        checksum += n
    return checksum % 10 == 0


def _redact(quote: str) -> str:
    """Replace the matched PII text with a fixed-length asterisk mask.

    We keep the first + last character for operator orientation (e.g. so a
    reviewer can correlate two RRNs from the same recipient) but redact
    everything in between. The byte offsets in the finding let the live
    path do precise rewriting; the redacted quote is for the audit log only.
    """
    if len(quote) <= 2:
        return "*" * len(quote)
    return f"{quote[0]}{'*' * (len(quote) - 2)}{quote[-1]}"


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class DlpInspectInput(BaseModel):
    """Capability input. Mirrors compliance.spec.md §6 `dlp.inspect`.

    Attributes:
        text:           The payload to scan. Treated as DATA — the regex
            panel never interprets it as instruction.
        info_types:     Subset of the supported info-type catalog to scan
            for. Empty list defaults to the day-1 critical set
            (KR_RRN + US_SSN + CREDIT_CARD).
        min_likelihood: Minimum likelihood for a hit to be reported. Hits
            below this floor are dropped (mirrors the SDP `minLikelihood`
            parameter).
    """

    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=200_000)
    info_types: list[DlpInfoType] = Field(
        default_factory=list,
        alias="infoTypes",
        max_length=16,
    )
    min_likelihood: Likelihood = Field(
        default="POSSIBLE",
        alias="minLikelihood",
    )


class DlpFinding(BaseModel):
    """One PII match in the scanned text."""

    model_config = ConfigDict(extra="forbid")

    info_type: DlpInfoType = Field(alias="infoType")
    likelihood: Likelihood
    quote_redacted: str = Field(
        alias="quoteRedacted",
        min_length=1,
        max_length=400,
        description=(
            "Asterisk-masked surface form. NEVER the raw PII — the audit log "
            "(D33 90d retention) must not become a PII honeypot."
        ),
    )
    byte_offset_start: int = Field(ge=0, alias="byteOffsetStart")
    byte_offset_end: int = Field(ge=0, alias="byteOffsetEnd")


class DlpInspectOutput(BaseModel):
    """Capability output. Findings (redacted) + total count for fast triage."""

    model_config = ConfigDict(extra="forbid")

    findings: list[DlpFinding] = Field(default_factory=list, max_length=200)
    total_findings: int = Field(ge=0, alias="totalFindings")


# ─────────────────────────────────────────────────────────────────────────────
# Tool entry point — D41 stub/live dispatch.
# ─────────────────────────────────────────────────────────────────────────────


_DEFAULT_INFO_TYPES: tuple[DlpInfoType, ...] = ("KR_RRN", "US_SSN", "CREDIT_CARD")
"""Day-1 critical set per compliance.spec.md §6 + D22 PIPA day-1 scope."""


def dlp_inspect(payload: DlpInspectInput) -> DlpInspectOutput:
    """Scan `text` for PII info-types at or above `min_likelihood`.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated inspect request.

    Returns:
        List of findings (redacted quotes + byte offsets) + total count.

    Raises:
        NotImplementedError: live mode — wired in W7 deploy phase.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


def _stub(payload: DlpInspectInput) -> DlpInspectOutput:
    """Deterministic regex panel.

    For each requested (or default) info_type:
      1. Iterate non-overlapping regex matches over `text`.
      2. Apply per-info-type filtering (e.g. Luhn on CREDIT_CARD; min digit
         count on PHONE_NUMBER to suppress noise).
      3. Compute the effective likelihood; drop if below `min_likelihood`.
      4. Emit a DlpFinding with the REDACTED quote + byte offsets.

    Findings are returned in (start_offset, info_type) order so the result
    is stable across runs and callers can dedupe by offset cheaply.
    """
    requested = tuple(payload.info_types) if payload.info_types else _DEFAULT_INFO_TYPES
    min_rank = _LIKELIHOOD_RANK[payload.min_likelihood]

    findings: list[DlpFinding] = []

    for info_type in requested:
        spec = _PATTERNS.get(info_type)
        if spec is None:
            # Unknown info-type in the stub catalog — silently skip.
            # Live path will route to the full SDP catalog.
            continue
        pattern, base_likelihood = spec

        for match in pattern.finditer(payload.text):
            quote = match.group(0)
            start, end = match.start(), match.end()

            # Per-info-type post-filtering + likelihood adjustment.
            likelihood = base_likelihood

            if info_type == "CREDIT_CARD":
                digits_only = re.sub(r"[^\d]", "", quote)
                if not _luhn_ok(digits_only):
                    continue
                likelihood = "VERY_LIKELY"

            elif info_type == "PHONE_NUMBER":
                digit_count = sum(1 for ch in quote if ch.isdigit())
                if not (7 <= digit_count <= 15) or len(quote) > 24:
                    continue
                # Avoid double-counting: if the text also matches KR_PHONE_NUMBER,
                # the KR_PHONE_NUMBER hit is preferred (VERY_LIKELY > LIKELY).
                if _PATTERNS["KR_PHONE_NUMBER"][0].search(quote):
                    continue

            elif info_type == "KR_PHONE_NUMBER":
                # No additional filtering; canonical 010-XXXX-XXXX form.
                pass

            if _LIKELIHOOD_RANK[likelihood] < min_rank:
                continue

            findings.append(
                DlpFinding(
                    infoType=info_type,
                    likelihood=likelihood,
                    quoteRedacted=_redact(quote),
                    byteOffsetStart=start,
                    byteOffsetEnd=end,
                )
            )

    # Stable ordering by (start_offset, info_type) — the live SDP API returns
    # arbitrary order; we normalise so callers can dedupe deterministically.
    findings.sort(key=lambda f: (f.byte_offset_start, f.info_type))

    logger.debug(
        "dlp_inspect_stub",
        extra={
            "info_types_requested": list(requested),
            "min_likelihood": payload.min_likelihood,
            "total_findings": len(findings),
        },
    )

    return DlpInspectOutput(
        findings=findings,
        totalFindings=len(findings),
    )


def _live(payload: DlpInspectInput) -> DlpInspectOutput:
    """Live SDP inspect — wired in W7 deploy phase.

    The live path will:
      1. Resolve a per-tenant InspectTemplate (CMEK-encrypted per D20).
      2. Call `dlp_v2.DlpServiceClient.inspect_content` with the requested
         info-types + min_likelihood.
      3. Translate SDP findings → DlpFinding (redacting quotes via the
         same `_redact` helper so the audit log shape is identical between
         stub and live).
    """
    raise NotImplementedError(
        "dlp_inspect live mode wired in W7 deploy phase "
        "(set CAPABILITY_LAYER_MODE=stub for now)"
    )


# Per-invocation cost attribute (D41 pattern).
dlp_inspect.usd_cost = USD_COST  # type: ignore[attr-defined]


__all__ = [
    "DlpFinding",
    "DlpInfoType",
    "DlpInspectInput",
    "DlpInspectOutput",
    "Likelihood",
    "USD_COST",
    "dlp_inspect",
]
