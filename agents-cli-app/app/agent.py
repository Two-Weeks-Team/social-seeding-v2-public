"""Social Seeding campaign orchestrator — Google Agents CLI (`agents-cli`) root agent.

This is the `agents-cli`-discoverable surface for Social Seeding v2's REAL agent
fleet. It does NOT reimplement campaign logic — it wraps the production
capability functions that live in `../packages/agents-adk/src/ss_agents` (imported,
never forked) behind ADK-auto-function-calling-friendly `str -> str` tools.

Grounding is REAL (not a chat completion): the `research_brand` tool delegates to
Social Seeding's `web.search` capability, which performs Google Search grounding
via gemini-3.5-flash and returns the cited source URLs lifted from the grounding
metadata. The orchestrator grounds 2026 market/trend claims through that single
tool and cites the real URLs it returns. (We deliberately do NOT also attach the
ADK built-in `google_search` tool: mixing a built-in grounding tool with custom
function tools disables automatic function calling and makes the model emit opaque
grounding-chunk markers like `[1.1.1]` that carry no citable URL — `research_brand`
returns explicit `Source: <url>` lines the model can cite verbatim.)

Model policy (hard requirement):
    * Gemini 3.x ONLY — `gemini-3.5-flash` for judgment/orchestration.
    * Served on the Vertex **`global`** endpoint (Gemini 3.x lives on `global`).
    * NO 2.5, NO Claude, NO `*-pro`.

The campaign loop the orchestrator drives (Social Seeding's core product loop):
    source → vet → outreach → verify
with market claims grounded via `research_brand` / `google_search`, and creators
sourced via `search_creators` (live ss-mcp A2A `plan_creator_search`, falling
back to the RapidAPI TikTok search capability).

Citations:
    D41 — Capability-layer ADK FunctionTool stub/live pattern (the wrapped tools).
    D45 — coordinator → a2a_invoke → ss-mcp-server.plan_creator_search.
    D47 — Google Agents Challenge submission surface.
    D53 — Google Search grounding via gemini-3.5-flash on the Vertex `global` endpoint.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import google.auth
from google.adk.agents import Agent
from google.adk.apps import App
from google.adk.models import Gemini
from google.genai import types

# ─────────────────────────────────────────────────────────────────────────────
# Reuse the REAL ss_agents fleet.
#
# Primary path: the editable path dependency declared in pyproject.toml
# (`ss-agents-adk @ file://../packages/agents-adk`) puts `ss_agents` on sys.path
# after `agents-cli install` / `uv sync`. The fallback below makes a bare
# `python -c "import app.agent"` work even before an install, by inserting the
# package's `src/` dir — so the orchestrator can never silently lose its tools.
# ─────────────────────────────────────────────────────────────────────────────
try:  # pragma: no cover — import path resolution, exercised by both branches in CI
    import ss_agents  # noqa: F401  (import-availability probe)
except ImportError:  # pragma: no cover
    _AGENTS_ADK_SRC = (
        Path(__file__).resolve().parent.parent.parent / "packages" / "agents-adk" / "src"
    )
    if _AGENTS_ADK_SRC.is_dir():
        sys.path.insert(0, str(_AGENTS_ADK_SRC))

from ss_agents.tools.a2a_invoke import A2AInvokeInput, a2a_invoke  # noqa: E402
from ss_agents.tools.rapidapi_tiktok_search import (  # noqa: E402
    RapidApiTiktokSearchInput,
    rapidapi_tiktok_search,
)
from ss_agents.tools.web_search import WebSearchInput, web_search  # noqa: E402

# ─────────────────────────────────────────────────────────────────────────────
# Vertex / Gemini wiring (matches the agents-cli `create --adk` template).
# Gemini 3.x is served on the `global` endpoint; we force Vertex-backed genai.
# ─────────────────────────────────────────────────────────────────────────────
try:  # pragma: no cover — ADC is present in the deploy/playground env, not in unit CI
    _, _project_id = google.auth.default()
    if _project_id:
        os.environ.setdefault("GOOGLE_CLOUD_PROJECT", _project_id)
except Exception:  # noqa: BLE001 — offline unit tests have no ADC; that's fine
    pass

os.environ["GOOGLE_CLOUD_LOCATION"] = "global"  # Gemini 3.x lives on `global` (D53)
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"

# The single model the orchestrator (and the eval LLM-judge) use. Gemini 3.5
# Flash only — see module docstring model policy.
MODEL_ID = "gemini-3.5-flash"

# Live ss-mcp A2A endpoint for `plan_creator_search` (D45). The Cloud Run host is
# allowlisted by a2a_invoke's SSRF guard; overridable via SS_MCP_ENDPOINT for the
# operator's own deploy without editing the wrapped capability.
SS_MCP_ENDPOINT = os.environ.get(
    "SS_MCP_ENDPOINT",
    "https://ss-mcp-server-1049119860518.us-central1.run.app",
)


# ─────────────────────────────────────────────────────────────────────────────
# Tool wrappers — simple `str -> str` so ADK auto-function-calling is happy.
#
# The wrapped ss_agents capabilities take strict Pydantic inputs and return
# Pydantic outputs, which ADK auto-FC cannot bind directly. Each wrapper builds
# the Pydantic input, calls the REAL capability, and formats a compact text
# answer (with cited URLs / ranked creators) for the model. Failures are
# returned as an error STRING — never raised — so a flaky network hop degrades
# to a routing signal instead of crashing the turn.
# ─────────────────────────────────────────────────────────────────────────────


def research_brand(query: str) -> str:
    """Research a brand, product, market, or trend on the public web and return a
    grounded summary with cited source URLs.

    Use this to ground any market/trend/competitor/funding claim before stating
    it (e.g. "K-beauty Vitamin C serum demand on TikTok in 2026"). Delegates to
    Social Seeding's real `web.search` capability, which performs Google Search
    grounding via gemini-3.5-flash and lifts the cited sources out of the
    grounding metadata. Set CAPABILITY_LAYER_MODE=live for real grounding (the
    default `stub` returns deterministic offline data for dev/CI).

    Args:
        query: The brand, product, market, or trend to research (free text).

    Returns:
        A formatted summary followed by a numbered list of cited source URLs,
        or an error string beginning with "research_brand error:".
    """
    try:
        payload = WebSearchInput(query=query, locale="en", maxResults=8)
        output = web_search(payload)
    except Exception as exc:  # noqa: BLE001 — surface as a string, never raise
        return f"research_brand error: {type(exc).__name__}: {exc}"

    if not output.results:
        return (
            f"research_brand: no web sources found for {query!r}. "
            "State the claim as unverified or broaden the query."
        )

    lines = [f"Web research for {query!r} ({len(output.results)} cited sources):", ""]
    for i, r in enumerate(output.results, start=1):
        date = f" ({r.published_date})" if r.published_date else ""
        lines.append(f"{i}. {r.title}{date}\n   {r.snippet}\n   Source: {r.url}")
    return "\n".join(lines)


def search_creators(brand_brief: str) -> str:
    """Source ranked TikTok creators for a campaign brief.

    Primary path: invoke the live Social Seeding MCP server's `plan_creator_search`
    skill over A2A v0.3 (D45) via the real `a2a.invoke` capability. If that hop
    fails (network, SSRF block, non-completed task, or stub mode without the
    endpoint), falls back to the real `rapidapi.tiktok_search` capability so the
    orchestrator always returns *something* sourceable.

    Args:
        brand_brief: The campaign brief / creator search intent (free text, e.g.
            "Korean vegan skincare creators for a Vitamin C serum launch").

    Returns:
        A ranked, human-readable list of creators (handle + headline metrics),
        or an error string beginning with "search_creators error:".
    """
    brief = (brand_brief or "").strip()
    if not brief:
        return "search_creators error: brand_brief is empty."

    # 1) Live ss-mcp A2A `plan_creator_search` (D45).
    try:
        a2a_out = a2a_invoke(
            A2AInvokeInput.model_validate(
                {
                    "remoteAgentEndpoint": SS_MCP_ENDPOINT,
                    "taskPayload": {"skill": "plan_creator_search", "brand_brief": brief},
                    "timeoutS": 30,
                    "correlationId": "agents-cli-search-creators",
                }
            )
        )
        if a2a_out.succeeded:
            data = a2a_out.response_payload.get("data")
            formatted = _format_a2a_creators(data)
            if formatted:
                return (
                    f"Creators via ss-mcp A2A plan_creator_search "
                    f"({a2a_out.latency_ms} ms):\n{formatted}"
                )
        # else: fall through to the RapidAPI fallback below.
    except Exception as exc:  # noqa: BLE001 — degrade to fallback, never raise
        a2a_error = f"{type(exc).__name__}: {exc}"
    else:
        a2a_error = a2a_out.error or "no structured creators in A2A response"

    # 2) Fallback: real RapidAPI TikTok creator search.
    try:
        rapid_out = rapidapi_tiktok_search(
            RapidApiTiktokSearchInput(query=brief[:500], mode="text", limit=10)
        )
    except Exception as exc:  # noqa: BLE001
        return (
            f"search_creators error: A2A hop failed ({a2a_error}) and the "
            f"RapidAPI fallback also failed ({type(exc).__name__}: {exc})."
        )

    if not rapid_out.creators:
        return (
            f"search_creators: A2A hop returned no creators ({a2a_error}); "
            f"RapidAPI fallback returned 0 creators for {brief!r}."
        )

    lines = [
        f"Creators via RapidAPI TikTok search (A2A unavailable: {a2a_error}); "
        f"query={rapid_out.query_echo!r}:",
        "",
    ]
    for i, c in enumerate(rapid_out.creators, start=1):
        tags = f" #{' #'.join(c.hashtags)}" if c.hashtags else ""
        lines.append(
            f"{i}. @{c.unique_id} ({c.nickname}) — "
            f"{c.follower_count:,} followers, {c.video_count} videos{tags}"
        )
    return "\n".join(lines)


def _format_a2a_creators(data: object) -> str:
    """Format the `plan_creator_search` A2A `data` artifact into ranked text.

    The remote returns a `RankedCreators`-shaped payload; we read the common
    shapes defensively (a list, or a dict with a `creators`/`results` list) and
    never raise — an unrecognized shape just yields an empty string so the caller
    falls back to RapidAPI.
    """
    rows: list[object]
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        candidate = data.get("creators") or data.get("results") or data.get("items")
        rows = candidate if isinstance(candidate, list) else []
    else:
        rows = []

    if not rows:
        return ""

    lines: list[str] = []
    for i, row in enumerate(rows[:15], start=1):
        if isinstance(row, dict):
            handle = (
                row.get("uniqueId")
                or row.get("unique_id")
                or row.get("handle")
                or row.get("username")
                or row.get("id")
                or "unknown"
            )
            nickname = row.get("nickname") or row.get("name") or ""
            followers = row.get("followerCount") or row.get("follower_count")
            score = row.get("score") or row.get("rank")
            extras = []
            if followers is not None:
                extras.append(f"{followers} followers")
            if score is not None:
                extras.append(f"score={score}")
            suffix = f" — {', '.join(extras)}" if extras else ""
            nick = f" ({nickname})" if nickname else ""
            lines.append(f"{i}. @{handle}{nick}{suffix}")
        else:
            lines.append(f"{i}. {row}")
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# Orchestrator instruction.
# ─────────────────────────────────────────────────────────────────────────────

_INSTRUCTION = """\
You are the Social Seeding campaign orchestrator. Social Seeding runs TikTok
influencer-seeding campaigns through one loop: SOURCE creators → VET them →
OUTREACH → VERIFY the resulting posts. You help the operator plan and reason about
this loop.

You have exactly two tools. Use them — never answer from memory:
  • research_brand(query): REAL Google-Search-grounded web research. Returns a
    numbered list of source entries (title, snippet, then a "Source: <url>" line).
  • search_creators(brand_brief): ranked TikTok creators from the live sourcing
    pipeline (real handles + metrics).

GROUNDING RULES (non-negotiable — these are graded):
  1. ALWAYS call research_brand BEFORE stating any claim about a market, a 2026
     trend, a brand, a competitor, an ingredient, funding, or anything not common
     knowledge. Even when the operator only asks you to "plan" or "source", if your
     answer contains such a claim you must ground it with a research_brand call
     first. When useful, call research_brand more than once (e.g. once per brand or
     sub-topic).
  2. State ONLY facts that actually appear in a research_brand result. If a fact is
     not in the tool output, DO NOT state it — no memory, no guessing, no filling
     in plausible details. If research_brand returns nothing for a point, say that
     point is unverified instead of asserting it.
  3. CITE REAL URLS. For every grounded claim, cite the URL from the "Source: <url>"
     line returned by research_brand — inline, e.g. "(https://site.com/article)".
     Then end the whole answer with a "Sources" section listing every URL you used,
     copied verbatim from the "Source: <url>" lines in the tool output. NEVER use a
     bare "[1]" / "[1.1.1]" marker that is not backed by a URL in your Sources list.

CREATOR RULES (report only what the tool returns):
  • Call search_creators with the campaign brief. Present EXACTLY the creators it
    returns — their real handles and metrics. NEVER invent a handle, a follower
    count, or an extra creator to pad a list.
  • If the operator asks for N creators and search_creators returns fewer, present
    the ones returned and state plainly how many were sourced (e.g. "The pipeline
    returned 5 creators — here they are; I can broaden the brief to source more").
    Do NOT fabricate the difference.
  • If a tool returns an error string or no results, say so plainly.

ANSWER FORMAT (keep it concise):
  1. A short grounded summary — every market/trend/brand claim cited inline to a
     real research_brand URL.
  2. The creator shortlist — only tool-returned creators, one-line fit reason each.
  3. One line: the next step in the source → vet → outreach → verify loop.
  4. A "Sources" section listing the real URLs you cited (verbatim from the tools).

Honesty about gaps always beats a polished but fabricated answer.
"""


# ─────────────────────────────────────────────────────────────────────────────
# root_agent + App — the agents-cli / ADK discovery surface.
# ─────────────────────────────────────────────────────────────────────────────

root_agent = Agent(
    name="root_agent",
    model=Gemini(
        model=MODEL_ID,
        retry_options=types.HttpRetryOptions(attempts=3),
    ),
    instruction=_INSTRUCTION,
    tools=[
        research_brand,  # → ss_agents web.search (REAL Google Search grounding, cited URLs)
        search_creators,  # → ss-mcp A2A plan_creator_search / RapidAPI fallback
    ],
)

app = App(root_agent=root_agent, name="app")


__all__ = ["app", "research_brand", "root_agent", "search_creators"]
