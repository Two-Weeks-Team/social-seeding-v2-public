# `social-seeding-platform` — Google Cloud AI Agents Challenge Fit Audit

**Date**: 2026-05-19
**Scope (read-only)**: `~/Documents/GitHub/social-seeding-platform/` + its submodules
**Auditor**: sub-agent for the v2 GCP research pass

---

## 1. Component inventory

| # | Service | Language / Framework | Port | Role | Current hosting | Agent / LLM involvement |
|---|---|---|---|---|---|---|
| 1 | `core/backend` (Go API + scheduler + workers) | Go 1.25, Gin/Fiber, MongoDB Atlas, Qdrant, Redis | **8080 prod**, 8081 test | Public REST API, load-balances 6× Vultr scraper fleet, cron scheduler, key rotation, circuit breaker. Single binary entrypoint at `core/backend/cmd/server/main.go:1-100`. | Docker on bare-metal / Hetzner (per workspace CLAUDE.md). nginx + certbot in front. | **No.** Pure deterministic API. Calls scrapers + caches; no LLM. |
| 2 | `core/backend/agent_service` (Python) | FastAPI 0.135, OpenAI SDK 2.30, `mcp>=1.26.0`, Redis, structlog | **8090** | **The actual agent.** ReAct loop with auto-summarization at 80k tokens (`core/backend/agent_service/app/agent.py:29-294`), Vercel-AI-SDK streaming, 5 MCP servers as the tool fabric, Redis session memory, rate-limit + cost reporter, Sentry. | Docker (`docker-compose.agent.prod.yml:17-49`) on backend host; 2 CPU / 2 GB limit. | **Yes — full agent.** Driver model = `gpt-5.4-mini` (OpenAI) per `app/config.py:24`. 21-tool ReAct, multi-turn Redis memory, tier-based rate limit, grounded suggestion follow-ups. |
| 3 | `core/backend/agent_service/mcp_servers/*` (4 internal MCP servers) | TypeScript per service: `influencer-mcp`, `campaign-mcp`, `email-mcp`, `bookmark-mcp` | 8191-8194 | Tool endpoints the agent calls over `streamable-http` (`agent_service/mcp.json:1-34`). | Docker, same compose stack. | **No (tool side).** They serve MCP tools, they do not think. |
| 4 | `core/backend/web` (Dashboard) | Next.js 16.2, React 19, **better-auth 1.6.9 on MongoDB** | **9001** | Internal admin dashboard; bound to **production** Atlas (`core/backend/web/lib/auth.ts:8-19, 35-41`). Started by `_scripts/deploy/deploy-web.sh start` only. | Same backend host, behind `backend.socialseed.ing/dashboard`. | **No.** Read-only ops UI; the dashboard does not host the agent. |
| 5 | `core/frontend` (Customer SaaS) | Next.js 16, React 19, **NextAuth 4.24** + Google OAuth, `@ai-sdk/openai`, `ai@6`, `openai@6` | 3000 dev / Vercel prod | Customer-facing chat + workflow UI. Proxies the agent's SSE stream and renders Vercel-AI-SDK Data Stream events. | **Vercel** (per `Port Map` in `README.md:289-303`). | **Partial — host only.** No agent code on this side. It calls `:8090` (and its own `/api/*` routes wrap OpenAI for niche utilities). |
| 6 | `core-services/tiktok-user-info` | Go 1.x, Fiber v3, chromedp pool (or nodriver) | 8082 | TikTok profile scraping | 6× Vultr nodes per workspace doc; Watchtower auto-pull from GHCR. | No. |
| 7 | `core-services/tiktok-user-posts` | Go, Fiber v3, chromedp + Node puppeteer-stealth | 8083 | Posts scraping | Same. | No. |
| 8 | `core-services/tiktok-search-users` | Go, Fiber v2, chromedp | 8084 | Keyword → users | Same. | No. |
| 9 | `core-services/tiktok-post-detail` | Go, Fiber v2, chromedp | 8085 | Post detail | Same. | No. |
| 10 | `core-services/tiktok-scraper-api` | Python 3.11, FastAPI, **nodriver** PagePool | 8089 | Endpoint-compatible Python rewrite of the 4 Go scrapers | Vultr | No. |
| 11 | `core-services/nodriver` | Python (CDP browser automation library) | — | Library, not a service | — | No. |
| 12 | `microservices/tiktok-mcp-server` | Node 22 / TypeScript, `@modelcontextprotocol/sdk`, better-sqlite3 (OAuth) | **8100** | **Public-facing MCP server** at `mcp.socialseed.ing`. 4 tools (`tiktok_search`, `tiktok_user_info`, `tiktok_user_posts`, `tiktok_post_detail`). Daily per-tool quotas (`PROGRESS.md:74-82`). | Docker multi-stage image, non-root, `HEALTHCHECK` (`microservices/tiktok-mcp-server/Dockerfile:25-52`). Deployed to `mcp.socialseed.ing` (`README.md` line 27-37). | **No (tool side).** Exposes tools to *other* agents (ChatGPT, Claude Desktop, Cursor). |
| 13 | `microservices/tiktok-mcp-web` | — | — | Not yet deployed (landing page placeholder per `CLAUDE.md:50`). | — | — |

Cross-cut infra: MongoDB Atlas (prod) + local Mongo (test), Redis (`:6381` prod / `:6380` test), Meilisearch (`:7700/7701`), Qdrant (`:6333/6335`), Prometheus + Grafana, Sentry (`agent_service/app/sentry_setup.py`).

---

## 2. Agent-ness assessment

**Where is the agentic behavior?** Exactly one place: `core/backend/agent_service/`. It is a hand-rolled **ReAct loop** with these load-bearing pieces:

- **Multi-step planning loop**: `Agent.run()` at `core/backend/agent_service/app/agent.py:267-294` runs up to `max_steps=50` (`app/config.py:44`) tool-call iterations, yielding Vercel-AI-SDK `start-step` / `tool-input-*` / `tool-output-available` / `finish-step` events.
- **Tool use**: 21 tools dispatched through 5 MCP servers (`agent_service/mcp.json:1-34`), grouped in the system prompt at `main.py:98-177` ("MANDATORY: Tool Usage Rules … You MUST use them for ANY data-related question.").
- **Stateful memory**: Redis-backed multi-turn history with cursor pagination (`app/memory/redis_memory.py`), conversation summarization above 80k tokens (`app/agent.py:134-265`), session sharing, voting, edit/delete.
- **LLM-driven follow-ups**: A second short LLM call generates grounded suggestion chips (`main.py:718-779`).
- **Cost & rate control**: Atomic per-tier `check_and_consume` (`main.py:444-487`), Sentry, structured cost reporter to the Go backend (`main.py:534-545`).

**Is `tiktok-mcp-server` (`microservices/`) an "agent"?** **No — it is a tool endpoint.** It registers MCP tools and serves them; it has no LLM, no planner, no loop. From `microservices/tiktok-mcp-server/src/server.ts:71-115`:

```ts
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "tiktok-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: [...] });
  server.registerTool("tiktok_search", { description: "USE THIS TOOL when ...",
    inputSchema: { keyword: z.string(), limit: z.number()... } },
    withLimit("tiktok_search", (args) => handleSearch(...), ...));
  // 3 more registerTool calls, then return server.
}
```

The MCP server is the **callee**; the agent in `agent_service` (and any external agent: ChatGPT Developer Mode, Claude Desktop, Cursor — see `microservices/tiktok-mcp-server/README.md:29-72`) is the **caller**.

**Orchestration frameworks present?** **None.** No LangGraph, no LangChain, no Google ADK, no Inngest, no Temporal, no Vertex Agent Builder. Confirmed by `agent_service/pyproject.toml:6-17` (only `openai`, `mcp`, `tiktoken`, `fastapi`, `redis`, `pydantic`, `sentry`) and by grep across `core/frontend/package.json` + `core/backend/web/package.json` (zero matches for langgraph/inngest/temporal/@google-cloud/@google/genai). The closest historical artifact is the comment "successor to langgraph" in `docker-compose.agent.prod.yml:4` — LangGraph was *removed* in favor of the hand-rolled loop.

---

## 3. Track 2 vs Track 3 fit

### Track 2 — Optimize Existing Agents

**Verdict: ⚠️ Possible, but awkward.**

There IS a real, production agent (`agent_service`, port 8090, ReAct + 21 tools + MCP fabric + Redis memory + grounded suggestions) that has been live since at least 2026-04-01 (see `PROGRESS.md` GPT-5.4-mini migration log). It is a legitimate "existing agent" to optimize. **However**, the agent is built on **OpenAI `gpt-5.4-mini`** (`app/config.py:24`), not Gemini, and uses **no GCP services anywhere** (Atlas + Vultr + Vercel + Hetzner). To pitch this to Track 2 you would be claiming the optimization *is* the migration to Gemini + GCP — which is really a refactor, not an "optimization". The v2 repo (`social-seeding-v2`) is a far stronger Track 2 candidate because it is already an *agent-first* product with 6 specialized Claude agents + Inngest durable orchestration + 354 passing agent/capability/workflow tests + a documented live-demo run on 2026-05-14/15 (v2 `README.md:14-33`).

### Track 3 — Refactor for Google Cloud Marketplace / Gemini Enterprise

**Verdict: ⚠️ Possible, with significant work.**

The platform has the *surface* a Marketplace listing needs (public MCP server at `mcp.socialseed.ing`, customer-facing SaaS on Vercel, dashboard, healthchecks, multi-stage Dockerfile, non-root containers, `HEALTHCHECK` directives, Sentry, Prometheus). And the MCP-as-distribution-channel pattern (Smithery, npm publish per `PROGRESS.md:149-150`) is exactly the integration shape Gemini Enterprise wants. **But** every load-bearing dependency is non-GCP: MongoDB Atlas (not Firestore/AlloyDB), Vercel (not Cloud Run/App Hosting), Vultr/Hetzner Docker + Watchtower auto-deploy (not Cloud Run/GKE/Artifact Registry), better-auth + NextAuth + Google-OAuth-direct (not Identity Platform / Workforce Identity), OpenAI (not Vertex/Gemini), nginx+certbot (not Cloud Load Balancing + managed certs). Track 3 effort is therefore *real refactor*, not relabeling.

### Track 1 — Build a new agent (for reference)

**Verdict: ❌ Not applicable here** — both v2 and platform have substantial existing agent code; submitting either as "new" would be dishonest.

---

## 4. Minimum refactor path to Track 3

Goal: smallest credible refactor that makes `social-seeding-platform` submittable as a Gemini Enterprise / Marketplace-listed agent. Effort: **S** = ≤1 day, **M** = 2-5 days, **L** = 1-2 weeks.

| # | Step | Files / pointers | Effort |
|---|---|---|---|
| 1 | **Swap LLM backend OpenAI → Vertex AI Gemini.** Add a Vertex client alongside `LLMClient` and gate by env. The interface in `agent_service/app/llm/client.py` + `openai_client.py` is already async-`generate()` shaped, so a `VertexGeminiClient` is a sibling, not a rewrite. Update the system prompt to drop OpenAI-isms and keep tool-use mandate (`agent_service/app/main.py:98-177`). | `agent_service/app/llm/{base.py,client.py,openai_client.py}` + new `gemini_client.py`; `app/config.py:23-25`. | M |
| 2 | **Containerize the agent for Cloud Run** with a hardened `Dockerfile` (the existing multi-stage at `agent_service/Dockerfile` is already non-root + slim — needs only env-var-injected `GOOGLE_APPLICATION_CREDENTIALS` and removal of the embedded `INTERNAL_SERVICE_SECRET` header dependency on the Go backend). Publish to **Artifact Registry**. | `agent_service/Dockerfile`; remove `app/main.py:577-590` X-Internal-Secret coupling to Go API, or front the Go API with the same Cloud Run service identity (IAM-bound). | M |
| 3 | **Move the 5 MCP servers to Cloud Run** (one service each, internal-only via VPC connector or Cloud Run service-to-service IAM auth). Update `agent_service/mcp.json:1-34` URLs from `ss-*-mcp` Docker DNS to the new Cloud Run hostnames. | `mcp.json`, `mcp_servers/*/`. | M |
| 4 | **Replace dashboard better-auth with Identity Platform** (or Workforce Identity Federation for staff SSO). The collections `be_dashboard_user/_session/_account` (`core/backend/web/lib/auth.ts:67-91`) become Identity Platform tenants/users. Keep app-level role on the user record. | `core/backend/web/lib/auth.ts`, `lib/auth-server.ts`, `lib/auth-client.ts`. | L |
| 5 | **Customer frontend (Next.js) → Cloud Run or Firebase App Hosting** instead of Vercel; keep NextAuth + Google OAuth provider (Google OAuth already works inside GCP). The only Vercel-specific surface is the SSE proxy, which Cloud Run supports natively. | `core/frontend/next.config.ts`, `package.json` scripts `dev:6500`/`start:6500`. | M |
| 6 | **Mongo Atlas → keep Atlas (Marketplace partner) OR migrate to AlloyDB / Firestore.** For *minimum* Track 3 refactor, **keep Atlas** and pair it via the GCP Marketplace Atlas listing — the existing `MONGO_URI` env-var pattern works unchanged. Migrating to Firestore touches every repository in `core/backend/pkg/repository/` and is **L+**. | `core/backend/pkg/repository/*`. | S (keep Atlas) / L+ (migrate) |
| 7 | **Move Redis to Memorystore.** One env var (`REDIS_URL` in `agent_service/app/config.py:36`, `agent_service/docker-compose.agent.prod.yml:35`). | `app/config.py`, compose files. | S |
| 8 | **Wire observability to Cloud Logging + Cloud Trace + Error Reporting.** Sentry stays as-is (works on any infra) OR replace with the equivalent. The structlog setup at `agent_service/app/sentry_setup.py` + Prometheus scrape in `core/backend/prometheus/` is the integration point. | `agent_service/app/main.py:24-29`, `core/backend/prometheus/*`, `core/backend/grafana/*`. | S |
| 9 | **Publish the public MCP server (`microservices/tiktok-mcp-server`) as a Gemini Enterprise–compatible tool/connector.** The image is already Docker-ready and non-root; needs a Marketplace listing manifest, Cloud Run deploy, and OAuth on Identity Platform (currently a hand-rolled in-image SQLite OAuth flow per `LESSONS.md:48-71`). | `microservices/tiktok-mcp-server/{Dockerfile,src/auth/}`. | M |
| 10 | **Replace Watchtower auto-deploy** on the 6 Vultr scraper nodes with Cloud Build → Artifact Registry → Cloud Run Jobs (scheduled scrapes) or scheduled GKE workloads. This kills the `:latest`-rollout landmine flagged in `~/Documents/GitHub/CLAUDE.md`. | `core-services/tiktok-*/Dockerfile`, deployment scripts. | L |

**Realistic minimum for a submittable Track 3**: steps 1, 2, 3, 7, 8, 9 — roughly **2-3 weeks** of focused work for one engineer. Steps 4, 5, 6, 10 are nice-to-have for a polished demo but not strictly required to *list* the agent.

---

## 5. Risks & landmines specific to a GCP migration

From `~/Documents/GitHub/CLAUDE.md` and `~/Documents/GitHub/social-seeding-platform/LESSONS.md` + this audit:

1. **Port 8080 is the live production backend.** Workspace CLAUDE.md and `social-seeding-platform/CLAUDE.md:25` both say "never start/stop/restart". Any migration must run *parallel* on a new GCP-hosted port + DNS cutover with a rollback plan, not in-place.
2. **`.env` is hands-off without explicit user confirmation** (CLAUDE.md + LESSONS.md §2). Track 3 work will need new `.env.gcp` / Secret Manager bindings, but never edit the live `.env`.
3. **Shared MongoDB Atlas cluster between v1, v2, and platform.** Per the workspace CLAUDE.md "landmine" callout, `social-seeding-backend/.env.test` already points at the **production** DB with `CORS_ALLOWED_ORIGINS=*`. GCP cutover cannot assume Atlas isolation — confirm a dedicated DB before any Firestore/AlloyDB experiment that mirror-writes.
4. **Watchtower auto-deploys `:latest` on the 6 scraper nodes with no canary, no gate.** Any image-layer change rolls to prod in ~5 min. During a GCP migration, the most-likely incident is a `:latest` tag accidentally pointing at a GCP-only build. Pin tags before Track 3 work starts.
5. **No DB migration tool** in `core/backend` — schema/index changes ride on hand-run scripts (`_scripts/migration/`, `_scripts/db/`). Track 3 step 4 (Identity Platform) implies new collections/migrations. Plan rollback manually.
6. **`core/backend/cookies.txt` is committed** (workspace CLAUDE.md landmines) — must be redacted before any public Marketplace submission that exposes the repo.
7. **`tiktok-scraper-api`** has non-reproducible builds (`pyproject.toml` ranges vs `requirements.txt` pins; `nodriver` is `git+...@main` with no SHA). A Cloud Build pipeline will surface this immediately. Pin first.
8. **`grpc v1.80.0` CVE GO-2026-4762** still pending on backend — must be patched to `v1.81.0+` *before* a Marketplace security review.
9. **Dashboard (port 9001) is wired directly at production Atlas** (`core/backend/web/lib/auth.ts:35` `baseURL: 'https://backend.socialseed.ing'`). Step 4 of the refactor must keep a working fallback for staff until Identity Platform is live.
10. **5 separate scraper repos share contract by convention only** (workspace CLAUDE.md) — no shared schema package. Any GCP service-to-service IAM/auth change has to be mirrored PR-by-PR across all 5; no CI gate catches divergence.

---

## 6. Recommendation

**Submit v2 (`social-seeding-v2`) to Track 2.** v2 is already what the challenge wants: an *agent-first* product where agents are functions invoked by a durable orchestrator (Inngest), with 6 specialized agents (sourcing/vetting/outreach/reply/logistics/etc.), curated tool sets, structured outputs, USD caps, explicit human gates, 354 passing tests, and a documented live end-to-end demo on 2026-05-14/15 (v2 `README.md:14-33`). The Track-2 deliverable can be honest "optimize existing agents": port v2's Claude SDK driver to Vertex AI Gemini behind the same `agentTool()` adapter pattern, swap MongoDB Atlas for AlloyDB *or* keep Atlas via Marketplace, run on Cloud Run, and use Gemini's tool-calling. `social-seeding-platform` (the prod stack) is a stronger *Track 3* candidate only because it has a public MCP server at `mcp.socialseed.ing` already wired for Marketplace-style distribution — but the refactor cost there (steps 1-10 in §4) is 3-4× the v2 Track-2 path. If team capacity allows **both**, the natural split is: v2 → Track 2 (Gemini optimization of existing Claude agents), and `microservices/tiktok-mcp-server` → Track 3 (publish the MCP-as-tool surface to Gemini Enterprise). Do **not** submit the legacy `agent_service` (port 8090) on its own — it is a real ReAct agent but it is OpenAI-bound, has zero GCP integration today, and its v2 successor is strictly more aligned with the challenge.
