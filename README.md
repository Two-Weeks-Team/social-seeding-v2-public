# Social Seeding v2 — agent-orchestrated TikTok influencer campaign operator

<p align="center">
  <a href="https://ss-landing-80064221403.us-central1.run.app/"><img src="https://img.shields.io/badge/LIVE%20DEMO-Cloud%20Run-1A73E8?style=for-the-badge&logo=googlecloud&logoColor=white" alt="Live Demo"/></a>
  <a href="https://github.com/Two-Weeks-Team/social-seeding-v2/pull/1"><img src="https://img.shields.io/badge/PR%20%231-MERGED-34A853?style=for-the-badge&logo=github&logoColor=white" alt="PR #1 MERGED"/></a>
  <a href="./gcp-research/reports/social-seeding-status-2026-05-19.html"><img src="https://img.shields.io/badge/PROGRESS%20REPORT-2026--05--19-7C3AED?style=for-the-badge&logo=googledocs&logoColor=white" alt="Progress Report"/></a>
</p>

<p align="center">
  <em>Google for Startups AI Agents Challenge 2026 — Track 2 (Optimize) + Track 3 (Refactor) dual submission.<br/>
  Deadline 2026-06-05 23:59 PT.</em>
</p>

> Rewrite of [`Two-Weeks-Team/social-seeding`](https://github.com/Two-Weeks-Team/social-seeding) (v1, frozen 2026-05-13 — see that repo's `FREEZE.md`).
>
> **The shift:** v1 was a *tool dashboard* — the human was the operator, clicking through a 6-step workflow board, hand-writing emails, manually advancing stages, with an AI chat bolted on as a read-only "ask my data" sidebar. v2 makes **the agent the operator**: you give it a campaign brief, a team of specialized agents runs the loop (source → vet → outreach → reply-handling → ship → verify content → report), and you only step in at the decision gates you choose to keep on. The dashboard becomes **Mission Control** — a timeline of what the agents did + an approval inbox — not a manual-labor surface.

> **For LLMs picking this up**: jump to [§ For agents picking up the codebase](#for-agents-picking-up-the-codebase). State: `docs/STATUS.md` → `HANDOFF.md` → `CLAUDE.md` → `docs/ARCHITECTURE.md`.
> **For team members**: jump to [§ TL;DR — what's running, what works](#tldr--whats-running-what-works) then [§ An end-to-end run actually looks like this](#an-end-to-end-run-actually-looks-like-this).

---

## Live demo (no install)

Click here to view a 6-minute interactive walkthrough — no signup, no GCP setup, runs entirely in your browser:

👉 **[https://ss-landing-80064221403.us-central1.run.app/](https://ss-landing-80064221403.us-central1.run.app/)**

The demo simulates a real mouse session over Mission Control: brand brief intake → 22-agent fleet → AP2 mandate signing → multimodal creative → reply classification → cost ledger. Toggle 4 locales (ko / en / ja / zh-CN), adjust playback `0.5×` ~ `8×`, jump to any of 24 scenes (Track 2 + Track 3).

> **Hosting**: Cloud Run on `ss-shared-infra` project (D39 GCP credits, us-central1, min=0 / max=10, 256Mi memory). Source: `site/` directory. Manual re-deploy: `cd site && gcloud run deploy ss-landing --source=. --project=ss-shared-infra --region=us-central1 --allow-unauthenticated --quiet`. The Cloud Run service auto-rebuilds the container from `site/Dockerfile` (nginx:alpine static server). Total cost target: < $1/month at demo traffic.

---

## TL;DR — what's running, what works

```
Status        Phases 0–6 shipped (autonomous build, verified by live demo)
Tests         354 vitest passing (4 observability · 64 agents · 183 capabilities · 103 workflows)
Inngest       10 functions registered (brand-campaign, creator-track, lead-campaign,
              lead-track, campaign-progression, gmail-watch-renew, report-deliver,
              report-deliver-cron, shipment-tracking-poller, tiktok-post-poller)
Mongo         23 indexes on 14 v2_* collections + 13 SHARED_* read-only carry-overs from v1
verify-build  green (lint + next build + tsc across 7 packages)
Live demo     2026-05-14/15 — full loop verified end-to-end:
                · brand brief → sourcing agent (Opus) → 4 candidates
                · vetting agent (Opus × 4 fan-out) → 2 shortlisted
                · approveShortlist gate → operator approved
                · creator-track → outreach-writer (Opus tournament) → Korean email
                · approveOutreachSend gate → operator approved
                · gmail.send → ACTUAL email sent (msgId 19e264a093c97c8e)
                · reply received → classify-reply (Haiku, "interested") → respond (Opus)
                · two follow-up emails on the same Gmail thread
                · final reply with shipping address → logistics (Haiku) → shipment.create
                · ↑ deferred at the carrier integration boundary (YUNTRACK)
```

**Next iteration**: v4 ([`Two-Weeks-Team/social-seeding-v4`](https://github.com/Two-Weeks-Team/social-seeding-v4)) — greenfield rewrite that turns the hardcoded Inngest workflows here into editable `WorkflowDefinition` data + a single-page canvas. Phases 0–5 done. v2 remains the **running production demo**.

---

## Quick start

```bash
pnpm install
cp .env.example .env.local            # MONGODB_URI, AUTH_*, ANTHROPIC_API_KEY, GOOGLE_*, INNGEST_*
pnpm run verify-build                  # lint → next build → tsc --noEmit (must stay green)
pnpm run dev-mongo                     # mongodb-memory-server :27027
pnpm exec tsx scripts/init-indexes.ts  # provision v2_* indexes (idempotent)
pnpm --filter @ss/web dev              # Mission Control :3000
npx inngest-cli@latest dev             # workflow runtime :8288

# End-to-end demo:
pnpm exec tsx scripts/run-demo.ts --dry-run --type=brand    # env preflight only
pnpm exec tsx scripts/run-demo.ts --type=brand              # live brand-campaign
pnpm exec tsx scripts/run-demo.ts --type=lead               # sales-lead loop
```

Mission Control:
- `/sign-in` → click "테스트 세션으로 로그인" (dev-only button) → `/campaigns`
- `/campaigns/<id>` → timeline view + approval inbox sidebar
- `/campaigns/<id>?view=canvas` → React Flow workflow visualization
- `/approvals`, `/policies`, `/usage`, `/leads`, `/share/<id>` — operator surfaces

---

## Why a new repo (not a renewal)

v1 accumulated 3 years of strata — multi-SNS→TikTok, Express→Go→Next.js, Polar→NicePay, 4-phase workspace ACL, 5-phase rate limit, i18n pipeline — 266+ API routes, ~100 lib files, migration flags, dual-key helpers, a half-built `workflow-automation.ts` with no durable engine under it, and a Go/LangGraph backend being re-absorbed into Next.js. The *product model itself* ("human = operator") is what needs to change, so we start clean — but **carry the hard-won domain assets** (TikTok ranking algos, the `cold-mail` agent pipeline, Gmail integration, CRM enrichment, billing). See [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) for the v1→v2 mapping.

## Key decisions (2026-05-13)

| Decision | Choice | Rationale |
|---|---|---|
| Orchestration engine | **Inngest** | Serverless/Vercel-friendly durable execution: `step.run` (atomic + retried), `step.sleep` (durable timers — "follow up in 3 days"), `step.waitForEvent` (block on a human approval or a Gmail reply without holding a process). State survives deploys. |
| Autonomy | **Staged** | Ships with every gate ON (`checkpointed`). Owners relax gates one at a time, per workspace → `autonomous`. Gates & budgets live in [`packages/contracts/src/policy.ts`](packages/contracts/src/policy.ts). |
| Database | **Same MongoDB Atlas cluster as v1** | Creator data, campaign history, CRM, blacklist, Gmail tokens carry over with zero migration. v2 reads v1-owned collections and owns new `v2_*` collections. v1 must not make breaking schema changes while both run. |
| Agents | **Claude Agent SDK** | Agents are *functions the workflow invokes* (curated tool set, structured output, budget cap, escalation) — not free ReAct loops. This generalizes v1's `cold-mail` evaluator-optimizer pattern. Model routing: Opus 4.7 for judgment, Haiku 4.5 for bulk classification. |
| Human checkpoints | **5 explicit gate kinds** | `approveShortlist`, `approveOutreachSend`, `approveReplyResponse`, `approveShipment`, `approveStageAdvance`. Each has its own MC drill-in (e.g. shortlist shows a candidate table with fitScore bars; outreach shows the email preview with 4 judge scores). |

---

## An end-to-end run actually looks like this

```
1. Operator submits a brief → /campaigns/new
   ↳ Brand: "Hydra Demo Serum", category: skincare/serum
   ↳ Targeting: 3 creators, KO language, hashtags [스킨케어, kbeauty]
   ↳ Goals: 2 verified posts in 30 days
   ↳ campaign/submitted event fires

2. brand-campaign Inngest function picks it up
   ↳ step.run("source") → runAgent(sourcingAgent)
        ↳ Opus 4.7 with tiktok.search + blacklist.check tools
        ↳ Plans 2-4 search queries, executes them, dedupes
        ↳ Returns { candidates: [4 creators], queriesUsed, coverageNote }
   ↳ step.run("vet-{i}") × N → runAgent(vettingAgent) per candidate (parallel)
        ↳ Opus 4.7 with tiktok.getCreator + ranking.score
        ↳ Returns { creator, fitScore, flags, matchReasons }
   ↳ pickShortlist (deterministic, top ceil(creatorCount * 1.5), drop hard-fail flags)

3. gate(approveShortlist) → step.waitForEvent
   ↳ Creates v2_approvals row with the shortlist
   ↳ Pauses durably (state in Inngest, no Node process held)
   ↳ MC inbox shows it → operator clicks /approvals/<id> →
     reviews candidate table → "전체 승인" → /api/approvals/<id>/resolve →
     approval/resolved event → workflow resumes

4. brand-campaign fan-out
   ↳ persist tracks (v2_creator_tracks)
   ↳ step.sendEvent("creator-track-fanout") — one CreatorTrackStart per creator

5. creator-track Inngest function (one per shortlisted creator)
   ↳ step.run("plan") → load workspace policy + creator
   ↳ step.run("extract-facts") → outreach.extractFacts capability
   ↳ step.run("draft-outreach") → runAgent(outreachWriterAgent)
        ↳ Opus 4.7 tournament: 5 angles × 4 judges
          (brand / conversion / deliverability / skeptic)
        ↳ Returns winning draft + judgeScores + spamScore + groundedFacts
   ↳ gate(approveOutreachSend) → MC drill-in shows subject/body preview +
     judge bars + grounded facts + editable subject/body
   ↳ operator approves (optionally edits) → workflow resumes
   ↳ step.run("send-outreach") → capabilities.gmail.send
        ↳ Real Gmail API via googleapis SDK (user's refresh_token)
        ↳ Returns { messageId, threadId, scheduled: false, spamScore }
   ↳ step.run("outreach-sent-mark") → patch creator-track state
   ↳ step.waitForEvent("await-reply") — 3-day timeout

6. Recipient replies → Gmail Pub/Sub webhook → /api/webhooks/gmail
   ↳ Verifies push token, walks gmail.history, normalizes message
   ↳ Emits gmail/reply.received with { campaignId, creatorId, threadId, ... }
   ↳ creator-track's waitForEvent matches → workflow resumes

7. creator-track continues:
   ↳ step.run("classify-reply") → runAgent(conversationAgent / Haiku)
        ↳ Returns { classification: "interested" | "send_sample" | "negotiating" |
                    "declined" | "unsubscribe" | "not_now" | "out_of_office" |
                    "unrelated", extracted: { question?, shippingAddress?,
                    proposedRateUsd? } }
   ↳ Branch by classification:
        · interested + shippingAddress → runShippingAndContentReview leg
        · interested (no address)      → draft-response leg (responder agent)
        · negotiating                  → forced escalate via reply_response gate
        · declined / unsubscribe       → terminal + suppression.add (CAN-SPAM)
        · others                       → terminal in_conversation

8. Shipping leg (interested + shippingAddress):
   ↳ gate(approveShipment) → MC drill-in: address + product manifest
   ↳ step.run("create-shipment") → runAgent(logisticsAgent / Haiku)
        ↳ Parses free-text Korean address → structured fields
        ↳ Calls shipment.create capability → carrier (YUNTRACK, currently deferred)
   ↳ step.waitForEvent("shipment-tracking-updated") — 14-day timeout
   ↳ On terminal carrier status, branch:
        · delivered                 → continue to content review
        · cancelled/failed/returned → terminal shipment_failed

9. Content review leg:
   ↳ step.waitForEvent("tiktok-post-detected") — 14-day timeout
        (tiktok-post-poller cron emits this when it detects a matching post)
   ↳ step.run("verify-content") → runAgent(contentVerifyAgent / Haiku)
        ↳ Checks: brand mentioned + ToS-compliant + matches expected post style
        ↳ Returns { matches: true|false, rationale }
   ↳ matches: true  → terminal verified
   ↳ matches: false → terminal flaked (with rationale)

10. Campaign completion:
    ↳ campaign-progression cron daily checks for campaigns with all tracks terminal
    ↳ When done → step.run("generate-report") → runAgent(analystAgent / Opus)
    ↳ /share/<id> generates a public report (no-auth, signed token)
```

The same shape applies to **lead-campaign** (sales B2B) — outreach to companies via `lead-track`, classified by `conversationAgent`, drafted by `leadOutreachWriterAgent`. See `packages/workflows/src/workflows/lead-campaign.ts`.

---

## Repo layout (Turborepo + pnpm workspaces)

```
apps/
  web/                  Next.js 16 — Mission Control UI + webhook receivers + /api/inngest serve
                        - app/(mission-control)/{campaigns,leads,approvals,policies,usage,share}
                        - app/api/{auth/test-login, approvals/[id]/resolve, inngest,
                                    webhooks/gmail, webhooks/nicepay}
                        - components/mission-control/{sidebar, stage-bar, activity-timeline,
                                                       campaign-canvas, campaign-track-buckets}
                        - components/ui/{button, card, badge}
packages/
  contracts/            Zod schemas — single source of truth (campaign, creator, outreach,
                        policy, shipment, events, analytics, report, lead)
  db/                   MongoDB client + 8 repositories (campaign, approval, lead, creator,
                        report, shipment, trace, workspace) + v1-workspace importer
  capabilities/         13 capability families — the typed functions HTTP + agents both call:
                        analytics · blacklist · crm · gmail (client/send/watch/reply) ·
                        outreach (extractFacts/judge/render) · ranking · shipment (create/
                        track/carrier-yuntrack) · suppression · templates · tiktok (search/
                        getCreator/fetcher-rapidapi) · workspace · usage · prompt-guard
  agents/               11 agent definitions + runAgent runtime (budget, tracing, escalation,
                        pseudo-tool-call recovery):
                        sourcing · vetting · outreach-writer · lead-outreach-writer ·
                        conversation · conversation-responder · logistics · content-verify ·
                        analyst · research · intake
  workflows/            9 Inngest function definitions:
                        brand-campaign · creator-track · lead-campaign · lead-track ·
                        campaign-progression · gmail-watch-renew · report-deliver ·
                        report-deliver-cron · shipment-tracking-poller · tiktok-post-poller
  observability/        per-run trace recorder + token/cost ledger
  config/               shared tsconfig + eslint preset
docs/
  STATUS.md             one-screen heartbeat (read first when picking up)
  ARCHITECTURE.md       6-layer model, orchestrator↔agent split
  CAPABILITIES.md       v1 → v2 feature mapping
  ROADMAP.md            Phases 0–6
  PHASE-1-PLAN.md       Phase 1 task list with DoD (kept for traceability)
  SMOKE-TEST*.md        per-phase credential-free smoke runbook
  V3-UI-COMPARISON.md   2026-05-15 audit of ~/social-seeding-v3 vs v2 MC
  V4-PLAN.md            2026-05-15 master plan for the v4 greenfield rewrite
scripts/
  run-demo.ts           operator end-to-end demo (--type=brand|lead, --dry-run)
  init-indexes.ts       provision v2_* Mongo indexes (idempotent)
  dev-mongo.ts          mongodb-memory-server runner
HANDOFF.md              append-only per-chunk log (every P0-P6-Cx)
CLAUDE.md               agent-facing context (read this if you're an LLM)
```

---

## Where to look in code (LLM-friendly map)

| Want to understand… | Read this |
|---|---|
| How a campaign runs end-to-end | `packages/workflows/src/workflows/brand-campaign.ts` (218 lines) |
| How one creator's lifecycle runs | `packages/workflows/src/workflows/creator-track.ts` (945 lines — the real density) |
| What the sourcing agent actually does | `packages/agents/src/sourcing.agent.ts` + `runtime.ts` |
| How tool calls work (pseudo-tool-call lesson) | `packages/agents/src/runtime.ts` (see "// tool loop") |
| What a gate does | `packages/workflows/src/gate.ts` (167 lines) |
| How Gmail send is wired | `packages/capabilities/src/gmail/{client,send,reply,watch}.ts` |
| How the operator approves a shortlist | `apps/web/app/(mission-control)/approvals/[id]/page.tsx` |
| What the timeline view renders | `apps/web/components/mission-control/activity-timeline.tsx` |
| What the canvas view renders | `apps/web/components/mission-control/campaign-canvas.tsx` |
| The 5 gate-kind contracts | `packages/contracts/src/policy.ts` + `events.ts` |
| Mongo collection names + indexes | `packages/db/src/collections.ts` + `scripts/init-indexes.ts` |
| v1 import (workspace policies) | `packages/db/src/imports/v1-workspaces.ts` |

---

## Conventions

- **One commit per task**, small diffs, message references the phase tag (`P0-1:`, `P3-C5:`, …)
- **`pnpm run verify-build` must stay green** — never push red.
- **`codex review --base main`** before pushing `src/`/`packages/` changes (reduces review-bot rounds).
- **No unrelated changes** in a task's diff (no drive-by cleanup).
- **Shared v1 Atlas collections** (`accounts_tiktok`, `blacklist`, `workspaces`, `user_tokens`, `crm_accounts`, `templates`, `unified_emails`, …): read freely; **write additive fields only**; never remove/retype. v2 owns `v2_*`.
- Agents = functions the workflow invokes (curated tools, Zod output, USD cap, escalation), never free loops.
- `prompt-guard` runs on user text before it reaches any agent prompt; `external_send`-scoped capabilities (`gmail.send`) never fire without a cleared policy gate.

---

## For agents picking up the codebase

If you're an LLM continuing development on v2:

1. **Read in order**: [`CLAUDE.md`](CLAUDE.md) → [`docs/STATUS.md`](docs/STATUS.md) → [`HANDOFF.md`](HANDOFF.md) tail → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) → relevant `docs/SMOKE-TEST-Pn.md` for the phase you're touching.
2. **Memory dir**: `~/.claude/projects/-Users-sgwannabe-social-seeding-v2/memory/` — has decisions like `autonomous-phase-progression`, `goal-4000-char-limit`, `p6-operator-decisions-2026-05-14`, `v3-prototype-comparison`.
3. **The 10 hard-won lessons** from this session's live demo are encoded in **v4's `docs/V2-LESSONS-LEARNED.md`** (the v4 repo is at [Two-Weeks-Team/social-seeding-v4](https://github.com/Two-Weeks-Team/social-seeding-v4)). Before re-implementing anything Opus/Inngest/Gmail-related, **read that file** — it'll save days of rediscovery. Examples:
   - Inngest `step.waitForEvent` `if:` expression must use `async.data.X`, not `event.data.X`
   - Opus 4.7 emits pseudo-tool-calls as text when `tool_choice: "any"` isn't forced on turn 1
   - Sourcing agent prompt must say "RUN EACH PLANNED QUERY" or model escalates after 1 search
   - Agent `maxUsd` caps for Opus need ≥$1.0 with tools (early defaults were 2–4× too low)
   - Logistics agent system prompt must render `products` array — else Haiku hallucinates "products_missing"
4. **Run pattern**: every change ends with `pnpm run verify-build` green + a commit tagged with the phase ID.
5. **Don't touch shared v1 collections destructively** — additive only.

---

## Read next

1. [`docs/STATUS.md`](docs/STATUS.md) — current state heartbeat
2. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 6-layer model with diagrams
3. [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) — v1→v2 migration inventory
4. [`docs/AGENTS.md`](docs/AGENTS.md) — agent roster, tool sets, output contracts
5. [`docs/ROADMAP.md`](docs/ROADMAP.md) — phase-by-phase scope
6. [`docs/V3-UI-COMPARISON.md`](docs/V3-UI-COMPARISON.md) — why v4 exists
7. [`docs/V4-PLAN.md`](docs/V4-PLAN.md) — the greenfield rewrite plan (mirrored in [v4 repo](https://github.com/Two-Weeks-Team/social-seeding-v4))
8. [`HANDOFF.md`](HANDOFF.md) — granular per-chunk history

---

## Sibling repos

- **v4** ([Two-Weeks-Team/social-seeding-v4](https://github.com/Two-Weeks-Team/social-seeding-v4)) — greenfield rewrite, workflow-as-data + single-page canvas. Phases 0–5 done.
- **v1** ([Two-Weeks-Team/social-seeding](https://github.com/Two-Weeks-Team/social-seeding)) — the tool-dashboard origin (frozen 2026-05-13). See its `FREEZE.md`.

## License

Private / internal — `Two-Weeks-Team`.
