# ss-agents-adk — social-seeding-v2 ADK Python agents (Phase 2 scaffold)

**Status**: Phase 2 scaffold. One working agent (`intake`) + runtime + observability
+ test harness. Phases 3-6 port the remaining 15 Tier-1 agents and the 6
meta/watchdog agents.

**Decision citations** (`gcp-research/decisions/DECISIONS.md`):

- **D5**  — Gemini 2.5 family is the production baseline. `intake` runs on
  `gemini-2.5-flash` (short conversational turn per ARCHITECTURE.md §3 row 10).
- **D17** — Vertex AI Agent Runtime is the target deployment surface.
  `runtime.py` mirrors v2's `runAgent` contract so the calling Cloud Workflow
  doesn't care whether the agent executes locally, on Cloud Run, or on Agent
  Engine.
- **D23** — Tier-1 agent #10 in the fleet.
- **D34** — 4 locales (ko / en / ja / zh-CN). Eval set covers all four.
- **D35** — Hybrid codebase. `packages/agents/` (TypeScript) is **frozen as the
  Anthropic-on-Claude reference**; `packages/agents-adk/` (this package) is the
  0-to-1 rebuild on ADK + Vertex AI for the GCP submission lane.
- **D36** — SDD format. Input/output Pydantic models are 1:1 mirrors of the
  JSON Schemas under `gcp-research/specs/_common/shared.schema.json` and the
  per-agent spec at `gcp-research/specs/tier1/intake.spec.md`.
- **D37** — TDD pyramid layer 3 (pytest). Every agent ships with three test
  classes (`TestInputContract`, `TestPlumbing`, `TestEscalation`) per
  `gcp-research/tests/MATRIX.md §4.2`.

## Quick start

```bash
# 1. Create + populate the venv (uv is the workspace tool of record)
cd packages/agents-adk
uv venv --python 3.12
source .venv/bin/activate

# 2. Install in editable mode with dev extras
uv pip install -e ".[dev]"

# 3. Run the offline pytest suite (no Vertex AI required — Gemini is stubbed)
pytest -v

# 4. Run the intake agent against live Vertex AI
export GOOGLE_GENAI_USE_VERTEXAI=TRUE
export GOOGLE_CLOUD_PROJECT=<your-project>
export GOOGLE_CLOUD_LOCATION=us-central1
export SS_LIVE=1
pytest -v -m integration

# 5. (later) Evaluate against the golden set
adk eval src/ss_agents/agents/intake.py eval/intake.evalset.json
```

## Design — agent-as-function

```
┌────────────────────────────────────────────────────────────────────┐
│  Cloud Workflow (D18) calls Cloud Run /agents/{name}/invoke        │
│                                                                    │
│       ▼                                                            │
│  run_agent(AgentDef, Input, RunContext) -> AgentOutcome            │
│       │                                                            │
│       ├── 1. prompt_guard(input)  ─── D8 + D21 input sanitizer     │
│       ├── 2. assert_within_budget(budgetCapUsd) ─── D39 cost cap   │
│       ├── 3. before_model: cost_guard (project next call's cost)   │
│       ├── 4. LlmAgent.run_async() — Gemini 2.5 + responseSchema    │
│       ├── 5. after_model: cost_record + OTel span                  │
│       ├── 6. pydantic.validate(output)                             │
│       └── 7. emit Pub/Sub event (AsyncAPI 3.0, D36)                │
└────────────────────────────────────────────────────────────────────┘
```

Every agent in this package follows the same shape:

1. **`AgentDef`** — Pydantic config describing id, model, tools, USD cap,
   input/output schemas, and the system-prompt builder. This is the
   Python-Pydantic mirror of v2's
   [`AgentDef<I, O>`](../agents/src/runtime.ts) interface.
2. **`run_agent`** — the one place LLMs are invoked. Validates inputs,
   enforces USD cap, runs the ADK `LlmAgent` via `InMemoryRunner`, validates
   outputs, returns a discriminated `AgentOutcome` (`ok` | `escalate`).
3. **`AgentOutcome`** — `OutcomeOk | Escalation` per
   `gcp-research/specs/_common/shared.schema.json#/$defs/Outcome`.

Hard guarantees:

- **No free ReAct loops** — every agent has a curated tool list and a Pydantic
  output schema. If the LLM produces unparseable output it's an escalation,
  not a retry storm.
- **USD cap is absolute** — exceeding it raises `BudgetExceeded` *before* the
  next LLM call (`before_model_callback`), not after. The cost ledger lives
  in the ADK session state so subsequent turns see prior cost.
- **Escalation is typed** — `EscalateToHuman` exception carries the reason
  string surfaced to Mission Control, not an opaque 500.
- **Prompt-guard runs first** — user-supplied text is sanitized for
  obvious prompt-injection patterns (D8) before the system prompt is composed.
  Model Armor (D21) does the deep work at the Vertex layer; this is the
  Python-side belt-and-braces.

## Layout

```
packages/agents-adk/
├── pyproject.toml
├── README.md                       ← you are here
├── BUILD-NOTES.md                  ← deviations + ADK API caveats
├── src/ss_agents/
│   ├── config.py                   ← env config (pydantic-settings)
│   ├── runtime.py                  ← run_agent + AgentDef + AgentOutcome
│   ├── observability.py            ← OTel + Cloud Trace
│   ├── tools/
│   │   ├── shared.py               ← RapidAPI + Gmail stubs (Phase 3 fills in)
│   │   └── prompt_guard.py         ← D8 + D21 input sanitizer
│   ├── memory/
│   │   └── firestore.py            ← Agent Memory Bank wrapper (D33)
│   └── agents/
│       └── intake.py               ← THE working agent (per intake.spec.md)
├── tests/
│   ├── conftest.py                 ← Gemini stub + fixtures
│   ├── test_runtime.py             ← USD cap + escalation + prompt-guard
│   └── agents/
│       └── test_intake.py          ← 3-class contract (Input / Plumbing / Escalation)
└── eval/
    └── intake.evalset.json         ← 8-case golden set across 4 locales
```

## Why intake first?

Per `gcp-research/specs/tier1/intake.spec.md` and the spec index:

- **Smallest tool surface** (1 tool: `forms.upsert`, and even that is optional
  per-turn — most turns are pure text generation).
- **Smallest output contract** — a `oneOf` between `{status: "asking", question}`
  and `{status: "done", brief}`.
- **Highest-volume agent in real use** — every campaign starts here, so a
  green intake unlocks downstream integration testing.
- **Bounded cost** — $0.20 cap across the whole conversation, which keeps the
  live-Vertex tests cheap during agent iteration.

The scaffolding decisions made for `intake` (Pydantic schema mirroring,
`InMemoryRunner` wrapping, OTel span shape, cost-guard callback ordering) are
locked in here so the remaining 15 Tier-1 ports are template-driven.

## Agent observability → Cloud Trace (D31 SLO · D32 Monitoring + SIEM)

Every `run_agent` invocation is wrapped in an OpenTelemetry span. The wiring
lives in `observability.py` (`setup_observability` / `agent_span` /
`record_outcome`) and is called from `runtime.run_agent`.

Each invocation emits one parent span `agent:{id}` carrying:

| attribute | value |
|---|---|
| `agent.id` | the `AgentDef.id` |
| `agent.model` | declared short Gemini id (`AgentDef.model`) |
| `agent.tenant_id` / `agent.workspace_id` / `agent.trace_id` | from `RunContext` |
| `agent.usd_spent` | cost of this invocation |
| `agent.outcome` | `"ok"` on success, `"escalate"` on every escalation path |

Plus a child span `llm:{model}` per model call (the offline/stub path emits a
minimal one; the live ADK path additionally inherits ADK's own GA
auto-instrumentation — OpenInference `GoogleADKInstrumentor` / Phoenix `register`
— into the same provider context).

**Default = off.** `SS_OTEL_ENABLED=false` (the test/dev default) takes a no-op
path: `agent_span` yields `None`, `record_outcome(None, …)` is a no-op, zero
overhead, nothing exported. The offline span shape is asserted deterministically
in `tests/runtime/test_observability_spans.py` with an in-memory exporter — no
GCP creds.

### Capturing a LIVE trace (operator-gated)

The spans are real and Cloud-Trace-*exportable* today (`setup_observability`
wires `BatchSpanProcessor(CloudTraceSpanExporter(project_id=…))` from
`opentelemetry-exporter-gcp-trace`). Producing a trace that actually lands in
Cloud Trace is an operator step because it costs real GCP API calls + needs ADC:

```bash
# 1. Authenticate (Application Default Credentials).
gcloud auth application-default login

# 2. Turn export on + point at the project.
export SS_OTEL_ENABLED=true
export GOOGLE_CLOUD_PROJECT=<your-project>
export GOOGLE_CLOUD_LOCATION=us-central1   # optional; used as resource label

# 3. Run any live agent invocation (e.g. the model-garden smoke), then view it:
#    https://console.cloud.google.com/traces/list?project=<your-project>
```

If `opentelemetry-exporter-gcp-trace` is unavailable in a minimal image,
`setup_observability` falls back to `ConsoleSpanExporter` so traces still print
locally. The IAM scope required for Cloud Trace ingestion is
`roles/cloudtrace.agent`.

## What this package does NOT do (yet)

- **No Cloud Run wrapper** — Phase 3 adds `apps/agents-runner/` (FastAPI) that
  exposes `/agents/{name}/invoke`. Today, `run_agent` is callable directly from
  pytest and from a Python `__main__`.
- **No A2A surface** — Phase 5 turns each agent into a `RemoteA2AAgent` per D24.
- **No live Memory Bank** — the Firestore wrapper is real, but the agent
  doesn't recall yet. Phase 4 wires Memory Bank into the prompt construction.
- **No Model Armor integration** — gated by O7 (Agent Gateway Private Preview
  allowlist). Local `prompt_guard.py` is a pure-Python fallback until Gateway
  is reachable.

## Sources

- `gcp-research/decisions/DECISIONS.md` — D5, D17, D23, D34, D35, D36, D37
- `gcp-research/adk-deep/ADK-GUIDE.md` — ADK 2.0 Beta API surface
- `gcp-research/specs/_common/shared.schema.json` — shared `$defs`
- `gcp-research/specs/tier1/intake.spec.md` — the contract this scaffold
  implements
- `gcp-research/porting-v2/PORTING-V2.md` §5 — 130-line outreach_writer
  template that informs the cost-guard callback shape
- `packages/agents/src/intake.agent.ts` — v2 reference (TypeScript)
- `packages/agents/src/runtime.ts` — v2 `AgentDef` interface
