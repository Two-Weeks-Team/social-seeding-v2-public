# specs/_index.md — Spec-Driven Development Catalog

> **Authority**: D36 (SDD format = AsyncAPI 3.0 + OpenAPI 3.1 + JSON Schema + Mermaid).
> **Fleet inventory**: D23 (22 agents = 16 Tier-1 + 3 Tier-2 + 3 Tier-3).
> **ARCHITECTURE.md citation**: §3 (Per-agent service mapping).
> **Authored by**: background agent #3 of 13, 2026-05-19.

This directory is the **contract** for code generation. Every `.spec.md`
file carries **all four formats** required by D36 plus a Mermaid happy-path
diagram, tool list with USD cap, eval criteria, and edge-cases catalog.

---

## 1. Shared components (loaded by every spec)

| File | Format | Role |
|---|---|---|
| [`_common/shared.openapi.yaml`](_common/shared.openapi.yaml) | OpenAPI 3.1 | Common security schemes (Identity Platform JWT, Workforce IF, SPIFFE), parameters, error responses, AgentOutcome envelope |
| [`_common/shared.asyncapi.yaml`](_common/shared.asyncapi.yaml) | AsyncAPI 3.0 | Lifecycle channels (invoked/completed/escalated), cost telemetry, Model Armor signals, anomaly events |
| [`_common/shared.schema.json`](_common/shared.schema.json) | JSON Schema draft-2020-12 | `$defs` for TenantId, AgentId, ModelId, USDCost, Escalation, Outcome, etc. |

---

## 2. Tier 1 — Domain agents (16, per D23)

| # | Spec | Source agent in v2 | Default model | Tools | Cap |
|---|---|---|---|---|---|
| 1 | [`tier1/sourcing.spec.md`](tier1/sourcing.spec.md) | `packages/agents/src/sourcing.agent.ts` | Gemini 2.5 Pro | `rapidapi.tiktok_search`, `rapidapi.instagram_search`, `blacklist.check`, `vector_search.creator` | $2.50 |
| 2 | [`tier1/vetting.spec.md`](tier1/vetting.spec.md) | `packages/agents/src/vetting.agent.ts` | Gemini 2.5 Pro (parallel) | `rapidapi.get_user_info`, `ranking.score`, `vector_search.brand_fit` | $0.10/cand |
| 3 | [`tier1/outreach_writer.spec.md`](tier1/outreach_writer.spec.md) | `packages/agents/src/outreach-writer.agent.ts` | Gemini 2.5 Pro tournament | `templates.list`, `outreach.extract_facts`, `outreach.render`, `outreach.judge` | $1.50 |
| 4 | [`tier1/conversation.spec.md`](tier1/conversation.spec.md) | `packages/agents/src/conversation.agent.ts` | Gemini 2.5 Flash-Lite | (none — pure NLP) | $0.02 |
| 5 | [`tier1/conversation_responder.spec.md`](tier1/conversation_responder.spec.md) | `packages/agents/src/conversation-responder.agent.ts` | Gemini 2.5 Pro | `templates.list`, `outreach.render`, `outreach.judge` | $1.00 |
| 6 | [`tier1/logistics.spec.md`](tier1/logistics.spec.md) | `packages/agents/src/logistics.agent.ts` | Gemini 2.5 Flash | `address.normalize`, `carrier.create` | $0.05 |
| 7 | [`tier1/content_verify.spec.md`](tier1/content_verify.spec.md) | `packages/agents/src/content-verify.agent.ts` | Gemini 2.5 Flash multimodal | `rapidapi.post_detail`, `vision.brand_logo_detect` | $0.05 |
| 8 | [`tier1/analyst.spec.md`](tier1/analyst.spec.md) | `packages/agents/src/analyst.agent.ts` | Gemini 2.5 Pro | `bigquery.query`, `view_metrics.aggregate` | $0.20 |
| 9 | [`tier1/research.spec.md`](tier1/research.spec.md) | `packages/agents/src/research.agent.ts` | Gemini 2.5 Pro | `web.search` (Google grounding), `vector_search.competitor` | $0.30 |
| 10 | [`tier1/intake.spec.md`](tier1/intake.spec.md) | `packages/agents/src/intake.agent.ts` | Gemini 2.5 Flash | `forms.upsert` | $0.20 |
| 11 | [`tier1/lead_outreach_writer.spec.md`](tier1/lead_outreach_writer.spec.md) | `packages/agents/src/lead-outreach-writer.agent.ts` | Gemini 2.5 Pro | `templates.list`, `outreach.render`, `crm.enrich`, `outreach.judge` | $1.20 |
| 12 | [`tier1/payment_mandate.spec.md`](tier1/payment_mandate.spec.md) | NEW (D23) | Gemini 2.5 Flash | `ap2.compose_intent_mandate`, `gate.approveOutreachSend` | $0.10 |
| 13 | [`tier1/compliance.spec.md`](tier1/compliance.spec.md) | NEW (D23) | Gemini 2.5 Pro | `pipa.check_consent`, `canspam.check_unsubscribe`, `dlp.inspect` | $0.15 |
| 14 | [`tier1/creative.spec.md`](tier1/creative.spec.md) | NEW (D23) | Gemini 2.5 Pro + Imagen 4 + Veo 3 | `imagen.generate`, `veo.generate`, `lyria.generate`, `assets.upload` | $3.00 |
| 15 | [`tier1/a11y.spec.md`](tier1/a11y.spec.md) | NEW (D23) | Gemini 2.5 Flash | `vision.describe`, `stt.transcribe`, `tts.synthesize`, `translation.translate` | $0.20 |
| 16 | [`tier1/customer_success.spec.md`](tier1/customer_success.spec.md) | NEW (D23) | Gemini 2.5 Pro | `analytics.funnel`, `intervention.propose` | $0.50 |

---

## 3. Tier 2 — Meta agents (3, per D23)

| # | Spec | Role |
|---|---|---|
| M1 | [`tier2/coordinator.spec.md`](tier2/coordinator.spec.md) | Route a task to the right Tier-1 agent (or A2A remote agent) |
| M2 | [`tier2/critic.spec.md`](tier2/critic.spec.md) | LLM-as-judge across Tier-1 outputs; gates the human approval stream |
| M3 | [`tier2/optimizer.spec.md`](tier2/optimizer.spec.md) | Periodically rewrite prompts + adjust tool budgets via Agent Optimizer |

---

## 4. Tier 3 — Watchdog agents (3, per D23)

| # | Spec | Role |
|---|---|---|
| W1 | [`tier3/anomaly_watch.spec.md`](tier3/anomaly_watch.spec.md) | Monitor token/cost/latency anomalies; trigger auto-runbook |
| W2 | [`tier3/cost_watch.spec.md`](tier3/cost_watch.spec.md) | Per-tenant USD/day ceiling; emit Pub/Sub alert at 50/75/90/95% |
| W3 | [`tier3/security_watch.spec.md`](tier3/security_watch.spec.md) | Watch Model Armor blocks + Chronicle alerts; quarantine on threshold |

---

## 5. Format conventions (per D36)

Every `*.spec.md` contains:

1. **Purpose + ARCHITECTURE.md citation** — 2-3 sentences naming the D-ID and §3 row.
2. **JSON Schema (input/output)** — Draft 2020-12, `$ref` into `_common/shared.schema.json`.
3. **OpenAPI 3.1** — REST surface for the orchestrator → agent invocation,
   `$ref` into `_common/shared.openapi.yaml`.
4. **AsyncAPI 3.0** — Pub/Sub channels (publishes / consumes), `$ref` into
   `_common/shared.asyncapi.yaml`.
5. **Mermaid sequence diagram** — end-to-end happy path.
6. **Tool list + USD cap + escalation conditions** — per ARCHITECTURE.md §3
   plus a Pydantic / typia example.
7. **Eval criteria** — Vertex AI Agent Evaluation metric names, thresholds,
   golden-set link.
8. **Edge cases** — 3-7 most likely failure modes.

---

## 6. Status

- Tier 1: 16/16 specs authored.
- Tier 2: 3/3 specs authored.
- Tier 3: 3/3 specs authored.
- Common: 3/3 (OpenAPI / AsyncAPI / JSON Schema).

Next consumer: backend-architect (Task #25 — code generation) + quality-engineer (Task #26 — test matrix).
