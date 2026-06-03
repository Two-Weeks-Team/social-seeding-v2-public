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
> pytest **2932 passed**; GCP idle envelope **~$1–5/mo** (all Cloud Run `min=0`).
>
> **✓ DEMONSTRATED LIVE 2026-05-20** (rows 6, 7, 11 moved from operator-deploy → demonstrated): the
> `brand-campaign-demo` Cloud Workflow was deployed to `ss-v2-prod` and **executed end-to-end** — real
> Gemini coordinator routed to `tiktok-mcp-search` → A2A v0.3 → live `ss-mcp` → **5 real RankedCreators**
> (execution `9cc843c1`, SUCCEEDED 11.98s). The Model Garden live smoke returned a validated
> `CoordinatorOutput` via `publishers/google/models/gemini-3.1-flash-lite` (exit 0). Evidence:
> `scripts/demo/assets/live-orchestration-evidence.md`.
>
> **✓ DEMONSTRATED LIVE 2026-06-03 (PR #70, native-adoption §A / GT1–GT6):** rows **1** (Prompt
> Optimizer, data-driven 50→90%), **2** (Cloud Trace span tree), and **4** (Memory Bank auto-recall)
> moved GA-real → demonstrated-live, and rows **18–20** were added — **18** GenAI Evaluation (rubric
> judged client-side by gemini-3.5-flash; the managed autorater rejects 3.x), **19** Vertex AI RAG
> Engine grounding (us-west1 — new-project Spanner allowlist), **20** AP2 mandate-chain guard
> (`verifyMandateChain` wired into `sign-mandate`). Repro: `scripts/native-adoption/`.

---

## 1. The table

| # | Feature | Shipped for judging (real — proof command) | Production path | Gating |
|---|---|---|---|---|
| 1 | **Triage hardening (the Optimize climax)** | A local **deterministic** triage pass over a 56-case multilingual set drives **40.5% → 100.0% on train (+59.5pp)** and **71.4% on a 14-case adversarial holdout the rules never saw** (28.6pp gap, 4 misses kept, not tuned away). Offline, $0. → `bash scripts/smoke-test/run-hardening-measure.sh` | The live **Vertex AI Prompt Optimizer (data-driven / VAPO)** does the same prompt improvement against real run data. (This corrects the earlier "Agent Optimizer" misnomer — there is no GA "Agent Optimizer"; the GA product is the **Prompt Optimizer**.) The local deterministic pass demonstrates the before/after offline; the GA Prompt Optimizer is wired and operator-gated. **✓ ran live 2026-06-03 (GT5/PR #70):** data-driven `prompts.optimize` (`examples_dataframe`, target gemini-3.5-flash) on a 10-row triage set lifted accuracy **50% → 90%**. | **✓ demonstrated-live** — GT5 (data-driven Prompt Optimizer, 50→90%) |
| 2 | **Agent Observability → Cloud Trace** | Agent spans are wired into `run_agent` (`agent_span` / `llm_child_span` / `record_outcome`, gated by `SS_OTEL_ENABLED`); the OTel span shape is real and asserted offline. The stall→repair trace assets are deterministic offline renderings of that same span tree. → `pnpm exec pytest packages/agents-adk -k observability` | Live OTel export to **Cloud Trace** (and Chronicle SIEM) per run. **✓ ran live 2026-06-03 (GT1/PR #70):** engine `2498295477225652224` deployed `enable_tracing=True` + SA `roles/cloudtrace.agent` → traceId `dc063a2af962770ff776b0c43ff8ac28` (7 spans: invocation→invoke_agent→call_llm→generate_content gemini-3.5-flash→execute_tool). | **✓ demonstrated-live** — GT1 (Cloud Trace span tree) |
| 3 | **Model Armor GA sanitize (A2A path)** | Real `model_armor_query_blocks` tool sanitizes the inbound A2A query path; block/allow behavior asserted offline. → `pnpm exec pytest packages/agents-adk -k model_armor` | Live Model Armor template enforcement on the production A2A ingress. | **GA-real** |
| 4 | **Vertex AI Memory Bank backend** | Managed Memory Bank backend implemented (`vertex_memory_bank` / `memory_bank_search`); **Firestore is the default backend**, Vertex Memory Bank is env-gated. Both paths tested offline. → `pnpm exec pytest packages/agents-adk -k memory_bank` | Managed **Vertex AI Memory Bank** as the live recall store (set the env flag); Firestore stays the zero-config default. **✓ auto-recall ran live 2026-06-03 (GT2/PR #70):** engine `2498295477225652224` recalls via `before_agent_callback` (env-pinned scope, memory service `location=us-central1`) — an ER-less query applied the remembered `min_engagement_rate=13` → @_alejandrauve only. | **✓ demonstrated-live** — GT2 (Memory Bank auto-recall; Firestore default stays env-gated) |
| 5 | **A2A v0.3 signed agent card (JWS ES256) + JWKS, Cloud KMS key** | **✓ DEMONSTRATED LIVE (2026-05-24) — now KMS-held.** The live `ss-mcp-server` (rev `ss-mcp-server-00013-hv4`, redeployed 2026-06-01 from main via no-traffic canary → verified 7/7 → promoted; prior `00012-rk9` retained for rollback) serves a **signed** card — `signatures[]` JWS (RFC 7515) over the JCS-canonicalized (RFC 8785) card, **ES256 (ECDSA P-256 / SHA-256)**, with the matching public key at `/.well-known/jwks.json` (`kid: ss-agent-card-prod-v1`), plus `securitySchemes` (oidc/oauth/mutualTLS) + `additionalInterfaces`. **The signing key is held in Cloud KMS** (asymmetric `EC_SIGN_P256_SHA256`; the private key never leaves KMS — the agent signs via `cryptoKeyVersions.asymmetricSign` and the JWKS publishes each enabled version's public key). Cut over from the Secret-Manager PEM key via a no-traffic canary (`verify_card_with_jwks` returns **True** against the live card+JWKS; rev `00010-j26` is the PEM-signed rollback). → `curl …/.well-known/agent.json \| jq '.signatures'` + `curl …/.well-known/jwks.json`. (Earlier the live card was an unsigned stub due to a path bug — fixed PR #24.) | Already KMS-held. Rotation is manual (KMS does not auto-rotate asymmetric keys): create a new key version → redeploy; the JWKS auto-lists old+new for the overlap. Runbook: `gcp-research/refactor-mcp/code/deployment/KMS-CARD-SIGNING.md`. | **✓ demonstrated-live** (KMS key + rotation runbook) |
| 6 | **Live A2A cross-call in the Cloud Workflow** | `coordinator → a2a_invoke → ss-mcp.plan_creator_search` over A2A v0.3 `message/send`; **task completed, 5 creators ranked**. **✓ now ran INSIDE a live Cloud Workflow execution** (exec `9cc843c1`, 2026-05-20), not just the standalone driver. → `bash scripts/smoke-test/run-integration-a2a.sh` (exit 0) + the workflow execution | A standing deployment of the same edge. | **✓ demonstrated-live** |
| 7 | **Live Cloud Workflow execution** | **✓ DEMONSTRATED LIVE (2026-05-20).** `ss-agents` (Cloud Run, `ss-v2-prod`, rev `ss-agents-00002-w5g`) + `brand-campaign-demo` Workflow deployed and **executed**: real Gemini coordinator → A2A → live ss-mcp → **5 RankedCreators**, exec `9cc843c1` SUCCEEDED 11.98s. Re-run: `scripts/deploy/DEPLOY-RUNBOOK.md §5`; evidence: `scripts/demo/assets/live-orchestration-evidence.md`. | A standing (always-on) deployment vs the on-demand demo run. | **✓ demonstrated-live** (was operator-deploy) |
| 8 | **`ss-mcp-server` orchestrator ranking** | **✓ DEMONSTRATED LIVE (2026-05-23) — real ADK ranking on Vertex `global`.** The live Cloud Run service (rev `ss-mcp-server-00008-ndg`) runs the ADK SequentialAgent (searcher `gemini-3.1-flash-lite` → ranker `gemini-3.5-flash`); an authenticated `plan_creator_search` returns LLM-ranked creators with non-zero `engagement_rate` + semantic `fit_score` + per-creator reasoning (not the templated heuristic). Verified via a no-traffic canary before traffic cut; Model Armor still blocked a jailbreak and no-token=401. `_heuristic_rank` remains the in-code fallback. → `curl …/.well-known/agent.json \| jq .protocolVersion` → `"0.3.0"` + an authenticated `message:send` | A standing always-on deployment vs the on-demand demo; engagement may read 0 when the backend Group-B analytics quota is exhausted (row 5). | **✓ demonstrated-live** |
| 9 | **content_verify ↔ DAM as a real A2A hop** | `content_verify → get_brand_assets` is a **real A2A v0.3 hop on `ss-mcp`** (W3), making the official Guide's Build Example #2 transport-exact, not a stand-in. → covered by `run-integration-a2a.sh` + `gcp-research/refactor-mcp/A2A-INTENTS.md §5` | Promote `get_brand_assets` to a separately-deployed, independently-scaled DAM/Brand-Asset agent (same lift as the `a2a_invoke` live-wiring). | **GA-real** (transport already A2A; standalone deploy is the next step) |
| 10 | **Real Imagen 4 image** | One real **1024×1024, 950 KB** Imagen 4 image (`generated-sample.png`) generated via the committed **standalone** `scripts/demo/gen_sample_image.py` (~$0.04, run once). → `python scripts/demo/gen_sample_image.py` (operator ADC) | The in-fleet `creative` agent's `imagen.generate` capability tool is **W7-staged — live mode raises `NotImplementedError`** today. The committed image is from the standalone script, **not** from the creative agent in live mode. A judge running the creative agent live will hit the W7 stub; this is deliberate, not a regression. | **GA-real** for the standalone script; **operator-deploy / W7** for the in-fleet tool |
| 11 | **Model Garden LLM routing (req ③)** | **✓ DEMONSTRATED LIVE (2026-05-20).** A real Gemini 3.1 Flash-Lite call via `projects/ss-v2-prod/locations/us-central1/publishers/google/models/gemini-3.1-flash-lite` returned a validated `CoordinatorOutput` (chose `tiktok-mcp-search`, confidence 0.99), exit 0. The offline test also asserts the publisher path reaches the model layer. → `bash scripts/smoke-test/run-model-garden-live.sh` (operator ADC) · `pnpm exec pytest packages/agents-adk -k model_garden` | Live `generateContent` at scale via the Model Garden publisher path under the strict-data-security framing. | **✓ demonstrated-live** |
| 12 | **Agent Identity (SPIFFE crypto ID)** | Each agent carries a SPIFFE workload identity (`spiffe://ss-mcp-prod.svc.id.goog/ns/agents/sa/tiktok-mcp-runner`); the identity and the agent card are real (`gcp-research/refactor-mcp/AGENT-IDENTITY.md`). | The callee verifies the caller's workload identity at the A2A transport layer in production. | **GA-real** |
| 13 | **Agent Gateway mTLS** | **Declared, not enforced** on the demo. The SPIFFE identity it would present is real; transport-layer mTLS enforcement is the production path. | mTLS enforced at the **Agent Gateway** in front of the A2A ingress. | **Google-Private-Preview** (Agent Gateway mTLS) |
| 14 | **Gemini Enterprise / Agentspace registration** | **✓ DEMONSTRATED LIVE 2026-05-22.** Created a live Gemini Enterprise app (`social-seeding-agents`, 30-day free-trial license) on `ss-mcp-prod` and **registered our A2A agent into it** via the Discovery Engine REST API — it is **state `ENABLED` and listed in the Agent Gallery** next to Google's built-in agents (Deep Research, Idea Generation). Agent id `4620305404746061476`; the card `url` was pointed at the live run.app A2A endpoint (the card already declared it as an `additionalInterface`). **No organization or allowlist was needed** — the earlier `geminienterprise.googleapis.com` 220002 was a dead-end API; the working path is the Gemini Enterprise console "Create app" (free trial) + the `discoveryengine` agents endpoint. → `curl …/engines/social-seeding-agents/assistants/default_assistant/agents` lists it `ENABLED`. The agent's endpoint was also fixed + verified callable: a direct A2A `message:send` to the registered `url` (run.app `/v1`, HTTP+JSON) returns real ranked creators (HTTP 200); the card's original `preferredTransport: JSONRPC` at the base 405s, so the registered card was PATCHed to the working HTTP+JSON `/v1` interface. **Security posture (corrected 2026-05-24, PR #24):** the live service now **enforces app-layer caller auth** — an unauthenticated `message:send` returns **401** (`REQUIRE_AUTH=true`; proof: `verify-live-evidence.sh` check [4]). This closes the earlier "unauthenticated `message:send`" caveat, which the Security Auditor flagged on 2026-05-22 *before* `REQUIRE_AUTH` was turned on. The **card + JWKS discovery endpoints stay intentionally public** — the A2A published-signed-card model *requires* anyone to fetch the card (`/v1`) and `/.well-known/jwks.json` to verify authorship. **Cloud Run service-level IAM gating is deliberately NOT applied**: it is all-or-nothing per service, so removing the `allUsers` invoker would 403 the public card/JWKS discovery (and the live-evidence checks [2][3][5], the GE Agent Gallery card fetch, and any independent verifier). The correct gate for the invocation path is the app-layer OIDC/OAuth check, which is live; the **mTLS *transport* scheme remains declared-not-enforced** (row 13 — Agent Gateway is Private Preview). Data is public TikTok creator rankings (not PII). **Invocation-via-assistant tested two ways and is a known Google-side limitation:** `streamAssist` with `agentsSpec.agentSpecs[].agentId` AND with `answerGenerationMode:"AGENT"`+`agentsConfig.agent` both return HTTP 200 `SUCCEEDED` but the assistant answers from the model, NOT our agent (a documented Gemini Enterprise API issue that requires a Cloud Support case to enable). | Standing paid-tier enrollment + assistant→agent routing enabled (Cloud Support case) + verified end-to-end answer from our agent. | **✓ demonstrated-live** registration + endpoint callable (free-trial); **assistant-API routing to custom agents is Google-side-gated** (UI-preview invocation + a Cloud Support case are the remaining steps — not on us) |
| 15 | **Synthetic vs real creator data** | Every triage case is **hand-authored synthetic** (multilingual: ko/ja/zh-CN/en); real Gmail sends go only to operator-owned test accounts (D10). | Real creator-reply telemetry feeds the Prompt Optimizer + the cost ledger once a campaign runs live. | **operator-deploy** (needs a live campaign) |
| 16 | **Google Search grounding (`web.search`)** | **✓ DEMONSTRATED LIVE (2026-05-21).** The `web.search` capability (research agent) does REAL grounding — `gemini-3.5-flash` + the built-in `GoogleSearch` tool — lifting cited sources from `grounding_metadata` (returned 5 real K-beauty/TikTok sources with URLs + per-source snippets). Not a chat completion. → `bash scripts/smoke-test/run-web-search-grounding.sh` (operator ADC + global) · offline-tested in `tests/tools/test_web_search_grounding.py` | Grounding + structured output + function calling combined (Gemini 3 supports it); + URL-context / code-execution tools as needed. | **✓ demonstrated-live** |
| 17 | **Judge 1-click demo login** | A **bypass** login: `GET /api/auth/judge-demo?token=…` mints an `ss_session` JWT directly (no Google OAuth / 2FA), so reviewers land on a populated Mission Control. The minted session carries **`demo: true`** and **every state-mutating route refuses it** (`POST /api/campaigns`, `/campaigns/intake`, `/approvals/[id]/resolve|sign-mandate|reject-mandate` → 403) — it is a **read-only tour**. Token is HMAC-stored (raw token never in DB), globally **usage-capped**, **time-boxed** (`JUDGE_DEMO_EXPIRES_AT`), and **kill-switchable** (`JUDGE_DEMO_ENABLED`). The demo email is **not** Gmail-connected, so `gmail.send` is structurally impossible. Real Google OAuth login (identity-only scopes) remains the production path and is also live. Landing data = public TikTok creator rankings / synthetic brand brief — **non-PII**. → tested in `apps/web/__tests__/judge-demo.test.ts` | Real multi-tenant user→workspace login (Auth.js v5); the demo bypass is removed/flipped off after judging. | **operator-deploy** (env: `JUDGE_DEMO_ENABLED/TOKEN/WORKSPACE_ID/EXPIRES_AT`) |
| 18 | **GenAI Evaluation (managed eval surface)** | `Client.evals.run_inference` + `evaluate` ran live (GT3/PR #70) with a rubric metric → `final_response_quality` summary (3/3 valid, mean 2.33; the judge penalised fabricated handles). **Honest boundary:** the *managed autorater rejects Gemini 3.x* (`Invalid autorater model`) and D53 forbids a 2.5/`*-pro` fallback, so the rubric is judged **client-side by gemini-3.5-flash** on the `global` endpoint. → `scripts/native-adoption/gt3_genai_evaluation.py` | Managed autorater once Google allowlists a 3.x judge; until then the client-side 3.x judge is the honest path. | **✓ demonstrated-live** (client-side 3.x judge; managed autorater for 3.x is Google-gated) |
| 19 | **Vertex AI RAG Engine grounding** | `rag.create_corpus` + brand-brief ingest + `rag.retrieval_query` + ADK `VertexAiRagRetrieval` ran live (GT4/PR #70): corpus `…/us-west1/ragCorpora/6917529027641081856`, retrieval score 0.234 → gemini-3.5-flash grounded answer citing `wooriliu-brand-brief.txt` (min ER 13%, Stripe Connect — all from the corpus). **Honest boundary:** created in **us-west1** because new projects are allowlist-restricted from Spanner-mode RAG in us-central1/us-east1/us-east4. → `scripts/native-adoption/gt4_rag_retrieval.py` | RagManagedDb corpus per workspace; brand briefs as the grounding source. | **✓ demonstrated-live** (us-central1 Spanner mode = Google allowlist) |
| 20 | **AP2 mandate-chain guard** | `verifyMandateChain` (Intent→Cart→Payment binding + ceiling + expiry) is wired into the `sign-mandate` route (`apps/web/lib/ap2/chain-guard.ts`, GT6/PR #70): a tampered/over-ceiling chain on an approval's `recommendation.ap2Chain` returns **HTTP 422** before a human can resolve the gate; the Intent-only (D27) flow skips. → `pnpm --filter @ss/web exec vitest run __tests__/ap2/` (83 passed) | The VC signature (Cloud KMS / WebAuthn SD-JWT) is the operator/KMS signing path; the binding check composes with it. | **GA-real** (binding check is code-real + tested; VC signing is operator-gated) |

---

## 2. How to read the split

- **✓ demonstrated-live (rows 5, 6, 7, 8, 11, 14, 16):** actually executed live on GCP — the
  `brand-campaign-demo` Cloud Workflow ran end-to-end (real Gemini coordinator → A2A → live ss-mcp
  → 5 RankedCreators, exec `9cc843c1`, 2026-05-20), the Model Garden live smoke returned a validated
  outcome via the publisher path, the `web.search` Google Search grounding returned 5 cited sources
  (2026-05-21), and our A2A agent was **registered + ENABLED in a live Gemini Enterprise app**
  (`social-seeding-agents` on `ss-mcp-prod`, Agent Gallery, 2026-05-22). Evidence:
  `scripts/demo/assets/live-orchestration-evidence.md` + `gcp-research/gemini-enterprise-api-status.md`.
- **GA-real (rows 1–4, 9, 12):** the code is real, the offline tests are green, and going live is an
  **operator ADC/billing/IAM step**, not new engineering. A judge can re-run every proof command with
  no GCP credentials and see the offline assertion pass.
- **operator-deploy (partials in 10, 15):** the artifacts ship in-repo; the full live campaign
  is the operator's to capture. (Row 8 — the ADK ranker — moved to demonstrated-live on 2026-05-23.)
- **Google-Private-Preview / allowlist (row 13 only):** blocked on Google, disclosed plainly, never
  faked. Agent Gateway mTLS is in Private Preview. (Gemini Enterprise registration — formerly here —
  moved to **demonstrated-live** on 2026-05-22, see row 14; no allowlist was needed.)

**Count:** 16 rows — **7 demonstrated-live** (5, 6, 7, 8, 11, 14, 16), **6 GA-real** (1–4, 9, 12),
**1 Google-Private-Preview** (13), **2 split** (10, 15). The single Google-gated row (13) is the
only item not in our control; everything else is a re-runnable proof, a live execution, or a
documented operator step. AP2 mandate scope and the 11 P1 pre-submission hardening sprint
disclosures (A2/A3/X4/A4/A5/A6/A7/A8/A9/A10/B-items) are described in **§4 P1 sprint
supplemental disclosures** below as numbered prose, not table rows — they reference the same
code+commit+verify evidence trail but are kept out of the table so the table stays at the
synthesis-target 16 data rows (17 lines including header).

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
   (`agents-adk` pytest 2932) and the hosted demo exercise** — it returns deterministic, realistic
   data. **Live mode** (`CAPABILITY_LAYER_MODE=live`) performs the real external SDK call, and for the
   not-yet-wired tools it raises `NotImplementedError("… wired in W7 deploy phase")`. This is the same
   W7 staging as Imagen (item 2), applied fleet-wide: it is deliberate stub/live discipline (a typed
   seam with offline coverage), **not** silent breakage. A judge driving the fleet with
   `CAPABILITY_LAYER_MODE=live` against unwired tools will hit these seams by design. The live A2A path
   actually demonstrated (`plan_creator_search`, exec `9cc843c1`) runs the wired tiktok tools end-to-end.
2c. **TS campaign-loop carrier (shipment tracking).** `packages/capabilities/src/shipment/carrier.ts`'s
   default factory now returns a **deterministic offline demo carrier** when no `YUNTRACK_API_KEY` is
   set — a faithful port of v1's `getEnhancedFallbackData` (Seller → … → delivered timeline). This is
   what lets the campaign loop reach `delivered → content_review → performance` in a demo/test run
   without live shipping. **It is demo data, not a live carrier scrape**; with `YUNTRACK_API_KEY`
   present the factory throws (`live yuntrack port pending`, issue #29) rather than silently faking a
   live track. The content-verify baseline (`avgViews`) is now real (from the creator's `recentPosts`),
   and report-deliver resolves `creatorId → @handle` (issue #29 P0-A/B/C). The *live* creator-track leg
   still needs Gemini credentials for its agents (conversation/logistics/content-verify) — that path is
   operator/Google-gated; offline it is driven by the mocked-model harness (creator-track tests reach
   `verified`).
3. **DAM is no longer a stand-in.** After W3, `content_verify → get_brand_assets` is a **real A2A v0.3
   hop on `ss-mcp`** — Build Example #2 is transport-exact (row 9).
4. **mTLS is declared, not enforced** on the demo (row 13); the ss-mcp ranker is a **real ADK LLM
   ranker** (searcher `gemini-3.1-flash-lite` → ranker `gemini-3.5-flash`, Vertex `global`) — not a
   heuristic — with `_heuristic_rank` as the in-code fallback (row 8). `engagement_rate: 0` is a
   backend Group-B quota artifact (item 5), not heuristic data. Neither is overclaimed anywhere.
5. **`engagement_rate: 0` / `posts_fetched: 0` in a live ss-mcp call is a backend quota artifact, not a
   bug.** The content-analytics path (backend Group-B) has a daily quota; when it is exhausted (or a
   niche creator's posts aren't cached), the ranker still returns real sourced creators + follower
   counts but engagement fills as 0. `search` + `user_info` are unaffected. A judge re-running after the
   quota resets sees engagement populated. Disclosed so this reads as the quota artifact it is (row 8).

---

## 4. P1 pre-submission hardening sprint supplemental disclosures (prose, 2026-05-28)

> These items were moved out of the §1 table to keep the row count at the synthesis-target 16
> (17 lines including header). They are still single-source-of-truth disclosures — each cites the
> committed code + tests + the verify command the operator runs to refresh the live state.

- **AP2 mandate scope.** AP2 v0.2 Intent Mandate only (D27 — agent plans payment, human approves).
  Cart + Payment Mandate is the production path via the `payment_mandate` agent. Operator-deploy
  roadmap. (was row 16 before 2026-05-28.)
- **agents-cli rubric LLM-judge (A4).** Demonstrated live 2026-05-21 in PR #10: the campaign
  orchestrator scored 4/4 on relevance + grounded rubrics — two consecutive live runs on
  `gemini-3.5-flash` / Vertex `global`, judge rationale cites real URLs verbatim. Result + operator
  re-capture handoff in `claudedocs/agents-cli-eval-2026-05-28.txt`. Re-capture command:
  `cd agents-cli-app && CAPABILITY_LAYER_MODE=stub scripts/run-judge.sh`. Demonstrated-live.
- **Research-agent grounding default flag (A7).** Capability wired (`web_search.py` + `research.py`
  `groundingEnabled` field, default OFF per GEMINI-MODELS §6.5; operator opts in). Same capability
  as row 16's web.search but in the research-agent loop. PR-ready capture in
  `claudedocs/research-grounded-capture-2026-05-28.json`. GA-real (capability wired, default OFF).
- **A6 — fleet "22 defined / 3 routed" health disclosure.** `packages/agents-adk/serve.py` `/healthz`
  + `/livez` + `/readyz` now surface `agents_defined: 22`, `agents_defined_ids: [22 ids]`,
  `agents_routed_in_workflow: [coordinator, sourcing, vetting]`, `agents_routed_count: 3`, plus a
  `fleet_serve_note` explaining the remaining 19 are run_agent-invocable + CI-tested but not wired
  into the brand-campaign-demo workflow. Verify offline:
  `pnpm exec pytest packages/agents-adk -k serve`. Live activation = operator `ss-agents` redeploy.
- **A8 — conversation_responder offline gate (eval coverage 1/22 → 2/22).** New gate wired in
  `evals/__main__.py` via `evals/conversation_responder_eval.py` (drives the existing triage_sim
  simulator). Result: train 42/42 (100%) · holdout 10/14 (71.43%) · gap +28.57% — matches D52 / PR
  hardening literature. Verify: `cd packages/agents-adk && SS_OFFLINE=1 SS_LIVE=0 .venv/bin/python
  -m evals --agent conversation --holdout-floor 0.7`. RESULT: PASS exit 0.
- **A2 — ss-mcp-server FastAPI rate-limit middleware.** Per-IP token-bucket middleware in
  `gcp-research/refactor-mcp/code/agent/src/tiktok_orchestrator/rate_limit.py` (100 req/min, 50
  burst, exempt: liveness + .well-known). 10 unit + middleware tests pass. The committed Cloud
  Armor `ss-mcp-ratelimit` security policy in ss-mcp-prod (`gcloud compute security-policies
  describe ss-mcp-ratelimit --project=ss-mcp-prod`) is the L7 backstop — it is created and
  retrievable but not yet attached to a backend service (Cloud Run direct ingress would require a
  Serverless NEG + Global HTTPS LB migration, tracked in `docs/IMPROVEMENT-MASTER-PLAN.md` as P4
  work). The two layers (app middleware + Cloud Armor policy) combined with the existing
  `maxScale=10` + `containerConcurrency=30` caps bound damage under attack.
- **A3 — approval `editedPayload` prompt-injection guard.**
  `apps/web/app/api/approvals/[id]/resolve/route.ts` walks the operator-supplied editedPayload
  recursively and applies `promptGuard` to every string leaf. Reject = 400 with the field path.
  10 unit tests pass via `cd apps/web && pnpm exec vitest run __tests__/approvals.injection.test.ts`.
  Closes the trust-boundary attack where a signed-in operator could smuggle injection patterns
  into `conversation_responder` / `logistics`.
- **X4 — REQUIRE_AUTH 4-place narrative aligned.** The four artefacts (Dockerfile / `main.py` /
  `cloud-run-service.yaml` / `agent.json`) now narrate the same truth: open-demo image default =
  `false`, but the live `ss-mcp-prod` container env binds `REQUIRE_AUTH=true` and unauthenticated
  POST /v1/message:send returns HTTP 401 (verified live 2026-05-28). Transport-layer mTLS is
  still NOT enforced (row 13 pending O7). `agent.json` x-securityPosture carries the verifiedAt +
  verifiedBy command inline.
- **Model Armor scope clarification (B4 / X3).** Model Armor is live on the ss-mcp-server A2A
  path only (row 3 covers this hop). The 22-agent ADK fleet uses `apps/web/lib/prompt-guard.ts`'s
  6-pattern guard + Gemini built-in safety filters instead of Model Armor at every agent
  invocation. Wrapping the fleet runtime in `model_armor_query_blocks` per-call is Phase 4 work
  (master plan §6 Sub-4.2).
- **Memory Bank fleet-level injection (B5).** Memory Bank backends ship (Firestore default +
  Vertex Memory Bank env-gated, both pytest-covered, row 4). Fleet-level injection into every
  agent's prompt construction is Phase 3 work (P3.2). Today only operator-driven explicit
  `memory_bank_search` tool calls reach the backend.
- **eval coverage 2/22 today, P3 plan to 12/22 (B10 / X1).** Two agents have an offline-PASS gate:
  `coordinator` and `conversation_responder` (A8). The other 20 agents have pytest schema +
  integration coverage (agents-adk 2932 passed) but no standalone `python -m evals --agent X`
  gate. P3 brings the gated coverage to ≥ 12/22.
- **Cold-start SLO disclosure (B11 / X5).** D31's "p99 < 1s on hot path" SLO is measured
  post-warm-up. Cloud Run `min=0` services cold-start the first request; demo recording warms
  the endpoints before capture. The `agent.latency_ms` span (A5 commit fbe1c62) makes warm-path
  measurement first-class on Cloud Trace.

---

**End of HONEST-SCOPE.md** — the single production-vs-shipped table (§1) + the P1 sprint
supplemental disclosures (§4). Linked from `devpost-track3.md` (Honest scope),
`STORYBOARD-unified.md` (honest-scope captions), and `CHECKLIST.md` (final review).
