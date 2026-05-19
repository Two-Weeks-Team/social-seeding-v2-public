"""templates_list — capability layer per D41.

Fetches per-workspace outreach email templates filtered by locale + campaign
type. Implements the `templates.list` capability declared in
`gcp-research/specs/tier1/outreach_writer.spec.md §6` (the row reads
`templates.list | DB read | Per-workspace template inventory`).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Returns 3 deterministic templates per requested locale. Inputs map
    1:1 to outputs so the outreach_writer tournament can render against
    known templates without burning Spanner reads / dev budgets.

Live mode (CAPABILITY_LAYER_MODE=live):
    Wired in W7 deploy phase — will read the per-workspace template inventory
    from Spanner v2_outreach_templates. Today raises NotImplementedError so
    silent fallback to the stub never happens in prod.

Citations:
    D41 — Capability layer ADK FunctionTool stub/live pattern (CAPABILITY_LAYER_MODE
          env switch + per-tool USD cost surfaced via attribute).
    D33 — Data lifecycle (Memory 14d). Templates themselves live in Spanner
          v2_outreach_templates (no TTL — they are durable per-workspace
          config), but rendered drafts that reference a template_id are
          retained ≤ 14 d in the Memory Bank.
    D34 — i18n: 4 locales — 한국어 / English / 日本語 / 简体中文. Each locale
          MUST have its own template set; we do not auto-translate at draft
          time (that's done at template-seeding time per the i18n runbook).

Per-call cost: $0.0001 (sub-cent — read-only Spanner lookup; cost scales
linearly with template count, capped at `count_limit` ≤ 50).
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0001
"""Per-call USD attribution surfaced via `templates_list.usd_cost` for the
runtime's `cost_watch` aggregator (D41)."""


# ─────────────────────────────────────────────────────────────────────────────
# Locale + campaign-type enums — kept in sync with D34 + the outreach_writer
# spec's locale set + sourcing.spec.md's campaign-type enum.
# ─────────────────────────────────────────────────────────────────────────────


Locale = Literal["ko", "en", "ja", "zh-CN"]
"""4 locales per D34 — extending here requires a deck of seed templates first."""


CampaignType = Literal["brand", "lead"]
"""brand = creator outreach (Tier-1 #3 outreach_writer);
   lead   = sales-lead outreach (Tier-1 #11 lead_outreach_writer)."""


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, `extra=forbid` to fail closed on schema drift.
# ─────────────────────────────────────────────────────────────────────────────


class TemplatesListInput(BaseModel):
    """Capability input — `templates.list` per outreach_writer.spec.md §6.

    Attributes:
        locale:        Which language's template set to return (D34).
        campaign_type: `brand` or `lead` — selects the writer that will
                       consume the template (different tone + CTA structure).
        count_limit:   Soft cap on how many templates to return. The stub
                       returns exactly 3 (the spec's contract); live mode
                       returns up to `count_limit` ordered by recency.
    """

    model_config = ConfigDict(extra="forbid")

    locale: Locale = Field(
        description="One of ko / en / ja / zh-CN per D34.",
    )
    campaign_type: CampaignType = Field(
        default="brand",
        alias="campaignType",
        description="`brand` for creator outreach, `lead` for sales-lead outreach.",
    )
    count_limit: int = Field(
        default=3,
        ge=1,
        le=50,
        alias="countLimit",
        description="Max templates to return. Stub returns min(3, count_limit).",
    )


class OutreachTemplate(BaseModel):
    """One outreach email template. Mirrors spec §6 row 1 shape:
    `{template_id, subject, body, variables[]}`."""

    model_config = ConfigDict(extra="forbid")

    template_id: str = Field(
        min_length=1,
        max_length=80,
        alias="templateId",
        description="Stable per-workspace id (e.g. `tmpl_brand_ko_001`).",
    )
    subject: str = Field(
        min_length=1,
        max_length=120,
        description="Subject line with Mustache-style `{{var}}` placeholders.",
    )
    body: str = Field(
        min_length=1,
        max_length=8000,
        description="HTML body with Mustache-style `{{var}}` placeholders.",
    )
    variables: list[str] = Field(
        default_factory=list,
        max_length=40,
        description="Variable names the body / subject reference (e.g. "
        "['creator.nickname', 'brand.name']). Drives outreach.render's "
        "facts-cite invariant per the outreach_writer spec §6.",
    )
    locale: Locale = Field(description="Locale this template was authored in (D34).")


class TemplatesListOutput(BaseModel):
    """Capability output — list of templates for the requested locale."""

    model_config = ConfigDict(extra="forbid")

    templates: list[OutreachTemplate] = Field(
        default_factory=list,
        max_length=50,
    )
    locale: Locale
    """Echoed back so caller can sanity-check no locale rewriting happened."""
    fetched_via: Literal["stub", "live"]
    """Distinguishes stubbed dev traffic from real Spanner reads in OTel traces."""


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def templates_list(payload: TemplatesListInput) -> TemplatesListOutput:
    """Fetch outreach email templates for the requested locale + campaign type.

    The runtime selects stub vs live via `CAPABILITY_LAYER_MODE` (D41). Stub
    mode returns 3 deterministic templates in the requested locale; live mode
    reads Spanner v2_outreach_templates (wired in W7).

    Args:
        payload: Validated `TemplatesListInput`.

    Returns:
        `TemplatesListOutput` carrying up to `count_limit` templates.

    Raises:
        NotImplementedError: when `CAPABILITY_LAYER_MODE=live` — until W7
            wires the real Spanner read. The runtime converts that to a typed
            `EscalateToHuman` so the workflow routes to the human queue.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
templates_list.usd_cost = USD_COST  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Stub — deterministic 3-template set per locale.
#
# Each locale has its own subject/body strings authored natively (no
# auto-translation per the i18n runbook). Variables are kept identical
# across locales so the outreach.render contract holds for any locale.
# ─────────────────────────────────────────────────────────────────────────────


# Tuple shape: (subject, body)
_STUB_TEMPLATES_BRAND: dict[Locale, list[tuple[str, str]]] = {
    "ko": [
        (
            "{{creator.nickname}}님, {{brand.name}} 협업 제안드립니다",
            "<p>안녕하세요 {{creator.nickname}}님,</p>"
            "<p>최근 콘텐츠에서 {{creator.recentPostThemes.0}} 주제를 다루신 점이 인상깊었습니다. "
            "{{brand.name}}의 {{brand.keyClaims.0}} 제품을 함께 소개해보시는 건 어떠실까요?</p>"
            "<p>샘플 발송 가능합니다. 회신 부탁드립니다.</p>",
        ),
        (
            "{{brand.name}} × {{creator.nickname}} 협업 문의",
            "<p>{{creator.nickname}}님 안녕하세요. {{brand.name}}입니다.</p>"
            "<p>{{creator.topHashtags.0}} 관련 콘텐츠를 즐겨 보고 있습니다. "
            "{{brand.keyClaims.1}} 특징을 가진 신제품 협업을 제안드립니다.</p>"
            "<p>관심 있으시면 답장 부탁드립니다.</p>",
        ),
        (
            "신제품 {{brand.name}} 체험 협업 안내",
            "<p>{{creator.nickname}}님, {{brand.category}} 카테고리에서 활발하게 활동하시는 "
            "모습이 인상적입니다.</p>"
            "<p>{{brand.name}} ({{brand.keyClaims.0}}) 체험 협업에 관심 있으신가요?</p>",
        ),
    ],
    "en": [
        (
            "{{creator.nickname}} — collab idea from {{brand.name}}",
            "<p>Hi {{creator.nickname}},</p>"
            "<p>Your recent posts on {{creator.recentPostThemes.0}} caught our eye. "
            "Would you be open to trying {{brand.name}} ({{brand.keyClaims.0}})?</p>"
            "<p>Happy to ship a sample — let us know.</p>",
        ),
        (
            "Quick partnership idea: {{brand.name}}",
            "<p>Hey {{creator.nickname}},</p>"
            "<p>We loved your {{creator.topHashtags.0}} content. "
            "{{brand.name}} just launched something we think pairs well with your style — "
            "specifically the {{brand.keyClaims.1}} angle.</p>"
            "<p>Interested?</p>",
        ),
        (
            "Trying {{brand.name}}? Sample on us",
            "<p>{{creator.nickname}}, you're crushing it in {{brand.category}}.</p>"
            "<p>Would a free {{brand.name}} sample (focus: {{brand.keyClaims.0}}) be useful "
            "for an upcoming video?</p>",
        ),
    ],
    "ja": [
        (
            "{{creator.nickname}}さんへ — {{brand.name}}よりコラボのご相談",
            "<p>{{creator.nickname}}さん、こんにちは。</p>"
            "<p>最近の{{creator.recentPostThemes.0}}に関する投稿、拝見しております。"
            "{{brand.name}} ({{brand.keyClaims.0}})をご一緒にご紹介いただけませんか?</p>"
            "<p>サンプル発送可能です。ご返信お待ちしております。</p>",
        ),
        (
            "{{brand.name}}コラボのご提案",
            "<p>{{creator.nickname}}さん、{{brand.name}}担当より失礼いたします。</p>"
            "<p>{{creator.topHashtags.0}}関連のコンテンツを楽しく拝見しております。"
            "{{brand.keyClaims.1}}という特徴の新商品でコラボご検討いただけますと幸いです。</p>",
        ),
        (
            "{{brand.name}}サンプル送付のご案内",
            "<p>{{creator.nickname}}さん、{{brand.category}}領域でのご活躍を拝見しました。</p>"
            "<p>{{brand.name}} ({{brand.keyClaims.0}})のサンプルをお試しいただけませんか?</p>",
        ),
    ],
    "zh-CN": [
        (
            "{{creator.nickname}},来自{{brand.name}}的合作邀请",
            "<p>{{creator.nickname}}你好,</p>"
            "<p>我们注意到你最近关于{{creator.recentPostThemes.0}}的内容非常出色。"
            "想邀请你试用{{brand.name}}({{brand.keyClaims.0}})。</p>"
            "<p>可以寄送样品,期待你的回复。</p>",
        ),
        (
            "{{brand.name}} × {{creator.nickname}} 合作提案",
            "<p>{{creator.nickname}}你好,我是{{brand.name}}的合作负责人。</p>"
            "<p>很喜欢你{{creator.topHashtags.0}}相关的内容。"
            "我们的新品具有{{brand.keyClaims.1}}的特点,很适合一起推广。</p>",
        ),
        (
            "{{brand.name}}样品试用邀请",
            "<p>{{creator.nickname}},你在{{brand.category}}领域的内容很棒。</p>"
            "<p>方便寄一份{{brand.name}}({{brand.keyClaims.0}})样品给你吗?</p>",
        ),
    ],
}


_STUB_TEMPLATES_LEAD: dict[Locale, list[tuple[str, str]]] = {
    "ko": [
        (
            "{{lead.companyName}}의 {{lead.painPoint}}에 대한 제안",
            "<p>{{lead.contactName}}님 안녕하세요.</p>"
            "<p>{{lead.companyName}}에서 {{lead.painPoint}} 관련 어려움이 있다고 들었습니다. "
            "{{brand.name}}의 {{brand.keyClaims.0}} 솔루션을 통해 도움드릴 수 있을 것 같습니다.</p>"
            "<p>짧은 통화 가능하실까요?</p>",
        ),
        (
            "{{lead.companyName}} 팀 대상 {{brand.name}} 데모 안내",
            "<p>{{lead.contactName}}님, {{brand.name}}의 {{brand.keyClaims.1}} 기능을 직접 "
            "보여드리는 30분 데모를 제안드립니다.</p>"
            "<p>다음 주 가능한 시간 알려주시겠어요?</p>",
        ),
        (
            "{{lead.industry}} 업계 대상 {{brand.name}} ROI 자료 공유",
            "<p>{{lead.contactName}}님, {{lead.industry}} 업계에서 {{brand.name}}을 도입한 "
            "유사 규모 회사의 사례를 정리한 자료가 있어 공유드립니다.</p>"
            "<p>관심 있으시면 회신 부탁드립니다.</p>",
        ),
    ],
    "en": [
        (
            "Solving {{lead.painPoint}} at {{lead.companyName}}",
            "<p>Hi {{lead.contactName}},</p>"
            "<p>I heard {{lead.companyName}} is wrestling with {{lead.painPoint}}. "
            "{{brand.name}}'s {{brand.keyClaims.0}} approach has helped similar teams.</p>"
            "<p>Open to a quick call?</p>",
        ),
        (
            "30-min demo: {{brand.name}} for {{lead.companyName}}",
            "<p>{{lead.contactName}}, would a focused 30-minute demo of "
            "{{brand.name}}'s {{brand.keyClaims.1}} feature be useful?</p>"
            "<p>Send a few times that work next week.</p>",
        ),
        (
            "{{lead.industry}} ROI case study from {{brand.name}}",
            "<p>{{lead.contactName}}, sharing a short case study from a "
            "{{lead.industry}} customer that adopted {{brand.name}} last quarter.</p>"
            "<p>Worth a 15-min chat?</p>",
        ),
    ],
    "ja": [
        (
            "{{lead.companyName}}様の{{lead.painPoint}}解決のご提案",
            "<p>{{lead.contactName}}様、はじめまして。</p>"
            "<p>{{lead.companyName}}様で{{lead.painPoint}}に関する課題があるとお伺いしました。"
            "{{brand.name}}の{{brand.keyClaims.0}}でお力になれるかもしれません。</p>"
            "<p>短時間のお打ち合わせは可能でしょうか?</p>",
        ),
        (
            "{{lead.companyName}}様向け{{brand.name}}デモのご案内",
            "<p>{{lead.contactName}}様、{{brand.name}}の{{brand.keyClaims.1}}機能を"
            "30分でご紹介させていただきます。</p>"
            "<p>来週ご都合の良い時間をお知らせください。</p>",
        ),
        (
            "{{lead.industry}}業界向けROI資料のご共有",
            "<p>{{lead.contactName}}様、{{lead.industry}}業界の同規模企業様が"
            "{{brand.name}}を導入された事例資料をご共有いたします。</p>",
        ),
    ],
    "zh-CN": [
        (
            "针对{{lead.companyName}}的{{lead.painPoint}}解决方案",
            "<p>{{lead.contactName}},你好。</p>"
            "<p>了解到{{lead.companyName}}在{{lead.painPoint}}方面遇到了挑战。"
            "{{brand.name}}的{{brand.keyClaims.0}}方案可能对你们有帮助。</p>"
            "<p>方便简短通话沟通吗?</p>",
        ),
        (
            "{{lead.companyName}}专属{{brand.name}}演示",
            "<p>{{lead.contactName}},我们想为{{lead.companyName}}团队"
            "安排30分钟的{{brand.name}}{{brand.keyClaims.1}}功能演示。</p>"
            "<p>下周哪天方便?</p>",
        ),
        (
            "{{lead.industry}}行业ROI案例分享",
            "<p>{{lead.contactName}},分享一份{{lead.industry}}行业"
            "采用{{brand.name}}的案例报告。</p>"
            "<p>有兴趣的话欢迎回复。</p>",
        ),
    ],
}


_TEMPLATE_VARIABLES_BRAND: list[str] = [
    "creator.nickname",
    "creator.recentPostThemes.0",
    "creator.topHashtags.0",
    "brand.name",
    "brand.category",
    "brand.keyClaims.0",
    "brand.keyClaims.1",
]

_TEMPLATE_VARIABLES_LEAD: list[str] = [
    "lead.contactName",
    "lead.companyName",
    "lead.painPoint",
    "lead.industry",
    "brand.name",
    "brand.keyClaims.0",
    "brand.keyClaims.1",
]


def _stub(payload: TemplatesListInput) -> TemplatesListOutput:
    """Deterministic 3-template stub for the requested locale.

    Determinism contract: same `(locale, campaign_type, count_limit)` →
    byte-identical output. Tests rely on this so golden assertions stay
    reproducible across CI runs.
    """
    bank = (
        _STUB_TEMPLATES_BRAND
        if payload.campaign_type == "brand"
        else _STUB_TEMPLATES_LEAD
    )
    variables = (
        _TEMPLATE_VARIABLES_BRAND
        if payload.campaign_type == "brand"
        else _TEMPLATE_VARIABLES_LEAD
    )

    locale_templates = bank.get(payload.locale)
    if locale_templates is None:
        # Defensive — Pydantic Literal should make this unreachable, but the
        # alternative (KeyError) would surface as an opaque 500 in prod.
        locale_templates = bank["en"]

    cap = min(len(locale_templates), payload.count_limit)
    templates: list[OutreachTemplate] = []
    for idx in range(cap):
        subject, body = locale_templates[idx]
        templates.append(
            OutreachTemplate(
                templateId=(
                    f"tmpl_{payload.campaign_type}_{payload.locale.replace('-', '').lower()}"
                    f"_{idx + 1:03d}"
                ),
                subject=subject,
                body=body,
                variables=list(variables),
                locale=payload.locale,
            )
        )

    logger.debug(
        "templates_list_stub",
        extra={
            "locale": payload.locale,
            "campaign_type": payload.campaign_type,
            "count_limit": payload.count_limit,
            "returned": len(templates),
        },
    )
    return TemplatesListOutput(
        templates=templates,
        locale=payload.locale,
        fetched_via="stub",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live — wired in W7 (deploy phase). Today raises NotImplementedError so the
# runtime can convert it to an `EscalateToHuman` rather than crashing.
# ─────────────────────────────────────────────────────────────────────────────


def _live(payload: TemplatesListInput) -> TemplatesListOutput:
    """Live Spanner read — wired in W7 deploy phase."""
    raise NotImplementedError("live mode wired in W7 deploy phase")


__all__ = [
    "CampaignType",
    "Locale",
    "OutreachTemplate",
    "TemplatesListInput",
    "TemplatesListOutput",
    "USD_COST",
    "templates_list",
]
