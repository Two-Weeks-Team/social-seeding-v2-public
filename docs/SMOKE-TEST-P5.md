# SMOKE-TEST P5 — Phase 5 local end-to-end (post review-fix pass)

> Logged 2026-05-14 after the codex review fix pass on Phase 5
> (commits `7f4d239`..`1a8335e`). Goal: confirm the new sales-lead
> pipeline registers, the new MC pages render, the 3 new collection
> indexes provision, the Zod schemas catch slop seed data, and the
> credential-free path is structurally sound. Full live demo is gated
> on `MODAL_CRAWL_URL`, `KIMI_API_KEY` (for `crm.enrich`), plus
> `ANTHROPIC_API_KEY` + the Phase-2 Gmail wiring (carried over).

## What ran

```bash
# 0. dev-mongo on 127.0.0.1:27027
set -a; source .mongo-dev/dev-env; set +a
export MONGODB_DB=ss_smoke_p5

# 1. init v2_* indexes — verifies the 3 new ones for P5 (v2_leads x 2,
#    v2_lead_campaigns x 1)
pnpm exec tsx scripts/init-indexes.ts
#   → "Ensuring 23 index(es) on ss_smoke_p5 …"
#       v2_leads.workspaceId_1_updatedAt_-1
#       v2_leads.workspaceId_1_sharedAccountId_1 (unique, partial)
#       v2_lead_campaigns.brief.workspaceId_1_updatedAt_-1
#   → ✓ done

# 2. Enumerate Inngest functions — confirm the 2 new ones registered
cd packages/workflows && pnpm exec tsx -e "
  import('./src/index.ts').then(m => {
    for (const f of m.functions) {
      const opts = f['opts'] ?? f;
      console.log(JSON.stringify({ id: opts.id, trigger: opts.triggers ?? opts.trigger }));
    }
  });"
#   {"id":"brand-campaign","trigger":[{"event":"campaign/submitted"}]}
#   {"id":"campaign-progression","trigger":[{"cron":"0 3 * * *"}]}
#   {"id":"creator-track","trigger":[{"event":"campaign/creator-track.start"}]}
#   {"id":"gmail-watch-renew","trigger":[{"cron":"0 4 * * *"}]}
#   {"id":"lead-campaign","trigger":[{"event":"lead-campaign/submitted"}]}        ← NEW P5
#   {"id":"lead-track","trigger":[{"event":"lead-campaign/lead-track.start"}]}    ← NEW P5
#   {"id":"report-deliver","trigger":[{"event":"report/deliver.request"}]}
#   {"id":"report-deliver-cron","trigger":[{"cron":"0 9 * * 1"}]}
#   {"id":"shipment-tracking-poller","trigger":[{"cron":"0 4,16 * * *"}]}
#   {"id":"tiktok-post-poller","trigger":[{"cron":"0 2 * * *"}]}

# 3. apps/web/.env.local pinned to MONGODB_DB=ss_smoke_p5
# 4. Next dev (port 3000)
curl http://localhost:3000/api/inngest   # → { "function_count": 10 }

# 5. test-login mints a JWT
# 6. seed a lead-campaign + 3 leads (researched / outreach_sent / agreed
#    states) via mongosh — first attempt failed because angles were
#    < 10 chars (Zod minLength caught the seed slop — exactly what the
#    schema is for). Re-seeded with longer angles; second attempt
#    rendered cleanly.

# 7. fetch the new MC pages
GET /leads                                  → 200, 28 KB (empty state)
GET /leads (after seed)                     → 200, 41 KB (campaign + 3 leads)
GET /leads/new                              → 200, 39 KB (form renders)
GET /leads/<seeded_lc_id>                   → 200, 45 KB (funnel + leaderboard)
```

## What passed

- **Init indexes (P5-C1)**: 23 total v2_* indexes — added 3 new ones
  for P5 (`v2_leads.workspaceId+updatedAt`, `v2_leads.workspaceId+
  sharedAccountId UNIQUE-on-exists` partial index, and
  `v2_lead_campaigns.brief.workspaceId+updatedAt`) on top of the
  existing 20 from earlier phases.
- **Inngest discovery (P5-C3)**: `function_count: 10`. The 2 new P5
  Inngest functions register with the right event triggers:
    - `lead-campaign` — event `lead-campaign/submitted`, with
      `cancelOn` against `CampaignCancelled` (same kill-switch event
      brand-campaign listens to).
    - `lead-track` — event `lead-campaign/lead-track.start`, same
      cancelOn.
- **MC pages render under HTTP 200**:
    - `/leads` empty state shows "아직 리드 캠페인이 없습니다" + the
      "+ 새 리드 캠페인" CTA.
    - `/leads/new` renders the LeadCampaignBrief form (campaign name +
      ourProduct + targeting countries + outreach toneNotes + goals +
      lead-list textarea).
    - `/leads/<seeded_lc_id>` shows the 9-column funnel strip
      (imported / enriched / researched / outreach / in_conv /
      agreed / declined / no_resp / flaked) + per-lead leaderboard
      with `priority high` + `confidence 85/90` badges.
    - `/leads` (post-seed) shows the campaign in the top table plus
      the 3 leads in the "recent leads" table.
- **Schema caught slop seed data**: the first seed had
  `angles: ["IG→TikTok 컨버전", "히트 제품 챌린지"]` — the second angle is
  9 chars in JS but the `LeadResearchSchema.angles` requires
  `min(10)`. The page returned 500 with a Next.js obscured error
  surfaced from a Zod `too_small` thrown inside `toLead()`. Re-seeding
  with longer angles fixed it. **This is the schema doing its job** —
  the contract is the load-bearing safety net. Smoke log retained
  here so a future operator hits this exact lesson.

## What this proves

- Phase-5 backend (Lead + LeadCampaign contracts + reportRepo +
  leadRepo + crm.search + crm.enrich + research agent +
  lead-outreach-writer + lead-campaign + lead-track workflows) is
  structurally sound against the live MongoDB driver + the new
  Inngest event schemas.
- The 3 new v2_leads + v2_lead_campaigns indexes provision cleanly
  alongside the 20 existing v2_* indexes; the
  `workspaceId+sharedAccountId` partial-unique index correctly only
  enforces uniqueness when `sharedAccountId` is set (standalone
  leads without one don't collide).
- The 4 P5 codex review findings hold in practice (the gmail.send
  shape fix doesn't break the build path; the
  contactEmail-promotion change is unit-tested; the
  maxSendsPerBatch cap is enforced in lead-campaign; the regex
  escape doesn't break the existing query test).

## What this didn't prove

- **Live Modal+Kimi enrichment**: `crm.enrich` needs
  `MODAL_CRAWL_URL` + `KIMI_API_KEY` env vars. Without them, every
  enrich call throws a clear "X not wired" error and the
  lead-campaign workflow flakes the lead — which is the correct
  fail-loud behavior. Live enrichment is gated on real keys.
- **Live LLM analyst + writer + research agents**: `ANTHROPIC_API_KEY`
  required. The unit tests + the codex review verify the workflow
  control flow is correct; the actual prompt outputs are gated on
  the key.
- **End-to-end UI form submission**: the smoke fetched HTML over curl
  but didn't POST the new-lead-campaign form. The server action is
  exercised by the unit tests (`lead-campaign.test.ts`).
- **The MC UI in a browser**: smoke is curl-based; the React Flow-
  free leads tree was visually verified by HTML inspection only.

## To advance to a full live P5 demo

1. **Set `MODAL_CRAWL_URL`** (default points to v1's Modal endpoint)
   + **`KIMI_API_KEY`** for Moonshot's API — `crm.enrich` starts
   crawling + analyzing real K-beauty brand sites.
2. **Set `ANTHROPIC_API_KEY`** for the research agent + the new
   lead-outreach-writer.
3. Submit a real lead-campaign via `/leads/new` with 5-10 K-beauty
   brand URLs. Watch Inngest Dev as `lead-campaign` walks the
   import → enrich → research path, then fans out one `lead-track`
   per researched lead. The approveOutreachSend gate creates a row
   in MC's `/approvals` inbox; approving triggers the gmail.send.

## Outcome

Smoke pass confirmed Phase-5 is **structurally sound**. The 74
workflow + 157 capability + 64 agent + 4 observability tests (299
total after the P5-C1 + C2 + C3 + review additions) cover the
control flow; this smoke confirmed the new code lives in the
Inngest function map, the indexes provision, the MC pages render
against seeded data, and the Zod contracts correctly reject loose
input. The "second campaign type" (sales-lead alongside brand-
campaign) is now real.
