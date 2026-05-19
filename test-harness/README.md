# test-harness/ — D37 5-Layer Test Harness

> **Authority**: derives from
> [`gcp-research/decisions/DECISIONS.md`](../gcp-research/decisions/DECISIONS.md) **D37**
> (5-layer TDD), [`tests/MATRIX.md`](../gcp-research/tests/MATRIX.md),
> [`chaos/SCENARIOS.md`](../gcp-research/chaos/SCENARIOS.md),
> [`simulation/SCENARIOS.md`](../gcp-research/simulation/SCENARIOS.md) +
> [`scenarios.yaml`](../gcp-research/simulation/scenarios.yaml), and
> [`edge-cases/CATALOG.md`](../gcp-research/edge-cases/CATALOG.md).
> When code here disagrees with one of those, the decision wins; file an issue.
>
> **Status**: scaffold (Phase-7 deliverable, 2026-05-19). The harness is
> *runnable* — `pytest test-harness/` passes against stubs. Real cloud
> wiring (Vertex AI Agent Evaluation, Agent Simulation, Litmus on GKE) is
> swapped in by toggling `HARNESS_MODE=stub|live` per
> [§7](#7-running-locally-vs-live).

---

## 1. What this is

The 22-agent fleet (D23) ships against an Enterprise SLO (D31:
99.99%/p99 < 1s/RTO 60s/RPO 30s). Five test layers (D37) defend that SLO.
The single source of truth for what each layer must do is
[`tests/MATRIX.md`](../gcp-research/tests/MATRIX.md); this directory is
**the working implementation** of that matrix.

```
┌────────────────────────────────────────────────────────────────────┐
│ L5 Chaos engineering  — chaos/   — 25 scenarios, nightly + canary  │
├────────────────────────────────────────────────────────────────────┤
│ L4 Agent Simulation   — simulation/ — 1000+ nightly, 50 per PR     │
├────────────────────────────────────────────────────────────────────┤
│ L1 Agent Evaluation   — golden/  — 267 cases across 16 T1 agents   │
├────────────────────────────────────────────────────────────────────┤
│ L3 pytest (agents)    — property-based/ + per-agent specs          │
├────────────────────────────────────────────────────────────────────┤
│ L2 Vitest (caps)      — lives at packages/*/src/*.test.ts (354 ✓)  │
└────────────────────────────────────────────────────────────────────┘
```

Plus two cross-cutting harnesses:

- `edge-cases/` — 78 adversarial cases from `edge-cases/CATALOG.md`,
  machine-readable + verification driver.
- `ci/` — Cloud Build YAML for per-PR (12 min) + nightly (~4.5 h, ~$140) +
  canary (5-min SLO burn check).

L2 Vitest lives **inside the v2 monorepo** at `packages/*/src/*.test.ts`
(354 tests already green per [`CLAUDE.md`](../CLAUDE.md)). It is not
duplicated here; only the new GCP-adapter Vitest mocks land in the
emulator setup scripts that MATRIX §3.2 lists.

---

## 2. Directory map

```
test-harness/
├── README.md                          ← you are here
│
├── golden/                            ← L1 Vertex AI Agent Evaluation
│   ├── README.md                      (267-case structure, schema, run order)
│   ├── tier1/                         (16 evalset.json files, one per T1 agent)
│   ├── tier2/                         (3 evalset.json files — coordinator/critic/optimizer)
│   └── tier3/                         (3 evalset.json files — anomaly_watch/cost_watch/security_watch)
│
├── simulation/                        ← L4 Agent Simulation
│   ├── runner.py                      (drives 1000-scenario nightly + 50-case per-PR)
│   ├── reward_calculator.py           (4-layer composite, §3.7 of simulation/SCENARIOS.md)
│   ├── nightly.sh                     (Cloud Scheduler-compatible wrapper)
│   └── tests/test_runner.py
│
├── chaos/                             ← L5 Chaos
│   ├── orchestrator.py                (Litmus + native GCP fault injection driver)
│   ├── scenarios/                     (25 *.yaml, one per CHAOS-* ID)
│   ├── litmus-experiments/            (CR YAML for GKE Autopilot)
│   ├── workflows/                     (Cloud Workflows YAML that drives runs)
│   └── tests/test_orchestrator.py
│
├── edge-cases/                        ← cross-cutting adversarial verification
│   ├── catalog.json                   (78 cases, machine-readable from CATALOG.md)
│   ├── verify.py                      (per-case trigger → assertion driver)
│   └── tests/test_verify.py
│
├── property-based/                    ← L3 property-test scaffolding (pytest+hypothesis)
│   ├── conftest.py                    (Hypothesis profile config)
│   ├── strategies.py                  (Pydantic shape strategies)
│   └── tests/                         (sample per-agent property test)
│
├── ci/
│   ├── per-pr.yaml                    (Cloud Build — 12-min, 8 stages, MATRIX §7.1)
│   ├── nightly.yaml                   (Cloud Build — 4.5h nightly, MATRIX §7.2)
│   └── canary-slo-check.yaml          (Cloud Deploy verify step, MATRIX §7.3)
│
└── coverage/
    ├── coverage.toml                  (90/75 line/branch + mutation targets, MATRIX §8)
    └── stryker.config.json            (TS Zod mutation testing)
```

---

## 3. Quickstart (local stub mode)

```bash
# 1. Python deps
python3 -m venv .venv && source .venv/bin/activate
pip install pytest hypothesis pyyaml jsonschema \
    google-cloud-aiplatform google-cloud-bigquery google-cloud-pubsub

# 2. Stub mode (no GCP)
export HARNESS_MODE=stub
export GOOGLE_CLOUD_PROJECT=ss-v2-stub

# 3. Run every Python test in the harness
pytest test-harness/ -v

# 4. Edge-case verification (78 cases, stub assertions only)
python test-harness/edge-cases/verify.py --mode=stub

# 5. Single chaos scenario (dry-run, no real fault injection)
python test-harness/chaos/orchestrator.py \
    --scenario=test-harness/chaos/scenarios/spanner-failover.yaml \
    --dry-run

# 6. Single simulation scenario (offline, uses fixtures)
python test-harness/simulation/runner.py \
    --scenarios=../gcp-research/simulation/scenarios.yaml \
    --limit=3 --dry-run
```

The harness deliberately runs in stub mode in CI for the per-PR layer —
real Vertex AI Agent Evaluation only runs when `HARNESS_MODE=live` and
the trigger is the nightly Cloud Build (cost reasons; MATRIX §9).

---

## 4. Run order (golden < per-PR < nightly < game-day)

Per MATRIX §7 and chaos/SCENARIOS.md §5, four cadences:

| Cadence | What runs | Wall-clock | Cost (D39 envelope) |
|---|---|---|---|
| **Golden / per-developer** | L1 fast-eval (5 cases per touched agent) + L2 Vitest + L3 pytest + L4 50-case smoke + L5 fast-subset (2 of 10) | ≤ 5 min | $0 (stub) / ~$1 (live smoke) |
| **Per-PR** (Cloud Build) | full L1 fast-eval (80 cases) + full L2 + full L3 + L4 50-case smoke + L5 fast-subset (2 scenarios) + spec conformance + BinAuthz attest | ≤ 12 min | ~$3-5 / PR |
| **Nightly** (Cloud Scheduler) | full L1 (267 cases) + full L4 (1000+ scenarios) + full L5 (25 scenarios) + Stryker mutation + license scan + cost regression | ≤ 4.5 h | ~$140 / night |
| **Quarterly game-day** | 5 chaos scenarios, compound failures, human-in-loop war room (chaos/SCENARIOS.md §6) | 4 h | ~$200 / day (one-shot) |

Order rule: a layer never runs unless every prior layer in its cadence
has passed. The Cloud Build YAMLs in [`ci/`](./ci/) enforce this.

---

## 5. Where things live (vs the v2 monorepo)

This harness directory is **deliberately separate** from the
`packages/` and `apps/` trees so a destructive change here can't
cascade into the running v2 backend / Mission Control. Specifically:

- `packages/agents/src/*.test.ts` (existing 64 v2 agent tests) → keep where they are; L2 owns them.
- `packages/capabilities/src/*.test.ts` (existing 22 capability tests) → keep where they are.
- `packages/workflows/src/*.test.ts` (existing 13 workflow tests) → keep where they are.
- `packages/observability/src/observability.test.ts` (existing 4 tests) → keep where it is.
- New ADK Python agent tests under `packages/agents-adk/tests/` once
  D17 migration begins — those reuse `property-based/strategies.py`
  via a `conftest.py` import. They are the **production L3**; this
  directory's `property-based/` is the *scaffolding template*.

This split keeps `pnpm run verify-build` (the v2 green-gate) untouched
when iterating on the harness, per
[`CLAUDE.md`](../CLAUDE.md) "`pnpm run verify-build` must stay green".

---

## 6. Decision citations

Every file in this directory carries a header like:

```
# orchestrator.py — Chaos L5 driver
# Cites: D31 (SLO), D32 (auto-runbook), D37 (TDD layers)
# MATRIX: §6, §7
# Source spec: chaos/SCENARIOS.md §3 + §4
```

If the header is missing, the file is a draft. Reviewers should reject
any merge of a file without that header — it's how we keep the harness
traceable to a decision under the Tech-30 weight (CHALLENGE-RULES).

---

## 7. Running locally vs live

The harness has two modes, controlled by `HARNESS_MODE`:

- `HARNESS_MODE=stub` (default) — no GCP calls. Trace sinks write to
  in-memory dicts; cost ledger is mocked at 0; reward composer reads
  fixture YAML. All tests in `test-harness/**/tests/` pass in this mode.
- `HARNESS_MODE=live` — real Vertex AI Agent Evaluation, real Agent
  Simulation, real Litmus on the chaos project. Requires:
  - `gcloud auth application-default login` with Workforce Identity
    Federation per D19;
  - `GOOGLE_CLOUD_PROJECT=ss-v2-chaos` (the chaos project mirror,
    chaos/SCENARIOS.md §9 C1);
  - billing budget alerts enabled (W2 cost-watch, MATRIX §9).

Per-PR Cloud Build never uses `live`. Nightly Cloud Build always uses
`live`. Local developers default to `stub`.

---

## 8. What's deferred (and why)

| Item | Status | Trigger to un-defer |
|---|---|---|
| Full per-agent ADK pytest port (MATRIX §4) | Stubbed | D17 (Agent Runtime Python) cutover begins |
| Real BigQuery `chaos_results` schema migration | Stubbed | chaos/SCENARIOS.md C4 lands |
| Stryker mutation testing on branded Zod types | Pending | MATRIX T3 open-question resolved |
| `clouddeploy.yaml` verify container image | Stubbed | MATRIX C3 / `ci/canary-slo-check.yaml` activation |
| Litmus admission webhook | Pending | chaos/SCENARIOS.md C2 |
| Mission Control `/admin/sim-reward-vs-human` page (simulation §8.5) | Pending | post-Phase 7 |

---

## 9. Maintenance contract

1. **Every new T1 agent gets one new evalset under `golden/tier1/`**
   before its first agent-rebuild merge (MATRIX §2.2).
2. **Every new chaos scenario starts as a YAML in `chaos/scenarios/`**
   and is appended to `chaos/SCENARIOS.md` §3 with a fresh `CHAOS-*` ID
   in the same PR.
3. **Every new edge case appended to `edge-cases/CATALOG.md` must add
   one row to `edge-cases/catalog.json`** and one verification stub in
   `edge-cases/verify.py`.
4. **Cost regression**: nightly runs that exceed the $140/night budget
   trigger the `cost_watch` (W2) agent which opens a PR to the
   `nightly.yaml` adjusting concurrency. Operators approve.
5. **Pass/fail gates** are in `ci/` only — never inline in a test file.
   That's the surface a reviewer audits in one place.

---

## 10. References

- D37: 5-layer TDD — `gcp-research/decisions/DECISIONS.md` §2 R7
- D31: SLO — `gcp-research/decisions/DECISIONS.md` §2 R6
- D25: RLHF on Agent Simulation — `gcp-research/decisions/DECISIONS.md` §2 R4
- D32: Auto-runbook IR — `gcp-research/decisions/DECISIONS.md` §2 R6
- MATRIX: `gcp-research/tests/MATRIX.md`
- Chaos: `gcp-research/chaos/SCENARIOS.md`
- Simulation: `gcp-research/simulation/SCENARIOS.md` + `scenarios.yaml`
- Edge cases: `gcp-research/edge-cases/CATALOG.md`
- v2 monorepo conventions: `CLAUDE.md`
