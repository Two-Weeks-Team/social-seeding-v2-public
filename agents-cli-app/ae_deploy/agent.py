"""Social Seeding — Agent Engine deploy unit (keystone Step 1).

Self-contained ADK `root_agent` for the FIRST live deployment to **Vertex AI
Agent Engine** (`reasoningEngines`) on `ss-v2-prod`, replacing the Cloud Run
path (roadmap Step 1). It is deliberately dependency-light — it does NOT import
the local `ss_agents` editable package, because Agent Engine's managed build
installs only `requirements.txt` (a `file://` path dep won't resolve in the
cloud). The full 22-agent fleet bundling (vendor `ss_agents` as an installable)
is the immediate follow-up; this proves the managed runtime + Sessions + Cloud
Trace path is live.

Model policy (D53, hard): Gemini 3.x ONLY (`gemini-3.5-flash`), served on the
Vertex **`global`** endpoint. We force `GOOGLE_CLOUD_LOCATION=global` at import
so the reasoningEngine (regional, us-central1) still routes model calls to
`global`. No 2.5 / Claude / *-pro.
"""
from __future__ import annotations

import os

# Gemini 3.x lives on the `global` endpoint — force it before the model is built,
# so the Agent Engine regional runtime (us-central1) does not pin the model call
# to a region that 404s for 3.x.
os.environ["GOOGLE_CLOUD_LOCATION"] = "global"
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"

from google.adk.agents import Agent  # noqa: E402
from google.adk.models import Gemini  # noqa: E402

MODEL_ID = "gemini-3.5-flash"

# Deterministic public-creator fixture (non-PII; the real path is the live ss-mcp
# A2A `plan_creator_search`). Mirrors the wooriliu shortlist surface.
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
        return f"No creators for '{niche}' at ER ≥ {min_engagement_rate}%."
    lines = [f"Shortlist for {niche} (ER ≥ {min_engagement_rate}%):"]
    for i, c in enumerate(picks, 1):
        lines.append(f"  {i}. @{c['handle']} — {c['views']:,} views · {c['er_pct']}% ER")
    return "\n".join(lines)


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
)

__all__ = ["root_agent", "source_creators"]
