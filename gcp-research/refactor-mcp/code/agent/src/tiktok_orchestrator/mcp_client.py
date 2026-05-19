# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""Thin async MCP client for the Node `tiktok-mcp-server` sidecar.

In the Cloud Run multi-container deployment (REFACTOR-MCP §5.3), the Node MCP
server runs on ``localhost:8100`` (loopback inside the pod). This module
abstracts away the streamable-HTTP framing so the ADK agent can call each tool
as if it were a normal async function.

Two transport paths:
    1. **streamable-http JSON-RPC** (production) — what the Node server actually
       speaks today (``src/transport/streamable-http.ts``). One POST opens a
       session, subsequent POSTs reuse ``Mcp-Session-Id`` per REFACTOR-MCP
       §9.5 (Cloud Run sessionAffinity required).
    2. **stub mode** (tests / local dev) — if ``MCP_BASE_URL`` is unset, the
       client returns deterministic fixtures so tests pass without booting the
       Node service.

The MCP envelope (``withLimit`` at ``src/server.ts:22-69``) gives us:

    {
      "content":           [{"type": "text", "text": "<rendered + Source footer>"}],
      "structuredContent": {
        "data": "<raw tool output>",
        "_meta": {
          "source":         "Social Seeding",
          "sourceUrl":      "https://socialseed.ing/...",
          "remainingToday": 198,
          "dailyLimit":     200
        }
      }
    }

When ``remainingToday`` hits 0, ``content`` carries the limit-reached message
(`backend/cta.ts`); we surface that as a ``LimitReachedError`` so the agent
can stop fanning out (REFACTOR-MCP §3.3 instruction: *"If you receive a
'Daily free limit reached' message from any tool, STOP IMMEDIATELY"*).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_MCP_BASE_URL = os.environ.get("MCP_BASE_URL", "")
DEFAULT_TIMEOUT_S = float(os.environ.get("MCP_TIMEOUT_S", "30"))
SESSION_HEADER = "Mcp-Session-Id"  # set by the Node server's transport


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class McpError(RuntimeError):
    """Generic MCP transport error (HTTP non-2xx, malformed JSON, etc.)."""


class LimitReachedError(McpError):
    """Daily free-tier quota exhausted for a given tool.

    The Node server signals this via the `withLimit` wrapper at
    `src/server.ts:30-32` — `content[0].text` carries the human-readable
    limit-reached message and `_meta.remainingToday == 0`. The agent layer
    treats this as a terminal "stop fanning out" signal.
    """

    def __init__(self, tool: str, message: str) -> None:
        super().__init__(f"{tool}: {message}")
        self.tool = tool
        self.message = message


# ---------------------------------------------------------------------------
# Response container
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class McpResult:
    """Parsed result of an MCP tool call.

    Attributes mirror the structured-content envelope from
    `withLimit` (REFACTOR-MCP §1.1, src/server.ts:43-54).
    """

    tool: str
    data: Any
    source: str
    source_url: str
    remaining_today: int
    daily_limit: int
    raw_text: str
    is_error: bool = False
    error_message: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class TikTokMcpClient:
    """Async streamable-HTTP MCP client targeting the Node sidecar.

    Lifecycle:
        async with TikTokMcpClient() as mcp:
            r = await mcp.search("뷰티", limit=10)

    Stub mode (no base URL configured) is intended for unit tests so the
    Python layer can be exercised without the Node container running.
    """

    def __init__(
        self,
        base_url: str | None = None,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        bearer_token: str | None = None,
    ) -> None:
        self.base_url = (base_url if base_url is not None else DEFAULT_MCP_BASE_URL).rstrip("/")
        self.timeout_s = timeout_s
        self.bearer_token = bearer_token
        self._session_id: str | None = None
        self._client: httpx.AsyncClient | None = None
        self._stub_mode = not self.base_url
        if self._stub_mode:
            logger.warning(
                "TikTokMcpClient running in stub mode — MCP_BASE_URL not set. "
                "All tool calls return canned fixtures."
            )

    # --- context manager -----------------------------------------------------

    async def __aenter__(self) -> TikTokMcpClient:
        if not self._stub_mode:
            headers: dict[str, str] = {"Accept": "application/json, text/event-stream"}
            if self.bearer_token:
                headers["Authorization"] = f"Bearer {self.bearer_token}"
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout_s,
                headers=headers,
            )
            await self._initialize()
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        if self._client is not None:
            try:
                if self._session_id:
                    # Politely DELETE the session — see src/transport/streamable-http.ts:71-78
                    await self._client.delete(
                        "/mcp", headers={SESSION_HEADER: self._session_id}
                    )
            except Exception:  # noqa: BLE001
                logger.debug("session DELETE failed; ignoring", exc_info=True)
            await self._client.aclose()

    # --- public tool surface -------------------------------------------------

    async def search(self, keyword: str, *, limit: int = 10) -> McpResult:
        """tiktok_search — discover creators by keyword.

        See ``src/server.ts:97-115`` for the canonical schema:
            keyword: str
            limit:   int  (1..100, default 10)
        """
        if not isinstance(keyword, str) or not keyword.strip():
            raise ValueError("keyword must be a non-empty string")
        limit = max(1, min(100, int(limit)))
        return await self._call("tiktok_search", {"keyword": keyword, "limit": limit})

    async def user_info(self, unique_id: str) -> McpResult:
        """tiktok_user_info — fetch creator profile.

        See ``src/server.ts:117-133``: ``uniqueId: str``.
        """
        if not isinstance(unique_id, str) or not unique_id.strip():
            raise ValueError("unique_id must be a non-empty string")
        return await self._call("tiktok_user_info", {"uniqueId": unique_id})

    async def user_posts(self, unique_id: str, *, count: int = 10) -> McpResult:
        """tiktok_user_posts — fetch recent posts.

        See ``src/server.ts:136-153``: ``uniqueId, count (1..30, default 10)``.
        """
        if not isinstance(unique_id, str) or not unique_id.strip():
            raise ValueError("unique_id must be a non-empty string")
        count = max(1, min(30, int(count)))
        return await self._call("tiktok_user_posts", {"uniqueId": unique_id, "count": count})

    async def post_detail(self, post_id: str, *, unique_id: str | None = None) -> McpResult:
        """tiktok_post_detail — fetch one post's engagement breakdown.

        See ``src/server.ts:155-172``: ``id: str``, ``uniqueId?: str``.
        """
        if not isinstance(post_id, str) or not post_id.strip():
            raise ValueError("post_id must be a non-empty string")
        params: dict[str, Any] = {"id": post_id}
        if unique_id:
            params["uniqueId"] = unique_id
        return await self._call("tiktok_post_detail", params)

    # --- internals -----------------------------------------------------------

    async def _initialize(self) -> None:
        """Send the MCP `initialize` JSON-RPC handshake (see MCP SDK 1.12).

        Caches the returned ``Mcp-Session-Id`` so subsequent tool calls reuse
        the same session — required by ``src/transport/streamable-http.ts:82``.
        """
        assert self._client is not None
        payload = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "tiktok-orchestrator", "version": "1.0.0"},
            },
        }
        resp = await self._client.post(
            "/mcp",
            json=payload,
            headers={"Content-Type": "application/json"},
        )
        resp.raise_for_status()
        # Node transport returns the session id in a response header.
        self._session_id = resp.headers.get(SESSION_HEADER)
        if not self._session_id:
            raise McpError("MCP initialize did not return a session id")
        # Send the required `initialized` notification.
        await self._client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
            headers={
                "Content-Type": "application/json",
                SESSION_HEADER: self._session_id,
            },
        )

    async def _call(self, tool: str, arguments: dict[str, Any]) -> McpResult:
        """Dispatch a `tools/call` JSON-RPC against the MCP endpoint."""
        if self._stub_mode:
            return _stub_response(tool, arguments)

        assert self._client is not None
        assert self._session_id is not None

        payload = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }
        try:
            resp = await self._client.post(
                "/mcp",
                json=payload,
                headers={
                    "Content-Type": "application/json",
                    SESSION_HEADER: self._session_id,
                },
            )
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise McpError(f"{tool}: transport error: {exc}") from exc

        # Streamable transport may answer with SSE (`text/event-stream`) or
        # plain JSON. Normalize both.
        body = _parse_streamable(resp)
        return _parse_envelope(tool, body)


# ---------------------------------------------------------------------------
# Envelope parsing
# ---------------------------------------------------------------------------


def _parse_streamable(resp: httpx.Response) -> dict[str, Any]:
    """Parse either JSON or SSE-frame response into a single dict."""
    ctype = resp.headers.get("content-type", "")
    if "text/event-stream" in ctype:
        # Concatenate `data:` frames; keep the LAST `result`-bearing frame.
        last: dict[str, Any] | None = None
        for line in resp.text.splitlines():
            if line.startswith("data:"):
                try:
                    chunk = json.loads(line.removeprefix("data:").strip())
                except json.JSONDecodeError:
                    continue
                if isinstance(chunk, dict) and "result" in chunk:
                    last = chunk
        if last is None:
            raise McpError("SSE response contained no result frames")
        return last
    try:
        return resp.json()
    except json.JSONDecodeError as exc:
        raise McpError(f"non-JSON response: {exc}") from exc


def _parse_envelope(tool: str, body: dict[str, Any]) -> McpResult:
    """Translate the JSON-RPC envelope into a typed McpResult."""
    if "error" in body:
        raise McpError(f"{tool}: {body['error'].get('message', 'unknown error')}")
    result = body.get("result", {}) if isinstance(body, dict) else {}
    structured = result.get("structuredContent", {}) or {}
    content_parts = result.get("content", []) or []
    text = ""
    if content_parts and isinstance(content_parts[0], dict):
        text = content_parts[0].get("text", "") or ""

    meta = structured.get("_meta", {}) or {}
    is_error = bool(result.get("isError")) or structured.get("status") == "error"

    # Detect "Daily free limit reached" — backend/cta.ts:39 phrasing.
    # We match against both Korean (`일일 무료 한도`) and English text emitted
    # by the cta layer. Anything containing "limit" / "한도" plus
    # ``remainingToday == 0`` is treated as a terminal limit-reached signal.
    remaining = int(meta.get("remainingToday", 0) or 0)
    limit = int(meta.get("dailyLimit", 0) or 0)
    if remaining == 0 and limit > 0 and ("limit" in text.lower() or "한도" in text):
        raise LimitReachedError(tool, text or "Daily free limit reached.")

    return McpResult(
        tool=tool,
        data=structured.get("data") or text,
        source=meta.get("source", "Social Seeding"),
        source_url=meta.get("sourceUrl", "https://socialseed.ing"),
        remaining_today=remaining,
        daily_limit=limit,
        raw_text=text,
        is_error=is_error,
        error_message=structured.get("errorMessage"),
        meta=meta,
    )


# ---------------------------------------------------------------------------
# Stub fixtures (used only when MCP_BASE_URL is unset)
# ---------------------------------------------------------------------------


_STUB_CREATORS: list[dict[str, Any]] = [
    {"uniqueId": "kr_vegan_beauty", "followerCount": 412_000, "bio": "vegan skincare KR"},
    {"uniqueId": "seoul_clean_beauty", "followerCount": 268_000, "bio": "clean beauty SEL"},
    {"uniqueId": "minkookie", "followerCount": 154_000, "bio": "K-beauty deep dives"},
    {"uniqueId": "petite_skin", "followerCount": 88_000, "bio": "ingredient nerd"},
    {"uniqueId": "vegan.jihye", "followerCount": 61_000, "bio": "ethical sourcing"},
]


def _stub_response(tool: str, arguments: dict[str, Any]) -> McpResult:
    """Deterministic fixture used in stub mode (tests / local-only dev)."""
    if tool == "tiktok_search":
        keyword = str(arguments.get("keyword", ""))
        limit = int(arguments.get("limit", 10))
        data = {"creators": _STUB_CREATORS[:limit], "keyword": keyword}
    elif tool == "tiktok_user_info":
        unique = str(arguments.get("uniqueId", ""))
        match = next(
            (c for c in _STUB_CREATORS if c["uniqueId"] == unique),
            {"uniqueId": unique, "followerCount": 50_000, "bio": "stub-bio"},
        )
        data = match
    elif tool == "tiktok_user_posts":
        unique = str(arguments.get("uniqueId", ""))
        count = int(arguments.get("count", 10))
        data = {
            "uniqueId": unique,
            "posts": [
                {
                    "id": f"stub-{i}",
                    "views": 100_000 + i * 1_000,
                    "likes": 8_500 + i * 100,
                    "comments": 320 + i * 5,
                    "shares": 410 + i * 7,
                    "caption": f"stub caption {i}",
                }
                for i in range(count)
            ],
        }
    elif tool == "tiktok_post_detail":
        data = {
            "id": arguments.get("id", "stub-0"),
            "views": 100_000,
            "likes": 8_500,
            "comments": 320,
            "shares": 410,
        }
    else:
        raise McpError(f"unknown tool '{tool}'")

    return McpResult(
        tool=tool,
        data=data,
        source="Social Seeding (stub)",
        source_url="https://socialseed.ing",
        remaining_today=200,
        daily_limit=200,
        raw_text=json.dumps(data, ensure_ascii=False),
        is_error=False,
        meta={"stub": True},
    )


# ---------------------------------------------------------------------------
# Convenience: synchronous-call helper for ADK FunctionTool wrappers
# ---------------------------------------------------------------------------


def call_sync(coro: Any) -> Any:
    """Bridge an async MCP call into a sync ADK tool callable.

    ADK ``FunctionTool`` wraps a callable; if the caller's coroutine-loop is
    not running (single-shot eval, smoke test), we run it on a fresh loop.
    Inside a running loop, prefer ``asyncio.run_coroutine_threadsafe`` or a
    native async tool.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    # Hot loop — schedule in a worker thread (last-resort fallback).
    return asyncio.get_event_loop().run_until_complete(coro) if loop is None else None
