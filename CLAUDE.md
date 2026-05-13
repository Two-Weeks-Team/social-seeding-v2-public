# CLAUDE.md — social-seeding-v2

Agent-orchestrated TikTok influencer campaign operator. Rewrite of v1 (`~/social-seeding`, frozen — **reference only**, port named assets, don't reinvent; see its `FREEZE.md`).

## Continuing the build? Read these first (in order)

1. `HANDOFF.md` — current state, what's next, setup, ready-to-paste `/goal` conditions, conventions. **Start here.**
2. `README.md` — the reframe + layout + key decisions.
3. `docs/ARCHITECTURE.md` — the 6 layers, orchestrator↔agent split, human-checkpoint model.
4. `docs/CAPABILITIES.md` — every v1 feature → its v2 home.
5. `docs/PHASE-1-PLAN.md` — **the task list with DoDs**. Task IDs (`P0-1…P0-8`, `S2`, `V1`, `R1`, `V3`, `A-*`, `WF1-3`, `W1-5`) are what the scaffold's `throw "not implemented — see docs/PHASE-1-PLAN.md task X"` messages reference.
6. `docs/ROADMAP.md` — Phases 0–6.

## Current state

- Phase 0 / P0-1 done. **`pnpm run verify-build` is green** (eslint → `next build` 9 routes → `tsc --noEmit` 7/7 packages). Keep it green; never push red.
- Everything else is **scaffold**: handlers `throw`. Contracts (Zod schemas), layering, capability registry, agent definitions, the Inngest workflow graph are designed; flesh goes on slice by slice.
- Next: Phase 0 P0-2…P0-8 (see `docs/PHASE-1-PLAN.md`), then Phase 1 (sourcing+vetting slice).

## Commands

```bash
pnpm install
cp .env.example .env.local            # MONGODB_URI (shared Atlas), AUTH_*, ANTHROPIC_API_KEY, GOOGLE_*, INNGEST_*
pnpm run verify-build                  # lint → next build → tsc --noEmit  (must stay green)
pnpm --filter @ss/web dev              # Next.js :3000  (serves /api/inngest)
npx inngest-cli@latest dev             # Inngest Dev Server
pnpm --filter @ss/agents test          # vitest (agent tests / evals)
```

## Architecture (one screen)

```
Mission Control (apps/web, Next 16)  ⇄  Inngest workflows (packages/workflows: brand-campaign + creator-track)
   ⇄  agents (packages/agents, Claude Agent SDK — agents are FUNCTIONS the workflow invokes: curated tool set,
       Zod output contract, USD cap, escalation; NOT free ReAct loops — generalize v1 lib/cold-mail)
   ⇄  capabilities (packages/capabilities — typed fns, the ONLY place HTTP+agents touch I/O; replaces v1's 266 routes)
   ⇄  Mongo (packages/db — shared v1 Atlas collections `accounts_tiktok` etc. + new `v2_*` collections)
   + observability (packages/observability — per-run trace, cost ledger) + contracts (packages/contracts — Zod, the
     single source of truth for shapes crossing a boundary)
```

Repo is a **JIT internal-package monorepo**: each `packages/*` `exports` points at `src/` (no build step, no project references); `apps/web` transpiles them via `transpilePackages`. `tsconfig.base.json` = ESNext/Bundler/noEmit/verbatimModuleSyntax/strict. Root `eslint.config.mjs` flat config.

Key decisions (2026-05-13): orchestration = **Inngest** (durable timers/signals/`waitForEvent`); autonomy = **staged** (every policy gate `always_ask` by default, owners relax per-workspace); DB = **same Atlas cluster as v1**; agents on **Claude Agent SDK** (Opus 4.7 for judgment, Haiku 4.5 for bulk).

## Conventions (carried from v1)

- **One commit per P0-x / task**, small diffs, message references the task ID; `co-authored-by` the assisting model.
- **`pnpm run verify-build` must stay green** — never push red.
- **`codex review --base main`** before pushing `src/`/`packages/` changes (shrinks review-bot rounds). Don't loop forever on findings.
- **No unrelated changes** in a task's diff (no drive-by lint cleanup, no reformatting).
- **Shared v1 Atlas collections** (`accounts_tiktok`, `blacklist`, `workspaces`, `user_tokens`, `crm_accounts`, `templates`, `unified_emails`, …): read freely; write **additive fields only**; never remove/retype. v2 owns `v2_*`. Don't connect to the production Atlas casually — for P0-2 dev prefer a dev cluster or `mongodb-memory-server` in tests.
- Agents = functions the workflow invokes (curated tools, Zod output, USD cap, escalation), never free loops. Each agent needs a golden-set eval before the phase that depends on it is "done".
- `prompt-guard` runs on user text before it reaches any agent prompt; `external_send`-scoped capabilities (`gmail.send`) never fire without a cleared policy gate.

## Notes for autonomous (`/goal`) runs

- The `/goal` evaluator (Haiku) only sees the conversation — when you claim a goal is met, **run and print the proof in that turn** (`pnpm run verify-build`, `git status`, the `curl`, the Inngest dashboard state).
- If blocked on a missing env var or an irreducible human decision (e.g. `docs/SCOPE-DECISIONS.md` = P0-8 needs the human to choose which "conditional" features are in v2 day-1), stop, say exactly what's needed, and `/goal clear`.
