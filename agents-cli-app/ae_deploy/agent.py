"""Social Seeding — Agent Engine deploy unit (keystone Step 1 + auto-recall).

Self-contained ADK `root_agent` deployed to **Vertex AI Agent Engine**
(`reasoningEngines`) on `ss-v2-prod`. Two native capabilities are wired here:

  • GT1 — Cloud Trace: enabled at the `AdkApp(enable_tracing=True)` layer by the
    deploy driver, so every `stream_query` emits reasoning spans to Cloud Trace.

  • GT2 — Memory auto-recall: `before_agent_callback` pulls this user's
    remembered brand preferences from a **Vertex AI Memory Bank** and stashes the
    text in session state; `before_model_callback` injects it into the model's
    instructions. The agent then applies the recalled minimum engagement rate
    WITHOUT the operator restating it.

    The earlier `PreloadMemoryTool` + `memory_service_builder` path silently
    no-op'd because the builder could not resolve the engine id at runtime. This
    version removes that ambiguity: the Memory Bank engine id and the memory
    SCOPE (`app_name`) are pinned via env vars (`MEMORY_BANK_ENGINE_ID`,
    `MEMORY_APP_NAME`), so the (app_name, user_id) tuple matches on both write
    (the seeding script) and read (this callback). No reliance on the deployed
    app_name or an auto-set engine-id env.

Model policy (D53, hard): Gemini 3.x ONLY (`gemini-3.5-flash`), served on the
Vertex **`global`** endpoint. No 2.5 / Claude / *-pro.
"""
from __future__ import annotations

import logging
import os

# Gemini 3.x lives on the `global` endpoint — force it before the model is built.
os.environ["GOOGLE_CLOUD_LOCATION"] = "global"
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"

_logger = logging.getLogger("ss.recall")

from google.adk.agents import Agent  # noqa: E402
from google.adk.agents.callback_context import CallbackContext  # noqa: E402
from google.adk.models import Gemini, LlmRequest  # noqa: E402

MODEL_ID = "gemini-3.5-flash"

# What we look for in the user's Memory Bank before each turn.
_MEMORY_QUERY = "brand campaign preferences and the required minimum engagement rate (ER)"

# Deterministic public-creator fixture (non-PII). Mirrors the wooriliu shortlist.
_CREATORS = [
    {"handle": "lizethhv2", "views": 38200, "er_pct": 10.3},
    {"handle": "guiomarmakeup", "views": 12400, "er_pct": 1.4},
    {"handle": "_alejandrauve", "views": 379, "er_pct": 18.6},
    {"handle": "weenz92", "views": 164, "er_pct": 12.2},
    {"handle": "dane2749", "views": 201, "er_pct": 9.0},
]


def source_creators(niche: str, min_engagement_rate: float = 2.0) -> str:
    """Source TikTok creators for a campaign niche, filtered by engagement rate.

    Args:
        niche: campaign niche, e.g. "beauty/cosmetics".
        min_engagement_rate: minimum engagement-rate percentage to include.

    Returns:
        A ranked, human-readable shortlist with @handle, views and ER%.
    """
    picks = [c for c in _CREATORS if c["er_pct"] >= float(min_engagement_rate)]
    picks.sort(key=lambda c: c["er_pct"], reverse=True)
    if not picks:
        return f"No creators for '{niche}' at ER >= {min_engagement_rate}%."
    lines = [f"Shortlist for {niche} (ER >= {min_engagement_rate}%):"]
    for i, c in enumerate(picks, 1):
        lines.append(f"  {i}. @{c['handle']} - {c['views']:,} views - {c['er_pct']}% ER")
    return "\n".join(lines)


async def _recall_brand_pref(callback_context: CallbackContext):
    """GT2 auto-recall: read the user's remembered prefs from the Memory Bank
    and stash them in state for `_inject_brand_pref` to surface to the model.

    Engine id + memory scope are env-pinned so the read scope tuple
    (app_name, user_id) matches what the seeding script wrote. Never blocks the
    turn — a recall failure is recorded in state and the agent proceeds."""
    eid = os.environ.get("MEMORY_BANK_ENGINE_ID")
    app_name = os.environ.get("MEMORY_APP_NAME", "ss-recall")
    uid = callback_context.user_id
    _logger.info("RECALL start: eid=%s app_name=%s user_id=%s", eid, app_name, uid)
    if not eid:
        return None
    try:
        from google.adk.memory import VertexAiMemoryBankService

        # The Memory Bank reasoningEngine lives in a REGION (us-central1); the
        # runtime env forces GOOGLE_CLOUD_LOCATION=global for Gemini 3.x model
        # calls, so we MUST pin project+location here or the retrieve routes to
        # `global` and 404s ("ReasoningEngine does not exist").
        svc = VertexAiMemoryBankService(
            project=os.environ.get("GOOGLE_CLOUD_PROJECT", "ss-v2-prod"),
            location=os.environ.get("MEMORY_BANK_LOCATION", "us-central1"),
            agent_engine_id=eid,
        )
        resp = await svc.search_memory(app_name=app_name, user_id=uid, query=_MEMORY_QUERY)
        texts: list[str] = []
        for entry in resp.memories:
            content = getattr(entry, "content", None)
            for part in (getattr(content, "parts", None) or []):
                text = getattr(part, "text", None)
                if text:
                    texts.append(text.strip())
        _logger.info("RECALL got %d memories: %s", len(texts), texts)
        if texts:
            callback_context.state["recalled_memory"] = " ".join(texts)
    except Exception as exc:  # noqa: BLE001 — recall is best-effort, never fatal
        _logger.exception("RECALL failed")
        callback_context.state["recall_error"] = repr(exc)
    return None


def _inject_brand_pref(callback_context: CallbackContext, llm_request: LlmRequest):
    """GT2: inject the recalled preference into the model instructions so the
    agent applies it without the operator restating it."""
    mem = callback_context.state.get("recalled_memory")
    _logger.info("INJECT recalled_memory present=%s", bool(mem))
    if mem:
        llm_request.append_instructions([
            f"[RECALLED BRAND PREFERENCE — you MUST apply this]: {mem} "
            "When this implies a minimum engagement rate, pass that exact number "
            "as `min_engagement_rate` to `source_creators`, and state which "
            "remembered preference you applied. Never invent metrics."
        ])
    return None


root_agent = Agent(
    name="root_agent",
    model=Gemini(model=MODEL_ID),
    description="Social Seeding campaign operator — sources TikTok creators from a one-line brief.",
    instruction=(
        "You are the Social Seeding campaign operator. Given a one-line brief, "
        "identify the niche and call `source_creators` to return a ranked creator "
        "shortlist. Be concise. Never invent metrics — only report what the tool "
        "returns. Models in use are Gemini 3.5/3.1 only."
    ),
    tools=[source_creators],
    before_agent_callback=_recall_brand_pref,
    before_model_callback=_inject_brand_pref,
)

__all__ = ["root_agent", "source_creators"]
