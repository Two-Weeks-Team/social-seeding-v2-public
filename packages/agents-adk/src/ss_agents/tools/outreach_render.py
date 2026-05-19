"""outreach_render — capability layer per D41.

Renders a single outreach email by substituting Mustache-style variables in a
template with values pulled from the extracted facts + campaign brief.
Implements the `outreach.render` capability declared in
`gcp-research/specs/tier1/outreach_writer.spec.md §6`:

    outreach.render | template engine | Mustache-style variable fill

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic Mustache-light substitution. Same `(template_id, facts,
    brief)` → byte-identical `{subject, body, sender_signature,
    follow_up_eta_days}`. The renderer:
      · resolves dotted-path variables (`{{creator.nickname}}`) against the
        flattened facts + brief dict
      · falls back to a typed placeholder (`[missing: creator.nickname]`) when
        a variable is missing — never silently emits an empty string (would
        leak as a deliverability red flag)
      · cleans up leftover double-spaces and stray placeholder braces

Live mode (CAPABILITY_LAYER_MODE=live):
    Wired in W7 deploy phase — will call the v2 capability-layer Mustache
    renderer with per-workspace style memory injection (D33 14-d retention).
    Today raises NotImplementedError so prod cannot silently fall back to
    the stub.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern.
    D33 — Memory 14d. Rendered drafts inherit the Memory Bank's 14-day TTL;
          the `sender_signature` is read from per-workspace style memory in
          live mode.
    D34 — 4-locale support: ko / en / ja / zh-CN. The renderer is locale-
          agnostic (it just substitutes strings), but `follow_up_eta_days`
          defaults vary slightly by region (Japan tradition: 4 days; KR/EN:
          3 days; ZH: 5 days — captured in `_LOCALE_FOLLOW_UP_DAYS`).

Per-call cost: $0.0001 (pure local string substitution — no LLM, no HTTP).
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `outreach_render.usd_cost` for the
runtime's `cost_watch` aggregator (D41)."""


# ─────────────────────────────────────────────────────────────────────────────
# Locale + input/output models.
# ─────────────────────────────────────────────────────────────────────────────


Locale = Literal["ko", "en", "ja", "zh-CN"]
"""4 locales per D34. Keep in sync with `outreach_writer.Locale`."""


class OutreachRenderInput(BaseModel):
    """Capability input — `outreach.render` per outreach_writer.spec.md §6.

    Attributes:
        template_id: Stable per-workspace id (e.g. `tmpl_brand_ko_001`).
                     Output of the W2-A3 sibling `templates_list` tool.
        facts:       Closed-set fact bench from `outreach.extract_facts`.
                     Flattened to dotted-path keys during substitution.
        brief:       Campaign brief sub-tree (brand + targeting + logistics).
                     Same flattening rule applies.
        locale:      Locale of the source template — drives `follow_up_eta_days`
                     defaults. Pydantic Literal enforces D34's 4-locale set.
        subject:     Optional override — when set, the renderer uses this
                     instead of the template's `subject`. Lets the drafter
                     hand the chosen angle's subject in directly.
        body:        Same override semantics as `subject`.
    """

    model_config = ConfigDict(extra="forbid")

    template_id: str = Field(min_length=1, max_length=80, alias="templateId")
    facts: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Closed-set facts. Either a flat `{'creator.nickname': '...'}` "
            "dict or a nested `{'creator': {'nickname': '...'}}` dict — both "
            "shapes are flattened before substitution."
        ),
    )
    brief: dict[str, Any] = Field(
        default_factory=dict,
        description="Campaign brief sub-tree — same flattening rule as facts.",
    )
    locale: Locale = Field(
        default="ko",
        description=(
            "Locale of the template (drives follow-up-eta default + leaves "
            "the substitution charset-agnostic)."
        ),
    )
    subject: str | None = Field(
        default=None,
        max_length=200,
        description="Optional subject override; takes precedence over the template.",
    )
    body: str | None = Field(
        default=None,
        max_length=12_000,
        description="Optional body override; takes precedence over the template.",
    )


class OutreachRenderOutput(BaseModel):
    """Capability output — the rendered email + downstream metadata.

    Mirrors the task brief's contract:
        `{subject, body, sender_signature, follow_up_eta_days}`.
    """

    model_config = ConfigDict(extra="forbid")

    subject: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=12_000)
    sender_signature: str = Field(
        min_length=1,
        max_length=2000,
        alias="senderSignature",
        description=(
            "Workspace-scoped signature block. Stub returns a deterministic "
            "placeholder per locale; live mode reads from per-workspace "
            "style memory (D33 — 14-day Memory Bank TTL)."
        ),
    )
    follow_up_eta_days: int = Field(
        ge=1,
        le=14,
        alias="followUpEtaDays",
        description=(
            "Suggested follow-up window in days. Default per locale: KR/EN 3, "
            "JA 4, ZH 5 (regional response-time norms — captured offline)."
        ),
    )
    fetched_via: Literal["stub", "live"] = Field(alias="fetchedVia")


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def outreach_render(payload: OutreachRenderInput) -> OutreachRenderOutput:
    """Render the named template with extracted facts + campaign brief.

    The runtime selects stub vs live via `CAPABILITY_LAYER_MODE` (D41). Stub
    mode performs deterministic Mustache-light substitution; live mode calls
    the v2 renderer (wired in W7).

    Args:
        payload: Validated `OutreachRenderInput`.

    Returns:
        `OutreachRenderOutput` carrying the rendered subject + body + signature
        + follow-up ETA.

    Raises:
        NotImplementedError: when `CAPABILITY_LAYER_MODE=live` — until W7
            wires the live renderer. The runtime converts to a typed
            `EscalateToHuman`.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
outreach_render.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic Mustache-light renderer.
# ─────────────────────────────────────────────────────────────────────────────


# Locale → default follow-up window (days). Numbers chosen from regional
# B2B / creator-outreach norms; can be tuned per-workspace in live mode.
_LOCALE_FOLLOW_UP_DAYS: dict[Locale, int] = {
    "ko": 3,
    "en": 3,
    "ja": 4,
    "zh-CN": 5,
}


# Locale → default sender signature line. Stub uses these; live mode reads
# the per-workspace signature from style memory (D33).
_LOCALE_SIGNATURE: dict[Locale, str] = {
    "ko": "감사합니다,\nSocial Seeding 팀",
    "en": "Best regards,\nThe Social Seeding Team",
    "ja": "よろしくお願いいたします,\nSocial Seedingチーム",
    "zh-CN": "祝好,\nSocial Seeding 团队",
}


# Locale → "missing fact" placeholder. Visible enough that a human reviewer
# (or the deliverability judge) can spot a hole rather than letting an empty
# string leak into a real send.
_LOCALE_MISSING_PLACEHOLDER: dict[Locale, str] = {
    "ko": "[누락된 변수: {var}]",
    "en": "[missing: {var}]",
    "ja": "[未設定: {var}]",
    "zh-CN": "[缺失变量: {var}]",
}


# Default fallback subject + body when the template_id is unknown. Returned
# in the requested locale so the renderer is never blocked on a missing
# template (the outreach_writer tournament re-routes to a different
# template_id; the drafter still gets a typed output).
_FALLBACK_TEMPLATE: dict[Locale, tuple[str, str]] = {
    "ko": (
        "{{creator.nickname}}님께 협업 제안",
        "<p>안녕하세요 {{creator.nickname}}님,</p>"
        "<p>{{brand.name}}의 협업을 제안드립니다.</p>",
    ),
    "en": (
        "Quick note for {{creator.nickname}}",
        "<p>Hi {{creator.nickname}},</p>"
        "<p>Wanted to share a quick collaboration idea from {{brand.name}}.</p>",
    ),
    "ja": (
        "{{creator.nickname}}さんへのコラボ提案",
        "<p>{{creator.nickname}}さん、こんにちは。</p>"
        "<p>{{brand.name}}よりコラボのご相談です。</p>",
    ),
    "zh-CN": (
        "致{{creator.nickname}}的合作提案",
        "<p>{{creator.nickname}}你好,</p>"
        "<p>{{brand.name}}希望与您探讨合作。</p>",
    ),
}


# Mustache-like `{{ ... }}` matcher. We deliberately do NOT support
# Mustache sections (`{{#…}} / {{^…}}` / `{{>partial}}`) — the templates we
# ship are flat substitution only. Anything more sophisticated is a tell
# that someone hand-edited a template; live mode logs + escalates.
_MUSTACHE_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}")


def _stub(payload: OutreachRenderInput) -> OutreachRenderOutput:
    """Deterministic Mustache-light substitution.

    Algorithm:
      1. Flatten `facts` + `brief` into a single dotted-path dict.
      2. Resolve template + apply overrides.
      3. Substitute every `{{var}}` token; missing vars become a typed
         placeholder so they never leak as empty strings.
      4. Return subject + body + locale-default signature + follow-up ETA.
    """
    flat: dict[str, str] = {}
    _flatten_dict(payload.facts, "", flat)
    _flatten_dict(payload.brief, "", flat)

    # Resolve the source subject + body.
    template_subject, template_body = _resolve_template_source(
        payload.template_id, payload.locale
    )
    raw_subject = payload.subject if payload.subject is not None else template_subject
    raw_body = payload.body if payload.body is not None else template_body

    missing_placeholder = _LOCALE_MISSING_PLACEHOLDER.get(
        payload.locale, _LOCALE_MISSING_PLACEHOLDER["en"]
    )
    rendered_subject = _substitute(raw_subject, flat, missing_placeholder)
    rendered_body = _substitute(raw_body, flat, missing_placeholder)

    # Subject hygiene — collapse internal whitespace + strip control chars.
    rendered_subject = " ".join(rendered_subject.split())[:200] or "(no subject)"

    signature = _LOCALE_SIGNATURE.get(payload.locale, _LOCALE_SIGNATURE["en"])
    follow_up = _LOCALE_FOLLOW_UP_DAYS.get(
        payload.locale, _LOCALE_FOLLOW_UP_DAYS["en"]
    )

    logger.debug(
        "outreach_render_stub",
        extra={
            "template_id": payload.template_id,
            "locale": payload.locale,
            "subject_len": len(rendered_subject),
            "body_len": len(rendered_body),
            "missing_vars": _MUSTACHE_RE.findall(rendered_body),
        },
    )
    return OutreachRenderOutput(
        subject=rendered_subject,
        body=rendered_body,
        senderSignature=signature,
        followUpEtaDays=follow_up,
        fetchedVia="stub",
    )


def _flatten_dict(value: Any, prefix: str, out: dict[str, str]) -> None:
    """Flatten nested dict / list into dotted-path keys with stringified leaves.

    Examples:
      `{'creator': {'nickname': 'K'}}` → `{'creator.nickname': 'K'}`
      `{'keyClaims': ['a', 'b']}`      → `{'keyClaims.0': 'a', 'keyClaims.1': 'b'}`

    Accepts already-flat dicts unchanged (idempotent).
    """
    if isinstance(value, dict):
        for k, v in value.items():
            new_prefix = f"{prefix}.{k}" if prefix else str(k)
            _flatten_dict(v, new_prefix, out)
        return
    if isinstance(value, (list, tuple)):
        for i, item in enumerate(value):
            new_prefix = f"{prefix}.{i}" if prefix else str(i)
            _flatten_dict(item, new_prefix, out)
        return
    if value is None:
        return
    if isinstance(value, bool):
        out[prefix] = "true" if value else "false"
        return
    out[prefix] = str(value)


def _substitute(
    template_str: str, flat: dict[str, str], missing_placeholder: str
) -> str:
    """Replace every `{{var}}` with `flat[var]`, falling back to a typed
    placeholder when the variable is missing.

    The placeholder is localised so a human reviewer can spot it. We do NOT
    silently drop missing tokens — empty strings inside an outreach email
    trigger the deliverability judge's `tooManyExclamations`/`hiddenText`
    flags and look like template scaffolding.
    """

    def replace(match: re.Match[str]) -> str:
        var = match.group(1)
        if var in flat:
            return flat[var]
        return missing_placeholder.format(var=var)

    return _MUSTACHE_RE.sub(replace, template_str)


def _resolve_template_source(template_id: str, locale: Locale) -> tuple[str, str]:
    """Resolve `(subject, body)` for `template_id` against the stub bank.

    The stub doesn't actually parse `template_id` — it returns the locale-
    appropriate fallback. In live mode the renderer reads from Spanner
    v2_outreach_templates; until then we return a typed default so the
    contract holds.
    """
    return _FALLBACK_TEMPLATE.get(locale, _FALLBACK_TEMPLATE["en"])


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Today raises NotImplementedError so the
# runtime can convert to a typed `EscalateToHuman`.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: OutreachRenderInput) -> OutreachRenderOutput:
    """Live Mustache renderer — wired in W7 deploy phase."""
    raise NotImplementedError("live mode wired in W7 deploy phase")


__all__ = [
    "Locale",
    "OutreachRenderInput",
    "OutreachRenderOutput",
    "USD_COST",
    "outreach_render",
]
