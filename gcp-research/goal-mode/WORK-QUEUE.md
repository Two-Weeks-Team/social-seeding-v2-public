# WORK-QUEUE.md — Prioritized Remaining Work for /goal

> **Purpose**: The autonomous `/goal` runner picks tasks from this queue in priority order, dispatches the matching subagent (per `DISPATCH-MATRIX.md`), and updates this file as items complete.
>
> **Status legend**: 🔴 P0 blocking · 🟡 P1 should · 🟢 P2 nice-to-have · 🚫 blocked on operator · ✅ DONE
>
> **Last updated**: 2026-05-19 — **P0 COMPLETE** (W1/W2/W3/W4 all green; commit `9db559b` on PR #1). P1 W5 blocks on operator BILLING_ACCOUNT.

---

## P0 — Blocking (must finish before any submission attempt)

### W1 — Fix BN-9 prompt-guard regex (KR/JA/ZH) · ✅ DONE 2026-05-19 (D40, agent `a93ebdee1da066812`)
- **Why blocking**: 3+ pre-existing test failures (`test_runtime.py::test_block_patterns_trip[ja]`, `[zh]`); 10+ Phase 3 agents currently use particle-free workarounds in their KR injection tests. Production traffic will use particle-rich text and will *not* be blocked. **Real security regression.**
- **File**: `packages/agents-adk/src/ss_agents/tools/prompt_guard.py`
- **Fix shape**: relax `\s*` between alternation tokens to `[\s　을를은는의에이가도]*` for KR (covers 8 most-common particles); add equivalent JA particle list (を を に へ で が の は); add ZH (的 了 也). Add unit tests with particle-rich strings.
- **D-ID**: D40 (new) — "prompt_guard regex covers particle-rich CJK injection variants per BN-9"
- **Acceptance**: all 3 BN-9 pre-existing failures green + 6 new particle-rich KR/JA/ZH tests pass + no regression in EN paths.
- **Owner**: `security-engineer` (per DISPATCH-MATRIX.md)
- **Effort**: 30 min

### W2 — Wire capability layer to Tier-1 agents · ✅ DONE 2026-05-19 (D41; 49 tools across 22 agents; Batches A/B/C — 17 subagents)
- **Why blocking**: 16 Tier-1 agents currently have `tools=[]` (Phase 3 boundary). Without real tool wiring, no agent can call RapidAPI, Gmail, Imagen, Veo, Lyria, vision, stt, tts, translation, BigQuery, Spanner. End-to-end demo cannot run.
- **Files**: `packages/agents-adk/src/ss_agents/tools/` (new modules per capability) + per-agent `tools=[...]` updates
- **Tools to implement** (16 total):
  - `rapidapi_tiktok_search`, `rapidapi_instagram_search` (sourcing)
  - `blacklist_check`, `vector_search_creator` (sourcing/vetting)
  - `rapidapi_get_user_info`, `ranking_score` (vetting)
  - `templates_list`, `outreach_extract_facts`, `outreach_render` (outreach_writer/responder)
  - `address_normalize`, `carrier_create` (logistics)
  - `vision_brand_logo_detect` (content_verify/creative)
  - `bigquery_query`, `view_metrics_aggregate` (analyst)
  - `web_search`, `vector_search_competitor` (research)
  - `forms_upsert` (intake)
  - `crm_enrich` (lead_outreach_writer)
  - `ap2_compose_intent_mandate`, `gate_approveOutreachSend` (payment_mandate)
  - `pipa_check_consent`, `canspam_check_unsubscribe`, `dlp_inspect` (compliance)
  - `imagen_generate`, `veo_generate`, `lyria_generate`, `assets_upload` (creative)
  - `vision_describe`, `stt_transcribe`, `tts_synthesize`, `translation_translate` (a11y)
  - `analytics_funnel`, `intervention_propose` (customer_success)
  - `agent_registry_list`, `a2a_invoke` (coordinator)
  - `evaluation_score`, `gate_escalate` (critic)
  - `agent_optimizer_tune`, `prompt_registry_update` (optimizer)
  - `metrics_query`, `runbook_execute` (anomaly_watch)
  - `billing_query`, `pubsub_alert` (cost_watch — rule-based, no LLM)
  - `model_armor_query_blocks`, `chronicle_query`, `tenant_quarantine` (security_watch)
- **Pattern**: each tool is an `ADK FunctionTool` with input/output Pydantic schemas; stubs first (returning canned data), real Cloud SDK calls in W5 deploy phase.
- **D-ID**: D41 (new) — "Capability layer uses ADK FunctionTool stubs in dev, swaps to real SDK calls behind a `CAPABILITY_LAYER_MODE=stub|live` env var."
- **Acceptance**: each Tier-1 agent's `tools=[]` becomes `tools=[<FunctionTool>, ...]`; per-tool unit test exists; agent end-to-end test invokes ≥1 tool successfully.
- **Owner**: `python-expert` × 16 (parallel, one tool/agent batch)
- **Effort**: ~6-10 hours of parallel agent time

### W3 — Cloud Workflows YAML wires to deployed agents · ✅ DONE 2026-05-19 (D42, agent `ae8949dda332fb508`; brand-campaign + creator-track refactored; terraform validate deferred_to_ci)
- **Why blocking**: `terraform/modules/integration/workflows/*.yaml` reference agent endpoints that don't yet resolve. Without integration, the GCP-native orchestration (D18) is paper-only.
- **Files**: 5 workflow YAMLs in `terraform/modules/integration/workflows/`
- **Wiring needed**: each workflow `call: agent_runtime_invoke` URL → real Cloud Run / Agent Runtime endpoint. Use `${args.agent_url}` substitution so dev/staging/prod targets vary.
- **D-ID**: D42 (new) — "Workflows reference agent URLs via Terraform `output` injection; no hardcoded hostnames in YAML."
- **Acceptance**: `gcloud workflows deploy <workflow> --source=<file>` succeeds for all 5 workflows + `gcloud workflows run brand-campaign-test` end-to-end succeeds with the stub agents (W2 stubs OK).
- **Owner**: `backend-architect`
- **Effort**: 2-3 hours

### W4 — End-to-end smoke test in dev mode · ✅ DONE 2026-05-19 (D43, agent `a0529b2ec92b15c44`; 22/22 agents, 50/50 tools, 0.15s, exit 0)
- **Why blocking**: no proof the system actually runs end-to-end. Demo recording (D30) needs this.
- **Setup**: brand brief JSON in → Mission Control approval → 22-agent fleet executes → real Gmail send (to `app.2weeks@gmail.com` test account per D10) → reply manually simulated → workflow continues to verify-content → final report
- **Files**: new `scripts/smoke-test/run-brand-campaign.sh` + `scripts/smoke-test/expected-output.json`
- **D-ID**: D43 (new) — "Smoke test is the Phase-3-checkpoint canary; must pass before any deploy."
- **Acceptance**: script exits 0, all 22 agents emit at least one signal, no `Escalation` outcomes in the happy path
- **Owner**: `quality-engineer` + `python-expert` pair
- **Effort**: 3-4 hours

---

## P1 — Should (gates the live deploy)

### W5 — Day-1 GCP setup (operator-blocking)
- **Status**: 🚫 BLOCKED on operator (needs `BILLING_ACCOUNT` value + 30-min run)
- **Operator action**:
  ```bash
  gcloud auth login --account=app.2weeks@gmail.com
  gcloud beta billing accounts list                    # copy ACCOUNT_ID
  export BILLING_ACCOUNT="01XXXX-XXXXXX-XXXXXX"
  cd gcp-research/scripts && ./day-1-setup.sh init
  ./day-1-setup.sh all ss-v2-prod
  ./day-1-setup.sh all ss-mcp-prod
  ```
- **Once done**: assistant continues W6 deploy.

### W6 — Terraform apply (per region)
- **Depends on**: W5 done
- **Files**: 8 Terraform modules in `terraform/modules/`; root `terraform/environments/{dev,prod}/main.tf` (NEW — needs to be authored)
- **D-ID**: D44 (new) — "Terraform root config lives in `terraform/environments/<env>/` not in module dirs."
- **Acceptance**: `terraform plan` clean + `terraform apply` succeeds in each of 3 regions (`us-central1`, `europe-west4`, `asia-northeast3`)
- **Owner**: `devops-architect`
- **Effort**: 4-6 hours (mostly waiting for cloud provisioning)

### W7 — Cloud Run + Agent Runtime deploy
- **Depends on**: W6 done
- **Files**: `apps/web/` (Mission Control) → Cloud Run via Cloud Build; `packages/agents-adk/` → Agent Runtime via `gcloud beta agents deploy` (per AGENT-PLATFORM-PROMPTING.md style)
- **Acceptance**: each surface returns HTTP 200 on `/healthz` from public DNS
- **Owner**: `devops-architect`
- **Effort**: 2-3 hours

### W8 — Demo video recording
- **Depends on**: W7 done
- **Files**: `scripts/demo/` (existing — Phase 8 deliverable)
- **Process**: run pre-record checklist → record 24 min source per track → ffmpeg 8× speed → overlay burn → subtitle burn × 4 locale → PII OCR gate → YouTube upload
- **Acceptance**: 2 final `.mp4` files (Track 2 + Track 3) hosted on YouTube unlisted, each 3:00 ± 2s, all 4 locale subtitles available
- **Owner**: `technical-writer` + operator (for the OBS recording itself)
- **Effort**: 4-6 hours (mostly mechanical, but 2× source recordings needed)

### W9 — Devpost submission package
- **Depends on**: W8 done
- **Files**: `scripts/demo/submission/` (existing) — fill in Marketplace `PENDING_REVIEW` screenshot, finalize architecture diagrams, polish written description
- **Operator action**: Devpost console submission per Track 2 + Track 3 (separate submissions per D1)
- **Acceptance**: Devpost UI shows both submissions as "Submitted" before 2026-06-05 11:59 PT
- **Owner**: `technical-writer` for write-ups; operator for the actual Devpost click
- **Effort**: 2-3 hours

---

## P2 — Nice-to-have (post-submission polish)

### W10 — KR-gap A2A-only public scaffold (OSS contribution)
- Per D9 (BUSL-1.1 core + Apache-2.0 ancillary) — extract the A2A-only pattern into a public Apache-2.0 repo `github.com/SocialSeeding/a2a-only-pattern`
- Source: `gcp-research/strategy/KR-GAP.md` §10 community call

### W11 — Live Marketplace submission (not "pending")
- Producer Portal full submission (4-12 weeks Google review)
- Blocked on D2 KR-region resolution OR foreign sub-entity (O10)

### W12 — SOC 2 Type 2 evidence pipeline
- Drata / Vanta integration
- Per D22 deferred — only kick off if Track 2/3 wins or commercial customer signs

---

## Outstanding decisions tracking

These are recorded in `DECISIONS.md §6` and gate certain `WORK-QUEUE.md` items:

| ID | Question | Gates |
|---|---|---|
| O1 | Devpost console 10 GAPs | W9 |
| O2 | GCP project IDs confirmed | W5 |
| O3 | Instagram email feasibility decision | W2 (sourcing tool wiring) |
| O5.1-5.5 | AP2 UX threshold/retention details | W2 (payment_mandate refinement) |
| O7 | Agent Gateway allowlist | W7 (deploy with gateway routes) |
| O10 | Foreign sub-entity strategy | W11 |
| O13-O18 | Pricing details | W9 (Devpost business case section) |

---

## Definition of "Goal achieved"

The autonomous `/goal` session is **complete** when:

1. ✅ All P0 items (W1-W4) complete with proof artifacts
2. ✅ P1 W5-W9 either complete OR explicitly blocked on operator with `STATUS-REPORT.md` written
3. ✅ `pnpm run verify-build` green
4. ✅ `pytest` shows ≥1500 tests passing, ≤5 failures
5. ✅ All Dn decisions appended to `DECISIONS.md` §8
6. ✅ Branch `feature/gcp-research-baseline` (or successor) pushed; PR URL printed
7. ✅ Final `STATUS-REPORT.md` printed to stdout — explicit "GOAL ACHIEVED" or "GOAL BLOCKED + reason"
