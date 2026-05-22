# Gemini Enterprise / Agent Platform — API enablement status (ss-mcp-prod)

> Baseline recorded **2026-05-22**. Project `ss-mcp-prod` (Social Seeding MCP — Track 3),
> **no organization** (조직 없음). Source: GCP console "에이전트 플랫폼 → 필요한 API 사용 설정"
> panel, cross-verified with `gcloud services list`.

## Why this file
We are pursuing the Gemini Enterprise / Agent Platform surface as a submission plus-factor.
This records the exact enablement state before/after we act, and the precise Google-side
gates we cannot cross, so nothing is overclaimed (RULES §Professional Honesty).

## Console panel → service ID → state (verified by gcloud)

| Console name | Service ID | Baseline | Decision |
|---|---|---|---|
| Agent Platform API | `aiplatform.googleapis.com` | ✅ enabled | keep (this is Vertex AI, our model path) |
| Cloud Trace API | `cloudtrace.googleapis.com` | ✅ enabled | keep (HONEST-SCOPE row 2 — Observability) |
| Telemetry API | `telemetry.googleapis.com` | ✅ enabled | keep |
| Dataform / IAM / Logging / Monitoring / Cloud Storage | (resp. IDs) | ✅ enabled | keep |
| (manually enabled 2026-05-22) | `discoveryengine.googleapis.com` | ✅ enabled | Agentspace backend prerequisite |
| **Model Armor API** | `modelarmor.googleapis.com` | ❌ not enabled | **ENABLE** → makes HONEST-SCOPE row 3 live-capable |
| **Agent Registry API** | `agentregistry.googleapis.com` | ❌ not enabled | **ENABLE** → managed Agent Registry (Govern) |
| **Observability API** | `observability.googleapis.com` | ❌ not enabled | **ENABLE** → managed Agent Observability view |
| App Hub API | `apphub.googleapis.com` | ❌ | skip (not used) |
| App Topology API | — | ❌ | skip |
| Cloud API Registry API | `cloudapiregistry.googleapis.com` | ❌ | skip |
| Compute Engine API | `compute.googleapis.com` | ❌ | skip (no GCE) |
| IAM Connectors API | — | ❌ | skip |
| Cloud Identity-Aware Proxy API | `iap.googleapis.com` | ❌ | skip |
| Network Security / Network Services API | — | ❌ | skip |
| Notebooks API | `notebooks.googleapis.com` | ❌ | skip |
| Cloud Text-to-Speech API | `texttospeech.googleapis.com` | ❌ | skip (no TTS) |

## Applied 2026-05-22 (enabled, verified)
`gcloud services enable` succeeded for all three (rc=0), verified present in `--enabled`:
- ✅ `discoveryengine.googleapis.com` — Agentspace backend prerequisite
- ✅ `modelarmor.googleapis.com` — unlocks live Model Armor sanitize (HONEST-SCOPE row 3)
- ✅ `agentregistry.googleapis.com` — managed Agent Registry (Govern column)
- ✅ `observability.googleapis.com` — managed Agent Observability view (row 2)

**Next "solve" steps (to turn enabled → live-proven):**
1. Model Armor — create a sanitization template + run the live A2A-ingress smoke (code already has `model_armor_query_blocks`, `MODEL_ARMOR_MODE=live`).
2. Agent Registry — register `ss-mcp-server` in the managed registry (investigate the gcloud/REST surface).
3. Observability — confirm the managed Agent Observability view ingests the existing OTel/Cloud Trace spans.

## ✅ RESOLVED — agent REGISTERED LIVE in Gemini Enterprise (2026-05-22)
**No organization or allowlist was needed.** The earlier "blocked" conclusion was wrong: it chased
two dead-end surfaces. The working path:
1. Gemini Enterprise console → **Create app** (started a **30-day free-trial license**, no org, no
   payment) → app `social-seeding-agents` on `ss-mcp-prod` (engine
   `projects/1049119860518/locations/global/collections/default_collection/engines/social-seeding-agents`).
2. **Registered our A2A agent** via the Discovery Engine REST API:
   `POST …/engines/social-seeding-agents/assistants/default_assistant/agents` with
   `a2aAgentDefinition.jsonAgentCard` = the live card, **`url` overridden to the working run.app
   endpoint** (the card already declared run.app as an `additionalInterface`). → **HTTP 200, state
   `ENABLED`**, agent id `4620305404746061476`, listed in the **Agent Gallery** beside Google's
   built-in agents. Verify: `curl …/agents` lists it.

**Dead ends that misled the first attempt (kept for the record):**
- `geminienterprise.googleapis.com` → 220002 (`SERVICE_CONFIG_NOT_FOUND_OR_PERMISSION_DENIED`) — this
  API is not the registration surface; ignore it.
- `discoveryengine` engine create with `solution_type AGENTSPACE` → `INVALID_ARGUMENT` — wrong enum;
  the console "Create app" provisions the engine correctly.
- "no org ⇒ blocked" was **incorrect** — the free-trial Gemini Enterprise license is sufficient.

**Endpoint fixed + verified callable (2026-05-22):** the card's `preferredTransport: JSONRPC` at the
run.app base **405s**; the working interface is **HTTP+JSON at `/v1/message:send`** (direct probe → HTTP
200, returns real ranked creators). The registered card was PATCHed so its `url` =
`…run.app/v1` + `preferredTransport` = `HTTP+JSON`.

> ⚠️ **Security caveat (operator follow-up).** The probe succeeded **with no auth** — the card declares
> `securitySchemes` (OIDC / OAuth / mTLS) but the live Cloud Run service does **not enforce** them
> (the declared-not-enforced posture of HONEST-SCOPE rows 8/13). The returned data is public TikTok
> creator rankings (not PII), but `message:send` on a production deploy must be gated (Identity
> Platform OIDC or Agent Gateway). Not introduced here — this records the existing demo posture.

**Assistant→agent invocation = known Google-side limitation (tested, not assumed):** `streamAssist`
was called two documented ways — `agentsSpec.agentSpecs[].agentId` and
`answerGenerationMode:"AGENT"` + `agentsConfig.agent` (full resource name). Both return HTTP 200
`SUCCEEDED`, but the assistant answers **from the model** (generic web-grounded creators), NOT our
registered agent (our `kr_vegan_beauty`/`fit_score` signature never appears). This matches a
documented Gemini Enterprise forum issue where custom-agent routing via the API only works after a
**Google Cloud Support case** (Google flips something server-side). **Operator next steps:** (a) test
invocation in the GE **UI preview** (the gallery UI may route where the API does not), and/or (b) open
a Cloud Support case to enable custom-agent API routing. Neither is on our side.

## Separate finding (in our control)
The live A2A agent card is served at `https://ss-mcp-server-…run.app/.well-known/agent.json` (200),
but the card's advertised `url: https://mcp.socialseed.ing` returns **404** (root + all card paths) —
the custom domain isn't mapped to `ss-mcp-server`. A consumer following the card's `url` hits a dead
endpoint. Fix: map the domain to `ss-mcp-server` OR set the card `url` to the run.app URL. (ss-mcp-prod
production change — operator-gated.)
