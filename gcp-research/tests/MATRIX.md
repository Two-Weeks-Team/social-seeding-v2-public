# MATRIX.md — 5-Layer Test Pyramid for the 22-Agent Fleet

> **Authority**: This document is derived from [`../decisions/DECISIONS.md`](../decisions/DECISIONS.md) (D37 + D23 + D25 + D31 + D38) and [`../decisions/ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) (§3 per-agent service mapping + §7 build pipeline). When a test design here conflicts with a recorded decision, the decision wins. Where this matrix names a peer document not yet authored (Task #31 Simulation, Task #33 Chaos), it specifies the contract those documents must honor.
>
> **Audience**: (1) Background agents implementing the test infrastructure, (2) PR authors crossing the test-pyramid boundary, (3) judges reviewing reproducibility evidence for the Tech-30 / Demo-20 weights.
>
> **Snapshot**: 2026-05-19. 354 v2 tests already green (4 observability · 64 agents · 183 capabilities · 103 workflows per [`/Users/kimsejun/Documents/GitHub/social-seeding-v2/CLAUDE.md`](../../CLAUDE.md) "Current state"). This file plans the **5-layer extension** that takes v2 from 354 deterministic tests to the production-grade pyramid D37 requires.

---

## 1. The fleet under test (22 agents, D23)

The pyramid covers everything in [`ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §3. Counts and tier breakdown match D23 / D38:

| Tier | Count | Agents | Test ownership |
|---|---|---|---|
| **T1 Domain** | 16 | sourcing, vetting, outreach_writer, conversation, conversation_responder, logistics, content_verify, analyst, research, intake, lead_outreach_writer, **payment_mandate**, **compliance**, **creative**, **a11y**, **customer_success** (bold = NEW per D23) | Layers 1+3+4 (Agent Evaluation, pytest, Simulation) |
| **T2 Meta** | 3 | coordinator (M1), critic (M2), optimizer (M3) | Layers 1+3+4. Optimizer (M3) **owns the eval-driven-development loop in §10** (D25) |
| **T3 Watchdog** | 3 | anomaly_watch (W1), cost_watch (W2), security_watch (W3) | Layers 2+5 (Vitest for rule logic; chaos for trigger paths). W2 has no LLM — pure pytest + Vitest (D23 calls it "agent-shaped for consistency") |
| **Total** | **22** | — | — |

Per [`ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §3, 11 of the 16 T1 agents have v2 source under [`packages/agents/src/`](../../packages/agents/src/) — those agents already have 64 golden+plumbing tests across the 11 files (`sourcing.golden.test.ts`, `vetting.golden.test.ts`, `outreach-writer.golden.test.ts`, `conversation.golden.test.ts`, `analyst.golden.test.ts`, `intake.golden.test.ts`, plus per-agent `.test.ts` plumbing tests). The 5 NEW agents (payment_mandate, compliance, creative, a11y, customer_success) start at zero and must hit parity before the agent-rebuild phase of [`EXECUTION-CALENDAR.md`](../EXECUTION-CALENDAR.md) closes.

### Pyramid shape (responsibility per layer)

```
                       ┌─────────────────────────────┐
                       │  L5 Chaos engineering        │  ~12 scenarios, nightly
                       │  D33, Task #33 ⇒ D31 SLO     │  multi-region fault injection
                       └─────────────────────────────┘
                    ┌────────────────────────────────────┐
                    │ L4 Agent Simulation                 │ 1000+ scenarios, nightly
                    │ D25 + Task #31, RLHF reward source  │ runs full 22-agent fleet end-to-end
                    └────────────────────────────────────┘
              ┌──────────────────────────────────────────────┐
              │ L1 Vertex AI Agent Evaluation                 │ per-PR + nightly
              │ D37 layer 1, per-agent .evalset.json          │ trajectory + LLM judge
              │ ≥1 evalset per T1 agent (16 total minimum)    │
              └──────────────────────────────────────────────┘
          ┌──────────────────────────────────────────────────────┐
          │ L3 pytest (agents — Python ADK)                       │ per-PR
          │ D37 layer 3, Pydantic property + plumbing tests       │ ~250 tests target
          │ Inherits the structure of v2's existing .test.ts      │
          └──────────────────────────────────────────────────────┘
      ┌──────────────────────────────────────────────────────────────┐
      │ L2 Vitest (capabilities + workflows + observability — TS)     │ per-PR
      │ D37 layer 2, 354 v2 tests carry forward (D35 hybrid codebase) │
      │ + new capability tests for Spanner/AlloyDB/Firestore adapters │
      └──────────────────────────────────────────────────────────────┘
```

Justification of shape: deterministic tests at the wide base are the only layer cheap enough to gate every PR; L4 Simulation and L5 Chaos are nightly because each scenario costs >$0.10 in Gemini calls (D39 budget makes this affordable at 1000 scenarios/night = ~$100/night, well within the $1500 challenge envelope). L1 Agent Evaluation runs per-PR but on a small per-agent evalset (10-30 cases) — full evaluation runs nightly with the full golden set.

---

## 2. Layer 1 — Vertex AI Agent Evaluation (LLM-as-judge + trajectory)

### 2.1 What L1 is

Per [`AI-AGENTS.md`](../ai-agents/AI-AGENTS.md) and Google's Vertex AI documentation (https://cloud.google.com/vertex-ai/generative-ai/docs/models/evaluation-overview), Agent Evaluation runs two evaluator families against a stored `.evalset.json`:

1. **Trajectory evaluators** — compare the actual tool-call sequence against an expected sequence; modes are `EXACT`, `IN_ORDER`, `ANY_ORDER` (https://cloud.google.com/vertex-ai/generative-ai/docs/agents/eval-overview#trajectory).
2. **LLM-as-judge evaluators** — score the final response against a rubric. Built-in metrics include `response_match_v2`, `safety_v1`, `groundedness`, `hallucinations_v1`; custom rubrics use Gemini 2.5 Pro as the judge model.

D37 names this layer first because it is the only one that exercises real Gemini calls inside CI. Mocks in L2/L3 can pass while the agent regresses on the model side.

### 2.2 Per-Tier-1 evalset specification

For each of the 16 T1 agents, the deliverable is an `.evalset.json` at `gcp-research/evals/<agent>/<agent>.evalset.json` and a `gcloud aiplatform evaluation-runs create` invocation in [`../scripts/run-evals.sh`](../scripts/run-evals.sh). The eval criteria below are derived from the "Eval criteria" column of [`ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §3 and the existing v2 golden tests.

| Agent | Golden-set size (min) | Trajectory mode | Primary metric | Threshold | Source of golden cases |
|---|---|---|---|---|---|
| `sourcing` | 12 | `ANY_ORDER` (tiktok.search + blacklist.check + (optional) vector_search.creator can interleave) | `tool_trajectory_avg_score >= 0.85` + `coverage_note_match >= 0.80` (custom) | both must pass | 3 already in `sourcing.golden.test.ts:117-159` (comfortable / tight / excludeCreatorIds) — extend with 9 more |
| `vetting` | 15 | `IN_ORDER` (get_user_info → ranking.score → vector_search.brand_fit; rare reordering) | `tool_trajectory_avg_score >= 0.90`, `fit_score_mae <= 0.08` (custom regression against pinned scores) | both | extend `vetting.golden.test.ts` |
| `outreach_writer` | 20 | `IN_ORDER` (extractFacts → judge×4 → (optional) judge re-do) | `response_match_v2 >= 0.75` + `spam_score == 0` + `judge_weighted_score >= 0.80` | all three | 3 cases pinned in `outreach-writer.golden.test.ts:204-294` (happy / revision / escalation); extend to 20 by combining 5 angles × 4 categories |
| `conversation` | 25 | n/a (single Flash-Lite classification, no tools) | `classification_f1 >= 0.92` per 8 reply categories | weighted f1 across all categories | reuse v2 `conversation.golden.test.ts` set |
| `conversation_responder` | 15 | `ANY_ORDER` (templates.list + outreach.render) | `response_match_v2 >= 0.75` + tone_consistency (custom Gemini judge) `>= 0.80` | both | new — derive from v2 production reply samples (PII-redacted via DLP per D20) |
| `logistics` | 30 | n/a (single Flash call, free-text → JSON) | `structured_extract_accuracy >= 0.95` (field-by-field) | weighted across 6 fields (name/phone/postal/street/city/country) | new — Korean + English + Japanese addresses (D34 i18n parity) |
| `content_verify` | 20 | `IN_ORDER` (post_detail → vision.brand_logo_detect) | `precision >= 0.95` AND `recall >= 0.85` against holdout of 100 hand-labeled posts | both | new — labeled by human annotator; LLM judge cross-checks |
| `analyst` | 10 | `IN_ORDER` (bigquery.query → view_metrics.aggregate) | `groundedness >= 0.90` + `numeric_accuracy >= 0.99` (custom — exact match on cited numbers) | both | extend `analyst.golden.test.ts` |
| `research` | 15 | `ANY_ORDER` (web.search + vector_search.competitor can repeat) | `hallucinations_v1 <= 0.05` + citation_count `>= 3` | both | new |
| `intake` | 12 | n/a (Flash, single conversational turn, may call forms.upsert) | `task_completion >= 0.85` + slot_fill_accuracy `>= 0.90` | both | extend `intake.golden.test.ts` |
| `lead_outreach_writer` | 15 | `IN_ORDER` (templates.list → crm.enrich → outreach.render) | `response_match_v2 >= 0.75` + spam_score == 0 | both | new — B2B template scenarios |
| `payment_mandate` (NEW) | 10 | `EXACT` (ap2.compose_intent_mandate → gate.approveOutreachSend) — sequence is invariant per D27 | `mandate_validity = 1.0` (custom — schema valid + amount within budget cap + tenant match) | strict pass/fail | new — covers each of D27's Intent Mandate fields |
| `compliance` (NEW) | 25 | `ANY_ORDER` (pipa.check_consent + canspam.check_unsubscribe + dlp.inspect, any order) | `false_clear_rate <= 0.01` (custom — agent must never approve a non-compliant draft) + `false_block_rate <= 0.05` | both; false_clear is the safety-critical metric | new — Korean PIPA Art 23/24 cases + US CAN-SPAM cases |
| `creative` (NEW) | 8 | `IN_ORDER` (imagen.generate → assets.upload → (optional) veo.generate) | `safety_v1 >= 0.95` + `brand_consistency >= 0.80` (custom Gemini-as-judge against brand-style-guide RAG) | both | new — 8 brand briefs |
| `a11y` (NEW) | 20 (5 per locale × 4 locales D34) | `ANY_ORDER` (vision.describe + stt.transcribe + tts.synthesize + translation.translate) | `a11y_compliance_score >= 0.90` (custom — WCAG 2.2 AA checklist) | weighted | new — locale parity is the test |
| `customer_success` (NEW) | 15 | `IN_ORDER` (analytics.funnel → intervention.propose) | `activation_lift >= 0.10` predicted lift validated against post-intervention BigQuery data; trajectory required as `IN_ORDER` | both | new — 15 onboarding-friction archetypes |

**Total minimum L1 golden cases**: 12+15+20+25+15+30+20+10+15+12+15+10+25+8+20+15 = **267** across 16 T1 agents (mean 16.7 cases/agent). Existing v2 golden tests provide the seed for 6 agents; the remaining 10 are net-new.

### 2.3 Trajectory mode rationale (D37)

The choice of `EXACT` vs `IN_ORDER` vs `ANY_ORDER` is load-bearing. Wrong choice produces brittle tests (false reds) or permissive tests (false greens). Per Vertex docs (https://cloud.google.com/vertex-ai/generative-ai/docs/models/evaluation-overview):

- `EXACT` — tool name, arguments, and order all match. Use only when the protocol is a strict spec (e.g. `payment_mandate` per D27 — Intent Mandate composition cannot vary).
- `IN_ORDER` — tools must appear in the expected order, but extra tools may be interleaved. Use for pipelines with a fixed shape but optional enrichment (`outreach_writer`'s extractFacts → judges).
- `ANY_ORDER` — only the set of tools matters. Use for agents where order is genuinely free (`sourcing` may call `tiktok.search` before or after `blacklist.check`).

When the v2 plumbing tests already pin a sequence with `toolSpans.filter` (e.g. `outreach-writer.golden.test.ts:225-227`), that pin migrates to `IN_ORDER` in the evalset.

### 2.4 Authoring the `.evalset.json`

Schema per https://cloud.google.com/vertex-ai/generative-ai/docs/agents/eval-overview:

```jsonc
{
  "name": "outreach_writer_v1",
  "description": "Pinned scenarios for the 5-angle tournament writer (D-ID: D23, source: outreach-writer.golden.test.ts)",
  "eval_cases": [
    {
      "name": "happy_path_clean_draft",
      "input": {
        "brief": { /* CampaignBrief — packages/contracts schema */ },
        "creator": { /* TikTokCreator */ },
        "recentPosts": [ /* … */ ]
      },
      "expected": {
        "tool_trajectory": [
          {"tool_name": "outreach.extractFacts"},
          {"tool_name": "outreach.judge", "tool_input": {"judge": "brand"}},
          {"tool_name": "outreach.judge", "tool_input": {"judge": "conversion"}},
          {"tool_name": "outreach.judge", "tool_input": {"judge": "deliverability"}},
          {"tool_name": "outreach.judge", "tool_input": {"judge": "skeptic"}}
        ],
        "trajectory_mode": "IN_ORDER",
        "reference_response": { /* the cleanDraft constant from outreach-writer.golden.test.ts:80-86 */ }
      },
      "metrics": ["tool_trajectory_avg_score", "response_match_v2", "spam_score"]
    }
  ]
}
```

Authoring rule: every case in a v2 `.golden.test.ts` ports to one entry in the corresponding evalset, with input/expected pulled verbatim from the test fixtures. This is the cheapest way to seed the evals — the work is already done.

Trigger: per-PR runs the 5-case fast-eval subset per agent (=80 cases total, ~$0.40 in Gemini calls). Nightly runs the full 267-case suite (~$25/night per [`../cost-planning/COST-PLAN.md`](../cost-planning/COST-PLAN.md) if it exists; budget signed off via D39).

### 2.5 Out-of-scope for L1

- T2 agents (coordinator, critic, optimizer) — they are evaluated **transitively** via L4 Simulation (running L1 evals through them) rather than directly. The `critic` (M2) is itself an LLM-as-judge, so evaluating it requires a separate "judge of judges" evalset (defer to Phase 2 per D24's "0→1 hybrid in-process").
- T3 watchdogs — rule-based or operations-focused; L1 not applicable. They get L2 unit tests + L5 chaos tests.

---

## 3. Layer 2 — Vitest (capabilities — TypeScript)

### 3.1 What carries forward

Per D35 ("Hybrid — keep v2 `packages/capabilities/` + `packages/contracts/` + `packages/db/`"), the existing 22 capability test files + 13 workflow test files + 1 observability test file (= 36 files, 354 tests) remain green. The names below are the authoritative reference list:

**Capabilities (22 files)** — [`packages/capabilities/src/`](../../packages/capabilities/src/):
- `usage.test.ts`, `ranking/score.test.ts`, `workspace/policy.test.ts`, `crm/enrich.test.ts`, `crm/search.test.ts`, `suppression/check.test.ts`, `blacklist/check.test.ts`, `templates/render.test.ts`, `shipment/create.test.ts`, `shipment/track.test.ts`, `tiktok/get-user-info.test.ts`, `tiktok/get-user-posts.test.ts`, `tiktok/search.test.ts`, `tiktok/get-creator.test.ts`, `outreach/extract-facts.test.ts`, `outreach/judge.test.ts`, `gmail/pubsub.test.ts`, `gmail/send.test.ts`, `gmail/unsubscribe-token.test.ts`, `gmail/client.test.ts`, `gmail/spam-score.test.ts`, `analytics/compile.test.ts`

**Workflows (13 files)** — [`packages/workflows/src/`](../../packages/workflows/src/):
- `pause.test.ts`, `imports.v1-workspaces.test.ts`, `gate.test.ts`, `imports.v2-rollout.test.ts`, plus 9 per-workflow tests under `workflows/` (brand-campaign, creator-track, gmail-watch-renew, report-deliver, tiktok-post-poller, shipment-tracking-poller, lead-campaign, report-deliver-cron, campaign-progression)

**Observability (1 file)** — [`packages/observability/src/observability.test.ts`](../../packages/observability/src/observability.test.ts)

### 3.2 What changes under D15 / D16

The capability test bodies stay; only the **repository fixture** changes from `mongodb-memory-server` (per current [`packages/agents/src/sourcing.golden.test.ts:71`](../../packages/agents/src/sourcing.golden.test.ts) `if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first")`) to the corresponding GCP emulator:

| v2 store (current) | D15 target store | Local test emulator | Vitest setup file |
|---|---|---|---|
| MongoDB Atlas (shared) | **Spanner Multi-region** (core / tenant / billing tables — D15) | `gcloud emulators spanner start --host-port=localhost:9010` (https://cloud.google.com/spanner/docs/emulator) | `scripts/dev-spanner.ts` — port-bind + DDL bootstrap |
| MongoDB Atlas (shared) | **AlloyDB AI** (analytics + feature store — D15) | **AlloyDB Omni** — Docker container `gcr.io/alloydb-omni/community-alloydb-omni-server` (https://cloud.google.com/alloydb/omni/docs) | `scripts/dev-alloydb.ts` — pgvector ext + columnar engine boot |
| MongoDB Atlas (Memory Bank backing) | **Firestore Native** (Memory Bank — D15) | `gcloud emulators firestore start --host-port=localhost:8580` (https://cloud.google.com/firestore/docs/emulator) | `scripts/dev-firestore.ts` |
| n/a (RapidAPI is HTTP) | n/a | nock interceptors (unchanged) | unchanged |
| n/a | **Vertex AI Vector Search** (D16) | **no first-class emulator exists**. Use Vitest mock with a small in-memory cosine-similarity stub honoring the same Zod contract from [`packages/contracts/`](../../packages/contracts/). Integration test runs against a dedicated `ss-v2-test-{region}` index in nightly. | `vector-search.mock.ts` + cron-tested integration |
| n/a (Pub/Sub is event-driven) | Pub/Sub | `gcloud emulators pubsub start --host-port=localhost:8085` | `scripts/dev-pubsub.ts` |
| n/a | BigQuery | **No emulator from Google**; use `goccy/bigquery-emulator` (https://github.com/goccy/bigquery-emulator) for capability tests; integration in nightly hits a `ss-v2-test` dataset | `scripts/dev-bigquery.ts` |

The **GCP emulator coverage gap** (no Vertex Vector Search emulator, no first-party BigQuery emulator) means two capability tests stay mock-only in L2; the **integration coverage** for those two stores lives in L4 Simulation (which must hit real services per D39's enabled $1500 budget).

### 3.3 Coverage targets (L2, per package)

Coverage is measured by `vitest --coverage` (v8 reporter). Per-package floors:

| Package | Line | Branch | Function | Mutation (Stryker — nightly only) |
|---|---|---|---|---|
| `@ss/capabilities` | 90% | 85% | 95% | 70% killed |
| `@ss/contracts` | 95% | 90% | 100% (every exported Zod schema must have at least one parse + one safeParse test) | 75% killed |
| `@ss/workflows` | 85% | 75% | 90% | 60% killed (Cloud Workflows YAML steps are tested via L4) |
| `@ss/observability` | 85% | 80% | 90% | 65% killed |
| `@ss/db` | 80% | 70% | 85% | 55% killed (much of the surface is I/O — covered by integration in L4) |

Mutation testing budget: nightly only, capped at 20 minutes per package via `stryker --concurrency 4`. Mutation reports are pinned in BigQuery for the optimizer (M3) to consume (see §10).

---

## 4. Layer 3 — pytest (agents — Python ADK)

### 4.1 Why Python at all

Per [`EXECUTION-CALENDAR.md`](../EXECUTION-CALENDAR.md) Day 2 ("Install ADK 2.0 Beta + Vertex AI SDK in a new `packages/agents-adk/` subdir") and D17 (Agent Runtime managed Python), the 22 agents move from the TypeScript `@anthropic-ai/sdk` runtime under [`packages/agents/src/`](../../packages/agents/src/) to ADK Python under `packages/agents-adk/`. The 64 existing TS agent tests in [`packages/agents/src/*.test.ts`](../../packages/agents/src/) are kept green during the transition (D35 hybrid codebase) and ported case-by-case to pytest as each Python agent ships. Per D38, the M3 PM agent coordinates the port via the PreviewForge-style task DAG.

### 4.2 Pydantic-based property tests

Each ADK agent declares a Pydantic input model and a Pydantic output model (https://google.github.io/adk-docs/agents/llm-agents/#structured-data-input-output). The L3 test contract: every agent must have **3 test classes** per `tests/agents/test_<agent>.py`:

| Test class | Purpose | Tools used | Existing v2 analog |
|---|---|---|---|
| `TestInputContract` | Parametrized Hypothesis property tests asserting that every valid Pydantic input is accepted and every invalid one raises `ValidationError` | `hypothesis` (https://hypothesis.readthedocs.io/) + `pydantic.ValidationError` | n/a — net new |
| `TestPlumbing` | Mocked-LLM scripted-tool-sequence tests (the direct equivalent of v2's `outreach-writer.golden.test.ts` `script()` helper) | `pytest-mock` + ADK's `agent.tools.mock` (https://google.github.io/adk-docs/testing/) | `packages/agents/src/outreach-writer.golden.test.ts:99-181` |
| `TestEscalation` | Forces every escalation path (e.g. `insufficient_context`, `budget_exceeded`, `tool_failure`) and asserts the agent surfaces the typed `Escalate` output without burning the rest of its turn budget | `pytest-mock` + ADK `agent.session.budget` shim | `packages/agents/src/outreach-writer.golden.test.ts:255-294` |

Per agent, this yields ~12-20 pytest cases. 16 T1 agents × 15 cases (mean) = **240 cases**. Plus M1/M2/M3 (3 × ~15 = 45) and W1/W2/W3 (3 × ~8 = 24, more rule-shaped). **Total L3 cases**: ~310.

### 4.3 Shared fixtures across the 16 T1 specs

The 16 specs in [`gcp-research/specs/`](../specs/) (Task #25 deliverable) share these pytest fixtures under `tests/conftest.py`:

```python
@pytest.fixture
def brand_brief() -> CampaignBrief:
    """The Hydra Serum brief used across v2 golden tests
       (packages/agents/src/outreach-writer.golden.test.ts:41-59).
       Keep identical to ensure cross-pyramid comparability."""

@pytest.fixture
def fake_creator() -> TikTokCreator:
    """@freshly — the 42k-follower k-beauty creator from
       outreach-writer.golden.test.ts:61-73."""

@pytest.fixture
def memory_bank_inmemory():
    """In-memory replacement for Agent Memory Bank
       (Firestore-backed per D15). Cleared per test."""

@pytest.fixture
def usage_store_inmemory() -> UsageStore:
    """Mirrors memUsageStore in outreach-writer.golden.test.ts:30-34."""

@pytest.fixture
def trace_sink_memory():
    """Mirrors memorySink() in observability.test.ts."""

@pytest.fixture
def workspace_ctx_default() -> CapabilityCtx:
    """The ctx0() pattern from outreach-writer.golden.test.ts:36-39
       — workspace=ws_wg, user=21-char synth, rate=default."""

@pytest.fixture(params=["ko", "en", "ja", "zh-CN"])
def locale(request):
    """D34 i18n parity — every relevant agent must pass under all 4
       locales. Drives the a11y agent's whole evalset."""
```

The `brand_brief` and `fake_creator` fixtures are **load-bearing**: they are the cross-layer continuity between v2 TS tests, ADK pytest, and Vertex Agent Evaluation evalsets. Changing them changes all three. The conventions doc at [`../decisions/ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §3 freezes them.

### 4.4 Coverage targets (L3)

| Package | Line | Branch | Property-test mutation kill rate |
|---|---|---|---|
| `packages/agents-adk/` | 85% | 75% | 65% (Hypothesis shrunk failures) |

### 4.5 What L3 does NOT cover

- **Real Gemini calls** — those live in L1.
- **Real Spanner/AlloyDB/Firestore I/O** — those live in capability adapter tests (L2 integration nightly).
- **Multi-agent orchestration** — that lives in L4.

---

## 5. Layer 4 — Agent Simulation (1000+ scenario regression)

### 5.1 Contract with Task #31

Per D25 ("RLHF on Agent Simulation") and D37 ("Agent Simulation 1000+ scenarios"), this layer runs the **entire 22-agent fleet end-to-end** against generated scenarios. The scenario generator is delivered by Task #31 ([`../simulation/SCENARIOS.md`](../simulation/SCENARIOS.md) — pending). This MATRIX specifies the **contract** L4 must honor:

| Field | Type | Meaning | Example |
|---|---|---|---|
| `scenario_id` | string (ULID) | unique replayable identifier | `01J9ZX1Q7N8KQP5W2H6P3V8T1A` |
| `tier` | enum `T1` / `T2_orchestration` / `T3_chaos_seed` | which pyramid layer consumes this scenario | `T1` |
| `inputs` | JSON conformant to [`packages/contracts/`](../../packages/contracts/) schemas | brief + creator pool + budget + tenant | `{ brief: {...}, candidates: [...] }` |
| `expected_outcome` | enum + optional rubric | what "success" looks like — terminal state, response shape, ledger constraint | `{ kind: "campaign_completed", min_creators_shipped: 3, max_cost_usd: 50 }` |
| `chaos_seeds` | array of [`../chaos/SCENARIOS.md`](../chaos/SCENARIOS.md) IDs | optional — which faults to inject mid-run (links L4↔L5) | `["spanner_failover_us_central"]` |
| `slo_targets` | object | per-scenario SLO assertions per D31 | `{ p99_ms: 1000, rpo_sec: 30 }` |
| `replay_metadata` | object | timestamp, seed for RNG, model version (Gemini 2.5 Pro `2026-04` snapshot etc.) | — |

The generator MUST produce **>= 1000 unique scenarios** spanning these axes (combinatorial):
- 4 locales × 6 verticals × 3 tenant sizes (single-user / SMB / enterprise) × 4 budget tiers × 4 outcome variants (happy path / reply / no-reply / escalation) = **1152 baseline scenarios**. Plus a curated 100-scenario "adversarial" set seeded from `gcp-research/edge-cases/CATALOG.md` (Task #27).

### 5.2 Simulation harness

- Runs against a dedicated `ss-v2-sim` GCP project (separate from prod/test per D39 budget envelope).
- Uses Agent Runtime canary endpoints (https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview) so simulation traffic never mixes with production canary.
- Outputs per scenario: pass/fail, full Cloud Trace, OTLP cost ledger row, BigQuery row at `ss-v2-sim.agent_evals.simulation_runs`.
- Aggregates nightly into a **regression score** = (passing scenarios / total) − (passing scenarios at last-tagged-green release / total).
- Feeds the **RLHF reward signal** to Agent Optimizer (M3) per D25. A scenario that flips from pass → fail produces a negative reward; scenarios that pass faster/cheaper produce positive reward.

### 5.3 Trigger

Nightly (cron, 02:00 UTC) per [`ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §7. Manual trigger via `gcloud builds submit --substitutions=_FORCE_SIM=true`. On a prompt-diff PR from the optimizer (§10), a 100-scenario subset (random + the scenarios that touched the changed agent in the last 7 days) runs synchronously.

### 5.4 Pass criteria

Nightly regression score must be **>= -0.005** (= no more than 0.5% drop in pass rate vs last green). A larger regression auto-files a Cloud Workflow runbook (D32) that pages the on-call.

---

## 6. Layer 5 — Chaos engineering

### 6.1 Contract with Task #33

L5 lives at [`../chaos/SCENARIOS.md`](../chaos/SCENARIOS.md) — pending. This MATRIX specifies what L5 must cover and how it ties to D31 SLOs.

### 6.2 Toolchain (D37)

D37 names **Litmus / Gremlin / Spanner failover / Pub/Sub drop** as the chaos surface. Mapping to actual GCP-native or open-source tools:

| D37 named | Real tool | Surface | Citation |
|---|---|---|---|
| Litmus | LitmusChaos on GKE Autopilot (Agent Sandbox per [`ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §2) | container/pod-level fault injection | https://litmuschaos.io/ |
| Gremlin | Gremlin SaaS — paid; alternative is GCP **Fault Injection Testing** preview | network/host/process fault injection | https://cloud.google.com/architecture/framework/reliability/conduct-tests-improve-reliability ("Inject faults using Fault Injection Testing") |
| Spanner failover | **Spanner managed failover test** (manual + scripted) | regional failover validation | https://cloud.google.com/spanner/docs/managed-failover |
| Pub/Sub drop | **Pub/Sub schema violations + dead-lettering** + GCP outage drill | message loss tolerance | https://cloud.google.com/pubsub/docs/dead-letter-topics |

### 6.3 Chaos scenarios mapped to D31 SLOs

D31: **99.99% availability / p99 < 1s / RTO 1 min / RPO 30 s**. Each SLO needs at least one chaos test that asserts the SLO holds under the corresponding failure:

| SLO | Chaos scenario | Tool | Pass criteria | Failure mode tested |
|---|---|---|---|---|
| 99.99% availability | `regional_outage_us_central` — drop all `us-central1` Agent Runtime + Cloud Run replicas | Litmus pod-kill at GKE level + Cloud Run revision disable | Global LB shifts ≥99% of traffic to `europe-west4` within 60 s; user-visible error rate <0.1% | Regional outage |
| 99.99% availability | `spanner_regional_failure` | `gcloud spanner instances perform-failover` | RW traffic auto-resumes within RTO 60 s; no data loss (RPO 30 s) | Spanner regional failure |
| p99 < 1s | `vertex_gemini_429` — synthetic 429 on Vertex AI generateContent | Pub/Sub-driven request mirror that returns 429 | Agent retries with exponential backoff; circuit breaker opens after 5 consecutive 429s; user-observed p99 still ≤1.5s during 5-min window | Gemini rate limit |
| p99 < 1s | `memorystore_eviction_storm` — flush Memorystore Valkey | redis-cli FLUSHALL on emulator | Cold cache warms within 90 s; p99 spikes ≤2s then recovers | Cache failure |
| RTO 1 min | `agent_runtime_oom` — force OOM on Agent Runtime replica | GKE memory-pressure pod | Replica restarts <60 s; in-flight requests drained via Workflows retry (D18 Cloud Tasks) | Agent crash |
| RPO 30 s | `pubsub_drop_5pct` — inject 5% message-drop rate on the brand-campaign topic | Pub/Sub dead-letter trigger + custom subscription | Workflows correlation (D18) recovers all dropped events within 30 s via Cloud Tasks retry | Event loss |
| Multi-region consistency | `network_partition_us_eu` | Litmus pod-network-loss policy | Spanner writes serialize correctly; no split-brain on tenant data | Network partition |
| Model Armor | `prompt_injection_burst` — fire 1000 prompt-injection attempts in 60 s (D21 max policy) | Custom harness + Chronicle SecOps alert | All 1000 blocked, security_watch (W3) quarantines within 5 min | Adversarial input |
| AP2 mandate | `mandate_replay_attack` — replay an Intent Mandate after expiry | Custom signed-payload harness | payment_mandate agent rejects; compliance agent logs to BigQuery audit | Mandate replay |
| Cost SLO | `runaway_token_burn` — force one tenant to 10× normal token usage | Synthetic workload | cost_watch (W2) alerts at 50/75/90/95% per D23; auto-quarantine at 95% | Cost blowout |
| AlloyDB | `alloydb_replica_lag` — induce 5 s lag on read replica | Datastream pause | Capability layer reads route to primary; analytics queries degrade gracefully | DB replica lag |
| Vector Search | `vector_index_rebuild` — rebuild a Vector Search index mid-flight | Cloud Build matrix retrigger | sourcing agent fallback to keyword search; coverage_note flags degraded mode | Vector index unavailability |

**Total L5 scenarios**: 12 (covers each of D31's 4 SLO dimensions × multiple failure modes). All run nightly. A subset (the 4 SLO-direct ones) also runs **pre-release** on every Cloud Deploy canary stage per [`ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §7.

### 6.4 Pass criteria

A chaos scenario passes IFF (a) the SLO assertion holds AND (b) the corresponding watchdog agent (W1/W2/W3) detected the anomaly within the SLO window AND (c) the auto-runbook executed without operator intervention (D32). Any one failing → page on-call.

---

## 7. CI integration (per D37 + [`ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §7)

### 7.1 Per-PR (Cloud Build trigger on every push)

Sequence — each stage gates the next; total budget 12 minutes:

```
git push → Cloud Build webhook
  └─ Stage 1: lint + type-check (ESLint flat config + tsc --noEmit + ruff + mypy)     ~1m
  └─ Stage 2: Vitest @ss/capabilities + @ss/workflows + @ss/observability               ~2m
  └─ Stage 3: pytest packages/agents-adk/ — TestInputContract + TestPlumbing + TestEscalation per agent ~3m
  └─ Stage 4: L1 fast-eval (5 cases per touched agent, max 80 cases)                    ~3m
  └─ Stage 5: spec conformance — OpenAPI 3.1 + AsyncAPI 3.0 + JSON Schema validation    ~1m
  └─ Stage 6: chaos smoke — 2 scenarios (regional_outage + vertex_429), short-duration  ~2m
  └─ Stage 7: Binary Authorization attestation                                          ~30s
  └─ Stage 8: Artifact Registry push + SLSA attestation                                 ~30s
```

Fail-fast: Stages 1-3 are parallelizable in two concurrent Cloud Build steps (lint+vitest in one, pytest in the other). Stages 4-8 are sequential.

### 7.2 Nightly (Cloud Build cron, 02:00 UTC)

Per [`ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §7:

```
02:00 UTC trigger
  └─ Full L1 (267 cases × 16 agents)                          ~40m, ~$25 in Gemini
  └─ Full L4 Agent Simulation (1152+ scenarios)                ~90m, ~$100
  └─ Full L5 Chaos (12 scenarios in series, multi-region)      ~60m, ~$15
  └─ Mutation testing (Stryker, capped 20m/package × 5)        ~60m
  └─ Cost regression check (BigQuery cost ledger query)         ~5m
  └─ License + secret scan (gitleaks + secretlint)              ~10m
  └─ Aggregate report → BigQuery `ss-v2-prod.test_runs`         ~5m
  └─ Slack + PagerDuty if regression score < -0.005 or any L5 fail
```

Nightly total runtime: ~4.5 hours, total cost ~$140/night. D39 budget allows ~10 nightlies/month of headroom. The optimizer (M3) decides which subset to run on weekends if budget squeezes.

### 7.3 Pre-release (Cloud Deploy canary)

Per [`ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §7 Mermaid diagram:

```
Cloud Build green → Cloud Deploy canary 10% → 5-min SLO check → 100% prod
                                            ├─ L5 4 SLO-direct scenarios
                                            └─ L1 full evalset on canary endpoint
```

5-minute burn-rate check uses Cloud Monitoring SLO burn (https://cloud.google.com/monitoring/alerts/slo-burn-rate-alerts). Auto-rollback via Cloud Deploy if burn rate >2x baseline.

---

## 8. Coverage targets (consolidated)

Per-package, per-layer, in one table. All thresholds gate merge.

| Package | L2 Line | L2 Branch | L3 Line | L3 Branch | L1 cases (min) | Mutation (nightly) |
|---|---|---|---|---|---|---|
| `@ss/contracts` | 95% | 90% | — | — | — | 75% |
| `@ss/capabilities` | 90% | 85% | — | — | — | 70% |
| `@ss/db` | 80% | 70% | — | — | — | 55% |
| `@ss/observability` | 85% | 80% | — | — | — | 65% |
| `@ss/workflows` | 85% | 75% | — | — | — | 60% |
| `packages/agents-adk/sourcing` | — | — | 85% | 75% | 12 | 65% |
| `packages/agents-adk/vetting` | — | — | 85% | 75% | 15 | 65% |
| `packages/agents-adk/outreach_writer` | — | — | 85% | 75% | 20 | 65% |
| `packages/agents-adk/conversation` | — | — | 85% | 75% | 25 | 65% |
| `packages/agents-adk/conversation_responder` | — | — | 85% | 75% | 15 | 65% |
| `packages/agents-adk/logistics` | — | — | 85% | 75% | 30 | 65% |
| `packages/agents-adk/content_verify` | — | — | 85% | 75% | 20 | 65% |
| `packages/agents-adk/analyst` | — | — | 85% | 75% | 10 | 65% |
| `packages/agents-adk/research` | — | — | 85% | 75% | 15 | 65% |
| `packages/agents-adk/intake` | — | — | 85% | 75% | 12 | 65% |
| `packages/agents-adk/lead_outreach_writer` | — | — | 85% | 75% | 15 | 65% |
| `packages/agents-adk/payment_mandate` | — | — | 90% (safety-critical) | 85% | 10 | 75% |
| `packages/agents-adk/compliance` | — | — | 90% (safety-critical) | 85% | 25 | 75% |
| `packages/agents-adk/creative` | — | — | 80% | 70% | 8 | 60% |
| `packages/agents-adk/a11y` | — | — | 85% | 75% | 20 | 65% |
| `packages/agents-adk/customer_success` | — | — | 85% | 75% | 15 | 65% |
| `packages/agents-adk/coordinator` (M1) | — | — | 85% | 75% | — (L4-only) | 65% |
| `packages/agents-adk/critic` (M2) | — | — | 85% | 75% | — (L4-only) | 65% |
| `packages/agents-adk/optimizer` (M3) | — | — | 85% | 75% | — (L4-only) | 65% |
| `packages/agents-adk/anomaly_watch` (W1) | — | — | 85% | 75% | — (L5-only) | 70% (rule logic) |
| `packages/agents-adk/cost_watch` (W2) | — | — | 90% (financial) | 85% | — (L5-only) | 75% |
| `packages/agents-adk/security_watch` (W3) | — | — | 90% (safety-critical) | 85% | — (L5-only) | 75% |

`payment_mandate`, `compliance`, `cost_watch`, `security_watch` have **elevated thresholds** because a false negative in any of these directly maps to a regulatory or financial loss (D20 CMEK / D21 Model Armor / D27 AP2 Intent only / D28 per-view pricing). These four agents are also the only ones whose L1 false_clear_rate is gated to 0 (zero tolerance).

---

## 9. Per-layer trigger summary

| Layer | Trigger | Cadence | Cost / run | Budget impact (D39) |
|---|---|---|---|---|
| L2 Vitest | PR push | every push | ~$0 (Cloud Build minutes) | nil |
| L3 pytest | PR push | every push | ~$0 | nil |
| L1 fast-eval (5 cases × touched agent) | PR push | every push | ~$0.40 | ~$10/day at 25 PRs |
| L1 full evalset | nightly | 1×/day | ~$25 | ~$750/mo |
| L4 Simulation full | nightly | 1×/day | ~$100 | ~$3000/mo (the bulk) |
| L4 Simulation 100-scenario subset | optimizer prompt-diff PR | on-demand | ~$10 | irregular |
| L5 Chaos full (12 scenarios) | nightly | 1×/day | ~$15 | ~$450/mo |
| L5 Chaos SLO-direct subset | Cloud Deploy canary | per release | ~$5 | ~$50/mo at 10 releases |
| Mutation testing (Stryker) | nightly | 1×/day | ~$0 (CI minutes only) | ~$50/mo CPU cost |

D39's $1500 month-1 envelope absorbs all of the above with ~30% headroom. Demo/judging window (last 3 days before D6 deadline) suspends L4 nightly to free budget for human-driven recording.

---

## 10. Eval-driven development workflow (closing the D25 loop)

This is the diagram in [`ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §7 made operational. The optimizer (M3, D25) consumes test results and produces prompt diffs:

```
                ┌──────────────────────────────────────────────────────────┐
                │  Step 1. PR merges to main → Cloud Build green            │
                └──────────────────────────────────────────────────────────┘
                                            │
                                            ▼
                ┌──────────────────────────────────────────────────────────┐
                │  Step 2. Nightly L1 + L4 + L5 run                         │
                │  ├─ L1 results → BigQuery ss-v2-prod.agent_evals.l1_runs │
                │  ├─ L4 results → BigQuery .l4_runs (+ RLHF reward signal)│
                │  └─ L5 results → BigQuery .l5_runs                       │
                └──────────────────────────────────────────────────────────┘
                                            │
                                            ▼
                ┌──────────────────────────────────────────────────────────┐
                │  Step 3. M3 optimizer wakes (cron 04:00 UTC)              │
                │  Reads:                                                    │
                │   • Per-agent eval score deltas (vs last week)            │
                │   • L4 RLHF rewards aggregated per agent                  │
                │   • L5 SLO burn per failure mode                          │
                │   • Mutation kill-rate trends                             │
                │  Decides: for each agent, is a prompt rewrite warranted? │
                └──────────────────────────────────────────────────────────┘
                                            │
                          (yes)             ▼              (no)
                ┌──────────────────────────────────────────────────────────┐
                │  Step 4a. M3 calls agent_optimizer.tune                   │
                │  ├─ Vertex AI Agent Optimizer (prompt tuning)            │
                │  ├─ produces candidate prompt v(n+1)                     │
                │  └─ writes prompt_registry.update with v(n+1) as draft   │
                └──────────────────────────────────────────────────────────┘
                                            │
                                            ▼
                ┌──────────────────────────────────────────────────────────┐
                │  Step 5. M3 opens a GitHub PR via gh CLI                  │
                │   • Branch: opt/<agent>-prompt-vN                        │
                │   • Body: diff vs previous prompt + projected eval lift  │
                │   • Reviewers: critic (M2) + 1 human (operator)          │
                └──────────────────────────────────────────────────────────┘
                                            │
                                            ▼
                ┌──────────────────────────────────────────────────────────┐
                │  Step 6. PR triggers per-PR pipeline (§7.1)               │
                │   • L2 + L3 + L1 fast-eval all pass on the new prompt    │
                │   • + an additional L4 100-scenario subset (touching     │
                │     this agent in last 7 days) runs synchronously        │
                │   • + the M2 critic auto-comments verdict                │
                └──────────────────────────────────────────────────────────┘
                                            │
                          (green)           ▼             (red)
                ┌──────────────────────────────────────────────────────────┐
                │  Step 7a. Human approves merge → Cloud Deploy canary →   │
                │           L5 SLO burn check → 100% prod                   │
                └──────────────────────────────────────────────────────────┘
                                            │
                                            ▼
                ┌──────────────────────────────────────────────────────────┐
                │  Step 8. Next nightly: L1 + L4 + L5 re-run → loop back   │
                └──────────────────────────────────────────────────────────┘
```

The contract that holds this loop together is the **eval-score → prompt-diff → eval-rerun** cycle:
1. Every prompt change must produce a measurable L1 eval-score delta in the PR body (M3 computes this).
2. Negative deltas auto-block merge (critic M2 enforces).
3. Positive deltas with degraded L4 RLHF reward also block (sometimes a higher L1 score destabilizes downstream agents).
4. The human gate at Step 5 is non-negotiable per D27 + D24 (Phase 0→1 stays "hybrid in-process" with human approval).

### 10.1 Specifically when this loop fires

- **Per agent, at most 1×/week.** Too-frequent rewrites destabilize the L4 baseline.
- **Net eval-score delta must be >= +0.02** (avoid drift on noise).
- **No simultaneous prompt rewrites across more than 2 agents per night** (the L4 baseline cannot deconvolve multi-variable changes).

### 10.2 What this gives the submission

Per the Tech-30 weight in [`../track-rules/CHALLENGE-RULES.md`](../track-rules/CHALLENGE-RULES.md), this loop is the demonstrable "the agents improve themselves under measurement" story. The Devpost write-up (Task #?? per [`../decisions/ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §9) cites the BigQuery `agent_evals` table as evidence.

---

## 11. Open questions (informs Tasks #31, #33)

| ID | Question | Blocking | Owner |
|---|---|---|---|
| T1 | Vertex AI Agent Evaluation pricing at 267 eval cases × 16 agents nightly — does it stay under D39 $1500/mo cap? | nightly L1 launch | DevOps + cost_watch verification |
| T2 | Pub/Sub emulator does not honor Pub/Sub Schema Registry — what's the L2 strategy for AsyncAPI 3.0 contract drift? | spec conformance gate | backend-architect (Task #23 migration) |
| T3 | Stryker mutation testing on TS code with branded Zod types — known issue with type erasure; does Stryker 8.x handle it? | L2 mutation floor | quality-engineer |
| T4 | AlloyDB Omni Docker image is amd64-only — Apple-Silicon dev machines need Rosetta. Confirm Cloud Workstations is the primary dev env to side-step this. | local dev | DevOps |
| T5 | How does L4 Simulation produce deterministic Cloud Trace IDs for replay? | replay/reproducibility | Task #31 |
| T6 | Litmus GKE Autopilot compatibility — Autopilot restricts privileged containers; some chaos experiments need privileged. Document fallback to GKE Standard for chaos-only nodepool. | L5 implementation | Task #33 |
| T7 | When the M3 optimizer opens a PR (§10 Step 5), what authentication does it use? Workforce Identity Federation per D19? Service-account-impersonation? | optimizer loop production | security-engineer |

---

## 12. Change log

| Date | Section | Change | Author |
|---|---|---|---|
| 2026-05-19 | initial | MATRIX v1 — all 12 sections drafted from D37 + [`ARCHITECTURE.md`](../decisions/ARCHITECTURE.md) §3 + §7 | quality-engineer agent #4 of 13 |
