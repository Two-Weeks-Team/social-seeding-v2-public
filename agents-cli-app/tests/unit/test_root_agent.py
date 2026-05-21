"""Offline unit tests for the campaign orchestrator `root_agent`.

Network-free: the wrapped ss_agents capabilities (`web_search`, `a2a_invoke`,
`rapidapi_tiktok_search`) are monkeypatched so nothing touches Vertex, the
ss-mcp Cloud Run endpoint, or RapidAPI. We assert:

  1. `root_agent.model` resolves to the required `gemini-3.5-flash`.
  2. `root_agent.tools` is exactly the two ss_agents wrappers `research_brand`
     (REAL Google Search grounding with citable URLs) + `search_creators`. The
     ADK built-in `google_search` tool is deliberately NOT attached — mixing a
     built-in grounding tool with custom function tools disables AFC and yields
     uncitable grounding-chunk markers; `research_brand` returns explicit source
     URLs the model can cite.
  3. Vertex is wired to the `global` endpoint (Gemini 3.x lives there).
  4. The wrappers delegate to the real ss_agents capabilities and degrade to
     an error STRING (never raise) on failure.
"""

from __future__ import annotations

import app.agent as agent_module
from app.agent import root_agent


def _tool_name(tool: object) -> str:
    """Resolve a tool's name across ADK shapes.

    Built-in tools (e.g. GoogleSearchTool) expose `.name`; plain function tools
    expose `__name__`. Mirror the verify command's resolution order.
    """
    return getattr(tool, "__name__", None) or getattr(tool, "name", None) or type(tool).__name__


def test_model_is_gemini_3_5_flash() -> None:
    model = root_agent.model
    model_id = getattr(model, "model", model)
    assert model_id == "gemini-3.5-flash"
    # Hard policy: no 2.5, no Claude, no pro.
    assert "2.5" not in str(model_id)
    assert "claude" not in str(model_id).lower()
    assert "pro" not in str(model_id).lower()


def test_tools_are_the_two_grounded_wrappers() -> None:
    names = {_tool_name(t) for t in root_agent.tools}
    assert "research_brand" in names, f"missing research_brand wrapper; got {names}"
    assert "search_creators" in names, f"missing search_creators wrapper; got {names}"
    # The built-in google_search is intentionally absent (see module docstring):
    # it disables AFC when mixed with function tools and yields uncitable markers.
    assert "google_search" not in names, f"built-in google_search should not be attached; got {names}"
    assert names == {"research_brand", "search_creators"}, f"unexpected tool set: {names}"


def test_vertex_wired_to_global_endpoint() -> None:
    import os

    assert os.environ.get("GOOGLE_CLOUD_LOCATION") == "global"
    assert os.environ.get("GOOGLE_GENAI_USE_VERTEXAI") == "True"


def test_research_brand_delegates_to_web_search(monkeypatch) -> None:
    from ss_agents.tools.web_search import WebSearchOutput, WebSearchResult

    captured: dict[str, object] = {}

    def fake_web_search(payload):  # noqa: ANN001
        captured["query"] = payload.query
        return WebSearchOutput(
            results=[
                WebSearchResult(
                    title="2026 K-beauty Vitamin C trend",
                    url="https://example.com/kbeauty-vitc-2026",
                    snippet="Vitamin C serums dominate TikTok seeding in 2026.",
                    publishedDate="2026-03-01",
                )
            ]
        )

    monkeypatch.setattr(agent_module, "web_search", fake_web_search)

    out = agent_module.research_brand("K-beauty Vitamin C serum trend 2026")
    assert captured["query"] == "K-beauty Vitamin C serum trend 2026"
    assert "https://example.com/kbeauty-vitc-2026" in out
    assert "cited source" in out.lower()


def test_research_brand_returns_error_string_on_failure(monkeypatch) -> None:
    def boom(payload):  # noqa: ANN001
        raise RuntimeError("vertex down")

    monkeypatch.setattr(agent_module, "web_search", boom)
    out = agent_module.research_brand("anything")
    assert out.startswith("research_brand error:")
    assert "vertex down" in out


def test_search_creators_uses_a2a_when_succeeds(monkeypatch) -> None:
    from ss_agents.tools.a2a_invoke import A2AInvokeOutput

    def fake_a2a(payload):  # noqa: ANN001
        return A2AInvokeOutput.model_validate(
            {
                "responsePayload": {
                    "data": {
                        "creators": [
                            {"uniqueId": "vegan_skin_kr", "nickname": "Vegan Skin KR", "followerCount": 120000, "score": 0.91},
                            {"uniqueId": "kbeauty_min", "nickname": "Min", "followerCount": 88000, "score": 0.87},
                        ]
                    }
                },
                "latencyMs": 142,
                "succeeded": True,
                "error": None,
            }
        )

    monkeypatch.setattr(agent_module, "a2a_invoke", fake_a2a)

    out = agent_module.search_creators("Korean vegan skincare creators for a Vitamin C serum")
    assert "ss-mcp A2A plan_creator_search" in out
    assert "@vegan_skin_kr" in out
    assert "@kbeauty_min" in out


def test_search_creators_falls_back_to_rapidapi(monkeypatch) -> None:
    from ss_agents.tools.a2a_invoke import A2AInvokeOutput
    from ss_agents.tools.rapidapi_tiktok_search import (
        RapidApiTiktokCreator,
        RapidApiTiktokSearchOutput,
    )

    def fake_a2a_fail(payload):  # noqa: ANN001
        return A2AInvokeOutput.model_validate(
            {"responsePayload": {}, "latencyMs": 50, "succeeded": False, "error": "task_state: 'failed'"}
        )

    def fake_rapidapi(payload):  # noqa: ANN001
        return RapidApiTiktokSearchOutput.model_validate(
            {
                "creators": [
                    RapidApiTiktokCreator.model_validate(
                        {"id": "tt_001", "uniqueId": "creator_001", "nickname": "Stub Creator 1", "followerCount": 10000, "videoCount": 50, "hashtags": ["vegan"]}
                    )
                ],
                "nextCursor": None,
                "queryEcho": "vegan skincare",
            }
        )

    monkeypatch.setattr(agent_module, "a2a_invoke", fake_a2a_fail)
    monkeypatch.setattr(agent_module, "rapidapi_tiktok_search", fake_rapidapi)

    out = agent_module.search_creators("vegan skincare")
    assert "RapidAPI TikTok search" in out
    assert "@creator_001" in out
    assert "A2A unavailable" in out


def test_search_creators_empty_brief_errors() -> None:
    out = agent_module.search_creators("   ")
    assert out.startswith("search_creators error:")
