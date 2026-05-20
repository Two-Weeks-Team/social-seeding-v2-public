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
> pytest **2925 passed**; GCP idle envelope **~$1–5/mo** (all Cloud Run `min=0`).

---

## 1. The table

| # | Feature | Shipped for judging (real — proof command) | Production path | Gating |
|---|---|---|---|---|
| 1 | **Triage hardening (the Optimize climax)** | A local **deterministic** triage pass over a 56-case multilingual set drives **40.5% → 100.0% on train (+59.5pp)** and **71.4% on a 14-case adversarial holdout the rules never saw** (28.6pp gap, 4 misses kept, not tuned away). Offline, $0. → `bash scripts/smoke-test/run-hardening-measure.sh` | The live **Vertex AI Prompt Optimizer (data-driven / VAPO)** does the same prompt improvement against real run data. (This corrects the earlier "Agent Optimizer" misnomer — there is no GA "Agent Optimizer"; the GA product is the **Prompt Optimizer**.) The local deterministic pass demonstrates the before/after offline; the GA Prompt Optimizer is wired and operator-gated. | **GA-real** (live optimizer needs ADC + a GCS bucket) |
| 2 | **Agent Observability → Cloud Trace** | Agent spans are wired into `run_agent` (`agent_span` / `llm_child_span` / `record_outcome`, gated by `SS_OTEL_ENABLED`); the OTel span shape is real and asserted offline. The stall→repair trace assets are deterministic offline renderings of that same span tree. → `pnpm exec pytest packages/agents-adk -k observability` | Live OTel export to **Cloud Trace** (and Chronicle SIEM) per run. | **GA-real** (live export is an operator step) |
| 3 | **Model Armor GA sanitize (A2A path)** | Real `model_armor_query_blocks` tool sanitizes the inbound A2A query path; block/allow behavior asserted offline. → `pnpm exec pytest packages/agents-adk -k model_armor` | Live Model Armor template enforcement on the production A2A ingress. | **GA-real** |
| 4 | **Vertex AI Memory Bank backend** | Managed Memory Bank backend implemented (`vertex_memory_bank` / `memory_bank_search`); **Firestore is the default backend**, Vertex Memory Bank is env-gated. Both paths tested offline. → `pnpm exec pytest packages/agents-adk -k memory_bank` | Managed **Vertex AI Memory Bank** as the live recall store (set the env flag); Firestore stays the zero-config default. | **GA-real** (env-gated) |
| 5 | **A2A v0.3 signed agent card (JWS ES256) + JWKS** | `sign_agent_card.py` emits an A2A v0.3 `signatures[]` JWS (RFC 7515) over a JCS-canonicalized (RFC 8785) card, **ES256 (ECDSA P-256 / SHA-256)**, plus the matching JWKS, against a self-managed dev key. → `python gcp-research/refactor-mcp/code/deployment/sign_agent_card.py --help` (+ verify path in the same module) | Sign with a **Cloud KMS**-held production key; publish the JWKS so any Gemini Enterprise consumer can verify the card. | **GA-real** (KMS key is an operator step) |
| 6 | **Live A2A cross-call in the Cloud Workflow** | `coordinator → a2a_invoke → ss-mcp.plan_creator_search` over A2A v0.3 `message/send`; **task completed in ~3.7s (cold) / sub-second (warm), 5 creators ranked**, re-verified this session against the live Cloud Run endpoint. → `bash scripts/smoke-test/run-integration-a2a.sh` (exit 0) | Same edge running inside a live **Cloud Workflow execution** (the workflow's coordinator step performs the transport switch). | **operator-deploy** (live capture via `scripts/deploy/DEPLOY-RUNBOOK.md`) |
| 7 | **Live Cloud Workflow execution** | Deploy artifacts are committed and make a live run a ~3-command operator step: `packages/agents-adk/serve.py` + the `code/Dockerfile` + `terraform/modules/integration/workflows/brand-campaign-demo.workflows.yaml` + `scripts/deploy/DEPLOY-RUNBOOK.md`. | An operator runs the runbook → a live brand-campaign Cloud Workflow execution captured for the demo. | **operator-deploy** |
| 8 | **`ss-mcp-server` orchestrator ranking** | The live Cloud Run server runs a **deterministic heuristic ranker** today; the A2A v0.3 card, `message/send` task envelope, and ~3.7s round-trip are all real — the ranking *data* behind them is heuristic. → `curl …/.well-known/agent.json \| jq .protocolVersion` → `"0.3.0"` | Full multi-container topology (Node MCP sidecar + Vertex ranking + live Identity Platform), preserved unchanged for the follow-up. | **operator-deploy** |
| 9 | **content_verify ↔ DAM as a real A2A hop** | `content_verify → get_brand_assets` is a **real A2A v0.3 hop on `ss-mcp`** (W3), making the official Guide's Build Example #2 transport-exact, not a stand-in. → covered by `run-integration-a2a.sh` + `gcp-research/refactor-mcp/A2A-INTENTS.md §5` | Promote `get_brand_assets` to a separately-deployed, independently-scaled DAM/Brand-Asset agent (same lift as the `a2a_invoke` live-wiring). | **GA-real** (transport already A2A; standalone deploy is the next step) |
| 10 | **Real Imagen 4 image** | One real **1024×1024, 950 KB** Imagen 4 image (`generated-sample.png`) generated via the committed **standalone** `scripts/demo/gen_sample_image.py` (~$0.04, run once). → `python scripts/demo/gen_sample_image.py` (operator ADC) | The in-fleet `creative` agent's `imagen.generate` capability tool is **W7-staged — live mode raises `NotImplementedError`** today. The committed image is from the standalone script, **not** from the creative agent in live mode. A judge running the creative agent live will hit the W7 stub; this is deliberate, not a regression. | **GA-real** for the standalone script; **operator-deploy / W7** for the in-fleet tool |
| 11 | **Model Garden LLM routing (req ③)** | Agent reasoning routes through the Vertex AI Model Garden publisher path (`publishers/google/models/<id>`); an offline test asserts the publisher path reaches the model layer. → `pnpm exec pytest packages/agents-adk -k model_garden` (+ `deploy/model-garden/README.md`) | Live `generateContent` via the Model Garden publisher path under the strict-data-security framing. | **GA-real** (live smoke operator-gated) |
| 12 | **Agent Identity (SPIFFE crypto ID)** | Each agent carries a SPIFFE workload identity (`spiffe://ss-mcp-prod.svc.id.goog/ns/agents/sa/tiktok-mcp-runner`); the identity and the agent card are real (`gcp-research/refactor-mcp/AGENT-IDENTITY.md`). | The callee verifies the caller's workload identity at the A2A transport layer in production. | **GA-real** |
| 13 | **Agent Gateway mTLS** | **Declared, not enforced** on the demo. The SPIFFE identity it would present is real; transport-layer mTLS enforcement is the production path. | mTLS enforced at the **Agent Gateway** in front of the A2A ingress. | **Google-Private-Preview** (Agent Gateway mTLS) |
| 14 | **Gemini Enterprise / Agentspace discovery** | The signed A2A v0.3 card is registration-ready; the agent is built to be discovered + called over A2A without the Marketplace billing rail (the A2A-only distribution path, D3). | Enrolled in Gemini Enterprise / Agentspace so customers discover and call `plan_creator_search` directly. | **Google-Private-Preview / allowlist** (O7, Google's 1–2 week window) |
| 15 | **Synthetic vs real creator data** | Every triage case is **hand-authored synthetic** (multilingual: ko/ja/zh-CN/en); real Gmail sends go only to operator-owned test accounts (D10). | Real creator-reply telemetry feeds the Prompt Optimizer + the cost ledger once a campaign runs live. | **operator-deploy** (needs a live campaign) |
| 16 | **AP2 mandate scope** | **AP2 v0.2 Intent Mandate only** (D27 — agent plans payment, human approves). Cart + Payment Mandate deferred. | Cart + Payment Mandate via the `payment_mandate` agent. | **operator-deploy** (roadmap) |

---

## 2. How to read the split

- **GA-real (rows 1–5, 9, 11, 12, 15-partial):** these are the features the brief calls "genuinely
  real this round." The code is real, the offline tests are green, and going live is an **operator
  ADC/billing/IAM step**, not new engineering. A judge can re-run every proof command above with no
  GCP credentials and see the offline assertion pass.
- **operator-deploy (rows 6–8, 16):** the artifacts ship in-repo; a live capture is a ~3-command
  operator action via `scripts/deploy/DEPLOY-RUNBOOK.md`. The cross-call and the ranker are real at
  the protocol layer today; the live Cloud Workflow execution and the full multi-container topology
  are the operator's to capture.
- **Google-Private-Preview / allowlist (rows 13, 14):** blocked on Google, disclosed plainly, never
  faked. Agent Gateway mTLS is in Private Preview; Gemini Enterprise enrollment is on Google's 1–2
  week allowlist window (O7).

**Count:** 16 rows — **9 GA-real**, **4 operator-deploy**, **2 Google-Private-Preview/allowlist**, and
**1 (row 15) split** GA-real/operator-deploy. The two Google-gated rows are the only items not in our
control; everything else is a re-runnable proof or a documented operator step.

---

## 3. The corrections this file makes explicit (so they are not buried)

1. **"Agent Optimizer" → "Prompt Optimizer."** There is no GA "Agent Optimizer." The GA product is the
   **Vertex AI Prompt Optimizer (data-driven / VAPO)**. The local deterministic pass demonstrates the
   before/after offline; the GA Prompt Optimizer is the production path (row 1).
2. **Imagen: standalone script vs in-fleet tool.** The real 1024×1024 image is from the committed
   `gen_sample_image.py` script. The `creative` agent's `imagen.generate` tool raises
   `NotImplementedError` in live mode (W7). A judge running the creative agent live should expect the
   stub (row 10).
3. **DAM is no longer a stand-in.** After W3, `content_verify → get_brand_assets` is a **real A2A v0.3
   hop on `ss-mcp`** — Build Example #2 is transport-exact (row 9).
4. **mTLS is declared, not enforced** on the demo (row 13); the heuristic ranker is real-at-the-wire,
   heuristic-in-the-data (row 8). Neither is overclaimed anywhere in the submission.

---

**End of HONEST-SCOPE.md** — the single production-vs-shipped table. Linked from `devpost-track3.md`
(Honest scope), `STORYBOARD-unified.md` (honest-scope captions), and `CHECKLIST.md` (final review).
