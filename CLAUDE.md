# CLAUDE.md — social-seeding-v2

Agent-orchestrated TikTok influencer campaign operator. Rewrite of v1 (`~/social-seeding`, frozen — **reference only**, port named assets, don't reinvent; see its `FREEZE.md`).

## Continuing the build? Read these first (in order)

1. **`docs/STATUS.md`** — one-screen "where everything stands". Phases 0-6 are shipped; this lists what's done, what's deferred (with reasons), and how to pick up. **Start here.**
2. `HANDOFF.md` — per-chunk granular history + carry-over breakdown.
3. `README.md` — the reframe + layout + key decisions.
4. `docs/ARCHITECTURE.md` — the 6 layers, orchestrator↔agent split, human-checkpoint model.
5. `docs/CAPABILITIES.md` — every v1 feature → its v2 home.
6. `docs/ROADMAP.md` — Phases 0–6.
7. `docs/PHASE-1-PLAN.md` — the original task list with DoDs (now all done; kept for traceability).
8. `docs/SMOKE-TEST*.md` — per-phase credential-free end-to-end smokes.

## Current state

- **Phases 0-6 done** (Phase 6 C1+C2; C3/C4 deferred per operator decision).
- `pnpm run verify-build` is green; **354 tests pass** (4 observability · 64 agents · 183 capabilities · 103 workflows). Keep it green; never push red.
- 10 Inngest functions registered + 23 MongoDB indexes provisioned.
- The full source → vet → outreach → reply → ship → verify → report loop runs end-to-end. The sales-lead campaign type is the second loop. `scripts/run-demo.ts --type=brand|lead` exercises the whole thing.
- Open work needing operator decisions: Phase 6 C3 (admin views sweep — port-vs-drop calls), Phase 6 C4 (retire v1 backend timing), carrier adapter (deferred 2026-05-14).

## Commands

```bash
pnpm install
cp .env.example .env.local            # MONGODB_URI (shared Atlas), AUTH_*, ANTHROPIC_API_KEY, GOOGLE_*, INNGEST_*
pnpm run verify-build                  # lint → next build → tsc --noEmit  (must stay green)
pnpm run dev-mongo                     # mongodb-memory-server on :27027
pnpm exec tsx scripts/init-indexes.ts  # provision v2_* indexes (idempotent)
pnpm --filter @ss/web dev              # Next.js :3000  (serves /api/inngest)
npx inngest-cli@latest dev             # Inngest Dev Server :8288
pnpm --filter @ss/agents test          # vitest (agent tests / evals)

# End-to-end demo (after the stack is up):
pnpm exec tsx scripts/run-demo.ts --dry-run --type=brand    # pre-flight only
pnpm exec tsx scripts/run-demo.ts --type=brand              # live demo
pnpm exec tsx scripts/run-demo.ts --type=lead               # sales-lead loop
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
