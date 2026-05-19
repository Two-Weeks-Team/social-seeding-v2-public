"""Tests for the MCP client stub fixtures + envelope parsing.

Live MCP integration is marked ``integration`` and skipped by default; CI
sets ``MCP_BASE_URL`` to point at the Node sidecar.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from tiktok_orchestrator.mcp_client import (
    LimitReachedError,
    McpError,
    McpResult,
    TikTokMcpClient,
    _parse_envelope,
)


# ---------------------------------------------------------------------------
# Stub-mode functional tests
# ---------------------------------------------------------------------------


def test_stub_search_returns_creators() -> None:
    async def go() -> McpResult:
        async with TikTokMcpClient(base_url="") as mcp:
            return await mcp.search("beauty", limit=3)

    res = asyncio.run(go())
    assert res.tool == "tiktok_search"
    assert isinstance(res.data, dict)
    creators = res.data["creators"]
    assert len(creators) == 3
    for c in creators:
        assert c["followerCount"] >= 5_000
    assert res.daily_limit == 200


def test_stub_user_info_returns_bio() -> None:
    async def go() -> McpResult:
        async with TikTokMcpClient(base_url="") as mcp:
            return await mcp.user_info("kr_vegan_beauty")

    info = asyncio.run(go())
    assert info.data["uniqueId"] == "kr_vegan_beauty"
    assert "bio" in info.data


def test_stub_user_posts_returns_count_items() -> None:
    async def go() -> McpResult:
        async with TikTokMcpClient(base_url="") as mcp:
            return await mcp.user_posts("kr_vegan_beauty", count=5)

    posts = asyncio.run(go())
    assert len(posts.data["posts"]) == 5
    for p in posts.data["posts"]:
        assert p["views"] > 0 and p["likes"] > 0


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def test_search_rejects_blank_keyword() -> None:
    async def go() -> None:
        async with TikTokMcpClient(base_url="") as mcp:
            await mcp.search("   ", limit=10)

    with pytest.raises(ValueError):
        asyncio.run(go())


def test_user_posts_rejects_blank_unique_id() -> None:
    async def go() -> None:
        async with TikTokMcpClient(base_url="") as mcp:
            await mcp.user_posts("", count=10)

    with pytest.raises(ValueError):
        asyncio.run(go())


# ---------------------------------------------------------------------------
# Envelope parsing
# ---------------------------------------------------------------------------


def _make_body(content_text: str, structured: dict | None = None) -> dict:
    """Wrap a tool response in the MCP JSON-RPC result envelope."""
    return {
        "jsonrpc": "2.0",
        "id": "1",
        "result": {
            "content": [{"type": "text", "text": content_text}],
            "structuredContent": structured or {},
        },
    }


def test_parse_envelope_success() -> None:
    body = _make_body(
        "ok\n\nSource: Social Seeding — https://socialseed.ing/search?q=k",
        {
            "data": "ok",
            "_meta": {
                "source": "Social Seeding",
                "sourceUrl": "https://socialseed.ing",
                "remainingToday": 198,
                "dailyLimit": 200,
            },
        },
    )
    res = _parse_envelope("tiktok_search", body)
    assert res.remaining_today == 198
    assert res.daily_limit == 200
    assert not res.is_error


def test_parse_envelope_limit_reached_raises() -> None:
    body = _make_body(
        "Daily free limit reached for this tool.",
        {
            "data": "Daily free limit reached for this tool.",
            "_meta": {
                "source": "Social Seeding",
                "sourceUrl": "https://socialseed.ing",
                "remainingToday": 0,
                "dailyLimit": 200,
            },
        },
    )
    with pytest.raises(LimitReachedError):
        _parse_envelope("tiktok_search", body)


def test_parse_envelope_error_field_raises() -> None:
    body = {"jsonrpc": "2.0", "id": "1", "error": {"code": -32602, "message": "bad params"}}
    with pytest.raises(McpError):
        _parse_envelope("tiktok_search", body)


def test_parse_envelope_handles_korean_limit_message() -> None:
    body = _make_body(
        "일일 무료 한도를 모두 사용하셨습니다.",
        {
            "_meta": {
                "source": "Social Seeding",
                "sourceUrl": "https://socialseed.ing",
                "remainingToday": 0,
                "dailyLimit": 50,
            },
        },
    )
    with pytest.raises(LimitReachedError):
        _parse_envelope("tiktok_user_posts", body)


# ---------------------------------------------------------------------------
# Integration (gated on env)
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_live_mcp_search_smoke() -> None:
    """Marked integration — skipped by default. Run with::

        MCP_BASE_URL=http://localhost:8100 pytest -m integration
    """
    import os

    base = os.environ.get("MCP_BASE_URL")
    if not base:
        pytest.skip("MCP_BASE_URL not set")

    async def go() -> McpResult:
        async with TikTokMcpClient(base_url=base) as mcp:
            return await mcp.search("beauty", limit=3)

    res = asyncio.run(go())
    assert res.daily_limit > 0
    assert isinstance(res.raw_text, str)


# ---------------------------------------------------------------------------
# JSON serialization sanity
# ---------------------------------------------------------------------------


def test_result_is_json_serializable() -> None:
    res = McpResult(
        tool="tiktok_search",
        data={"creators": []},
        source="Social Seeding",
        source_url="https://socialseed.ing",
        remaining_today=10,
        daily_limit=200,
        raw_text="",
    )
    payload = {
        "tool": res.tool,
        "data": res.data,
        "remaining": res.remaining_today,
    }
    blob = json.dumps(payload)
    assert "tiktok_search" in blob
