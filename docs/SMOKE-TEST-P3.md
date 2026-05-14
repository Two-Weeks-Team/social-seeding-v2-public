# SMOKE-TEST P3 — Phase 3 local end-to-end (post review-fix pass)

> Logged 2026-05-14 after the codex review fix pass on Phase 3 (commits
> `859442a`..`70313dd`). Goal: confirm the new shipment-tracking-poller
> cron + the carrier/post wiring registers, the new MC pages render, and
> the v2_shipments indexes provision cleanly. Credentialed/full-loop smoke
> (real carrier + LLM + Gmail) is still gated on `YUNTRACK_API_KEY` +
> `ANTHROPIC_API_KEY` + the Phase-2 Step-D googleapis wiring.

## What ran

```bash
# 0. dev-mongo already running on 127.0.0.1:27027 (see HANDOFF §2)
set -a; source .mongo-dev/dev-env; set +a
export MONGODB_DB=ss_smoke_p3        # isolate from earlier smoke runs

# 1. init v2_* indexes — verifies the 3 new v2_shipments indexes (P3-C1)
pnpm exec tsx scripts/init-indexes.ts
#   → "Ensuring 18 index(es) on ss_smoke_p3 …"
#       v2_shipments.campaignId_1_updatedAt_-1
#       v2_shipments.creatorTrackId_1 (unique)
#       v2_shipments.trackingNumber_1
#   → ✓ done

# 2. apps/web/.env.local seeded from .env.local + MONGODB_DB=ss_smoke_p3 pin
cp .env.local apps/web/.env.local
echo "MONGODB_DB=ss_smoke_p3" >> apps/web/.env.local

# 3. Next dev (port 3000)
pnpm --filter @ss/web dev   # ✓ Ready in 309ms

# 4. Inngest function discovery — confirm shipment-tracking-poller registered
curl -fsS http://localhost:3000/api/inngest
#   → { "function_count": 5, ... }

# 5. Enumerate functions via the SDK directly (curl only returns the count)
cd packages/workflows && pnpm exec tsx -e "
  import('./src/index.ts').then(m => {
    for (const f of m.functions) {
      const opts = f['opts'] ?? f;
      console.log(JSON.stringify({ id: opts.id, trigger: opts.triggers ?? opts.trigger }));
    }
  });"
#   {"id":"brand-campaign","trigger":[{"event":"campaign/submitted"}]}
#   {"id":"creator-track","trigger":[{"event":"campaign/creator-track.start"}]}
#   {"id":"gmail-watch-renew","trigger":[{"cron":"0 4 * * *"}]}
#   {"id":"shipment-tracking-poller","trigger":[{"cron":"0 4,16 * * *"}]}   ← NEW P3
#   {"id":"tiktok-post-poller","trigger":[{"cron":"0 2 * * *"}]}            ← NEW P3

# 6. mint a session
curl -X POST http://localhost:3000/api/auth/test-login \
  -H "content-type: application/json" -d '{"secret":"$AUTH_TEST_LOGIN_SECRET"}' \
  -c /tmp/ss-cookies.txt
#   → 200 + JWT, ss_session cookie

# 7. seed a minimal v2_campaigns row so the new pages have something to render
mongosh "mongodb://127.0.0.1:27027/ss_smoke_p3" <<'SCRIPT'
db.v2_campaigns.insertOne({
  brief: { workspaceId: "ws_test", createdBy: "tu_…", brandProduct: {…},
           targeting: {…}, logistics: { shipsSamples: true }, goals: {…} },
  status: "running", stage: "outreach", tracks: [],
  createdAt: new Date(), updatedAt: new Date()
});
SCRIPT

# 8. fetch the new MC pages
curl -fsS -b /tmp/ss-cookies.txt /campaigns/{id}/shipments  # → 200 28263 bytes
curl -fsS -b /tmp/ss-cookies.txt /campaigns/{id}/posts      # → 200 28060 bytes
curl -fsS -b /tmp/ss-cookies.txt /policies                  # → 200 68786 bytes
```

## What passed

- **Init indexes (P3-C1)**: `v2_shipments` got all 3 indexes — the unique
  `creatorTrackId_1` is the load-bearing one for the atomic-claim pattern in
  `shipment.create` (codex P1#2 fix). 18 total v2 indexes across the
  collection set.
- **Inngest discovery (P3-C4 + P3-full P1#1)**: `function_count: 5`. The two
  new P3 functions register with the right cron schedules:
    - `shipment-tracking-poller` → `0 4,16 * * *` (12-hour cadence, producer
      for `shipment/tracking.updated`)
    - `tiktok-post-poller` → `0 2 * * *` (daily, producer for
      `tiktok/post.detected`)
- **Auth**: `/api/auth/test-login` minted a JWT against the smoke DB.
- **MC Phase-3 pages (P3-C7b–d)**:
    - `/campaigns/{id}/shipments` → 200 (28 KB, empty state — no shipments
      seeded, expected).
    - `/campaigns/{id}/posts` → 200 (28 KB, empty state).
    - `/policies` → 200 (68 KB) and the HTML contains
      `approveShipment` + `followerCountGte` + `auto_unless` — confirms
      P3-C7d unblocked the gate's policy controls and the predicate knob is
      now editable in the UI.

## What this proves

- The new Phase-3 wiring (shipment-tracking-poller cron, shipment indexes,
  MC drill-ins) is structurally sound under Turbopack + the live MongoDB
  driver. Inngest discovers all 5 functions including the new producer.
- The `approveShipment` policy gate is no longer a placeholder in the UI:
  the policy editor exposes `mode` + `followerCountGte` — closes the loop
  with the codex P3-full P1#3 fix that put `followerCount` on the
  recommendation payload so the predicate can actually evaluate.
- A campaign row + the two new pages survive the round-trip from
  MongoDB → Next.js RSC → HTML without crashing on missing related rows
  (empty `v2_shipments` / no `v2_creator_tracks` entries with `content`).

## What this didn't prove

- **The full P3 happy-loop**: outreach reply → ship → carrier delivered →
  post detected → content-verified. That needs:
    - `ANTHROPIC_API_KEY` (sourcing / writer / classifier / responder /
      logistics / content-verify agents)
    - `GOOGLE_CLIENT_ID/SECRET` + a real Gmail OAuth user token (gmail.send
      + Pub/Sub reply ingestion; the Step-D googleapis wiring from P2 is
      in place)
    - `YUNTRACK_API_KEY` (or equivalent) for `defaultCarrierClientFactory` —
      currently throws "carrier not wired" without it
    - `RAPIDAPI_KEY_TIKTOK` (or v1's TikTok proxy) for the post-poller's
      `defaultTikTokFetcherFactory`
- **The shipment-tracking-poller actually polling**: the cron fires
  at 04:00 + 16:00 UTC; smoke just verified it registered. Inngest Dev
  Server's manual-trigger UI can drive it on demand, but with no shipments
  seeded the run is a no-op.
- **The MC UI in a browser**: smoke fetched the HTML over curl. The
  React Flow canvas + new shipment/post views weren't visually verified.

## Environment gotcha (carried from P2 smoke)

The Phase-2 smoke log called out a stale `next-server` from a sibling
`~/social-seeding-v3` repo hijacking `:3000`. For this smoke that other
process was no longer running; `lsof -nP -iTCP:3000 -sTCP:LISTEN` came up
empty before `pnpm --filter @ss/web dev` started. Still worth checking
before any future smoke.

## To advance to a full live P3 demo

1. **Set `YUNTRACK_API_KEY`** + flesh out `defaultCarrierClientFactory`
   (currently throws `"carrier not wired"`) — mirror v1's
   `lib/shipping/carriers/yuntrack.ts` adapter against the v2
   `CarrierClient` interface. The contract is already there
   (`packages/capabilities/src/shipment/carrier.ts`).
2. **Set `RAPIDAPI_KEY_TIKTOK`** + flesh out `defaultTikTokFetcherFactory`
   for `getUserPosts` (used by `tiktok-post-poller`). Sourcing already
   has this in P1; `getUserPosts` is the additional method.
3. Trigger the full loop end-to-end on a real campaign — submit a brief,
   approve the shortlist, let the outreach run send a real email, reply
   to it with an address, watch the workflow advance into the shipping
   leg, manually drive the carrier-poller via Inngest Dev to a delivered
   status, then emit a `tiktok/post.detected` event to drive content-
   verify. (A scripted version of this end-to-end is a P3.5 follow-up.)

## Outcome

Smoke pass confirmed Phase-3 is **structurally sound**. The 50 workflow +
126 capability + 53 agent unit/integration tests cover the logic; this
smoke confirmed the new code actually links + serves + lives in Inngest's
function map. The remaining gaps are credential / SDK wiring, not code.
