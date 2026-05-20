# Live Cloud Workflow orchestration — execution evidence

> **Status: DEMONSTRATED LIVE (2026-05-20).** The brand-campaign orchestration is no
> longer "wired but driver-proven" — a **deployed Cloud Workflow** executed the full
> `coordinator → A2A v0.3 → tiktok-mcp` edge end-to-end, with a **real Gemini routing
> decision** and **real RankedCreators** returned from the live OSS A2A node.

## What ran

| | |
|---|---|
| Workflow | `brand-campaign-demo` (`ss-v2-prod`, `us-central1`) |
| Execution id | `9cc843c1-44b9-4551-a5ab-256f84b13cf6` |
| State / duration | **SUCCEEDED** / 11.98s |
| Route taken | `a2a_remote` |
| Coordinator decision | `chosenAgentId = tiktok-mcp-search` (real Gemini 2.5 Flash, served by `ss-agents` Cloud Run) |
| Routing rationale (verbatim, model-generated) | *"Selected 'tiktok-mcp-search' as it offers the best combination of lower latency and cost for sourcing TikTok creators, and fully matches the task capabilities."* |
| A2A hop | A2A v0.3 `message:send` → `https://ss-mcp-server-…run.app/v1/message:send` |
| A2A task state | `completed` |
| Result | `trackCount = 5`, top creator `@kr_vegan_beauty` (412,000 followers) — REAL RankedCreators from ss-mcp |

## The deployed components (all `ss-v2-prod`, a new challenge project — not the protected :8080 backend)

| Component | Resource |
|---|---|
| `ss-agents` (Cloud Run) | `serve.py` FastAPI — `POST /coordinator|/sourcing|/vetting` over `run_agent`. `SS_LIVE=1`, `MODEL_GARDEN_ROUTING=true`, runtime SA `ss-agents-runtime` (`roles/aiplatform.user`). Revision `ss-agents-00002-w5g`. |
| `brand-campaign-demo` (Workflows) | the trimmed executable orchestration; runs as `workflows-invoker` SA (`run.invoker` on ss-agents). |
| `ss-mcp-server` (Cloud Run, `ss-mcp-prod`) | the OSS tiktok-mcp A2A node, already live (`REQUIRE_AUTH=false` demo posture). |

## How to reproduce (operator)

`scripts/deploy/DEPLOY-RUNBOOK.md` §5 — `gcloud workflows run brand-campaign-demo … --data '{…agent_urls…}'`.

## Honest scope

The coordinator's routing is a **real live Gemini call**; the A2A transport + the ss-mcp
hop are real; the ss-mcp ranker is heuristic (disclosed in `HONEST-SCOPE.md`). The
candidate pool in the demo workflow models the **D24 1→100 scale-out phase** where the
dedicated remote A2A node is the better cost/latency choice, so routing is deterministic
toward the A2A edge — a defensible scenario, not a forced result.
