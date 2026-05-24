# HONEST-SCOPE.md — production path vs shipped-for-judging (the single source of truth)

> **What this file is.** One table that replaces every scattered honesty caveat across the
> submission. For each feature it states three things: what is **shipped for judging** (real, with the
> exact re-runnable proof command), the **production path** (where it goes when an operator runs it
> live), and the **gating** that separates the two. The "gaps" are a roadmap, not hidden debt.
>
> **Why one file.** Per `RULES.md §Professional Honesty`: no marketing superlatives, no fabrication,
> every number traceable. `devpost-track3.md`, `STORYBOARD-unified.md`, and `CHECKLIST.md` link here
> instead of repeating caveats inline. If a row here disagrees with another doc, **this file wins**.
>
> **Gating legend** (the only three states a row can be in):
> - **GA-real** — built on a generally-available GCP/protocol surface; the code is real and runs
>   offline in CI today; **going live is an operator step** (ADC + billing/IAM), not new engineering.
> - **operator-deploy** — the artifacts exist (Dockerfile / serve.py / Workflow YAML / runbook); a
>   live capture is a documented ~3-command operator action via `scripts/deploy/DEPLOY-RUNBOOK.md`.
> - **Google-Private-Preview / allowlist** — blocked on Google, not on us. Disclosed, never faked.
>
> **Verified facts pinned here** (measured this session — do not inflate): triage routing accuracy
> **40.5% → 100.0% on train (+59.5pp)**, **holdout 71.4% (10/14, 28.6pp gap, 4 misses kept)**; the live
> A2A cross-call **task completed in ~3.7s (cold) / sub-second (warm), 5 creators**; `agents-adk`
> pytest **2924 passed**; GCP idle envelope **~$1–5/mo** (all Cloud Run `min=0`).
>
> **✓ DEMONSTRATED LIVE 2026-05-20** (rows 6, 7, 11 moved from operator-deploy → demonstrated): the
> `brand-campaign-demo` Cloud Workflow was deployed to `ss-v2-prod` and **executed end-to-end** — real
> Gemini coordinator routed to `tiktok-mcp-search` → A2A v0.3 → live `ss-mcp` → **5 real RankedCreators**
> (execution `9cc843c1`, SUCCEEDED 11.98s). The Model Garden live smoke returned a validated
> `CoordinatorOutput` via `publishers/google/models/gemini-3.1-flash-lite` (exit 0). Evidence:
> `scripts/demo/assets/live-orchestration-evidence.md`.

---

## 1. The table

| # | Feature | Shipped for judging (real — proof command) | Production path | Gating |
|---|---|---|---|---|
| 1 | **Triage hardening (the Optimize climax)** | A local **deterministic** triage pass over a 56-case multilingual set drives **40.5% → 100.0% on train (+59.5pp)** and **71.4% on a 14-case adversarial holdout the rules never saw** (28.6pp gap, 4 misses kept, not tuned away). Offline, $0. → `bash scripts/smoke-test/run-hardening-measure.sh` | The live **Vertex AI Prompt Optimizer (data-driven / VAPO)** does the same prompt improvement against real run data. (This corrects the earlier "Agent Optimizer" misnomer — there is no GA "Agent Optimizer"; the GA product is the **Prompt Optimizer**.) The local deterministic pass demonstrates the before/after offline; the GA Prompt Optimizer is wired and operator-gated. | **GA-real** (live optimizer needs ADC + a GCS bucket) |
| 2 | **Agent Observability → Cloud Trace** | Agent spans are wired into `run_agent` (`agent_span` / `llm_child_span` / `record_outcome`, gated by `SS_OTEL_ENABLED`); the OTel span shape is real and asserted offline. The stall→repair trace assets are deterministic offline renderings of that same span tree. → `pnpm exec pytest packages/agents-adk -k observability` | Live OTel export to **Cloud Trace** (and Chronicle SIEM) per run. | **GA-real** (live export is an operator step) |
| 3 | **Model Armor GA sanitize (A2A path)** | Real `model_armor_query_blocks` tool sanitizes the inbound A2A query path; block/allow behavior asserted offline. → `pnpm exec pytest packages/agents-adk -k model_armor` | Live Model Armor template enforcement on the production A2A ingress. | **GA-real** |
| 4 | **Vertex AI Memory Bank backend** | Managed Memory Bank backend implemented (`vertex_memory_bank` / `memory_bank_search`); **Firestore is the default backend**, Vertex Memory Bank is env-gated. Both paths tested offline. → `pnpm exec pytest packages/agents-adk -k memory_bank` | Managed **Vertex AI Memory Bank** as the live recall store (set the env flag); Firestore stays the zero-config default. | **GA-real** (env-gated) |
| 5 | **A2A v0.3 signed agent card (JWS ES256) + JWKS, Cloud KMS key** | **✓ DEMONSTRATED LIVE (2026-05-24) — now KMS-held.** The live `ss-mcp-server` (rev `ss-mcp-server-00012-rk9`) serves a **signed** card — `signatures[]` JWS (RFC 7515) over the JCS-canonicalized (RFC 8785) card, **ES256 (ECDSA P-256 / SHA-256)**, with the matching public key at `/.well-known/jwks.json` (`kid: ss-agent-card-prod-v1`), plus `securitySchemes` (oidc/oauth/mutualTLS) + `additionalInterfaces`. **The signing key is held in Cloud KMS** (asymmetric `EC_SIGN_P256_SHA256`; the private key never leaves KMS — the agent signs via `cryptoKeyVersions.asymmetricSign` and the JWKS publishes each enabled version's public key). Cut over from the Secret-Manager PEM key via a no-traffic canary (`verify_card_with_jwks` returns **True** against the live card+JWKS; rev `00010-j26` is the PEM-signed rollback). → `curl …/.well-known/agent.json \| jq '.signatures'` + `curl …/.well-known/jwks.json`. (Earlier the live card was an unsigned stub due to a path bug — fixed PR #24.) | Already KMS-held. Rotation is manual (KMS does not auto-rotate asymmetric keys): create a new key version → redeploy; the JWKS auto-lists old+new for the overlap. Runbook: `gcp-research/refactor-mcp/code/deployment/KMS-CARD-SIGNING.md`. | **✓ demonstrated-live** (KMS key + rotation runbook) |
| 6 | **Live A2A cross-call in the Cloud Workflow** | `coordinator → a2a_invoke → ss-mcp.plan_creator_search` over A2A v0.3 `message/send`; **task completed, 5 creators ranked**. **✓ now ran INSIDE a live Cloud Workflow execution** (exec `9cc843c1`, 2026-05-20), not just the standalone driver. → `bash scripts/smoke-test/run-integration-a2a.sh` (exit 0) + the workflow execution | A standing deployment of the same edge. | **✓ demonstrated-live** |
| 7 | **Live Cloud Workflow execution** | **✓ DEMONSTRATED LIVE (2026-05-20).** `ss-agents` (Cloud Run, `ss-v2-prod`, rev `ss-agents-00002-w5g`) + `brand-campaign-demo` Workflow deployed and **executed**: real Gemini coordinator → A2A → live ss-mcp → **5 RankedCreators**, exec `9cc843c1` SUCCEEDED 11.98s. Re-run: `scripts/deploy/DEPLOY-RUNBOOK.md §5`; evidence: `scripts/demo/assets/live-orchestration-evidence.md`. | A standing (always-on) deployment vs the on-demand demo run. | **✓ demonstrated-live** (was operator-deploy) |
| 8 | **`ss-mcp-server` orchestrator ranking** | **✓ DEMONSTRATED LIVE (2026-05-23) — real ADK ranking on Vertex `global`.** The live Cloud Run service (rev `ss-mcp-server-00008-ndg`) runs the ADK SequentialAgent (searcher `gemini-3.1-flash-lite` → ranker `gemini-3.5-flash`); an authenticated `plan_creator_search` returns LLM-ranked creators with non-zero `engagement_rate` + semantic `fit_score` + per-creator reasoning (not the templated heuristic). Verified via a no-traffic canary before traffic cut; Model Armor still blocked a jailbreak and no-token=401. `_heuristic_rank` remains the in-code fallback. → `curl …/.well-known/agent.json \| jq .protocolVersion` → `"0.3.0"` + an authenticated `message:send` | A standing always-on deployment vs the on-demand demo; engagement may read 0 when the backend Group-B analytics quota is exhausted (row 5). | **✓ demonstrated-live** |
| 9 | **content_verify ↔ DAM as a real A2A hop** | `content_verify → get_brand_assets` is a **real A2A v0.3 hop on `ss-mcp`** (W3), making the official Guide's Build Example #2 transport-exact, not a stand-in. → covered by `run-integration-a2a.sh` + `gcp-research/refactor-mcp/A2A-INTENTS.md §5` | Promote `get_brand_assets` to a separately-deployed, independently-scaled DAM/Brand-Asset agent (same lift as the `a2a_invoke` live-wiring). | **GA-real** (transport already A2A; standalone deploy is the next step) |
| 10 | **Real Imagen 4 image** | One real **1024×1024, 950 KB** Imagen 4 image (`generated-sample.png`) generated via the committed **standalone** `scripts/demo/gen_sample_image.py` (~$0.04, run once). → `python scripts/demo/gen_sample_image.py` (operator ADC) | The in-fleet `creative` agent's `imagen.generate` capability tool is **W7-staged — live mode raises `NotImplementedError`** today. The committed image is from the standalone script, **not** from the creative agent in live mode. A judge running the creative agent live will hit the W7 stub; this is deliberate, not a regression. | **GA-real** for the standalone script; **operator-deploy / W7** for the in-fleet tool |
| 11 | **Model Garden LLM routing (req ③)** | **✓ DEMONSTRATED LIVE (2026-05-20).** A real Gemini 3.1 Flash-Lite call via `projects/ss-v2-prod/locations/us-central1/publishers/google/models/gemini-3.1-flash-lite` returned a validated `CoordinatorOutput` (chose `tiktok-mcp-search`, confidence 0.99), exit 0. The offline test also asserts the publisher path reaches the model layer. → `bash scripts/smoke-test/run-model-garden-live.sh` (operator ADC) · `pnpm exec pytest packages/agents-adk -k model_garden` | Live `generateContent` at scale via the Model Garden publisher path under the strict-data-security framing. | **✓ demonstrated-live** |
| 12 | **Agent Identity (SPIFFE crypto ID)** | Each agent carries a SPIFFE workload identity (`spiffe://ss-mcp-prod.svc.id.goog/ns/agents/sa/tiktok-mcp-runner`); the identity and the agent card are real (`gcp-research/refactor-mcp/AGENT-IDENTITY.md`). | The callee verifies the caller's workload identity at the A2A transport layer in production. | **GA-real** |
| 13 | **Agent Gateway mTLS** | **Declared, not enforced** on the demo. The SPIFFE identity it would present is real; transport-layer mTLS enforcement is the production path. | mTLS enforced at the **Agent Gateway** in front of the A2A ingress. | **Google-Private-Preview** (Agent Gateway mTLS) |
| 14 | **Gemini Enterprise / Agentspace registration** | **✓ DEMONSTRATED LIVE 2026-05-22.** Created a live Gemini Enterprise app (`social-seeding-agents`, 30-day free-trial license) on `ss-mcp-prod` and **registered our A2A agent into it** via the Discovery Engine REST API — it is **state `ENABLED` and listed in the Agent Gallery** next to Google's built-in agents (Deep Research, Idea Generation). Agent id `4620305404746061476`; the card `url` was pointed at the live run.app A2A endpoint (the card already declared it as an `additionalInterface`). **No organization or allowlist was needed** — the earlier `geminienterprise.googleapis.com` 220002 was a dead-end API; the working path is the Gemini Enterprise console "Create app" (free trial) + the `discoveryengine` agents endpoint. → `curl …/engines/social-seeding-agents/assistants/default_assistant/agents` lists it `ENABLED`. The agent's endpoint was also fixed + verified callable: a direct A2A `message:send` to the registered `url` (run.app `/v1`, HTTP+JSON) returns real ranked creators (HTTP 200); the card's original `preferredTransport: JSONRPC` at the base 405s, so the registered card was PATCHed to the working HTTP+JSON `/v1` interface. **Security caveat (transparency):** that demo endpoint is currently **unauthenticated** — the card *declares* OIDC/OAuth/mTLS security schemes but the live Cloud Run service does not enforce them (the same declared-not-enforced posture as row 13). The data is public TikTok creator rankings (not PII), but a production deploy must gate `message:send` (Identity Platform / Agent Gateway). Operator follow-up. **Invocation-via-assistant tested two ways and is a known Google-side limitation:** `streamAssist` with `agentsSpec.agentSpecs[].agentId` AND with `answerGenerationMode:"AGENT"`+`agentsConfig.agent` both return HTTP 200 `SUCCEEDED` but the assistant answers from the model, NOT our agent (a documented Gemini Enterprise API issue that requires a Cloud Support case to enable). | Standing paid-tier enrollment + assistant→agent routing enabled (Cloud Support case) + verified end-to-end answer from our agent. | **✓ demonstrated-live** registration + endpoint callable (free-trial); **assistant-API routing to custom agents is Google-side-gated** (UI-preview invocation + a Cloud Support case are the remaining steps — not on us) |
| 15 | **Synthetic vs real creator data** | Every triage case is **hand-authored synthetic** (multilingual: ko/ja/zh-CN/en); real Gmail sends go only to operator-owned test accounts (D10). | Real creator-reply telemetry feeds the Prompt Optimizer + the cost ledger once a campaign runs live. | **operator-deploy** (needs a live campaign) |
| 16 | **AP2 mandate scope** | **AP2 v0.2 Intent Mandate only** (D27 — agent plans payment, human approves). Cart + Payment Mandate deferred. | Cart + Payment Mandate via the `payment_mandate` agent. | **operator-deploy** (roadmap) |
| 17 | **Google Search grounding (`web.search`)** | **✓ DEMONSTRATED LIVE (2026-05-21).** The `web.search` capability (research agent) does REAL grounding — `gemini-3.5-flash` + the built-in `GoogleSearch` tool — lifting cited sources from `grounding_metadata` (returned 5 real K-beauty/TikTok sources with URLs + per-source snippets). Not a chat completion. → `bash scripts/smoke-test/run-web-search-grounding.sh` (operator ADC + global) · offline-tested in `tests/tools/test_web_search_grounding.py` | Grounding + structured output + function calling combined (Gemini 3 supports it); + URL-context / code-execution tools as needed. | **✓ demonstrated-live** |

---

## 2. How to read the split

- **✓ demonstrated-live (rows 5, 6, 7, 8, 11, 14, 17):** actually executed live on GCP — the
  `brand-campaign-demo` Cloud Workflow ran end-to-end (real Gemini coordinator → A2A → live ss-mcp
  → 5 RankedCreators, exec `9cc843c1`, 2026-05-20), the Model Garden live smoke returned a validated
  outcome via the publisher path, the `web.search` Google Search grounding returned 5 cited sources
  (2026-05-21), and our A2A agent was **registered + ENABLED in a live Gemini Enterprise app**
  (`social-seeding-agents` on `ss-mcp-prod`, Agent Gallery, 2026-05-22). Evidence:
  `scripts/demo/assets/live-orchestration-evidence.md` + `gcp-research/gemini-enterprise-api-status.md`.
- **GA-real (rows 1–4, 9, 12):** the code is real, the offline tests are green, and going live is an
  **operator ADC/billing/IAM step**, not new engineering. A judge can re-run every proof command with
  no GCP credentials and see the offline assertion pass.
- **operator-deploy (row 16; partials in 10, 15):** the artifacts ship in-repo; the full live campaign
  is the operator's to capture. (Row 8 — the ADK ranker — moved to demonstrated-live on 2026-05-23.)
- **Google-Private-Preview / allowlist (row 13 only):** blocked on Google, disclosed plainly, never
  faked. Agent Gateway mTLS is in Private Preview. (Gemini Enterprise registration — formerly here —
  moved to **demonstrated-live** on 2026-05-22, see row 14; no allowlist was needed.)

**Count:** 17 rows — **7 demonstrated-live** (5, 6, 7, 8, 11, 14, 17), **6 GA-real** (1–4, 9, 12),
**1 operator-deploy** (16), **1 Google-Private-Preview** (13), **2 split** (10, 15). The single
Google-gated row (13) is the only item not in our control; everything else is a re-runnable proof,
a live execution, or a documented operator step.

---

## 3. The corrections this file makes explicit (so they are not buried)

1. **"Agent Optimizer" → "Prompt Optimizer."** There is no GA "Agent Optimizer." The GA product is the
   **Vertex AI Prompt Optimizer (data-driven / VAPO)**. The local deterministic pass demonstrates the
   before/after offline; the GA Prompt Optimizer is the production path (row 1).
2. **Imagen: standalone script vs in-fleet tool.** The real 1024×1024 image is from the committed
   `gen_sample_image.py` script. The `creative` agent's `imagen.generate` tool raises
   `NotImplementedError` in live mode (W7). A judge running the creative agent live should expect the
   stub (row 10).
2b. **ADK fleet stub/live seam (the Imagen case generalized — disclosed up front, not buried).** The
   external-IO tools in the ADK fleet (~47 files: `rapidapi_*`, `gmail_*`, `imagen`, `tts_synthesize`,
   `pubsub_alert`, `assets_upload`, `carrier_create`, etc.) ship a **D41 stub/live seam**
   (`CAPABILITY_LAYER_MODE`). **Stub mode is the default in dev/CI and is what every offline test
   (`agents-adk` pytest 2924) and the hosted demo exercise** — it returns deterministic, realistic
   data. **Live mode** (`CAPABILITY_LAYER_MODE=live`) performs the real external SDK call, and for the
   not-yet-wired tools it raises `NotImplementedError("… wired in W7 deploy phase")`. This is the same
   W7 staging as Imagen (item 2), applied fleet-wide: it is deliberate stub/live discipline (a typed
   seam with offline coverage), **not** silent breakage. A judge driving the fleet with
   `CAPABILITY_LAYER_MODE=live` against unwired tools will hit these seams by design. The live A2A path
   actually demonstrated (`plan_creator_search`, exec `9cc843c1`) runs the wired tiktok tools end-to-end.
3. **DAM is no longer a stand-in.** After W3, `content_verify → get_brand_assets` is a **real A2A v0.3
   hop on `ss-mcp`** — Build Example #2 is transport-exact (row 9).
4. **mTLS is declared, not enforced** on the demo (row 13); the heuristic ranker is real-at-the-wire,
   heuristic-in-the-data (row 8). Neither is overclaimed anywhere in the submission.
5. **`engagement_rate: 0` / `posts_fetched: 0` in a live ss-mcp call is a backend quota artifact, not a
   bug.** The content-analytics path (backend Group-B) has a daily quota; when it is exhausted (or a
   niche creator's posts aren't cached), the ranker still returns real sourced creators + follower
   counts but engagement fills as 0. `search` + `user_info` are unaffected. A judge re-running after the
   quota resets sees engagement populated. Disclosed so this reads as the quota artifact it is (row 8).

---

**End of HONEST-SCOPE.md** — the single production-vs-shipped table. Linked from `devpost-track3.md`
(Honest scope), `STORYBOARD-unified.md` (honest-scope captions), and `CHECKLIST.md` (final review).
