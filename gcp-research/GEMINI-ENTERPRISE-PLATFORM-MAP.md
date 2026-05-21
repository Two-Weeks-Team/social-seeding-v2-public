# Gemini Enterprise Agent Platform — what Social Seeding v2 USES vs DOESN'T

> Mapped 1:1 against the official **Gemini Enterprise Agent Platform** capability grid
> (Build · Scale · Govern · Optimize). Honest live status as of 2026-05-21.
>
> **Legend**
> - ✅ **USE — live-proven** (real, demonstrated this build; re-runnable proof exists)
> - 🟢 **USE — wired** (real code, env-gated; offline-tested; live = operator ADC step)
> - 🟡 **PARTIAL** (our own in-code equivalent; the *managed* platform product not adopted)
> - ⚪ **DON'T USE** (deliberately out of scope — reason given)
> - 🔴 **WANT but Google-gated** (Preview / allowlist not granted to our project)

---

## BUILD

### Agent frameworks
| Component | Status | Where / why |
|---|---|---|
| **Agent Development Kit (ADK)** `New` | ✅ USE | `packages/agents-adk` — 22-agent fleet on `google-adk` 1.x; `run_agent` typed runtime. Core of the build. |
| 3P Agent Framework | ⚪ DON'T | We standardize on ADK (no LangChain/CrewAI). |
| Agent Studio | ⚪ DON'T | Code-first. Dev UI need is met by `adk web` / `agents-cli playground`, not the visual Studio. |
| Agent Garden | 🟡 PARTIAL | ADK sample patterns informed our agents; no Garden agent imported as-is. |

### Gemini API and Model Garden
| Component | Status | Where / why |
|---|---|---|
| **Gemini Models** | ✅ USE | `gemini-3.5-flash` (judgment+coordinator) + `gemini-3.1-flash-lite` (bulk). D53. |
| 3P and Open Models | ⚪ DON'T | Gemini-only mandate (no Claude/Llama/Gemma). |
| **Model Inference** | ✅ USE | Vertex `generateContent` on the **global** endpoint (3.x). Proven live (exec 7c08ce50). |
| Managed Training | ⚪ DON'T | No SFT/model training. (Prompt improvement is via Prompt Optimizer, not training.) |
| **Model Garden (routing)** | ✅ USE | D47 — `publishers/google/models/...` publisher-path routing; live smoke exit 0. |

### Tools, data, and other agents
| Component | Status | Where / why |
|---|---|---|
| **A2A** | ✅ USE | A2A v0.3 — coordinator→ss-mcp `plan_creator_search` (live, 5 creators) + content_verify→DAM `get_brand_assets`; signed agent card (JWS ES256) + JWKS. |
| **Grounding** | ✅ USE | `web.search` → real Google Search grounding (`gemini-3.5-flash` + `GoogleSearch` tool, `grounding_metadata` citations). Proven live (5 sources). |
| RAG | 🟡 PARTIAL | Memory Bank handles recall; a dedicated Vector-Search RAG (D16) is **not live**. |
| **MCP** | ✅ USE | `ss-mcp-server` is MCP-spec-compliant (4 tiktok tools) + A2A node. |
| **Search** | ✅ USE | Google Search grounding (above) + TikTok creator search via the scraper fleet (RapidAPI). |
| **APIs and Connectors** | ✅ USE | Capability layer: RapidAPI scrapers, Gmail send, etc. (D41 stub/live FunctionTools). |
| A2UI | ⚪ DON'T | Agent-UI protocol not used; demo UI is custom HTML / `adk web`. |
| **AP2 and UCP** | 🟢 USE (partial) | **AP2 v0.2 Intent Mandate only** (D27 — agent plans, human approves); Cart/Payment Mandate + UCP deferred. |
| Cloud Marketplace | 🔴 / ⚪ | KR is excluded from the Marketplace payment region (D2). **Innovation = A2A-only distribution INSTEAD** (D3). Deliberately not used. |

---

## SCALE (all GA on the platform)
| Component | Status | Where / why |
|---|---|---|
| Agent Runtime | 🟡 PARTIAL → 🔴 | We run on **Cloud Run** (serve.py + ss-agents, live). The *managed* **Vertex AI Agent Runtime / Agent Engine** is the D17 target — `adk deploy agent_engine` / `agents-cli deploy` path; **not live** (access TBD, same allowlist family as 3.x-pro). |
| Agent Sessions | 🟡 PARTIAL | ADK in-process sessions per invocation; managed Agent Sessions not adopted. |
| Agent Sandbox | ⚪ DON'T | Code-execution sandbox not used (no code-exec agent in scope). |
| **Agent Memory Bank** | 🟢 USE | Managed Vertex Memory Bank backend wired (`MEMORY_BACKEND=vertex`); Firestore is the default. |

---

## GOVERN
| Component | Status | Where / why |
|---|---|---|
| Agent Gateway `New` | 🔴 WANT-gated | mTLS **declared-not-enforced** on the demo; Agent Gateway is **Private Preview** (O7). Disclosed, not faked. |
| **Agent Identity** `GA` | ✅ USE | SPIFFE crypto ID `spiffe://ss-mcp-prod.svc.id.goog/ns/agents/sa/tiktok-mcp-runner` on the signed agent card. |
| Agent Registry `New` | 🟡 PARTIAL | `agent_registry_list` capability + `agent.json` discovery; the *managed* Agent Registry not adopted. |
| Agent Anomaly Detection `New` | 🟡 PARTIAL | `anomaly_watch` Tier-3 watchdog agent; managed product not used. |
| **Model Armor** | 🟢 USE | Real GA `sanitizeUserPrompt`/`sanitizeModelResponse` integration on the A2A path (`MODEL_ARMOR_MODE=live`); D21. |
| Agent Policy | 🟡 PARTIAL | Workspace policy gates (budget/SLA/allow-list) in code; managed Agent Policy not used. |
| Agent Security `New` | 🟡 PARTIAL | `security_watch` agent + SSRF allowlist + prompt_guard; managed product not used. |
| Agent Compliance | 🟡 PARTIAL | PIPA framing (D22) in code; managed Agent Compliance not used. |

---

## OPTIMIZE (all New on the platform)
| Component | Status | Where / why |
|---|---|---|
| **Agent Evaluation** `New` | 🟢 USE | Golden-set runner + adversarial **holdout** (train 100% / holdout 71.4%). Adopting GA `adk eval` / `agents-cli eval` is the in-progress upgrade. |
| **Agent Simulation** `New` | 🟢 USE | 56-case synthetic edge-case simulation (the hardening "stall→repair"). Native Agent Simulation = the GA upgrade path. |
| **Agent Observability** `New` | 🟢 USE | OTel `agent:<id>` spans → Cloud Trace (`SS_OTEL_ENABLED=true`, wired into `run_agent`). |
| Agent Optimizer `New` | 🟢 USE (wired) | Local deterministic optimize pass for the before/after; **Vertex Prompt Optimizer (VAPO)** wired as the production path (operator-gated). |

---

## Scorecard
- **✅ live-proven (8)**: ADK, Gemini Models, Model Inference, Model Garden routing, A2A, Grounding, MCP, Agent Identity.
- **🟢 wired/env-gated (8)**: APIs+Connectors, AP2(Intent), Memory Bank, Model Armor, Agent Evaluation, Agent Simulation, Agent Observability, Agent Optimizer.
- **🟡 our-own-equivalent, managed-not-adopted (8)**: Agent Garden, RAG, Agent Runtime(Cloud Run vs managed), Agent Sessions, Agent Registry, Agent Anomaly Detection, Agent Policy, Agent Security, Agent Compliance.
- **⚪ deliberately out of scope (6)**: 3P Framework, Agent Studio, 3P/Open Models, Managed Training, Agent Sandbox, A2UI, Cloud Marketplace.
- **🔴 want-but-Google-gated (2)**: Agent Gateway (mTLS, Private Preview), managed Agent Runtime/Agent Engine (access TBD). Plus `gemini-*-pro` (404).

## Where `agents-cli` fits — ADOPTED (trialed live)
`google/agents-cli` (Preview, v0.2.0) is the lifecycle DX wrapper over ADK that operationalizes the
**Optimize** column (Agent Evaluation/Simulation/Observability/Optimizer) + **deploy** to Agent
Runtime/Cloud Run/GKE + **publish gemini-enterprise**.

**Integrated** as `agents-cli-app/` — a real agents-cli project (`agents-cli-manifest.yaml`,
`app/agent.py` `root_agent`) that **wraps the real `ss_agents` fleet** (imported, not forked): a
Social Seeding campaign-orchestrator `Agent` on **`gemini-3.5-flash`** (global) with `research_brand`
(→ our `web.search` **real Google Search grounding**, returns citable `Source: <url>` lines) +
`search_creators` (→ live ss-mcp A2A `plan_creator_search`, RapidAPI fallback). We deliberately do
**not** attach the ADK built-in `google_search` tool at the orchestrator level — mixing a built-in
grounding tool with function tools disables AFC and yields uncitable grounding-chunk markers;
`research_brand` runs the same Google Search grounding under the hood but returns explicit URLs.

**Trialed live (2026-05-21):**
- `agents-cli install` → `uv sync` OK (reuses `ss-agents-adk` via editable path source).
- `agents-cli eval run --all` → runs end-to-end on **gemini-3.5-flash** (Vertex `global`) with the GA **rubric judge** (relevance + grounded, threshold 0.7). First run scored **1/4** because the model emitted opaque `[1.1.1]` citation markers without surfacing the real source URLs (grounded = 0/4). After hardening the orchestrator (mandatory grounding calls, cite the real `Source:` URLs inline + in a "Sources" section, report only tool-returned facts/creators — no fabrication), it scores **4/4** (relevance 1.0 + grounded 1.0 on every case, confirmed on two consecutive runs).
- 8/8 offline unit tests pass (`tests/unit`, ss_agents mocked).

**Next (operator):** `agents-cli playground` (live UI demo), `agents-cli deploy` (cloud_run target in the manifest), `agents-cli publish gemini-enterprise` (O7 allowlist). Maps directly onto the **Optimize** + **Scale** (Agent Runtime) columns above.
