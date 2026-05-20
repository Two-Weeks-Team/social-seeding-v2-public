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
injection than over-block legitimate user content. False positives are an
operator-visible UX failure.

⚠️ HONEST SCOPE (RULES.md Professional Honesty; GRAND-NARRATIVE-PLAN §7):
    `prompt_guard` is the IN-PROCESS belt-and-braces layer and is BYPASSABLE
    (regex pattern-matching is defeatable by obfuscation, novel phrasings,
    encoding, etc.). It is NOT a complete defense. The intended deep layer is
    Model Armor (D21), which is a **STUB today** — so we do NOT claim layered
    enforcement is live, and we do NOT claim Model Armor "catches the long
    tail" in production. This guard reduces obvious-injection blast radius and
    trips before any Vertex billing; it is not a substitute for the deep layer.

Citations:
    D8  — TikTok scraping framing requires careful handling of user-supplied
          text in prompts. Same rule applies to outreach inputs.
    D21 — Model Armor max policy + custom regex (brand, competitor, influencer
          handle). The custom regex set lives there. INTENDED deep layer;
          currently a stub — see honest-scope note above. This module catches
          the *generic* injection patterns the standard policy would block — we
          run it first so we don't pay for a Vertex round-trip to get blocked.
    D32 — Chronicle/SecOps SIEM: a block-severity hit is an audit-worthy
          security signal (the runtime emits it via PromptGuardBlocked).
    D34 — ko-first product surface ⇒ multilingual (ko/ja/zh-CN) coverage is
          first-class, not an afterthought.
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
    # Direct override attempts. The target noun set is the key precision lever:
    # we anchor on "system / instructions / prompt / rules / context / guard-
    # rails" qualified by a directional word (prior/previous/above/all/your) so
    # a benign "ignore my last message, I meant…" (target = "message", not on
    # the noun set) does NOT trip. EN paths stay tight on purpose.
    (
        re.compile(
            r"\b(ignore|disregard|forget|override|bypass|skip|drop)\b"
            r"[^.\n]{0,40}"
            r"\b(prior|previous|above|earlier|all|any|the|your|these|those)?\b"
            r"[^.\n]{0,12}"
            r"\b(system\s+prompt|system\s+message|instruction|instructions|"
            r"prompt|prompts|rule|rules|guardrail|guardrails|directive|"
            r"directives|guideline|guidelines|restriction|restrictions|"
            r"constraint|constraints|context)\b",
            re.I,
        ),
        "block",
        "system_prompt_override",
    ),
    # "new system prompt" / "updated instructions" — re-injection of a fresh
    # directive block (a common indirect-injection payload shape).
    (
        re.compile(
            r"\b(?:(?:the|your)\s+)?(new|updated|revised|replacement|real|actual|"
            r"true|correct)\b"
            r"[^.\n]{0,20}"
            r"\b(system\s+prompt|system\s+message|system\s+instructions?|"
            r"instructions?|directives?)\b",
            re.I,
        ),
        "block",
        "new_system_prompt_injection",
    ),
    # Role-reassignment: "you are now <a persona/AI/unrestricted thing>".
    #
    # Precision: a bare "you are now …" is too broad — legit text like "you are
    # now confirmed for the May collab" must NOT trip. We require the reassigned
    # identity to look like an AI/persona/role redefinition: an article/"a(n)"
    # or one of the persona/restriction nouns. ("you are now confirmed" → the
    # word after "now" is a verb, no article/persona noun, so it is allowed.)
    (
        re.compile(
            r"\byou\s+are\s+(?:now|hereby)\s+"
            r"(?:an?\s+|the\s+|going\s+to\s+(?:be|act)|"
            r"(?:a\s+)?(?:new\s+)?(?:AI|assistant|chatbot|model|bot|agent|"
            r"persona|character|unrestricted|unfiltered|jailbroken|free|"
            r"DAN|developer|hacker|expert)\b)",
            re.I,
        ),
        "block",
        "role_reassignment",
    ),
    (
        re.compile(
            r"\b(from\s+now\s+on|starting\s+now|going\s+forward)\b[^.\n]{0,30}"
            r"\byou\s+(?:are|will|must|should)\s+(?:always\s+|never\s+|"
            r"answer|respond|reply|act|behave|ignore|comply|obey|"
            r"a\b|an\b|the\b)",
            re.I,
        ),
        "block",
        "role_reassignment",
    ),
    # "act as <persona>" / "pretend to be" / "roleplay as" — but NOT a benign
    # "I act as the marketing lead" (1st-person job description). We require the
    # actor to be 2nd-person/imperative ("you act as" / leading "act as") and
    # exclude a directly-preceding subject pronoun other than an imperative.
    (
        re.compile(
            r"(?:(?<![a-z])you\s+(?:should\s+|must\s+|will\s+)?act\s+as\b"
            r"|(?<![a-z\s])\bact\s+as\s+(?:an?|the)\b"
            r"|behave\s+(?:as|like)\s+(?:an?|the)\b"
            r"|pretend\s+(?:to\s+be|you\s+are|that\s+you)"
            r"|roleplay\s+as\b|simulate\s+(?:being|a)\b|imagine\s+you\s+are\b)",
            re.I,
        ),
        "block",
        "role_reassignment",
    ),
    # Markdown-fenced re-role attempts (```system / ```assistant blocks).
    (
        re.compile(r"```\s*(system|assistant|developer)\s*\n", re.I),
        "block",
        "fenced_system_block",
    ),
    # Chat-template / role-marker injection ("<|system|>", "[INST]",
    # "### System:", "System:" at line start as a role header).
    (
        re.compile(
            r"(<\|?\s*(system|assistant|im_start)\s*\|?>|\[/?INST\]|"
            r"(?m:^[#\s>*-]*\s*(system|assistant|developer)\s*:))",
            re.I,
        ),
        "block",
        "role_marker_injection",
    ),
    # Common jailbreak personas + "enable/activate <mode>" framings.
    (
        re.compile(
            r"\b(DAN|STAN|AIM|do\s+anything\s+now|jailbreak(?:en)?|"
            r"developer\s+mode|god\s+mode|sudo\s+mode|unrestricted\s+mode|"
            r"no\s+restrictions?\s+mode)\b",
            re.I,
        ),
        "block",
        "known_jailbreak_persona",
    ),
    (
        re.compile(
            r"\b(enable|activate|turn\s+on|switch\s+to|enter)\b[^.\n]{0,24}"
            r"\b(developer|god|sudo|debug|unrestricted|jailbreak|admin|root)\s+mode\b",
            re.I,
        ),
        "block",
        "mode_switch_jailbreak",
    ),
    # Tool/function exfil + "print/repeat your system prompt|instructions".
    (
        re.compile(
            r"\b(print|reveal|show|repeat|output|display|dump|tell\s+me|"
            r"what\s+(?:are|is)|expose|leak|disclose)\b"
            r"[^.\n]{0,40}"
            r"\b(your\s+)?(system\s+prompt|system\s+message|"
            r"(?:initial|original|full)\s+instructions?|instructions?|"
            r"prompt|api\s+key|secret|credential|token)\b",
            re.I,
        ),
        "block",
        "prompt_exfil_attempt",
    ),
    # Inline tool call injection ("[tool:gmail_send args={…}]") + alt syntaxes
    # ("call tool gmail.send(…)", "use the gmail.send tool to …").
    (
        re.compile(r"\[\s*tool\s*:\s*[a-z_]+\s+args\s*=", re.I),
        "block",
        "inline_tool_call_injection",
    ),
    (
        re.compile(
            r"\b(call|invoke|execute|run|use)\b[^.\n]{0,40}"
            r"\b(gmail[._]?send|external_send|[a-z_]+\.(?:send|exec|run|delete|"
            r"transfer|pay|charge)|tool\s*:\s*[a-z_]+|(?:tool|function|"
            r"capability)\b[^.\n]{0,24}[a-z_]+\.[a-z_]+)\b",
            re.I,
        ),
        "block",
        "tool_exfil_request",
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
            r"(忽略|无视|忘记|跳过|绕过)[\s　的了也]*"
            r"(之前|上面|以上|前面|所有|你的)?[\s　的了也]*"
            r"(指令|提示|系统提示|系统|指示|规则|约束)",
            re.I,
        ),
        "block",
        "zh_system_prompt_override",
    ),
    # ── Multilingual role-reassignment (D34 ko-first product surface) ────────
    # KO: "너는 이제 …", "당신은 이제 …", "지금부터 너는 …", "~인 척해".
    (
        re.compile(
            r"((너|당신|넌)[\s　은는이가]*\s*이제|지금부터[\s　]*(너|당신|넌))"
            r"|(처럼|인\s*척|역할[\s　을를]*(해|맡))",
            re.I,
        ),
        "block",
        "ko_role_reassignment",
    ),
    # JA: "あなたは今〜", "今から〜として", "〜のふりをして", "〜になりきって".
    (
        re.compile(
            r"(あなた[\s　はがを]*今|今[\s　]*から[\s　]*[^.\n]{0,12}として)"
            r"|(の[\s　]*ふり[\s　]*を|になりきって|を[\s　]*演じ)",
            re.I,
        ),
        "block",
        "ja_role_reassignment",
    ),
    # ZH: "你现在是…", "从现在起你…", "扮演…", "假装你是…".
    (
        re.compile(
            r"(你现在是|从现在起[\s　]*你|你[\s　]*将[\s　]*扮演)"
            r"|(扮演|假装[\s　]*你[\s　]*是|假装成|模拟[\s　]*成为)",
            re.I,
        ),
        "block",
        "zh_role_reassignment",
    ),
    # ── Multilingual prompt/credential exfiltration ──────────────────────────
    # KO: "시스템 프롬프트 보여줘/출력해/알려줘", "지시사항 알려줘", "API 키".
    (
        re.compile(
            r"(시스템[\s　]*(프롬프트|지시|메시지)|지시\s*사항|프롬프트|API[\s　]*키)"
            r"[\s　을를은는이가]*"
            r"(보여|출력|알려|말해|공개|노출|반복|보내)",
            re.I,
        ),
        "block",
        "ko_prompt_exfil_attempt",
    ),
    # JA: "システムプロンプトを教えて/見せて/出力して", "指示を表示".
    (
        re.compile(
            r"(システム[\s　]*(プロンプト|指示|メッセージ)|プロンプト|指示|APIキー)"
            r"[\s　をはが]*"
            r"(教え|見せ|表示|出力|公開|繰り返|漏らし)",
            re.I,
        ),
        "block",
        "ja_prompt_exfil_attempt",
    ),
    # ZH: "显示/输出/告诉我 系统提示/指令", "泄露 API 密钥".
    (
        re.compile(
            r"(显示|输出|告诉我|展示|打印|重复|泄露|公开)[\s　的了你我]*"
            r"(系统提示|系统指令|系统消息|提示词|提示|指令|API[\s　]*密钥|密钥)",
            re.I,
        ),
        "block",
        "zh_prompt_exfil_attempt",
    ),
    # ── Multilingual jailbreak-mode framings ─────────────────────────────────
    # KO: "개발자 모드 켜/활성화", "탈옥". JA: "開発者モード". ZH: "开发者模式".
    (
        re.compile(
            r"((개발자|디버그|관리자)[\s　]*모드[\s　]*(켜|활성|on)|탈옥)"
            r"|((開発者|デベロッパー)[\s　]*モード)"
            r"|((开发者|调试|管理员)[\s　]*模式)",
            re.I,
        ),
        "block",
        "cjk_mode_switch_jailbreak",
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
