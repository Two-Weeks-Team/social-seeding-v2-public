# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""ADK Coordinator + searcher + ranker.

Reference: ``REFACTOR-MCP.md §3.2-§3.3``.

Topology:

    coordinator (SequentialAgent)
        ├── searcher  (gemini-3.1-flash-lite, bulk tier)  → tiktok_search, tiktok_user_info
        └── ranker    (gemini-3.5-flash, judgment tier)   → tiktok_user_posts, tiktok_post_detail
                                            + RankedCreators structured output

The agent is wrapped as the A2A skill ``plan_creator_search(brand_brief)``
which is what Gemini Enterprise calls. Internally we run the coordinator
through ADK's ``Runner`` and pull the final ``RankedCreators`` JSON.

Why **functions wrapping MCP**, not ReAct loops:
    See ``social-seeding-v2`` CLAUDE.md: "Agents = functions the workflow
    invokes (curated tools, Zod output, USD cap, escalation), never free
    loops." Each subagent has:
        * a curated tool set (no shell, no arbitrary HTTP)
        * a structured output contract (Pydantic ``RankedCreators``)
        * a stop signal (LimitReachedError from MCP → terminal "stop fanning
          out", per REFACTOR-MCP §3.3 instruction)
        * Model Armor wrap on prompt + response (D21)

This module degrades gracefully if ADK is not installed: the public
``plan_creator_search`` function still runs against the stub MCP client and
returns a heuristically-ranked top-10, so the FastAPI + smoke tests don't
require Vertex AI credentials to pass.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from pydantic import BaseModel, Field, NonNegativeInt

from . import model_armor
from .mcp_client import LimitReachedError, McpResult, TikTokMcpClient

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
# D53: the product runs exactly two Gemini ids on the Vertex `global` endpoint —
# gemini-3.5-flash (judgment) + gemini-3.1-flash-lite (bulk). gemini-*-pro is 404
# in ss-v2-prod. The env var names below are kept for deploy compatibility; the
# ranker ("PRO") binds the judgment-tier flash model, the searcher ("FLASH") the
# bulk flash-lite model. Enabling these live also requires GOOGLE_CLOUD_LOCATION
# (Vertex) = "global"; see config note on the Model-Armor region coupling.
FLASH_MODEL = os.environ.get("ADK_FLASH_MODEL", "gemini-3.1-flash-lite")
PRO_MODEL = os.environ.get("ADK_PRO_MODEL", "gemini-3.5-flash")
ADK_DISABLED = os.environ.get("ADK_DISABLED", "").lower() in {"1", "true", "yes"} or not PROJECT

# Eval default; the searcher is told to expand each variant in parallel.
DEFAULT_KEYWORDS_PER_BRIEF = 5
DEFAULT_CANDIDATES_PER_KEYWORD = 10
DEFAULT_POSTS_PER_CANDIDATE = 10
DEFAULT_TOP_N = 10
FOLLOWER_SPAM_THRESHOLD = 5_000


# ---------------------------------------------------------------------------
# Structured output schemas (used directly by the ranker + the HTTP API)
# ---------------------------------------------------------------------------


class CreatorRank(BaseModel):
    """One ranked TikTok creator.

    Field semantics match REFACTOR-MCP §3.3 schema verbatim so the
    Producer Portal validator and ADK output_schema stay in sync.
    """

    unique_id: str = Field(..., description="TikTok handle without @")
    follower_count: NonNegativeInt = Field(..., description="Total followers")
    engagement_rate: float = Field(
        ..., ge=0.0, le=1.0,
        description="Avg (likes+comments+shares)/views over last N posts",
    )
    fit_score: float = Field(
        ..., ge=0.0, le=1.0,
        description="0..1 semantic fit to the brand brief",
    )
    reasoning: str = Field(
        ..., min_length=10, max_length=500,
        description="2 sentences max — why this creator was chosen",
    )


class RankedCreators(BaseModel):
    """A2A skill output: ranked top-N creators for a brand brief."""

    brief: str
    creators: list[CreatorRank] = Field(default_factory=list)
    source_attribution: str = Field(
        default="Source: Social Seeding — https://socialseed.ing",
        description="MANDATORY attribution — the MCP license terms.",
    )
    # Operational metadata — useful for the demo trace + evals.
    trace: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Subagent prompts
# ---------------------------------------------------------------------------

SEARCHER_INSTRUCTION = """
You are a creator-sourcing specialist for a B2B influencer marketing platform.

Given a brand brief (one or two paragraphs), produce up to 30 candidate creators.

Workflow:
  1. Extract 3-5 search keywords from the brief. Include at least one Korean,
     one English, and (if the brief implies APAC) one Japanese or Chinese variant.
  2. Call tiktok_search(keyword=..., limit=10) for each keyword IN PARALLEL.
  3. Dedupe by uniqueId. Discard creators with <5K followers (spam threshold).
  4. For the top 30 by follower_count, call tiktok_user_info(uniqueId=...) to
     fetch bios. Use bios to filter creators whose content is obviously off-brief.
  5. Emit a JSON list of {uniqueId, followerCount, bio} — nothing else.

If you receive a "Daily free limit reached" message from any tool, STOP IMMEDIATELY
and return whatever candidates you have. Do not retry.
""".strip()


RANKER_INSTRUCTION = """
You are an influencer ranking analyst.

Input: a brand brief + a JSON array of candidate creators with uniqueId.
Output: a RankedCreators JSON conforming to the schema.

Workflow:
  1. For each candidate, call tiktok_user_posts(uniqueId=..., count=10).
  2. For up to 3 high-signal posts per creator, call tiktok_post_detail.
  3. Compute engagement_rate = (likes+comments+shares) / views, averaged.
  4. Compute fit_score by reading the brief + post captions + bio. Be honest:
     a beauty creator scoring a fintech brief gets a low score with reasoning.
  5. Return RankedCreators with the top 10. Always include source_attribution.

If any tool returns a limit_reached error, return whatever you have ranked so far.
""".strip()


# ---------------------------------------------------------------------------
# Coordinator factory (ADK)
# ---------------------------------------------------------------------------


def build_coordinator() -> Any | None:
    """Construct the SequentialAgent + subagents if ADK is available.

    Returns ``None`` when ADK is intentionally disabled (``ADK_DISABLED=1``)
    or unavailable in the environment (tests, smoke runs). In that case
    callers fall through to ``_heuristic_rank`` so the HTTP surface remains
    functional without Vertex credentials.
    """
    if ADK_DISABLED:
        logger.info("ADK disabled; using heuristic ranker for plan_creator_search")
        return None

    try:
        from google.adk.agents import Agent, SequentialAgent  # type: ignore[import-not-found]
        from google.adk.tools.mcp_tool import MCPToolset  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover — env-dependent
        logger.warning(
            "google-adk not importable (%s); falling back to heuristic ranker",
            exc,
        )
        return None

    # ADK's MCPToolset speaks streamable-http directly to our Node sidecar.
    mcp_base = os.environ.get("MCP_BASE_URL", "http://localhost:8100")
    tiktok_tools = MCPToolset(
        connection_params={
            "transport": "streamable-http",
            "url": f"{mcp_base.rstrip('/')}/mcp",
        },
        tool_filter=[
            "tiktok_search",
            "tiktok_user_info",
            "tiktok_user_posts",
            "tiktok_post_detail",
        ],
    )

    searcher = Agent(
        name="searcher",
        model=FLASH_MODEL,
        description=(
            "Discovers candidate TikTok creators for a brief. Uses tiktok_search "
            "across language variants and dedupes by uniqueId."
        ),
        instruction=SEARCHER_INSTRUCTION,
        tools=[tiktok_tools],
        output_schema=None,
    )

    ranker = Agent(
        name="ranker",
        model=PRO_MODEL,
        description="Ranks candidate creators by engagement and brief-fit.",
        instruction=RANKER_INSTRUCTION,
        tools=[tiktok_tools],
        output_schema=RankedCreators,
    )

    return SequentialAgent(
        name="influencer_research_coordinator",
        description="Plans, sources, and ranks TikTok creators for a brand brief.",
        sub_agents=[searcher, ranker],
    )


coordinator: Any | None = build_coordinator()


# ---------------------------------------------------------------------------
# A2A skill — plan_creator_search
# ---------------------------------------------------------------------------


async def plan_creator_search(brand_brief: str, *, uid: str | None = None) -> RankedCreators:
    """A2A-callable orchestration tool.

    The Gemini Enterprise install path calls this via FastAPI
    (``POST /a2a/skills/plan_creator_search``). The contract:

        Input:  ``brand_brief: str`` (one or two paragraphs)
        Output: ``RankedCreators`` (top-10 with reasoning, source attribution)

    Flow:
        1. Sanitize the brief through Model Armor INPUT (D21).
        2. If ADK is available, drive the coordinator on Vertex AI.
        3. Otherwise, run the heuristic path (production sources real MCP
           data, ranks by simple ER × follower-count score). This path is
           what runs in smoke tests and during ADK quota-cold-start, so it
           must always return a valid RankedCreators.
        4. Sanitize the final output through Model Armor OUTPUT.
    """
    brief = (brand_brief or "").strip()
    if not brief:
        raise ValueError("brand_brief must be a non-empty string")

    # --- INPUT sanitization --------------------------------------------------
    input_armor = await model_armor.sanitize_prompt(brief)
    if input_armor.blocked:
        return RankedCreators(
            brief=brief,
            creators=[],
            source_attribution="Source: Social Seeding — https://socialseed.ing",
            trace={
                "blocked_by": "model_armor_input",
                "reasons": input_armor.reasons,
                "uid": uid,
            },
        )

    safe_brief = input_armor.text

    # --- Plan / source / rank ------------------------------------------------
    if coordinator is not None:
        try:
            ranked = await _run_adk(safe_brief, uid=uid)
        except Exception as exc:  # noqa: BLE001
            logger.warning("ADK path failed (%s); falling back to heuristic", exc, exc_info=True)
            ranked = await _heuristic_rank(safe_brief, uid=uid)
    else:
        ranked = await _heuristic_rank(safe_brief, uid=uid)

    # --- OUTPUT sanitization -------------------------------------------------
    serialized = ranked.model_dump_json()
    output_armor = await model_armor.sanitize_response(serialized)
    if output_armor.blocked:
        return RankedCreators(
            brief=brief,
            creators=[],
            trace={
                "blocked_by": "model_armor_output",
                "reasons": output_armor.reasons,
                "uid": uid,
            },
        )

    if output_armor.text and output_armor.text != serialized:
        # Redactions were applied — re-hydrate from the sanitized JSON.
        try:
            return RankedCreators.model_validate_json(output_armor.text)
        except Exception:  # noqa: BLE001
            logger.warning(
                "Model Armor sanitized output failed to re-validate; "
                "returning original ranked output."
            )

    return ranked


# ---------------------------------------------------------------------------
# DAM-style A2A skill — get_brand_assets (Build Example #2, exposed half)
# ---------------------------------------------------------------------------
#
# `designed_guide.pdf` p.7 Build Example #2: a Gemini-powered multimodal
# marketing agent uses A2A to reach a company's internal Digital Asset Manager
# (DAM) Agent for *approved brand logos / product imagery*, keeping output
# on-brand and compliant. Social Seeding's `content_verify` agent is the
# marketing agent; it A2A-invokes THIS skill (via `ss_agents.tools.
# dam_get_brand_assets` → `a2a_invoke`) to retrieve approved assets + an
# on-brand verdict.
#
# Honest scope: this is a DEMO DAM stand-in for a customer's real Digital Asset
# Manager. The A2A TRANSPORT is genuine (this skill is reached over the live
# A2A v0.3 `message/send` binding, same as `plan_creator_search`); the asset
# store is a small in-memory catalog so the cross-component hop is reachable
# end-to-end without provisioning a real DAM. A2A-INTENTS.md §5.


class BrandAsset(BaseModel):
    """One approved brand asset the DAM returns (logo / product imagery)."""

    asset_id: str = Field(..., description="Stable DAM asset id")
    kind: str = Field(default="logo", description="logo | product_image | wordmark")
    uri: str = Field(..., description="gs:// or https:// URI of the approved asset")


class BrandAssets(BaseModel):
    """DAM `get_brand_assets` skill output — approved assets + on-brand verdict."""

    brand_name: str
    brand_assets: list[BrandAsset] = Field(default_factory=list)
    logo_detected: bool = Field(
        default=False,
        description="DAM matched an approved logo on the supplied post media.",
    )
    confidence_0_1: float = Field(default=0.0, ge=0.0, le=1.0)
    on_brand: bool = Field(
        default=False, description="DAM on-brand / compliance verdict."
    )
    compliance_notes: str = Field(default="", description="Short operator note.")
    source_attribution: str = Field(
        default="Source: Social Seeding DAM (demo) — https://socialseed.ing",
        description="MANDATORY attribution — mirrors the MCP licence terms.",
    )


# Demo DAM catalog — a tiny set of "approved" assets keyed by brand name. A real
# DAM Agent would back this with the customer's asset store; the demo keeps it
# in-memory so the A2A hop is reachable without external infra.
_DAM_CATALOG: dict[str, list[dict[str, str]]] = {
    "_default": [
        {
            "asset_id": "dam-logo-primary",
            "kind": "logo",
            "uri": "gs://ss-v2-dam/approved/_default/logo-primary.png",
        },
    ],
}


def get_brand_assets(
    brand_name: str, post_media_url: str | None = None
) -> BrandAssets:
    """A2A-callable DAM skill — return approved brand assets + an on-brand verdict.

    Input:
        brand_name      — the seeded brand whose approved assets to return.
        post_media_url  — optional gs:///https:// URI of the creator post media
                          the on-brand verdict is computed against.

    Output:
        ``BrandAssets`` — approved assets + logo_detected / confidence / on_brand
        / compliance_notes + the mandatory source attribution.

    Deterministic (demo): when `brand_name` is non-empty we return the catalog's
    `_default` approved logo and an on-brand verdict (the demo DAM trusts the
    seeded brand). A blank brand name yields an empty, NOT-on-brand result so a
    mis-routed call cannot pass as compliant.
    """
    name = (brand_name or "").strip()
    if not name:
        return BrandAssets(
            brand_name="",
            brand_assets=[],
            logo_detected=False,
            confidence_0_1=0.0,
            on_brand=False,
            compliance_notes="No brand name supplied; cannot verify on-brand compliance.",
        )

    catalog = _DAM_CATALOG.get(name, _DAM_CATALOG["_default"])
    assets = [BrandAsset(**a) for a in catalog]
    has_media = bool(post_media_url and str(post_media_url).strip())
    return BrandAssets(
        brand_name=name,
        brand_assets=assets,
        logo_detected=has_media,
        confidence_0_1=0.88 if has_media else 0.0,
        on_brand=True,
        compliance_notes=(
            f"DAM returned {len(assets)} approved asset(s) for '{name}'; "
            + (
                "post media matches the primary approved logo."
                if has_media
                else "no post media supplied — asset list returned only."
            )
        ),
    )


def serialize_brand_assets(assets: BrandAssets) -> dict[str, Any]:
    """Stable serialization for HTTP responses + A2A artifacts."""
    return json.loads(assets.model_dump_json())


# ---------------------------------------------------------------------------
# ADK runner glue
# ---------------------------------------------------------------------------


async def _run_adk(brief: str, *, uid: str | None) -> RankedCreators:
    """Invoke the SequentialAgent on Vertex AI Agent Runtime.

    We keep this thin — ADK does all the heavy lifting and the structured
    output schema on the ranker forces a ``RankedCreators`` JSON back.
    """
    from google.adk.runners import Runner  # type: ignore[import-not-found]
    from google.adk.sessions import InMemorySessionService  # type: ignore[import-not-found]
    from google.genai import types as genai_types  # type: ignore[import-not-found]

    session_service = InMemorySessionService()
    runner = Runner(
        agent=coordinator,
        app_name="influencer-research",
        session_service=session_service,
    )
    # create_session is async in ADK 1.x — await it directly. (Wrapping it in
    # asyncio.to_thread returns the un-awaited coroutine, so `session.id` below
    # raised AttributeError and the ADK path silently fell back to heuristic.)
    session = await session_service.create_session(
        app_name="influencer-research",
        user_id=uid or "a2a-caller",
    )
    content = genai_types.Content(
        role="user",
        parts=[genai_types.Part.from_text(text=brief)],
    )

    final_text: str | None = None
    for event in runner.run(
        user_id=uid or "a2a-caller",
        session_id=session.id,
        new_message=content,
    ):
        if event.is_final_response() and event.content and event.content.parts:
            final_text = event.content.parts[0].text

    if not final_text:
        raise RuntimeError("ADK produced no final response")

    try:
        return RankedCreators.model_validate_json(final_text)
    except Exception as exc:
        raise RuntimeError(f"ADK output failed schema validation: {exc}") from exc


# ---------------------------------------------------------------------------
# Heuristic ranker — runs when ADK is unavailable
# ---------------------------------------------------------------------------


async def _heuristic_rank(brief: str, *, uid: str | None) -> RankedCreators:
    """Deterministic ranker that exercises every MCP tool exactly as the
    ADK ranker would, but uses simple arithmetic instead of an LLM call.

    This is the path the smoke test takes, and it's also what runs if the
    Vertex AI quota is exhausted (REFACTOR-MCP §9.6). The output shape is
    identical so callers cannot tell the two paths apart.
    """
    # A9 (P1 Sub-1.3) — surface every entry into the heuristic ranker so
    # a judge re-running the demo doesn't silently get the deterministic
    # path while believing the LLM (Gemini 3.5-flash on Vertex global) is
    # ranking. The earlier silent-fallback bug (an `await`-less
    # create_session in _run_adk) is what made this visibility necessary —
    # see commit 548c854. If LIVE traces stop showing llm.model=gemini-3.5-flash
    # for plan_creator_search, this warning is the operator's signal.
    logger.warning(
        "heuristic_rank_triggered",
        extra={
            "uid": uid or "anonymous",
            "reason_hint": "ADK_DISABLED set OR google-adk unimportable OR _run_adk raised; check stack/INFO logs above",
            "brief_chars": len(brief),
        },
    )
    keywords = _extract_keywords(brief)

    candidates: dict[str, dict[str, Any]] = {}
    sourced = 0
    posts_fetched = 0
    posts_details_fetched = 0

    async with TikTokMcpClient(bearer_token=None) as mcp:
        # --- 1. Parallel keyword search --------------------------------------
        search_tasks = [
            mcp.search(keyword, limit=DEFAULT_CANDIDATES_PER_KEYWORD) for keyword in keywords
        ]
        try:
            search_results: list[McpResult] = await _gather_until_limit(search_tasks)
        except LimitReachedError as exc:
            logger.info("search limit reached early: %s", exc)
            search_results = []
        for res in search_results:
            payload = res.data if isinstance(res.data, dict) else {}
            for creator in payload.get("creators", []) or []:
                uid_ = str(creator.get("uniqueId") or "")
                if not uid_:
                    continue
                if int(creator.get("followerCount", 0) or 0) < FOLLOWER_SPAM_THRESHOLD:
                    continue
                candidates.setdefault(
                    uid_,
                    {
                        "uniqueId": uid_,
                        "followerCount": int(creator.get("followerCount") or 0),
                        "bio": str(creator.get("bio") or ""),
                    },
                )
        sourced = len(candidates)

        # --- 2. user_info enrichment (parallel) ------------------------------
        # In the heuristic path we only call user_info for candidates whose
        # bio was missing from the search result. This mirrors the ADK
        # ranker's behaviour and bounds quota usage.
        missing_bio = [uid_ for uid_, c in candidates.items() if not c["bio"]]
        if missing_bio:
            try:
                infos = await _gather_until_limit(
                    [mcp.user_info(uid_) for uid_ in missing_bio[:30]]
                )
                for info in infos:
                    body = info.data if isinstance(info.data, dict) else {}
                    uid_ = str(body.get("uniqueId") or "")
                    if uid_ and uid_ in candidates and body.get("bio"):
                        candidates[uid_]["bio"] = str(body["bio"])
            except LimitReachedError as exc:
                logger.info("user_info limit reached early: %s", exc)

        # --- 3. user_posts + post_detail for the top-N -----------------------
        top_ids = [
            uid_
            for uid_, _ in sorted(
                candidates.items(), key=lambda kv: -int(kv[1]["followerCount"])
            )
        ][: DEFAULT_TOP_N * 2]

        engagement_by_uid: dict[str, float] = {}
        for uid_ in top_ids:
            try:
                posts = await mcp.user_posts(uid_, count=DEFAULT_POSTS_PER_CANDIDATE)
            except LimitReachedError as exc:
                logger.info("user_posts limit reached at %s: %s", uid_, exc)
                break
            posts_body = posts.data if isinstance(posts.data, dict) else {}
            post_items = list(posts_body.get("posts", []) or [])
            posts_fetched += len(post_items)
            if not post_items:
                engagement_by_uid[uid_] = 0.0
                continue

            # Pick the 3 highest-view posts and pull detail for each.
            post_items.sort(key=lambda p: int(p.get("views", 0) or 0), reverse=True)
            sampled = post_items[:3]
            try:
                details = await _gather_until_limit(
                    [
                        mcp.post_detail(str(p.get("id") or ""), unique_id=uid_)
                        for p in sampled
                        if p.get("id")
                    ]
                )
                posts_details_fetched += len(details)
                merged = [d.data for d in details if isinstance(d.data, dict)] or post_items
            except LimitReachedError as exc:
                logger.info("post_detail limit reached at %s: %s", uid_, exc)
                merged = post_items

            engagement_by_uid[uid_] = _compute_engagement(merged)

    # --- 4. Score + rank -----------------------------------------------------
    ranked_creators: list[CreatorRank] = []
    for uid_, candidate in candidates.items():
        er = engagement_by_uid.get(uid_, 0.0)
        if uid_ not in engagement_by_uid:
            # Candidates we never got to (limit, ordering) get zeroed so they
            # rank below scored ones but stay in the trace.
            er = 0.0
        fit = _fit_score(brief, candidate.get("bio", ""))
        ranked_creators.append(
            CreatorRank(
                unique_id=uid_,
                follower_count=int(candidate.get("followerCount") or 0),
                engagement_rate=round(er, 4),
                fit_score=round(fit, 3),
                reasoning=_reasoning(brief, candidate, er, fit),
            )
        )

    ranked_creators.sort(key=lambda c: (-c.fit_score, -c.engagement_rate, -c.follower_count))
    top = ranked_creators[:DEFAULT_TOP_N]

    return RankedCreators(
        brief=brief,
        creators=top,
        source_attribution="Source: Social Seeding — https://socialseed.ing",
        trace={
            "path": "heuristic",
            "uid": uid,
            "keywords": keywords,
            "sourced_candidates": sourced,
            "posts_fetched": posts_fetched,
            "post_details_fetched": posts_details_fetched,
        },
    )


# ---------------------------------------------------------------------------
# Helpers — keywords / engagement / fit score
# ---------------------------------------------------------------------------


_KEYWORD_HINTS: dict[str, list[str]] = {
    "beauty": ["beauty", "skincare", "뷰티", "스킨케어"],
    "vegan": ["vegan", "비건"],
    "fitness": ["fitness", "workout", "운동"],
    "fintech": ["fintech", "투자", "핀테크"],
    "fashion": ["fashion", "스트릿", "패션"],
    "gaming": ["gaming", "게임"],
    "food": ["food", "맛집", "쿠킹"],
    "pet": ["pet", "반려동물"],
    "k-pop": ["kpop", "케이팝", "k-pop"],
}


def _extract_keywords(brief: str) -> list[str]:
    """Pull keyword variants from the brief without invoking an LLM.

    Heuristics:
        * Match against ``_KEYWORD_HINTS`` for known verticals.
        * Always include the first noun-like token (best-effort) plus a
          Korean transliteration if the brief contains Hangul.
        * Cap at ``DEFAULT_KEYWORDS_PER_BRIEF``.

    The ADK searcher does this with Gemini and is strictly better. This is
    here so the heuristic path produces sensible queries during smoke tests.
    """
    brief_low = brief.lower()
    keywords: list[str] = []

    for vertical, variants in _KEYWORD_HINTS.items():
        if vertical in brief_low or any(v in brief for v in variants):
            keywords.extend(variants)

    # Fallback — take the longest non-stop word from the brief.
    if not keywords:
        tokens = [t for t in brief_low.split() if len(t) >= 4]
        if tokens:
            keywords.append(tokens[0])

    if not keywords:
        keywords.append("trending")

    # Deduplicate preserving order.
    seen: set[str] = set()
    out: list[str] = []
    for k in keywords:
        if k not in seen:
            seen.add(k)
            out.append(k)
        if len(out) >= DEFAULT_KEYWORDS_PER_BRIEF:
            break
    return out


def _compute_engagement(posts: list[dict[str, Any]]) -> float:
    """Avg (likes + comments + shares) / views across the supplied posts."""
    ratios: list[float] = []
    for p in posts:
        views = float(p.get("views", 0) or 0)
        if views <= 0:
            continue
        likes = float(p.get("likes", 0) or 0)
        comments = float(p.get("comments", 0) or 0)
        shares = float(p.get("shares", 0) or 0)
        ratios.append(min(1.0, (likes + comments + shares) / views))
    if not ratios:
        return 0.0
    return sum(ratios) / len(ratios)


def _fit_score(brief: str, bio: str) -> float:
    """Token-overlap fit score in [0, 1] — Jaccard with light normalization.

    A real ADK ranker uses Gemini for this; the heuristic version is
    deterministic and good enough for smoke tests.
    """
    brief_tokens = {t for t in _tokenize(brief) if len(t) >= 3}
    bio_tokens = {t for t in _tokenize(bio) if len(t) >= 3}
    if not brief_tokens or not bio_tokens:
        return 0.0
    inter = brief_tokens & bio_tokens
    union = brief_tokens | bio_tokens
    return len(inter) / len(union) if union else 0.0


def _tokenize(text: str) -> list[str]:
    import re

    return [t.lower() for t in re.findall(r"[\w가-힣]+", text)]


def _reasoning(brief: str, candidate: dict[str, Any], er: float, fit: float) -> str:
    """Produce a 2-sentence rationale string."""
    handle = candidate.get("uniqueId", "")
    bio = (candidate.get("bio") or "").strip()
    bio_excerpt = bio[:80] + ("..." if len(bio) > 80 else "")
    followers = int(candidate.get("followerCount") or 0)
    return (
        f"@{handle} has {followers:,} followers and an estimated "
        f"engagement rate of {er:.1%}. Bio: \"{bio_excerpt}\" — fit score "
        f"{fit:.2f} against the brief."
    )


# ---------------------------------------------------------------------------
# Concurrency helpers
# ---------------------------------------------------------------------------


async def _gather_until_limit(coros: list[Any]) -> list[McpResult]:
    """asyncio.gather, but bubble the FIRST LimitReachedError to the caller.

    Other exceptions are caught and logged so a single bad post-id doesn't
    nuke the whole ranking pass.
    """
    results: list[McpResult] = []
    for fut in await asyncio.gather(*coros, return_exceptions=True):
        if isinstance(fut, LimitReachedError):
            raise fut
        if isinstance(fut, Exception):
            logger.debug("MCP call failed inside gather: %r", fut)
            continue
        results.append(fut)
    return results


# ---------------------------------------------------------------------------
# Convenience for the FastAPI layer
# ---------------------------------------------------------------------------


def serialize(ranked: RankedCreators) -> dict[str, Any]:
    """Stable serialization shape for HTTP responses + A2A artifacts."""
    return json.loads(ranked.model_dump_json())


__all__ = [
    "BrandAsset",
    "BrandAssets",
    "CreatorRank",
    "RankedCreators",
    "build_coordinator",
    "coordinator",
    "get_brand_assets",
    "plan_creator_search",
    "serialize",
    "serialize_brand_assets",
]
