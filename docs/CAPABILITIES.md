# Capabilities — v1 feature → v2 home (the migration inventory)

> Every v1 feature, and where it lives in v2: a **capability** (typed fn in `packages/capabilities`), an **agent** (`packages/agents`), a **workflow step** (`packages/workflows`), a **Mission Control view** (`apps/web`), or **dropped**.
>
> "Port" = lift the v1 logic largely as-is. "Reframe" = same job, restructured around the new model. "New" = didn't exist in v1.

---

## Domain A — TikTok data & search

| v1 feature | v1 location | v2 home | Action |
|---|---|---|---|
| 3-phase Progressive search (Atlas Search → RapidAPI live → Mongo remainder), AND/OR, weighted fields (hashtags 10x / signature 5x / nickname 2x / uniqueId 1x) | `api/search`, `searchResultStore` | capability `tiktok.search` + agent `sourcing` (drives it) + MC drill-down "search by hand" | Port |
| RapidAPI ingestion + 24h cache + queue/circuit-breaker + API-key auto-rotation | `api/tiktok/*`, `lib/api-key-rotation.ts` | capability `tiktok.getCreator` (refreshes if stale), key-rotation moves into the capability's infra | Port |
| Ranking algorithms (influence score, avg views, engagement) | `lib/calculate-average-views.ts`, `lib/tiktok-mappers.ts`, `docs/.../tiktok-ranking-*` | capability `ranking.score` (called by `vetting`, `content-verify`, `analyst`) | Port — domain IP, do not reinvent |
| Similar-creator search | `components/similar-search` | capability `tiktok.findSimilar` | Port |
| Trends page | `/trends` | MC view `/trends` (drill-down) | Reframe |
| Autocomplete | `useAutocomplete` | capability `tiktok.suggest` | Port |
| CDN image expiry (~6h) handling | `imageUpdateStore` | capability-internal (re-sign on read); no client store | Reframe |

## Domain B — bookmarks & influencer pool

| v1 feature | v1 location | v2 home | Action |
|---|---|---|---|
| TikTok bookmarks + folders + auto stats refresh | `api/bookmarks`, `bookmarks_tiktok` | capability `pool.*` (a "pool" subsumes bookmarks); MC view "creator library" | Reframe |
| Influencer Management (pool / campaign-pool / blacklist / settings tabs) | `/influencer-management`, `api/influencer-pools` | MC views (library + per-campaign confirmed list); pool membership is a side effect of campaigns | Reframe |
| Blacklist + auto-detect (REPEATED_REJECTION / NO_CONTENT_DELIVERY / FRAUD / MANUAL; WARNING/TEMPORARY/PERMANENT) + batch | `api/blacklist`, `api/blacklist/auto-detect`, `blacklist` | capability `blacklist.check` (read, called by `vetting`) + scheduled fn `blacklist-autodetect` (writes, feeds `priorOutcome` memory) | Port |
| Influencer cart (select → push to campaign) | `influencerCartStore` | obsoleted — the workflow shortlists; the human approves a shortlist, doesn't build a cart | Drop |

## Domain C — campaign 6-stage workflow

| v1 feature | v1 location | v2 home | Action |
|---|---|---|---|
| Campaign CRUD + list (status: draft/active/paused/completed) | `api/campaigns/*` (18), `campaignStore`, `campaigns` | thin API `POST /api/campaigns` (validate brief → persist → emit event); workflow owns transitions; `campaignRepo` | Reframe |
| Step 1 overview (info, KPIs, budget, team) | step-1 | brief intake conversation (`CampaignBriefSchema`) + workflow stage `overview` + MC stage view | Reframe |
| Step 2 influencer探索 (waiting list, scores, owner) | step-2 | agents `sourcing` + `vetting` + gate `approveShortlist` | Reframe — was manual, now automated |
| Step 3 섭외 / EmailCenter 7 tabs (compose/AI/templates/sent/replies/scheduled/settings) + spam score + schedule send | step-3, `components/campaign/email-center` | agents `outreach-writer` + `conversation`; capabilities `gmail.send`, `templates.render`; gates `approveOutreachSend` / `approveReplyResponse`; MC view "thread" for manual override | Reframe — the 7 tabs become agent behaviors |
| Step 4 제품 발송 (3 tabs: list/register/track) + Excel export | step-4, `api/shipping`, `shipping` types | agent `logistics`; capabilities `shipment.create` / `shipment.track`; gate `approveShipment`; MC export | Port + reframe |
| Step 5 콘텐츠 확인 (verify posts, performance, manual add) | step-5, `lib/campaign-content-service.ts` | agent `content-verify` + scheduled fn `tiktok-post-poller` (emits `tiktok/post.detected`); MC view | Reframe |
| Step 6 성과 분석 (5 tabs, reply rate, budget efficiency, score) | step-6 | agent `analyst` + capability `analytics.compile`; MC view "report"; weekly auto-delivery | Reframe |
| Auto-progress state machine (email_response > 0.3 → next stage) | `lib/workflow-automation.ts` | the Inngest `brand-campaign` workflow itself (now actually wired, with durable timers + gates) | Reframe — this was the half-built thing |
| Campaign auth / workspace-based ACL | `lib/campaign-auth.ts` | `CapabilityContext.workspaceId` + `workspaceRepo`; ACL enforced in the capability layer | Port |

## Domain D — email / outreach

| v1 feature | v1 location | v2 home | Action |
|---|---|---|---|
| **Cold-mail pipeline**: extractFacts → draftWriter → reviser loop → verifiers; tournament (5 angles × 4 judges: brand/conversion/deliverability/skeptic + weighted score); few-shot; followup | `lib/cold-mail/*` (13 files) | agent `outreach-writer` (wraps it verbatim); `conversation` reuses the reviser + followup pieces | **Port — highest-value asset, already an agent done right** |
| Gmail OAuth (`gmail.readonly`+`gmail.send`), token auto-refresh, watch/Pub-Sub push | `lib/gmail/*`, `api/gmail`, `api/webhooks/gmail/pubsub`, `cron/renew-gmail-watch` | capabilities `gmail.send` / `gmail.watchThread`; webhook `apps/web/.../webhooks/gmail`; scheduled fn `gmail-watch-renew` | Port |
| AI email write / reply | `api/ai-email`, `api/ai/generate-reply`, `lib/ai-reply-utils.ts` | folded into `outreach-writer` / `conversation` agents | Reframe |
| Email templates CRUD + seeder + variable engine | `api/templates`, `lib/email-template-engine.ts`, `templates` | capability `templates.render` (variables); `templates` collection shared with v1; MC view to edit | Port |
| Send queue (5-min cron) + schedule send | `cron/process-email-queue`, `lib/email-queue.ts` | `gmail.send` supports `sendAt`; no queue — Inngest `step.sleepUntil` + the capability handle scheduling | Reframe — queue obsoleted |
| Follow-up cadence (1h cron) | `cron/follow-ups`, `lib/email-follow-up.ts`, `cold-mail/followup.ts` | `step.sleep("3d")` inside `creator-track` + the `cold-mail/followup` text generator | Reframe |
| Open-pixel / click tracking | `api/email/tracking/*`, `lib/email-tracking.ts` | capability-internal in `gmail.send` (injects pixel + tracked links); events feed the timeline | Port |
| Spam score (0–10) | `lib/spam-score.ts` | called inside `outreach-writer` before returning a draft; also a gate predicate | Port |
| Bounce handling (Resend webhook) | `api/webhooks/resend/bounce`, `lib/email-bounce*.ts` | webhook receiver; updates track state; feeds blacklist auto-detect | Port |
| Unsubscribe token / page | `lib/email-unsubscribe-token.ts`, `/unsubscribe` | capability-internal footer + `/unsubscribe` page; suppression list | Port |
| Unified email center / threads | `/email`, `api/email/*` (36), `unified_emails` | MC view "threads" (drill-down/manual reply); `unified_emails` shared | Reframe |
| Email campaigns (separate) | `/email-campaigns`, `api/email-campaigns` | subsumed by the `lead-campaign` workflow type (Phase 5) | Reframe |
| Conversation summary | `lib/conversation-summary.ts`, `api/summarize` | `conversation` agent maintains a running thread summary in the track | Port |

## Domain E — AI agent chat (v1 = read-only)

| v1 feature | v1 location | v2 home | Action |
|---|---|---|---|
| SSE chat, tool visualization, sessions/history/share/vote, WS push, proactive insights, memory panel; Go+LangGraph backend; tools `get_top_campaigns` / `get_recent_emails` / `get_campaign_stats` etc. | `/agent`, `api/agent/*` (11), `components/agent/*`, `backend.socialseed.ing` | **Largely obsoleted.** The agents now *do* the work, not answer questions. Keep a lightweight "ask Mission Control" chat as a MC affordance over `v2_agent_traces` + `analytics.compile` (read-only), but it's a feature, not the product. Go/LangGraph backend retired entirely. | Drop / re-found |

## Domain F — personalization / proactive

| v1 feature | v1 location | v2 home | Action |
|---|---|---|---|
| Insights / tips / campaign suggestions / filter presets / state-based suggestions / SSE stats | `api/personalization/*` (17), `personalizationStore` | the workspace **context/memory** layer (`packages/db`) + the agents (which read it) + MC timeline (which surfaces it). "Proactive insight" = an agent escalation or an analyst observation. | Reframe |
| Behavior / heatmap / page / activity tracking | `useActivityTracker`, `useHeatmapTracking`, … | drop the client telemetry; keep server-side outcome memory (creator `priorOutcome`, campaign results) which is the part agents actually use | Drop / reframe |

## Domain G — CRM / lead generation

| v1 feature | v1 location | v2 home | Action |
|---|---|---|---|
| CRM accounts CRUD + bulk + facets + dup detection + saved views + mapping templates + members + activities + import jobs | `/crm`, `api/crm/*` (24), `lib/crm/*` (19), `crmAccountStore` | capabilities `crm.*` + `crm_accounts` collection shared with v1; MC views "leads"; the `lead-campaign` workflow consumes them | Port |
| Enrichment pipeline: Modal crawler → Kimi (Moonshot) analysis (company summary, products, business type, outreach angle, sales priority, confidence) | `lib/crm/enrichment-service.ts`, `modal-enrichment/app.py`, `api/crm/enrichment/*` | capability `crm.enrich` (analysis prompt ported verbatim; model swapped Kimi → `gemini-3.5-flash` per D53) + agent `research` | Port — domain IP |
| CRM → cold-mail / email integration | `api/crm/accounts/[id]/cold-mail`, `lib/crm/email-event-handler.ts` | `lead-campaign` workflow: `crm.enrich` → `outreach-writer` → `conversation` | Reframe |
| Email signature / unsub for CRM | `lib/crm/email-signature.ts`, `email-unsub.ts` | folded into `gmail.send` + suppression list | Port |

## Domain H — workspace / plan / billing

| v1 feature | v1 location | v2 home | Action |
|---|---|---|---|
| Workspace + members (OWNER/ADMIN/MEMBER) + invites (expiring single-use) + audit log + cancel→30d grace→cleanup cron→billing self-heal | `api/workspaces/*`, `lib/workspace/*`, `workspaces`/`workspace_members`/`workspace_invites`/`workspace_audit_log` | shared collections; `workspaceRepo`; cancel/grace/cleanup → scheduled fn `workspace-cleanup`; MC view "workspace settings" | Port |
| Plans (FREE / BEAUTY_VERIFIED / STARTER / PRO / BUSINESS), `PLAN_LIMITS` per-action monthly caps | `lib/feature-flags.ts`, `lib/usage-limiter.ts` | `CapabilityContext.rateLimitClass` + usage counters in `packages/db`; plan resolved via `workspaceRepo` | Port |
| BEAUTY_VERIFIED (3-month free, PRO-level) | `/beauty-verify`, `api/beauty-verify`, `beauty_verified` | shared collection + plan-resolution rule; MC admin view | Port |
| NicePay recurring billing (monthly/yearly), webhook idempotency, retry log, checkout draft | `api/nicepay`, `api/billing/*`, `lib/nicepay/*`, `subscriptions`/`workspace_subscriptions`/`checkout_drafts`/`billing_attempts`/`webhook_events`, `cron/billing-recurring` | webhook receiver `apps/web/.../webhooks/nicepay` + scheduled fn `billing-recurring` + shared collections | Port |
| Refund page | `/refund` | MC view | Port |

## Domain I — unified rate limiting

| v1 feature | v1 location | v2 home | Action |
|---|---|---|---|
| Member: plan × action monthly quota, atomic `$inc` + rollback, 3-month TTL | `lib/usage-limiter.ts`, `user_usage`/`workspace_usage` | enforced in `invokeCapability` via the capability's `rateLimitClass`; also caps agent loops | Port |
| Guest: IP+UA hash bucket (lifetime/hourly) for the landing trial | `lib/guest-rate-limit.ts`, `guest_usage_rate_limit` | if v2 keeps a public landing trial: same mechanism, in the public API; else drop | Port (conditional) |
| Admin overrides: per-user per-action, expiresAt/tombstone | `api/admin/usage-limit-overrides`, `usage_limit_overrides` | shared collection + MC admin view | Port |
| Plan cache (10-min TTL) | `user_plan_cache`/`workspace_plan_cache` | `workspaceRepo` internal cache | Port |

## Domain J — auth / permission

| v1 feature | v1 location | v2 home | Action |
|---|---|---|---|
| NextAuth v4 + Google OAuth (all accounts), JWT 30d | `lib/auth.ts`, `api/auth/*` | Auth.js v5 + Google OAuth; `apps/web/lib/auth.ts` | Port (minor version bump) |
| Progressive Permission — Gmail connect = `2weeks.co` + allowlist only; else `/waitlist` 403 | `lib/gmail/allowed-emails.ts`, `api/auth/gmail-reauth` | same; the `gmail.*` capabilities check it | Port |
| 21-char Google OAuth id enforced + 3-way id mapping (googleOAuthId/mongoObjectId/email) 5-min cache | `lib/auth/id-mapping-service.ts`, `user_id_mappings` | `CapabilityContext.userId` is the 21-char id; id-mapping ported as a lib | Port |
| Beta invite codes | `api/beta-request`, `lib/invitation-code.ts`, `/beta-request`, `/invite` | port if v2 keeps invite-gating | Port (conditional) |
| Waitlist approval | `/waitlist`, `api/waitlist`, `api/admin/waitlist` | port if v2 keeps it | Port (conditional) |
| Prompt-injection guard, input sanitize | `lib/security/prompt-guard.ts` | applied at the public API + before any user text reaches an agent prompt | Port |
| E2E OAuth bypass | `/api/auth/test-login` | `AUTH_TEST_LOGIN_ENABLED` + `apps/web/.../auth/test-login` | Port |

## Domain K — admin / ops

| v1 feature | v1 location | v2 home | Action |
|---|---|---|---|
| Admin dashboards (16 pages: AI metrics, token monitor, performance, campaigns/users/emails/influencers, workspaces, beta-requests, invitations, waitlist, beauty-verify, clean-email, usage-dashboard) | `/admin/*`, `api/admin/*` (17+), `lib/admin-*.ts` | MC admin section, rebuilt over `v2_agent_traces` + `v2_cost_ledger` + shared collections; many become obsolete (the trace/cost views replace AI-metrics/token-monitor) | Reframe — port the useful ones |
| Notifications (CRUD/read/stats) + admin alerts | `api/notifications/*`, `lib/notifications/admin-alerts.ts` | the approval inbox + alert emails (cost caps, escalations); generic notif system optional | Reframe |
| Cost alerts / audit log / invite-token service | `lib/services/*` | `packages/observability` (cost) + `workspace_audit_log` (shared) | Port |
| Cron ×6 (process-email-queue, sync-from-gmail, follow-ups, renew-gmail-watch, billing-recurring, workspace-cleanup) + (coded) beauty-expiry, purge-users, deletion-warnings | `api/cron/*`, `vercel.json` | scheduled Inngest fns: `gmail-sync` (or push-only via the webhook), `gmail-watch-renew`, `billing-recurring`, `workspace-cleanup`, `tiktok-post-poller`, `blacklist-autodetect`, `beauty-expiry-notice`, `purge-deleted-users`; queue & follow-ups → workflow timers | Port → scheduled fns |
| GitHub bug report / Slack / health | `api/github`, `api/slack`, `api/health` | optional dev affordances; `/api/health` kept | Port (low priority) |
| Image processing / Vercel Blob | `api/image`, `@vercel/blob` | port as needed (sample photos, etc.) | Port (as needed) |
| i18n (ko/en, auto-translate pipeline) | `lib/i18n/*`, `api/translate`, `api/detect-language` | not core; `next-intl` if/when needed | Defer |
| Newsletter / profile / share / help / legal pages | `/newsletter`, `/profile`, `/share`, `/help`, `/terms`, `/privacy`, `/refund` | MC static pages; `/share` reframed (share a campaign report, not a chat) | Port (as needed) |
| Landing v2 (cinematic video bg) | `components/landing-v2` | port as the marketing site (dark; the app surface stays light) | Port |

---

## Capability registry — target shape (Phase 1 names in **bold**)

```
tiktok.search**          tiktok.getCreator**     tiktok.findSimilar      tiktok.suggest
ranking.score**          blacklist.check**       pool.add  pool.list
gmail.send               gmail.watchThread       templates.render        suppression.check
shipment.create          shipment.track
crm.enrich               crm.account.upsert      crm.account.list
analytics.compile        report.deliver
workspace.getPolicy**    workspace.getPlan**     usage.checkAndIncrement** (rate-limit primitive)
```

Each is `defineCapability({ name, description, input: ZodSchema, output: ZodSchema, scope, idempotent, rateLimitClass, handler })`. Agents receive a *subset* as their tool set (see `docs/AGENTS.md`).
