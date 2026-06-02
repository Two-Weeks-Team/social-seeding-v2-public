# Contributing to social-seeding-v2

Thanks for helping. This repo is a JIT internal-package pnpm + Turborepo monorepo (TypeScript product stack) alongside a Python `uv` ADK agent fleet. Read [`CLAUDE.md`](CLAUDE.md) first — it is the authoritative guide; this file is the short version.

## Two laws to internalize before any model or deploy work

- **Models: Gemini 3.5 / 3.1 only**, on the Vertex AI **`global`** endpoint. No Gemini 2.5, no `*-pro` (404 in our project), no third-party models (D53). The TS product agents reach Vertex via ADC (`GOOGLE_GENAI_USE_VERTEXAI=true`); local/test may use `GEMINI_API_KEY`.
- **Deploy isolation.** Live deploys target `ss-v2-prod` / `ss-mcp-prod` / `ss-shared-infra` only.

Honesty discipline: declared-but-not-live items are disclosed in [`scripts/demo/submission/HONEST-SCOPE.md`](scripts/demo/submission/HONEST-SCOPE.md). Don't claim live what runs as a stub.

## Toolchain

| Tool | Version | Install |
|---|---|---|
| Node.js | `22` (`.nvmrc`) | `nvm install 22 && nvm use` |
| pnpm | `10.18.2` (pinned) | `corepack enable && corepack prepare pnpm@10.18.2 --activate` |
| Python | `3.12` (ADK fleet) | `pyenv install 3.12 && pyenv local 3.12` |
| uv | latest | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |

## Local setup

```bash
pnpm install
cp .env.example .env.local          # fill MONGODB_URI, AUTH_SECRET, GOOGLE_*, etc.
pnpm run dev-mongo                   # in-memory Mongo on :27027 (separate terminal)
pnpm exec tsx scripts/init-indexes.ts
pnpm --filter @ss/web dev            # Mission Control on :3000
npx inngest-cli@latest dev           # Inngest Dev Server on :8288 (separate terminal)

# Python ADK fleet
cd packages/agents-adk && uv pip install --system -e ".[dev]"
```

Full from-zero reproduction (incl. MongoDB + GCP): the [rendered runbook](https://storage.googleapis.com/ss-social-seeding-v2-docs/onboarding-zero-to-reproduce.html).

## Gates — keep them green

CI (`.github/workflows/ci.yml`) runs three jobs; all must pass and you must **never push red**:

```bash
pnpm run verify-build    # lint → turbo build (incl. next build) → tsc --noEmit
pnpm test                # full TS vitest (self-boots an ephemeral mongo)
cd packages/agents-adk && pytest -q          # ADK, offline by design
python -m evals --agent coordinator --holdout-floor 0.7   # golden-eval gate
```

## Git workflow

- **Feature branches only** — never work on `main`. Start each session with `git status` + `git branch`.
- **One commit per task**, small diffs, message references the task; **no unrelated changes** in a task's diff (no drive-by reformatting).
- **No squash merges.** Use `gh pr merge --merge` to preserve individual commit history; `--rebase` only for conflict resolution.
- Co-author the assisting model on commits (`Co-Authored-By:`).
- `codex review --base main` before pushing `src/` / `packages/` changes shrinks review-bot rounds. Don't loop forever on findings.

## Conventions

- Agents are **functions the workflow invokes** (curated tools, Zod/Pydantic output contract, USD cap, escalation) — never free ReAct loops. Each agent needs a golden-set eval before the phase that depends on it is "done".
- `packages/capabilities` is the **only** place HTTP + agents touch I/O. `external_send`-scoped capabilities (`gmail.send`) never fire without a cleared policy gate.
- `packages/contracts` (Zod) is the single source of truth for shapes crossing a boundary.
- **Shared v1 Mongo collections** (`accounts_tiktok`, `workspaces`, `user_tokens`, …) in DB `instarsearch`: read freely; write **additive fields only**; never remove/retype. v2 owns `v2_*`. Prefer `mongodb-memory-server` for dev.

## Where to look

`CLAUDE.md` · `docs/ARCHITECTURE.md` · the [rendered system architecture](https://storage.googleapis.com/ss-social-seeding-v2-docs/architecture-current.html) + [master manual](https://storage.googleapis.com/ss-social-seeding-v2-docs/onboarding-master.html) · `gcp-research/decisions/DECISIONS.md` (D1–D53).
