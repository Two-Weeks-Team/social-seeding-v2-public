# HANDOFF — continuing the v2 build (Claude Code CLI)

> Read this first when you (or a fresh Claude Code session) pick this repo up.
> Last handoff: **Phase 5 all 4 chunks + codex-review fix pass + P5 smoke** — `pnpm run verify-build` is green, 299 tests pass (74 workflows / 157 capabilities / 64 agents / 4 observability).

---

## 1. Current state (commits on `main`, nothing pushed)

```
Phase 0  (foundation, 8 commits)                                      ✓ done
Phase 1  (sourcing+vetting vertical slice, 17 + 1 docs)               ✓ done
Phase 2  C1-C7 + codex-review pass + Step D googleapis (29 commits)   ✓ done
Phase 3  C1-C7 + 4-commit codex-review pass (14 commits)              ✓ done
Phase 4  C1-C6 + codex-review fix pass + smoke (9 commits)            ✓ done
Phase 5  C1 (Lead/LeadCampaign contracts + crm.search + crm.enrich)   ✓ done
Phase 5  C2 (research agent — Haiku — enrichment → pitch)             ✓ done
Phase 5  C3 (lead-campaign + lead-track + lead-outreach-writer)       ✓ done
Phase 5  C4 (MC /leads list + /leads/new + /leads/[id])               ✓ done
Phase 5  codex-review fixes (gmail.send shape + email-promote + …)    ✓ done
Phase 6  (cutover: migrate v1 workspaces, retire v1 backend)          ⏳ NEXT
```

`git log --oneline` shows ~95 commits since the scaffold (`66f4390`). `pnpm run verify-build` exits 0; 299 tests across `@ss/agents` (64) · `@ss/capabilities` (157) · `@ss/observability` (4) · `@ss/workflows` (74). `docs/PHASE-1-PLAN.md` unchanged (no scope creep).

### Phase 5 in one paragraph

Adds the **second campaign type**: sales leads (B2B cold outreach). Same
orchestrator + capability stack as the brand-campaign loop; swaps the
sourcing primitives. `crm.enrich` ports v1's Modal crawl + Kimi
(Moonshot) analysis verbatim behind a `CrmEnrichClient` factory seam —
production binds the real Modal + Kimi from env vars; tests inject a
fake. `crm.search` reads v2_leads + the shared `crm_accounts`
collection, deduping shared candidates against already-imported v2
rows via `sharedAccountId`. The `research` agent (Haiku, no tools, $0.10
cap) takes the enrichment + the LeadCampaignBrief and emits a
pitch-specific research block (pitch + angles + groundedFacts +
contactProfile + confidence) for the writer to consume. A B2B-flavored
`leadOutreachWriterAgent` (Opus 4.7, reuses the 4 deterministic judges
from Phase 2) drafts the cold-sales email. Two new Inngest functions
(`lead-campaign` + `lead-track`) mirror brand-campaign + creator-track:
the parent walks import → enrich → research and fans out one child per
researched lead (respecting `brief.outreach.maxSendsPerBatch`); the
child does outreach (writer + send) + 3-day reply wait + classifier +
branch (interested → responder + reply gate + send → 'agreed'/'in_conv';
negotiating → always_ask escalate; declined/unsubscribe → 'declined' +
suppression.add; not_now/OOO/unrelated → 'no_response'). MC adds
`/leads` (list + per-campaign + recent-leads tables), `/leads/new`
(LeadCampaignBrief form + paste-list textarea), `/leads/[id]` (9-column
funnel strip + per-lead leaderboard with priority + confidence badges).
Sidebar gets "리드 (B2B)" as the 2nd PRIMARY nav item.

### Codex review fix pass (post-P5)

`codex review --base p5-baseline` against the 4-commit P5 delta
surfaced 4 issues (2 P1 + 2 P2); all fixed in `1a8335e`:

- **P1#1** — lead-track called gmail.send with the wrong schema
  (passed `senderUserId / campaignId / creatorId`; needed
  `creatorTrackId + publicBaseUrl`). Every B2B outreach would have
  failed Zod validation at the invokeCapability boundary. Fix: pass
  `creatorTrackId = ${leadCampaignId}:${leadId}` + a resolved
  `publicBaseUrl` from deps → PUBLIC_APP_URL env → localhost.
- **P1#2** — crawled emails sat in `enrichment.websiteData.emails`
  but weren't promoted to `lead.contactEmail`, so lead-track flaked
  every UI-imported lead at the `!lead.contactEmail` guard. Fix:
  after `patchEnrichment`, if the lead has no contactEmail and the
  crawl found emails, promote the first one. Operator-supplied
  addresses always win.
- **P2#3** — lead-campaign's fan-out ignored
  `brief.outreach.maxSendsPerBatch`. Fix: slice the fan-out at the
  cap; held-back leads stay at stage='researched' (P5.5 cron /
  manual button drains them).
- **P2#4** — `crm.search`'s `lowercaseQ` went into `$regex` raw,
  letting query strings with `[`, `(`, or `.*` either throw an
  invalid-regex error or match-everything. Fix: escape regex
  special chars. Regression test asserts `(Seoul)` matches literally
  and `.*` matches nothing.

3 new tests; 299/299 pass.

### Phase 5 smoke (post all fixes, 2026-05-14)

`docs/SMOKE-TEST-P5.md` logs the credential-free smoke. What passed:
init-indexes provisions 23 v2_* indexes including the 3 new P5 ones
(v2_leads workspace+updatedAt, v2_leads workspace+sharedAccountId
partial UNIQUE, v2_lead_campaigns brief.workspace+updatedAt);
Inngest discovery returns `function_count: 10` including the 2 new P5
functions (`lead-campaign` event-triggered, `lead-track` event-
triggered, both with `cancelOn` against `campaign/cancelled`); the
3 new MC pages render under HTTP 200 (`/leads` list, `/leads/new`
form, `/leads/[id]` detail with funnel + leaderboard). The schema
correctly rejected a too-short angle in the first seed — exactly its
job. Full live demo needs `MODAL_CRAWL_URL` + `KIMI_API_KEY` for
`crm.enrich`, plus `ANTHROPIC_API_KEY` and the Phase 2/3 Gmail wiring.

### Phase 4 in one paragraph

Closes the brand-campaign loop with a per-campaign **analytics report**.
`analytics.compile` (pure aggregation) rolls v2_campaigns + v2_cost_ledger
into an `AnalyticsReport` (funnel, goals, reach, performance, cost,
flags). The `analyst` agent (Haiku, no tools, $0.10 cap) takes that report
+ the brief and produces a markdown narrative (summary / highlights /
concerns / recommendations / full markdown). `report-deliver` is the
durable workflow that ties them — triggered by `report/deliver.request`
from three places: weekly cron (Mon 09:00 UTC), stage-transition
(campaign-progression cron at 03:00 UTC, when all creator-tracks
terminate), and a manual "🔄 새 리포트 생성" button on the MC report page.
Reports are append-only (audit log) and persisted on a 24-byte random
shareToken for the public `/share/[id]?t=…` page (constant-time-compared
via `timingSafeEqual`). `campaign-progression` is the cron that closes
the lifecycle: `outreach → performance` when all tracks reached terminal
state + `performance → completed` when any report row exists. MC gets a
new `/usage` cost dashboard (per-agent + per-campaign spend rollups, MTD
vs 30d windows), a "원클릭 프리셋 적용" for autonomy levels on `/policies`,
and a working kill switch on `/campaigns/[id]`.

### Phase 4 in one paragraph

Closes the brand-campaign loop with a per-campaign **analytics report**.
`analytics.compile` (pure aggregation) rolls v2_campaigns + v2_cost_ledger
into an `AnalyticsReport` (funnel, goals, reach, performance, cost,
flags). The `analyst` agent (Haiku, no tools, $0.10 cap) takes that report
+ the brief and produces a markdown narrative (summary / highlights /
concerns / recommendations / full markdown). `report-deliver` is the
durable workflow that ties them — triggered by `report/deliver.request`
from three places: weekly cron (Mon 09:00 UTC), stage-transition
(campaign-progression cron at 03:00 UTC, when all creator-tracks
terminate), and a manual "🔄 새 리포트 생성" button on the MC report page.
Reports are append-only (audit log) and persisted on a 24-byte random
shareToken for the public `/share/[id]?t=…` page (constant-time-compared
via `timingSafeEqual`). `campaign-progression` is the cron that closes
the lifecycle: `outreach → performance` when all tracks reached terminal
state + `performance → completed` when any report row exists. MC gets a
new `/usage` cost dashboard (per-agent + per-campaign spend rollups, MTD
vs 30d windows), a "원클릭 프리셋 적용" for autonomy levels on `/policies`,
and a working kill switch on `/campaigns/[id]`.

### Codex review fix pass (post-P4)

`codex review --base p4-baseline` against the 6-commit P4 delta surfaced
4 issues (1 P1 + 3 P2); all fixed in `5e047c2`:

- **P1#1** — pause button shown but not wired into workflows. Hiding it
  for now; pause/resume needs every long `step.waitForEvent` to also
  cancel on `CampaignPaused` with a resumability contract — Phase 4.5
  follow-up. Only "취소" (cancel — already wired via brand-campaign's
  `cancelOn`) ships in Phase 4.
- **P2#2** — nested `<form>` on the policies page (the 1-click preset
  card was inside the save form). HTML doesn't allow it; SSR would
  collapse one of them. Fix: presets are now a sibling card outside the
  save form.
- **P2#3** — `report-deliver` analyst escalation returned a "soft"
  `kind: 'analyst_escalated'` result. `campaign-progression`'s "any
  report row exists → completed" rule never fired in this branch,
  leaving the campaign at `stage='performance'`/`status='running'`
  indefinitely. Fix: throw `AnalystEscalatedError` so Inngest's
  retry/backoff kicks in; persistent failures dead-letter to the
  Inngest dashboard.
- **P2#4** — `/usage` MTD calculation used a 30-day window, so on day 31
  of a month the first-of-month spend was dropped. Fix: fetch from
  `min(monthStart, thirtyDaysAgo)` and partition the same superset into
  MTD vs 30d windows in JS.

### Phase 4 smoke (post all fixes, 2026-05-14)

`docs/SMOKE-TEST-P4.md` logs the credential-free smoke. What passed:
init-indexes provisions 20 v2_* indexes (added 2 new v2_reports indexes
on top of the existing 18); Inngest discovery returns `function_count: 8`
including the 3 new P4 functions (`report-deliver`, `report-deliver-cron`,
`campaign-progression`); the 4 new/updated MC pages render under HTTP 200
(`/usage`, `/policies` preset card, `/campaigns/[id]/report`,
`/share/[id]?t=<token>`); the share token check correctly rejects wrong
tokens with 404 (constant-time-compared via `timingSafeEqual`). Full live
demo still needs `ANTHROPIC_API_KEY` (for the analyst agent's Haiku
narration) on top of everything Phase 2 / 3 already required.

### Phase 3 in one paragraph

Closes the loop from "creator agreed" to "verified content shipping the brand
goal." `shipment.create` (atomic-claim against concurrent races, codex P1#2)
+ `shipment.track` (chronological event sort, watermark on every poll, codex
P2#4) sit behind a `CarrierClient` factory seam — production binds yuntrack
once `YUNTRACK_API_KEY` is set; tests inject a recording fake. Two new Inngest
crons drive the producers: `tiktok-post-poller` (daily, `tiktok/post.detected`)
and `shipment-tracking-poller` (every 12h, `shipment/tracking.updated`).
`creator-track` grew two new legs after `interested + shippingAddress`:
gate(approveShipment) → runAgent(logisticsAgent) → wait for terminal carrier
status (delivered / cancelled / failed / returned; in-flight statuses are
filtered out by the wait `if` expression — codex P3-full P1#2) →
runAgent(contentVerifyAgent). MC gets two new pages
(`/campaigns/[id]/shipments`, `/campaigns/[id]/posts`), an approveShipment
drill-in at `/approvals/[id]`, and a policies-page that unblocks
`approveShipment` with the `followerCountGte` knob — which now actually fires
because the gate's recommendation carries `followerCount` (codex P3-full P1#3).

### Codex review fix passes (post-P3)

Two full `codex review --base p3-baseline` passes against the 14-commit P3
delta surfaced 9 issues across 3 batches; all fixed in 4 commits:

- **C2 + C4 P1#1 (`b2334c4`)** — tiktok-post-poller called `fetcher.getUserPosts(creator.id)` but the fetcher expects `uniqueId`. Fix: resolve via `creatorRepo.getById` before each call; added regression test for the missing-creator case.
- **C2 P1#2 (`859442a`)** — `shipment.create` had a concurrent-create race: two workers could both pass the existence check before either inserted. Fix: atomic claim via `insertOne(status=pending)` with the unique `creatorTrackId` index + E11000 → branch on the existing row's status; mirrors the gmail.send pattern.
- **C1-C5 P2-batch (`a2870cd`)** — trust boundary (use `ctx.campaignId` not model input), chronological sort of new tracking events before append (so the latest carrier status wins, not the oldest), `$elemMatch` dedupe in `appendTrackingEvent`, plus 4 smaller correctness fixes; 3 regression tests.
- **P3-full P1#1 + P2#4 (`497c2f2`)** — `shipment/tracking.updated` had no producer; daily cron added that pulls every non-terminal shipment with stale `lastTrackedAt`, emits only on a status flip. `shipment.track` now bumps `lastTrackedAt` even on no-op carrier responses so the poller can skip recently-polled rows. 7-test poller suite.
- **P3-full P1#2 + P1#3 (`70313dd`)** — workflow's shipment wait now filters to terminal carrier statuses via the `if` expression; the recommendation payload threading `followerCount` so `auto_unless` policies with a follower threshold actually fire. 2 regression tests asserting the predicate evaluates with/without the threshold met.

### Phase 3 smoke (post all fixes, 2026-05-14)

`docs/SMOKE-TEST-P3.md` logs the credential-free smoke. What passed:
init-indexes provisions 18 v2_* indexes including the 3 new v2_shipments
ones; Inngest discovery returns all 5 functions including the new
shipment-tracking-poller (`0 4,16 * * *`) and tiktok-post-poller
(`0 2 * * *`); the new MC pages (`/campaigns/{id}/{shipments,posts}` and
the updated `/policies`) render under HTTP 200 against a seeded campaign
row. What still needs creds for a full live P3 loop: `YUNTRACK_API_KEY`
(carrier adapter) + `RAPIDAPI_KEY_TIKTOK` (post fetcher) + everything Phase 2
already required.

### Step D: googleapis SDK wiring

The throwing `defaultGmailClientFactory` is replaced with a real googleapis-backed implementation. `send` / `getMessage` / `listHistory` / `renewWatch` are all live. Lazy-imports googleapis so tests that always inject fakes don't load the ~50MB module on cold start. With `GOOGLE_CLIENT_ID/SECRET` + a Gmail-connected user token + `GMAIL_PUBSUB_TOPIC`, every Phase-2 code path is end-to-end runnable. See `docs/SMOKE-TEST.md` for the credential-free smoke proof.

The remaining gating items for a fully-live demo are now purely **infrastructure** (not code): `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID/SECRET` + OAuth user-grant flow (Phase 2 didn't wire the Auth.js Gmail-connect screen — that's a Phase-2.5 polish item; for now token rows can be seeded manually), and a real GCP Pub/Sub topic for `GMAIL_PUBSUB_TOPIC`.

### Codex review fix pass (post-P2-C7)

`codex review --base p2-baseline` against the full 29-commit P2 delta surfaced 8 issues; all fixed in 3 commits:

  · **P1#1** — creator-track agentCtx.capabilityCtx was missing `campaignId`. Every `gmail.send` from this workflow wrote outbox rows without it AND signed unsubscribe tokens with `cid="no-campaign"` → webhook+ unsubscribe lookups would fail in prod. **Fix**: spread `campaignId` into the ctx.
  · **P1#2** — `step.waitForEvent` used `match: "data.threadId"`, but Inngest evaluates `match` against BOTH the trigger event (CreatorTrackStart, no threadId) and the awaited event. **Every reply wait would time out in prod.** Fix: drop `match`, use a self-contained `if` expression pinned to (campaignId, creatorId, threadId).
  · **P1#3** — Reply classification = `unsubscribe` only set state="declined" without adding to suppression list. Fix: `step.run("suppression-from-reply")` invokes `suppression.add` before terminal patchTrack.
  · **P2#4** — Pub/Sub webhook fails open when `GMAIL_PUBSUB_TOKEN` env is missing. Fix: route returns 503 in production when token isn't configured.
  · **P2#5** — gmail.send idempotency race: 2 concurrent workers could both pass the existence check before either upsert → double-send. Fix: atomic claim via `insertOne({ status: "pending" })` + E11000 detect; in-flight pending row throws `concurrent_send`.
  · **P2#6** — spam score ran on `input.bodyHtml` (pre-footer), penalizing the `noUnsubscribe` rule even though gmail.send adds the footer. Fix: score the COMPOSED HTML (post pixel + unsub footer).
  · **P2#7** — `negotiating` branch went through the policy gate → an `auto` setting would auto-approve rate counter-offers without human review. Fix: pass `{ mode: "always_ask" }` literally for this branch.
  · **P2#8** — `v2_suppression_list` unique index was `email` alone; the code queries `{ workspaceId, email }` → cross-workspace duplicate-key. Fix: compound `{ workspaceId: 1, email: 1 }` unique.

3 regression tests added (unsubscribe→suppression, concurrent_send race, cross-workspace suppression).

P2-C2 added five capabilities/modules — all credential-free testable via injected fakes:
- `templates.render` — pure `{{var}}` variable engine with HTML-escape + missing-var policy (port of v1 `email-template-engine`).
- `gmail/unsubscribe-token` — HMAC-signed tokens with dual-secret rotation (CAN-SPAM §5 compliant; port of v1 `email-unsubscribe-token`).
- `gmail/spam-score` — pure 10-rule engine, weights match v1 verbatim, `DEFAULT_MAX_SPAM_SCORE = 6` gates `gmail.send`.
- `gmail/client` — `GmailClient` factory seam (matches the v1 `TikTokFetcher` pattern) + minimal `tokenManager` port (reads SHARED `user_tokens`, refreshes via Google OAuth, additive writes).
- `gmail.send` — composes MIME with tracking pixel + unsub footer, spam-score pre-check, idempotency + scheduled-send via new `v2_outbox` collection.

P2-C3 ported v1's `lib/cold-mail` tournament discipline into the v2 single-agent shape — credential-free deterministic tools so the runtime stays testable:
- `OutreachFacts` contract + `JudgeKeySchema` / `JUDGE_WEIGHTS` (verbatim from v1: skeptic 0.40 / conversion 0.30 / deliverability 0.15 / brand 0.15) + `weightedJudgeScore()`.
- `outreach.extractFacts` — pure, deterministic. Closed fact set ("cite only what's here"). Emits `hasMinimumContext` flag for v2's escalation pattern (v1 threw `InsufficientContextError`).
- `outreach.judge` — 4 deterministic judges (brand / conversion / deliverability / skeptic). Each judge audits drafts against the closed fact set; the deliverability judge wraps `calculateSpamScore`. LLM-backed variants are a follow-up — each judge's score function is pure, so an upgrade is a strict superset.
- `outreachWriterAgent` rewritten — curated tools `[outreach.extractFacts, outreach.judge, templates.render]`, system prompt encoding the v1 5-angle × 4-judge tournament reshaped to a single Opus 4.7 session with one optional revision pass.
- 3 golden-set scenarios (happy / revision / escalation) verifying tool-call order, judge weight honoring, and the `insufficient_context` short-circuit.

P2-C4 split the inbound side into a Haiku classifier + an Opus responder so the model bill scales with what each inbound actually needs:
- `conversationAgent` (Haiku, no tools, $0.02 cap) — runs on every inbound; output is `ConversationTurnSchema` minus `draftedReply`. Classification matrix matches the contract: interested / needs_info / negotiating / not_now / declined / out_of_office / unsubscribe / unrelated. Extracts only what the workflow branches on (shipping address / proposed rate / verbatim question). Sets `needsHumanReason` on negotiating / declined / unsubscribe automatically.
- `conversationResponderAgent` (Opus 4.7, tools `[outreach.judge, templates.render]`, $0.25 cap) — runs only when `needsResponseDraft(turn)` returns true (interested or needs_info). Drafts the reply, self-checks deliverability via the existing judge, and returns `{subject, body, deliverabilityScore}`.
- `needsResponseDraft()` pure helper — centralizes the branching rule so the workflow (P2-C5) and the agent tests stay in sync.
- 5-scenario golden set pins the full branching matrix (interested+address → responder; needs_info → responder; negotiating / unsubscribe / out-of-office → no responder).

P2-C7 closed the inbound side of the Phase-2 loop:
- `apps/web/app/api/webhooks/gmail/route.ts` is now an actual producer: verifies Pub/Sub auth (User-Agent + content-type + `?token=` vs `GMAIL_PUBSUB_TOKEN`), parses the `{emailAddress, historyId}` envelope, walks `GmailClient.listHistory` from `v2_gmail_watches.lastHistoryId`, calls `getMessage` per new id, joins `v2_outbox` by `threadId` to recover `(campaignId, creatorId)`, and emits `gmail/reply.received` — which wakes the `step.waitForEvent` in creator-track.
- `verifyPubSubAuth` / `parsePubSubMessage` / `buildPubSubMessage` live in `@ss/capabilities/gmail/pubsub`. Tests are pure (no I/O, no SDK).
- `GmailClient` interface gets optional `getMessage` + `listHistory` + `renewWatch`. Optional on the type so existing fakes that only set `send()` keep compiling; the default-throwing factory still refuses to operate without `googleapis` wired.
- `gmail-watch-renew` daily cron (04:00 UTC) iterates `v2_gmail_watches` and calls `renewWatch` per row — 6 chances a week to keep each watch alive (Gmail watches expire after 7 days). 5 buckets in the result: total / renewed / skipped (no renewWatch on the fake) / failed (factory threw OR renew threw) / failures[].
- `suppression.check` + `suppression.add` capabilities — workspace-scoped do-not-mail list. `gmail.send` runs the suppression check immediately after the idempotency hit-test (before spam-score, before the client call) and refuses with `recipient_suppressed`, recording the refusal on `v2_outbox` for trace honesty.
- `apps/web/app/unsubscribe/page.tsx` — CAN-SPAM §5 landing. HMAC token verify (dual-secret rotation honored — P2-C2b), confirm form, server action does best-effort recipient-email recovery via the outbox row keyed by `${campaignId}:${creatorId}:` prefix, then `suppressionAdd.handler(…, reason: "unsubscribed", source)`. Five UX states: ok / ok_no_email (operator reconciliation path) / expired / bad_signature / not_configured / missing_token / campaign_missing.
- Schema additions: `V2_GMAIL_WATCHES` + `V2_SUPPRESSION_LIST` collections, `v2_outbox.threadId` compound index for the webhook lookup.

P2-C6 brought Mission Control up to parity with the workflow:
- `/approvals/[id]` `outreach_send` drill-in: OutreachDraft preview with the winning angle, 4 judge bars (brand/conversion/deliverability/skeptic) + inverted spam-score meter, groundedFacts audit list, editable subject + body, sandboxed-iframe HTML preview.
- `/approvals/[id]` `reply_response` drill-in: discriminates ConversationTurn (negotiating escalation, no auto-reply — shows extracted signals + thread metadata for the human) vs responder draft (editable preview + deliverability self-check meter).
- `resolveAction` now handles `approveEdited` — merging edited subject/body into the recommendation as `editedPayload` so the workflow's gate() helper threads the human's edit downstream.
- `/policies` unblocks `approveOutreachSend` (spamScoreGte + followerCountGte) and `approveReplyResponse` (proposedRateUsdGte + replyClassIn multi-select) with real mode toggles. `approveShipment` / `approveStageAdvance` still placeholders.
- Campaign canvas: outreach-writer node lights up by aggregate `CreatorTrack.state` — running while tracks are live, done once every track is terminal. wait-reply node shows the waiting-for-reply count. Edges to wait + shipping animate by bucket totals. Right-rail track sidebar gets a color-coded bucket cluster.

P2-C5 wired the per-creator child workflow that was a `see Phase 2` skeleton in the scaffold:
- `creatorTrackHandler`: load brief+creator+policy → `outreach.extractFacts` → `runAgent(outreachWriterAgent)` → `gate(approveOutreachSend)` → `invokeCapability(gmail.send, idempotencyKey=…:outreach)` → `step.waitForEvent('gmail/reply.received', timeout='3d')` → `runAgent(conversationAgent)` → branch on classification (interested+addr → state='agreed'; interested-no-addr / needs_info → responder + gate(approveReplyResponse) + `gmail.send` idempotencyKey=…:reply:<msgId>; declined/unsubscribe → state='declined'; negotiating → approveReplyResponse approval surfaced; OOO/not_now/unrelated → state='no_response'; timeout → state='no_response'; writer escalate → 'writer_escalated'; no creatorEmail → 'no_email').
- `CreatorTrackStartEvent` now carries the full brief + creator (+ optional email + recentPosts) so creator-track is self-contained without re-fetching.
- `GmailReplyReceivedEvent` extended with `fromEmail / subject / bodyText` — the webhook (P2-C7) is the producer; tests emit the same shape.
- `StepLike.waitForEvent` is now generic so creator-track (awaiting Gmail data) reuses the same step surface as the approvals path.
- `brand-campaign`: after persist-tracks, `step.run('advance-stage-outreach')` + `step.sendEvent` fans out one `CreatorTrackStart` per confirmed creator. Stage advances to `outreach` on success.
- 8-scenario integration suite exercises every branch end-to-end through the real capability stack (gmail.send + outreach.extractFacts + judges + campaignRepo) — only the LLM (via ModelClient) and the Gmail wire (via setGmailClientFactory) are faked.

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

## 4. What's next — Phase 6 cutover

Per `docs/ROADMAP.md` §"Phase 6". Phase 5 added the second campaign
type (sales-lead) so the brand + lead loops are both real. Phase 6 is
the **migration + sunset**: move existing v1 workspaces/users to v2,
run both side-by-side in a deprecation window, retire the v1 Go +
LangGraph backend, then sweep the admin views v1 still owns.

Planned chunks (loose — Phase 6 is ongoing maintenance, not a single
delivery):

- **P6-C1**: v1 → v2 workspace importer. Script that walks v1
  workspaces + memberships and creates v2-side mirrors (the shared
  Atlas already holds the historical campaign data, so this is just
  bootstrap of the v2_* per-workspace rows: workspace_policies with
  conservative defaults, agent_traces TTL, cost_ledger seed).
- **P6-C2**: side-by-side rollout. Documentation + a workspace-level
  flag (`v2_enabled` on the shared `workspaces` doc) so v1 frontend
  hides itself for opted-in workspaces.
- **P6-C3**: admin views (sweep of v1's `/admin/*` pages that aren't
  yet rebuilt — usage-dashboard is already in v2 at `/usage`; the
  remaining ones are user-overrides, billing impersonation, etc).
- **P6-C4**: retire v1 backend (Go/LangGraph). Mark v1 as read-only
  in `~/social-seeding/FREEZE.md`; remove the Modal+Kimi services
  v2 doesn't depend on; spin down infra.

After Phase 6 → backlog (i18n, landing/marketing site, the small set
of conditional CAPABILITIES.md rows that turned out to matter).

Open work spilled out of earlier phases (not blocking P6, fold into the
next relevant chunk):

- **Carrier adapter** — `defaultCarrierClientFactory` still throws.
  `packages/capabilities/src/shipment/carrier.ts` defines the seam;
  v1's `lib/shipping/carriers/yuntrack.ts` is the port reference.
- **TikTok `getUserPosts` adapter** — `defaultTikTokFetcherFactory.getUserPosts`
  still throws. Sourcing already uses `searchUsers` + `getUserInfo` from the
  same fetcher; `getUserPosts` is the additional method the post-poller calls.
- **Pause/resume wiring** — Phase 4 ships only the cancel switch (P4
  codex P1#1). Pause/resume needs every long `step.waitForEvent` in
  creator-track + shipment-tracking-poller to also cancel on
  `CampaignPaused` with a resumability contract.
- **Full live demo script** — credentialed end-to-end (real LLM + real
  Gmail + real carrier + real TikTok). Could become a `scripts/`
  helper alongside `scripts/init-indexes.ts`.

### Phase 2 / Phase 3 / Phase 4 sub-tasks (now all ✓, retained for reference)

Per `docs/ROADMAP.md` §"Phase 2"-§"Phase 3". Six chunks per phase; each
~50-80 turns; commit per sub-task.

| Chunk | Scope | New env needed for full demo |
|---|---|---|
| ~~**P2-C2**~~ ✓ | `gmail.send` + `templates.render` capabilities — token-manager + OAuth refresh ported; tracking pixel + unsubscribe footer + `sendAt` scheduling + spam-score pre-check all wired through the injectable `GmailClient` seam. **Live demo still needs**: a Phase-2 follow-up to fill `defaultGmailClientFactory` with `googleapis` + provide `GOOGLE_CLIENT_ID/SECRET` and a Gmail-connected user token. Tests are credential-free via the fake seam. | `GOOGLE_CLIENT_ID/SECRET`, Gmail OAuth scopes, `EMAIL_UNSUBSCRIBE_HMAC_SECRET` (≥16 chars) |
| ~~**P2-C3**~~ ✓ | `outreach-writer` agent — v1's `lib/cold-mail` discipline (extractFacts → angle plan → 4-judge tournament with revision) reshaped into a v2 single-agent runtime with curated deterministic tools (`outreach.extractFacts`, `outreach.judge`, `templates.render`). Golden tests verify tool-call order, judge weights, and `insufficient_context` escalation. **Live demo still needs**: `ANTHROPIC_API_KEY` so the actual Opus 4.7 model runs the tournament — and (optional) a Phase-2 follow-up that swaps the deterministic skeptic/conversion/brand judges for LLM-backed variants. | `ANTHROPIC_API_KEY` for live |
| ~~**P2-C4**~~ ✓ | Split into two agents so the model bill scales with what each inbound needs: `conversationAgent` (Haiku, no tools) classifies + extracts on every inbound; `conversationResponderAgent` (Opus 4.7, tools `[outreach.judge, templates.render]`) runs only when `needsResponseDraft(turn) === true`. 5-scenario golden set pins the branching matrix. **Live demo still needs**: `ANTHROPIC_API_KEY`. | `ANTHROPIC_API_KEY` |
| ~~**P2-C5**~~ ✓ | `creator-track` end-to-end: extractFacts → outreachWriterAgent → approveOutreachSend → gmail.send → 3-day waitForEvent → conversationAgent → branch (agreed / in_conversation / declined / no_response / writer_escalated) → optional responder + approveReplyResponse + gmail.send. brand-campaign now `step.sendEvent`-fans-out one `CreatorTrackStart` per confirmed creator and advances stage to `outreach`. **Live demo still needs**: `ANTHROPIC_API_KEY`, `EMAIL_UNSUBSCRIBE_HMAC_SECRET` (≥16 chars), Gmail OAuth wired (P2-C2 follow-up), and a real creator-email source (Phase 5 enrichment). Without enrichment, every track terminates as `no_email` cleanly. | `ANTHROPIC_API_KEY`, `EMAIL_UNSUBSCRIBE_HMAC_SECRET`, Gmail OAuth |
| ~~**P2-C6**~~ ✓ | `/approvals/[id]` drill-ins for `outreach_send` (OutreachDraft preview + 4 judge meters + editable subject/body + sandboxed-iframe HTML preview) and `reply_response` (split: ConversationTurn escalation view vs editable responder draft). `resolveAction` learns `approveEdited` for the workflow's gate() editedPayload path. Policy editor unblocks `approveOutreachSend` (spamScoreGte / followerCountGte) and `approveReplyResponse` (proposedRateUsdGte / replyClassIn multi-select). Canvas reflects `CreatorTrack.state` aggregate buckets: outreach-writer node lights as tracks fan out, wait-reply node shows waiting count, outreach→shipping edge activates on `agreed` tracks. **Live demo still needs**: nothing new beyond C5's prereqs. Note: `/threads/[id]` manual-reply page is deferred to P2.5 — the reply_response drill-in surfaces the same data plus the approveReplyResponse action for the workflow path. | — |
| ~~**P2-C7**~~ ✓ | Gmail Pub/Sub webhook produces `gmail/reply.received`: verify → parse envelope → listHistory + getMessage via GmailClient seam → join v2_outbox by threadId → emit. `verifyPubSubAuth` + `parsePubSubMessage` ported into `@ss/capabilities/gmail/pubsub`. Daily `gmail-watch-renew` cron + `v2_gmail_watches` collection. `suppression.check` / `.add` capabilities + workspace-scoped `v2_suppression_list`; gmail.send refuses pre-send when recipient is on the list. `/unsubscribe` page (HMAC token verify → suppressionAdd; ok / ok_no_email / 5 error states). **Live demo still needs**: `GMAIL_PUBSUB_TOKEN`, a Pub/Sub topic+subscription pointing at `/api/webhooks/gmail`, plus the P2-C2 follow-up that fills `defaultGmailClientFactory` with the `googleapis` SDK + GOOGLE_CLIENT_ID/SECRET + `googleapis`-backed `getMessage`/`listHistory`/`renewWatch` implementations. Phase-2.5 backlog: Resend bounce webhook, MC `/threads/[id]` manual-reply page. | `GMAIL_PUBSUB_TOKEN`, Pub/Sub topic, googleapis SDK |
| ~~**P3-C1**~~ ✓ | `Shipment` contract (port of v1 `~/social-seeding/src/types/shipping.ts` trimmed for seeding) + `v2_shipments` collection + `shipmentRepo` (create / get / findByCreatorTrack / listByCampaign / claim / appendTrackingEvent / finalizeShipped / touchLastTrackedAt). | — |
| ~~**P3-C2**~~ ✓ | `shipment.create` (atomic claim against E11000 on unique `creatorTrackId` index — codex P1#2) + `shipment.track` (chronological event sort + `lastTrackedAt` watermark always bumped — codex P2#4) + `CarrierClient` factory seam. Production binds yuntrack once `YUNTRACK_API_KEY` is set; tests inject fakes. | `YUNTRACK_API_KEY` |
| ~~**P3-C3**~~ ✓ | `logisticsAgent` (Haiku, tools `[shipment.create]`, $0.08 cap) — parses raw free-form addresses (Korean / English mixed) into the `ShippingAddress` schema, then invokes `shipment.create`. Escalates on `address_unparseable` / `missing_required_field`. 3 golden scenarios pin parse / escalation paths. | `ANTHROPIC_API_KEY` for live |
| ~~**P3-C4**~~ ✓ | `tiktok-post-poller` daily cron (02:00 UTC) — walks `v2_creator_tracks` with `state=delivered + content` empty, calls `TikTokFetcher.getUserPosts` (creator's `uniqueId`, resolved via `creatorRepo.getById` — codex P1#1), matches against the brief hashtags + brand keywords, emits `tiktok/post.detected`. 14-day-no-post timeout escalates the track. 8-test suite covers the matrix. | `RAPIDAPI_KEY_TIKTOK` for live |
| ~~**P3-C5**~~ ✓ | `contentVerifyAgent` (Haiku, no tools, $0.05 cap) — given the detected post + brief + creator baseline, returns `{matches, mentionsBrand, performanceScore, flags, rationale}`. 5-scenario golden set (verified / off-topic / no-brand-mention / borderline / sponsored-disclosure-only). | `ANTHROPIC_API_KEY` for live |
| ~~**P3-C6**~~ ✓ | `creator-track`'s `interested + shippingAddress` branch now runs `runShippingAndContentReview`: gate(approveShipment) → runAgent(logisticsAgent) → state="shipped" → waitForEvent(`shipment/tracking.updated`, terminal-status filter — codex P3-full P1#2, 14d timeout) → delivered? then waitForEvent(`tiktok/post.detected`, 14d timeout) → runAgent(contentVerifyAgent) → terminal `verified` / `flaked` / `shipment_failed`. Track stage now derives from state. 7 new test scenarios. | — |
| ~~**P3-C7a-d**~~ ✓ | MC drill-ins for the new gate + the new state: `/approvals/[id]` learns the `shipment` kind (parsed address preview, products list, follower-count display + edit-and-approve); `/campaigns/[id]/shipments` list view (status badges, tracking links); `/campaigns/[id]/posts` content-review view + the `CreatorTrack.content` snapshot field that backs it; `/policies` unblocks `approveShipment` (`auto_unless` + `followerCountGte` knob); canvas reflects shipping / content state buckets. | — |
| ~~**P3 codex review**~~ ✓ | 2 full passes against the 14-commit P3 delta surfaced 9 issues; all fixed in 4 commits across `b2334c4` / `859442a` / `a2870cd` / `497c2f2` / `70313dd` with regression tests. See §1 above for the per-finding breakdown. | — |
| ~~**P4-C1**~~ ✓ | `analytics.compile` capability + `AnalyticsReport` contract. Pure aggregation over v2_campaigns + v2_cost_ledger: funnel (13 buckets per CreatorTrack.state) + goals (target vs actual, days-to-deadline) + reach (verified-track engagement sums + weighted ER) + performance (mean/median score, top performer) + cost (spent + budget %) + 6 deterministic ReportFlags. No LLM. 16 tests. | — |
| ~~**P4-C2**~~ ✓ | `analyst` agent (Haiku, no tools, $0.10 cap). Takes the AnalyticsReport + brief + optional creatorHandle map; returns `{summary, highlights, concerns, recommendations, markdown}`. Concerns map 1:1 to fired report flags (+ at most 1 qualitative concern); recommendations are 1-3 concrete next-campaign actions. 7 tests (3 unit + 4 golden archetypes: goal_met / underperformed / budget_exceeded / in_flight). | `ANTHROPIC_API_KEY` for live |
| ~~**P4-C3**~~ ✓ | `report-deliver` workflow + weekly `report-deliver-cron` (Mon 09:00 UTC) + `Report` contract + `reportRepo` + V2_REPORTS collection (campaignId+generatedAt + workspaceId+generatedAt indexes). Pipeline: load-campaign → compile-analytics → analyst-narrative → persist-report (with random 24-byte URL-safe shareToken) → emit `report/delivered`. Append-only audit log. Concurrency=1 keyed on campaignId. Analyst escalation throws AnalystEscalatedError so Inngest retries (codex P2#3). 12 tests (5 workflow + 7 cron). | — |
| ~~**P4-C4**~~ ✓ | `campaign-progression` daily cron (03:00 UTC). Closes the two lifecycle transitions brand-campaign doesn't hold state for: outreach → performance (when all tracks terminal: emit report request if verified > 0, else patchStatus(completed) directly) and performance → completed (when any report row exists). Idempotent at the query (status='running' filter). 8 tests. | — |
| ~~**P4-C5**~~ ✓ | MC `/campaigns/[id]/report` (4-tile analytics strip + summary + 3-column highlights/concerns/recommendations + markdown + history drawer + "🔄 새 리포트 생성" server action). Public `/share/[id]?t=<token>` page — constant-time-compared via `timingSafeEqual` (Buffer-pad-then-compare to avoid length leak); render the brand + 3-tile stats + summary + markdown, strips operator-only data. | — |
| ~~**P4-C6**~~ ✓ | `/usage` cost dashboard (MTD + 30d + per-agent + per-campaign rollups over v2_cost_ledger; cost-per-verified-post column makes "is this efficient?" concrete). 1-click autonomy preset on `/policies` (copilot / checkpointed / autonomous mass-set the 5 gates). Working kill switch on `/campaigns/[id]` (emits `campaign/cancelled`; brand-campaign's `cancelOn` already wired it). Pause/resume deferred to Phase 4.5 (codex P1#1). | — |
| ~~**P4 codex review**~~ ✓ | 1 pass against the 6-commit P4 delta surfaced 4 issues (1 P1 + 3 P2); all fixed in `5e047c2`: pause hidden (P1#1), preset forms unnested (P2#2), analyst escalation throws (P2#3), MTD window honest on day 31 (P2#4). | — |
| ~~**P5-C1**~~ ✓ | `Lead` + `LeadCampaign` contracts + `LeadEnrichment` (verbatim v1 K-beauty K-pop fields) + `LeadResearch`. `leadRepo` (create / get / findBySharedAccountId / listByWorkspace / patchEnrichment / patchResearch / patchStage) + `leadCampaignRepo`. V2_LEADS + V2_LEAD_CAMPAIGNS collections + 3 indexes (workspaceId+updatedAt, workspaceId+sharedAccountId UNIQUE-on-exists partial, brief.workspaceId+updatedAt). `CrmEnrichClient` factory seam (Modal crawl + Kimi analyze; production binds env, tests inject fakes; v1's ANALYSIS_PROMPT verbatim). `crm.enrich` capability (crawl → analyze → schema-validate → optionally persist; promotes first crawled email to lead.contactEmail). `crm.search` capability (v2_leads + shared crm_accounts dedupe, regex-escaped query, soft-delete-aware). 13 tests. | `MODAL_CRAWL_URL`, `KIMI_API_KEY` for live |
| ~~**P5-C2**~~ ✓ | `research` agent (Haiku, no tools, $0.10 cap). Takes LeadCampaignBrief + LeadEnrichment + lead {name+url+country}; emits `{pitch, angles[1-5], groundedFacts[0-8], contactProfile, confidence}`. Prompt enforces "enrichment is DATA"; escalates via `{escalate: "enrichment_too_thin: …"}` when ≥4 of 6 analysis fields are 'unclear'. 4 tests. | `ANTHROPIC_API_KEY` for live |
| ~~**P5-C3**~~ ✓ | `lead-outreach-writer` agent (Opus 4.7, tools [outreach.judge, templates.render], $1.20 cap — B2B sibling of Phase-2 writer, same OutreachDraft output). `lead-campaign` parent workflow (import → per-lead enrich + research → fan out one `lead-track` per researched lead, capped at brief.outreach.maxSendsPerBatch). `lead-track` child workflow (writer → approveOutreachSend gate → gmail.send → 3d reply wait → conversation classifier → branch: interested/needs_info → responder + reply gate + send; negotiating → always_ask escalate; declined/unsubscribe → 'declined' + suppression.add; not_now/OOO/unrelated → 'no_response'). 4 tests. | `ANTHROPIC_API_KEY`, Gmail OAuth (P2 prereqs) |
| ~~**P5-C4**~~ ✓ | MC surfaces: `/leads` (per-campaign table + recent-leads table), `/leads/new` (LeadCampaignBriefSchema form + paste-list textarea, server action emits `lead-campaign/submitted`), `/leads/[id]` (9-column funnel strip imported → flaked + per-lead leaderboard with priority + confidence badges + pitch/summary preview). Sidebar adds "리드 (B2B)" as the 2nd PRIMARY nav item. | — |
| ~~**P5 codex review**~~ ✓ | 1 pass against the 4-commit P5 delta surfaced 4 issues (2 P1 + 2 P2); all fixed in `1a8335e`: gmail.send shape (P1#1), crawled-email promote (P1#2), batch cap honored (P2#3), regex special chars escaped (P2#4). 3 regression tests. | — |

After Phase 5 → Phase 6 (cutover: migrate v1 workspaces, retire v1
backend, sweep remaining admin views). See `docs/ROADMAP.md`.

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
