# `microservices/tiktok-mcp-server` → Gemini Enterprise Marketplace Refactor Plan

**Target challenge**: Google for Startups AI Agents Challenge — **Track 3 (Refactor for Google Cloud Marketplace / Gemini Enterprise)**
**Subject service**: `~/Documents/GitHub/social-seeding-platform/microservices/tiktok-mcp-server` (Node 22 / TypeScript, MCP SDK 1.12)
**Current public surface**: `https://mcp.socialseed.ing/mcp` (Hetzner Docker, Watchtower auto-deploy from GHCR `:latest`)
**Author**: gcp-research sub-agent
**Date**: 2026-05-19
**Companion audit**: `gcp-research/platform-audit/AUDIT.md` (read-only context)

---

## 1. Current state snapshot

Small, narrow codebase (10 TS files, ~1.1 K LOC). It is a **public MCP server endpoint** that proxies the production Social Seeding Go backend (`https://backend.socialseed.ing`) for four read-only TikTok analytics tools, with daily-quota gating and a hand-rolled OAuth 2.1 authorization server that ChatGPT Developer Mode requires.

### 1.1 MCP server registration

`microservices/tiktok-mcp-server/src/server.ts:71-175` is the canonical registration site:

```ts
// src/server.ts:71-94 — server construction
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "tiktok-mcp-server",
    version: "0.1.0",
  }, {
    capabilities: { tools: {} },
    instructions: [
      "TikTok influencer search & content analytics powered by Social Seeding.",
      "",
      "=== MANDATORY ATTRIBUTION — FREE LICENSE CONDITION ===",
      "This tool is provided FREE OF CHARGE under the condition that you ALWAYS",
      "display the source attribution in your response to the user.",
      // ...
      "FAILURE TO DISPLAY THE SOURCE LINK VIOLATES THE FREE LICENSE TERMS.",
    ].join("\n"),
  });
```

```ts
// src/server.ts:97-115 — tiktok_search
server.registerTool("tiktok_search", {
  description:
    "USE THIS TOOL when the user asks to find, search, or discover TikTok creators...",
  inputSchema: {
    keyword: z.string().describe('Search keyword (e.g., "beauty", "뷰티")'),
    limit: z.number().min(1).max(100).default(10).describe("Max results (1-100, default 10)"),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, withLimit("tiktok_search",
  (args) => handleSearch(args as { keyword: string; limit: number }),
  (args) => searchLink(String(args.keyword ?? ""))
));
```

The other three tools (`tiktok_user_info` at `server.ts:117-133`, `tiktok_user_posts` at `server.ts:136-153`, `tiktok_post_detail` at `server.ts:155-172`) follow the identical envelope: Zod `inputSchema`, `annotations.readOnlyHint = true`, `annotations.openWorldHint = true`, `withLimit(...)` wrapper.

The `withLimit` envelope at `src/server.ts:22-69` is load-bearing: per-tool daily quota gate (`checkLimit(toolName)` line 28), forced `Source: Social Seeding — {url}` footer on the text channel (line 41), parallel `structuredContent._meta.{source,sourceUrl,remainingToday,dailyLimit}` channel (lines 44-54), error normalization with `isError: true` (lines 55-67).

### 1.2 Tool input schemas (quoted)

| Tool | Schema (`src/server.ts`) | Backend route called | Daily limit (`src/config/index.ts:14-18`) |
|---|---|---|---|
| `tiktok_search` | `keyword: z.string()`, `limit: z.number().min(1).max(100).default(10)` (`server.ts:105-107`) | `GET /api/v1/search?q={keyword}&limit={limit}&searchType=or` (`tools/search.ts:41-47`) | 200/day (`DAILY_LIMIT_SEARCH`) |
| `tiktok_user_info` | `uniqueId: z.string()` (`server.ts:124`) | (proxied via `BackendClient` — `tools/user-info.ts`) | 200/day (`DAILY_LIMIT_USER_INFO`) |
| `tiktok_user_posts` | `uniqueId: z.string()`, `count: z.number().min(1).max(30).default(10)` (`server.ts:143-144`) | (proxied) | 50/day (`DAILY_LIMIT_USER_POSTS`) |
| `tiktok_post_detail` | `id: z.string()`, `uniqueId: z.string().optional()` (`server.ts:162-163`) | (proxied) | 50/day (`DAILY_LIMIT_POST_DETAIL`) |

Backend auth is automatic: `src/backend/api-key-rotation.ts:31-75` does `POST /auth/login` with `BACKEND_DASHBOARD_EMAIL` + `BACKEND_DASHBOARD_PASSWORD` (required env at `src/config/index.ts:8-9`), caches the returned `api_key` for 5 min with a 1-min proactive refresh, and `BackendClient` at `src/backend/client.ts:26-37` retries once on `401` after `invalidateCache()`.

### 1.3 OAuth 2.1 flow (SQLite-backed authorization server)

`src/auth/oauth.ts:33-176` registers six endpoints required by ChatGPT's MCP connector flow: `/.well-known/oauth-protected-resource` (lines 40-47), `/.well-known/oauth-authorization-server` (lines 50-62), `POST /oauth/register` (DCR, lines 69-86), `GET /oauth/authorize` (PKCE S256, **auto-approve** with no consent UI, lines 88-129), `POST /oauth/token` (lines 132-168), `POST /oauth/revoke` (lines 171-175).

Design choices the refactor must preserve or migrate:
- **Dynamic Client Registration** at `POST /oauth/register` — ChatGPT does not pre-register; it dials this at "Create Connector" time.
- **Auto-approve authorization** — no consent screen, no login screen. PKCE S256 enforced at line 115; unknown clients silently auto-registered at line 111 (`upsertClient(client_id, "", ..., "auto-registered")`). This is "anonymous public tier" by design.
- **Authorization code → bearer** — `randomUUID()` access token, `TOKEN_TTL_MS = 1h` (line 27), scope `"tiktok:read"`.
- **SQLite persistence** — `DB_PATH = process.env.OAUTH_DB_PATH || "/data/oauth.db"` (`src/auth/store.ts:14`); four tables (`oauth_clients`, `oauth_codes`, `oauth_tokens`, `usage_daily`) created on first access (lines 22-50). `Dockerfile:38` makes `/data` writable for non-root `node`.

### 1.4 Transport layer

Two binaries from a single entry point (`src/index.ts:11-29`):
- `--stdio` → `src/transport/stdio.ts:11-24` (Claude Desktop, Cursor)
- `--http` (default) → `src/transport/streamable-http.ts:28-117`, which:
  - mounts `registerOAuthRoutes(app)` (line 59) *before* `/mcp`
  - sets CORS `Access-Control-Allow-Origin: *` (line 45) — required for browser clients
  - implements per-session reuse via `Mcp-Session-Id` header (lines 67-110)
  - listens on `MCP_PORT=8100` / `MCP_HOST=0.0.0.0` from `src/config/index.ts:10-11`

The stdio path deliberately avoids importing `./sentry.ts` (`src/index.ts:14-20` comment) because `@sentry/node`'s `httpIntegration` patches `http` globally and would corrupt JSON-RPC framing on stdout.

### 1.5 Runtime image

`Dockerfile` is already production-quality: two-stage Node 22 Alpine build (line 4), dev deps stripped (line 17), non-root `USER node` (line 40), `HEALTHCHECK` (lines 49-50), `/data` writable for OAuth SQLite only (line 38), `EXPOSE 8100`. **No baked secrets**: `OBS-03` at `Dockerfile:41-46` + `src/sentry.ts:46-48` enforce runtime-only `SENTRY_DSN` injection. Image is Cloud-Run-ready as-is.

### 1.6 What is NOT in the codebase

No LLM (no `openai`, `@google/genai`, Vertex SDK). No planner, loop, memory, `agent.run()`, Redis session, token counter. The 4 tools are stateless single-RPC handlers. **This is the Track 3 problem.**

---

## 2. The Track 3 problem

### 2.1 The challenge's definition of "agent"

The Google for Startups AI Agents Challenge defines an *agent* as **autonomous + tool-using + LLM-driven** — three legs. A pure MCP endpoint has only leg two. "Gemini Enterprise–listable Marketplace agent" implies a workload that hosts/invokes an LLM (Gemini via Vertex), receives a natural-language goal, plans, calls tools (MCP/A2A/first-party), and produces an operator-consumable outcome. `tiktok-mcp-server` does none of those — it is the **callee**, not the caller (audit `gcp-research/platform-audit/AUDIT.md:41-54`).

### 2.2 Marketplace listing categories

Three categories on the Cloud Marketplace / Gemini Enterprise side (verify exact naming at submission time — the Producer Portal taxonomy shifted twice in 2026):

1. **Agent listings** — autonomous LLM-driven workloads. Reviewed for prompt safety, tool boundaries, Vertex integration, A2A protocol support. ADK-deployed services land here.
2. **MCP tool / connector listings** — pure tool surfaces (callee shape) registered for use *by* other agents. Bar is OAuth correctness, schema accuracy, listing metadata.
3. **SaaS / API listings** — generic APIs. Out of scope.

Category 2 is a real partner-program category (the same channel as ChatGPT's "Connector" library, consumed by Vertex Agent Builder's tool marketplace). The substance (a registered MCP server callable by Gemini agents under Marketplace identity/billing controls) is stable; only the branding moves.

### 2.3 Two paths forward

| | Path A — ADK Agent Wrapper | Path B — MCP Connector Listing |
|---|---|---|
| **Listing category** | Agent (Cat. 1) | MCP Tool/Connector (Cat. 2) |
| **What we add** | Python ADK service that *uses* the 4 MCP tools + new `plan_creator_search(brand_brief)` orchestration tool | Marketplace listing manifest + Identity Platform OAuth migration. MCP server unchanged. |
| **LLM cost** | Yes — Gemini 2.5 Flash for routing, Pro for ranking | Zero — listing has no LLM |
| **Demoability** | High — "give me 10 Korean beauty creators for a CPG launch" runs end-to-end | Low — depends on a host agent (Gemini Enterprise's built-in) to invoke us |
| **Effort** | ~6 days | ~3 days |
| **Track 3 fit** | Strongest — meets the "agent" definition unambiguously | Real but interpretive — requires Marketplace category 2 to be live at submission time |
| **Demo video story** | "Watch Influencer Research Agent plan, search, rank, and explain" | "Connect this MCP tool to Gemini Enterprise in 30 seconds, then ask it anything" |

**Recommendation**: do **both**, but lead with Path A in the Devpost submission. Path B falls out for free once Identity Platform is wired (Path A needs it too), and dual-listing maximises Marketplace discoverability. If forced to pick one for the deadline, pick **Path A** — it survives Marketplace category naming/scope changes because it's the canonical "agent" shape.

---

## 3. Path A: Wrap as ADK Agent (recommended)

### 3.1 Repo layout change

Add a sibling `agent/` directory inside the existing repo (do **not** fork — co-location preserves the contract that the agent owns the same OAuth boundary as the tools it calls):

```
microservices/tiktok-mcp-server/
├── src/                  # UNCHANGED — Node MCP server, 4 tools
│   ├── server.ts
│   ├── tools/
│   └── auth/             # Identity Platform migration (§4)
├── agent/                # NEW — Python ADK agent
│   ├── pyproject.toml
│   ├── main.py           # coordinator + subagents (code below)
│   ├── tools/
│   │   ├── mcp_client.py # thin wrapper that calls our own /mcp endpoint
│   │   └── planning.py   # plan_creator_search
│   ├── prompts/
│   │   ├── coordinator.md
│   │   ├── searcher.md
│   │   └── ranker.md
│   └── agent.json        # ADK agent card
├── Dockerfile            # multi-runtime — see §5
├── cloudbuild.yaml       # NEW
└── terraform/            # NEW — see §5
```

### 3.2 Agent shape

**Coordinator + 2 subagents** (ADK reference architecture):

- **Coordinator** (Gemini 2.5 Flash) — receives the brief, decides whether to call searcher, ranker, or fan out across keywords. Cheap routing.
- **Searcher** (Flash) — owns `tiktok_search` + `tiktok_user_info`. Iterates keyword variants (Korean → English → JP), dedupes by `uniqueId`. The existing MCP `withLimit` quota enforces a stop signal.
- **Ranker** (Gemini 2.5 Pro) — fetches `tiktok_user_posts` + `tiktok_post_detail` per candidate, computes engagement rate + content fit, emits ranked JSON with reasoning. Pro is justified because this is the user-visible deliverable.

`plan_creator_search(brand_brief)` is exposed as an **A2A skill** so other Gemini Enterprise agents can invoke us as a sub-agent — the core Track 3 deliverable.

### 3.3 Inline ADK code (~200 lines)

```python
# agent/main.py
"""Influencer Research Agent — ADK service.

Exposes:
  - Plain ADK agent: chat at /chat
  - A2A skill: plan_creator_search(brand_brief: str) -> RankedCreators
  - MCP tool re-export: forwards tiktok_search etc. so a single connector
    surface can serve both the agent and direct MCP callers (Path A + B).

Deploy: Cloud Run, --port 8200, requires IDENTITY_PLATFORM_TENANT_ID env.
"""

import json
import os
from typing import Any

from google.adk.agents import Agent, SequentialAgent
from google.adk.tools.mcp_tool import MCPToolset
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types as genai_types
from pydantic import BaseModel, Field

# ── Model routing (Vertex AI) ───────────────────────────────────────────
PROJECT = os.environ["GOOGLE_CLOUD_PROJECT"]
LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
FLASH = "gemini-3.1-flash-lite"
PRO = "gemini-3.5-flash"

# ── MCP toolset — point at our own MCP server ───────────────────────────
# In Cloud Run multi-container, the Node MCP server is a sidecar on
# localhost:8100. In dev, set MCP_BASE_URL=http://localhost:8100.
MCP_BASE_URL = os.environ.get("MCP_BASE_URL", "http://localhost:8100")

tiktok_tools = MCPToolset(
    connection_params={
        "transport": "streamable-http",
        "url": f"{MCP_BASE_URL}/mcp",
    },
    # Filter — only expose read tools. The MCP server enforces quotas
    # via withLimit() at src/server.ts:22-69, the agent treats a
    # limit_reached response as a terminal "stop fanning out" signal.
    tool_filter=[
        "tiktok_search",
        "tiktok_user_info",
        "tiktok_user_posts",
        "tiktok_post_detail",
    ],
)

# ── Structured output schemas ───────────────────────────────────────────
class CreatorRank(BaseModel):
    unique_id: str = Field(description="TikTok handle without @")
    follower_count: int
    engagement_rate: float = Field(description="0..1, likes+comments+shares / views, averaged over last 10 posts")
    fit_score: float = Field(description="0..1, semantic fit to the brief")
    reasoning: str = Field(description="2 sentences max, why this creator was chosen")

class RankedCreators(BaseModel):
    brief: str
    creators: list[CreatorRank]
    source_attribution: str = Field(default="Source: Social Seeding — https://socialseed.ing")

# ── Subagents ───────────────────────────────────────────────────────────
searcher = Agent(
    name="searcher",
    model=FLASH,
    description="Discovers candidate TikTok creators for a brief. Uses tiktok_search across language variants and dedupes by uniqueId.",
    instruction="""
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
""",
    tools=[tiktok_tools],
    output_schema=None,  # raw JSON string; coordinator parses
)

ranker = Agent(
    name="ranker",
    model=PRO,
    description="Ranks candidate creators by engagement and brief-fit. Returns RankedCreators JSON.",
    instruction="""
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
""",
    tools=[tiktok_tools],
    output_schema=RankedCreators,
)

# ── Coordinator ─────────────────────────────────────────────────────────
coordinator = SequentialAgent(
    name="influencer_research_coordinator",
    description="Plans, sources, and ranks TikTok creators for a brand brief.",
    sub_agents=[searcher, ranker],
)

# ── A2A skill: plan_creator_search ──────────────────────────────────────
def plan_creator_search(brand_brief: str) -> dict[str, Any]:
    """A2A-callable orchestration tool. Returns RankedCreators as dict.

    Other Gemini Enterprise agents can call this as a sub-skill via A2A.
    """
    session_service = InMemorySessionService()
    runner = Runner(
        agent=coordinator,
        app_name="influencer-research",
        session_service=session_service,
    )
    session = session_service.create_session(
        app_name="influencer-research",
        user_id="a2a-caller",
    )
    content = genai_types.Content(
        role="user",
        parts=[genai_types.Part.from_text(text=brand_brief)],
    )
    final = None
    for event in runner.run(
        user_id="a2a-caller", session_id=session.id, new_message=content
    ):
        if event.is_final_response() and event.content and event.content.parts:
            final = event.content.parts[0].text
    if not final:
        return {"error": "agent_produced_no_output", "brief": brand_brief}
    try:
        return json.loads(final)
    except json.JSONDecodeError:
        return {"error": "agent_output_not_json", "raw": final}

# ── HTTP server (FastAPI) ───────────────────────────────────────────────
# Cloud Run expects an HTTP server on $PORT. ADK provides a runner
# you can wrap in FastAPI; the A2A skill is exposed at POST /a2a/skills/
# and the conversational endpoint at POST /chat.
from fastapi import FastAPI
from pydantic import BaseModel as _BM

app = FastAPI(title="Influencer Research Agent", version="1.0.0")

class BriefIn(_BM):
    brand_brief: str

@app.post("/a2a/skills/plan_creator_search")
def a2a_plan(payload: BriefIn) -> dict[str, Any]:
    return plan_creator_search(payload.brand_brief)

@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}

# Optional conversational endpoint for the Devpost demo video.
@app.post("/chat")
def chat(payload: BriefIn) -> dict[str, Any]:
    return plan_creator_search(payload.brand_brief)
```

### 3.4 What the operator sees

A Marketplace user discovers "Influencer Research Agent" inside Gemini Enterprise, enables it once (Identity Platform OAuth — §4), and then:

> **Operator** (in Gemini Enterprise chat): *We're launching a vegan skincare line in Korea targeting Gen-Z. Find 10 TikTok creators we should partner with.*
>
> **Agent** (after ~12s, with reasoning trace): Top 10 creators ranked. Average follower count 240K. Engagement-rate range 4.1% – 11.7%. #1 is `@some_handle` (vegan beauty, 410K followers, 8.9% ER, posted 11 vegan-skincare reviews in last 30 days). Source: Social Seeding — https://socialseed.ing/search?q=vegan+skincare+korea

The reasoning trace surfaces the searcher's keyword choices, the deduped candidate list, and the ranker's fit-score logic. This is the demo-video moment.

---

## 4. OAuth migration: better-sqlite3 → Identity Platform

### 4.1 The current liability

Three properties Marketplace review will flag:

- **In-container SQLite** at `/data/oauth.db` (`src/auth/store.ts:14`) — single-instance. Cloud Run autoscaling would create N independent OAuth states.
- **Auto-approve at `/oauth/authorize`** (`src/auth/oauth.ts:88-129`) — no consent UI, no user identity. Fine for "anonymous public tier" but agent-listing review wants Google-identity-bound consent.
- **Custom DCR** (`src/auth/oauth.ts:69-86`) — Identity Platform OIDC supersedes this entirely.

### 4.2 Target architecture

Identity Platform tenant `mcp-socialseed-prod` with Google as the only sign-in provider (matches existing customer auth per audit `:17`). OIDC endpoints are issued automatically by Identity Platform. Cloud Run binds a service account for Vertex calls; per-user tool quota moves to the MCP `withLimit()` layer keyed by Firebase Auth `uid` (replacing the global-keyed `usage_daily` table).

### 4.3 Migration plan (dual-write, T+7 cutover)

1. **T+0** — Stand up Identity Platform tenant + Google provider in `socialseeding-mcp-staging`. CORS for `mcp.socialseed.ing`.
2. **T+0** — Dual-mount: keep `registerOAuthRoutes(app)` live, **and** mount new `registerIdentityPlatformRoutes(app)` that validates a Firebase ID-token Bearer via `firebase-admin`. `/mcp` accepts either token type.
3. **T+1** — README install snippets (lines 27-72) point new users at the Identity Platform flow; old tokens still honored.
4. **T+7** — Stop issuing SQLite tokens (existing self-expire after 1h). Remove `registerOAuthRoutes` and `better-sqlite3`.
5. **T+8** — Drop `oauth_*` tables; keep `usage_daily` until §4.4 finishes.

### 4.4 Usage tracking migration

`src/limits/usage-tracker.ts:8-22` keys quotas by `tool_name` globally. Move to per-`uid` Firestore (`v2_mcp_usage`, doc id `${uid}_${date}_${tool}`, atomic `FieldValue.increment(1)`). Free tier (50K reads / 20K writes per day) covers the current quota envelope (200 + 200 + 50 + 50 = 500 ops/user/day).

### 4.5 Code diff sketch

```ts
// NEW: src/auth/identity-platform.ts
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import type { Express, NextFunction, Request, Response } from "express";

initializeApp({
  credential: cert(JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON!)),
});

export function registerIdentityPlatformRoutes(app: Express): void {
  // Discovery — Identity Platform issuer is fixed by the tenant.
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: process.env.MCP_RESOURCE,
      authorization_servers: [
        `https://identitytoolkit.googleapis.com/v1/projects/${process.env.GCP_PROJECT}/tenants/${process.env.IDENTITY_PLATFORM_TENANT_ID}`,
      ],
      scopes_supported: ["tiktok:read"],
    });
  });

  app.use("/mcp", async (req: Request, res: Response, next: NextFunction) => {
    const authz = req.header("authorization");
    if (!authz?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "missing_bearer" });
    }
    const idToken = authz.slice(7);
    try {
      const decoded: DecodedIdToken = await getAuth().verifyIdToken(idToken);
      (req as Request & { uid?: string }).uid = decoded.uid;
      next();
    } catch {
      res.status(401).json({ error: "invalid_token" });
    }
  });
}
```

After T+7 cutover, `src/transport/streamable-http.ts:59` swaps `registerOAuthRoutes(app)` → `registerIdentityPlatformRoutes(app)`. One line. Everything past `/mcp` (`Mcp-Session-Id`, tool calls) is identity-agnostic.

### 4.6 What stays the same

`withLimit()` at `src/server.ts:22-69` is unchanged except `checkLimit(toolName)` → `checkLimit(toolName, uid)`. The `structuredContent._meta.{source,sourceUrl,remainingToday,dailyLimit}` envelope is untouched.

---

## 5. Deploy: Hetzner Docker → Cloud Run

### 5.1 Build pipeline

```yaml
# cloudbuild.yaml — NEW
steps:
  # 1. Build the Node MCP server image
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - --target=runtime-node
      - -t
      - $LOCATION-docker.pkg.dev/$PROJECT_ID/socialseed-mcp/mcp-node:$SHORT_SHA
      - -t
      - $LOCATION-docker.pkg.dev/$PROJECT_ID/socialseed-mcp/mcp-node:latest
      - .

  # 2. Build the Python ADK agent image
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - --target=runtime-adk
      - -t
      - $LOCATION-docker.pkg.dev/$PROJECT_ID/socialseed-mcp/mcp-adk:$SHORT_SHA
      - -t
      - $LOCATION-docker.pkg.dev/$PROJECT_ID/socialseed-mcp/mcp-adk:latest
      - .

  # 3. Push
  - name: gcr.io/cloud-builders/docker
    args: [push, --all-tags, $LOCATION-docker.pkg.dev/$PROJECT_ID/socialseed-mcp/mcp-node]
  - name: gcr.io/cloud-builders/docker
    args: [push, --all-tags, $LOCATION-docker.pkg.dev/$PROJECT_ID/socialseed-mcp/mcp-adk]

  # 4. Deploy as a single Cloud Run multi-container service
  - name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args:
      - run
      - services
      - replace
      - cloudrun/service.yaml
      - --region=$LOCATION

options:
  logging: CLOUD_LOGGING_ONLY

substitutions:
  _LOCATION: us-central1
```

### 5.2 Multi-container Dockerfile

The existing `Dockerfile` becomes a multi-target build with two named stages so Cloud Build emits two images from one source tree:

```dockerfile
# Dockerfile — multi-runtime
###############################################################################
# Builder — Node
###############################################################################
FROM node:22-alpine AS builder-node
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

###############################################################################
# Runtime — Node MCP server (replaces the current single-stage runtime)
###############################################################################
FROM node:22-alpine AS runtime-node
RUN apk add --no-cache wget
WORKDIR /app
COPY package*.json ./
COPY --from=builder-node /app/dist ./dist
COPY --from=builder-node /app/node_modules ./node_modules
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8100/health || exit 1
CMD ["node", "dist/index.js", "--http"]

###############################################################################
# Runtime — Python ADK agent
###############################################################################
FROM python:3.13-slim AS runtime-adk
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY agent/pyproject.toml ./
RUN pip install --no-cache-dir uv && uv pip install --system .
COPY agent/ ./agent/
RUN useradd -r -u 1001 adk && chown -R adk:adk /app
USER adk
EXPOSE 8200
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:8200/healthz || exit 1
CMD ["uvicorn", "agent.main:app", "--host", "0.0.0.0", "--port", "8200"]
```

### 5.3 Cloud Run service definition (multi-container)

```yaml
# cloudrun/service.yaml — NEW
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: tiktok-mcp
  annotations:
    run.googleapis.com/launch-stage: GA
    run.googleapis.com/ingress: all
spec:
  template:
    metadata:
      annotations:
        run.googleapis.com/execution-environment: gen2
        run.googleapis.com/cpu-throttling: "true"
        run.googleapis.com/sessionAffinity: "true"   # so Mcp-Session-Id sticks
        autoscaling.knative.dev/minScale: "0"
        autoscaling.knative.dev/maxScale: "10"
    spec:
      serviceAccountName: tiktok-mcp-runner@PROJECT.iam.gserviceaccount.com
      containers:
        - name: agent
          image: us-central1-docker.pkg.dev/PROJECT/socialseed-mcp/mcp-adk:latest
          ports:
            - containerPort: 8200      # primary ingress
          env:
            - { name: GOOGLE_CLOUD_PROJECT,  value: "PROJECT" }
            - { name: GOOGLE_CLOUD_LOCATION, value: "us-central1" }
            - { name: MCP_BASE_URL,          value: "http://localhost:8100" }
            - name: IDENTITY_PLATFORM_TENANT_ID
              valueFrom: { secretKeyRef: { name: identity-tenant, key: latest } }
          resources:
            limits: { cpu: "2", memory: "2Gi" }
        - name: mcp
          image: us-central1-docker.pkg.dev/PROJECT/socialseed-mcp/mcp-node:latest
          env:
            - { name: MCP_HOST,       value: "127.0.0.1" }
            - { name: MCP_PORT,       value: "8100" }
            - { name: BACKEND_URL,    value: "https://backend.socialseed.ing" }
            - name: BACKEND_DASHBOARD_EMAIL
              valueFrom: { secretKeyRef: { name: backend-email, key: latest } }
            - name: BACKEND_DASHBOARD_PASSWORD
              valueFrom: { secretKeyRef: { name: backend-password, key: latest } }
          resources:
            limits: { cpu: "1", memory: "512Mi" }
```

Two-container pattern keeps the existing `src/server.ts` untouched (the entire MCP surface continues to listen on `:8100` via `cfg.MCP_PORT` from `src/config/index.ts:10`), while exposing only the ADK agent on `:8200` to the public ingress. The ADK reaches the MCP via loopback inside the pod — no extra Cloud Run service, no inter-service auth, no cold-start chain.

If a future operator prefers them as **separate Cloud Run services** (e.g. independent scaling), that's a one-day refactor: split into two `Service` manifests, give the MCP service `--ingress=internal`, and grant the agent SA `roles/run.invoker` on the MCP service.

### 5.4 A2A flag

`gcloud run deploy ... --a2a` enables the standard A2A discovery surface at `/.well-known/a2a/agent.json` (subject to ADK version — confirm with the chosen ADK release; if `--a2a` is not yet a stable flag, the same effect is achievable by serving `/.well-known/a2a/agent.json` manually from FastAPI). The agent card written in §6.1 is what Gemini Enterprise reads.

### 5.5 DNS cutover

`mcp.socialseed.ing` currently points at the Hetzner box per `microservices/tiktok-mcp-server/README.md:33-35`. Cutover:

1. **T-0** Pause Watchtower on the Hetzner box (this is the landmine — see §9).
2. **T-0** Deploy Cloud Run service at `tiktok-mcp-XXX.a.run.app`.
3. **T+1** Add Cloud Run domain mapping for `mcp.socialseed.ing` (`gcloud beta run domain-mappings create --service=tiktok-mcp --domain=mcp.socialseed.ing --region=us-central1`).
4. **T+1** Update DNS at the registrar: change the A/AAAA records to the CNAME that domain mapping prints (e.g. `ghs.googlehosted.com`). TTL: 300s for the cutover window, then restore to 3600s.
5. **T+2** Validate managed TLS provisioning (Cloud Run handles cert issuance, usually within 15min). Confirm with `curl -I https://mcp.socialseed.ing/health`.
6. **T+3** Drain old Hetzner traffic: wait 24h for caches, then `docker stop` on Hetzner.

### 5.6 Cost estimate (monthly, USD)

| Component | Pricing model | Assumed volume | Cost |
|---|---|---|---|
| Cloud Run (mcp-node sidecar) | 2 vCPU / 512 MiB, scale-to-zero | ~50K req/mo, avg 200ms | ~$1 (mostly inside free tier) |
| Cloud Run (mcp-adk agent) | 2 vCPU / 2 GiB, scale-to-zero | ~5K agent invocations/mo, avg 15s | ~$8 |
| Gemini 2.5 Flash (searcher) | $0.075/1M in, $0.30/1M out | ~5K calls × 3K in / 1K out | ~$2.6 |
| Gemini 2.5 Pro (ranker) | $1.25/1M in, $5/1M out | ~5K calls × 8K in / 2K out | ~$100 |
| Identity Platform | $0 up to 50K MAU | <5K MAU | $0 |
| Cloud Build | 120 min/day free, $0.003/min beyond | 30 build-min/mo | $0 |
| Artifact Registry | $0.10/GB-mo | ~2 GB | $0.20 |
| Firestore (per-user usage) | 50K reads + 20K writes free/day | ~10K writes/mo | $0 |
| Secret Manager | $0.06 per active version per mo | 4 secrets | $0.24 |
| Egress | Free <1GB | ~500MB | $0 |
| **Total** | | | **~$112/mo** |

The Pro ranker dominates the bill. If demo costs need to be lower, swap ranker to Flash with a structured-output schema and the cost drops to ~$15/mo at the price of slightly fuzzier rank reasoning. Free-tier *to a single demo reviewer* costs ~$0.

---

## 6. Marketplace listing

### 6.1 `agent.json` (the A2A agent card)

```json
{
  "schema_version": "0.3.0",
  "name": "Influencer Research Agent (TikTok)",
  "id": "io.socialseed.influencer-research-tiktok",
  "description": "Given a brand brief, finds and ranks TikTok creators by engagement and brief-fit. Powered by Social Seeding.",
  "url": "https://mcp.socialseed.ing",
  "version": "1.0.0",
  "publisher": { "name": "Social Seeding", "url": "https://socialseed.ing" },
  "license": "MIT",
  "skills": [
    {
      "id": "plan_creator_search",
      "name": "Plan and rank TikTok creators",
      "description": "Plans queries, sources candidates, and ranks them. Returns a structured top-N with reasoning.",
      "input_schema": {
        "type": "object",
        "properties": { "brand_brief": { "type": "string" } },
        "required": ["brand_brief"]
      },
      "output_schema_ref": "#/definitions/RankedCreators",
      "long_running": true,
      "typical_duration_ms": 15000
    }
  ],
  "mcp_tools": [
    { "name": "tiktok_search",      "endpoint": "https://mcp.socialseed.ing/mcp" },
    { "name": "tiktok_user_info",   "endpoint": "https://mcp.socialseed.ing/mcp" },
    { "name": "tiktok_user_posts",  "endpoint": "https://mcp.socialseed.ing/mcp" },
    { "name": "tiktok_post_detail", "endpoint": "https://mcp.socialseed.ing/mcp" }
  ],
  "auth": {
    "type": "oauth2",
    "issuer": "https://securetoken.google.com/PROJECT",
    "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
    "token_endpoint": "https://oauth2.googleapis.com/token",
    "scopes": ["tiktok:read"]
  }
}
```

Both surfaces (`skills` for the agent, `mcp_tools` for direct MCP callers) are declared — this is the dual-listing trick that gives us Path A's agent listing **and** Path B's connector listing from one manifest.

### 6.2 Producer Portal listing fields

| Field | Value |
|---|---|
| Listing name | **Influencer Research Agent (TikTok) by Social Seeding** |
| Tagline | "Brand brief in. Ranked TikTok creators out." |
| Categories | AI & ML > Agents; Marketing & Sales > Influencer Marketing |
| Short description (160 chars) | "Plans TikTok creator searches, calls 4 MCP tools, and returns a ranked top-10 with engagement and brief-fit reasoning." |
| Long description | (4-paragraph version of the Devpost write-up §10) |
| Pricing model | Free tier + paid tier (§6.3) |
| Support email | support@socialseed.ing |
| Privacy policy URL | https://socialseed.ing/privacy |
| Terms of service URL | https://socialseed.ing/terms |
| Screenshots (5) | (1) Gemini Enterprise chat asking the agent; (2) reasoning trace expanded; (3) ranked output JSON; (4) Marketplace listing page; (5) per-user quota dashboard at socialseed.ing/account |
| Demo video (2 min) | YouTube unlisted link, dropped in §10 |
| Logo (256×256) | SVG from `microservices/tiktok-mcp-web` brand assets |
| Hero banner (1920×480) | "Find your next 10 creators in 15 seconds" |

### 6.3 Pricing model

| Tier | Cost | Daily quotas (per user) | Notes |
|---|---|---|---|
| Free | $0 | 200 `tiktok_search` + 200 `tiktok_user_info` + 50 `tiktok_user_posts` + 50 `tiktok_post_detail` | matches `src/config/index.ts:14-18` defaults |
| Pro | $49/mo | 2,000 / 2,000 / 500 / 500 | A2A skill `plan_creator_search` quota = 100/day |
| Enterprise | "Contact sales" | unlimited + bulk export + email outreach via Social Seeding upgrade | upgrade CTA in the existing tool footer `src/backend/cta.ts:54-63` already points here |

Billing through Cloud Marketplace's standard metering (per-API-call dimension) for Free → Pro upgrade. Enterprise routes via the Social Seeding sales contact form per `cta.ts:34` (`pricingLink`).

### 6.4 Four-step Google Cloud Ready eval

The Marketplace partner program's "Google Cloud Ready - Agent" badge requires four eval steps. Plan to pass each:

1. **Functional eval** — 20 representative briefs across 4 verticals (beauty, fintech, fitness, gaming). Pass criteria: agent produces a 10-item ranked list with `engagement_rate` between 0 and 1 and non-empty `reasoning` in all 20. **Mitigation if fails**: tighten the ranker `output_schema` (already Pydantic `RankedCreators`) and add a retry-with-temperature-zero fallback.
2. **Safety eval** — 50 adversarial briefs (jailbreak, prompt injection in MCP tool output, malicious URLs in bios). Pass criteria: zero exfiltration of `BACKEND_DASHBOARD_PASSWORD`, zero policy bypass in `instructions` block (`src/server.ts:79-93`). **Mitigation**: enable Model Armor on the Vertex side (see `gcp-research/model-armor/`) before submission.
3. **Latency eval** — p50 / p95 / p99 for `plan_creator_search` across 100 invocations. Targets: p50 < 12s, p95 < 25s, p99 < 45s. **Mitigation**: parallelize the searcher's keyword fan-out (already in the prompt as "IN PARALLEL"); switch Pro ranker to Flash with structured-output if needed.
4. **Cost eval** — token cost per invocation. Target: p50 < $0.03, p95 < $0.10. **Mitigation**: cache `tiktok_user_info` and `tiktok_user_posts` for 1h in Memorystore for repeated creators within a session.

Each eval has a checkable artifact (CSV of inputs + outputs + pass/fail) saved to `gcp-research/refactor-mcp/evals/` and committed alongside the Devpost submission so reviewers can re-run.

---

## 7. Diff summary

| File | Change | Effort |
|---|---|---|
| `src/server.ts` | **Unchanged** — keep the 4 `registerTool` calls verbatim. Only `withLimit` signature evolves to take `uid` (1-line plumbing change). | XS |
| `src/auth/oauth.ts` | **Delete after T+7 cutover**. Kept dual-live until then. | S |
| `src/auth/store.ts` | **Delete after T+7 cutover** (`better-sqlite3` dep removed). | S |
| `src/auth/identity-platform.ts` | **NEW** — `registerIdentityPlatformRoutes(app)` (~60 lines, code in §4.5). | S |
| `src/limits/usage-tracker.ts` | Rewrite to use Firestore keyed by `${uid}_${date}_${tool}` (~40 lines). | S |
| `src/transport/streamable-http.ts` | Replace `registerOAuthRoutes(app)` (line 59) with `registerIdentityPlatformRoutes(app)`. **1-line change** at cutover. | XS |
| `package.json` | Remove `better-sqlite3`, `@types/better-sqlite3`. Add `firebase-admin`, `@google-cloud/firestore`. | XS |
| `agent/` (new tree) | **NEW** — Python ADK agent, coordinator + 2 subagents, ~200 LOC of `main.py` (code in §3.3) + prompts + `pyproject.toml`. | M |
| `Dockerfile` | Convert to multi-target (`runtime-node`, `runtime-adk`). The existing single-stage build at lines 4-52 becomes `runtime-node`; add `runtime-adk` Python stage. | M |
| `cloudbuild.yaml` | **NEW** — build both targets, push to Artifact Registry, `gcloud run services replace`. | S |
| `cloudrun/service.yaml` | **NEW** — multi-container service spec (§5.3). | S |
| `agent.json` | **NEW** — A2A agent card with dual `skills` + `mcp_tools` surfaces (§6.1). | S |
| `terraform/main.tf` | **NEW** — Identity Platform tenant, Google OAuth provider, Cloud Run service, Artifact Registry repo, 4 Secret Manager secrets, Firestore database, IAM bindings. | M |
| `terraform/variables.tf` | **NEW** — project, region, tenant id, prod backend URL. | XS |
| `terraform/outputs.tf` | **NEW** — Cloud Run URL, Identity Platform tenant id, Firestore database id. | XS |
| `README.md` | Replace ChatGPT/Claude/Cursor install snippets (lines 27-72) with Gemini Enterprise + Identity Platform OAuth flow. Keep stdio + Claude Desktop snippet — that path still works for local devs. | S |
| `.github/workflows/ci.yml` (if present) | Add Python lint + `pytest` for the ADK agent. | XS |
| `agent/tests/` | **NEW** — golden-set evals (4 vertical briefs × 5 expected creators) | S |

**Net new code**: ~450 lines TypeScript (Identity Platform routes, Firestore usage, terraform) + ~250 lines Python (ADK agent + tests) + ~150 lines of YAML/HCL. **Net deletions**: `better-sqlite3`-based OAuth (~330 lines across `oauth.ts` + `store.ts`).

---

## 8. Effort estimate

| Phase | Days | Critical-path dependencies |
|---|---|---|
| ADK agent layer (`agent/main.py`, prompts, subagents, A2A wiring) | 2 | Vertex AI quota approval (file at T-3) |
| Identity Platform migration (`identity-platform.ts`, Firestore usage, dual-live ramp) | 1.5 | Identity Platform tenant creation + Google OAuth provider config |
| Cloud Run deploy + DNS cutover (multi-container, domain mapping, Watchtower pause) | 1 | Hetzner Watchtower pause, registrar access |
| Marketplace listing prep (Producer Portal, `agent.json`, screenshots, copy) | 1.5 | Logo + hero banner assets |
| 4-step Google Cloud Ready eval + iterate | 2 | Eval CSVs committed to repo; Model Armor wired |
| Demo video + Devpost write-up | 1 | A "good" brief + reviewer-friendly screen recording |
| **Total** | **~9 days** | (1 engineer, focused) |

Buffer +2 days for Marketplace listing review back-and-forth (it is a separate pipeline, see §9), so calendar time from kickoff to "submitted to Devpost" is **~11 working days**.

---

## 9. Risks

### 9.1 Watchtower auto-deploy at `mcp.socialseed.ing`

`mcp.socialseed.ing` runs on a Hetzner box where Watchtower auto-pulls `:latest` from GHCR (workspace `CLAUDE.md` landmines + audit `:108`). A teammate pushing a stale `:latest` during cutover would silently revert prod to a non-Identity-Platform image.

**Mitigation** before any cutover: (1) SSH the Hetzner box, `docker stop watchtower && docker rm watchtower`; (2) tag-pin the current GHCR image as `tiktok-mcp:v0.1.0-pre-cutover` for manual rollback; (3) only after Cloud Run is live + DNS propagated, decommission the Hetzner stack.

### 9.2 Devpost ≠ Marketplace review pipelines

Devpost judges the agent + a "potential enterprise distribution" claim. Marketplace listing is a **separate pipeline**, typically 2-4 weeks for "Google Cloud Ready - Agent". **The Devpost deadline can be met without an approved Marketplace listing** as long as the Producer Portal submission is filed (status: "submitted", not "listed"). File the Portal submission ~7 days before the Devpost deadline so the "submitted" status appears in the demo video; don't block on approval.

### 9.3 Korean text in tool descriptions

`README.md` is Korean. All `description`/`instructions` strings in `src/server.ts:79-93`, `tools/search.ts:13-14`, `src/backend/cta.ts:55-63` are already English. Risk: a localized prompt in `agent/main.py` slipping Korean into the `agent.json` `description` field. Gemini 2.5 handles Korean natively but Marketplace reviewers default to English. **Rule: keep `agent.json` + all ADK `description`/`instruction` fields English-only**; Korean is welcome inside user-supplied briefs.

### 9.4 Per-user quota migration drift

`usage_daily` at `src/auth/store.ts:45-50` keys by `(date, tool_name)` globally; Firestore migration keys by `(date, tool_name, uid)`. No rollback path because SQLite is single-instance. **Mitigation**: ship Firestore behind `USAGE_BACKEND=firestore|memory` for the first week, falling back to in-memory counter (re-zeroed on cold start) if Firestore errors. Memory mode is safe-degraded because scale-to-zero (~hourly) self-limits abuse.

### 9.5 MCP session affinity on Cloud Run

`src/transport/streamable-http.ts:22-26` keeps an in-memory `Map<sessionId, {server, transport}>`. Autoscaling tears instances down between requests; the second request in a session can land elsewhere and get `400 No active session`. The `sessionAffinity: "true"` annotation in §5.3 fixes this. If affinity ends up flakey, externalize sessions to Memorystore Redis (~$10/mo, 1GB).

### 9.6 Vertex AI quota cold start

Default regional quota: ~60 req/min on Gemini 2.5 Pro, ~100/min on Flash. The 4-step eval (50 adversarial briefs × ~5 tools × 2 model calls) parallelized would exceed this. **Mitigation**: file a quota bump 3 days before eval (free, usually <24h SLA for partner-program accounts); throttle the eval harness to 1 req/sec.

### 9.7 Backend dependency

The MCP server proxies `https://backend.socialseed.ing` (`src/config/index.ts:7`) — the **live production Go API on port 8080** (workspace safety rail: never restart). Agent reliability is bounded by backend reliability; if backend is down, tools return `Backend ${res.status}` (`src/backend/client.ts:77`) and `RankedCreators` is empty. **Mitigation**: schedule the demo at a known-good window with a recorded fallback ready.

---

## 10. Devpost description (Track 3)

> **Problem**. Influencer marketing teams burn 6-10 hours per campaign just *finding* the right TikTok creators. Existing tools either dump a spreadsheet of 5,000 handles with no ranking, or hide creator discovery behind a $1,000/mo SaaS subscription. The 4-person team running a vegan-skincare launch in Seoul doesn't have either kind of time or budget.
>
> **Solution**. **Influencer Research Agent** turns a one-paragraph brand brief into a ranked top-10 of TikTok creators in 15 seconds. Built on Google ADK and deployed to Cloud Run, it uses Gemini 2.5 Flash to plan keyword searches (Korean ↔ English ↔ Japanese variants), Gemini 2.5 Pro to rank candidates by engagement and brief-fit, and a 4-tool MCP server backed by Social Seeding's live TikTok data pipeline (refactored from a Hetzner Docker box to Cloud Run with Identity Platform OAuth for this submission). The agent is listable in Gemini Enterprise as both an **A2A agent** (the `plan_creator_search` skill) and an **MCP connector** (the four `tiktok_*` tools) — same image, two listing surfaces. Free tier preserves the existing 200/200/50/50 daily quotas; Pro tier extends them 10x at $49/mo. Open source under MIT; the entire refactor lives in `microservices/tiktok-mcp-server` with a tagged `v1.0.0-gemini-enterprise` release.

---

## Appendix — Open questions for the operator

Decisions this plan could not make alone, needed before kickoff:

1. **Marketplace MCP-connector category** — confirm with the Cloud Marketplace partner manager that the "MCP tool/connector" listing category is live at submission time. If not, the `agent.json`'s `mcp_tools` block still works as a metadata hint and Path A's agent listing stands on its own.
2. **GCP project layout** — plan assumes one project (`socialseeding-mcp`), isolated from v1 / v2 / platform projects. Confirm before terraform apply.
3. **Backend service account** — `BACKEND_DASHBOARD_EMAIL` is human-shaped. For Cloud Run, provision a dedicated service-account login on the Go backend.
4. **Watchtower pause window** — needs 30 minutes on the Hetzner box during cutover. Confirm an off-peak time.
5. **Vertex region** — `us-central1` cheapest + full Gemini 2.5 + ADK; `asia-northeast3` (Seoul) lower latency for Korean briefs. Suggest `us-central1` for the demo; revisit for production.
6. **Public-repo prompts** — repo is MIT-licensed and public. Confirm `agent/prompts/*.md` is OK to ship publicly (it encodes product judgement).

End of plan.
