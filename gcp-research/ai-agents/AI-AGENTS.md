# AI-AGENTS.md — Google Cloud Gemini Enterprise Agent Platform (2026 Definitive Reference)

> **Audience.** Engineers building agents on Google Cloud for the *AI Agents Challenge* (Track 3 — Gemini Enterprise agent listing).
> **Asof.** 2026-05-19. Rebrand baseline = **Google Cloud Next ’26 (April 22, 2026)** when "Vertex AI" was repositioned as the **Gemini Enterprise Agent Platform** and Agent Engine was renamed to **Agent Runtime**.
> **Citations.** Every product/version claim links to `cloud.google.com` or `developers.googleblog.com` (Google's official channels). Third-party blogs are *never* used as the source of truth.

---

## 0. The 2026 Rebrand You MUST Know Before Touching Anything

At **Google Cloud Next ’26 (April 22, 2026)**, Google consolidated *Vertex AI Agent Builder* + *Agentspace* into one rebranded product:

| Old name (≤ April 2026) | New name (April 22, 2026 →) |
|---|---|
| Vertex AI Agent Builder | **Gemini Enterprise Agent Platform** |
| Vertex AI Agent Engine | **Agent Runtime** |
| Agent Builder Sessions | **Agent Platform Sessions** |
| Memory Bank | **Agent Platform Memory Bank** |
| Vertex AI Search | **Agent Search** (still uses `discoveryengine.googleapis.com`) |

Existing customers do **not** need to migrate — the underlying APIs (`aiplatform.googleapis.com`, `discoveryengine.googleapis.com`) are unchanged. The Python SDK (`google-cloud-aiplatform`, `vertexai`) is unchanged. Only consoles, docs, and pricing pages were re-skinned.
[Source: cloud.google.com — Gemini Enterprise Agent Platform overview](https://cloud.google.com/products/gemini-enterprise-agent-platform)

The platform is organized as **four pillars** (the official mental model used in every keynote and doc):

```
┌─────────────────────────────────────────────────────────────────┐
│   BUILD       │   SCALE       │   GOVERN      │   OPTIMIZE      │
│   (ADK,       │   (Runtime,   │   (Gateway,   │   (Evaluation,  │
│    Studio,    │    Sandbox,   │    Identity,  │    Observ-      │
│    Garden,    │    Memory     │    Registry,  │    ability,     │
│    CLI,       │    Bank,      │    Model      │    Optimizer,   │
│    A2A/MCP/   │    Sessions)  │    Armor)     │    Simulation,  │
│    AP2/A2UI)  │               │               │    Anomaly Det.)│
└─────────────────────────────────────────────────────────────────┘
```
[Source: Gemini Enterprise Agent Platform overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/overview) · [Five guides to building and scaling production-ready AI agents](https://cloud.google.com/blog/topics/developers-practitioners/five-guides-to-building-and-scaling-production-ready-ai-agents)

---

# BUILD LAYER

## 1. Agent Development Kit (ADK)

### What it is
The **open-source** agent framework Google uses internally for Workspace, Search, and Gemini Enterprise — released as `pip install google-adk`. It is **code-first** (LLM agents, workflow agents, tools, callbacks are real Python/TS/Go/Java classes you compose), with an opinionated set of primitives:

- `LlmAgent` — single agent powered by a Gemini (or Model Garden) model + tools.
- **Workflow agents** — `SequentialAgent`, `ParallelAgent`, `LoopAgent` for deterministic orchestration.
- **Custom agents** — subclass `BaseAgent` for hand-rolled control flow.
- **Sub-agents / Agent Teams** — coordinator → specialists pattern with auto-delegation.
- **Tools** — function tools, `google_search`, `built_in_code_execution`, OpenAPI, MCP servers, Agent-as-Tool.
- **Callbacks** — `before_model`, `after_model`, `before_tool`, `after_tool` for guardrails/logging.
- **Graph-based workflows** (new in 2026) — DAG with conditional edges, replacing the older "ReAct only" model.
- **Agent Skills** — packaged, reusable agent capabilities discoverable via Agent Registry.

### Status (May 2026)
- **Python ADK 2.0 Beta** — workflows and agent teams. (`pip install google-adk`)
- **TypeScript ADK 1.0 GA**.
- **Java + Go ADK** — Alpha/Beta tracks.
[Source: adk.dev](https://adk.dev/) · [Agent Development Kit (Build pillar)](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/adk)

### When to use it
**Build pillar.** Whenever you need code-first, multi-agent control with explicit tools, evaluation harnesses, and the ability to deploy to *anywhere* (Agent Runtime, Cloud Run, GKE, your laptop).

### Minimum working code (Python)

```bash
# 1. Install
pip install google-adk
# Optional extras for managed memory + Agent Runtime
pip install "google-cloud-aiplatform[adk,agent_engines]"
```

```python
# 2. Define a single agent with a tool
from google.adk.agents import LlmAgent
from google.adk.tools import google_search

root_agent = LlmAgent(
    name="researcher",
    model="gemini-2.5-flash",                       # or gemini-3-pro-preview for hard reasoning
    instruction="You research topics and cite sources.",
    tools=[google_search],
)
```

```python
# 3. Compose a multi-agent workflow (Sequential + Parallel + Loop)
from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent, LoopAgent

positive_critic = LlmAgent(name="PositiveCritic", model="gemini-2.5-flash",
                           instruction="List strengths.", output_key="pros")
negative_critic = LlmAgent(name="NegativeCritic", model="gemini-2.5-flash",
                           instruction="List weaknesses.", output_key="cons")

parallel_critique = ParallelAgent(
    name="parallel_critique",
    sub_agents=[positive_critic, negative_critic],
)

refine = LlmAgent(name="Refine", model="gemini-2.5-pro",
                  instruction="Refine based on {pros} and {cons}.", output_key="draft")
critic_loop = LoopAgent(name="critic_loop",
                        sub_agents=[parallel_critique, refine],
                        max_iterations=3)

pipeline = SequentialAgent(
    name="research_pipeline",
    sub_agents=[root_agent, critic_loop],
)
```
[Source: Multi-agent systems — adk.dev](https://google.github.io/adk-docs/agents/multi-agents/) · [Sequential agents](https://google.github.io/adk-docs/agents/workflow-agents/sequential-agents/)

### Integration points
- **Agent Runtime** — wrap with `AdkApp` and `client.agent_engines.create()` (see §10).
- **Cloud Run** — `agents-cli scaffold enhance --deployment-target cloud_run && agents-cli deploy` (see §4 and §9).
- **GKE Agent Sandbox** — deploy as a single-replica gVisor-isolated workload (see §11).
- **Agent Registry / Gemini Enterprise** — register a deployed agent to surface it in the corporate Agent Gallery.
- **MCP / A2A / AP2 / A2UI** — first-class support (see §6–§8 and §A2UI).
- **Memory Bank, Sessions** — via `VertexAiMemoryBankService` and `VertexAiSessionService`.

### Latest features (May 2026)
- Graph-based workflows (Python).
- Collaborative agents (coordinator + sub-agents) with automatic A2A bridging.
- Dynamic workflows (LLM-decided next-step routing).
- Agent Skills support — package an agent capability and publish to Agent Registry.
- MCP client + MCP server emit/consume.
- A2A client + AgentExecutor server-side primitives.
[Source: Google Cloud Next ’26 wrap-up](https://cloud.google.com/blog/topics/google-cloud-next/google-cloud-next-2026-wrap-up) · [Five guides to building and scaling production-ready AI agents](https://cloud.google.com/blog/topics/developers-practitioners/five-guides-to-building-and-scaling-production-ready-ai-agents)

### Pricing
ADK is **free / open-source**. You pay for the **model tokens** (Gemini / Model Garden) the agent consumes, plus the **runtime** (Agent Runtime, Cloud Run, or GKE) it executes on, plus optional **Memory Bank / Sessions / Agent Search** usage.
[Source: Agent Platform pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)

### Doc URLs
- [`adk.dev`](https://adk.dev/) — canonical framework docs (Python, TS, Go, Java).
- [`docs.cloud.google.com/gemini-enterprise-agent-platform/build/adk`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/adk) — ADK inside the Agent Platform.

---

## 2. Agent Studio (Public Preview / GA April 2026)

### What it is
The **low-code visual canvas** for designing, prototyping, and managing agent reasoning loops. Replaces the old "Vertex AI Studio" + "Agent Designer". The unique property is **bi-directional**: you can drag-and-drop a flow, then export the same agent as ADK code for engineering teams to extend.

### Status
- Announced and demoed at Cloud Next ’26 (April 22, 2026).
- GA April 23, 2026 per the launch blog.
[Source: Introducing Gemini Enterprise Agent Platform](https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform)

### When to use it
**Build pillar.** Product managers, business users, or solution architects prototyping an agent before engineering takes over.

### Integration points
- Exports to **ADK** code.
- Publishes directly to **Agent Runtime** + **Gemini Enterprise app**.
- Picks up tools / MCP servers from **Agent Registry**.

### Doc URLs
- [`cloud.google.com/products/gemini-enterprise-agent-platform`](https://cloud.google.com/products/gemini-enterprise-agent-platform) (marketing/landing — Studio is described under "Build")

---

## 3. Agent Garden (GA April 2026)

### What it is
A curated, ever-growing library of **atomic agent blueprints** (RAG-grounded customer support, documentation Q&A, data analyst, code modernization, financial analyst, economic research, invoice processing, deep research, etc.) — each blueprint is a ready-to-clone repo that already wires together ADK + Agent Runtime + Agent Search + Memory Bank + Model Armor.

### Status
GA at Cloud Next ’26 (April 22, 2026). Application Design Center integrates Garden templates with one-click deployment to Agent Runtime and one-click registration to Gemini Enterprise.
[Source: Agent Garden docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/agent-garden)

### When to use it
**Build pillar — Day 1.** Always check Garden first; it saves weeks of integration plumbing.

### Integration points
- RAG Engine, Vector Search, Gemini models, Agent Runtime — all pre-wired.
- Agents CLI `agents-cli create --template <garden-blueprint>` clones a blueprint.
- Application Design Center exposes a low-code "ClickOps" path.

### Doc URLs
- [`docs.cloud.google.com/gemini-enterprise-agent-platform/build/agent-garden`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/agent-garden)
- Source repos under [`github.com/Google-Cloud-AI/agent-platform`](https://github.com/Google-Cloud-AI/agent-platform).

---

## 4. Agents CLI (Alpha, Cloud Next ’26)

### What it is
A **single command-line tool** that covers the entire **Agent Development Lifecycle (ADLC)**: scaffold → install → run → evaluate → infra → deploy → publish. Crucially, it is *designed for AI coding agents* (Gemini CLI, Claude Code, Cursor) — i.e. it exposes a machine-readable "skills" surface so your AI assistant can talk to the agent stack directly. Two modes: **Agent Mode** (optimized for AI consumption) and **Human Mode** (deterministic terminal).

### Status
**Alpha (open-source on GitHub)** as of Cloud Next ’26.
[Source: Agents CLI in Agent Platform](https://developers.googleblog.com/agents-cli-in-agent-platform-create-to-production-in-one-cli/) · [github.com/google/agents-cli](https://github.com/google/agents-cli)

### When to use it
**Build → Optimize.** Day-1 scaffolding of an ADK project, recurring eval runs, deploys to Agent Runtime / Cloud Run, and publishing to Gemini Enterprise.

### Minimum working code

```bash
# 1. Install uv (https://docs.astral.sh/uv/getting-started/installation/) then:
uvx google-agents-cli setup       # one-time machine bootstrap

# 2. Scaffold + run locally
agents-cli create caveman-agent --prototype --yes
cd caveman-agent && agents-cli install
agents-cli run "Why do mammoths matter?"

# 3. Evaluate against golden-set
agents-cli eval run
agents-cli eval compare           # diff metrics across runs

# 4. Provision infra + deploy
agents-cli scaffold enhance --deployment-target cloud_run   # or: agent_runtime
agents-cli infra
agents-cli deploy

# 5. Publish to Gemini Enterprise
agents-cli publish
```
[Source: agents-cli quickstart](https://docs.cloud.google.com/gemini-enterprise-agent-platform/agents/quickstart-adk)

### Integration points
- **ADK** projects (scaffolds them).
- **Agent Runtime / Cloud Run / GKE** (deploys to them).
- **Cloud Trace** (enabled by default — observability without code).
- **Gemini Enterprise** (`publish` registers the agent).

### Doc URLs
- [`developers.googleblog.com/agents-cli-in-agent-platform-create-to-production-in-one-cli`](https://developers.googleblog.com/agents-cli-in-agent-platform-create-to-production-in-one-cli/)
- [`docs.cloud.google.com/gemini-enterprise-agent-platform/agents/quickstart-adk`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/agents/quickstart-adk)

---

## 5. Gemini API + Model Garden

### What it is
The single endpoint (`generativelanguage.googleapis.com` for AI Studio / `aiplatform.googleapis.com` for Vertex) for **200+ models**: Gemini 3.x, Gemini 2.5, Gemini 2.0 Flash, plus 3P (Anthropic Claude, Meta Llama 4, Mistral, Cohere, AI21) and open models (Gemma 3/4) all callable through one unified API. **Managed Training** lets you fine-tune / distill / RLHF a model on your own data.

### Status
- **Gemini 3.1 Pro** — GA Feb 19, 2026.
- **Gemini 3 Pro / Flash** — Preview April 22, 2026.
- **Gemini 2.5 Pro / Flash / Flash-Lite** — GA.
- **Gemini 2.0 Flash / Flash-Lite** — GA (legacy tier).
- Model Garden — GA.
[Source: Agent Platform pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)

### When to use which model

| Model | When to use |
|---|---|
| **Gemini 3 Pro / 3.1 Pro** | Hard reasoning, judgment, planning, tool selection in agents. |
| **Gemini 2.5 Pro** | Stable production reasoning at lower cost than Gemini 3. |
| **Gemini 2.5 Flash / 2.0 Flash** | High-throughput tool calls, evals, batch enrichment. |
| **Gemini 2.5 Flash-Lite / 2.0 Flash-Lite** | Bulk classification, embedding generation, summarization. |
| **Claude / Llama / Gemma** (Model Garden) | Multi-vendor agent policies, "second opinion" judging. |

### Minimum working code

```python
# Vertex AI (Agent Platform) endpoint — preferred for enterprise (IAM, VPC-SC, logging)
from google import genai
client = genai.Client(vertexai=True, project="PROJECT_ID", location="us-central1")

resp = client.models.generate_content(
    model="gemini-3-pro-preview",
    contents="Summarize this in 3 bullets: ...",
    config={"thinking_config": {"include_thoughts": True}},
)
print(resp.text)
```

### Pricing (Gemini, standard tier, May 2026)
| Model | Input ≤200K | Input >200K | Output |
|---|---|---|---|
| Gemini 3.1 Pro | $2 / 1M | $4 / 1M | $12 / 1M |
| Gemini 3 Pro Preview | $2 / 1M | $4 / 1M | $12 / 1M |
| Gemini 3.1 Flash-Lite | $0.25 / 1M | $0.25 / 1M | $1.5 / 1M |
| Gemini 2.5 Pro | $1.25 / 1M | — | $10 / 1M |
| Gemini 2.5 Flash | $0.30 / 1M | — | $2.50 / 1M |
| Gemini 2.5 Flash-Lite | $0.10 / 1M | — | $0.40 / 1M |
| Gemini 2.0 Flash | $0.15 / 1M | — | $0.60 / 1M |

Cached-input tokens get a **90% discount**. **Priority** tier = 1.8× standard; **Flex / Batch** tier = 0.5× standard.
[Source: Agent Platform pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)

### Doc URLs
- [`cloud.google.com/vertex-ai/generative-ai/docs/models`](https://cloud.google.com/vertex-ai/generative-ai/docs/models)
- [`cloud.google.com/model-garden`](https://cloud.google.com/model-garden)

---

## 6. MCP — Model Context Protocol

### What it is
The **Anthropic-originated, Google-adopted** protocol for connecting agents to tools and data sources. Google ships:
- **First-party MCP servers** (Cloud Storage MCP, Workspace MCP — Preview).
- **MCP client** in ADK — any MCP server is a tool.
- **BYO-MCP** for Gemini Enterprise — admins register custom MCP servers.
- **Model Armor for MCP** — every MCP call can be screened for prompt injection / data leakage.

### Status
- MCP client in ADK — GA.
- Cloud Storage MCP server — GA.
- Workspace MCP server — **Preview**.
- BYO-MCP in Gemini Enterprise — GA.
[Source: Google Cloud Next ’26 wrap-up](https://cloud.google.com/blog/topics/google-cloud-next/google-cloud-next-2026-wrap-up)

### Minimum working code (Python ADK + MCP)

```python
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import MCPToolset, StdioServerParameters

mcp_tools = MCPToolset(
    connection_params=StdioServerParameters(
        command="npx",
        args=["-y", "@modelcontextprotocol/server-cloud-storage"],
        env={"GCS_BUCKET": "my-data-bucket"},
    )
)

agent = LlmAgent(
    name="storage_agent",
    model="gemini-2.5-pro",
    tools=[mcp_tools],
    instruction="Use MCP to read/write GCS objects on the user's behalf.",
)
```

### Doc URLs
- [`docs.cloud.google.com/model-armor/model-armor-mcp-google-cloud-integration`](https://docs.cloud.google.com/model-armor/model-armor-mcp-google-cloud-integration)

---

## 7. A2A — Agent2Agent Protocol

### What it is
An **open, transport-agnostic protocol** for agents to discover each other, exchange capabilities (via *Agent Cards*), and delegate work. Originally introduced 2025; v0.3 introduced gRPC + signed agent cards + extended Python SDK. The protocol underpins multi-agent collaboration across organizations.

### Status
- **A2A v0.3** — stable interface, gRPC, signed cards (August 2025).
- 150+ organizations support it (Adobe, S&P Global, ServiceNow, Twilio, hyperscalers).
- A2A v1.0 expected with the Cloud Next ’26 wave.
[Source: A2A protocol upgrade](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)

### When to use it
**Build + Scale pillars.** Whenever an agent must call another agent that lives in a different service, organization, or runtime (cross-team, cross-vendor, marketplace partners).

### Minimum working code — expose ADK as A2A server

```python
# Three primitives: AgentCard (capabilities), AgentExecutor (request handler), AgentSkill (skill metadata)
from a2a.server import AgentExecutor, AgentSkill, AgentCard
from a2a.server.tasks import InMemoryTaskStore
from google.adk.agents import LlmAgent

skill = AgentSkill(id="research", name="research", description="Web research and synthesis")
card = AgentCard(name="researcher",
                 description="ADK-powered research agent",
                 url="https://researcher.example.com",
                 version="1.0.0",
                 defaultInputModes=["text/plain"],
                 defaultOutputModes=["text/plain"],
                 skills=[skill])

executor = AgentExecutor(agent=LlmAgent(name="r", model="gemini-2.5-flash",
                                        instruction="Research and cite."),
                         task_store=InMemoryTaskStore())
# bind executor + card to an HTTP/gRPC server (see a2a-protocol.org docs)
```

### Integration points
- ADK exposes any agent as A2A with **one wrapper**.
- Agent Runtime hosts A2A agents.
- Cloud Run has a dedicated [A2A agents quickstart](https://docs.cloud.google.com/run/docs/ai/a2a-agents).
- Gemini Enterprise can register a remote A2A agent (see §13).

### Doc URLs
- [Agent2Agent protocol — official site](https://a2a-protocol.org/latest/)
- [Develop an A2A agent on Agent Runtime](https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/develop/a2a)
- [Register and manage A2A agents in Gemini Enterprise](https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent)

---

## 8. AP2 — Agent Payments Protocol

### What it is
An open extension of A2A + MCP that lets an agent perform **verifiable, accountable payments**. Built on **Mandates** — cryptographically signed digital contracts — solving the three hard problems of agentic commerce: **Authorization, Authenticity, Accountability**.

Three mandate types:
1. **Intent Mandate** — user instructs agent ("buy item X under $50 when in stock").
2. **Cart Mandate** — agent presents cart, user signs to lock items + price.
3. **Payment Mandate** — links payment method to the signed Cart Mandate, creating a non-repudiable audit trail.

Payment-method-agnostic: cards, stablecoins, real-time bank transfers, crypto via the **A2A x402** extension (built with Coinbase / Ethereum Foundation / MetaMask).

### Status
- **AP2 v0.2.0** — April 2026.
- Reference implementations in Python (primary), TypeScript, Kotlin, Go.
- 60+ partner companies (Mastercard, PayPal, Adyen, Amex, Salesforce, ServiceNow, Coinbase, etc.).
[Source: Announcing Agent Payments Protocol (AP2)](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)

### When to use it
**Build pillar — only if your agent performs payments.** For Social Seeding–style influencer disbursement, AP2 is the right abstraction for the eventual "pay creator" step.

### Doc URLs
- [`ap2-protocol.org`](https://ap2-protocol.org/) — specification.
- [`github.com/google-agentic-commerce/AP2`](https://github.com/google-agentic-commerce/AP2) — reference repos.
- [`github.com/google-a2a/a2a-x402`](https://github.com/google-a2a/a2a-x402) — crypto extension.

---

## 9. A2UI — Agent-to-UI Protocol

### What it is
A **declarative UI protocol** that lets an agent generate rich, native UI (forms, tables, charts, approval dashboards) rendered by the client — **without executing model-generated code**. The agent emits a JSON tree of components + data bindings; the client maps to native widgets. Sent over A2A as secure messages, so a remote agent can paint UI in the host app (e.g., a custom agent rendering an interactive chart inside the Gemini Enterprise app).

### Status
- **A2UI v0.8** — public preview (Cloud Next ’26).
- Gemini Enterprise supports **v0.8** specifically.
- Rendering targets: Web Components, Angular, Lit, Flutter (via GenUI SDK).
[Source: Introducing A2UI](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/) · [Register and manage A2UI agents](https://docs.cloud.google.com/gemini/enterprise/docs/a2ui-agents/register-and-manage-an-a2ui-agent)

### When to use it
**Build pillar.** When your agent's output is interactive — forms, dashboards, approval flows — and you want it native inside Gemini Enterprise (or your own host app) rather than as plain markdown.

### Minimum working code (clone the reference)

```bash
git clone https://github.com/google/A2UI.git
export GEMINI_API_KEY="..."

# Run the restaurant-finder reference agent + Lit web client
cd A2UI/samples/agent/adk/restaurant_finder && uv run .
cd A2UI/samples/client/lit/shell && npm install && npm run dev
```

### Doc URLs
- [`a2ui.org`](https://a2ui.org/)
- [`docs.cloud.google.com/gemini/enterprise/docs/a2ui-agents`](https://docs.cloud.google.com/gemini/enterprise/docs/a2ui-agents/register-and-manage-an-a2ui-agent)
- [Host an A2UI agent with Cloud Run](https://docs.cloud.google.com/gemini/enterprise/docs/a2ui-agents/tutorial-host-agent-cloud-run)

---

## 9b. Grounding — Search & Vertex AI Search

### What it is
**Grounding** attaches authoritative evidence to a model response. Two flavors:
- **Grounding with Google Search** — Gemini cites live web results.
- **Grounding with Your Data / Agent Search** — Gemini cites your own corpus indexed in Agent Search (formerly Vertex AI Search).

### Status
- Grounding with Google Search — **GA**.
- Grounding with Your Data — **GA**.
- Web Grounding for Enterprise — **GA**.
- Maps Grounding — **GA** (Preview last year).

### Pricing (May 2026)
| Grounding type | Cost |
|---|---|
| Grounding with Google Search (Gemini 3) | $14 per 1k queries (after free quota) |
| Grounding with Google Search (Gemini 2.5) | $35 per 1k prompts |
| Web Grounding for Enterprise | $45 per 1k prompts |
| Grounding with Your Data | $2.50 per 1k requests |
| Maps Grounding | $14-25 per 1k queries |
[Source: Agent Platform pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)

### Doc URLs
- [Grounding with Vertex AI Search](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/grounding/grounding-with-vertex-ai-search)

---

# SCALE LAYER

## 10. Agent Runtime (formerly Agent Engine — GA April 2026)

### What it is
The **fully managed runtime** for hosting ADK / LangChain / LangGraph / LlamaIndex / Agent2Agent / AG2 / *custom* agents. Replaces self-hosted Cloud Run for agents when you want managed sessions, managed memory, agent-to-agent orchestration, and Cloud Trace built in.

**2026 upgrades** (the reason for the rename):
- **Sub-second cold starts** (down from minutes).
- **Provisioning in under 1 minute**.
- **Long-running operations up to 7 days** (checkpoint-and-resume, human-in-loop pauses, zero compute during waits).
- **Custom container support** — bring your own image.
- **Agent-to-agent orchestration** built in.
[Source: Agent Runtime overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview) · [Five guides — design patterns](https://cloud.google.com/blog/topics/developers-practitioners/five-guides-to-building-and-scaling-production-ready-ai-agents)

### Status
**GA April 23, 2026.** Underlying REST resource is still `projects/*/locations/*/reasoningEngines/*` — unchanged so existing code keeps working.

### When to use it
**Scale pillar.** Pick Agent Runtime over Cloud Run when you need (a) managed sessions/memory, (b) >15min request lifetimes, (c) multi-day long-running workflows, (d) zero infra mgmt.

### Minimum working code — deploy ADK to Agent Runtime

```python
# pip install --upgrade "google-cloud-aiplatform[adk,agent_engines]"
import vertexai
from vertexai.preview import reasoning_engines
from google.adk.agents import LlmAgent

vertexai.init(project="PROJECT_ID", location="us-central1",
              staging_bucket="gs://STAGING_BUCKET")

root_agent = LlmAgent(name="researcher",
                      model="gemini-2.5-pro",
                      instruction="You research and cite.")

# Wrap the agent so it’s deployable
app = reasoning_engines.AdkApp(agent=root_agent, enable_tracing=True)

# (Optional) Test it locally
session = app.create_session(user_id="u1")
for event in app.stream_query(user_id="u1", session_id=session.id,
                              message="What is BLEU?"):
    print(event)

# Deploy to Agent Runtime
client = vertexai.Client(project="PROJECT_ID", location="us-central1")
remote_agent = client.agent_engines.create(
    agent=app,
    config={
        "requirements": ["google-cloud-aiplatform[agent_engines,adk]"],
        "staging_bucket": "gs://STAGING_BUCKET",
        "display_name": "researcher-v1",
    },
)

# Call the deployed agent
session = remote_agent.create_session(user_id="u1")
for event in remote_agent.stream_query(user_id="u1",
                                       session_id=session["id"],
                                       message="What is BLEU?"):
    print(event)
```
[Source: Class AdkApp Python reference](https://docs.cloud.google.com/python/docs/reference/vertexai/latest/vertexai.agent_engines.AdkApp) · [Quickstart: Develop with ADK on Agent Runtime](https://docs.cloud.google.com/agent-builder/agent-engine/quickstart-adk)

### Integration points
- **ADK / LangChain / LangGraph / LlamaIndex / A2A / AG2 / Custom**.
- Auto-issues an **Agent Identity** cryptographic ID.
- Routes through **Agent Gateway** (optional but recommended).
- Emits traces to **Cloud Trace** + metrics for **Agent Observability**.
- Uses **Memory Bank** + **Sessions** when called via ADK's services.

### Pricing
Compute-tier metered per **vCPU-hour + GiB-hour** during agent execution; idle waiting is **not** billed (the multi-day long-running pause feature). Plus **Sessions** and **Memory Bank** usage. Detailed rates: [Agent Platform pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing).

### Doc URLs
- [Agent Runtime overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview)
- [Use an ADK agent on Agent Runtime](https://docs.cloud.google.com/agent-builder/agent-engine/use/adk)
- [AdkApp Python reference](https://docs.cloud.google.com/python/docs/reference/vertexai/latest/vertexai.agent_engines.AdkApp)

---

## 11. Agent Sandbox (GKE Agent Sandbox — GA April 2026)

### What it is
A hardened, **gVisor**-isolated, single-replica execution environment on GKE for running **model-generated code** and **computer-use / browser-automation** tasks safely. Pre-warmed pools deliver **sub-second cold starts** at **300 sandboxes/sec** scale, with up to **90% latency reduction vs. cold start**. Open-source upstream is the Kubernetes SIG Apps **Agent Sandbox** controller.

### Status
- **GA April 23, 2026** (GKE Agent Sandbox).
- Open-source controller: [`agent-sandbox.sigs.k8s.io`](https://agent-sandbox.sigs.k8s.io/).
[Source: GKE Agent Sandbox docs](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox) · [Google Cloud Next ’26 wrap-up](https://cloud.google.com/blog/topics/google-cloud-next/google-cloud-next-2026-wrap-up)

### When to use it
**Scale pillar.** Whenever an agent runs **untrusted code** (Python interpreter, shell, browser, code-mod tools). Mandatory for any "computer-use" agent.

### Integration points
- ADK `built_in_code_execution` tool can be backed by Agent Sandbox.
- GKE Hypercluster (Private GA) can scale to millions of sandboxes.
- Model Armor screens code inputs/outputs.

### Doc URLs
- [About GKE Agent Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox)
- [Isolate AI code execution with Agent Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox)
- [Open-source project](https://agent-sandbox.sigs.k8s.io/)

---

## 12. Agent Memory Bank (GA — billing starts Jan 28, 2026)

### What it is
A **managed long-term memory store** that persists user/agent facts across sessions, with three phases under the hood: **extraction** (LLM pulls salient facts from a conversation), **consolidation** (de-dup + merge with existing memories), **retrieval** (semantic lookup at query time). 2026 added **Memory Profiles** for low-latency keyed recall.

### Status
**Generally Available.** Billing started **January 28, 2026** (the SDK was free preview through 2025).
[Source: Memory Bank overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/memory-bank/overview) · [Vertex AI release notes](https://docs.cloud.google.com/vertex-ai/docs/release-notes)

### When to use it
**Scale pillar.** Any agent that benefits from "remembering you" across sessions — preferences, history, ongoing projects. Anti-pattern: short-lived single-turn agents.

### Minimum working code

```python
import vertexai
client = vertexai.Client(project="PROJECT_ID", location="us-central1")

# Generate memories from a conversation
client.agent_engines.memories.generate(
    name="projects/PROJECT_ID/locations/us-central1/reasoningEngines/AGENT_ID",
    direct_contents_source={"events": [
        {"content": {"role": "user", "parts": [{"text": "I prefer 25C office temp."}]}}
    ]},
    scope={"user_id": "u1"},
)

# Retrieve memories at query time
results = client.agent_engines.memories.retrieve(
    name="projects/PROJECT_ID/locations/us-central1/reasoningEngines/AGENT_ID",
    scope={"user_id": "u1"},
    similarity_search_params={"search_query": "office preferences", "top_k": 5},
)

# Or wire into ADK:
from google.adk.memory import VertexAiMemoryBankService
mem = VertexAiMemoryBankService(project="PROJECT_ID", location="us-central1",
                                agent_engine_id="AGENT_ID")
```

### Doc URLs
- [Memory Bank overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/memory-bank/overview)
- [Set up Memory Bank](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/memory-bank/set-up)

---

## 13. Agent Sessions (GA — billing starts Jan 28, 2026)

### What it is
Per-session **conversation state** (events, messages, intermediate tool calls) — the short-term complement to Memory Bank. 2026 additions: **custom Session IDs** (bind a session to your CRM record id), **bidirectional streaming over WebSocket**.

### Status
GA. Billing starts Jan 28, 2026.

### Minimum working code

```python
import vertexai
client = vertexai.Client(project="PROJECT_ID", location="us-central1")

session = client.agent_engines.sessions.create(
    name="projects/PROJECT_ID/locations/us-central1/reasoningEngines/AGENT_ID",
    user_id="u1",
    session_id="crm-account-12345",  # custom ID bound to your DB row
)
```

### Doc URLs
- [Set up Sessions](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/sessions/overview)

---

# GOVERN LAYER

## 14. Agent Gateway (GA April 2026)

### What it is
**Centralized "air traffic control"** for the agent fleet: single ingress, applies **Model Armor**, enforces auth/quota/rate-limit policies, maintains audit trail. All inter-agent calls route through it.

### Status
GA April 22, 2026. Model Armor integration **in Preview** for Agent Gateway as of the GA wave.
[Source: Five guides — governance stack](https://cloud.google.com/blog/topics/developers-practitioners/five-guides-to-building-and-scaling-production-ready-ai-agents)

### When to use it
**Govern pillar.** Always, when an agent fleet exceeds ~5 agents or touches sensitive data.

### Integration points
- **Agent Identity** for cryptographic agent IDs.
- **Model Armor** for inline screening.
- **Agent Registry** for tool/agent allowlist.

---

## 15. Agent Identity (GA April 2026)

### What it is
Each agent gets a **verifiable cryptographic ID** (think workload identity for agents). Used to attach authorization policies, trace actions to a specific agent in audits, and prove origin when an agent calls another agent.

### Status
GA April 22, 2026.
[Source: Introducing Gemini Enterprise Agent Platform](https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform)

### Doc URLs
- [Five guides — agent governance stack](https://cloud.google.com/blog/topics/developers-practitioners/five-guides-to-building-and-scaling-production-ready-ai-agents)

---

## 16. Agent Registry (GA April 2026)

### What it is
The **central catalog** for everything an agent might use or be: registered **AI agents** (custom + partner), **MCP servers / tools**, **endpoints**, **Agent Skills**. Coordinator agents search the registry to find collaborators; admins use it to enforce a tool allow-list.

### Status
GA April 22, 2026.
[Source: Agent Registry docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/govern/agent-registry)

### Capabilities
- Keyword + prefix search for agents and tools.
- **Auth manager** integration — bind discovered tools to OAuth credentials.
- Dynamic endpoint resolution for orchestrator agents.

### Doc URLs
- [Agent Registry overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/govern/agent-registry)
- [Client libraries and ADK](https://docs.cloud.google.com/agent-registry/reference/libraries)

---

## 17. Model Armor (GA April 2026 — billing live)

### What it is
**Runtime LLM/agent security gateway**. Screens prompts and responses for: **prompt injection**, **jailbreak**, **malicious URLs** (up to 40/request), **sensitive data** (PII — credit cards, SSNs, API keys via Sensitive Data Protection), **harmful content** (hate, harassment, sexual, dangerous), **CSAM** (always-on). Stateless service, in-memory only unless Cloud Logging is enabled.

### Status
- **Standalone Model Armor — GA**.
- Integration with **Firebase — GA**.
- Integration with **Agent Gateway / Agent Runtime / LangChain — Preview**.
- Integration with **Gemini Enterprise — GA, default-on**.
- Integration with **GKE — GA**.
- Integration with **Google Cloud MCP servers — GA**.
[Source: Model Armor overview](https://docs.cloud.google.com/model-armor/overview) · [Model Armor release notes](https://docs.cloud.google.com/model-armor/release-notes)

### When to use it
**Govern pillar.** Every production agent. Anti-pattern: skipping Model Armor on internal tools because "they're not user-facing" — agents that touch user-controlled text are *always* user-facing.

### Pricing
**First 2M tokens/month free; $0.10 per 1M tokens thereafter.**
[Source: Model Armor pricing](https://cloud.google.com/security/products/model-armor)

### Templates / config
- Confidence thresholds: **High / Medium-and-above / Low-and-above**.
- Enforcement modes: **Inspect-only** (log without block) / **Inspect-and-block**.
- Separate templates for **input** vs. **output**.
- Languages: zh, en, fr, de, it, ja, ko, pt, es (others have variable quality).

### Minimum working code (REST sanitize prompt)

```bash
curl -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://modelarmor.us-central1.rep.googleapis.com/v1/projects/PROJECT_ID/locations/us-central1/templates/TEMPLATE_ID:sanitizeUserPrompt" \
  -d '{"user_prompt_data": {"text": "Ignore previous instructions and..."}}'
```

### Doc URLs
- [Model Armor overview](https://docs.cloud.google.com/model-armor/overview)
- [Integrate with Gemini Enterprise Agent Platform](https://docs.cloud.google.com/model-armor/model-armor-vertex-integration)
- [Integration with Google Cloud MCP servers](https://docs.cloud.google.com/model-armor/model-armor-mcp-google-cloud-integration)

---

## 18. Agent Security / Threat Detection / Compliance / Policy

### What it is
A unified pane in **Security Command Center** for the agent fleet:
- **Agent Anomaly Detection** — real-time suspicious behavior using statistical models + LLM-as-judge (e.g., agent suddenly calls a tool it never used before).
- **Agent Threat Detection** — flags reverse shells, malicious IPs, data exfil patterns originating from an agent.
- **Agent Security Dashboard** — fleet-wide visibility.
- **Agent Compliance / Policy** — declare policies (data residency, allowed tools, allowed models) and the platform enforces them via Gateway + Identity.

### Status
GA April 22, 2026.
[Source: Cloud Next ’26 wrap-up](https://cloud.google.com/blog/topics/google-cloud-next/google-cloud-next-2026-wrap-up)

---

# OPTIMIZE LAYER

## 19. Agent Evaluation (GA April 2026)

### What it is
A managed evaluation harness running both **deterministic metrics** (BLEU, ROUGE, exact-match) and **LLM-as-judge / multi-turn autoraters**. Trajectory scoring grades the entire tool-call sequence, not just final answer. Tracks live production traffic.

### When to use it
**Optimize pillar — Day 1.** Every ADK agent should ship with a golden-set eval before the phase that depends on it is "done" — this is canon in the social-seeding-v2 RULES.md and in Google's own guidance.

### Minimum working code (via Agents CLI)

```bash
agents-cli eval run                       # runs tests/eval/evalsets/*.json
agents-cli eval compare baseline current  # diff metrics between runs
```

### Doc URLs
- [Agent Evaluation in Agent Platform](https://docs.cloud.google.com/gemini-enterprise-agent-platform/optimize/evaluation)

---

## 20. Agent Observability (GA April 2026)

### What it is
**Visual tracing** of every agent step: tool call inputs/outputs, sub-agent delegation graph, token usage, latency per node, errors. Backed by Cloud Trace + a domain-specific UI. Enabled by default when deploying via Agents CLI or `reasoning_engines.AdkApp(enable_tracing=True)`.

### Doc URLs
- [Cloud Trace explorer](https://console.cloud.google.com/traces)
- [Agent Observability](https://docs.cloud.google.com/gemini-enterprise-agent-platform/optimize/observability)

---

## 21. Agent Optimizer (GA April 2026)

### What it is
Automatic post-hoc analyzer that **clusters real-world failures** from production traces and **suggests refined system instructions / tool descriptions / sub-agent prompts**. Closes the loop: production → cluster failures → propose fix → re-eval → ship.

### Doc URLs
- [Agent Optimizer](https://docs.cloud.google.com/gemini-enterprise-agent-platform/optimize/optimizer)

---

## 22. Agent Simulation (GA April 2026)

### What it is
**Synthetic user simulator** that drives your agent against virtualized tools with automated scoring. Stress-tests for edge cases pre-prod. Critical for compliance use cases ("what would happen if a user said X 1000 times?").

### Doc URLs
- [Agent Simulation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/optimize/simulation)

---

## 23. Agent Anomaly Detection (GA April 2026)

(Covered above under §18 Govern.) Statistical + LLM-as-judge detector for behavioral drift, abnormal tool use, time-of-day anomalies, sudden token bursts.

---

# VERTEX AI CORE (Still Relevant Under the Rebrand)

## 24. Vertex AI Pipelines (Kubeflow)
**GA.** Pipelines orchestrate ML lifecycle (data prep → train → eval → deploy). 2026 GA additions: **Private Service Connect interface (PSC-I) for ML pipeline runs**. Use when training/fine-tuning a custom model.
[Source: Vertex AI release notes](https://docs.cloud.google.com/vertex-ai/docs/release-notes)

## 25. Vertex AI Vector Search
**GA.** Approximate-NN vector index for RAG embeddings. Pricing is **node-hour** based (~$700–$800/month for a moderately-sized index on 3 replicas). **Hybrid search** (dense + sparse) is in **Public Preview**.
[Source: Vector Search pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)

## 26. Vertex AI Search (now Agent Search)
**GA.** Google-quality search for your data, plus out-of-the-box grounding. Powered by the **Discovery Engine API** (`discoveryengine.googleapis.com`). Default answer-gen model: `gemini-2.5-flash/answer_gen/v1`. New: **media recommendations apps** (videos, news, music).
Pricing: **$4 / 1k standard queries, $6 / 1k advanced queries**.
[Source: Agent Search overview](https://docs.cloud.google.com/generative-ai-app-builder/docs)

## 27. Vertex AI Conversation
Now folded into **Conversational Agents (Dialogflow CX)** for voice/IVR + **Agent Studio** for general conversational agents. Use only if you need IVR/phone gateway specifically.
[Source: Dialogflow CX release notes](https://docs.cloud.google.com/dialogflow/docs/release-notes)

## 28. Vertex AI Workbench
**GA.** Managed JupyterLab. 2026 additions: **Workforce Identity Federation** support, **reservations** for Compute Engine resources, **Confidential Computing** for data-in-use encryption.
[Source: Vertex AI Workbench release notes](https://docs.cloud.google.com/vertex-ai/docs/workbench/release-notes)

## 29. Vertex AI Reasoning Engine — *the same thing as Agent Runtime*
The REST resource (`reasoningEngines/*`) and the Python class (`reasoning_engines.AdkApp`) are unchanged. *Reasoning Engine = Agent Engine = Agent Runtime* — they are three names for the same service across the 2024→2025→2026 rebrand history. **Use "Agent Runtime" in 2026 docs.**

---

# SPECIALIZED AI SERVICES (Use When the Capability Is Domain-Specific)

| Service | When to use | Pricing snapshot |
|---|---|---|
| **Dialogflow CX / Conversational Agents** | Phone gateway, IVR, voice-first. `gemini-2.5-flash` now default; **phone gateway GA**, **Call companion GA**. | Per request + STT/TTS. [Docs](https://docs.cloud.google.com/dialogflow/docs/release-notes) |
| **Document AI** | OCR, form parsing, invoice/receipt/contract extraction. | $30 / 1k pages (prediction), $20 / 1k pages (Form Parser). [Pricing](https://cloud.google.com/document-ai/pricing) |
| **Vision AI** | Object detection, OCR-light, image classification. Often replaced by Gemini multimodal in 2026 agents. | Per-image. [Docs](https://cloud.google.com/vision) |
| **Speech-to-Text** | Audio transcription. | Per-minute. [Docs](https://cloud.google.com/speech-to-text) |
| **Text-to-Speech** | Voice synthesis for voice agents. | Per-character. [Docs](https://cloud.google.com/text-to-speech) |
| **Translation API** | Multi-language agents. | Per-character. [Docs](https://cloud.google.com/translate) |
| **Natural Language API** | Sentiment, entity, syntax — increasingly replaced by Gemini in agents. | Per-record. |
| **Recommendations AI** | Product-recommendation agents in e-commerce. | Per-prediction. |
| **Healthcare NLP** | HIPAA-compliant medical entity extraction. | Per-record. |
| **Gemini Code Assist** | Developer-IDE assistant (VS Code, JetBrains, Cloud Shell). Used **to build** agents. | Per-seat subscription. |
| **Gemini Cloud Assist** | Cloud-console assistant for ops/SRE. **To operate** agents (cost, logs, IAM). | Per-seat subscription. |

---

# CRITICAL SUB-TOPICS

## C1. Getting an ADK agent listed in Gemini Enterprise (Track 3 path)

This is **the** flow the AI Agents Challenge Track 3 is graded on.

**Prerequisites**
- IAM role: **Gemini Enterprise Admin** on the consuming project.
- **Discovery Engine API** enabled.
- An existing **Gemini Enterprise app** in the project.
- An **ADK agent deployed to Agent Runtime** (you have `reasoningEngines/RESOURCE_ID`).
- (If agent is cross-project) IAM grants on the agent resource for the Gemini Enterprise app's service agent.
- (If the agent needs OAuth-protected resources) an **Authorization** resource with the IdP's client_id, client_secret, auth_uri, token_uri.

**Step 1 — Deploy the ADK agent to Agent Runtime** (see §10 code sample). You get back a path:
```
projects/PROJECT_ID/locations/LOCATION/reasoningEngines/RESOURCE_ID
```

**Step 2 (optional) — Create an Authorization for any OAuth tools**

```bash
curl -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -H "X-Goog-User-Project: PROJECT_ID" \
  "https://us-discoveryengine.googleapis.com/v1alpha/projects/PROJECT_NUMBER/locations/us/authorizations?authorizationId=AUTH_ID" \
  -d '{
    "name": "projects/PROJECT_NUMBER/locations/us/authorizations/AUTH_ID",
    "serverSideOauth2": {
      "clientId": "OAUTH_CLIENT_ID",
      "clientSecret": "OAUTH_CLIENT_SECRET",
      "authorizationUri": "OAUTH_AUTH_URI",
      "tokenUri": "OAUTH_TOKEN_URI"
    }
  }'
```

**Step 3 — Register the ADK agent**

```bash
curl -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -H "X-Goog-User-Project: PROJECT_ID" \
  "https://us-discoveryengine.googleapis.com/v1alpha/projects/PROJECT_ID/locations/global/collections/default_collection/engines/APP_ID/assistants/default_assistant/agents" \
  -d '{
    "displayName": "Social Seeding Operator",
    "description": "Operates TikTok creator outreach campaigns from source → reply → ship.",
    "icon": {"uri": "gs://my-icons/agent.png"},
    "adkAgentDefinition": {
      "provisionedReasoningEngine": {
        "reasoningEngine": "projects/PROJECT_ID/locations/us-central1/reasoningEngines/RESOURCE_ID"
      }
    },
    "authorizationConfig": {
      "toolAuthorizations": [
        "projects/PROJECT_NUMBER/locations/global/authorizations/AUTH_ID"
      ]
    }
  }'
```

**Step 4 — Verify in the console**: `Gemini Enterprise → <app> → Agents → <your agent>` should appear. Test by `@`-mentioning the agent in the Gemini Enterprise app.

**Notes & gotchas**
- The Agent Platform location must match the Gemini Enterprise app's location (`us` apps → `us-*` agent regions; `eu` apps → `europe-*`; `global` works anywhere).
- The connection is **VPC Service Controls compliant**.
- **ADK agents receive the user's email from Gemini Enterprise** in the request context — use it for personalization.
- **Model Armor** must be configured *inside the agent code* (REST API), not in the registration JSON.
[Source: Register and manage an ADK agent](https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-adk-agent) · [Cross-project ADK agent access](https://docs.cloud.google.com/gemini/enterprise/docs/configure-cross-project-adk-agents)

---

## C2. Registering an agent in Agent Registry

Agent Registry sits **inside** the Agent Platform and is the source of truth that **Gemini Enterprise + Application Design Center + ADK coordinators** all read from. There are two registration flows:

1. **Auto-register from a supported runtime**: when you deploy via Agent Runtime, the agent is auto-listed in the registry of the same project.
2. **Manual register a custom ADK / A2A / MCP server**: use the [client libraries](https://docs.cloud.google.com/agent-registry/reference/libraries) or REST.

A custom ADK agent registered in Agent Registry can then be exposed (via the Step 3 call in C1) to a specific Gemini Enterprise app.
[Source: Agent Registry overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/govern/agent-registry)

---

## C3. Cloud Marketplace listing requirements for agents (Track 3 commercial path)

If the AI Agents Challenge submission is a **commercial agent** intended for partner-style distribution (vs. internal-only), the path is:

1. **Apply** to the [AI Agents Program](https://cloud.google.com/marketplace/sell).
2. Build an **A2A-compliant agent** (Agent Card JSON file in Cloud Storage, conforming to the [A2A Agent Card spec](https://a2a-protocol.org/latest/)).
3. The Agent Card must include: `protocolVersion`, `name`, `description`, `url`, `version`, `defaultInputModes`, `defaultOutputModes`, `capabilities`, `skills` (array of `{id, name, description}`).
4. In **Producer Portal**: add the listing, upload the Agent Card, fill product details, submit pricing (review ≤ 4 business days), integrate backend + frontend, submit for publication.
5. **Google operations validates** with a four-step evaluation: basic functionality → output accuracy → autonomous execution → enterprise standards. Pass → Google issues a `gcloud` command to make the listing public.
6. Approved agents carry the **"Google Cloud Ready – Gemini Enterprise"** designation in the Agent Gallery.

**Pricing models** available to publishers:
- Free (customer pays only GCP resources).
- Subscription (flat monthly, prorated).
- Usage-based (publisher-defined metric).
- Combined (subscription base + usage).

**Commercial reality (per Google)**:
- $750M partner fund for agentic development.
- Standardized contracts shortening sales cycles by up to 50%.
- Marketplace vendors close deals ~112% larger on average vs. direct.
[Source: Offer AI agents through Google Cloud Marketplace](https://docs.cloud.google.com/marketplace/docs/partners/ai-agents) · [Partner-built agents in Gemini Enterprise](https://cloud.google.com/blog/products/ai-machine-learning/partner-built-agents-available-in-gemini-enterprise)

---

## C4. Tools that ADK supports natively

ADK ships a **rich tool taxonomy** out of the box:

| Tool family | What it is | Import |
|---|---|---|
| **Function tools** | Any Python callable typed-annotated; ADK auto-generates the schema. | `from google.adk.tools import FunctionTool` |
| **Built-in tools** | `google_search`, `built_in_code_execution`, `vertex_ai_search`. | `from google.adk.tools import google_search` |
| **MCP tools** | Connect any MCP server (stdio or SSE) as a toolset. | `from google.adk.tools.mcp_tool import MCPToolset` |
| **OpenAPI tools** | Import an entire OpenAPI/Swagger spec as tools. | `from google.adk.tools.openapi_tool import OpenAPIToolset` |
| **Agent-as-Tool** | Wrap another agent (local or remote A2A) as a callable tool. | `from google.adk.tools.agent_tool import AgentTool` |
| **GCP-native tools** | Vertex AI Search, Vertex AI RAG Engine, BigQuery, Cloud Storage. | various |
| **LangChain / LlamaIndex tools** | Wrap existing third-party tools. | `LangChainTool`, `LlamaIndexTool` |

This is the same primitives table the production-ready guides + ADK docs converge on.
[Source: ADK tool integrations](https://adk.dev/integrations/)

---

## C5. Pricing model summary (May 2026, standard tier)

| Service | Unit | Price |
|---|---|---|
| **Gemini 3.1 Pro input** | per 1M tokens (≤200K) | $2.00 |
| **Gemini 3.1 Pro output** | per 1M tokens | $12.00 |
| **Gemini 2.5 Pro input / output** | per 1M tokens | $1.25 / $10.00 |
| **Gemini 2.5 Flash input / output** | per 1M tokens | $0.30 / $2.50 |
| **Gemini 2.5 Flash-Lite input / output** | per 1M tokens | $0.10 / $0.40 |
| **Cached input tokens** | per 1M | 10% of input price |
| **Priority tier multiplier** | — | 1.8× standard |
| **Flex / Batch tier multiplier** | — | 0.5× standard |
| **Agent Runtime compute** | vCPU-hour + GiB-hour | see [pricing page](https://cloud.google.com/vertex-ai/generative-ai/pricing) — idle waits are free |
| **Memory Bank** | per memory generated + retrieved | billing live since Jan 28, 2026 |
| **Sessions** | per session-event stored | billing live since Jan 28, 2026 |
| **Vector Search** | node-hour | ~$700–$800/month for moderate index |
| **Agent Search (Vertex AI Search)** | per 1k queries | $4 standard / $6 advanced |
| **Grounding with Google Search (Gemini 3)** | per 1k queries | $14 |
| **Grounding with Your Data** | per 1k requests | $2.50 |
| **Web Grounding for Enterprise** | per 1k prompts | $45 |
| **Document AI prediction** | per 1k pages | $30 |
| **Document AI Form Parser** | per 1k pages | $20 |
| **Model Armor** | per 1M tokens screened | 2M free, then $0.10 |
| **A2A protocol** | — | free (open protocol) |
| **AP2 protocol** | — | free (open protocol) |
| **A2UI protocol** | — | free (open protocol) |
| **ADK framework** | — | free (open-source) |
| **Agents CLI** | — | free (open-source) |

[Sources: Agent Platform pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) · [Model Armor pricing](https://cloud.google.com/security/products/model-armor) · [Document AI pricing](https://cloud.google.com/document-ai/pricing)

---

# REFERENCE ARCHITECTURE FOR THIS SUBMISSION

For an AI Agents Challenge Track 3 submission targeting Gemini Enterprise:

```
                  ┌─────────────────────────────────────────────────────┐
                  │            Gemini Enterprise (the surface)          │
                  │   Agent Gallery → @your-agent  ←  user types here   │
                  └──────────────────────┬──────────────────────────────┘
                                         │ A2A / ADK contract
                                         ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │   Agent Runtime (managed)                                           │
   │  ┌──────────────────────────────────────────────────────────────┐  │
   │  │  ADK root agent (LlmAgent + Gemini 3 Pro / 2.5 Pro)          │  │
   │  │     ├─ SequentialAgent / ParallelAgent / LoopAgent           │  │
   │  │     ├─ Sub-agents (specialists) via Agent-as-Tool / A2A      │  │
   │  │     ├─ Tools: function tools, MCP servers, OpenAPI specs     │  │
   │  │     ├─ Callbacks: before_model = Model Armor sanitize        │  │
   │  │     └─ Memory: VertexAiMemoryBankService                     │  │
   │  └──────────────────────────────────────────────────────────────┘  │
   │     Sessions (custom IDs) | Memory Bank | Code Execution           │
   │     Cloud Trace (always on)                                         │
   └────┬──────────────┬──────────────┬──────────────┬─────────────────┘
        │              │              │              │
        ▼              ▼              ▼              ▼
   Agent Gateway   Model Armor    Agent Identity  Agent Registry
   (route+policy)  (filter I/O)   (crypto ID)     (catalog)
        │
        ▼
   Agent Anomaly Det. → Security Command Center / Agent Security Dashboard
                                         │
                                         ▼
                          Agent Evaluation + Observability + Optimizer + Simulation
                                  (Optimize pillar feedback loop)
```

---

# QUICK-START COMMAND BUNDLE

Copy-paste sequence for a fresh project that ends with an ADK agent registered in Gemini Enterprise:

```bash
# 0. Prereqs (one-time)
gcloud config set project PROJECT_ID
gcloud services enable aiplatform.googleapis.com \
                       discoveryengine.googleapis.com \
                       modelarmor.googleapis.com \
                       run.googleapis.com
gcloud storage buckets create gs://PROJECT_ID-adk-staging --location=us-central1

# 1. ADK locally
pip install --upgrade google-adk "google-cloud-aiplatform[adk,agent_engines]"

# 2. Scaffold via Agents CLI
uvx google-agents-cli setup
agents-cli create my-agent --prototype --yes
cd my-agent && agents-cli install

# 3. (edit app/agent.py — define your LlmAgent + tools + sub-agents)
agents-cli run "hello"
agents-cli eval run

# 4. Deploy to Agent Runtime (managed)
agents-cli scaffold enhance --deployment-target agent_runtime
agents-cli deploy

# 5. Publish to Gemini Enterprise (auto)
agents-cli publish
# (Or do the curl flow in §C1 if you want fine-grained control.)
```

---

# FURTHER READING (Official Only)

- [Gemini Enterprise Agent Platform overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/overview)
- [Introducing Gemini Enterprise Agent Platform (blog, April 2026)](https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform)
- [Five guides to building and scaling production-ready AI agents](https://cloud.google.com/blog/topics/developers-practitioners/five-guides-to-building-and-scaling-production-ready-ai-agents)
- [Google Cloud Next ’26 wrap-up](https://cloud.google.com/blog/topics/google-cloud-next/google-cloud-next-2026-wrap-up)
- [adk.dev — Agent Development Kit](https://adk.dev/)
- [Agents CLI announcement](https://developers.googleblog.com/agents-cli-in-agent-platform-create-to-production-in-one-cli/)
- [Agents CLI on GitHub](https://github.com/google/agents-cli)
- [Register and manage ADK agents (Gemini Enterprise)](https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-adk-agent)
- [Register and manage A2A agents](https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent)
- [Register and manage A2UI agents](https://docs.cloud.google.com/gemini/enterprise/docs/a2ui-agents/register-and-manage-an-a2ui-agent)
- [Offer AI agents through Google Cloud Marketplace](https://docs.cloud.google.com/marketplace/docs/partners/ai-agents)
- [Agent Runtime overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview)
- [AdkApp Python class reference](https://docs.cloud.google.com/python/docs/reference/vertexai/latest/vertexai.agent_engines.AdkApp)
- [Quickstart: Develop with ADK on Agent Runtime](https://docs.cloud.google.com/agent-builder/agent-engine/quickstart-adk)
- [Memory Bank overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/memory-bank/overview)
- [Agent Registry](https://docs.cloud.google.com/gemini-enterprise-agent-platform/govern/agent-registry)
- [Model Armor overview](https://docs.cloud.google.com/model-armor/overview)
- [Model Armor integration with Agent Platform](https://docs.cloud.google.com/model-armor/model-armor-vertex-integration)
- [Model Armor for MCP](https://docs.cloud.google.com/model-armor/model-armor-mcp-google-cloud-integration)
- [GKE Agent Sandbox concepts](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox)
- [GKE Agent Sandbox how-to](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox)
- [A2A protocol upgrade (v0.3)](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)
- [Announcing AP2](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)
- [Introducing A2UI](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/)
- [Agent Platform pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- [Model Armor pricing](https://cloud.google.com/security/products/model-armor)
- [Document AI pricing](https://cloud.google.com/document-ai/pricing)
- [Partner-built agents in Gemini Enterprise](https://cloud.google.com/blog/products/ai-machine-learning/partner-built-agents-available-in-gemini-enterprise)
- [Dialogflow CX release notes](https://docs.cloud.google.com/dialogflow/docs/release-notes)
- [Vertex AI release notes](https://docs.cloud.google.com/vertex-ai/docs/release-notes)
- [Vertex AI Workbench release notes](https://docs.cloud.google.com/vertex-ai/docs/workbench/release-notes)

---

*End of AI-AGENTS.md. Maintainer's note: re-pull `release-notes` pages quarterly — the platform is in active GA rollout and field semantics (especially around Memory Bank pricing, A2UI version, and Model Armor preview→GA transitions for Agent Gateway/Runtime/LangChain) change month-by-month through 2026.*
