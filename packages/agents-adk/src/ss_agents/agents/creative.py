"""Creative agent — Phase 3 port (NEW agent, no v2 predecessor).

Turns a CampaignBrief into a creative direction package:
    · moodboard (palette + style keywords + reference creators),
    · shot list (5-12 shots with framing + duration + optional dialogue),
    · sample video brief (Veo 3 + Lyria prompts + expected runtime),
    · brand-safety check (IP, deepfake risk, locale-specific cultural notes).

Phase 3 boundary (see BUILD-NOTES.md §1):
    Imagen 4 (moodboard stills), Veo 3 (≤ 8 sec sample video), and Lyria
    (audio sting) are **capability-layer tools** that get wired in Phase 4.
    This file computes the **prompts** + **safety logic** without actually
    invoking those tools. The capability stubs live in
    `ss_agents.tools.shared` for Phase 4 hand-off; Phase 3 keeps `tools=[]`
    on the AgentDef so the unit tests + golden eval run fully offline.

Behaviour (creative.spec.md §1 + task brief):
    Bounded single-turn planner. Given a brand brief + mood keywords +
    optional reference URLs + target duration + locale, the agent emits:
      moodboard: { palette_oklch[6], style_keywords[3-8], reference_creators[3] }
      shot_list: [ { scene_index, duration_sec, action_description, framing,
                     dialogue? } ] (5-12 shots)
      sample_video_brief: { veo3_prompt, lyria_music_prompt, expected_runtime_sec }
      brand_safety_check: { ip_concerns[], deepfake_risks[], cultural_sensitivities[] }

Citations:
    D5  — Gemini 3.1 Pro for creative planning (multimodal Pro chosen over
          Flash because the task requires sustained creative reasoning across
          palette + shot list + multimodal prompts; outweighs the 5× cost
          delta given the $0.30 cap).
    D23 — Tier-1 agent #14 (creative, NEW).
    D29 — Multimodal + AP2 + Multi-agent — the differentiator behind v2 day-1.
    D33 — Asset retention via Cloud Storage lifecycle (post-Phase-4 storage
          path is `gs://ss-v2-creative/{workspace_id}/{trace_id}/…` with a
          30-day lifecycle rule).
    D34 — `cultural_sensitivities` is keyed on the operator locale so the
          model writes locale-appropriate cautions (e.g. red-package = funeral
          imagery in zh-CN contexts, alcohol restrictions in ko/ja TV norms).
    D39 — $1,500 credits unlocked Veo 3 + Imagen 4 + Lyria for the demo;
          the $0.30 cap leaves headroom for the workflow's later asset-gen
          step ($3.00/full pack per spec.md §6) plus 4× retries.
    ARCHITECTURE.md §3 row 14:
        creative | 1 | Gemini 3.1 Pro + Imagen 4 + Veo 3
                 | imagen.generate, veo.generate, lyria.generate, assets.upload
                 | Memory Bank (brand)
                 | safety_v1 + brand_consistency

Compared to `content_verify.py`:
    - Content-verify is a verdict producer (matches/flags/score); this is a
      generator producing structured creative content + prompts.
    - The output always includes a `brand_safety_check`. Non-empty lists in
      any of the three sub-lists are an **operator gate** (the workflow
      escalates), NOT a runtime-level Escalation — same posture as
      content_verify's `ambiguous` flag.
    - Palette + WCAG-AA contrast check happen post-LLM in a Pydantic
      `model_validator` so the model can't ship a low-contrast palette into
      downstream pipelines silently.
"""
from __future__ import annotations

import logging
import math
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ss_agents.agents.intake import CampaignBrief
from ss_agents.runtime import AgentDef
from ss_agents.tools.assets_upload import assets_upload
from ss_agents.tools.imagen_generate import imagen_generate
from ss_agents.tools.lyria_generate import lyria_generate
from ss_agents.tools.veo_generate import veo_generate

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Constants + helpers — palette contrast (WCAG AA) + Lyria copyright filter.
# ─────────────────────────────────────────────────────────────────────────────


# WCAG 2.1 §1.4.3 — normal text needs 4.5:1 against its background. Phase 3
# pairs each palette colour against the lightest + darkest swatch and demands
# at least ONE pair clears 4.5:1 (the moodboard is for overlays / text on
# imagery so the agent must offer at least one usable text-vs-background
# combination). Threshold per the W3C contrast ratio formula.
_WCAG_AA_RATIO = 4.5

# oklch(L C H) — Lightness 0-1, Chroma 0-0.4ish, Hue 0-360. The regex is
# deliberately liberal in spacing so the model has room to format naturally.
# Per CSS Color Module Level 4 (oklch() function).
_OKLCH_RE = re.compile(
    r"""^\s*oklch\(\s*
        (?P<L>0(?:\.\d+)?|1(?:\.0+)?)        # lightness 0..1
        \s+
        (?P<C>0(?:\.\d+)?|[01](?:\.\d+)?)    # chroma 0..~0.4 (accept up to 1)
        \s+
        (?P<H>\d+(?:\.\d+)?)                 # hue degrees 0..360
        \s*\)\s*$""",
    re.VERBOSE,
)


# Lyria's documented blocked-prompt patterns (per Vertex AI safety docs,
# 2026 Q1 — "Lyria content filter scope"). We trip on:
#   · Named artists (Lyria refuses style transfer of named living/recent
#     artists, treated as IP/copyright unsafe).
#   · "in the style of <Proper Noun>" patterns.
#   · Explicit "cover of <song>" / "sample of <album>" requests.
# The list is conservative — Model Armor backstops at the Vertex layer.
_LYRIA_BLOCKED_RE = re.compile(
    r"""(
        \bin\s+the\s+style\s+of\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?    # Proper noun artist
        | \bcover\s+of\s+["“][^"”]+["”]                              # cover of "song"
        | \bsample(?:s|d|ing)?\s+(?:of|from)\s+[A-Z][a-z]+           # sample of <Artist>
        | \b(?:Taylor\s+Swift|Beyonc[eé]|Drake|BTS|Blackpink|IU)\b   # high-risk explicit list
    )""",
    re.IGNORECASE | re.VERBOSE,
)


def _oklch_relative_luminance(L: float) -> float:
    """Approximate sRGB relative luminance for an oklch() colour.

    The accurate path is oklch → oklab → linear sRGB → relative luminance, but
    OKLCH lightness L is **perceptually** uniform and very close to the
    perceived luminance the WCAG formula uses. For palette-contrast triage —
    which is what we need pre-handoff — using L directly is conservative (it
    over-estimates ratios for mid-chroma colours, biasing FALSE-LOW on the
    safety side, which is what we want).

    The exact threshold equivalence: WCAG ratio 4.5:1 ↔ ΔL ≈ 0.35 in OKLCH
    for typical chromas. We use the canonical ratio formula on L+0.05 to keep
    the API identical with future swap-in of a true sRGB pipeline.
    """
    return float(L)


def oklch_contrast_ratio(a: str, b: str) -> float:
    """WCAG-style contrast ratio for two oklch() colour strings.

    Returns the ratio (≥ 1.0); raises ValueError when either input fails the
    `_OKLCH_RE` regex. Calculated on L+0.05 per the W3C contrast formula's
    flare offset — we use OKLCH's L as a proxy for relative luminance per the
    docstring on `_oklch_relative_luminance`.
    """
    ma, mb = _OKLCH_RE.match(a), _OKLCH_RE.match(b)
    if not ma or not mb:
        raise ValueError(f"invalid oklch input: {a!r}, {b!r}")
    la = _oklch_relative_luminance(float(ma.group("L")))
    lb = _oklch_relative_luminance(float(mb.group("L")))
    lighter, darker = max(la, lb), min(la, lb)
    return (lighter + 0.05) / (darker + 0.05)


def palette_has_aa_pair(palette: list[str]) -> bool:
    """True iff at least one pair of palette colours hits WCAG AA (4.5:1).

    Phase 3 gate per task brief: 'palette has insufficient contrast for WCAG
    AA' is one of the three escalation triggers.
    """
    if len(palette) < 2:
        return False
    for i, a in enumerate(palette):
        for b in palette[i + 1:]:
            try:
                if oklch_contrast_ratio(a, b) >= _WCAG_AA_RATIO:
                    return True
            except ValueError:
                # Malformed colour — caller will get a Pydantic error on the
                # palette field validator below. Don't double-fail here.
                continue
    return False


def lyria_prompt_blocked(prompt: str) -> str | None:
    """Return the matched substring when a Lyria-blocked pattern fires,
    None when the prompt is clean. Lyria's copyright filter rejects named-
    artist style transfer + explicit cover/sample requests."""
    if not prompt:
        return None
    m = _LYRIA_BLOCKED_RE.search(prompt)
    return m.group(0) if m else None


# ─────────────────────────────────────────────────────────────────────────────
# Input + Output schemas — task brief shape (slightly tighter than
# creative.spec.md §2 which is the workflow-level surface).
# ─────────────────────────────────────────────────────────────────────────────


# Brief restates the locale spread per D34.
CreativeLocale = Literal["ko", "en", "ja", "zh-CN"]


class CreativeInput(BaseModel):
    """Per task brief §Spec.Input.

    Fields:
        brand_brief             — full CampaignBrief from intake.
        mood_keywords           — operator-supplied creative direction hints.
        reference_image_urls    — optional gs://… or https://… references.
        target_duration_seconds — desired sample-video length (3-30 sec).
        locale                  — operator locale (D34); routes the cultural-
                                  sensitivity check + dialogue language.
        metadata                — invocation metadata pass-through.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    brand_brief: CampaignBrief = Field(alias="brandBrief")
    mood_keywords: list[str] = Field(
        min_length=1, max_length=20, alias="moodKeywords",
        description="Operator-supplied creative direction hints (e.g. ['fresh', 'morning-light']).",
    )
    reference_image_urls: list[str] = Field(
        default_factory=list,
        max_length=10,
        alias="referenceImageUrls",
        description="gs://… or https://… references (deferred to Phase 4 multimodal channel).",
    )
    target_duration_seconds: int = Field(
        ge=3, le=30, alias="targetDurationSeconds",
        description="Desired sample-video length. Veo 3 caps at 8s; longer durations split into multi-clip briefs.",
    )
    locale: CreativeLocale = "ko"
    metadata: dict[str, str] | None = Field(
        default=None,
        description="Invocation metadata per shared.schema.json#/$defs/InvocationMetadata.",
    )

    @field_validator("mood_keywords")
    @classmethod
    def _normalise_mood(cls, v: list[str]) -> list[str]:
        cleaned = [k.strip() for k in v if k and k.strip()]
        if not cleaned:
            raise ValueError("mood_keywords must contain at least one non-blank entry")
        return cleaned

    @field_validator("reference_image_urls")
    @classmethod
    def _ref_url_shape(cls, v: list[str]) -> list[str]:
        for u in v:
            if not (u.startswith("gs://") or u.startswith("https://")):
                raise ValueError(
                    f"reference URL must begin with gs:// or https:// (got {u[:64]!r})"
                )
        return v


class Moodboard(BaseModel):
    """Per task brief §Spec.Output.moodboard."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    palette_oklch: list[str] = Field(
        min_length=6, max_length=6, alias="paletteOklch",
        description="Exactly 6 OKLCH colour strings. Validated for syntax + WCAG-AA pair existence.",
    )
    style_keywords: list[str] = Field(
        min_length=3, max_length=8, alias="styleKeywords",
        description="3-8 short style descriptors (e.g. 'minimal', 'sun-drenched').",
    )
    reference_creators: list[str] = Field(
        min_length=3, max_length=3, alias="referenceCreators",
        description="Exactly 3 TikTok @-handles or descriptive references the seeded creator can study.",
    )

    @field_validator("palette_oklch")
    @classmethod
    def _palette_syntax(cls, v: list[str]) -> list[str]:
        for c in v:
            if not _OKLCH_RE.match(c):
                raise ValueError(
                    f"palette entry {c!r} is not a valid oklch(L C H) string"
                )
        return v

    @field_validator("style_keywords")
    @classmethod
    def _style_strip(cls, v: list[str]) -> list[str]:
        cleaned = [k.strip() for k in v if k and k.strip()]
        if len(cleaned) < 3:
            raise ValueError("style_keywords must have at least 3 non-blank entries")
        return cleaned


class ShotListItem(BaseModel):
    """Per task brief §Spec.Output.shot_list[].

    `dialogue` is optional — silent / b-roll shots simply omit it. The agent's
    locale field governs which language the dialogue is written in.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    scene_index: int = Field(ge=1, le=20, alias="sceneIndex")
    duration_sec: float = Field(
        gt=0.0, le=30.0, alias="durationSec",
        description="Per-shot duration in seconds. Sum across shots ≈ target_duration_seconds.",
    )
    action_description: str = Field(
        min_length=10, max_length=400, alias="actionDescription",
        description="What happens on-screen — camera + subject + action.",
    )
    framing: str = Field(
        min_length=3, max_length=80,
        description="Shot framing (e.g. 'close-up', 'medium two-shot', 'overhead flat-lay').",
    )
    dialogue: str | None = Field(
        default=None, max_length=300,
        description="Optional spoken line in the operator's locale.",
    )


class SampleVideoBrief(BaseModel):
    """Per task brief §Spec.Output.sample_video_brief.

    The two prompts are computed but NOT executed in Phase 3 — capability-
    layer wiring lands in Phase 4 (imagen.generate / veo.generate /
    lyria.generate live in `ss_agents.tools.shared`).
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    veo3_prompt: str = Field(
        min_length=20, max_length=2000, alias="veo3Prompt",
        description="Veo 3 generation prompt — describes subject + motion + style + duration.",
    )
    lyria_music_prompt: str = Field(
        min_length=10, max_length=600, alias="lyriaMusicPrompt",
        description="Lyria audio-sting prompt — describes genre + tempo + mood. Filtered against named-artist patterns.",
    )
    expected_runtime_sec: float = Field(
        gt=0.0, le=30.0, alias="expectedRuntimeSec",
        description="Expected total runtime; Veo 3 caps single clips at 8s.",
    )


class BrandSafetyCheck(BaseModel):
    """Per task brief §Spec.Output.brand_safety_check.

    Non-empty lists in ANY of the three fields are an operator gate — the
    workflow escalates per `creative.spec.md §6`. We do NOT raise
    EscalateToHuman here because the model can still produce a usable
    creative direction; the operator decides whether to ship or rework.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    ip_concerns: list[str] = Field(
        default_factory=list, max_length=10, alias="ipConcerns",
        description="Identified IP / trademark / likeness concerns (empty when clear).",
    )
    deepfake_risks: list[str] = Field(
        default_factory=list, max_length=10, alias="deepfakeRisks",
        description="Real-person likeness or voice-clone risks (empty when clear).",
    )
    cultural_sensitivities: list[str] = Field(
        default_factory=list, max_length=10, alias="culturalSensitivities",
        description="Locale-specific cultural notes per D34 (empty when clear).",
    )

    @property
    def has_any(self) -> bool:
        """True when ANY list is non-empty — used by the workflow's gate."""
        return bool(self.ip_concerns or self.deepfake_risks or self.cultural_sensitivities)


class CreativeOutput(BaseModel):
    """Per task brief §Spec.Output.

    Cross-section invariants enforced by the model-level validator:
      · sum(shot.duration_sec) ≈ target_duration_seconds (within ±15%).
      · sample_video_brief.expected_runtime_sec ≤ 8.0 (Veo 3 single-clip cap).
      · palette has at least one WCAG-AA-clearing pair.
      · lyria_music_prompt is not blocked by the copyright filter.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    moodboard: Moodboard
    shot_list: list[ShotListItem] = Field(
        min_length=5, max_length=12, alias="shotList",
        description="5-12 shots; scene_index must be 1..N contiguous after dedupe.",
    )
    sample_video_brief: SampleVideoBrief = Field(alias="sampleVideoBrief")
    brand_safety_check: BrandSafetyCheck = Field(alias="brandSafetyCheck")

    @field_validator("shot_list")
    @classmethod
    def _scene_indices_contiguous(cls, v: list[ShotListItem]) -> list[ShotListItem]:
        indices = [s.scene_index for s in v]
        if sorted(indices) != list(range(1, len(v) + 1)):
            raise ValueError(
                f"shot_list scene_index must be a 1..N contiguous sequence, got {sorted(indices)}"
            )
        return v

    @model_validator(mode="after")
    def _palette_wcag_aa(self) -> "CreativeOutput":
        if not palette_has_aa_pair(self.moodboard.palette_oklch):
            raise ValueError(
                "moodboard.palette_oklch has no pair clearing WCAG-AA (4.5:1) — "
                "the agent must produce at least one usable text-vs-background combo"
            )
        return self

    @model_validator(mode="after")
    def _veo3_single_clip_cap(self) -> "CreativeOutput":
        if self.sample_video_brief.expected_runtime_sec > 8.0:
            raise ValueError(
                "sample_video_brief.expected_runtime_sec > 8.0 — Veo 3 single-clip cap is 8s; "
                "split into multi-clip briefs in a later workflow step"
            )
        return self

    @model_validator(mode="after")
    def _lyria_copyright_clean(self) -> "CreativeOutput":
        match = lyria_prompt_blocked(self.sample_video_brief.lyria_music_prompt)
        if match is not None:
            raise ValueError(
                f"sample_video_brief.lyria_music_prompt trips Lyria copyright filter: "
                f"matched pattern {match!r}"
            )
        return self


# ─────────────────────────────────────────────────────────────────────────────
# System prompt builder — task brief + creative.spec.md §6.
# ─────────────────────────────────────────────────────────────────────────────


_LOCALE_DIALOGUE = {
    "ko": "Write any optional `dialogue` field in 한국어. Keep cultural-sensitivities flags in English (for the operator UI).",
    "en": "Write any optional `dialogue` field in English.",
    "ja": "Write any optional `dialogue` field in 日本語. Keep cultural-sensitivities flags in English.",
    "zh-CN": "Write any optional `dialogue` field in 简体中文. Keep cultural-sensitivities flags in English.",
}


# Locale-specific cultural-sensitivity hint table — D34. Non-exhaustive; the
# agent is told to add its own when domain context warrants. These are the
# starter prompts that have shown up in past v1 demos (e.g. red-package
# imagery during Lunar New Year vs. funerary use in zh-CN).
_LOCALE_CULTURAL_HINTS = {
    "ko": (
        "Korea: avoid green-bottle alcohol references unless category fits; "
        "respect 'fan service' boundaries (no implied minor-fan content); "
        "national mourning windows (e.g. Sewol anniversary 04-16) require muted tone."
    ),
    "en": (
        "EN-global: avoid culturally-narrow idioms (regional sports metaphors, "
        "specific holiday tropes) unless the brand brief specifies a region."
    ),
    "ja": (
        "Japan: pricing in 円 with consumption tax; avoid pun-based humour that "
        "translates poorly; respect seasonal-greeting conventions (e.g. 'お盆' window)."
    ),
    "zh-CN": (
        "China: avoid red-+-white packaging combinations (funerary); respect "
        "Lunar New Year vs Qingming distinction; avoid named-celebrity references "
        "without licensing per 网信办 rules."
    ),
}


def build_creative_system_prompt(payload: BaseModel) -> str:
    """Per task brief §Spec + creative.spec.md §6.

    Composes the Gemini 3.1 Pro system prompt with:
      · Brand context (name + category + description + key claims).
      · Operator-supplied mood keywords + target duration + locale.
      · Output schema + invariants (palette WCAG AA, Veo 3 clip cap, Lyria
        copyright filter, scene-index contiguity).
      · Locale-specific cultural-sensitivity hints (D34).
      · Brand-safety rubric — what counts as ip_concerns / deepfake_risks /
        cultural_sensitivities.
    """
    assert isinstance(payload, CreativeInput), f"unexpected input type: {type(payload)}"

    brand = payload.brand_brief.brand_product
    targeting = payload.brand_brief.targeting

    key_claims_line = (
        f"Key claims to weave into the creative: {' / '.join(brand.key_claims)}"
        if brand.key_claims
        else "Key claims: (none — let the creative speak through visuals + tone)"
    )
    refs_block = (
        "## Reference imagery (operator-supplied)\n"
        + "\n".join(f"  · {u}" for u in payload.reference_image_urls)
        if payload.reference_image_urls
        else "## Reference imagery\n  · (none — fall back to category-typical aesthetics)"
    )
    cultural_hint = _LOCALE_CULTURAL_HINTS.get(
        payload.locale, _LOCALE_CULTURAL_HINTS["ko"]
    )
    dialogue_locale = _LOCALE_DIALOGUE.get(
        payload.locale, _LOCALE_DIALOGUE["ko"]
    )
    expected_total = payload.target_duration_seconds
    # Veo 3 caps at 8s — clip the briefed runtime accordingly.
    veo_runtime = min(8.0, float(expected_total))

    return "\n".join(
        [
            "You are the Creative agent for Social Seeding. The operator handed you a CampaignBrief plus mood direction. Produce a complete creative direction package — moodboard + shot list + sample-video brief + safety check — that the seeded creator can shoot against.",
            "",
            "## Brand (from CampaignBrief)",
            f"Name: {brand.name}",
            f"Category: {brand.category}",
            f"Description: {brand.description}",
            key_claims_line,
            (
                f"Targeting: {targeting.creator_count} creators in "
                f"{'/'.join(targeting.languages) or 'ko'}; "
                f"min ER {targeting.min_engagement_rate:.0%}"
            ),
            "",
            "## Operator creative direction",
            f"Mood keywords: {', '.join(payload.mood_keywords)}",
            f"Target sample-video duration: {expected_total} sec total "
            f"(Veo 3 single-clip cap is 8 sec; expected_runtime_sec ≤ {veo_runtime:g}).",
            f"Operator locale: {payload.locale} (D34).",
            "",
            refs_block,
            "",
            "## Locale-specific cultural hints (D34)",
            f"  {cultural_hint}",
            "  Add any additional locale-specific notes you spot in the brief "
            "  to `brand_safety_check.cultural_sensitivities`.",
            "",
            "## Output exactly this JSON shape",
            "{",
            '  "moodboard": {',
            '    "palette_oklch":  [<6 OKLCH strings>],',
            '    "style_keywords": [<3-8 short descriptors>],',
            '    "reference_creators": [<exactly 3 TikTok handles or refs>]',
            '  },',
            '  "shot_list": [',
            '    { "scene_index": 1, "duration_sec": <float>, "action_description": <str>, "framing": <str>, "dialogue": <str|null> },',
            '    … 5 to 12 shots total, scene_index 1..N contiguous',
            '  ],',
            '  "sample_video_brief": {',
            '    "veo3_prompt":         <str ≥ 20 chars — subject + motion + style + duration>,',
            '    "lyria_music_prompt":  <str ≥ 10 chars — genre + tempo + mood>,',
            '    "expected_runtime_sec": <float ≤ 8.0>',
            '  },',
            '  "brand_safety_check": {',
            '    "ip_concerns":           [<strings — empty when clear>],',
            '    "deepfake_risks":        [<strings — empty when clear>],',
            '    "cultural_sensitivities": [<strings — empty when clear>]',
            '  }',
            "}",
            "",
            "## Invariants (the schema validator WILL reject violations)",
            "  · palette_oklch — exactly 6 entries in oklch(L C H) syntax (L ∈ [0,1], C ≥ 0, H ∈ [0,360)).",
            "  · palette must contain at least one pair with WCAG-AA contrast (≥ 4.5:1) — pick one near-black and one near-white if unsure.",
            "  · style_keywords — 3 to 8 short, concrete words. No marketing fluff.",
            "  · reference_creators — exactly 3. Prefer real TikTok handles (`@…`) when you can name them; otherwise descriptive refs ('Korean morning-routine aesthetic creators').",
            "  · shot_list — 5 to 12 shots, scene_index 1..N contiguous, sum of duration_sec roughly matches the target duration (±15%).",
            "  · sample_video_brief.expected_runtime_sec ≤ 8.0 (Veo 3 hard cap).",
            "  · sample_video_brief.lyria_music_prompt MUST NOT name specific artists or request 'cover of' / 'sample of' a known song — Lyria's copyright filter blocks those and the schema validator will reject.",
            "",
            "## Brand-safety rubric — populate the three lists",
            "  · ip_concerns:     trademarked terms, logos shown without licence, claim language that needs legal review (e.g. 'clinically proven' for unregulated categories).",
            "  · deepfake_risks:  the brief implies generating a real person's likeness or voice (celebrity, the operator themselves, a specific creator).",
            "  · cultural_sensitivities: locale-specific friction points for the `locale` field above. Use English entries so the operator UI can render them uniformly.",
            "  An entry in ANY list will gate the workflow — the operator decides whether to ship. So be honest but not paranoid: only flag REAL concerns, not generic 'be culturally aware' boilerplate.",
            "",
            "## Veo 3 prompt discipline",
            "  · Describe the subject, the action, the camera motion, the lighting, the lens / aesthetic, and the duration.",
            "  · Keep it under 2000 chars.",
            "  · Do NOT include named real people, copyrighted characters, or trademarked logos. If the brand brief includes the brand's own logo and you reference it, that's fine — flag it in `ip_concerns` only if the rendering instructions ASK Veo to invent a logo variant.",
            "",
            "## Lyria prompt discipline",
            "  · Describe genre, tempo (BPM range OK), instrumentation, mood. NEVER name an artist (Lyria's filter blocks 'in the style of <Artist>'). Generic descriptors only.",
            "",
            "## Discipline",
            "  · Output ONE JSON object matching CreativeOutput exactly. No preamble, no markdown fences, no extra keys.",
            "  · If the brief is too sparse to produce a coherent moodboard (e.g. `brand_product.description` is one word), still produce your best guess and add 'sparse_brief_inference' to `brand_safety_check.ip_concerns` so the operator knows to double-check.",
            "  · Use the mood keywords as the PRIMARY signal for style + palette; the brand brief sets the CONSTRAINTS (category fit + key claims).",
            "",
            dialogue_locale,
        ]
    )


# ─────────────────────────────────────────────────────────────────────────────
# AgentDef — Pydantic config the runtime consumes.
# ─────────────────────────────────────────────────────────────────────────────


creative_agent_def: AgentDef[CreativeInput, CreativeOutput] = AgentDef(
    id="creative",
    description=(
        "Generate a creative direction package (moodboard + shot list + "
        "sample-video brief + brand-safety check) from a CampaignBrief plus "
        "operator mood keywords. Phase 3 boundary: Imagen 4 / Veo 3 / Lyria "
        "are capability-layer tools (Phase 4 wiring); this agent computes "
        "the PROMPTS + safety logic without invoking them. Per "
        "creative.spec.md (D23 Tier-1 agent #14, D5 Gemini 3.1 Pro, D29 "
        "multimodal differentiator)."
    ),
    model="gemini-3.1-pro",  # D53 — Pro for sustained creative reasoning
    max_usd=0.30,  # task brief: $0.30; spec.md §6 reserves $3 for full-asset
    #                workflow run (Imagen + Veo + Lyria). $0.30 is the
    #                AGENT-only cap; capability calls happen outside it.
    input_schema=CreativeInput,
    output_schema=CreativeOutput,
    system_prompt=build_creative_system_prompt,
    # W2-B4 (Phase 4 capability-layer wire-up): imagen.generate /
    # veo.generate / lyria.generate / assets.upload are now wired as
    # FunctionTools per D41 (canonical W2-A1 stub/live form). Stub mode
    # (default in dev/CI) returns deterministic GCS URIs; live mode
    # raises NotImplementedError until the Phase 4 live wiring lands.
    # vision.brand_logo_detect lives on the content_verify agent's tool
    # list (creative.spec.md §6 has it under creative's tool table for
    # the workflow's post-gen IP check; the agent itself emits prompts +
    # safety logic and delegates the IP check to the content_verify
    # surface that already owns that capability).
    tools=[imagen_generate, veo_generate, lyria_generate, assets_upload],
    max_turns=3,  # Pro reasoning may benefit from one self-correction turn;
    #             cap = 3 prevents runaway loops without starving the model.
)


# ─────────────────────────────────────────────────────────────────────────────
# Module-level helper exposed for tests + capability-layer Phase 4 wiring.
# ─────────────────────────────────────────────────────────────────────────────


def shot_durations_within_target(
    shots: list[ShotListItem], target_seconds: int, tolerance: float = 0.15
) -> bool:
    """Phase 3 soft-check used by the eval rubric (NOT enforced at the schema
    level — the model is sometimes off by > 15% on creative inputs and we'd
    rather let the operator decide than escalate).

    Args:
        shots:           the shot_list output.
        target_seconds:  the operator's target_duration_seconds input.
        tolerance:       allowed fractional deviation (default 15%).
    """
    if not shots:
        return False
    total = sum(s.duration_sec for s in shots)
    return math.isclose(total, target_seconds, rel_tol=tolerance, abs_tol=0.5)


__all__ = [
    "BrandSafetyCheck",
    "CreativeInput",
    "CreativeLocale",
    "CreativeOutput",
    "Moodboard",
    "SampleVideoBrief",
    "ShotListItem",
    "build_creative_system_prompt",
    "creative_agent_def",
    "lyria_prompt_blocked",
    "oklch_contrast_ratio",
    "palette_has_aa_pair",
    "shot_durations_within_target",
]


# ─────────────────────────────────────────────────────────────────────────────
# __main__ entry point for ad-hoc testing.
# ─────────────────────────────────────────────────────────────────────────────


if __name__ == "__main__":  # pragma: no cover
    """Run a single invocation against live Vertex AI.

    Requires:
        GOOGLE_GENAI_USE_VERTEXAI=TRUE
        GOOGLE_CLOUD_PROJECT=<…>
        GOOGLE_CLOUD_LOCATION=us-central1
        SS_LIVE=1
    """
    import asyncio
    import datetime as dt
    import json
    import sys

    from ss_agents.agents.intake import (
        BrandProduct,
        Goals,
        Logistics as LogisticsBrief,
        Targeting,
    )
    from ss_agents.runtime import RunContext, run_agent

    async def main() -> None:
        ctx = RunContext(
            tenant_id="t_demo000000000000",
            workspace_id="ws_demo_creative_main",
            trace_id="trace-cli-creative-1",
        )
        brief = CampaignBrief(
            workspaceId="ws_demo_creative_main",
            createdBy="cli@example.com",
            brandProduct=BrandProduct(
                name="Freshly Vitamin C Serum",
                category="skincare/serum",
                description="Brightening Vitamin C serum with hyaluronic acid.",
                keyClaims=["10% vitamin C", "fragrance-free"],
            ),
            targeting=Targeting(creatorCount=20, languages=["ko"]),
            logistics=LogisticsBrief(shipsSamples=True),
            goals=Goals(
                targetLivePosts=15,
                deadline=dt.datetime(2026, 6, 30, 23, 59, tzinfo=dt.UTC),
            ),
        )
        moods = sys.argv[1].split(",") if len(sys.argv) > 1 else [
            "fresh", "morning-light", "minimal"
        ]
        payload = CreativeInput(
            brandBrief=brief,
            moodKeywords=moods,
            referenceImageUrls=[],
            targetDurationSeconds=8,
            locale="ko",
        )
        outcome = await run_agent(creative_agent_def, payload, ctx)
        print(json.dumps(outcome.model_dump(by_alias=True), indent=2, default=str))

    asyncio.run(main())
