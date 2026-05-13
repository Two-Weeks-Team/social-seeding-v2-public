# HANDOFF — continuing the v2 build (Claude Code CLI + `/goal`)

> Read this first when you (or a fresh Claude Code session) pick this repo up.
> Last handoff: **2026-05-13** — scaffold + Phase 0 / P0-1 done; `pnpm run verify-build` is green.

---

## 1. Current state

- Monorepo is real and green: `pnpm install` works; **`pnpm run verify-build` exits 0** (eslint clean → `next build` 9 routes → `tsc --noEmit` 7/7 packages).
- Pattern: **JIT internal packages** — each `packages/*` `exports` points at `src/`, no build step, no project references; `apps/web` transpiles them via `transpilePackages`. `tsconfig.base.json` = `ESNext`/`Bundler`/`noEmit`/`verbatimModuleSyntax`/strict. Root `eslint.config.mjs` flat config; per-package `lint` = `eslint .` (walks up).
- Everything else is **scaffold**: handlers `throw "not implemented — see docs/PHASE-1-PLAN.md task X"`. The contracts (Zod schemas), layering, capability registry, agent definitions, and the Inngest workflow graph are designed; the flesh goes on slice by slice.
- Commits so far: `66f4390` (scaffold), `83323e5` (P0-1 monorepo green). Branch `main`.

## 2. Read order (before writing code)

1. `README.md` — the reframe, the layout, the key decisions.
2. `docs/ARCHITECTURE.md` — the 6 layers, the orchestrator↔agent split, the human-checkpoint model.
3. `docs/CAPABILITIES.md` — every v1 feature mapped to its v2 home (where things come from).
4. `docs/PHASE-1-PLAN.md` — **the task list with DoDs**. Task IDs (`P0-1…P0-8`, `S2`, `V1`, `R1`, `V3`, `A-*`, `WF1-3`, `W1-5`) are referenced by the `throw` messages in the scaffold.
5. `docs/ROADMAP.md` — Phases 0–6, what ships when.

The v1 codebase (`~/social-seeding`, frozen) is **reference only** — port the named assets (TikTok ranking algos, `lib/cold-mail`, `lib/gmail`, CRM enrichment, NicePay billing, rate-limiter), don't reinvent. See its `FREEZE.md`.

## 3. What's next — Phase 0 (P0-2 … P0-8)

DoDs are in `docs/PHASE-1-PLAN.md`. Summary + what gates each:

| Task | Gist | Needs |
|---|---|---|
| **P0-2** | `@ss/db` real connection to the shared Atlas; `scripts/init-indexes.ts` for the `v2_*` collections; adjust `TikTokCreatorSchema` to match a real `accounts_tiktok` doc | `MONGODB_URI`, `MONGODB_DB` |
| **P0-3** | `runAgent` on the Claude Agent SDK (add `@anthropic-ai/claude-agent-sdk` to `packages/agents`): tool resolution → `invokeCapability`, budget gate, tracing, output parse + one reviser pass, escalation. Prove with a throwaway echo agent in a vitest test. **Make the model call go through an injectable client so the test runs without a real key.** | `ANTHROPIC_API_KEY` (runtime); test can use a fake client |
| **P0-4** | observability sinks: trace → `v2_agent_traces`, cost → `v2_cost_ledger`, soft-cap alerts at `COST_ALERT_THRESHOLDS` | (P0-2) |
| **P0-5** | `apps/web` boots: Auth.js v5 + Google OAuth (carry v1 Progressive-Permission allowlist), `/api/auth/test-login` JWT bypass (`AUTH_TEST_LOGIN_ENABLED`), `prompt-guard` on user text, `POST /api/campaigns` full impl, empty Mission Control pages render | `AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET` |
| **P0-6** | rate-limit primitive — port v1 `lib/usage-limiter.ts` (`user_usage`/`workspace_usage` atomic `$inc` + plan compare + rollback + `usage_limit_overrides`); `invokeCapability` calls it | (P0-2) |
| **P0-7** | Inngest end-to-end: `npx inngest-cli dev` discovers `brand-campaign`+`creator-track`; `POST /api/campaigns` → a run that completes (skeleton return); pause/resume/cancel events plumbed | `INNGEST_*` (dev works without keys) |
| **P0-8** | `docs/SCOPE-DECISIONS.md` — which CAPABILITIES.md "conditional" rows are in v2 day-1 (guest trial? beta codes? waitlist? i18n? newsletter? landing port?) | a human decision (ask) |

After Phase 0 → Phase 1 (the sourcing+vetting vertical slice; `intake`/`sourcing`/`vetting` agents, `tiktok.search`/`tiktok.getCreator`/`ranking.score`/`blacklist.check` capabilities, `brand-campaign` stages 1–2, the `gate()` helper, Mission Control campaign list + timeline + approval inbox + policy editor). See `docs/PHASE-1-PLAN.md`.

## 4. Setup before you start

```bash
cd ~/social-seeding-v2          # already a git repo, origin = Two-Weeks-Team/social-seeding-v2
pnpm install
cp .env.example .env.local      # fill at minimum MONGODB_URI, ANTHROPIC_API_KEY, AUTH_SECRET, GOOGLE_CLIENT_ID/SECRET
pnpm run verify-build           # confirm it's still green before changing anything
```

For `/goal` to work the workspace must be **trusted** (accept the trust dialog the first time you run `claude` here) — `/goal` is part of the hooks system.

## 5. Recommended `/goal` conditions

`/goal` keeps Claude working turn-after-turn until a small fast model judges the condition met **from what's in the transcript** (it doesn't run commands itself) — so the condition tells Claude to *run and show* the checks. Pair with **auto mode** so each turn runs unattended. Bound it with a turn clause. Check progress with `/goal` (no arg); abort with `/goal clear`.

**(a) No secrets available — do the parts of Phase 0 that don't need external credentials:**

```
/goal Read README.md, docs/ARCHITECTURE.md, docs/PHASE-1-PLAN.md first. Then complete the credential-free parts of Phase 0: add @anthropic-ai/claude-agent-sdk to packages/agents; implement P0-3 runAgent's control flow (tool resolution -> invokeCapability, budget gate via @ss/observability, trace spans, output parse + one reviser pass, escalate) with the LLM call behind an injectable client so a fake client makes a new echo-agent vitest test pass; wire P0-4 trace/cost code (stdout sink working, mongo sink coded against @ss/db); code P0-6 the rate-limit primitive's logic against an injectable db (no real connection); create scripts/init-indexes.ts (createIndex calls coded, not run); create docs/SCOPE-DECISIONS.md listing the open conditional-scope questions. Commit one commit per task. Done when, IN THE TURN YOU CLAIM COMPLETION, you have run and shown: `pnpm run verify-build` exits 0; `pnpm --filter @ss/agents test` passes including the echo-agent test; `git status` is clean. And no file outside the listed scope changed. Or stop after 35 turns and report what is left.
```

**(b) `.env.local` is filled — full Phase 0:**

```
/goal Read README.md, docs/ARCHITECTURE.md, docs/PHASE-1-PLAN.md first. Then complete all of Phase 0 (P0-1 is done; do P0-2..P0-8) per docs/PHASE-1-PLAN.md, one commit per task, no unrelated changes, additive-only to any shared v1 Atlas collection. Done when ALL of these hold and you have shown the proof in the transcript: (1) `pnpm run verify-build` exits 0; (2) `pnpm --filter @ss/agents test` passes including an echo-agent test; (3) `pnpm exec tsx scripts/init-indexes.ts` runs without error; (4) with `pnpm --filter @ss/web dev` and `npx inngest-cli@latest dev` running, `curl -s -XPOST localhost:3000/api/campaigns -H "Authorization: Bearer <token from /api/auth/test-login>" -H 'content-type: application/json' -d @<a valid brief>` returns HTTP 201 and the Inngest dev dashboard shows a brand-campaign run that completed; (5) docs/SCOPE-DECISIONS.md exists; (6) `git status` is clean and `git log --oneline` shows the P0-x commits. If you hit a missing or invalid env var, stop immediately, say exactly which var, and run /goal clear. Otherwise stop after 60 turns and report the remaining checks.
```

You can also run per-task goals (`/goal complete P0-2 per docs/PHASE-1-PLAN.md — done when scripts/init-indexes.ts runs clean against MONGODB_URI and pnpm run verify-build exits 0; stop after 15 turns`) and chain them. Headless: `claude -p "/goal ..."` runs the loop to completion in one invocation.

## 6. Conventions (carried from v1 — keep them)

- **One commit per P0-x / task**, small diffs; commit message references the task ID. `co-authored-by` the assisting model.
- **`pnpm run verify-build` must stay green** — never push red.
- **`codex review --base main`** before pushing `src/`/`packages/` changes (shrinks review-bot rounds; good at symmetry/consistency). Stop iterating per `docs/PHASE-1-PLAN.md` discipline (don't loop forever on a finding).
- **No unrelated changes** in a task's diff (no drive-by lint cleanup, no reformatting).
- **Shared v1 Atlas collections** (`accounts_tiktok`, `blacklist`, `workspaces`, `user_tokens`, `crm_accounts`, `templates`, `unified_emails`, …): read freely; write **additive fields only**; never remove/retype — coordinate with v1 (`~/social-seeding`, frozen). v2 owns the `v2_*` collections.
- **Don't connect to the production Atlas casually** — for P0-2 dev, prefer a separate dev cluster or `mongodb-memory-server` for tests; only point at the real shared cluster when intentionally validating P0-2/P0-7.
- Agents are **functions the workflow invokes** (curated tool set, Zod output contract, USD cap, escalation) — never free ReAct loops. Generalize v1's `lib/cold-mail` evaluator-optimizer + tournament pattern; don't reinvent it.
- Each agent needs a golden-set eval (`pnpm --filter @ss/agents test:eval` once set up — add the config) before the phase that depends on it is "done".

## 7. `/goal` gotchas

- The evaluator (Haiku) **only sees the conversation** — if Claude doesn't run+print `pnpm run verify-build` / `git status` / the curl, the evaluator can't confirm. The conditions above already say "show the proof in the turn you claim completion."
- It will keep spending tokens turn after turn — the turn clause bounds it; check `/goal` status for token spend; `/goal clear` to stop.
- A goal active when the session ends is restored on `--resume`/`--continue` (timer/turn-count reset).
- If blocked on a missing credential or an irreducible decision (e.g. P0-8 scope), the conditions tell Claude to stop, say what's needed, and clear the goal — answer it, then re-set the goal.
