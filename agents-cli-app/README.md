# ss-agents-acli — Social Seeding campaign orchestrator (Google Agents CLI)

A [Google Agents CLI](https://cloud.google.com/) (`agents-cli`) project that wraps
**Social Seeding v2's real agent fleet** so the standard `agents-cli`
`playground` / `eval` / `deploy` lifecycle works against our production
capabilities. Built for the Google AI Agents Challenge submission.

> Status: **Preview.** `agents-cli` is a preview tool; commands and flags may
> change. The grounding shown below is **real** — `research_brand` grounds against
> the live web via Gemini Google Search grounding, not a chat completion.

## What it is

`app/agent.py` defines a single `root_agent` — a **campaign orchestrator** that
drives Social Seeding's core loop: **source → vet → outreach → verify**. It is
NOT a reimplementation; it imports the production capability functions from
`../packages/agents-adk/src/ss_agents` and exposes them to ADK behind
auto-function-calling-friendly `str -> str` wrappers.

| Tool | Backed by | Purpose |
|---|---|---|
| `research_brand(query)` | `ss_agents.tools.web_search.web_search` | **Real Google Search grounding** (the headline "not just chat completion" feature): brand/market/trend/competitor research that returns the cited source URLs lifted from Gemini grounding metadata (D53). |
| `search_creators(brand_brief)` | `ss_agents.tools.a2a_invoke` → live ss-mcp `plan_creator_search` (A2A v0.3, D45), with `ss_agents.tools.rapidapi_tiktok_search` fallback | Ranked TikTok creator sourcing from the real pipeline. |

> **Why not the ADK built-in `google_search` tool too?** Mixing a built-in
> grounding tool with custom function tools in one agent disables automatic
> function calling and makes the model emit opaque grounding-chunk markers
> (`[1.1.1]`) that carry no citable URL. `research_brand` performs the *same*
> Google Search grounding under the hood (via `web.search`) but returns explicit
> `Source: <url>` lines the model cites verbatim — measurably better grounding
> (it took the eval rubric's `grounded` score from 0/4 → 4/4).

### Model policy

- **Gemini 3.x only.** `gemini-3.5-flash` for orchestration/judgment and as the
  eval rubric LLM-judge.
- Served on the Vertex **`global`** endpoint (Gemini 3.x lives on `global`).
- **No** Gemini 2.5, **no** Claude, **no** `*-pro`.

### How `ss_agents` is reused

`pyproject.toml` declares an **editable path dependency**
(`ss-agents-adk @ file://../packages/agents-adk`, `[tool.uv.sources]` `editable = true`),
so edits to the real package are picked up live and we never fork the logic.
`app/agent.py` also has a `sys.path` fallback to `../packages/agents-adk/src` so a
bare `python -c "import app.agent"` works before an install.

## Run it

```bash
cd agents-cli-app
agents-cli install                 # resolves deps incl. the editable ss-agents-adk path dep
agents-cli playground              # interactive UI against root_agent (needs ADC + Vertex)
agents-cli eval run                # runs tests/eval/evalsets/*.evalset.json vs eval_config.json
agents-cli deploy                  # deploys to Cloud Run (deployment_target in the manifest)
agents-cli publish gemini-enterprise   # operator/allowlist-gated publish surface
```

For real (not stub) grounding + creator sourcing, set:

```bash
export CAPABILITY_LAYER_MODE=live   # web_search → Google Search grounding; a2a_invoke → live ss-mcp
# optional: override the A2A target
export SS_MCP_ENDPOINT="https://ss-mcp-server-1049119860518.us-central1.run.app"
```

`CAPABILITY_LAYER_MODE` defaults to `stub` so dev/CI/playground smoke runs stay
offline and deterministic.

## Test offline

```bash
cd agents-cli-app
uv run --extra dev pytest tests/unit -q     # network-free; ss_agents calls are mocked
```

## Layout

```
agents-cli-app/
├── agents-cli-manifest.yaml          # acli schema (adk template, cloud_run target, region us-central1)
├── pyproject.toml                    # editable path dep on ../packages/agents-adk
├── CLAUDE.md                         # agent guidance (referenced by the manifest)
├── README.md
├── app/
│   ├── __init__.py
│   └── agent.py                      # root_agent + App(root_agent=..., name="app")
└── tests/
    ├── eval/
    │   ├── eval_config.json          # gemini-3.5-flash rubric LLM-judge (relevance + grounded)
    │   └── evalsets/
    │       └── campaign.evalset.json # 4 grounded-sourcing cases
    ├── unit/
    │   └── test_root_agent.py        # offline: model + tools + delegation
    └── integration/
```

## Citations (DECISIONS.md)

- **D41** — capability-layer ADK FunctionTool stub/live pattern (the wrapped tools).
- **D45** — coordinator → `a2a_invoke` → ss-mcp-server `plan_creator_search`.
- **D47** — Google AI Agents Challenge submission surface.
- **D53** — Google Search grounding via `gemini-3.5-flash` on the Vertex `global` endpoint.
