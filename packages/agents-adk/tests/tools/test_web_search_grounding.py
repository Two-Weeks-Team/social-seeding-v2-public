"""Offline test for `web.search` LIVE grounding (D53).

Mocks `google.genai.Client` so the live path is exercised WITHOUT a network call:
asserts `_live_search` lifts `grounding_metadata` (grounding_chunks + grounding_supports)
into validated `WebSearchResult` rows with real URLs + per-source snippets. The actual
live grounding 200 is proven by `scripts/smoke-test/run-web-search-grounding.sh`.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from ss_agents.tools.web_search import WebSearchInput, web_search


def _fake_response() -> SimpleNamespace:
    """A google-genai response shaped like a grounded gemini-3.5-flash reply."""
    web1 = SimpleNamespace(uri="https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA", title="elle.com")
    web2 = SimpleNamespace(uri="https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB", title="knokglobal.com")
    chunks = [SimpleNamespace(web=web1), SimpleNamespace(web=web2)]
    supports = [
        SimpleNamespace(
            segment=SimpleNamespace(text="Vegan K-beauty is surging on TikTok in 2026."),
            grounding_chunk_indices=[0],
        ),
        SimpleNamespace(
            segment=SimpleNamespace(text="58% of Gen Z prioritize vegan-certified products."),
            grounding_chunk_indices=[1],
        ),
    ]
    gm = SimpleNamespace(
        grounding_chunks=chunks,
        grounding_supports=supports,
        web_search_queries=["vegan k-beauty tiktok 2026"],
    )
    candidate = SimpleNamespace(grounding_metadata=gm)
    return SimpleNamespace(text="Grounded summary.", candidates=[candidate])


class _FakeModels:
    def __init__(self, captured: dict) -> None:
        self._captured = captured

    def generate_content(self, *, model, contents, config):  # noqa: ANN001
        self._captured["model"] = model
        self._captured["has_google_search"] = bool(getattr(config, "tools", None))
        return _fake_response()


class _FakeClient:
    last_kwargs: dict = {}

    def __init__(self, **kwargs):  # noqa: ANN003
        _FakeClient.last_kwargs = kwargs
        self._captured: dict = {}
        self.models = _FakeModels(self._captured)


@pytest.fixture
def _live_genai(monkeypatch: pytest.MonkeyPatch):
    """Force live mode + a global Vertex location, and stub google.genai.Client."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "ss-v2-prod")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "global")
    from ss_agents.config import reset_settings_cache

    reset_settings_cache()
    # Patch the real google.genai.Client (don't replace the module — that's
    # bypassed once another test has imported the real `google.genai` as an
    # attribute of the `google` package). Real `types` is used to build the
    # GoogleSearch tool; only the network-touching Client is faked.
    import google.genai as real_genai

    monkeypatch.setattr(real_genai, "Client", _FakeClient)
    yield
    reset_settings_cache()


def test_live_grounding_lifts_cited_sources(_live_genai) -> None:
    out = web_search(WebSearchInput(query="vegan k-beauty tiktok creators 2026", maxResults=5))
    assert len(out.results) == 2
    titles = {r.title for r in out.results}
    assert titles == {"elle.com", "knokglobal.com"}
    # URLs are the real grounding-redirect citations.
    assert all(r.url.startswith("https://vertexaisearch.cloud.google.com/") for r in out.results)
    # Snippets are the per-source grounded segments (not a generic blurb).
    snippets = {r.snippet for r in out.results}
    assert "Vegan K-beauty is surging on TikTok in 2026." in snippets
    assert "58% of Gen Z prioritize vegan-certified products." in snippets


def test_live_uses_global_endpoint_and_search_tool(_live_genai) -> None:
    web_search(WebSearchInput(query="anything", maxResults=3))
    # The client was created against the global Vertex endpoint (Gemini 3.x).
    assert _FakeClient.last_kwargs.get("location") == "global"
    assert _FakeClient.last_kwargs.get("vertexai") is True


def test_live_respects_max_results(_live_genai) -> None:
    out = web_search(WebSearchInput(query="x", maxResults=1))
    assert len(out.results) == 1
