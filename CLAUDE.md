# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# social-seeding-v2

Agent-orchestrated TikTok influencer-campaign operator. Two things are true at once, and the second now drives the repo:

1. It is a **v2 rewrite** of v1 (`~/social-seeding`, frozen — **reference only**: port named assets, don't reinvent; see its `FREEZE.md`). The rewrite makes *the agent the operator* — a human gives a brief, a fleet of agents runs the loop (source → vet → outreach → reply → ship → verify → report), and the human only steps in at the policy gates they keep on.
2. It is a **single Google for Startups AI Agents Challenge — Track-3 submission** (deadline **2026-06-11 17:00 PT** — extended from 2026-06-05 per official Devpost email 2026-06-02). The v2 product build (Phases 0-6, the TS stack) is the *foundation*; the active layer is the **challenge stack** — a Python ADK agent fleet on Vertex AI reached over **A2A v0.3** inside a deployed Cloud Workflow. Decision source-of-truth: **`gcp-research/decisions/DECISIONS.md` (D1–D53)**.

## Two laws to internalize before any model or deploy work

These are hard constraints (D53 + deploy isolation). Violating them silently breaks the submission.

- **Models: Gemini 3.5 / 3.1 ONLY.** `gemini-3.5-flash` (judgment + coordinator) and `gemini-3.1-flash-lite` (bulk). **No** Gemini 2.5, **no** Anthropic Claude, **no** `*-pro` (`*-pro` returns 404 in `ss-v2-prod`; Preview allowlist not granted). The product is Gemini-only end-to-end (Kimi/Moonshot was removed from `crm.enrich`).
- **Endpoint: Vertex `global`.** Gemini 3.x is callable only on the `global` endpoint here — `us-central1` returns 404 for 3.x. Default region = `global`.
- **Naming (current, verified 2026-06).** Google rebranded the platform: **"Gemini Enterprise Agent Platform" (formerly Vertex AI)**. "Vertex AI" is **still official** for the model-serving surface we use — the `global` endpoint, `aiplatform.googleapis.com`, "Generative AI / Gemini API in Vertex AI", the `GOOGLE_GENAI_USE_VERTEXAI` SDK flag, and the Prompt Optimizer (VAPO) — so keep those as "Vertex AI". The **managed agent runtime** dropped the prefix: it's now **"Agent Runtime" / "Agent Platform Runtime"** (formerly "Vertex AI Agent Engine"). ("Agent Optimizer" is a separate new product, not a rename of the Prompt Optimizer.)
- **Deploy isolation.** Live deploys go to the NEW projects `ss-v2-prod` / `ss-mcp-prod` / `ss-shared-infra`. **Never** touch the protected v1 backend (`social-seeding-backend` :8080) or its `.env`.
- **Honesty discipline.** Declared-but-not-live items are disclosed in `scripts/demo/submission/HONEST-SCOPE.md`. Many ADK tools have a `CAPABILITY_LAYER_MODE` stub→live seam (stub = default + tested; live = staged). Keep the stub/live boundary honest; don't claim live what runs as stub.

## Read these first (in order)

1. **Latest handoff** — newest `claudedocs/*-handoff.md` (load via `/handon`); this is the live "where we are" for the submission. Trust the memory-index "Latest handoff" pointer over a filename glob.
2. `README.md` — the public submission framing (Build → Optimize → Refactor arc, live-evidence, the deployed components).
3. `gcp-research/decisions/DECISIONS.md` — D1–D53, the binding decisions; `gcp-research/decisions/SERVICE-INVENTORY.md` for what's deployed where.
4. `scripts/demo/submission/HONEST-SCOPE.md` — exactly what is live vs stubbed vs deferred.
5. **Product-build foundation** (still accurate for the local TS loop): `docs/STATUS.md` (Phases 0-6 state, snapshot 2026-05-14), `HANDOFF.md`, `docs/ARCHITECTURE.md`, `docs/CAPABILITIES.md`, `docs/SMOKE-TEST*.md`.
6. `agents-cli-app/CLAUDE.md` — nested guidance for the Google agents-cli wrapper; defer to it when working there.

## Repo map — two stacks

**TS product stack** (the v2 rewrite; runs the campaign loop locally, Phases 0-6 shipped):
- `apps/web` — Next 16 Mission Control (timeline + approval inbox), serves `/api/inngest`.
- `packages/workflows` — Inngest functions (brand-campaign + creator-track + lead loops).
- `packages/agents` — the 11 product agents: Gemini via `@google/genai`. Agents are **FUNCTIONS the workflow invokes** (curated tool set, Zod output contract, USD cap, escalation) — **not** free ReAct loops. Generalizes v1 `lib/cold-mail`.
- `packages/capabilities` — typed fns, the ONLY place HTTP + agents touch I/O (replaces v1's 266 routes).
- `packages/db` — Mongo: shared v1 Atlas collections + new `v2_*` collections.
- `packages/observability` (per-run trace, cost ledger), `packages/contracts` (Zod, the single source of truth for shapes crossing a boundary), `packages/config` (shared tsconfig).

**Python challenge stack** (the Track-3 submission surface; deployed on GCP):
- `packages/agents-adk` — the **22-agent ADK fleet** on Vertex AI (Python `uv` project). Library entry = `ss_agents.runtime.run_agent`; `serve.py` is the FastAPI front the Cloud Workflow calls over HTTP. Posture via env: `SS_LIVE` / `SS_OFFLINE`, `CAPABILITY_LAYER_MODE=stub|live`. (Note: 22 ADK agents ≠ 11 TS product agents — different runtimes.)
- `agents-cli-app` — Google `agents-cli`/ADK wrapper around the real `ss_agents` fleet (A2A discovery surface for playground/eval/deploy). Imports `ss_agents` editable — never forks it. Has its own `CLAUDE.md`.
- `oss/a2a-only-distribution` — standalone OSS `tiktok-mcp-server` reached over **A2A v0.3 `message:send`**.
- `deploy/` + `terraform/` — Cloud Run / Cloud Workflows IaC + Dockerfiles + cloudbuild (web, agents, model-garden).
- `site/` — `ss-landing` static demo/report site (live at the URL in `README.md`).
- `test-harness/` — Python chaos / golden / property-based / simulation suites.
- `gcp-research/` — research + the binding `decisions/` (DECISIONS.md D1–D53).
- `scripts/demo/` — recording, storyboards, and `submission/` (Devpost copy, HONEST-SCOPE, live-evidence verify scripts).
- `claudedocs/` — session handoffs + submission scorecards (the running log).

## Commands

```bash
# --- TS stack ---
pnpm install
cp .env.example .env.local             # MONGODB_URI (shared Atlas), AUTH_*, GEMINI_API_KEY, GOOGLE_*, INNGEST_*
pnpm run verify-build                   # lint → turbo build (incl. next build) → tsc --noEmit, all packages (CI gate — keep green)
pnpm test                               # full TS suite: scripts/test-all.ts self-boots an ephemeral mongo,
                                        #   runs each package's vitest against an isolated MONGODB_DB (CI `unit-tests` gate)
pnpm --filter @ss/web test              # one package's vitest suite
pnpm exec vitest run path/to/file.test.ts   # a single test file (from within a package dir, or filter the package)
pnpm run dev-mongo                      # mongodb-memory-server on :27027
pnpm exec tsx scripts/init-indexes.ts   # provision v2_* indexes (idempotent)
pnpm --filter @ss/web dev               # Next.js :3000 (serves /api/inngest)
npx inngest-cli@latest dev              # Inngest Dev Server :8288

# End-to-end demo (after the stack is up):
pnpm exec tsx scripts/run-demo.ts --dry-run --type=brand    # pre-flight env matrix only (no DB writes)
pnpm exec tsx scripts/run-demo.ts --type=brand              # brand-campaign loop
pnpm exec tsx scripts/run-demo.ts --type=lead               # sales-lead loop

# --- Python ADK stack (packages/agents-adk) ---
uv pip install --system -e ".[dev]"     # install (dev extra)
pytest -q                               # offline by design (conftest forces SS_OFFLINE=1 / SS_LIVE=0) — no GCP creds
python -m evals --agent coordinator --holdout-floor 0.7   # offline golden-eval gate (overfit/regression guard)
```

CI (`.github/workflows/ci.yml`) runs three jobs: `verify` (`pnpm run verify-build`), `unit-tests` (`pnpm test`), and `pytest-agents` (pytest + golden-eval, offline). All must pass; never push red.

## Architecture (one screen)

```
TS loop (local + product foundation):
Mission Control (apps/web, Next 16) ⇄ Inngest workflows (packages/workflows)
   ⇄ agents (packages/agents — Gemini via @google/genai; FUNCTIONS w/ curated tools, Zod output, USD cap, escalation)
   ⇄ capabilities (packages/capabilities — typed fns, the ONLY I/O boundary)
   ⇄ Mongo (packages/db — shared v1 Atlas + v2_* collections)
   + observability (trace, cost ledger) + contracts (Zod shapes across boundaries)

Challenge path (deployed on GCP):
brand-campaign Cloud Workflow → coordinator (gemini-3.5-flash, Vertex `global`) → 22-agent ADK fleet (serve.py)
   ── A2A v0.3 message:send ──▶ OSS tiktok-mcp-server (creator sourcing + brand-asset legs)
```

Repo is a **JIT internal-package monorepo**: each `packages/*` `exports` points straight at `src/*.ts` (no per-package build step, no project references); `apps/web` consumes them via Next `transpilePackages`. `turbo` orchestrates the cross-package task graph (`lint` / `type-check` / `test` / the `next build`). `tsconfig.base.json` = ES2022 target / ESNext module / Bundler resolution / strict + `noUncheckedIndexedAccess` / `noEmit` / `verbatimModuleSyntax`. Root `eslint.config.mjs` flat config.

Key decisions: orchestration = **Inngest** (durable timers/signals/`waitForEvent`); autonomy = **staged** (every policy gate `always_ask` by default, owners relax per-workspace); DB = **same Atlas cluster as v1**; agents on **Gemini** (`@google/genai` for the TS stack, ADK/Vertex for the Python fleet) under the D53 model law above.

## Conventions

- **One commit per task**, small diffs, message references the task ID; `co-authored-by` the assisting model.
- **`pnpm run verify-build` + `pnpm test` + `pytest` must stay green** — never push red.
- **`codex review --base main`** before pushing `src/`/`packages/` changes (shrinks review-bot rounds). Don't loop forever on findings.
- **No unrelated changes** in a task's diff (no drive-by lint cleanup, no reformatting).
- **No squash merges** — `gh pr merge --merge` (preserve individual commit history); `--rebase` only for conflict resolution.
- **Shared v1 Atlas collections** (`accounts_tiktok`, `blacklist`, `workspaces`, `user_tokens`, `crm_accounts`, `templates`, `unified_emails`, …): read freely; write **additive fields only**; never remove/retype. v2 owns `v2_*`. Don't connect to production Atlas casually — for dev prefer a dev cluster or `mongodb-memory-server`; `run-demo.ts` refuses live runs against the shared prod DB `instarsearch` (the real prod DB name — the code default and `.env.example` use `instarsearch`).
- Agents = functions the workflow invokes (curated tools, Zod output, USD cap, escalation), never free loops. Each agent needs a golden-set eval before the phase that depends on it is "done".
- `prompt-guard` runs on user text before it reaches any agent prompt; `external_send`-scoped capabilities (`gmail.send`) never fire without a cleared policy gate.

## Notes for autonomous (`/goal`) runs

- The `/goal` evaluator (Haiku) only sees the conversation — when you claim a goal is met, **run and print the proof in that turn** (`pnpm run verify-build`, `pnpm test`, `pytest`, `git status`, the `curl`, the live Cloud Run / Inngest state).
- If blocked on a missing env var, a Google-gated step (e.g. Gemini Enterprise invocation), or an irreducible human decision (e.g. `docs/SCOPE-DECISIONS.md` choices, the Devpost Submit click, demo video), stop, say exactly what's needed, and `/goal clear`.
