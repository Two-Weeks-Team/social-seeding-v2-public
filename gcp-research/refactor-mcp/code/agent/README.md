# `tiktok-orchestrator` — Python ADK orchestration layer

Wraps the Node `tiktok-mcp-server` (4 MCP tools) as an A2A-listable
Influencer Research Agent for Gemini Enterprise.

This is the **Phase 5 deliverable** for the Track 3 refactor — code that
lives next to (not in place of) the existing platform repo. The TS-side
edits required to complete the refactor are queued as patches under
`../ts-patches/` and will be applied by a separate review PR.

## Decisions implemented

| ID | What |
|---|---|
| D1 | Dual submission — Track 3 path |
| D2/D3 | KR-gap re-framed as A2A-only distribution innovation |
| D17 | Vertex AI Agent Runtime (transitions through Cloud Run multi-container) |
| D19 | Identity Platform replaces SQLite OAuth |
| D21 | Model Armor max policy + custom-regex pre-filter on every call |

Plan source: `gcp-research/refactor-mcp/REFACTOR-MCP.md` §3.

## Architecture

```
                            ┌──────────────────────────────┐
  Gemini Enterprise         │  Cloud Run multi-container   │
  ──────────────────►       │  ┌────────────────────────┐  │
  HTTPS / A2A JSON-RPC      │  │ container: agent       │  │
   + ID-token Bearer        │  │   FastAPI :8200 (ext)  │  │
                            │  │   ADK SequentialAgent  │  │
                            │  │   Model Armor wrap     │  │
                            │  │   ID-Platform verifier │  │
                            │  └─────────┬──────────────┘  │
                            │            │ loopback        │
                            │            ▼                 │
                            │  ┌────────────────────────┐  │
                            │  │ container: mcp (Node)  │  │
                            │  │   :8100 (internal)     │  │
                            │  │   4 read-only tools    │  │
                            │  │   withLimit() quotas   │  │
                            │  └────────────────────────┘  │
                            └──────────────────────────────┘
                                        │
                                        ▼ HTTPS  (existing prod)
                              backend.socialseed.ing (Go API)
```

Single Cloud Run service, two containers, one ingress (REFACTOR-MCP §5.3).

## Module map

| Module | Role |
|---|---|
| `main.py` | FastAPI app — `/healthz`, `/readyz`, `/.well-known/*`, `/a2a/skills/*`, `/v1/message:send`, `/chat` |
| `agent.py` | ADK `SequentialAgent(searcher, ranker)` + `plan_creator_search(brief)` skill |
| `mcp_client.py` | Async streamable-HTTP MCP client to the Node sidecar |
| `identity_platform.py` | ID-token verifier (Firebase Admin SDK) + OAuth metadata |
| `model_armor.py` | Per-request sanitization wrapper + custom-regex pre-filter |

## Quick start

```bash
cd code/agent
uv pip install --system -e ".[dev]"

# 1) Stub-mode dev server (no MCP container, no Vertex, no Identity Platform)
REQUIRE_AUTH=false MCP_BASE_URL= \
IDENTITY_PLATFORM_STUB=1 MODEL_ARMOR_STUB=1 ADK_DISABLED=1 \
uvicorn tiktok_orchestrator.main:app --reload --port 8200

curl -sS -XPOST http://localhost:8200/a2a/skills/plan_creator_search \
  -H 'content-type: application/json' \
  -d '{"brand_brief":"We are launching a vegan skincare line in Korea for Gen-Z."}' \
  | jq .

# 2) Run the test suite
pytest -q

# 3) Live MCP integration (requires the Node sidecar on :8100)
MCP_BASE_URL=http://localhost:8100 pytest -q -m integration
```

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MCP_BASE_URL` | prod | `http://localhost:8100` | Node MCP sidecar URL (empty = stub mode) |
| `GOOGLE_CLOUD_PROJECT` | prod | `""` | Vertex AI + Identity Platform project |
| `GOOGLE_CLOUD_LOCATION` | no | `us-central1` | Vertex / Model Armor region |
| `IDENTITY_PLATFORM_TENANT_ID` | prod | `""` | Multi-tenant Identity Platform tenant id |
| `GOOGLE_APPLICATION_CREDENTIALS` | prod | `""` | Path to service-account JSON (or ADC) |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | alt | `""` | Inline service-account JSON |
| `MODEL_ARMOR_INPUT_TEMPLATE` | prod | derived | MA INPUT template resource name |
| `MODEL_ARMOR_OUTPUT_TEMPLATE` | prod | derived | MA OUTPUT template resource name |
| `MODEL_ARMOR_FAIL_MODE` | no | `closed` | `closed` / `open` (audit toggle only) |
| `ADK_FLASH_MODEL` | no | `gemini-2.5-flash` | Cheap routing model |
| `ADK_PRO_MODEL` | no | `gemini-2.5-pro` | Ranker model |
| `REQUIRE_AUTH` | no | `true` | Disable for local dev / smoke tests |
| `IDENTITY_PLATFORM_STUB` | tests | `0` | Stub mode for the verifier |
| `MODEL_ARMOR_STUB` | tests | `0` | Stub mode for the sanitizer |
| `ADK_DISABLED` | tests | `0` | Force the heuristic ranker path |

## Tests

```bash
pytest                 # full suite (stub-mode, no external creds)
pytest -m integration  # opt-in live MCP test (needs MCP_BASE_URL set)
```

Coverage targets per Phase 5 §5.1 Basic Functionality:

- Health: `/healthz`, `/readyz`
- Agent card: well-known surface validates against A2A v0.3 required fields
- OAuth metadata: `/.well-known/oauth-protected-resource`
- Skill round-trip: `plan_creator_search` returns ranked creators
- A2A REST binding: `POST /v1/message:send` returns a task artifact
- Custom-regex pre-filter: gcp/aws/key/influencer_id all block
- Identity Platform: stub returns deterministic uid; empty token rejected

## Reference

- `gcp-research/refactor-mcp/REFACTOR-MCP.md` (master plan)
- `gcp-research/protocols/PROTOCOLS.md` §1 (A2A v0.3) + §3 (`agent.json` schema)
- `gcp-research/strategy/KR-GAP.md` §10 (community publication)
- `gcp-research/model-armor/ARMOR-GATEWAY.md` §1.6 path A (per-request sanitize)
- `gcp-research/decisions/DECISIONS.md` D1/D2/D3/D17/D19/D21
