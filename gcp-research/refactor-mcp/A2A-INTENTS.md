<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Social Seeding Inc. -->

# A2A Intents Manifest — `tiktok-mcp-server`

> **Track 3 official requirement #6** (`designed_guide.pdf` p.6): *"Finalize
> documentation, outlining the specific A2A intents your agent exposes and
> consumes."* This file is that document.
>
> **Authority chain**: [`DECISIONS.md` D48](../decisions/DECISIONS.md) authorizes
> this manifest. The intents below are extracted from the actual source — not
> aspirational. Each row cites the file + symbol it derives from. The agent card
> ([`code/deployment/agent.json`](code/deployment/agent.json)) is the
> machine-readable counterpart; this file is the human/judge-readable one.
>
> **Scope clarification**: "A2A intent" here means a *capability another agent
> can invoke over the A2A v0.3 protocol*, surfaced as either an **A2A skill**
> (Path A — what Gemini Enterprise calls) or an **MCP tool** (Path B — what an
> MCP client calls). A2A v0.3 establishes caller identity at the HTTP/transport
> layer; the message payload carries no identity (verified via Context7 against
> the A2A spec "Enterprise-Ready Authentication" topic). The two paths share one
> Cloud Run image so the agent lists into the Marketplace/Registry under either
> category (`agent.json` `_comment_intent`).

---

## 1. At a glance

| Direction | Count | Transport surface |
|---|---|---|
| **Exposed** (this agent → other agents) | **5** (1 A2A skill + 4 MCP tools) | A2A v0.3 over JSONRPC + HTTP+JSON; MCP streamable-HTTP |
| **Consumed** (this agent → other systems) | **2** (MCP toolset internal call + Identity Platform OIDC verification) | loopback MCP `:8100`; OIDC token verification |
| **Consumed over A2A** (this agent A2A-invoking peers) | **0** today | — (the reverse leg — Track-2 coordinator → this agent — is in §4) |

The agent is a **leaf producer** in the A2A ecosystem: it *exposes* creator-research
intents and *consumes* only its own MCP sidecar + the identity provider. It does
not currently A2A-invoke other agents. The cross-component proof for D45 (single
Track-3 narrative) runs in the **other direction** — the Track-2 `coordinator`
agent A2A-invokes *this* agent. That mapping is §4.

---

## 2. Exposed intents (what other agents can invoke)

### 2.1 A2A skill (Path A)

#### `plan_creator_search`

| Property | Value |
|---|---|
| **Skill id** | `plan_creator_search` |
| **A2A binding** | `POST /v1/message:send` (A2A v0.3 REST `message/send`) and the direct alias `POST /a2a/skills/plan_creator_search` |
| **Source** | [`agent/src/tiktok_orchestrator/agent.py`](code/agent/src/tiktok_orchestrator/agent.py) `plan_creator_search()`; HTTP binding in [`main.py`](code/agent/src/tiktok_orchestrator/main.py) `a2a_message_send()` / `a2a_plan()` |
| **Input** | `brand_brief: str` — one-to-two paragraphs, 10–8 000 chars (`BriefIn`). Over `message/send` it arrives as a single `text` part. |
| **Output** | `RankedCreators` — `{brief, creators[], source_attribution, trace}`; each creator carries `unique_id`, `follower_count`, `engagement_rate` (0–1), `fit_score` (0–1), `reasoning` (10–500 chars). Schema is `agent.json` `#/_definitions/RankedCreators`, mirrored by `agent.py` `RankedCreators` / `CreatorRank`. |
| **Authentication** | Identity Platform OIDC bearer (D19) **or** OAuth2 `tiktok:read`. Enforced by `require_identity` in `main.py`; rejects tokens without a `firebase.tenant` claim. RFC 6750 401 on failure. |
| **Rate limit** | No per-skill limit at the A2A layer; the underlying MCP tools enforce daily free-tier quotas (see §2.2) and the orchestrator stops fanning out on the first `LimitReachedError` (`mcp_client.py`). |
| **Typical duration** | ~15 000 ms; declared `long_running` in the card. Streaming declared (`capabilities.streaming = true`) but the shipped `message/send` binding is non-streaming (PROTOCOLS.md §1.4 streaming is a follow-up). |
| **A2A v0.3 message format** | Request: `{"message": {"role":"user","parts":[{"kind":"text","text":"<brief>"}]}}`. Response: a `task` envelope `{"kind":"task","id","contextId","status":{"state":"completed"},"artifacts":[{"artifactId","parts":[{"kind":"data","data":<RankedCreators>}]}]}` (`main.py` `a2a_message_send`). |

**A2A v0.3 sample (the exact bytes Gemini Enterprise sends):**

```http
POST /v1/message:send HTTP/1.1
Host: mcp.socialseed.ing
Authorization: Bearer <Identity Platform ID token>
Content-Type: application/json

{
  "message": {
    "role": "user",
    "parts": [
      { "kind": "text", "text": "Find 10 vegan-skincare TikTok creators in Korea for a Gen-Z launch." }
    ]
  }
}
```

```json
{
  "kind": "task",
  "id": "task-1747699200000",
  "contextId": "ctx-1747699200000",
  "status": { "state": "completed", "timestamp": "2026-05-20T00:00:00Z" },
  "artifacts": [
    {
      "artifactId": "task-1747699200000-result",
      "parts": [
        { "kind": "data", "data": {
            "brief": "Find 10 vegan-skincare …",
            "creators": [
              { "unique_id": "kr_vegan_beauty", "follower_count": 412000,
                "engagement_rate": 0.072, "fit_score": 0.91,
                "reasoning": "@kr_vegan_beauty has 412,000 followers and …" }
            ],
            "source_attribution": "Source: Social Seeding — https://socialseed.ing",
            "trace": { "path": "heuristic", "keywords": ["vegan", "비건"] }
        } }
      ]
    }
  ]
}
```

### 2.2 MCP tool surfaces (Path B)

These four read-only tools are the original `tiktok-mcp-server` surface. They are
declared in the agent card (`mcp_tools[]`) so an MCP client can invoke them
directly, and they are the tools the `plan_creator_search` skill orchestrates
internally. Schemas are pinned in
[`mcp_client.py`](code/agent/src/tiktok_orchestrator/mcp_client.py) (the docstrings
cite the canonical `src/server.ts` line ranges in the Node sidecar).

| MCP tool | Input | Output (key fields) | Auth | Daily free-tier limit |
|---|---|---|---|---|
| `tiktok_search` | `keyword: str`, `limit: int (1–100, default 10)` | `creators[] {uniqueId, followerCount, bio}` | OIDC bearer (D19); per-uid quota key | **200 / day** |
| `tiktok_user_info` | `uniqueId: str` | `{uniqueId, followerCount, bio, video_count}` | OIDC bearer | **200 / day** |
| `tiktok_user_posts` | `uniqueId: str`, `count: int (1–30, default 10)` | `posts[] {id, views, likes, comments, shares, caption}` | OIDC bearer | **50 / day** |
| `tiktok_post_detail` | `id: str`, `uniqueId?: str` | `{id, views, likes, comments, shares}` | OIDC bearer | **50 / day** |

**MCP envelope + rate-limit signalling** (`mcp_client.py` `_parse_envelope`): every
tool response carries `structuredContent._meta = {source, sourceUrl, remainingToday,
dailyLimit}`. When `remainingToday == 0` and the text is the limit-reached message,
the client raises `LimitReachedError`, which the orchestrator treats as a terminal
"stop fanning out" signal. Each tool response also appends a mandatory
`Source: Social Seeding` attribution footer per the MCP licence terms.

**Transport note**: MCP uses streamable-HTTP JSON-RPC with an `Mcp-Session-Id`
header; Cloud Run `sessionAffinity: "true"` is required so the in-memory session
map lands consecutive requests on the same instance (`cloud-run-service.yaml`).

---

## 3. Consumed intents (what this agent calls out to)

The orchestrator does **not** A2A-invoke other agents. Its outbound dependencies
are two, neither of which is an A2A intent:

| # | Dependency | Direction / transport | Source | Notes |
|---|---|---|---|---|
| C1 | **MCP toolset** (`tiktok_search` / `tiktok_user_info` / `tiktok_user_posts` / `tiktok_post_detail`) | loopback to the Node sidecar at `http://127.0.0.1:8100/mcp` | `mcp_client.py` `TikTokMcpClient`; ADK path via `MCPToolset` in `agent.py` `build_coordinator()` | This is an *internal* MCP call inside the same Cloud Run pod, not an external A2A hop. The same four tools are *exposed* (§2.2) and *consumed-internally* here. |
| C2 | **Identity Platform OIDC** token verification | inbound-token verification via Firebase Admin SDK | `identity_platform.py` `verify_id_token()` | The agent verifies caller tokens; it does not mint or relay them. Multi-tenant: rejects tokens whose `firebase.tenant` mismatches `IDENTITY_PLATFORM_TENANT_ID`. |

**Why zero consumed A2A intents today**: this agent is a creator-research *producer*.
The composition story (a marketing agent A2A-calling a brand-asset agent) is realized
by the Track-2 fleet calling *into* this agent — documented next.

---

## 4. Cross-platform integration table (D45 — the single-narrative proof)

Per [`DECISIONS.md` D45](../decisions/DECISIONS.md), the Track-2 22-agent ADK fleet
and this Track-3 refactored MCP server are presented as **one A2A ecosystem**. The
load-bearing cross-component edge is the Track-2 **coordinator (M1)** routing a
sourcing task to this agent over A2A.

| Caller (Track 2) | Capability | Mechanism | Callee (Track 3) | Intent invoked |
|---|---|---|---|---|
| `coordinator` agent (M1) | `a2a.invoke` | `a2a_invoke(A2AInvokeInput)` → HTTPS POST through Agent Gateway (D44) | `tiktok-mcp-server` | `plan_creator_search` (via `POST /v1/message:send`) |

**Code trail**:
- `packages/agents-adk/src/ss_agents/agents/coordinator.py` — the M1 routing agent
  carries `tools=[agent_registry_list, a2a_invoke]` and, in its `__main__` demo,
  scores a candidate pool that includes `tiktok-mcp-search`
  (`capabilities=["source_creators","tiktok","remote","a2a"]`, `transport="a2a_grpc"`).
  When the coordinator picks that candidate, Cloud Workflows performs the transport
  switch and calls `a2a_invoke`.
- `packages/agents-adk/src/ss_agents/tools/a2a_invoke.py` — the capability that does
  the outbound A2A v0.3 hop. It **enforces `https`** on `remote_agent_endpoint`
  (A2A v0.3 mandates TLS), surfaces a per-hop USD cost (`USD_COST = 0.0005`) for
  `cost_watch`, and — in live mode — *"Acquire a SPIFFE identity token (D44 Agent
  Identity)"* before posting through Agent Gateway (see the `_live()` docstring).
  Live mode is wired in the W7 deploy phase; stub mode is deterministic for
  dev/CI.

So the edge `coordinator → a2a_invoke → tiktok-mcp-server.plan_creator_search` is
the concrete A2A cross-call that makes the two submissions one story. The SPIFFE
token referenced in `a2a_invoke._live()` is exactly the Agent Identity specified in
[`AGENT-IDENTITY.md`](AGENT-IDENTITY.md) — the caller presents its workload identity,
the callee verifies it at the transport layer.

---

## 5. PDF Build Example #2 match — `content_verify` ↔ DAM Agent

> **`designed_guide.pdf` p.7, Build Example #2 (verbatim):** *"marketing agent…
> Cloud Run or GKE… multi-modal video assembly… powered by Gemini… analyze PDF
> briefs, generate storyboards, orchestrate audio-visual assets… A2A protocol… to
> communicate with company's internal Digital Asset Manager (DAM) Agent to retrieve
> approved brand logos and product imagery, ensuring every generated video remains
> on-brand and compliant."*

The PDF's reference pattern is **a Gemini-powered, multimodal marketing agent that
uses A2A to reach a brand-asset/DAM agent so output stays on-brand and compliant.**
Social Seeding implements this 1:1 with the **`content_verify`** agent and its
**`vision.brand_logo_detect`** capability:

| PDF Build Example #2 element | Social Seeding implementation | Source |
|---|---|---|
| Marketing agent on **Cloud Run / GKE** | Track-2 fleet on Vertex AI Agent Runtime; this refactored agent on multi-container Cloud Run (D17) | `cloud-run-service.yaml` |
| **Powered by Gemini, multi-modal** | `content_verify` runs **Gemini 2.5 Flash multimodal** (text + image + video URIs) — the first multimodal Tier-1 agent | `content_verify.py` `content_verify_agent_def(model="gemini-2.5-flash")`; D5 |
| **A2A to an internal DAM Agent** for **approved brand logos / product imagery** | `content_verify` calls **`vision.brand_logo_detect`** (Cloud Vision `LOGO_DETECTION`) to retrieve/verify the seeded brand's logo against the post media — the "approved brand logo" check the DAM Agent provides | `content_verify.py` `tools=[vision_brand_logo_detect]`; `vision_brand_logo_detect.py` |
| **"remains on-brand and compliant"** | `content_verify` returns `{matches, mentionsBrand, logoDetected, performanceScore, flags[8], rationale}`; flags include `competitor_mention`, `logo_only`, `ai_generated_suspect` — the explicit on-brand / compliance verdict | `content_verify.py` `ContentVerifyOutput`, `ContentVerifyFlag` |

**Honest scope note** (per RULES.md — no overclaiming): in the shipped Phase-3 code,
`content_verify` reaches its brand-asset check via an **in-process ADK FunctionTool**
(`vision_brand_logo_detect`), not yet an A2A hop to a separately-deployed DAM agent.
The roles map 1:1 (Gemini multimodal marketing agent retrieving an approved brand
logo to enforce on-brand compliance); the *transport* is currently a local capability
call. Promoting `vision.brand_logo_detect` to a standalone A2A-addressable
"DAM/Brand-Asset Agent" is the same lift as the `a2a_invoke` live-wiring in §4 and is
the natural Phase-4 step. The `agent.json` `_build_example_2_match` block records this
mapping for the Producer Portal / judges.

---

## 6. References

- A2A intents authority: [`DECISIONS.md` D48](../decisions/DECISIONS.md)
- Agent card (machine-readable): [`code/deployment/agent.json`](code/deployment/agent.json)
- Agent Identity design: [`AGENT-IDENTITY.md`](AGENT-IDENTITY.md)
- Master plan: [`REFACTOR-MCP.md`](REFACTOR-MCP.md)
- A2A v0.3 spec (AgentCard, securitySchemes, message/send, signatures): https://a2a-protocol.org/specification/0.3.0
- Single-narrative decision: [`DECISIONS.md` D45](../decisions/DECISIONS.md)

**Status**: authored per D48 (2026-05-20). Exposed: 5 intents (1 A2A skill + 4 MCP
tools). Consumed: 2 outbound dependencies (0 over A2A today). Cross-call proof + Build
Example #2 match recorded.
