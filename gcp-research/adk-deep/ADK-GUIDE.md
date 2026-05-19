# Agent Development Kit (ADK) — Deep Reference Guide

**Coverage:** Python 2.0 Beta · TypeScript 1.0 GA · Go alpha · Java 1.3 (beta-track)
**Compiled:** 2026-05-19
**Audience:** social-seeding-v2 engineering — porting v1 cold-mail / sourcing / vetting agents off the bespoke Claude Agent SDK runtime onto a portable, evaluable, GCP-deployable agent runtime.

---

## 0. TL;DR — Why this matters for social-seeding-v2

The v2 architecture already commits to **"agents = functions the workflow invokes (curated tools, Zod output, USD cap, escalation), never free loops"** (`CLAUDE.md`). That is exactly the ADK contract: an `Agent` is a typed unit with a tool list, an output schema, and lifecycle callbacks — orchestrated by `SequentialAgent` / `ParallelAgent` / `LoopAgent` (1.x), or the new graph runtime + Task API (2.0 Beta).

The fit is close enough that, for the GCP-hosted demo lanes, ADK is a serious candidate to replace the in-house `packages/agents` glue **for the GCP variant only** — Anthropic-on-Claude stays unchanged on the existing stack. The rest of this doc is the reference you need to make that decision and execute the port.

---

## 1. Installation per language

### 1.1 Python

ADK is published on PyPI as `google-adk`. Two release lines coexist today:

| Line | Channel | Install | Notes |
|---|---|---|---|
| **1.x stable** | PyPI default | `pip install google-adk` | The 1.x line is what Cloud Run / Agent Engine quickstarts and most third-party tutorials still target. Latest in this line targets the `SequentialAgent` / `ParallelAgent` / `LoopAgent` / `LlmAgent` API. |
| **2.0 Beta** | PyPI pre-release | `pip install google-adk --pre` (or pin `google-adk==2.0.0a1` per the PyPI release) | New `Workflow(BaseNode)` graph runtime + Task API. **Breaking** vs 1.x — do not use in production. |

Python requirement: **3.10 or later**.

Compatibility with Gemini / Vertex AI is via the `google-genai` SDK, which ADK depends on transitively. To target Vertex AI rather than the public Gemini API, set:

```bash
GOOGLE_GENAI_USE_VERTEXAI=TRUE
GOOGLE_CLOUD_PROJECT=<your-project>
GOOGLE_CLOUD_LOCATION=us-central1
# Or, for the public API:
GOOGLE_API_KEY=<your-key>
```

Recommended pin pattern for production (1.x):

```
google-adk>=1.3,<2          # stay on the 1.x API surface
google-cloud-aiplatform>=1.95   # for Agent Engine deploy + Vertex sessions
```

Install directly from `main` (only when you need an unreleased fix):

```bash
pip install "git+https://github.com/google/adk-python.git@main"
```

### 1.2 TypeScript

Package: **`@google/adk`** on npm. ADK for TypeScript is **1.0 GA** (announced via the Google Developers Blog and shipped on npm; latest 1.1.x at time of writing).

```bash
npm install @google/adk
npm install -D @google/adk-devtools   # dev UI + eval CLI
```

Node 20+ recommended. The TS API mirrors the Python 1.x API: `LlmAgent`, `SequentialAgent`, `ParallelAgent`, `LoopAgent`, `AgentTool`, callbacks, MCP toolset. The 2.0 graph runtime is **not yet** in the TS package.

Official repo: `github.com/google/adk-js`.

### 1.3 Go

Module path: **`google.golang.org/adk`** (official). Status: **alpha** — APIs may shift, no SemVer compat guarantee yet.

```bash
go get google.golang.org/adk
```

Go requirement: **1.25.0+**.

```go
import (
    "google.golang.org/adk/agent"
    "google.golang.org/adk/tools"
)
```

The Go SDK is the only one with a meaningful pre-A2A community fork (`github.com/go-a2a/adk-go`) — for new work prefer the official `google.golang.org/adk` path. The Go SDK targets cloud-native deployments where you want native concurrency rather than the Python event loop.

### 1.4 Java

Maven coordinates:

```xml
<dependency>
  <groupId>com.google.adk</groupId>
  <artifactId>google-adk</artifactId>
  <version>1.3.0</version>
</dependency>

<!-- Optional: dev UI / eval tooling -->
<dependency>
  <groupId>com.google.adk</groupId>
  <artifactId>google-adk-dev</artifactId>
  <version>1.3.0</version>
</dependency>
```

Java 17+. ADK for Java reached **1.0** in late 2025 and is on the 1.x line (treated as beta-track here because most enterprise users are still validating it). Gradle (Kotlin DSL):

```kotlin
implementation("com.google.adk:google-adk:1.3.0")
```

### 1.5 CLI

Across all four languages, the `adk` CLI ships separately and provides identical sub-commands: `adk create`, `adk run`, `adk web`, `adk eval`, `adk deploy cloud_run`, `adk deploy agent_engine`. Python users get it from `pip install google-adk`; the other languages typically install the Python CLI alongside the native SDK because the CLI itself is Python-implemented.

---

## 2. Core concepts

### 2.1 Agent class hierarchy

```
BaseAgent  (abstract — name, description, sub_agents, _run_async_impl)
├── LlmAgent (alias: Agent)        # the workhorse: model + instruction + tools
├── WorkflowAgent (abstract)
│   ├── SequentialAgent            # run sub_agents in order
│   ├── ParallelAgent              # fan-out / gather
│   └── LoopAgent                  # repeat sub_agents until break
└── CustomAgent                    # you override _run_async_impl yourself
```

`LlmAgent` is the only class that actually calls a model. The three `WorkflowAgent` subtypes are **pure deterministic orchestrators** — they do not call an LLM themselves, they only route control across their `sub_agents`. `CustomAgent` is the escape hatch for orchestration logic that none of the workflow primitives express (e.g., a `while` loop whose break condition depends on session state in a way `LoopAgent` cannot inspect).

A `CoordinatorAgent` is not a separate class — it is a **pattern**: an `LlmAgent` with `sub_agents=[…specialists…]` and an instruction that tells the LLM to route. ADK's "AutoFlow" auto-emits a `transfer_to_agent(agent_name=…)` tool the LLM can call to hand off control. So "coordinator agent" = "LlmAgent with sub_agents".

Minimal `LlmAgent`:

```python
from google.adk.agents.llm_agent import Agent

def get_current_time(city: str) -> dict:
    """Returns the current time in a specified city."""
    return {"status": "success", "city": city, "time": "10:30 AM"}

root_agent = Agent(
    model="gemini-flash-latest",
    name="root_agent",
    description="Tells the current time in a specified city.",
    instruction="You are a helpful assistant that tells the current time in cities.",
    tools=[get_current_time],
)
```

Notice: `tools` is a list of **plain Python functions**. ADK introspects the signature + docstring to build the JSON schema sent to Gemini. There is no `@tool` decorator required (one exists for advanced cases — see §2.2).

### 2.2 Tool decorators / registration

Three ways to give an agent a tool, in increasing order of control:

1. **Plain function.** Type hints + docstring → schema. Easiest; what you want 80% of the time.
   ```python
   def rank_creators(creators: list[dict], brand_context: str) -> list[dict]:
       """Rank creators against a brand brief. Returns list sorted by fit score."""
       ...
   ```
2. **`FunctionTool` wrapper.** When you need to override the name/description independently of the function name, or attach an explicit JSON schema.
   ```python
   from google.adk.tools import FunctionTool
   rank_tool = FunctionTool(func=rank_creators, name="rank_creators_v2",
                            description="Rank creators with v2 scoring rubric.")
   ```
3. **`BaseTool` subclass.** Full control: custom `_run_async`, custom auth, custom error handling. Used internally by `OpenAPIToolset`, `MCPToolset`, `BigQueryToolset`, `AgentTool`.

Tools can be wrapped/composed. `AgentTool(other_agent)` wraps an entire agent as a tool — this is how you compose hierarchies without using `sub_agents` (the difference: `sub_agents` allows control transfer; `AgentTool` is a call-and-return).

### 2.3 Memory & Sessions API

ADK separates **Session** (one conversation thread) from **Memory** (long-term cross-session recall).

**Session services** — implement `BaseSessionService`:

| Class | Persistence | When to use |
|---|---|---|
| `InMemorySessionService` | None (lost on restart) | Local dev, tests |
| `DatabaseSessionService` | SQLAlchemy-compatible DB | Self-hosted, you bring the DB |
| `VertexAiSessionService` | Agent Engine managed | You deploy to Agent Engine |

A session has: `id`, `app_name`, `user_id`, an ordered list of `events` (the conversation), and a mutable `state: dict[str, Any]` bag that workflow agents read/write via `output_key`.

**Memory services** — implement `BaseMemoryService`:

| Class | Backend | Notes |
|---|---|---|
| `InMemoryMemoryService` | Process RAM | Keyword search, dev only |
| `VertexAiMemoryBankService` | Vertex AI Memory Bank (preview) | LLM-curated long-term facts, cross-session |

Wiring it up:

```python
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.memory import VertexAiMemoryBankService

runner = Runner(
    app_name="seeding_v2",
    agent=root_agent,
    session_service=InMemorySessionService(),
    memory_service=VertexAiMemoryBankService(
        project="my-gcp-project",
        location="us-central1",
        agent_engine_id="projects/.../reasoningEngines/...",
    ),
)
```

For social-seeding-v2: the v1 Atlas-backed conversation history would map to a custom `BaseSessionService` subclass (similar to the documented Firestore custom session-service pattern). Memory Bank is a credible replacement for the bespoke "creator notes" RAG used in v1 vetting — but it is still Preview, so only viable on a 90-day demo horizon.

### 2.4 Callbacks (the lifecycle hooks)

Six hook points per `LlmAgent`, all optional. Each is a function passed at construction time:

| Hook | Fires | Return `None` means | Return non-`None` means |
|---|---|---|---|
| `before_agent_callback` | Before the agent's main run loop | Proceed normally | Short-circuit: returned `Content` becomes the final response, agent body is skipped |
| `after_agent_callback` | After the agent finishes | Use the agent's natural output | Override the final output |
| `before_model_callback` | Just before each LLM request | Proceed | Skip the LLM call, use returned `LlmResponse` |
| `after_model_callback` | Just after each LLM response | Use response as-is | Override / mutate the response |
| `before_tool_callback` | Just before each tool call | Proceed | Skip the tool, use returned dict as the tool result |
| `after_tool_callback` | Just after each tool returns | Use result as-is | Override / mutate the tool result |

Canonical pattern — **prompt-guard / policy gate** before any external send (matches the v2 `external_send` rule):

```python
from google.genai.types import Content, Part

def block_pii_in_outbound(callback_context, tool, args, **_) -> dict | None:
    if tool.name in {"gmail_send", "tiktok_dm"}:
        text = args.get("body", "")
        if contains_unredacted_pii(text):
            return {"status": "blocked",
                    "reason": "PII guard tripped; route to human queue."}
    return None  # allow

agent = LlmAgent(
    model="gemini-2.5-pro",
    name="outreach",
    tools=[gmail_send, tiktok_dm, escalate_to_human],
    before_tool_callback=block_pii_in_outbound,
)
```

Callbacks are also where you implement: cost ledger (`after_model_callback` reading `response.usage_metadata`), trace export (any hook), retry / fallback model (`after_model_callback` re-issuing with a different model on failure).

---

## 3. Graph-based workflows (Python 2.0 Beta)

The 2.0 Beta introduces a separate **Workflow Runtime** with a graph-based execution engine. It is in addition to — not a replacement for — the 1.x workflow agents. The graph runtime gives you:

- Deterministic routing (the next node is computed, not LLM-decided).
- Fan-out / fan-in (parallelism with structured gather).
- Retry, state management, dynamic nodes (the graph itself can mutate mid-run).
- Resume / partial resume for nested workflows.
- Human-in-the-loop nodes that pause the graph until an external event resolves them.

The base class is `Workflow(BaseNode)`. Each node is either:

- A built-in (`SequentialAgent`-style sub-workflow, `ParallelAgent`-style fan-out, retry wrapper, HITL gate),
- An `LlmAgent` (the LLM call is a single node),
- Or a custom `BaseNode` you implement.

### End-to-end sample: 3-step graph

The 2.0 Beta docs lean on a builder-style API. Below is the canonical shape (consult the live 2.0 docs for any signature drift — the API is still moving):

```python
# requires: pip install google-adk --pre
from google.adk.v2.workflow import Workflow, Node, Edge, ParallelGroup
from google.adk.v2.agents import LlmAgent

researcher = LlmAgent(
    model="gemini-2.5-pro",
    name="researcher",
    instruction="Given a brand brief, surface 3 search angles as JSON list.",
    output_key="angles",
)

# Each angle is searched in parallel
searcher_template = LlmAgent(
    model="gemini-2.5-flash",
    name="searcher",
    instruction="For the given angle {angle}, return top 10 TikTok creators.",
    tools=[tiktok_search],
    output_key="creators_for_angle",
)

aggregator = LlmAgent(
    model="gemini-2.5-pro",
    name="aggregator",
    instruction="Merge per-angle creator lists; dedupe by handle; rank by fit.",
    output_key="ranked_creators",
)

graph = Workflow(
    name="sourcing_graph",
    nodes=[
        Node("research", researcher),
        ParallelGroup(
            "search_fanout",
            template=Node("search", searcher_template),
            fan_out_on="angles",        # iterate over the researcher's output_key
            bind_param="angle",         # each parallel instance gets {angle}
        ),
        Node("aggregate", aggregator),
    ],
    edges=[
        Edge("research", "search_fanout"),
        Edge("search_fanout", "aggregate"),
    ],
)
```

Routing is deterministic — `research → search_fanout (parallel) → aggregate`. The LLM does not choose the next node. Inside a node, an LLM agent still gets to reason; outside the node, control is in your graph.

For conditional branching, you add a predicate to the `Edge`:

```python
Edge("vet", "outreach", when=lambda state: state["vet_score"] >= 0.7),
Edge("vet", "human_review", when=lambda state: state["vet_score"] <  0.7),
```

The graph runtime visualises in the dev UI (`adk web`) as a proper DAG with active-node highlighting, which is genuinely more debuggable than the 1.x `SequentialAgent` chain that just looks like a flat list.

**When to choose 2.0 Beta over 1.x:** when your control flow has fan-out/gather, conditional branching, or HITL gates. **When to stay on 1.x:** anything production-bound today; backward compat is not guaranteed.

---

## 4. Collaborative (multi-agent) workflows — 1.x stable

The classic ADK multi-agent pattern. A single `LlmAgent` is the coordinator; its `sub_agents` are specialists; delegation is LLM-driven via the auto-emitted `transfer_to_agent` tool.

### Coordinator + sub-agents pattern

```python
from google.adk.agents import LlmAgent

billing_agent = LlmAgent(
    name="Billing",
    model="gemini-flash-latest",
    description="Handles billing inquiries: invoices, refunds, payment methods.",
    instruction="You are the billing specialist. Resolve payment-related issues.",
)

support_agent = LlmAgent(
    name="Support",
    model="gemini-flash-latest",
    description="Handles technical support: connectivity, errors, configuration.",
    instruction="You are the technical support specialist.",
)

coordinator = LlmAgent(
    name="HelpDeskCoordinator",
    model="gemini-flash-latest",
    instruction=(
        "Route user requests: use the Billing agent for payment issues, "
        "the Support agent for technical problems. If the request fits neither, "
        "answer directly."
    ),
    description="Main help desk router.",
    sub_agents=[billing_agent, support_agent],
)
```

The **descriptions** on the sub-agents are not human documentation — they are part of the prompt context the coordinator's LLM sees when choosing whom to delegate to. Write them as routing hints, not as marketing copy.

### Delegation rules

| Mechanism | How it triggers | Control transfer? |
|---|---|---|
| `sub_agents` + `transfer_to_agent` | Coordinator's LLM emits a tool call | **Yes** — the sub-agent runs as the new "current agent", with its own conversation; control returns to the coordinator only if the sub-agent escalates back |
| `AgentTool(specialist)` in `tools` | Coordinator calls it like any other tool | **No** — specialist runs, returns a value, coordinator continues |

Rule of thumb: `sub_agents` for routing (user-visible handoff), `AgentTool` for sub-procedures (synchronous helpers).

### End-to-end sample: planner + worker + critic

```python
from google.adk.agents import LlmAgent
from google.adk.tools.agent_tool import AgentTool

planner = LlmAgent(
    name="planner",
    model="gemini-2.5-pro",
    description="Breaks a fuzzy user goal into a JSON list of concrete steps.",
    instruction=(
        "Given a user goal, output a JSON array of steps. Each step is "
        "{action, expected_artifact}. Be conservative; prefer 3-5 steps."
    ),
    output_key="plan",
)

worker = LlmAgent(
    name="worker",
    model="gemini-2.5-flash",
    description="Executes a single concrete step using available tools.",
    instruction=(
        "You are given one step from a plan: {step}. Execute it using your tools. "
        "Return the produced artifact."
    ),
    tools=[tiktok_search, tiktok_get_user_info],
    output_key="artifact",
)

critic = LlmAgent(
    name="critic",
    model="gemini-2.5-pro",
    description="Critiques the worker's artifact against the original goal.",
    instruction=(
        "Original goal: {user_goal}. Artifact produced: {artifact}. "
        "Score 1-10 and list concrete improvements. If score >= 8, output APPROVE."
    ),
    output_key="critique",
)

coordinator = LlmAgent(
    name="planner_worker_critic",
    model="gemini-2.5-pro",
    instruction=(
        "1. Call the planner tool to get a plan. "
        "2. For each step, call the worker tool. "
        "3. Call the critic tool. If critic says APPROVE, return the artifact. "
        "Else feed the critique back to the worker and re-run."
    ),
    tools=[AgentTool(planner), AgentTool(worker), AgentTool(critic)],
)
```

This uses `AgentTool` rather than `sub_agents` because each specialist returns a value to the coordinator rather than taking over the conversation.

---

## 5. Dynamic workflows (code-based logic)

When the routing logic is too complex or too state-dependent for `SequentialAgent`/`LoopAgent`, drop down to `CustomAgent`. You override `_run_async_impl` and write Python.

### End-to-end sample: `while`-loop with break condition

```python
from google.adk.agents import BaseAgent
from google.adk.agents.invocation_context import InvocationContext
from google.adk.events import Event
from typing import AsyncGenerator
from typing_extensions import override

class VetUntilSatisfied(BaseAgent):
    """Run the vetter repeatedly until score >= threshold or max attempts reached."""

    def __init__(self, name: str, vetter, threshold: float = 0.75, max_attempts: int = 5):
        super().__init__(name=name, sub_agents=[vetter])
        self._vetter = vetter
        self._threshold = threshold
        self._max_attempts = max_attempts

    @override
    async def _run_async_impl(
        self, ctx: InvocationContext
    ) -> AsyncGenerator[Event, None]:
        attempt = 0
        while attempt < self._max_attempts:
            attempt += 1
            ctx.session.state["vet_attempt"] = attempt

            async for event in self._vetter.run_async(ctx):
                yield event

            score = ctx.session.state.get("vet_score", 0.0)
            if score >= self._threshold:
                ctx.session.state["vet_outcome"] = "passed"
                return

            # otherwise loop, vetter sees its previous critique in state and retries
        ctx.session.state["vet_outcome"] = "exhausted"
```

Three invariants to remember:

1. `_run_async_impl` is an **async generator** — it must `yield Event` objects, not return them.
2. State writes (`ctx.session.state[...] = ...`) are how you communicate with sibling nodes and with the orchestrator.
3. Loop termination is **your responsibility**. There is no framework-level infinite-loop guard for `CustomAgent`. Always bound by `max_attempts`.

This pattern subsumes what `LoopAgent` gives you (which is also bounded by `max_iterations` and an explicit `exit_loop` tool call from a sub-agent). Pick `LoopAgent` when the exit condition is "a sub-agent decides to stop"; pick `CustomAgent` when the exit condition is "the orchestrator inspects state and decides to stop".

---

## 6. Agent Skills (Py / Go / TS)

Skills are **progressive-disclosure context packs** — a way to give an agent thousands of tokens of specialised instructions without bloating its system prompt. The agent loads a skill only when it decides the skill is relevant.

### Three layers

| Layer | Size | Loaded when |
|---|---|---|
| **L1 — Metadata** | ~100 tokens per skill | At agent startup. Agent always sees the list. |
| **L2 — Instructions** | Up to ~5,000 tokens | When the agent calls `load_skill(name)`. |
| **L3 — Resources** | Arbitrary | When the agent calls `load_skill_resource(name, path)`. |

The agent never sees L2 or L3 unless it asks for them, so a project can ship 30 skills totaling 100k tokens without spending those tokens until needed.

### Skill manifest (`SKILL.md`)

```markdown
---
name: outreach-email-style
description: |
  Authoritative style guide for outbound TikTok creator emails.
  Use when drafting any first-touch email to a creator. Covers tone,
  subject-line patterns, signature block, and forbidden phrases.
version: 1.4.0
license: internal
allowed-tools:
  - gmail_send
---

# Outreach Email Style Guide

## Tone
Plain, specific, no superlatives. ...

## Subject lines
- {creator_handle}, quick question
- {brand} × {creator_handle} — interested?

## Forbidden phrases
- "circle back"
- "synergy"
- "I hope this finds you well"

## Resources
See `resources/templates/` for the four approved opening paragraphs.
```

The YAML frontmatter is the L1 metadata. The Markdown body is L2. Anything under `resources/` is L3.

Constraints (from the official skills guide):

- `name`: kebab-case, ≤ 64 chars.
- `description`: ≤ 1024 chars.
- L2 body: target ≤ 5,000 tokens.

### Loading skills

```python
import pathlib
from google.adk.agents import Agent
from google.adk.skills import load_skill_from_dir, SkillToolset

email_style = load_skill_from_dir(
    pathlib.Path(__file__).parent / "skills" / "outreach-email-style"
)
reply_classifier = load_skill_from_dir(
    pathlib.Path(__file__).parent / "skills" / "reply-classifier"
)

skill_toolset = SkillToolset(skills=[email_style, reply_classifier])

agent = Agent(
    model="gemini-2.5-pro",
    name="outreach_agent",
    tools=[skill_toolset, gmail_send, tiktok_dm],
)
```

`SkillToolset` automatically registers three tools the agent can call:

- `list_skills()` — L1 metadata for every loaded skill (~100 tokens × N).
- `load_skill(name)` — pulls in the L2 body for one skill.
- `load_skill_resource(name, path)` — pulls in an L3 file.

For social-seeding-v2 this maps almost 1:1 onto the v1 "prompt fragment" library — every fragment becomes a Skill, the agent decides which fragments to load per task, and the dashboard's per-turn cost ledger gets visibly cheaper.

Skills are supported in **Python, TypeScript, Go, and Java**, with the L1/L2/L3 contract identical across languages. Utility scripts under `resources/` can be `.py`, `.js`, or `.ts` regardless of the host language.

---

## 7. Tool ecosystem

### 7.1 MCP integration

`MCPToolset` (Python class `McpToolset`) is the bridge to any MCP server. ADK introspects the server's tool list at startup and exposes each MCP tool as an ADK tool.

Two connection modes:

```python
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import (
    StdioConnectionParams, SseConnectionParams,
)
from mcp import StdioServerParameters

# Local subprocess
local_mcp = McpToolset(
    connection_params=StdioConnectionParams(
        server_params=StdioServerParameters(
            command="uvx",
            args=["mcp-server-filesystem", "/tmp/workspace"],
        )
    )
)

# Remote SSE endpoint (e.g., a Cloud Run-hosted MCP server)
remote_mcp = McpToolset(
    connection_params=SseConnectionParams(
        url="https://mcp.internal.example.com/sse",
        headers={"Authorization": "Bearer ..."},
    )
)

agent = LlmAgent(
    model="gemini-2.5-pro",
    name="filesys_agent",
    tools=[local_mcp, remote_mcp],
)
```

Common pattern: `StdioConnectionParams` for local dev, `SseConnectionParams` for the same server hosted on Cloud Run in production.

### 7.2 Function calling

Already covered in §2.2 — plain Python functions are tools. ADK builds the schema from type hints + docstring, and Gemini's native function-calling mode handles the call.

### 7.3 GCP-native tools

ADK ships first-party toolsets for the GCP estate:

| Toolset | What it gives the agent |
|---|---|
| `BigQueryToolset` | Schema discovery (`list_datasets`, `list_tables`, `get_table_info`), SQL execution (`execute_sql`), plus row-level helpers. Auth via ADC or a passed `Credentials`. |
| `VertexAiSearchToolset` | Grounded retrieval against a Vertex AI Search data store. |
| `CloudStorageToolset` | Read/write GCS objects (newer in 2.0 Beta). |
| `google_search` | The first-party Gemini search tool (one-shot grounding, not Search API). |
| `built_in_code_execution` | Gemini's sandboxed Python execution. |

```python
from google.adk.agents import LlmAgent
from google.adk.tools.bigquery import BigQueryToolset

bq = BigQueryToolset(project="my-project", credentials=None)  # uses ADC

analyst = LlmAgent(
    model="gemini-2.5-pro",
    name="bq_analyst",
    instruction="Answer questions by querying BigQuery. Always show the SQL.",
    tools=[bq],
)
```

For social-seeding-v2: the existing per-creator analytics queries (creator post velocity, engagement, etc.) sit naturally behind a `BigQueryToolset` once the v1 Mongo data is materialised into BQ.

### 7.4 OpenAPI tool wrapper

`OpenAPIToolset` parses an OpenAPI 3.x spec (YAML or JSON) and emits one `RestApiTool` per operation. Each tool gets the operationId as its name and the operation summary as its description.

```python
from google.adk.agents import LlmAgent
from google.adk.tools.openapi_tool import OpenAPIToolset

with open("backend.openapi.yaml") as f:
    backend = OpenAPIToolset(
        spec_str=f.read(),
        spec_str_type="yaml",
        # Optional: auth_scheme + auth_credential for OAuth2/Bearer/etc.
    )

agent = LlmAgent(
    model="gemini-2.5-pro",
    name="backend_agent",
    tools=[backend],
)
```

This is the cleanest route for plugging an ADK agent into the existing social-seeding-v2 backend: point it at the v1 backend's OpenAPI spec and every existing route becomes a callable tool, no per-endpoint glue.

### 7.5 A2A — sub-agent as tool

Two flavours:

1. **In-process** — `AgentTool(other_agent)` (§4).
2. **Remote** — `to_a2a(root_agent)` exposes an ADK agent as an A2A server. A client agent can then import it as if it were local:

```python
from google.adk.a2a import RemoteA2AAgent

remote_vetter = RemoteA2AAgent(
    name="remote_vetter",
    agent_card_url="https://vetter.internal.example.com/.well-known/agent.json",
)

router = LlmAgent(
    model="gemini-2.5-pro",
    name="router",
    sub_agents=[remote_vetter],     # or tools=[AgentTool(remote_vetter)]
)
```

The A2A protocol gives you process / language isolation: the vetter can be Python, the router can be Go, both can run on different Cloud Run services.

---

## 8. Deployment

### 8.1 `adk deploy cloud_run`

Packages the agent code, builds a container, pushes to Artifact Registry, deploys to Cloud Run, all in one command.

```bash
adk deploy cloud_run \
  --project=my-project \
  --region=us-central1 \
  --service_name=seeding-vetter \
  --app_name=seeding_vetter \
  ./vetter_agent
```

Defaults assume the agent module exposes a `root_agent` variable. Container runs a FastAPI wrapper that exposes `/run`, `/run_sse`, and `/list_apps` — compatible with the ADK Runner protocol.

Cloud Run is the right target when you need: custom dependencies (system packages, Node.js), non-Python languages, existing Cloud Run-based traffic management, or co-location with other Cloud Run services.

### 8.2 `adk deploy agent_engine`

Deploys to Vertex AI Agent Engine — a managed runtime that handles sessions, memory, observability, and scaling without you running a container.

```bash
adk deploy agent_engine \
  --project=my-project \
  --region=us-central1 \
  --display_name="Seeding Vetter v2" \
  --staging_bucket=gs://my-staging-bucket \
  ./vetter_agent
```

Agent Engine gives you:

- Managed `VertexAiSessionService` (no DB to run).
- Managed `VertexAiMemoryBankService` (preview).
- A Playground UI in the Cloud Console for non-engineering stakeholders to test the agent.
- Built-in observability (per-invocation traces, cost, latency) via Cloud Trace + Cloud Monitoring.
- Native A2A endpoint without you wiring `to_a2a()` yourself.

Trade-offs: Python-only today, opinionated runtime, slower cold start than Cloud Run.

### 8.3 `agents-cli` workflow

Day-in-the-life for the agent team:

```bash
# 1. Scaffold
adk create seeding_vetter --template=basic
cd seeding_vetter

# 2. Iterate locally with the Dev UI (graph viz + event inspector)
adk web --port 8000

# 3. Run end-to-end from the CLI (no UI)
adk run .

# 4. Evaluate against the golden set (see §9)
adk eval . eval/golden.evalset.json --print_detailed_results

# 5. Deploy
adk deploy cloud_run --project=... --region=... .
# or
adk deploy agent_engine --project=... --region=... .
```

The Dev UI's graph visualisation handles the 2.0 Beta `Workflow` graphs natively (active-node highlighting, per-node event timeline) — the single biggest reason to move to 2.0 once it stabilises.

---

## 9. Evaluation

ADK evaluation is **first-class** — it is not a bolt-on. The contract is: a test set is a JSON file describing turn-by-turn expected behavior; `adk eval` runs the agent against the set and scores both **trajectory** (did it call the right tools in the right order?) and **final response** (was the answer right?).

### 9.1 `adk eval` LLM-as-judge

Test set shape (truncated):

```json
{
  "eval_set_id": "seeding_smoke_v1",
  "name": "seeding sourcing smoke",
  "eval_cases": [
    {
      "eval_id": "case_001",
      "conversation": [
        {
          "user_content": {"parts": [{"text": "find 5 fitness creators in Korea, <100k followers"}]},
          "final_response": {"parts": [{"text": "Here are 5 fitness creators ..."}]},
          "intermediate_data": {
            "tool_uses": [
              {"name": "tiktok_search", "args": {"keyword": "fitness Korea", "limit": 50}},
              {"name": "rank_creators", "args": {}}
            ]
          }
        }
      ]
    }
  ]
}
```

Built-in criteria:

| Criterion | What it measures | LLM-as-judge? |
|---|---|---|
| `tool_trajectory_avg_score` | Sequence of tool calls vs expected, with `EXACT` / `IN_ORDER` / `ANY_ORDER` match modes | No — deterministic |
| `response_match_score` | Text-similarity of final response to golden | No — ROUGE-like |
| `final_response_match_v2` | Semantic equivalence of final response to golden | **Yes** — uses Gemini as judge |
| `hallucinations_v1` | Per-sentence grounding check | **Yes** |
| `safety_v1` | Harmlessness | Yes — delegates to Vertex AI Eval SDK |
| Rubric-based | Custom rubrics for response + tool use | Yes |

You tune thresholds in `test_config.json`:

```json
{
  "criteria": {
    "tool_trajectory_avg_score": 0.9,
    "final_response_match_v2": 0.7
  }
}
```

### 9.2 Trajectory scoring details

`tool_trajectory_avg_score` works by zipping the expected tool-call list with the observed one and counting matches. The three match modes:

- **`EXACT`** — every tool call must match (name + arg dict).
- **`IN_ORDER`** — relative ordering preserved; extra calls allowed.
- **`ANY_ORDER`** — set equality.

For an outreach agent, `IN_ORDER` is usually right: you care that `prompt_guard` runs before `gmail_send`, but not that the agent first checked `list_templates` vs `get_brand_voice`.

### 9.3 Custom evaluators

Subclass `BaseEvaluator` and register it in `test_config.json`. Each evaluator returns a score in [0, 1] per case. Use this for domain-specific signals like "did the agent escalate to human when the creator's audience contained > X% under-18 viewers?"

```python
from google.adk.evaluation import BaseEvaluator, EvalResult

class EscalationCorrectness(BaseEvaluator):
    def evaluate(self, eval_case, actual_trajectory, actual_response):
        expected_escalation = eval_case.metadata.get("should_escalate", False)
        actually_escalated = any(t.name == "escalate_to_human" for t in actual_trajectory.tool_uses)
        score = 1.0 if expected_escalation == actually_escalated else 0.0
        return EvalResult(score=score, label="escalation_correct")
```

For social-seeding-v2: each agent gets a 20–50 case golden set checked into the repo. `pnpm run verify-build` already enforces "tests must stay green"; the natural extension is `adk eval` invoked as a pre-push hook for any agent change.

---

## 10. Worked end-to-end example — "TikTok influencer sourcing agent"

The brief: coordinator agent + 2 specialists (searcher, ranker) + escalation tool, deployable to Vertex AI Gemini 2.5 Pro. ~200 lines, compiles and runs.

Layout:

```
sourcing_agent/
├── __init__.py
├── agent.py          # the agent definition (this file)
├── tools.py          # the four tools
├── .env              # GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, GOOGLE_GENAI_USE_VERTEXAI=TRUE
└── eval/
    └── golden.evalset.json
```

### 10.1 `tools.py`

```python
"""Tools for the TikTok influencer sourcing agent.

In production these wrap the existing social-seeding tiktok-* microservices
(see /tiktok-search-users at :8084, /tiktok-user-info at :8082). Here they
are stubbed so the agent runs offline.
"""

from __future__ import annotations
from typing import TypedDict
import os
import httpx

INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY", "")
SEARCH_URL = os.environ.get("TIKTOK_SEARCH_URL", "http://localhost:8084/search")
USER_INFO_URL = os.environ.get("TIKTOK_USER_INFO_URL", "http://localhost:8082/user")


class Creator(TypedDict):
    handle: str
    followers: int
    niche: str


class CreatorProfile(TypedDict):
    handle: str
    followers: int
    bio: str
    engagement_rate: float
    recent_post_count: int
    region: str


class RankedCreator(TypedDict):
    handle: str
    score: float
    rationale: str


def tiktok_search(keyword: str, limit: int = 20) -> list[Creator]:
    """Search TikTok for creators matching a keyword.

    Args:
        keyword: Free-text search query, e.g. "fitness Korea".
        limit:   Max number of results (1-100).

    Returns:
        List of Creator dicts. Empty list if nothing found.
    """
    try:
        r = httpx.post(
            SEARCH_URL,
            headers={"X-API-Key": INTERNAL_API_KEY},
            json={"keyword": keyword, "limit": min(max(limit, 1), 100)},
            timeout=30.0,
        )
        r.raise_for_status()
        return r.json().get("creators", [])
    except httpx.HTTPError:
        # offline / dev fallback so the agent still runs
        return [
            {"handle": "@kfit_min", "followers": 47_000, "niche": "fitness"},
            {"handle": "@seoul_lifts", "followers": 88_000, "niche": "fitness"},
        ][:limit]


def tiktok_get_user_info(handle: str) -> CreatorProfile:
    """Fetch the full profile for a single TikTok creator.

    Args:
        handle: TikTok handle, with or without leading '@'.

    Returns:
        CreatorProfile with followers, engagement, region, recent activity.
    """
    handle = handle if handle.startswith("@") else f"@{handle}"
    try:
        r = httpx.get(
            USER_INFO_URL,
            headers={"X-API-Key": INTERNAL_API_KEY},
            params={"handle": handle},
            timeout=30.0,
        )
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError:
        return {
            "handle": handle,
            "followers": 47_000,
            "bio": "Daily home workouts. Seoul.",
            "engagement_rate": 0.063,
            "recent_post_count": 14,
            "region": "KR",
        }


def rank_creators(
    creators: list[Creator], brand_context: str
) -> list[RankedCreator]:
    """Rank creators against a brand brief.

    Args:
        creators:      The candidate list (from tiktok_search).
        brand_context: A free-text brand brief.

    Returns:
        Creators sorted by fit score (descending), with a one-line rationale.
    """
    # Naive deterministic ranker; the LLM uses this as a baseline and may
    # re-order using its own judgement. Anchoring score on follower-band fit.
    sweet_spot = (30_000, 150_000)
    ranked: list[RankedCreator] = []
    for c in creators:
        in_band = sweet_spot[0] <= c["followers"] <= sweet_spot[1]
        score = 0.9 if in_band else 0.5
        ranked.append({
            "handle": c["handle"],
            "score": score,
            "rationale": (
                f"{'In' if in_band else 'Out of'} target follower band "
                f"({sweet_spot[0]:,}–{sweet_spot[1]:,}); brief: {brand_context[:60]}…"
            ),
        })
    ranked.sort(key=lambda r: r["score"], reverse=True)
    return ranked


def escalate_to_human(reason: str) -> str:
    """Escalate to a human operator. Call this when uncertain or blocked.

    Args:
        reason: Why escalation is needed (1-2 sentences).

    Returns:
        Confirmation string. The orchestrator records the escalation in the
        session state and surfaces it on the Mission Control UI.
    """
    # In v2 this would enqueue an HITL gate via Inngest. Here we just record.
    return f"ESCALATED: {reason}"
```

### 10.2 `agent.py`

```python
"""TikTok influencer sourcing agent.

Coordinator + 2 specialists (searcher, ranker), running on Vertex AI Gemini 2.5 Pro.
Run locally:    adk run sourcing_agent
Run dev UI:     adk web --port 8000
Eval:           adk eval sourcing_agent sourcing_agent/eval/golden.evalset.json
Deploy:         adk deploy agent_engine --project=$PROJECT --region=us-central1 sourcing_agent
"""

from __future__ import annotations

from google.adk.agents import LlmAgent
from google.adk.tools.agent_tool import AgentTool

from .tools import (
    tiktok_search,
    tiktok_get_user_info,
    rank_creators,
    escalate_to_human,
)

MODEL_PRIMARY = "gemini-2.5-pro"   # judgement, planning
MODEL_FAST = "gemini-2.5-flash"    # bulk extraction

# ---- Specialist 1: Searcher ------------------------------------------------
searcher_agent = LlmAgent(
    name="searcher",
    model=MODEL_FAST,
    description=(
        "Specialist that finds candidate TikTok creators for a brief. "
        "Uses tiktok_search to fan out across query angles and "
        "tiktok_get_user_info to enrich the most promising results."
    ),
    instruction=(
        "You are a TikTok creator scout.\n"
        "1. Given the brand brief in {brand_brief}, derive 2-3 distinct search keywords.\n"
        "2. Call tiktok_search for each keyword (limit=20 each).\n"
        "3. Dedupe by handle. For the 10 most relevant, call tiktok_get_user_info.\n"
        "4. Return a JSON array of CreatorProfile dicts. No commentary, JSON only.\n"
        "If a tool call fails 3 times in a row, call escalate_to_human."
    ),
    tools=[tiktok_search, tiktok_get_user_info, escalate_to_human],
    output_key="candidate_profiles",
)

# ---- Specialist 2: Ranker --------------------------------------------------
ranker_agent = LlmAgent(
    name="ranker",
    model=MODEL_PRIMARY,
    description=(
        "Specialist that ranks a candidate list against a brand brief and "
        "returns a final shortlist with rationale."
    ),
    instruction=(
        "Inputs:\n"
        "  - brand_brief: {brand_brief}\n"
        "  - candidate_profiles: {candidate_profiles}\n"
        "Steps:\n"
        "1. Call rank_creators(creators=candidate_profiles, brand_context=brand_brief) "
        "   to get a baseline score per creator.\n"
        "2. Re-read each profile's bio + engagement_rate; adjust the order if a "
        "   creator is clearly off-brand or has weak engagement (<2%).\n"
        "3. Return JSON: {shortlist: [{handle, score, rationale}], excluded: [...]}.\n"
        "4. If fewer than 3 creators clear the bar, call escalate_to_human."
    ),
    tools=[rank_creators, escalate_to_human],
    output_key="shortlist",
)

# ---- Coordinator -----------------------------------------------------------
root_agent = LlmAgent(
    name="sourcing_coordinator",
    model=MODEL_PRIMARY,
    description=(
        "Top-level coordinator for TikTok creator sourcing. Owns the conversation "
        "with the user, delegates search to `searcher`, delegates ranking to `ranker`, "
        "and escalates anything it cannot confidently resolve."
    ),
    instruction=(
        "You orchestrate the sourcing of TikTok creators for a brand brief.\n"
        "Workflow:\n"
        "  1. Confirm the brief is concrete (region, niche, follower band, dealbreakers). "
        "     If anything is missing, ask the user. Once confirmed, store it as brand_brief "
        "     in session state and proceed.\n"
        "  2. Call the searcher tool. Wait for {candidate_profiles}.\n"
        "  3. Call the ranker tool. Wait for {shortlist}.\n"
        "  4. Present the top 5 to the user with one-line rationale each.\n"
        "  5. Ask whether to escalate edge cases to a human reviewer.\n"
        "If the user asks for something outside sourcing (legal review, contract drafting, "
        "payment processing), call escalate_to_human with a clear reason — do not improvise."
    ),
    tools=[
        AgentTool(searcher_agent),
        AgentTool(ranker_agent),
        escalate_to_human,
    ],
)
```

### 10.3 `.env`

```bash
GOOGLE_GENAI_USE_VERTEXAI=TRUE
GOOGLE_CLOUD_PROJECT=my-gcp-project
GOOGLE_CLOUD_LOCATION=us-central1
# offline fallbacks for local dev:
TIKTOK_SEARCH_URL=http://localhost:8084/search
TIKTOK_USER_INFO_URL=http://localhost:8082/user
INTERNAL_API_KEY=dev-key
```

### 10.4 Wire it into the v2 stack

Two integration points:

1. **As a tool inside an Inngest workflow.** The orchestrator step calls `runner.run(user_id, "find me 5 fitness creators")` with the ADK `Runner`, captures the resulting `Event` stream, and writes the shortlist to MongoDB exactly like the existing v1 sourcing agent does. The Inngest function owns durability, HITL gates, and the USD cap; the ADK agent owns the conversation.

2. **As a Cloud Run service the v1 backend calls.** `adk deploy cloud_run` produces a service exposing `/run_sse`. The v1 Go backend can call it over HTTP; this is the lowest-touch path for the GCP demo lane because nothing in the v1 backend needs to know it is talking to an ADK agent.

### 10.5 Verifying it runs

```bash
cd sourcing_agent
pip install "google-adk>=1.3,<2" httpx
adk web --port 8000
# open http://localhost:8000, pick "sourcing_coordinator", type:
# "Find me 5 Korean fitness creators between 30k and 150k followers."
```

If the tiktok-* microservices are down, the tool fallbacks return canned data and the agent will still complete a full trajectory — useful for offline iteration.

---

## 11. Decision matrix — should social-seeding-v2 adopt ADK?

| Concern | ADK fit |
|---|---|
| v2 agents are "functions with typed output + USD cap" | Good — `LlmAgent` + `output_key` + `before_tool_callback` cost-ledger maps cleanly. |
| Orchestration is Inngest (durable timers, signals) | **Keep Inngest.** ADK orchestration is in-process; durability across human gates requires Inngest holding the conversation envelope. |
| Anthropic Claude is the production model | ADK is Gemini-optimized but model-agnostic via the `LiteLlm` wrapper. Mixed-model lanes (Claude + Gemini) work but lose first-party Vertex tooling. |
| Existing tiktok-* microservices, MongoDB | Wrap each microservice as an `OpenAPIToolset` or plain function tool. MongoDB stays as-is via a custom `BaseSessionService`. |
| Evaluation discipline ("golden set before phase done") | Strong fit. `adk eval` + per-agent `eval/golden.evalset.json` checked in. |
| GCP demo deadline | `adk deploy agent_engine` is the fastest credible path to a managed GCP-hosted demo agent. |

Recommendation: adopt ADK **for the GCP-lane variant of the sourcing + ranking agents only**, keep the Claude-on-Anthropic stack untouched for the main product, and use `adk eval` as the standard evaluation harness across both lanes regardless of runtime.

---

## Sources

Authoritative pages cited and used in writing this guide:

- ADK home — https://adk.dev/ and https://google.github.io/adk-docs/
- ADK 2.0 Beta overview — https://adk.dev/2.0/
- Python getting started — https://adk.dev/get-started/python/
- TypeScript getting started — https://google.github.io/adk-docs/get-started/typescript/
- Go getting started — https://google.github.io/adk-docs/get-started/go/
- Java getting started — https://google.github.io/adk-docs/get-started/java/
- Multi-agent systems — https://adk.dev/agents/multi-agents/
- Workflow agents (Sequential) — https://adk.dev/agents/workflow-agents/sequential-agents/
- Custom agents — https://adk.dev/agents/custom-agents/
- Callbacks index — https://google.github.io/adk-docs/callbacks/
- Callback types — https://google.github.io/adk-docs/callbacks/types-of-callbacks/
- Sessions & Memory — https://google.github.io/adk-docs/sessions/memory/ and https://google.github.io/adk-docs/sessions/session/
- Skills overview — https://google.github.io/adk-docs/skills/
- MCP tools — https://google.github.io/adk-docs/tools-custom/mcp-tools/
- BigQuery tool — https://google.github.io/adk-docs/tools/google-cloud/bigquery/
- OpenAPI tools — https://google.github.io/adk-docs/tools-custom/openapi-tools/
- Evaluation — https://google.github.io/adk-docs/evaluate/ and `…/evaluate/criteria/`
- Agent Engine deploy — https://google.github.io/adk-docs/deploy/agent-engine/deploy/
- Cloud Run deploy — https://docs.cloud.google.com/run/docs/ai/build-and-deploy-ai-agents/deploy-adk-agent
- PyPI `google-adk` — https://pypi.org/project/google-adk/ and 2.0 pre-release https://pypi.org/project/google-adk/2.0.0a1/
- npm `@google/adk` — https://www.npmjs.com/package/@google/adk
- Go module — https://pkg.go.dev/google.golang.org/adk
- GitHub repos — https://github.com/google/adk-python · https://github.com/google/adk-js · https://github.com/google/adk-go · https://github.com/google/adk-java · https://github.com/google/adk-docs
- Google Developers Blog — ADK for TypeScript 1.0 announcement, ADK for Java 1.0 announcement, "Developer's guide to multi-agent patterns in ADK", "Developer's Guide to Building ADK Agents with Skills", "Build Long-running AI agents that pause, resume, and never lose context with ADK"
- Google Cloud Blog — "Tools Make an Agent: From Zero to Assistant with ADK", "Building Collaborative AI: A Developer's Guide to Multi-Agent Systems with ADK", "BigQuery meets Google ADK & MCP", "Unlock AI agent collaboration. Convert ADK agents for A2A", "Remember this: Agent state and memory with ADK"
