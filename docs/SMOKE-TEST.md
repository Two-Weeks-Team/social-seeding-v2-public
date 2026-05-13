# SMOKE-TEST — Phase 2 local end-to-end (post review-fix pass)

> Logged 2026-05-13 after the codex review fix pass on Phase 2 (commits
> `8c19487`..`fec5c64`). The goal was to confirm the workflow + API + Inngest
> wiring actually executes — not to exercise the LLM (no `ANTHROPIC_API_KEY`
> involved). Credentialed/full-loop smoke is gated on the P2-C2 follow-up
> (googleapis wiring + GOOGLE_CLIENT_ID/SECRET + ANTHROPIC_API_KEY).

## What ran

```bash
# 1. dev-mongo (already running)
pnpm run dev-mongo                      # 127.0.0.1:27027

# 2. init the v2_* indexes against ss_smoke
MONGODB_DB=ss_smoke pnpm exec tsx scripts/init-indexes.ts
# → ✓ done (15 indexes incl. P2-C7 additions)

# 3. apps/web/.env.local — copied from a curated set (NO ANTHROPIC_API_KEY)
#    MONGODB_URI / MONGODB_DB=ss_smoke / AUTH_SECRET / AUTH_TEST_LOGIN_* /
#    EMAIL_UNSUBSCRIBE_HMAC_SECRET / PUBLIC_APP_URL=http://localhost:3000
#    (the root .env.local is the SAME file but Next reads from apps/web/)

# 4. Next dev (turbo, port 3000)
pnpm --filter @ss/web dev

# 5. Inngest dev server (port 8288)
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest

# 6. mint a session
curl POST /api/auth/test-login + AUTH_TEST_LOGIN_SECRET
# → 200, ss_session cookie set

# 7. submit a brief
curl POST /api/campaigns -b cookies -d @brief.json
# → 201 { id }
```

## What passed

- **Auth**: `/api/auth/test-login` minted a JWT, set `ss_session` cookie. (Required `AUTH_TEST_LOGIN_ENABLED=true` to live in `apps/web/.env.local`, not the repo-root `.env.local` — Next reads from the app dir.)
- **Campaign intake**: `POST /api/campaigns` validated the brief, persisted to `v2_campaigns`, emitted `campaign/submitted`.
- **Inngest discovery**: `/api/inngest` registered 3 functions: `brand-campaign`, `creator-track`, `gmail-watch-renew`.
- **brand-campaign workflow steps executed in order:**
  - `observability` (P0-7 trace + $0 cost ledger) — ✓ `StepCompleted`
  - `plan` (`workspaceRepo.getPolicy` against dev-mongo) — ✓ `StepCompleted`
  - `source` (`runAgent(sourcingAgent)`) — ⊗ `StepErrored` with the **expected** message: `"ANTHROPIC_API_KEY is not set — runAgent needs it at runtime"`.

## What this proves

- The 7-package monorepo links and ships through to runtime — every `@ss/*` import path works under Turbopack.
- The brief-validate → persist → emit → dispatch → step chain actually executes (not just type-checks).
- `workspaceRepo` writes/reads via the live MongoDB driver.
- Inngest's executor reaches the Next.js route, the SDK handler parses the payload, the workflow handler runs.
- The credential gap surfaces at exactly the right place, with the right error message — agent runtime fails loudly when no `ANTHROPIC_API_KEY`, instead of silently producing garbage.

## What this didn't prove

- LLM calls (sourcing → vetting → outreach-writer → conversation × responder). Gate behind `ANTHROPIC_API_KEY`.
- gmail.send live (`defaultGmailClientFactory` still throws — googleapis not wired). Gate behind P2-C2 follow-up + `GOOGLE_CLIENT_ID/SECRET` + a real Gmail OAuth token.
- Gmail Pub/Sub webhook (no real Pub/Sub topic yet). Gate behind `GMAIL_PUBSUB_TOKEN` + topic provisioning.
- The Mission Control UI in a browser (no headless puppet here — would need Playwright or manual click-through).

## Environment gotcha caught during the smoke

A stale `next-server` process from a sibling `~/social-seeding-v3` repo was also bound to `:3000`, intercepting Inngest's POSTs and returning a different shape that crashed the SDK parser. Symptom: workflow step errors with stack traces pointing at OLD line numbers + a `TypeError: Cannot read properties of undefined (reading 'workspaceId')` that doesn't reproduce in the current code. Fix: `lsof -i :3000` to find dupes; kill the other `next-server` before re-running. Worth a note: any future re-smoke should first `lsof -i :3000 -t | xargs ps -p` to confirm we're hitting OUR Next.

## To advance to a full live demo

In rough order of effort:

1. **Set `ANTHROPIC_API_KEY` in `apps/web/.env.local`** → the source/vetting agents start running for real; brand-campaign reaches the `approveShortlist` gate.
2. **Step D (next planned)**: wire `defaultGmailClientFactory` with `googleapis` + supply `GOOGLE_CLIENT_ID/SECRET` + a real Gmail OAuth token → `gmail.send` actually sends; reply waits resolve when a creator replies (manual test: send a reply to your own outreach).
3. Real GCP Pub/Sub topic + push subscription pointing at `/api/webhooks/gmail?token=$GMAIL_PUBSUB_TOKEN`. This is the only "infrastructure has to exist" step that requires a GCP project.
4. Headless E2E via Playwright would be nice-to-have but is post-Phase-2.

## Outcome

Smoke pass confirmed Phase-2 is **structurally sound** — every package compiles, every connection holds, the workflow advances through real Mongo + real Inngest until it asks for the LLM. The remaining gaps are credential / SDK-wiring, not code.
