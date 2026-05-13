# HANDOFF — continuing the v2 build (Claude Code CLI)

> Read this first when you (or a fresh Claude Code session) pick this repo up.
> Last handoff: **after Phase 1 + Phase 2 Chunks 1–2** — `pnpm run verify-build` is green, 114 tests pass.

---

## 1. Current state (commits on `main`, nothing pushed)

```
Phase 0  (foundation, 8 commits)              ✓ done
Phase 1  (sourcing+vetting vertical slice, 17 + 1 docs)  ✓ done
Phase 2  Chunk 1 (canvas paradigm UI)         ✓ done
Phase 2  Chunk 2 (templates.render + gmail.send platform, 5 commits) ✓ done
Phase 2  Chunks 3–7 (writer agent → conversation → workflow → MC → webhook)  ⏳ NEXT
```

`git log --oneline` shows ~34 commits since the scaffold (`66f4390`). `pnpm run verify-build` exits 0; 114 tests across `@ss/agents` (24) · `@ss/capabilities` (72) · `@ss/observability` (4) · `@ss/workflows` (14). `docs/PHASE-1-PLAN.md` unchanged (no scope creep).

P2-C2 added five capabilities/modules — all credential-free testable via injected fakes:
- `templates.render` — pure `{{var}}` variable engine with HTML-escape + missing-var policy (port of v1 `email-template-engine`).
- `gmail/unsubscribe-token` — HMAC-signed tokens with dual-secret rotation (CAN-SPAM §5 compliant; port of v1 `email-unsubscribe-token`).
- `gmail/spam-score` — pure 10-rule engine, weights match v1 verbatim, `DEFAULT_MAX_SPAM_SCORE = 6` gates `gmail.send`.
- `gmail/client` — `GmailClient` factory seam (matches the v1 `TikTokFetcher` pattern) + minimal `tokenManager` port (reads SHARED `user_tokens`, refreshes via Google OAuth, additive writes).
- `gmail.send` — composes MIME with tracking pixel + unsub footer, spam-score pre-check, idempotency + scheduled-send via new `v2_outbox` collection.

`apps/web` Mission Control surfaces (W1–W5) + the canvas alternative view all
ship in `apps/web/app/(mission-control)/*` + `apps/web/components/`. Design
language locked: **minimalist editorial** (Linear/Vercel tone) — see
`docs/previews/mission-control-{timeline,canvas}.html` for the visual
contracts and `memory/design-quality-canvas.md` for the no-AI-slop rules.

## 2. What's running locally

- **dev-mongo** (`mongodb-memory-server`) on `127.0.0.1:27027`, scratch dir
  `.mongo-dev/` (gitignored). Manage with `pnpm run dev-mongo` (foreground) or
  `kill $(cat .mongo-dev/pid)` to stop. Persistent across runs.
- **`.mongo-dev/dev-env`** holds the test env (real `MONGODB_URI` pointing at
  dev-mongo, generated `AUTH_SECRET`, `AUTH_TEST_LOGIN_*`). Source it before
  running anything that needs the DB:
  ```bash
  set -a; source .mongo-dev/dev-env; set +a; export MONGODB_DB=ss_test
  ```
- `.env.local` is still byte-identical to `.env.example` (placeholders). For
  live LLM / Gmail demos the real `.env.local` needs to be filled — see §5.

## 3. Read order (when writing code)

1. `README.md` — reframe + layout.
2. `docs/ARCHITECTURE.md` — 6 layers, orchestrator↔agent split, human checkpoints.
3. `docs/CAPABILITIES.md` — every v1 feature → its v2 home.
4. `docs/PHASE-1-PLAN.md` — task list with DoDs (Phase 1 done, but the
   wording is the contract).
5. `docs/ROADMAP.md` — Phase 2-6.
6. `docs/SCOPE-DECISIONS.md` — conditional-row decisions + Phase-0/1
   implementation calls (LLM SDK seam, in-memory observability sink, etc.).
7. `docs/previews/{mission-control-timeline,mission-control-canvas}.html` —
   design contracts.

v1 (`~/social-seeding`, frozen) is **reference only** — port named assets
(TikTok ranking, `lib/cold-mail`, `lib/gmail`, `lib/crm` enrichment, NicePay
billing, usage-limiter, blacklist) without reinventing.

## 4. What's next — Phase 2 outreach + reply-handling slice

Per `docs/ROADMAP.md` §"Phase 2". Six chunks; each ~50-80 turns; commit per
sub-task. Same discipline as Phase 1 (one commit per task, verify-build
green throughout, no scope creep on `docs/`).

| Chunk | Scope | New env needed for full demo |
|---|---|---|
| ~~**P2-C2**~~ ✓ | `gmail.send` + `templates.render` capabilities — token-manager + OAuth refresh ported; tracking pixel + unsubscribe footer + `sendAt` scheduling + spam-score pre-check all wired through the injectable `GmailClient` seam. **Live demo still needs**: a Phase-2 follow-up to fill `defaultGmailClientFactory` with `googleapis` + provide `GOOGLE_CLIENT_ID/SECRET` and a Gmail-connected user token. Tests are credential-free via the fake seam. | `GOOGLE_CLIENT_ID/SECRET`, Gmail OAuth scopes, `EMAIL_UNSUBSCRIBE_HMAC_SECRET` (≥16 chars) |
| **P2-C3** | `outreach-writer` agent — **highest-value port**. `~/social-seeding/src/lib/cold-mail/*` (13 files) is already in the right shape: `extractFacts → draftWriter → reviser loop → verifiers; tournament: 5 angles × 4 judges (brand/conversion/deliverability/skeptic) → winner; fewshot; followup`. Update the existing scaffold's `outreachWriterAgent` to use the curated tool set + judges; add golden-set tests using `runAgent`'s injectable `ModelClient`. | `ANTHROPIC_API_KEY` for live |
| **P2-C4** | `conversation` agent — reply classification (Haiku, the cheap one) + extraction (address / rate / question / classification) + response draft (Opus when needed). Defined in `packages/contracts/src/outreach.ts` (`ReplyClassSchema`, `ConversationTurnSchema`); just needs the agent definition + tests. | `ANTHROPIC_API_KEY` |
| **P2-C5** | `creator-track` child workflow — fully wire `packages/workflows/src/workflows/creator-track.ts`: `extractFacts` step → `runAgent(outreachWriterAgent)` → `approveOutreachSend` gate → `gmail.send` → reply loop (`step.sleep("3d") / step.waitForEvent("gmail/reply.received") / runAgent(conversationAgent) → branch on classification → approveReplyResponse gate for negotiating/question replies → gmail.send). brand-campaign fans out one `creator-track` per persisted shortlist track via `step.sendEvent("campaign/creator-track.start")`. | — |
| **P2-C6** | Mission Control extensions — `/approvals` gets outreach_send + reply_response drill-ins (the inbox kinds already render placeholders); new `/threads/[id]` view for a single creator's Gmail thread (manual reply, demoted v1 EmailCenter); policy editor unblocks the 4 Phase-2/3 gates (currently disabled). Canvas nodes light up as outreach progresses. | — |
| **P2-C7** | Gmail Pub/Sub webhook (`apps/web/app/api/webhooks/gmail/route.ts` already stubbed) — verify JWT, decode message, pull thread, emit `gmail/reply.received`. Scheduled fn `gmail-watch-renew` (daily). Bounce webhook via Resend. Suppression list. Unsubscribe page. | `GMAIL_PUBSUB_TOPIC`, `RESEND_API_KEY` |

After Phase 2 → Phase 3 (shipping + content_review), Phase 4 (analyst + MC
polish), Phase 5 (sales-lead campaign type — CRM enrichment via Modal + Kimi),
Phase 6 (admin / billing rollover). See `docs/ROADMAP.md`.

## 5. To run the live exit demo (Phase 1)

Currently the code path is wired but the LLM step throws without
`ANTHROPIC_API_KEY`. Fill `.env.local` with at least:

```bash
MONGODB_URI="mongodb://127.0.0.1:27027/social_seeding"  # dev-mongo, or real Atlas
MONGODB_DB="social_seeding"
AUTH_SECRET="$(openssl rand -base64 33)"
AUTH_TEST_LOGIN_ENABLED="true"
AUTH_TEST_LOGIN_SECRET="$(openssl rand -hex 24)"
ANTHROPIC_API_KEY="sk-ant-..."  # required for sourcing + vetting agents
# optional now, needed by P2-C2+:
# GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, RAPIDAPI_KEY_TIKTOK
```

Then:

```bash
pnpm run dev-mongo                  # (or already running)
pnpm exec tsx scripts/init-indexes.ts
pnpm --filter @ss/web dev           # :3000
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest  # :8288
```

Mint a session: `POST /api/auth/test-login {"secret":"$AUTH_TEST_LOGIN_SECRET"}`
(sets `ss_session` cookie). Browser to `http://localhost:3000` → `/campaigns/new`
→ submit the brief → workflow runs end-to-end → shortlist approval lands in
`/approvals` → resolve → tracks persisted → `/campaigns/[id]?view=canvas`
shows the graph or `?view=timeline` shows the span feed.

## 6. Conventions (carried)

- **One commit per task**; small diffs; commit message references the task ID
  (P0-2 / R1 / WF2 / W3 / P2-C1 …); `Co-Authored-By: Claude Opus 4.7 (1M
  context) <noreply@anthropic.com>` footer.
- **`pnpm run verify-build` green throughout** — `eslint .` + `next build` +
  `tsc --noEmit` across 7 packages. Currently fully cached (FULL TURBO).
- **No unrelated changes** in a task's diff. No drive-by lint cleanup.
- **Shared v1 collections** (`accounts_tiktok`, `influencer_blacklist`,
  `workspaces`, `user_tokens`, `templates`, `unified_emails`, `subscriptions`,
  `workspace_usage`, `user_usage`, `usage_limit_overrides`): read freely;
  write **additive fields only**; never remove / retype.
- **Agents** are bounded functions the workflow invokes (curated tools, Zod
  output contract, USD cap, escalation) — never free ReAct loops.
- **Tests** run credential-free against `dev-mongo` + injected fakes (the
  `ModelClient` seam in `@ss/agents`, the `TikTokFetcher` seam in
  `@ss/capabilities`, the `UsageStore` + `ObservabilitySink` seams).
- **`docs/PHASE-1-PLAN.md` is read-only** — anything not yet implemented
  carries a `TODO(phase-X)` in code, not an edit to the plan.

## 7. Memory notes (auto-recalled)

- `[[design-quality-canvas]]` — Phase 2+ canvas / UI work must explicitly use
  the design-skill inventory. Owner flagged "AI-slop 빼라" early.
- `[[mission-control-mockups]]` — `docs/previews/{timeline,canvas}.html` are
  the visual contracts.
- `[[goal-4000-char-limit]]` — `/goal` text is capped at 4000 chars; draft
  ≤ ~3500.

## 8. `/goal` patterns

The "drive-to-end / 다음 진행" pattern works without `/goal` once trust is
established; the project's chunked discipline (one commit per task,
verify-build green, final consolidated proof per chunk) is self-imposed.

For unattended runs use `/goal` with the 4-check structure that's worked
through Phase 0/1/Chunk-3:

```
/goal Per docs/PHASE-1-PLAN.md (or ROADMAP), implement <chunk> — one commit
per task, additive only, verify-build green throughout. Done only when ALL
hold AND shown in the turn you claim completion: (1) pnpm run verify-build
exits 0; (2) pnpm --filter @ss/<pkg> test passes with new suites; (3) git
status clean + git log shows the new commits; (4) no unrelated docs
touched. If missing env var or irreducible decision, stop immediately, say
what's needed, and run /goal clear. Otherwise stop after 60 turns.
```

Resume in a fresh session by reading this file → typing "다음 진행" or pasting
a chunk-scoped `/goal`.
