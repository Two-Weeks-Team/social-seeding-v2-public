# Devpost gallery — image ↔ Track-3 mandate map

> Why each image is in the gallery, mapped to the **official Track-3 architectural mandates** and the Designed-Guide emphasis. Devpost allows up to 10 images; we ship **7** (4 product surfaces + 3 mandate-proof additions). Upload order is the operator's call; the mandate coverage below is the rationale.

## Official Track-3 mandates / emphasis (from the Rules + Designed Guide)
- **B2B Focus** — the agent solves a clear B2B problem.
- **Cloud-Native Runtime** — runtime migrated natively to Google Cloud (Cloud Run / GKE) + **deployment on Agent Engine**.
- **Google Cloud Powered Intelligence** — reasoning on Gemini (3.5/3.1), exclusively via Agent Platform.
- **A2A Interoperability** — communication layer uses A2A so the agent is discoverable by / coordinates with other enterprise agents.
- **Multi-agent orchestration (ADK)** — collaboration between specialized agents > a single agent.
- **Agent Observability** — *"visually trace the agent's complex reasoning to debug stalled logic"* (Designed Guide, Optimize track).
- **Agent Simulation / Optimizer** — synthetic edge-case testing + programmatic instruction refinement (Optimize track).

## Coverage map (7 images)

| # | Image | Mandate(s) it proves | What it shows |
|---|---|---|---|
| 1 | `mission-control-campaigns.png` | B2B · Multi-agent orchestration | Mission Control — multi-tenant B2B campaign surface, the 22-agent fleet at work |
| 2 | `approval-gate-decision.png` | (governance / safe action) | Human-in-the-loop policy gate — the agent pauses for the operator before an external action |
| 3 | `content-verification-grid.png` | Multimodal · A2A (Build Example #2 / DAM) | `content_verify` Gemini 3.1 multimodal verdict grid (on-brand / compliant) |
| 4 | `performance-leaderboard.png` | B2B value / outcome | Per-creator delivered-view performance + ROI outcome |
| **5** | **`a2a-live-crosscall.png`** ⭐ NEW | **A2A Interoperability** (mandate) | Live `coordinator → a2a_invoke → ss-mcp` cross-call, `task/completed` **318 ms**, 5 ranked creators, against the live Cloud Run endpoint |
| **6** | **`agent-observability-stall-repair.png`** ⭐ NEW | **Agent Observability** + Simulation/Optimizer | The stall→repair **reasoning trace** (BEFORE auto-respond/STALL vs AFTER escalate/REPAIRED) + measured before/after (40.5%→100% train / 71.4% holdout), honest-scope caption |
| **7** | **`cloud-native-runtime.png`** ⭐ NEW | **Cloud-Native Runtime** + Agent Engine + Gemini-only | All live runtime surfaces on Cloud Run + the managed **Agent Runtime** `reasoningEngine 2498…`, region us-central1, Gemini 3.5/3.1 on Vertex `global`, verified 200 |

## Why the 3 additions
The original 4 covered *what the product does* (B2B · multi-agent · HITL · multimodal · outcome) but did **not visually prove three mandate-load-bearing items** the rules call out explicitly: **A2A interoperability**, **Agent Observability (reasoning trace)**, and **Cloud-Native Runtime / Agent Engine deployment**. Images 5–7 close exactly those gaps, 1:1 with the mandates. (The written submission + `HONEST-SCOPE.md` already cover all four required mandates in text; this makes the **gallery** visually complete.)

## Honesty notes (carried in-image / HONEST-SCOPE)
- #6: the before/after is a **local deterministic** optimization pass (re-runnable via `run-hardening-measure.sh`); the OTel span shape (D32) is real, live Cloud Trace export is the production path. Holdout 71.4% (28.6pp gap) shown, not tuned away.
- #5: 318 ms is the **direct A2A hop** measured 2026-05-19; the in-workflow execution (`7c08ce50`) is ~15.8s.
- #7: every figure is verified live (HTTP 200, agent.json 0.3.0, region us-central1); ss-mcp is warm (min=1), the rest scale-to-zero.
