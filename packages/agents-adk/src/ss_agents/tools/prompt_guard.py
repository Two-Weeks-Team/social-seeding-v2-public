"""D8 + D21 prompt-guard — input sanitizer.

Two responsibilities:

1. **Detect obvious prompt-injection patterns** in user-controlled text before
   the system prompt is composed. We are not trying to replicate Model Armor
   (D21); we are providing a *belt-and-braces* second layer that runs in-process
   and trips before *any* Vertex billing happens.

2. **Block PII patterns from leaking into outbound model context** when the
   spec calls for it (intake doesn't — operator email IS the operator's data —
   but outreach_writer + lead_outreach_writer will).

The pattern list is conservative on purpose: we'd rather miss an exotic
injection (Model Armor catches the long tail) than over-block legitimate
user content. False positives are an operator-visible UX failure.

Citations:
    D8  — TikTok scraping framing requires careful handling of user-supplied
          text in prompts. Same rule applies to outreach inputs.
    D21 — Model Armor max policy + custom regex (brand, competitor, influencer
          handle). The custom regex set lives there. This module catches the
          *generic* injection patterns Model Armor's standard policy already
          blocks — we run it first so we don't pay for a Vertex round-trip
          just to get blocked.
"""
from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel

from ss_agents.runtime import PromptGuardBlocked


# ─────────────────────────────────────────────────────────────────────────────
# Pattern set. Each tuple is (regex, severity, label).
#
# Severity:
#   "block"  — trip immediately, raise PromptGuardBlocked.
#   "warn"   — log + emit telemetry, do NOT block (Phase 3 will gate on this
#              for autonomous-mode agents per D24).
# ─────────────────────────────────────────────────────────────────────────────


_INJECTION_PATTERNS: list[tuple[re.Pattern[str], str, str]] = [
    # Direct override attempts.
    (
        re.compile(r"\b(ignore|disregard|override)\b[^.\n]{0,40}\b(prior|previous|above|system)\b", re.I),
        "block",
        "system_prompt_override",
    ),
    (
        re.compile(r"\byou\s+are\s+(?:now|hereby)\s+", re.I),
        "warn",
        "role_reassignment_warn",
    ),
    # Markdown-fenced re-role attempts.
    (
        re.compile(r"```\s*system\s*\n", re.I),
        "block",
        "fenced_system_block",
    ),
    # Common jailbreak personas.
    (
        re.compile(r"\b(DAN|do\s+anything\s+now|developer\s+mode)\b", re.I),
        "block",
        "known_jailbreak_persona",
    ),
    # Tool/function exfil attempts.
    (
        re.compile(r"\b(print|reveal|show|repeat)\b[^.\n]{0,40}\b(system\s+prompt|instructions|api\s+key)\b", re.I),
        "block",
        "prompt_exfil_attempt",
    ),
    # Inline tool call injection ("[tool:gmail_send args={…}]").
    (
        re.compile(r"\[\s*tool\s*:\s*[a-z_]+\s+args\s*=", re.I),
        "block",
        "inline_tool_call_injection",
    ),
    # Cross-locale escape attempts (the v1 Korean prompt-injection corpus).
    #
    # D40 + BN-9: particle-rich CJK injection variants must trip. The previous
    # `\s*` between alternation tokens only matched literal whitespace, so
    # production-grade Korean like "이전 지시는 무시해주세요" (with topic
    # particle 는) bypassed the guard. We relax the inter-token gap to a
    # character class containing whitespace + ideographic space (　) +
    # the most common particles (KO: 을/를/은/는/의/에/이/가/도 + 모두;
    # JA: を/に/へ/で/が/の/は; ZH: 的/了/也) and extend each token
    # alternation with the surface variants surfaced by the BN-9 test corpus
    # (JA: 前; ZH: 前面 in g2, 指示 in g3). EN paths are untouched.
    (
        re.compile(
            r"(이전|위의|상위)[\s　을를은는의에이가도모두]*"
            r"(지시|명령|프롬프트)[\s　을를은는의에이가도모두]*"
            r"(무시|버려|취소|덮어)",
            re.I,
        ),
        "block",
        "ko_system_prompt_override",
    ),
    (
        re.compile(
            r"(以前|上記|前述|先の|前)[\s　をにへでがのは]*"
            r"(指示|プロンプト|システム)[\s　をにへでがのは]*"
            r"(無視|破棄|忘れ)",
            re.I,
        ),
        "block",
        "ja_system_prompt_override",
    ),
    (
        re.compile(
            r"(忽略|无视|忘记|跳过)[\s　的了也]*"
            r"(之前|上面|以上|前面)[\s　的了也]*"
            r"(指令|提示|系统|指示)",
            re.I,
        ),
        "block",
        "zh_system_prompt_override",
    ),
]


# ─────────────────────────────────────────────────────────────────────────────
# Scanning primitives.
# ─────────────────────────────────────────────────────────────────────────────


def scan_text(text: str) -> list[dict[str, str]]:
    """Scan one string for injection patterns.

    Returns:
        List of `{"label": str, "severity": str, "match": str}` dicts. Empty
        when nothing tripped. Callers decide what to do per severity.
    """
    if not text or not isinstance(text, str):
        return []
    hits: list[dict[str, str]] = []
    for pattern, severity, label in _INJECTION_PATTERNS:
        m = pattern.search(text)
        if m:
            hits.append(
                {
                    "label": label,
                    "severity": severity,
                    "match": m.group(0)[:120],  # cap echo length
                }
            )
    return hits


def guard_payload(payload: BaseModel) -> None:
    """Scan every string field on the payload. Raise on `block`-severity hits.

    Walks the validated input Pydantic model. For each `str` field (recursively
    through nested models + lists), scans the value. If any hit has severity
    "block", raises PromptGuardBlocked with the first label encountered.

    Args:
        payload: A validated Pydantic input model (from `AgentDef.input_schema`).

    Raises:
        PromptGuardBlocked: when a block-severity pattern is found.
    """
    all_hits: list[dict[str, Any]] = []
    _walk(payload, all_hits)
    block_hits = [h for h in all_hits if h["severity"] == "block"]
    if not block_hits:
        return
    first = block_hits[0]
    raise PromptGuardBlocked(
        f"injection pattern detected: {first['label']}",
        partial={"hits": all_hits[:5]},  # cap to avoid log floods
    )


def _walk(value: Any, hits: list[dict[str, Any]], path: str = "") -> None:
    """Recursive walker. Records hits with their JSON path for debuggability."""
    if isinstance(value, str):
        for hit in scan_text(value):
            hits.append({**hit, "path": path or "(root)"})
        return
    if isinstance(value, BaseModel):
        for name, _info in value.__class__.model_fields.items():
            _walk(getattr(value, name), hits, f"{path}.{name}" if path else name)
        return
    if isinstance(value, dict):
        for k, v in value.items():
            _walk(v, hits, f"{path}.{k}" if path else str(k))
        return
    if isinstance(value, (list, tuple)):
        for i, item in enumerate(value):
            _walk(item, hits, f"{path}[{i}]" if path else f"[{i}]")
        return
    # int / float / bool / None / datetime → nothing to scan.


__all__ = ["guard_payload", "scan_text"]
