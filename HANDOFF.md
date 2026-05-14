# HANDOFF — continuing the v2 build (Claude Code CLI)

> Read this first when you (or a fresh Claude Code session) pick this repo up.
> Last handoff: **Phase 3 all 7 chunks + 2 codex-review fix passes + P3 smoke** — `pnpm run verify-build` is green, 235 tests pass (50 workflows / 126 capabilities / 53 agents / 6 observability).

---

## 1. Current state (commits on `main`, nothing pushed)

```
Phase 0  (foundation, 8 commits)                                      ✓ done
Phase 1  (sourcing+vetting vertical slice, 17 + 1 docs)               ✓ done
Phase 2  C1-C7 + codex-review pass + Step D googleapis (29 commits)   ✓ done
Phase 3  C1 (Shipment contract + v2_shipments + shipmentRepo)         ✓ done
Phase 3  C2 (shipment.create + shipment.track + CarrierClient seam)   ✓ done
Phase 3  C3 (logistics agent — Haiku — parses address + creates ship) ✓ done
Phase 3  C4 (tiktok-post-poller daily cron + post.detected event)     ✓ done
Phase 3  C5 (content-verify agent — Haiku — scores detected posts)    ✓ done
Phase 3  C6 (creator-track shipping + content-review legs wired)      ✓ done
Phase 3  C7a-d (MC shipment + posts drill-ins + policy editor)        ✓ done
Phase 3  codex-review P1-batch (atomic claim, poller uniqueId)        ✓ done
Phase 3  codex-review P2-batch (trust boundary + dedupe + sort)       ✓ done
Phase 3  codex-review P3-full P1+P2 (poller producer + wait filters)  ✓ done
Phase 4  (analyst + ranking polish + MC final pass)                   ⏳ NEXT
```

`git log --oneline` shows ~78 commits since the scaffold (`66f4390`). `pnpm run verify-build` exits 0; 235 tests across `@ss/agents` (53) · `@ss/capabilities` (126) · `@ss/observability` (6) · `@ss/workflows` (50). `docs/PHASE-1-PLAN.md` unchanged (no scope creep).

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

## 4. What's next — Phase 4 analyst + MC final pass

Per `docs/ROADMAP.md` §"Phase 4". Goal: ranking signals + post-campaign
analytics + final MC polish before Phase 5 (sales-lead campaign type) and
Phase 6 (admin / billing rollover). Same discipline as Phases 1-3 (one
commit per task, verify-build green throughout, no scope creep on `docs/`).

Open work spilled out of Phase 3 (not blocking P4, fold into the next
relevant chunk):

- **Carrier adapter** — `defaultCarrierClientFactory` still throws.
  `packages/capabilities/src/shipment/carrier.ts` defines the seam;
  v1's `lib/shipping/carriers/yuntrack.ts` is the port reference.
- **TikTok `getUserPosts` adapter** — `defaultTikTokFetcherFactory.getUserPosts`
  still throws. Sourcing already uses `searchUsers` + `getUserInfo` from the
  same fetcher; `getUserPosts` is the additional method the post-poller calls.
- **Full live P3 demo script** — credentialed end-to-end (real creator
  reply → real shipment → manual Inngest replay to a delivered status →
  emit a `tiktok/post.detected` event → verify). Could become a `scripts/`
  helper alongside `scripts/init-indexes.ts`.

### Phase 2 / Phase 3 sub-tasks (now all ✓, retained for reference)

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

After Phase 3 → Phase 4 (analyst + MC polish), Phase 5 (sales-lead
campaign type — CRM enrichment via Modal + Kimi), Phase 6 (admin / billing
rollover). See `docs/ROADMAP.md`.

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
