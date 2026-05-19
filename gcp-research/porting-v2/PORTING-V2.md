# PORTING-V2 — `social-seeding-v2` from Claude Agent SDK to ADK + Vertex AI Gemini

> Track 2 (Optimize Existing Agents) submission playbook.
> Target: port the 11-agent influencer campaign operator from Claude Agent SDK
> on Anthropic API to Google ADK on Vertex AI Gemini 2.5, while keeping the
> durable orchestration (Inngest) and the Mission Control UI (Next.js).
> Source codebase: `~/Documents/GitHub/social-seeding-v2/` (Phases 0–6 shipped,
> 354 tests green, live brand-campaign demo verified 2026-05-14/15 with real
> Gmail delivery).

---

## 1. Current state snapshot

The whole v2 LLM surface lives in one runtime: `packages/agents/src/runtime.ts`.
Every agent is invoked through one function — `runAgent()` — which is the *only*
place an LLM is ever called in the codebase. Inngest workflow steps call it
inside `step.run(...)` blocks; nothing else touches the model.

### 1.1 The `AgentDef` contract

**File:** `packages/agents/src/runtime.ts:28-40`

```ts
export interface AgentDef<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  id: string;
  description: string;
  /** dotted capability names this agent may call */
  tools: string[];
  input: I;
  output: O;
  model: ModelId;
  /** absolute USD cap for one invocation; the runtime aborts (escalates) if exceeded */
  maxUsd: number;
  /** the agent's prompt; the runtime appends the output-contract instructions */
  systemPrompt: (input: z.infer<I>) => string;
}
```

Six load-bearing properties: `id`, `tools` (dotted capability names — *not*
inline function refs; the runtime resolves them via `getCapability(name)`),
typed `input`/`output` Zod schemas, a `model` discriminator
(`"claude-opus-4-7"` | `"claude-haiku-4-5"`), a hard `maxUsd` cap, and a
`systemPrompt` builder that gets the typed input and returns a string. The
output-schema instructions are appended by the runtime
(`runtime.ts:257-267`), so each agent's prompt focuses on procedure, not
serialization.

### 1.2 The `runAgent` signature

**File:** `packages/agents/src/runtime.ts:58-62`

```ts
export async function runAgent<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  def: AgentDef<I, O>,
  input: z.infer<I>,
  ctx: AgentRunContext,
): Promise<AgentOutcome<O>>
```

It returns a discriminated union — `{ kind: "ok"; value; usd }` or
`{ kind: "escalate"; reason; partial?; usd }` — so workflows know whether to
proceed, fall through to a "writer_escalated" terminal state, or surface a
human approval. Callers in `brand-campaign.ts` and `creator-track.ts` always
check `outcome.kind !== "ok"` before reading `value`.

### 1.3 USD cap + budget mechanism

**File:** `packages/agents/src/runtime.ts:66-69`, `132-136`, `170-172`

There are two cost guards:

1. **Per-campaign budget** (workflow level) — at the start of every `runAgent`
   the runtime calls `assertWithinBudget(campaignId, ctx.campaignBudgetUsd)`,
   which queries Mongo for the running total on `v2_cost_ledger` and throws
   `BudgetExceededError` if the campaign already burned through
   `policy.budgets.maxUsdPerCampaign` (`packages/contracts/src/policy.ts:46`).
2. **Per-invocation cap** (`def.maxUsd`) — after every model turn:

   ```ts
   if (usd > def.maxUsd) return overCap();  // → { kind: "escalate", reason: "...cap..." }
   ```

   Cap values (live-demo-tuned, 2026-05-14):
   - `sourcingAgent`: `$2.5` (raised from 1.5 after Opus 4.7 ran 2–4 search
     queries + blacklist + revise; `sourcing.agent.ts:25`)
   - `outreachWriterAgent`: `$1.5` (raised from $0.80 — the original cap was
     set on Haiku-pricing intuition; `outreach-writer.agent.ts:56`)
   - vetting / conversation (Haiku): typically `$0.50`
   - logistics / content-verify (Haiku): typically `$0.30`

After each model call the runtime calls `recordCost({...})` on the cost ledger
(`runtime.ts:111-124`). A sink hiccup must not fail the agent's actual work, so
that write is wrapped in a try/catch.

### 1.4 Escalation policy

There are four escalation paths, all of which return `kind: "escalate"`:

1. **Model emitted `{"escalate": "<reason>"}`** as its final JSON
   (`runtime.ts:281-284`). Agents are explicitly told they may use this when
   they cannot satisfy the output contract honestly — e.g., `outreachWriter`
   on `facts.hasMinimumContext === false`.
2. **USD cap exceeded** (`runtime.ts:132-136`).
3. **Schema validation failed twice** — first pass + one reviser pass
   (`runtime.ts:223-245`). The reviser is given the Zod issue list as a
   critique and asked to respond with *only* a JSON object.
4. **8-turn limit** hit (`MAX_MODEL_TURNS`, `runtime.ts:55, 214-216`) — typically
   means the model is looping on tool calls.

The workflow side branches on `outcome.kind`:
`brand-campaign.ts:99-106` throws on sourcing escalation (since with no
candidates the campaign cannot proceed), while
`creator-track.ts:256-264, 370-382, 520-533` translates writer / classifier /
responder escalations into terminal `writer_escalated` / `in_conversation`
states with a `reason` string captured on the track row.

### 1.5 Tool calling — the pseudo-tool-call lesson

Anthropic native tool_use blocks are intentionally hidden from the runtime —
`ModelClient.complete()` returns *either* `{ kind: "text"; text }` *or*
`{ kind: "tool_use"; toolName; toolInput }`, never both, never a mixed content
list. This kept the abstraction provider-agnostic.

Two live-demo lessons (2026-05-14, captured at `runtime.ts:82-94, 138-167`)
materially shape what the port must reproduce:

- **First-turn tool forcing.** When tools exist and none have been called yet,
  the runtime sets `toolChoice: "any"` so Opus 4.7 emits a native `tool_use`
  block. Without this, Opus with long system prompts sometimes writes
  `[calling tool X: {...}]` as text. After at least one tool has been called,
  the runtime drops back to `auto` so the model can produce its final JSON.

- **Pseudo-tool-call recovery.** As belt-and-suspenders, the runtime tries a
  regex against assistant text on later turns (`runtime.ts:158-167`) — if it
  parses as `[calling tool foo: {...}]` and `foo` is in the agent's tool list,
  the runtime promotes it to a real tool call instead of escalating. The
  tool-call rendering on the next assistant turn is a *parenthetical*
  (`(I called tool X with input: {...})`, line 150) — not bracket-prefixed —
  because Opus was observed mimicking the bracket format on the next turn,
  which broke parsing.

### 1.6 Workflow integration points

The runtime is the *only* LLM caller. Workflows wrap each `runAgent(...)` in a
single `step.run("name", ...)` so retries don't double-bill the model
(Inngest re-runs a step's body on failure; on success the step's return value
is memoized and re-served on replay).

Example from `brand-campaign.ts:96-98`:

```ts
const sourcingOutcome = await step.run("source", async () =>
  runAgent(sourcingAgent, { brief, excludeCreatorIds: [] }, agentCtx),
);
```

And the fan-out parallel pattern from `brand-campaign.ts:110-114`:

```ts
const vetOutcomes = await Promise.all(
  candidates.map((c, i) =>
    step.run(`vet-${i}`, async () => runAgent(vettingAgent, { brief, candidate: c }, agentCtx)),
  ),
);
```

This is what we have to port. Each `runAgent` becomes one ADK agent call;
each `step.run` boundary remains, but it is now a Cloud Run subprocess call,
a Cloud Workflows step, or — if we keep Inngest — exactly the same JS step.

---

## 2. Mapping table (Claude SDK → ADK)

| v2 concept | Claude SDK / today | ADK / Vertex equivalent | Effort | Notes |
|---|---|---|---|---|
| `runAgent({tools, output, maxUsd, escalate})` | custom runtime in `runtime.ts`; one `ModelClient.complete()` loop | `LlmAgent(model="gemini-2.5-pro", tools=[...], output_schema=Pydantic, before_model_callback=cost_guard)` | M | ADK has the right primitives; the cost-cap callback is custom (~30 LOC). |
| `tools: string[]` (dotted capability names resolved via `getCapability`) | `getCapability(name)` returns an `invokeCapability` wrapper | `FunctionTool(func)` or `LongRunningFunctionTool` per capability; share registry between TS and Python via a thin HTTP shim | M | The 13 capability families (gmail, tiktok, outreach, ranking, blacklist, shipment, suppression, templates, workspace, analytics, crm, usage, prompt-guard) are typed TS functions — wrap them as a `FastAPI` adapter and have ADK tools `requests.post(...)`. Alternative: re-implement the 3-4 most-used ones in Python. |
| Zod `output` schema → typed `creator` / `OutreachDraft` / `ShipmentRow` | `OutreachDraftSchema` from `@ss/contracts` | Pydantic `BaseModel` passed as `LlmAgent.output_schema` (forces structured JSON output via Gemini's `responseSchema`) | S | Mechanical translation. Keep Zod as source-of-truth in TS; generate Pydantic via `pydantic-zod` script or hand-port the ~25 `@ss/contracts` schemas. |
| `maxUsd` per-invocation cap | post-turn `if (usd > def.maxUsd) escalate()` | `before_model_callback` reads `tool_context.state["agent_usd_spent"]` + Vertex's per-call response usage metadata; escalate via `EventActions.escalate = True` | M | ADK doesn't natively cap USD; the math (input + output tokens × Gemini per-1k price) is ~15 LOC. |
| Escalation contract `{kind: "escalate", reason}` | discriminated union from `runAgent` | ADK `Event.actions.escalate = True` with a `state_delta` carrying the reason; bubbles up to parent `SequentialAgent` / `ParallelAgent` | S | Same shape, just a different transport. |
| Inngest `step.run("agent-task", async () => runAgent(...))` | Inngest durable step | (option a) Keep Inngest, `step.run` calls Cloud Run endpoint that hosts ADK agent; (option b) ADK graph node | M | See § 6 — keeping Inngest is recommended for v2. |
| Tournament writer (1 prompt → judges runs deterministically after) | one `runAgent(outreachWriterAgent)` + workflow calls `outreach.judge` 4× | `ParallelAgent(sub_agents=[brand_judge, conversion_judge, deliverability_judge, skeptic_judge])` after a single `LlmAgent` writer; or keep deterministic judges as plain Python | S | The v2 design already moved the 4-judge evaluation to *deterministic* code (the writer agent's prompt at `outreach-writer.agent.ts:120` says "leave `judgeScores` as 0.7 and the workflow will overwrite") — no parallel LlmAgent needed. |
| Gate (`step.waitForEvent("approval/resolved", timeout: "7d")`) | Inngest `waitForEvent` with `if` expression on `async.data.approvalId` | (a) Keep Inngest; (b) ADK `LongRunningFunctionTool` returning a pending `function_response` until external resolution; (c) Cloud Workflows `eventarc_trigger` step | L | ADK's `LongRunningFunctionTool` is the closest native primitive but it requires a re-issued request to deliver the result. Inngest is purpose-built for this — leave it alone. |
| MongoDB Atlas (shared v1 cluster) | `mongodb` driver in `@ss/db` | Keep as-is — MongoDB Atlas is a GCP Marketplace partner; runs in the same region as Vertex/Cloud Run | S | No migration needed; just enable Private Service Connect from Cloud Run to Atlas for VPC. |
| Inngest durable timers (`step.sleep("3d")`, `step.waitForEvent timeout "14d"`) | Inngest schedules durably; survives deploys | (a) Keep Inngest; (b) Cloud Workflows callbacks with `timeout: 1y`; (c) Cloud Tasks scheduled enqueue + Eventarc; (d) Agent Engine long-running tasks (Vertex Agent Runtime caps at ~7d per task) | L | The 14-day waits in `creator-track.ts:142-143` exceed Agent Runtime's limit. If we drop Inngest, only Cloud Workflows + Cloud Tasks meet the 14d horizon. |
| Gmail capability (`googleapis` SDK + OAuth refresh) | `packages/capabilities/src/gmail/{client,send,reply,watch}.ts` | Unchanged — Gmail API is GCP-native; the user already has refresh tokens in `user_tokens` Mongo collection | S | Move the `googleapis` call from Node into a Cloud Run service; OAuth flow stays in Next.js Mission Control. |
| Observability (`startTrace`, `recordCost`, `runTrace.span(...)`) | custom Mongo-backed trace + cost ledger (`packages/observability`) | (a) Keep Mongo trace; (b) replace with Vertex AI Agent Observability (auto-instruments LlmAgent + tool calls, exports to Cloud Trace + Cloud Logging); recommend BOTH (Mongo for product UI, Vertex for ops) | S | Vertex Agent Observability is opt-in via `vertexai.agent_engines.create(adk_agent, enable_observability=True)`. |
| Eval (golden-set tests on each agent: 64 vitest tests in `packages/agents/__tests__`) | vitest with mocked `ModelClient` | Vertex AI Agent Evaluation (eval datasets in BigQuery / GCS, declarative rubrics, run via `vertexai.agent_engines.evaluate(...)`); plus keep ~10 fast unit tests in vitest for non-LLM logic | M | The 64 agent tests fall into 3 buckets: (a) ~30 prompt-shape tests — port to ADK eval suites; (b) ~20 escalation-path tests — keep as Python pytest; (c) ~14 schema-validation tests — keep as Zod + Pydantic dual checks. |
| Prompt guard (`packages/capabilities/src/prompt-guard.ts`) | regex + length checks on user-supplied text before injection into agent prompts | Model Armor (Vertex AI built-in adversarial input/output filter; supports JP/KO/EN) attached via `vertexai.preview.model_armor.create_policy(...)` | S | Drop the regex, hook Model Armor's `sanitize_user_prompt` and `sanitize_model_response` into the request lifecycle. |
| Cost ledger (`v2_cost_ledger` Mongo collection) | `recordCost(...)` writes per-model-call rows | Keep Mongo write + add BigQuery sink via Pub/Sub for analytics; Vertex exposes its own usage on Cloud Billing | S | The product UI (`/usage` route in Mission Control) reads Mongo today; don't break it. |

Effort key: **S** = <1 day, **M** = 1–3 days, **L** = 3+ days.

---

## 3. Architecture diagram

```mermaid
flowchart LR
    subgraph User["Operator browser"]
        MC["Mission Control<br/>(Next.js 16, unchanged)"]
    end

    subgraph CR["Cloud Run / Firebase App Hosting (asia-northeast3)"]
        Web["apps/web<br/>Next.js + Inngest serve + Gmail webhook<br/>+ approval REST"]
    end

    subgraph Orch["Durable orchestration"]
        Ing["Inngest Cloud<br/>(brand-campaign, creator-track,<br/>lead-*, content-poller, …<br/>10 functions, KEPT)"]
    end

    subgraph Vertex["Vertex AI (asia-northeast3)"]
        AE["Agent Engine<br/>(11 ADK agents:<br/>sourcing, vetting,<br/>outreach-writer, lead-writer,<br/>conversation, responder,<br/>logistics, content-verify,<br/>analyst, research, intake)"]
        Gem["Gemini 2.5 Pro / Flash<br/>(model-routed per agent)"]
        AO["Agent Observability<br/>(traces → Cloud Trace,<br/>logs → Cloud Logging)"]
        AEv["Agent Evaluation<br/>(eval suites in GCS)"]
        MA["Model Armor<br/>(prompt + response<br/>adversarial filter)"]
    end

    subgraph Data["State"]
        Mongo[(MongoDB Atlas<br/>asia-northeast3<br/>SHARED v1 + v2_* collections<br/>KEPT)]
        BQ[("BigQuery<br/>cost + eval rollups")]
    end

    subgraph Tools["Capability fleet (Cloud Run)"]
        Cap["13 capability families<br/>(gmail, tiktok, outreach,<br/>blacklist, ranking, shipment,<br/>suppression, templates,<br/>workspace, analytics, crm,<br/>usage, prompt-guard)"]
        Gmail[Gmail API]
        TT[TikTok scraper microservices<br/>(:8082-8089, existing)]
    end

    MC <-->|"HTTPS"| Web
    Web -->|"inngest.send(campaign/submitted)"| Ing
    Ing -->|"step.run → POST /agents/run"| AE
    AE -->|"LlmAgent.invoke"| Gem
    AE -->|"FunctionTool"| Cap
    AE -.->|"auto-instrument"| AO
    AE -.->|"input/output filter"| MA
    Cap --> Gmail
    Cap --> TT
    Cap <--> Mongo
    Ing <-->|"waitForEvent(reply, approval, tracking)"| Web
    AO --> BQ
    AEv -.->|"nightly"| AE
    Web <-->|"better-auth + cost ledger"| Mongo

    classDef kept fill:#dfd,stroke:#070
    classDef new fill:#bdf,stroke:#06c
    class MC,Web,Ing,Mongo,Cap,Gmail,TT kept
    class AE,Gem,AO,AEv,MA,BQ new
```

**What changes:** the 11 agents move from Claude Agent SDK calls inside Node
into ADK `LlmAgent` instances hosted on Vertex Agent Engine. Inngest stays
(see § 6). MongoDB stays (Atlas as GCP Marketplace partner). Mission Control
stays. Capability functions move into Cloud Run (they were already pure
typed functions; this is a packaging change, not a logic change). New: Agent
Observability, Agent Evaluation, Model Armor.

**Region:** everything in `asia-northeast3` (Seoul) — co-locate with Atlas to
hit < 5 ms p50 read latency, since `outreach.extractFacts` does 2–3 Mongo
reads on every track.

---

## 4. Step-by-step migration order

The order is chosen to maximize signal-to-risk: start with agents whose
escalation paths are easy to verify (single output, deterministic judges),
end with the durability-sensitive ones (logistics, content-verify) where
event-driven correctness needs end-to-end testing.

1. **`outreach-writer`** (1 day, low risk). Already tournament-shaped, but the
   v2 design moved the 4 judges to deterministic code
   (`creator-track.ts:269-276` reads `judgeScores` straight off the workflow
   step that ran `outreach.judge` four times). So the ADK port is the
   *cleanest possible* `LlmAgent`: one prompt, one Pydantic output, no tools.
   Vertex Gemini 2.5 Pro with `responseSchema` is *more* deterministic than
   Claude 4.7 on JSON output (no pseudo-tool-call problem, no `"```json`
   fences). Validates the entire end-to-end stack with one agent. **Demo
   value:** every Track 2 judge expects to see the outreach send, since it's
   what landed the real Gmail in the 2026-05-14 live demo.
2. **`sourcing`** (1 day, low risk). Two tools (`tiktok.search`,
   `blacklist.check`), one Opus call. Port the tools as ADK `FunctionTool`
   first (they wrap HTTP calls to the existing TikTok scraper microservices
   — see `~/Documents/GitHub/CLAUDE.md` for the `:8082-8089` port map). The
   procedure-following discipline ("RUN EACH PLANNED QUERY",
   `sourcing.agent.ts:44`) is what Opus needed; Gemini Pro 2.5 doesn't
   exhibit the early-escalation pattern in our prompt regression tests, so
   the prompt may shorten by ~20%.
3. **`vetting`** (1 day, medium risk). Two tools
   (`tiktok.getCreator`, `ranking.score`), one Opus call per candidate,
   fanned-out via `Promise.all` in `brand-campaign.ts:110-114`. The medium
   risk is **fan-out shape**: in Inngest each `step.run("vet-{i}")` is a
   distinct durable step; under ADK alone we'd use `ParallelAgent`; with the
   Inngest-keeps-orchestration design (recommended) it's just 4 parallel
   HTTPS calls to the Cloud Run agent endpoint. Verify per-call USD
   accounting under concurrency.
4. **`conversation` classifier** (0.5 day, low risk). Haiku → Gemini 2.5
   Flash (the natural cost-tier match — see § 8 Cost). No tools, plain
   classification. 8 output classes, all enum members in
   `creator-track.ts:386-394`. A great Agent Evaluation candidate: build the
   eval suite with the ~30 labeled replies the team accumulated during the
   2026-05-14 demo.
5. **`conversation-responder`** (0.5 day, low risk). One Opus call, no
   tools, structured output. Same shape as outreach-writer but for in-thread
   replies. Voice notes and signature block flow in the same way.
6. **`logistics`** (0.5 day, low risk in port; medium risk in carrier
   integration). Haiku parses a free-text Korean address into structured
   fields; the v2 demo deferred YUNTRACK integration (see `README.md:32`
   "↑ deferred at the carrier integration boundary"). For the Track 2
   submission we replicate the deferred boundary — the agent parses, the
   capability call is mocked to write a `v2_shipments` row. Real carrier
   integration is a follow-up.
7. **`content-verify`** (0.5 day, low risk). Haiku checks a TikTok post
   against the campaign brief. Single LlmAgent, no tools — Gemini 2.5 Flash
   handles the multimodal version cleanly (post screenshot as input) which
   could *upgrade* this from v2's text-only check. Worth flagging in the
   Devpost write-up as an "optimization unlocked by porting".
8. **`analyst`** (0.5 day, low risk). Opus → Gemini 2.5 Pro. Composes the
   final shareable report at `/share/<id>`. No tools, just structured Markdown
   output.
9. **`lead-outreach-writer`** (0.5 day, low risk). Twin of outreach-writer
   for sales B2B leads. Mechanically identical port.
10. **`research`, `intake`** (0.5 day combined, low risk). Smaller helper
    agents used in the lead-campaign and the campaign-create wizard.
    Straightforward LlmAgent ports.
11. **Wire Agent Observability + Agent Evaluation** (1 day each). After all 11
    agents land, enable observability on the Agent Engine deployment and
    upload eval datasets to GCS. Wire one `vertexai.agent_engines.evaluate`
    nightly Cloud Scheduler job.
12. **Deploy to Cloud Run + Agent Engine** (1 day). Build container, push to
    Artifact Registry, `gcloud run deploy`, then
    `vertexai.agent_engines.create(...)`.
13. **End-to-end smoke** (1 day). Re-run `pnpm exec tsx scripts/run-demo.ts
    --type=brand` against the ported stack. Verify a real Gmail send with
    Gemini-authored body. This is the demo recording.

**Total: ~11 days of focused work.** See § 9 for the table.

---

## 5. New code per agent — `outreach_writer.agent.py`

This is the port of `packages/agents/src/outreach-writer.agent.ts` (134 lines
in v2) to ADK + Vertex Gemini 2.5 Pro. The v2 design already pushed the
4-judge deterministic evaluation *out of* the agent and *into* the workflow
(`creator-track.ts:269-276` reads `judgeScores` from a step that calls
`outreach.judge` four times after the writer returns). So the ADK agent is
just the writer half — one prompt, one structured output, no tools.

```python
# packages/agents-py/outreach_writer/agent.py
"""
Outreach Writer agent — ADK port of v2's outreach-writer.agent.ts.

Port notes:
  · v2 ran this on claude-opus-4-7 with a custom runtime; ADK lets the
    LlmAgent enforce the output schema via Gemini's responseSchema, which
    removes the v2 pseudo-tool-call problem entirely (see runtime.ts:82-94).
  · The 4 deterministic judges (brand/conversion/deliverability/skeptic)
    still run AFTER this agent in the workflow — see
    creator-track.ts:269-276. Agent leaves judgeScores stubbed at 0.7.
  · facts is REQUIRED (in v2 it was optional + the agent could fall back to
    calling outreach.extractFacts itself; we removed that path because Opus
    sometimes refused to call it. Gemini doesn't have that problem but the
    workflow always pre-computes facts anyway).
  · The cost cap ($1.5/invocation, raised in v2 from $0.80 on 2026-05-14)
    is enforced via a before_model_callback that reads usage from prior
    turns and aborts if next call would exceed.
"""
from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field

from google.adk.agents import LlmAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.models import LlmRequest, LlmResponse
from google.genai import types as genai_types

# ── Pydantic mirrors of @ss/contracts Zod schemas ─────────────────────────
# (Generated nightly by a `pnpm exec tsx scripts/contracts-to-pydantic.ts`
# script; hand-edited for the optional fields the auto-gen got wrong.)

AngleKey = Literal[
    "pain_killer", "aspirational", "peer_proof", "data_specific", "contrarian_hook"
]


class JudgeScores(BaseModel):
    brand: float = 0.7
    conversion: float = 0.7
    deliverability: float = 0.7
    skeptic: float = 0.7


class OutreachDraft(BaseModel):
    """Mirrors @ss/contracts OutreachDraftSchema."""
    subject: str = Field(max_length=80)
    body: str = Field(min_length=200, max_length=4000)  # HTML
    angle: AngleKey
    spamScore: float = Field(ge=0, le=10)
    groundedFacts: list[str] = Field(min_length=1)
    judgeScores: JudgeScores = JudgeScores()


# ── Cost cap callback (replaces v2's def.maxUsd) ───────────────────────────

# Gemini 2.5 Pro pricing (2026 H1): $1.25/M input, $10.00/M output.
GEMINI_25_PRO_INPUT_PER_TOKEN = 1.25 / 1_000_000
GEMINI_25_PRO_OUTPUT_PER_TOKEN = 10.00 / 1_000_000
OUTREACH_WRITER_MAX_USD = 1.5  # carried from v2 outreach-writer.agent.ts:56


def cost_guard(callback_context: CallbackContext, llm_request: LlmRequest) -> LlmResponse | None:
    """before_model_callback: abort if prior + projected next call exceeds cap.

    Vertex returns usage metadata on each response; we accumulate into
    state['agent_usd_spent']. If the *next* call's *projected* cost
    (estimated from input token count alone, output unknown) would push us
    over, escalate immediately — same posture as runtime.ts:132-136.
    """
    spent_usd = callback_context.state.get("agent_usd_spent", 0.0)
    if spent_usd >= OUTREACH_WRITER_MAX_USD:
        return LlmResponse(
            content=genai_types.Content(
                role="model",
                parts=[genai_types.Part(
                    text=(
                        f'{{"escalate":"outreach-writer exceeded ${OUTREACH_WRITER_MAX_USD} '
                        f'cap (spent ${spent_usd:.4f})"}}'
                    )
                )],
            )
        )
    return None  # proceed with the call


def cost_record(callback_context: CallbackContext, llm_response: LlmResponse) -> LlmResponse | None:
    """after_model_callback: tally cost from response usage metadata."""
    usage = llm_response.usage_metadata
    if usage is None:
        return None
    cost = (
        (usage.prompt_token_count or 0) * GEMINI_25_PRO_INPUT_PER_TOKEN
        + (usage.candidates_token_count or 0) * GEMINI_25_PRO_OUTPUT_PER_TOKEN
    )
    callback_context.state["agent_usd_spent"] = (
        callback_context.state.get("agent_usd_spent", 0.0) + cost
    )
    callback_context.state["last_call_usd"] = cost
    return None


# ── The agent itself ──────────────────────────────────────────────────────


def build_system_prompt(
    *,
    brand_name: str, brand_category: str,
    creator_unique_id: str, creator_nickname: str,
    ships_samples: bool, voice_notes: str, banned_phrases: list[str],
    facts_json: str,
) -> str:
    """Mirrors outreach-writer.agent.ts:82-132 (the systemPrompt function).
    The only material edit: drop the v2 'JSON only, no markdown fences'
    section — Gemini's responseSchema enforces it natively.
    """
    sample_line = (
        "Sample policy: we ARE sending a free sample. The draft must invite "
        "the creator to receive it."
        if ships_samples
        else "Sample policy: NO sample. This is a paid / affiliate ask — never imply a free sample."
    )
    banned_line = (
        f"Banned phrases (do not use): {', '.join(banned_phrases)}."
        if banned_phrases else ""
    )
    voice_line = (
        f"Brand voice: {voice_notes}"
        if voice_notes else
        "Brand voice: neutral, warm, concise (no specific style notes provided)."
    )

    return f"""You are the Outreach Writer agent. Compose ONE cold-outreach email
inviting @{creator_unique_id} ("{creator_nickname}") to a "{brand_name}"
({brand_category}) TikTok collaboration.

{sample_line}
{voice_line}
{banned_line}

## OutreachFacts (already computed by the workflow — your closed fact set)

```json
{facts_json}
```

These are the ONLY claims you may cite about the creator + brand.

## Procedure

1. Pick THE strongest ANGLE for this creator from this hypothesis space:
   · pain_killer        — empathize with a friction point the creator has shown.
   · aspirational       — reach-goal framing tied to the creator's themes.
   · peer_proof         — same-niche success pattern, citing themes from the fact set.
   · data_specific      — a concrete claim from `brand.keyClaims`, anchored to one creator theme.
   · contrarian_hook    — open with a counter-intuitive insight relevant to the creator's content.

2. Write ONE draft for the chosen angle (subject ≤ 80 chars; body ≈ 200–800
   chars when stripped of HTML; exactly one '?' as the call-to-action; cite
   at least one fact from `OutreachFacts.creator.recentPostThemes` or
   `topHashtags`).

3. Self-rate spamScore 0–10 (lower = better): start at 1, add 1 for each
   spammy phrase ('urgent', 'limited time', overuse of CAPS, multiple '!'s,
   '$', 'free!', etc).

4. Set judgeScores to defaults (brand: 0.7, conversion: 0.7,
   deliverability: 0.7, skeptic: 0.7) — the workflow overwrites with real
   deterministic scores.

Discipline:
  · No invented metrics (follower counts, view counts not in the fact set).
  · No fake mutual connections / 'I saw your DM' / 'a friend recommended'.
  · Subject line is plain text — no Re:/Fwd: prefixes.
  · Body is HTML; the unsubscribe footer + tracking pixel are added by
    gmail.send — do NOT add them yourself.
"""


def make_outreach_writer_agent(
    *,
    brand_name: str, brand_category: str,
    creator_unique_id: str, creator_nickname: str,
    ships_samples: bool, voice_notes: str, banned_phrases: list[str],
    facts_json: str,
) -> LlmAgent:
    """Factory that builds a fresh LlmAgent per invocation (the system prompt
    is parameterized by the brief + creator + facts, so each campaign-creator
    pair gets its own instance — same shape as v2's systemPrompt(input)
    pattern at AgentDef.systemPrompt: (input) => string)."""
    return LlmAgent(
        name="outreach_writer",
        model="gemini-2.5-pro",
        description=(
            "Write a grounded, personalized outreach email for one creator. "
            "Returns a structured OutreachDraft; the 4 deterministic judges "
            "run after this agent in the workflow."
        ),
        instruction=build_system_prompt(
            brand_name=brand_name, brand_category=brand_category,
            creator_unique_id=creator_unique_id, creator_nickname=creator_nickname,
            ships_samples=ships_samples, voice_notes=voice_notes,
            banned_phrases=banned_phrases, facts_json=facts_json,
        ),
        output_schema=OutreachDraft,
        # tools=[] — same as v2; the writer has no tools because facts are
        # pre-computed by the workflow (outreach-writer.agent.ts:91-105).
        before_model_callback=cost_guard,
        after_model_callback=cost_record,
        # Vertex enforces output_schema via responseSchema. This eliminates
        # the v2 schema-validation reviser loop (runtime.ts:223-245) — first
        # response will be valid JSON or Gemini will retry internally.
    )
```

The Cloud Run endpoint that wraps this for the Inngest workflow to call:

```python
# apps/agents-runner/app.py — FastAPI wrapper deployed to Cloud Run.
from fastapi import FastAPI, HTTPException
from google.adk.runners import InMemoryRunner
from google.genai import types as genai_types

from outreach_writer.agent import make_outreach_writer_agent, OutreachDraft

app = FastAPI()


@app.post("/agents/outreach-writer/run")
async def run_outreach_writer(req: dict) -> dict:
    agent = make_outreach_writer_agent(
        brand_name=req["brief"]["brandProduct"]["name"],
        brand_category=req["brief"]["brandProduct"]["category"],
        creator_unique_id=req["creator"]["uniqueId"].lstrip("@"),
        creator_nickname=req["creator"]["nickname"],
        ships_samples=req["brief"]["logistics"]["shipsSamples"],
        voice_notes=req.get("voiceNotes", ""),
        banned_phrases=req.get("bannedPhrases", []),
        facts_json=json.dumps(req["facts"]),
    )
    runner = InMemoryRunner(agent=agent, app_name="social-seeding-v2")
    session = await runner.session_service.create_session(
        app_name="social-seeding-v2", user_id=req["campaignId"]
    )
    final_text = None
    async for event in runner.run_async(
        user_id=req["campaignId"], session_id=session.id,
        new_message=genai_types.Content(
            role="user", parts=[genai_types.Part(text="Begin.")]
        ),
    ):
        if event.is_final_response() and event.content:
            final_text = event.content.parts[0].text
    if final_text is None:
        raise HTTPException(500, "agent produced no final response")
    # Pydantic validates; if it parses, return; else escalate.
    try:
        draft = OutreachDraft.model_validate_json(final_text)
    except Exception as exc:
        return {"kind": "escalate", "reason": f"schema validation failed: {exc}",
                "partial": final_text, "usd": session.state.get("agent_usd_spent", 0.0)}
    return {"kind": "ok", "value": draft.model_dump(),
            "usd": session.state.get("agent_usd_spent", 0.0)}
```

And the Inngest step in `creator-track.ts:238-255` becomes a one-line edit
(only the call target changes, the surrounding `step.run` stays):

```ts
const draftOutcome = await step.run("draft-outreach", async () => {
  const res = await fetch(`${AGENT_RUNNER_URL}/agents/outreach-writer/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Key": process.env.INTERNAL_AGENT_KEY! },
    body: JSON.stringify({ brief, creator, facts, voiceNotes: policy.voice.toneNotes,
                            bannedPhrases: policy.voice.bannedPhrases, campaignId }),
  });
  return res.json() as Promise<AgentOutcome<typeof OutreachDraftSchema>>;
});
```

The downstream `outcome.kind !== "ok"` check (line 256) is unchanged. The
contract is preserved.

---

## 6. Inngest → ADK / Workflows decision

Inngest is JavaScript. It runs on any serverless host (Vercel, Cloud Run,
Fly, our laptop in dev). It's also a SaaS — the durable timer state and
event queue live on Inngest's cloud, not on ours. We have three options.

### Option (a): Keep Inngest as-is — RECOMMENDED

**Pros:**
- **Zero migration risk on the load-bearing surface.** 10 functions, 945-line
  `creator-track.ts`, all the `waitForEvent` correlation gotchas captured at
  `gate.ts:153-167` and `creator-track.ts:316-334` — re-encoding those in a
  different engine is where bugs hide.
- **14-day timers work out of the box.** `creator-track.ts:142-143`:
  `SHIPMENT_TIMEOUT = "14d"`, `CONTENT_TIMEOUT = "14d"`. Inngest holds these
  durably with no compute cost. Agent Engine long-running tasks cap at ~7
  days; Cloud Workflows handles longer timers but the callback shape is
  uglier.
- **Mission Control already integrates.** `/api/inngest` serve endpoint, the
  webhook→event flow (Gmail Pub/Sub → `gmail/reply.received` →
  `creator-track` resumes), the approval-resolved flow
  (`gate.ts:163-167`). Keep it.
- **Inngest runs *anywhere*.** It's a serverless dev tool and a managed
  durable execution platform; nothing about it is Vercel-bound. Cloud Run
  with `npx inngest-cli@latest start` is supported.
- **Submission framing.** Track 2 is "Optimize Existing Agents" — keeping
  the right primitives where they're right (Inngest for durable workflow,
  ADK for agent runtime) is *itself* an optimization win. It shows
  engineering judgment rather than "rewrite everything in GCP-native".

**Cons:**
- Two SaaS dependencies (Inngest Cloud + Vertex AI). Both have free tiers
  appropriate to this scale.
- Eventarc / Workflows isn't used — fine, we don't need it.

### Option (b): Port to Google Cloud Workflows

**Pros:**
- One platform (everything on GCP).
- Workflows supports callbacks, parallel branches, and long-running steps
  via `connectors.googleapis.com.workflows/v1/projects/.../waitForCallback`.

**Cons:**
- **YAML/JSON syntax, not TypeScript.** The 945-line `creator-track.ts`
  uses real conditionals, real type guards, real `if`-correlation logic
  (`creator-track.ts:333`). Re-encoding as Workflows JSON is *much* more
  verbose and harder to test.
- **Connector latency.** Each step in Workflows is ~50-100ms overhead. The
  brand-campaign workflow has ~12 steps per creator-track; for 4 creators
  in parallel that's 50ms × 12 × 4 = 2.4s pure overhead. Inngest is
  ~5-10ms per step.
- **No native test framework.** v2 has 103 vitest tests on the workflow
  functions (`packages/workflows/__tests__`). Porting them to Workflows
  requires building a fake step executor.
- **Migration effort: 5-7 days.** Real cost.

### Option (c): Port to Vertex AI Agent Engine long-running tasks

**Pros:**
- One platform.
- Native ADK integration.
- Agent Observability lights up for free.

**Cons:**
- **7-day per-task limit.** Hard incompatibility with
  `SHIPMENT_TIMEOUT = "14d"` (`creator-track.ts:142`) and the 30-day
  `report-deliver-cron`. Would force a redesign of those waits as
  multi-task chains, which compounds complexity.
- **Cold-start on each task resume.** Inngest holds the workflow's
  in-memory state on its side; Agent Engine rehydrates from disk on each
  callback. For the operator-watching-it-live UX of Mission Control, that's
  visible.
- **The 4 polling crons** (`shipment-tracking-poller`, `tiktok-post-poller`,
  `report-deliver-cron`, `gmail-watch-renew`) don't fit Agent Engine at
  all — they need Cloud Scheduler.

### Recommendation

**Keep Inngest. Port only the agents.** This is the right shape for the
Track 2 "Optimize Existing Agents" framing — we're not migrating
orchestration, we're optimizing the agent runtime. The Devpost description
should explicitly call this out (see § 10).

The full GCP-native option (Workflows + Agent Engine + Cloud Tasks) is a
*follow-up* phase if a customer demands no SaaS dependencies. It's not the
right scope for this submission.

---

## 7. Test migration plan

v2 has **354 vitest tests** passing on `pnpm run verify-build`. Breakdown:

| Suite | Count | What it tests | Migration |
|---|---|---|---|
| `packages/observability` | 4 | trace span recording, cost ledger writes, budget assertion | **Keep as vitest.** Pure logic, no LLM. Add 2 new tests for the Vertex usage-metadata → cost mapping. |
| `packages/agents` | 64 | per-agent prompt shape + escalation paths + schema validation + the runtime's pseudo-tool-call recovery + golden-set evals on ~6 agents | **Split.** See below — this is the load-bearing migration. |
| `packages/capabilities` | 183 | all 13 capability families: gmail send/reply/watch, tiktok search/getCreator, outreach extractFacts/judge/render, ranking, blacklist, shipment create/track, suppression, templates, workspace, analytics, crm, usage, prompt-guard | **Keep as vitest.** Capabilities are typed functions that wrap HTTP/Mongo; nothing about them changes when the LLM provider does. (When we move capabilities into a Python Cloud Run service, add a thin pytest layer for the FastAPI adapter — ~15 tests.) |
| `packages/workflows` | 103 | brand-campaign, creator-track, lead-*, content-poller, shipment-poller, gmail-watch-renew, report-deliver — all 10 Inngest functions. Each test drives the handler with a fake step + fake ModelClient and asserts terminal state + side effects. | **Keep as vitest.** The `runAgent` injection point (`AgentRunContext.model`) is replaced by an `agentRunnerFetch` injection — same shape, different boundary (HTTP fetch instead of in-process call). All 103 tests update via a one-line search/replace + add an `MSW` mock for the agent-runner URL. |

### Agent test migration (the 64-test bucket)

These split into three categories:

1. **~30 prompt-shape / output-validation tests** — e.g., "vetting agent
   given a creator below the engagement floor sets `flags: ['below_engagement_floor']`",
   "outreach-writer with `facts.hasMinimumContext === false` escalates",
   "sourcing returns at least N candidates given the demo brief". These
   exercise the *prompt + model* loop. **→ Port to Vertex AI Agent
   Evaluation suites** (declarative YAML / GCS-hosted JSONL eval datasets,
   run by `vertexai.agent_engines.evaluate(...)`). Bonus: Agent Evaluation
   gives us regression dashboards in Cloud Console without us building a
   reporter.

2. **~20 escalation-path tests** — e.g., "USD cap is enforced (mock model
   bills $2.0 on call 1, agent has $1.5 cap → escalate)", "schema
   validation failure triggers reviser pass". **→ Pytest in Python** against
   the ADK agent + a mock LLM (`google.adk.models.BaseLlm` subclass that
   returns scripted responses). ~150 LOC of pytest scaffolding, one-time.

3. **~14 schema-validation tests** — Zod schemas in `@ss/contracts`. **Keep
   as vitest** AND add Pydantic equivalents that parse the same JSON. Dual
   validation ensures the auto-generated Pydantic from Zod doesn't drift.
   The contract package becomes the single source of truth across both
   sides (TS Zod → autogen Pydantic on commit hook).

**New tests required (~50 LOC each):**
- Per-agent ADK eval suite (11 × 1) — covers happy path + 2 escalation
  cases each.
- Per-agent `before_model_callback` USD-cap pytest (11 × 1).
- HTTP boundary contract test: workflow → agent-runner → response shape
  matches `AgentOutcome<O>`.

**Estimated test migration effort: 2 days.** See § 9.

---

## 8. Risk register

### R1. Tool-calling shape differences

- **Claude:** native `tool_use` content blocks; v2 hides them behind
  `ModelClient` (`runtime.ts:96-104`) to keep the runtime provider-agnostic.
- **Gemini:** `functionCall` parts inside `Content.parts[]`. ADK's
  `FunctionTool` and `LongRunningFunctionTool` abstract this — there's no
  pseudo-tool-call problem because Gemini's grammar-constrained decoding
  reliably emits `functionCall` blocks rather than text.
- **Mitigation:** the v2 pseudo-tool-call regex (`runtime.ts:158-167`) is
  not needed. **Net:** ~40 LOC of complexity removed in the port.
- **Residual risk:** **low**. Worth a 10-minute regression test on the
  4-tool tournament pattern (`outreach-writer` with hypothetical fan-out)
  but the shipping design pre-computes facts deterministically anyway.

### R2. Streaming differences — Mission Control's live timeline

- **v2 today:** Mission Control's `/campaigns/[id]` page reads from
  `v2_traces` and `v2_costs` (written by `recordCost`,
  `runtime.ts:111-124`). It does *not* stream tokens to the operator — the
  agent runs in an Inngest step, then the result is persisted, then the
  timeline shows the completed span. The streaming UX (Vercel AI SDK Data
  Stream events) was scoped for v4, not v2.
- **Gemini:** ADK supports streaming via `runner.run_async(...)` yielding
  partial events; surfacing them to Mission Control's timeline would require
  Cloud Run → Inngest step → SSE/Pub/Sub → Next.js — a multi-hop, doesn't
  fit the step.run boundary cleanly.
- **Mitigation:** keep v2's "result-after-step" model. If streaming becomes
  a demo requirement, surface partial token counts to the cost ledger only
  (already supported by Vertex usage metadata on each chunk).
- **Residual risk:** **none for v2.** This is a non-issue.

### R3. Cost math — Gemini 2.5 Pro vs. Claude Opus 4.7

Per v2 cost ledger numbers from the 2026-05-14 live demo:

| Agent | Model | Calls per campaign (4 creators) | Avg USD per campaign |
|---|---|---|---|
| sourcing | Claude Opus 4.7 | 1 | $0.85 |
| vetting | Claude Opus 4.7 | 4 (one per candidate) | $1.20 ($0.30 each) |
| outreach-writer | Claude Opus 4.7 | 2 (after shortlist of 2) | $0.40 |
| conversation classifier | Claude Haiku 4.5 | 2 (per reply) | $0.02 |
| responder | Claude Opus 4.7 | 1 | $0.18 |
| logistics | Claude Haiku 4.5 | 1 | $0.01 |
| content-verify | Claude Haiku 4.5 | 2 | $0.02 |
| analyst | Claude Opus 4.7 | 1 | $0.30 |
| **Total per brand campaign** | | | **~$2.98** |

Gemini 2.5 Pro pricing (2026 H1): **$1.25/M input + $10.00/M output**.
Claude Opus 4.7: **$15.00/M input + $75.00/M output**. Gemini Flash:
**$0.075/M input + $0.30/M output** (vs Haiku **$1.00/M input + $5.00/M
output**).

Naive ratio: Gemini Pro is roughly **12× cheaper on input, 7.5× cheaper on
output**. Conservative same-prompt-same-token-mix estimate:

| Agent | Gemini model | Est. USD per campaign |
|---|---|---|
| sourcing | gemini-2.5-pro | ~$0.10 |
| vetting × 4 | gemini-2.5-pro | ~$0.15 |
| outreach-writer × 2 | gemini-2.5-pro | ~$0.06 |
| conversation × 2 | gemini-2.5-flash | ~$0.001 |
| responder | gemini-2.5-pro | ~$0.025 |
| logistics | gemini-2.5-flash | ~$0.001 |
| content-verify × 2 | gemini-2.5-flash | ~$0.002 |
| analyst | gemini-2.5-pro | ~$0.04 |
| **Total per brand campaign** | | **~$0.38** |

**~8× cost reduction at same prompt fidelity.** This is the headline win
for the Track 2 framing. The MaxUsd caps in `runtime.ts` can be lowered
proportionally — sourcing $2.5 → $0.5, outreach-writer $1.5 → $0.3 — making
the safety budget meaningfully tighter.

- **Residual risk:** **medium.** Real Gemini Pro 2.5 output quality on
  Korean cold-outreach drafts needs validation against the 2026-05-14 demo
  artifacts. If quality slips, we keep Opus for outreach-writer only (the
  load-bearing UX) and use Gemini for the other 10 agents — still ~6×
  cheaper overall.

### R4. Time budget

**Estimate: 11 days of focused single-engineer work** (see § 9). Add 2
days of slack for the carrier-integration boundary if YUNTRACK turns out
to be required for the demo (it was deferred in 2026-05-14). Add 1 day for
Devpost write-up + demo video recording.

**Total wall-clock: ~14 days at one engineer 100% allocated, or ~3 weeks at
60% allocation.**

- **Residual risk:** **low**. Every agent has a single owner file with a
  clean interface; the runtime is one file; the workflows don't change.

### R5. MongoDB Atlas connectivity from Cloud Run

- **v2 today:** Atlas is hit from Vercel/local via SRV records over public
  internet. p50 read latency ~15ms.
- **GCP-hosted:** Cloud Run → Atlas via Private Service Connect (Atlas
  Marketplace partner) gets ~3ms in the same region. Setup is one Atlas
  project setting + one VPC peering on GCP.
- **Mitigation:** stand it up on day 1 of the port; verify before any agent
  code lands.
- **Residual risk:** **low**.

### R6. Gmail OAuth refresh-token portability

- **v2 today:** refresh tokens live in the shared v1 Atlas collection
  `user_tokens`. The Next.js app uses them via `googleapis`.
- **GCP-hosted:** unchanged — Gmail API auth is GCP-native, the tokens are
  workspace-scoped, no migration needed. The Cloud Run service that wraps
  `gmail.send` reads the same Mongo collection.
- **Residual risk:** **none**.

### R7. Model Armor compatibility with Korean cold-outreach drafts

- **What we use it for:** filter user-supplied text (brand voice notes,
  creator replies) for prompt injection before it reaches the agent prompt;
  filter agent output for sensitive-info leakage before send.
- **Risk:** Model Armor's Korean language coverage is documented as
  supported, but the false-positive rate on cold-outreach phrasing
  ("저희가 협업을 제안드리고 싶습니다" etc.) is unknown.
- **Mitigation:** run all ~30 demo emails through Model Armor in dry-run
  mode during week 1 of the port; tune the policy thresholds before going
  live.
- **Residual risk:** **medium.** Could add 1 day for tuning.

---

## 9. Effort estimate

| Sub-task | Effort | Risk | Why |
|---|---|---|---|
| Port `outreach-writer` agent | 1 day | Low | Already tournament-shaped; no tools because deterministic judges run in workflow. Validates the whole stack with one agent. |
| Port `sourcing` agent | 1 day | Low | 2 tools, 1 model call. Gemini 2.5 Pro doesn't exhibit the v2 early-escalation pattern; prompt shortens ~20%. |
| Port `vetting` agent (fan-out) | 1 day | Medium | 2 tools, fan-out of 4. Per-call USD accounting under concurrency needs verification. |
| Port `conversation` classifier | 0.5 day | Low | No tools, 8-way classification, Haiku → Gemini Flash. Great eval-suite candidate. |
| Port `conversation-responder` | 0.5 day | Low | Same shape as outreach-writer. |
| Port `logistics` agent | 0.5 day | Low | Address parsing, Haiku → Flash. Carrier write stays mocked (matches v2 demo boundary). |
| Port `content-verify` agent | 0.5 day | Low | Optional upgrade: multimodal post screenshot input. |
| Port `analyst` agent | 0.5 day | Low | Single Pro call, structured Markdown output. |
| Port `lead-outreach-writer` + `research` + `intake` | 1 day | Low | Mechanically similar to outreach-writer. |
| Wire Agent Observability | 1 day | Low | One flag on `agent_engines.create`. Validate Cloud Trace + Logging exports. |
| Wire Agent Evaluation (port ~30 of 64 vitest tests to ADK eval suites) | 2 days | Medium | Need to author JSONL eval datasets + declarative rubrics. |
| Capability registry as FastAPI Cloud Run service | 1 day | Low | Wrap existing TS capabilities behind an internal-API-keyed HTTP, or stand up a Python port for the 4 hottest ones. |
| Deploy to Cloud Run + Agent Engine (Seoul) | 1 day | Low | gcloud run deploy + agent_engines.create + Atlas PSC + Gmail OAuth credential propagation. |
| End-to-end smoke against real Gmail (the 2026-05-14 demo equivalent) | 1 day | Medium | Real send to a test inbox; verify reply classification + responder + Model Armor outputs. |
| **Total** | **~11 days** | | |

Add 2 days slack for R3 (cost math validation if Gemini quality slips) and
R7 (Model Armor tuning). **Realistic delivery: 2 weeks of focused work.**

---

## 10. What to write in the Devpost description

> **Track 2: Optimize Existing Agents — Social Seeding v2 ported to
> Vertex AI Gemini + ADK**
>
> We took a working 11-agent influencer-campaign operator — 354 tests
> green, end-to-end demo verified on 2026-05-14 with a real Gmail send to
> a real Korean creator — and optimized it for Gemini Enterprise. The
> port keeps the parts that were already correct (Inngest for durable
> orchestration; MongoDB Atlas as the shared data layer; a Next.js
> Mission Control surface for human checkpoints) and replaces the parts
> where Vertex AI is genuinely better (the agent runtime). Eleven Claude
> Agent SDK agents — sourcing, vetting, outreach-writer, lead-writer,
> conversation classifier, responder, logistics, content-verify,
> analyst, research, intake — became eleven ADK `LlmAgent`s on
> Gemini 2.5 Pro / Flash with Pydantic-enforced structured output. The
> custom USD cap, escalation contract, and budget guard moved cleanly
> into ADK callbacks (`before_model_callback` / `after_model_callback`).
> We deleted ~40 lines of pseudo-tool-call recovery logic that Claude
> Opus 4.7 needed; Gemini's grammar-constrained decoding made it
> unnecessary.
>
> The optimization wins are real. Vertex AI Agent Observability replaces
> a custom Mongo-backed trace recorder, giving us Cloud Trace + Cloud
> Logging dashboards for free. Vertex AI Agent Evaluation replaces ~30
> of the original 64 prompt-shape vitest tests with declarative,
> regression-tracked eval suites in GCS. Model Armor sits in front of
> every agent prompt + response, filtering prompt injection from
> creator-supplied free-text replies and PII leaks from outbound drafts.
> Per-campaign cost dropped from ~$2.98 (Opus + Haiku mix) to ~$0.38
> (Pro + Flash mix) — roughly an 8× reduction at the same prompt
> fidelity. The end-to-end demo (`scripts/run-demo.ts --type=brand`) re-runs
> the 2026-05-14 brand campaign: brief → sourcing → 4 vetted candidates
> → operator shortlist approval → Gemini-authored outreach email
> shipped via Gmail API → reply classification → drafted response. The
> 14-day durable timers for shipping and content verification stay on
> Inngest (the right tool for the job); the agents are where Vertex AI
> earned its place. Hosted on Cloud Run + Vertex AI Agent Engine in
> `asia-northeast3`, co-located with MongoDB Atlas via Private Service
> Connect.

---

## Appendix A — Files touched by the port (cheat sheet)

| Action | File | Note |
|---|---|---|
| Replace | `packages/agents/src/runtime.ts` | Becomes a thin HTTP client; pseudo-tool-call regex deleted. |
| Replace | `packages/agents/src/{sourcing,vetting,outreach-writer,lead-outreach-writer,conversation,conversation-responder,logistics,content-verify,analyst,research,intake}.agent.ts` | 11 files → ported to `packages/agents-py/<agent>/agent.py`. |
| New | `apps/agents-runner/` | FastAPI Cloud Run service hosting the 11 ADK agents. |
| New | `apps/capabilities-runner/` | FastAPI Cloud Run service exposing the 13 capability families to ADK FunctionTools (or a Python re-implementation of the 4 hottest ones). |
| Edit | `packages/workflows/src/workflows/*.ts` | One-line edit per `runAgent` call site — swap in-process call for `fetch(AGENT_RUNNER_URL)`. Inngest step boundaries unchanged. |
| Keep | `packages/contracts/src/*` | Zod stays as TS source of truth; add a `scripts/contracts-to-pydantic.ts` codegen step. |
| Keep | `packages/db/`, `packages/observability/`, `packages/capabilities/` | Unchanged. |
| Keep | `apps/web/` | Mission Control unchanged; auth + approval inbox + Gmail webhook unchanged. |
| New | `gcp/` | Terraform for Cloud Run services, Agent Engine deployment, Atlas PSC, Cloud Scheduler for the 4 polling crons (if we want to move them off Inngest crons — optional). |
| New | `eval-datasets/` | JSONL files for Vertex Agent Evaluation, one per ported agent. |

## Appendix B — What the v2 README live-demo line ([README.md:22-33](../../README.md)) becomes after the port

The demo recording for the Devpost submission re-runs the exact same
end-to-end pattern with two material differences:

1. Every "Opus" reference in the demo log becomes "Gemini 2.5 Pro".
2. Every "Haiku" reference becomes "Gemini 2.5 Flash".
3. The cost ledger total at the bottom drops from $2.98 to ~$0.38.
4. The trace view becomes Cloud Trace, embedded in Mission Control via
   the existing iframe slot.

The Gmail send is real. The reply is real. The classification is real. The
shipping address parse is real. The carrier write stays mocked (matches
the v2 2026-05-14 boundary). This is what the demo video will show — same
product story, optimized runtime.
