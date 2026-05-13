# Social Seeding v2 — agent-orchestrated TikTok influencer campaign operator

> Rewrite of [`Two-Weeks-Team/social-seeding`](https://github.com/Two-Weeks-Team/social-seeding) (v1, frozen 2026-05-13 — see that repo's `FREEZE.md`).
>
> **The shift:** v1 was a *tool dashboard* — the human was the operator, clicking through a 6-step workflow board, hand-writing emails, manually advancing stages, with an AI chat bolted on as a read-only "ask my data" sidebar. v2 makes **the agent the operator**: you give it a campaign brief, a team of specialized agents runs the loop (source → vet → outreach → reply-handling → ship → verify content → report), and you only step in at the decision gates you choose to keep on. The dashboard becomes **Mission Control** — a timeline of what the agents did + an approval inbox — not a manual-labor surface.

---

## Why a new repo (not a renewal)

v1 accumulated 3 years of strata — multi-SNS→TikTok, Express→Go→Next.js, Polar→NicePay, 4-phase workspace ACL, 5-phase rate limit, i18n pipeline — 266+ API routes, ~100 lib files, migration flags, dual-key helpers, a half-built `workflow-automation.ts` with no durable engine under it, and a Go/LangGraph backend being re-absorbed into Next.js. The *product model itself* ("human = operator") is what needs to change, so we start clean — but **carry the hard-won domain assets** (TikTok ranking algos, the `cold-mail` agent pipeline, Gmail integration, CRM enrichment, billing). See [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) for the v1→v2 mapping.

## Key decisions (2026-05-13)

| Decision | Choice | Rationale |
|---|---|---|
| Orchestration engine | **Inngest** | Serverless/Vercel-friendly durable execution: `step.run` (atomic + retried), `step.sleep` (durable timers — "follow up in 3 days"), `step.waitForEvent` (block on a human approval or a Gmail reply without holding a process). State survives deploys. Can graduate to Temporal later with no workflow-code changes. |
| Autonomy | **Staged** | Ships with every gate ON (`checkpointed`). Owners relax gates one at a time, per workspace, as trust accumulates → `autonomous`. Gates & budgets live in [`packages/contracts/src/policy.ts`](packages/contracts/src/policy.ts). |
| Database | **Same MongoDB Atlas cluster as v1** | Creator data, campaign history, CRM, blacklist, Gmail tokens carry over with zero migration. v2 reads v1-owned collections (`accounts_tiktok`, `blacklist`, …) and owns new `v2_*` collections. v1 must not make breaking schema changes while both run. |
| Agents | **Claude Agent SDK** | Agents are *functions the workflow invokes* (curated tool set, structured output, budget cap, escalation) — not free ReAct loops. This generalizes v1's `cold-mail` evaluator-optimizer + tournament/judges pattern, which is already the right shape. Model routing: Opus 4.7 for judgment, Haiku 4.5 for bulk classification. |

## Repo layout (Turborepo + pnpm workspaces)

```
apps/
  web/                 Next.js 16 — Mission Control UI + thin public API + webhook receivers + /api/inngest serve
packages/
  contracts/           Zod schemas — the single source of truth for shapes crossing a boundary
  db/                  MongoDB client + repositories (shared v1 collections + new v2_* collections)
  capabilities/        the platform's typed functions (registry); HTTP API and agents both call this — replaces v1's 266-route sprawl
  agents/              agent definitions on the Claude Agent SDK + the runAgent runtime (budget, tracing, escalation)
  workflows/           Inngest function definitions — brand-campaign (the 6-stage product), creator-track (per-creator child), scheduled jobs
  observability/       per-run trace recorder + token/cost ledger + (Phase 1+) eval harness
  config/              shared tsconfig + eslint preset
docs/                  ARCHITECTURE / CAPABILITIES / AGENTS / ROADMAP / PHASE-1-PLAN
```

## Getting started (skeleton state)

```bash
pnpm install
cp .env.example .env.local            # fill MONGODB_URI (shared Atlas), AUTH_*, ANTHROPIC_API_KEY, INNGEST_*
pnpm run verify-build                  # lint → next build (9 routes) → tsc --noEmit (7/7 packages) — green
pnpm --filter @ss/web dev              # Next.js on :3000
npx inngest-cli@latest dev             # Inngest Dev Server — discovers apps/web/app/api/inngest
```

> The skeleton compiles structurally but most handlers `throw "not implemented — see docs/PHASE-1-PLAN.md task X"`. That's deliberate: the contracts, layering and workflow graph are designed; the flesh goes on slice by slice (Phase 1 = sourcing+vetting end-to-end, Phase 2 = outreach+replies, …). See [`docs/ROADMAP.md`](docs/ROADMAP.md).

**Continuing the build** (e.g. handing off to a Claude Code session with `/goal`): start at [`HANDOFF.md`](HANDOFF.md) — current state, what's next, setup, ready-to-paste `/goal` conditions, conventions.

## Read next

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the 6-layer architecture, the orchestrator↔agent split, the human-checkpoint model.
2. [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) — every v1 feature mapped to a v2 capability/agent (the migration inventory).
3. [`docs/AGENTS.md`](docs/AGENTS.md) — the agent roster, tool sets, output contracts, escalation rules.
4. [`docs/ROADMAP.md`](docs/ROADMAP.md) — Phases 0–6, what ships when.
5. [`docs/PHASE-1-PLAN.md`](docs/PHASE-1-PLAN.md) — the concrete task list for Phase 0 (foundation) + Phase 1 (sourcing+vetting slice).
