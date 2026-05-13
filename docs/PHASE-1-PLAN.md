# Phase 0 + Phase 1 — detailed task plan

> The skeleton's `throw "not implemented — see ... task X"` messages point at the task IDs below. Phase 0 = foundation (everything compiles + every layer's plumbing runs). Phase 1 = the sourcing+vetting vertical slice (give the system a brief → it presents a shortlist for approval).
>
> Each task: a clear definition of done. Group → review → commit per group (carry the v1 habit: small PRs, self-review the diff first, `codex review --base main` before pushing src/ changes).

---

## Phase 0 — Foundation

### P0-1 — Monorepo green
- **DoD:** `pnpm install` resolves; `pnpm run verify-build` (turbo lint+type-check+build, all packages) passes; `.github/workflows/ci.yml` green on a PR. Add the missing dev deps the skeleton references (`@eslint/js`, `typescript-eslint`, `vitest`, `@types/*`, `tailwindcss`, `eslint-config-next`). Add per-package `eslint.config.js` re-exporting `@ss/config/eslint-preset`. Generate `pnpm-lock.yaml`.

### P0-2 — `@ss/db` real
- **DoD:** `getDb()` connects to the **shared** Atlas (`MONGODB_URI`, `MONGODB_DB`); a `scripts/init-indexes.ts` creates indexes on the `v2_*` collections (`v2_campaigns`: `brief.workspaceId+updatedAt`; `v2_creator_tracks`: `campaignId+creatorId`; `v2_approvals`: `workspaceId+status`, `campaignId`; `v2_agent_traces`: `campaignId+startedAt` + TTL; `v2_cost_ledger`: `campaignId`, `workspaceId+at` + TTL); `campaignRepo` CRUD works against a real cluster; `workspaceRepo.getPolicy` returns `defaultPolicy` when absent and round-trips a saved one; `creatorRepo.getByUniqueId` reads a real `accounts_tiktok` doc and `TikTokCreatorSchema.parse` succeeds (adjust the schema to match v1's actual doc shape — inspect a few real docs first).

### P0-3 — `@ss/agents` `runAgent` on the Claude Agent SDK
- **DoD:** `runAgent(def, input, ctx)` implemented: (a) `assertWithinBudget` before the first call; (b) resolve `def.tools` → capability schemas → SDK tool definitions, every tool call routed through `invokeCapability` with `ctx.capabilityCtx`; (c) every tool + LLM call wrapped in `ctx.trace.span`; (d) parse the final message vs. `def.output`; on Zod failure, one reviser pass (synthesize a critique from the Zod error — port `cold-mail/agent.ts`'s `synthesizeCritiqueFromSchemaError`); still failing → `{ kind: "escalate" }`; (e) `recordCost` per LLM call; (f) model routing honors `def.model`. Prove it with a throwaway `echo` agent (input `{ text }` → output `{ upper: string }`, no tools) in a vitest test.

### P0-4 — `@ss/observability` real
- **DoD:** `startTrace(...).flush()` writes a `v2_agent_traces` doc (the span tree) when `AGENT_TRACE_SINK=mongo`; `recordCost` appends to `v2_cost_ledger`; `assertWithinBudget(campaignId, cap)` sums the ledger and throws `BudgetExceededError` over cap; crossing a `COST_ALERT_THRESHOLDS` value sends an alert email (port v1 `services/cost-alert.service`). Unit-tested with an in-memory Mongo (mongodb-memory-server) or a test DB.

### P0-5 — `apps/web` boots: auth + thin API
- **DoD:** Next.js 16 dev server runs; Auth.js v5 + Google OAuth configured (`apps/web/lib/auth.ts`); Progressive-Permission preserved (Gmail-connect allowlist — port `lib/gmail/allowed-emails.ts`); `/api/auth/test-login` issues a JWT directly when `AUTH_TEST_LOGIN_ENABLED=true` (port v1); the `prompt-guard` runs on user text in the public API; `POST /api/campaigns` requires a session, validates `CampaignBriefSchema`, calls `usage.checkAndIncrement` (rate-limit primitive — task P0-6), persists a draft via `campaignRepo`, emits `campaign/submitted`; `GET /api/campaigns` returns `campaignRepo.listByWorkspace`. The empty Mission Control pages render under a basic layout (light mode).

### P0-6 — Rate-limit primitive (`usage.checkAndIncrement`)
- **DoD:** port v1 `lib/usage-limiter.ts`: a capability/lib that, given `(workspaceId|userId, rateLimitClass)`, atomically `$inc`s a monthly counter in `user_usage`/`workspace_usage` (3-month TTL), compares to the plan's `PLAN_LIMITS` (resolved via `workspaceRepo.getPlan` — port the plan-cache), rolls back on over-limit, honors `usage_limit_overrides` (tombstone-aware). `invokeCapability` calls it before every capability whose `rateLimitClass !== "default"`. (Guest IP+UA bucket: skip unless v2 keeps a public landing trial.)

### P0-7 — Inngest plumbing
- **DoD:** `apps/web/app/api/inngest/route.ts` serves; `npx inngest-cli dev` discovers `brand-campaign` + `creator-track`; `POST /api/campaigns` → an `EventEmitter`-confirmed `campaign/submitted` → a `brand-campaign` run appears in the Inngest dashboard and completes (skeleton return); `campaign/paused` / `campaign/resumed` / `campaign/cancelled` events plumbed (`cancelOn` works). A trace + a $0 cost entry recorded for the run.

### P0-8 — Scope decision doc
- **DoD:** a short `docs/SCOPE-DECISIONS.md` recording which of the CAPABILITIES.md "conditional" rows are in v2 day-one (guest trial? beta invite codes? waitlist? i18n? newsletter? landing port?) — keep it tight.

**Phase 0 exit demo:** `curl POST /api/campaigns` (with `test-login` JWT) → draft row → Inngest run kicks off & finishes → `v2_agent_traces` + `v2_cost_ledger` rows exist → `pnpm run verify-build` + CI green.

---

## Phase 1 — Sourcing + Vetting slice

### Capabilities

#### S2 — `tiktok.search`
- **DoD:** port v1's 3-phase search, Phase-0 synchronous for agent use: replicate the Atlas Search aggregation with weighted fields (`hashtags` 10x / `signature` 5x / `nickname` 2x / `uniqueId` 1x), `mode` ∈ {text, hashtag, and, or} matching v1's comma/space semantics, filters (followers, engagement, language), `limit` ≤ 1000. Returns `{ creators, total, continuation }` (`continuation` non-null if Phase 1/2 results would be available — but the agent rarely needs them). Refresh-via-RapidAPI is *not* this capability's job (that's `tiktok.getCreator`). Reuse v1 `src/app/api/search` + the `accounts_tiktok` Atlas Search index definition.

#### V1 — `tiktok.getCreator`
- **DoD:** read `accounts_tiktok` by `uniqueId`; if missing or stale (>24h, v1's policy) fetch via RapidAPI (port v1 `api/tiktok/*` + `lib/tiktok-mappers.ts` + the API-key rotation pool), upsert back into `accounts_tiktok` (additive — same as v1's ingestion). With `withRecentPosts`: also pull recent `posts_tiktok` (or fetch). Returns `{ creator, recentPosts[] }`. `rateLimitClass: "tiktok_read"`.

#### R1 — `ranking.score`
- **DoD:** port v1 `lib/calculate-average-views.ts` + the influence-score / engagement-rate formulas (`docs/.../tiktok-ranking-*`). Input: a creator + recent posts. Output: `{ avgViews, engagementRate, influenceScore }`. Pure; no I/O. Used by `vetting` (Phase 1), `content-verify` (Phase 3), `analyst` (Phase 4).

#### V3 — `blacklist.check`
- **DoD:** read the **shared** `blacklist` collection, workspace-scoped, for a batch of `uniqueIds`; return `{ blacklisted, reason?, severity? }` per id. `rateLimitClass: "default"`. (The auto-detect *writer* — scheduled fn `blacklist-autodetect` — is Phase 2/3 work; this is the read side `vetting` needs now.)

#### W0 — `workspace.getPolicy` / `workspace.getPlan` capabilities
- **DoD:** thin capability wrappers over `workspaceRepo` so agents/workflows get policy & plan through the same `invokeCapability` path (consistent auth/trace). `getPlan` resolves FREE/BEAUTY_VERIFIED/STARTER/PRO/BUSINESS via `subscriptions`/`workspace_subscriptions` + `beauty_verified` + the 10-min cache (port v1).

### Agents

#### A-intake — `intake` agent
- **DoD:** a bounded conversational agent (no tools) that, over ≤ ~6 turns, fills a `CampaignBrief` (brand/product, targeting, logistics, goals). Asks only for what it can't infer; confirms the assembled brief before returning it; escalates if the human's answers can't produce a valid brief. Lives behind `POST /api/campaigns/intake` (SSE) used by the MC "new campaign" flow. Golden set: 10 transcripts → expected briefs.

#### A-sourcing — `sourcing` agent
- **DoD:** implement `packages/agents/src/sourcing.agent.ts`'s handler via `runAgent`: choose a few `tiktok.search` queries (text + hashtag) from the brief, `blacklist.check` the union, drop PERMANENT, de-dupe vs. `excludeCreatorIds`, return `{ candidates, queriesUsed, coverageNote }` aiming for ~3–5× `creatorCount`. Eval: brief → candidates, graded on (a) all in declared follower/engagement range, (b) no blacklisted PERMANENT, (c) ≥ target×3 count or an honest `coverageNote`, (d) match reasons reference real profile attributes.

#### A-vetting — `vetting` agent
- **DoD:** implement `vetting.agent.ts`'s handler: `tiktok.getCreator(withRecentPosts)` → `ranking.score` → set `fitScore` ∈ [0,1] + `flags` (`below_engagement_floor`, `blacklisted`, `wrong_language`, `brand_unsafe`, `prior_flake`, `data_stale`). Haiku. Eval: a labeled set of (brief, creator) → expected fitScore bucket + expected flags; grade on flag precision/recall and fitScore calibration (the cold-mail-style judge pattern as the grader).

### Workflow

#### WF1 — `brand-campaign` stages `overview` → `sourcing`
- **DoD:** in `brand-campaign.ts`: `step.run("plan")` loads brief + `workspace.getPolicy`, persists a plan, `campaignRepo.patchStage("sourcing")`; `step.run("source")` → `runAgent(sourcingAgent, ...)`; `Promise.all(candidates.map((c,i) => step.run(`vet-${i}`, () => runAgent(vettingAgent, {brief, candidate: c}))))`; `pickShortlist(vetted, ceil(creatorCount*1.5))` (sort by fitScore, drop hard flags); then the **gate**:

#### WF2 — the `gate()` helper
- **DoD:** `gate(step, gateConfig, { campaignId, workspaceId, kind, recommendation, rationale })`: if `gateConfig.mode === "auto"` → return `{ decision: "approved", payload: recommendation }`; if `"auto_unless"` and no `escalateIf` predicate matches the recommendation → same; else create a `v2_approvals` row, `step.sendEvent` an inbox notification, `await step.waitForEvent("approval/resolved", { match: "data.approvalId", timeout: "7d" })` → return the human's decision; on timeout → escalate (alert + leave the campaign paused at this gate). `evaluatePredicate` checks `spamScoreGte` / `followerCountGte` / `proposedRateUsdGte` / `fitScoreLt` / `replyClassIn` against the recommendation shape.

#### WF3 — persist tracks on shortlist approval
- **DoD:** when `approveShortlist` resolves "approved"/"edited", `campaignRepo.upsertTrack` one `CreatorTrack` (state `shortlisted`) per confirmed creator; `campaignRepo.patchStage` stays `sourcing` (Phase 2 advances to `outreach`); record the decision in the trace; campaign sits idle awaiting Phase 2.

### Mission Control

#### W1 — layout + nav + auth-gated shell
- **DoD:** `apps/web` app shell: header, left nav (Campaigns / Approvals / Policies / Library / Admin), session-gated; light mode; shadcn/ui + Tailwind 4 set up. Port enough of the v1 design tokens to not look unfinished.

#### W2 — campaigns list + detail (stage view)
- **DoD:** `/campaigns` server component lists `campaignRepo.listByWorkspace` (status, stage, #tracks, updatedAt); `/campaigns/[id]` shows the read-only 6-stage indicator + the campaign brief; "new campaign" → the intake conversation (SSE) → `POST /api/campaigns`.

#### W3 — activity timeline
- **DoD:** on `/campaigns/[id]`, a reverse-chron feed built from `v2_agent_traces` for that campaign: render each span with a human label ("sourcing agent: 3 queries → 240 candidates → 22 after blacklist + engagement floor", "vetting @x → fitScore 0.78, flags: []"), nested, with timing. Auto-refresh (poll or SSE).

#### W4 — approval inbox
- **DoD:** `/approvals` lists `v2_approvals` (status `pending`) across the workspace, grouped by `kind`; for `kind: "shortlist"` render the candidate table (handle, followers, engagement, fitScore, flags, match reasons) with per-row keep/drop + a free-text note; Approve / Edit (= approve with the edited subset) / Reject buttons → `POST /api/approvals/[id]/resolve` → emits `approval/resolved`. Resolving updates the row + unblocks the workflow.

#### W5 — policy editor (sourcing scope)
- **DoD:** `/policies` reads/writes `workspaceRepo` `WorkspacePolicy`: at minimum the `approveShortlist` gate (`always_ask` / `auto` / `auto_unless` with `fitScoreLt`) + `budgets` (`maxUsdPerCampaign`, `maxUsdPerWorkspaceMonthly`) + the `level` preset. Saving affects future campaigns only.

**Phase 1 exit demo:** start a campaign through the intake conversation → the timeline fills in as `sourcing` + `vetting` run → a `shortlist` approval lands in the inbox with ~22 ranked, vetted creators + reasons + fit scores → approve (or edit down to 20) → tracks persisted, campaign waits at end-of-`sourcing` → flip the policy's `approveShortlist` to `auto_unless(fitScoreLt: 0.5)` and run another campaign nearly hands-off through sourcing. Eval suites for `intake` / `sourcing` / `vetting` green in CI.
