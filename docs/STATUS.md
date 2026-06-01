# STATUS — social-seeding-v2 final state

> Snapshot 2026-05-14, commit `351a734`. This doc is the one-screen
> "where everything stands" for the next person picking the project up.

## Goal (carried from README §1)

> v2 makes **the agent the operator**. The human gives a campaign brief;
> a team of specialized agents runs the loop (source → vet → outreach →
> reply-handling → ship → verify content → report). The human only
> steps in at the policy gates they choose to keep on.

## What's done

| Layer | Status |
|---|---|
| **Phase 0 — Foundation** (monorepo, Inngest, capabilities runtime, Auth, observability) | ✓ |
| **Phase 1 — Sourcing + Vetting** (intake → sourcing agent → vetting fan-out → shortlist gate) | ✓ |
| **Phase 2 — Outreach + Reply-handling** (writer w/ 4-judge tournament → gmail.send → 3d reply wait → conversation classifier + responder) | ✓ |
| **Phase 3 — Shipping + Content-verification** (logistics agent → shipment.create → carrier-poll → tiktok-post-poller → content-verify agent) | ✓ |
| **Phase 4 — Analyst + MC final pass** (analytics.compile → analyst agent → report-deliver workflow + weekly cron + manual MC button → /share/[id] public preview → /usage cost dashboard → autonomy presets → kill switch) | ✓ |
| **Phase 5 — Sales-lead campaign type** (crm.search + crm.enrich via Modal+Gemini → research agent → lead-outreach-writer → lead-campaign + lead-track workflows → MC /leads tree) | ✓ |
| **Phase 6 C1 — v1→v2 workspace importer** (read-only on shared `workspaces`; additive `$setOnInsert` on v2_workspace_policies; canceled + cleanupMutationAt filtered; --dry-run + --include-canceled) | ✓ |
| **Phase 6 C2 — v2Enabled rollout flag** (additive write on shared `workspaces`; MC `/policies` toggle gated on owner/admin role) | ✓ |
| **Carry-over: TikTok getUserPosts adapter** (RapidAPI; `mapRapidApiPosts` defensive across 4+ provider shapes) | ✓ |
| **Carry-over: TikTok getUserInfo adapter** (same RapidAPI seam; finishes `tiktok.getCreator`'s missing/stale-row branch) | ✓ |
| **Carry-over: pause/resume wiring** (`pauseCheck(step, campaignId)` at every gmail.send site in creator-track + lead-track; UI button re-enabled) | ✓ |
| **Carry-over: end-to-end demo runner** (`scripts/run-demo.ts --type=brand\|lead`; per-type env-check matrix; 5-min progress poll) | ✓ |

## Numbers

- **109 commits** since the scaffold (`66f4390`).
- **`pnpm run verify-build` green** (lint → next build → tsc --noEmit across 7 packages, FULL TURBO).
- **449 TS tests** pass: 77 web · 64 agents · 191 capabilities · 113 workflows · 4 observability (+ 2932 agents-adk pytest).
- **10 Inngest functions** registered: brand-campaign / creator-track / lead-campaign / lead-track / report-deliver / report-deliver-cron / campaign-progression / shipment-tracking-poller / tiktok-post-poller / gmail-watch-renew.
- **23 MongoDB indexes** on the v2_* collections (`scripts/init-indexes.ts`).
- **6 SMOKE-TEST docs** logging credential-free end-to-end smokes per phase: `docs/SMOKE-TEST.md` (P2), `-P3.md`, `-P4.md`, `-P5.md`, `-P6.md`.
- **7 codex review fix passes** — every P1/P2 finding addressed with regression tests.

## Live-demo readiness — what each credential unlocks

| Env var | Required for | What stops working without it |
|---|---|---|
| `MONGODB_URI` | Every path | Nothing runs |
| `AUTH_SECRET` + `AUTH_TEST_LOGIN_*` | MC sessions | Can't sign in to MC |
| `GEMINI_API_KEY` | Every agent (sourcing / writer / classifier / responder / logistics / content-verify / analyst / research / lead-outreach-writer) — `gemini-3.5-flash` + `gemini-3.1-flash-lite`, D53 | Workflows throw at the first agent call (`runAgent` raises "GEMINI_API_KEY is not set") |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + OAuth flow + `EMAIL_UNSUBSCRIBE_HMAC_SECRET` (≥16 chars) | `gmail.send` (outreach + replies) | Workflows reach the send step then throw "Gmail not wired" |
| `GMAIL_PUBSUB_TOKEN` + GCP Pub/Sub topic | Inbound replies | Reply waits time out at 3d |
| `RAPIDAPI_KEY_TIKTOK` | TikTok creator + post fetches | Sourcing falls back to Atlas Search on v1 data; post-poller throws |
| `GEMINI_API_KEY` + `MODAL_CRAWL_URL` | `crm.enrich` (lead-campaign) — analysis on gemini-3.5-flash (D53; was Kimi) | Lead workflow flakes leads at enrich step |
| **`YUNTRACK_API_KEY` + carrier adapter (deferred)** | Live shipments | Phase 3 shipping leg can't actually ship — workflow flakes |

## Explicit deferrals

1. **Carrier adapter (yuntrack)** — operator decision 2026-05-14: skip per priority (TikTok adapter + pause/resume + demo runner were higher-leverage). The `CarrierClient` seam is in place; `defaultCarrierClientFactory` throws clearly until wired. v1's `lib/shipping/carriers/yuntrack.ts` is the port reference. Estimated effort: 1 chunk (~2h) once `YUNTRACK_API_KEY` is provided.
2. **Phase 6 C3 — admin views sweep** — operator decision: per-page port-vs-drop call needed. `/admin/usage-dashboard` is already ported as `/usage`. The rest (user-override admin, billing impersonation, …) await a product call.
3. **Phase 6 C4 — retire v1 backend** — operator decision: side-by-side 1-2 months after first migration. Irreversible; needs explicit go-ahead.
4. **pause/resume 30d hard cap visibility** — `pauseCheck` proceeds after a 30-day wait timeout. Operator visibility on a 30d-paused campaign is a follow-up.

## Backlog (not autonomous-doable — needs product calls)

- i18n (multi-language MC + outreach prompts; v1 supported KO/EN).
- Landing / marketing site port (currently in v1; v2 has none).
- Conditional CAPABILITIES.md rows that turned out to matter (decided after dogfooding — see `docs/SCOPE-DECISIONS.md`).

## How to pick this up

```bash
# 1. Pre-flight check (no DB writes) — surfaces what's wired vs what's not.
pnpm exec tsx scripts/run-demo.ts --dry-run --type=brand

# 2. Get the env right. `.env.local` template in .env.example; minimum
#    for a credential-free smoke is just MONGODB_URI + AUTH_SECRET +
#    EMAIL_UNSUBSCRIBE_HMAC_SECRET (≥16 chars).

# 3. Start the local stack.
pnpm run dev-mongo
pnpm exec tsx scripts/init-indexes.ts
pnpm --filter @ss/web dev                       # MC + /api/inngest on :3000
npx inngest-cli@latest dev                      # workflow runtime on :8288

# 4. Run a real campaign end-to-end.
pnpm exec tsx scripts/run-demo.ts --type=brand
# Watch MC at http://localhost:3000/campaigns/<id> + Inngest Dev at
# http://localhost:8288. Resolve gates in /approvals as they appear.

# 5. Try the sales-lead loop too.
pnpm exec tsx scripts/run-demo.ts --type=lead
# /leads/<id> shows the funnel.
```

## When the next phase starts

The next chunk of meaningful work needs **operator decisions**:

1. **Run the actual v1→v2 migration?** — `scripts/import-v1-workspaces.ts --dry-run` against production Atlas tells you what would import. Then live run. Then per-workspace owner clicks "→ v2 활성화" on `/policies`.
2. **Phase 6 C4 retire v1?** — once side-by-side window expires, freeze v1 + retire Modal/Kimi services that v2 no longer needs.
3. **Wire the carrier adapter** — if shipping is on the demo path.
4. **i18n / landing / SCOPE-DECISIONS rows** — scope work needs a product call first.

Until one of those decisions is made, the project sits at a clean
stopping point. The autonomous build is finished.
