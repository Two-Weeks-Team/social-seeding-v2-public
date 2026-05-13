# Roadmap — Social Seeding v2

> Principle: **vertical slices, not breadth.** Ship one full agentic loop end-to-end before widening. Dogfood it on our own GTM cold-outreach (the v1 `STATUS.md` plan) before onboarding anyone.
>
> Durations are rough estimates for a small team. Each phase ends with a demoable thing.

---

## Phase 0 — Foundation (~1–2 wk) — *enables everything*

**Goal:** the skeleton becomes a real, running scaffold. No campaign logic yet, but every layer's plumbing works.

- Monorepo green: `pnpm install && pnpm run verify-build` passes; CI runs.
- `@ss/db`: real MongoDB connection to the shared Atlas; the `v2_*` collections + indexes created; `campaignRepo` / `workspaceRepo` working; `creatorRepo` reads `accounts_tiktok`.
- `@ss/contracts`: schemas finalized (campaign, creator, outreach, policy, events).
- `@ss/capabilities`: `invokeCapability` with schema validation + the `usage.checkAndIncrement` rate-limit primitive (port v1 `usage-limiter`); registry working; the 5 stub capabilities present (still `throw`).
- `@ss/agents`: `runAgent` implemented on the Claude Agent SDK — tool resolution, budget gate, tracing, output parse + one reviser pass, escalation. Test it against a trivial throwaway agent.
- `@ss/observability`: `startTrace` writing to `v2_agent_traces`; `recordCost` / `assertWithinBudget` against `v2_cost_ledger`; cost-alert emails at thresholds.
- `@ss/workflows`: Inngest client wired; `apps/web/app/api/inngest/route.ts` serves; Inngest Dev Server discovers it; `brand-campaign` registered (still a no-op skeleton); pause/resume/cancel events plumbed.
- `apps/web`: Next.js boots; Auth.js v5 + Google OAuth + the `/api/auth/test-login` bypass; layout + the empty Mission Control pages render; `POST /api/campaigns` validates a brief, persists a draft, emits `campaign/submitted`.
- Decide: which billing/auth/i18n bits are in scope for v2 day-one vs. deferred (see CAPABILITIES.md "conditional" rows).

**Demo:** `curl POST /api/campaigns` with a brief → a draft row appears → the Inngest dashboard shows a `brand-campaign` run kick off and immediately finish (skeleton). A trace + a cost entry of $0 are recorded.

---

## Phase 1 — Sourcing + Vetting slice (~3–4 wk) — *"sourcing is automatic"*

**Goal:** give the system a brief; it sources and vets creators and presents a shortlist for approval. The single most valuable, highest-toil part of v1, automated.

- `intake` agent: a short structured conversation → `CampaignBrief`. MC "new campaign" flow uses it.
- `tiktok.search` capability: port v1's Atlas Search aggregation (weighted fields, AND/OR). `tiktok.getCreator`: port v1 RapidAPI fetch + mappers + 24h cache. `ranking.score`: port v1 avg-views + influence-score. `blacklist.check`: read `blacklist`.
- `sourcing` + `vetting` agents implemented; golden-set evals for both.
- `brand-campaign` workflow stages `overview` → `sourcing`: load brief+policy, run sourcing, fan-out vetting, rank, build shortlist, hit the `approveShortlist` gate (the `gate()` helper: policy → auto / auto_unless / always_ask → `Approval` row + `step.waitForEvent`).
- Mission Control: campaign list, campaign detail with the **activity timeline** (from traces) + the **approval inbox** for `shortlist` approvals (approve/edit/reject → emits `approval/resolved`). The **policy editor** (at least the `approveShortlist` gate + budget caps).

**Demo:** start a campaign via the intake conversation → watch the timeline fill in ("3 queries → 240 candidates → 22 after blacklist+engagement floor, ranked") → an approval lands in the inbox with the 22-creator shortlist + per-creator reasons & fit scores → approve (or edit down) → campaign sits at end-of-`sourcing` waiting for Phase 2.

---

## Phase 2 — Outreach + Reply-handling slice (~3–4 wk) — *"outreach runs itself"*

**Goal:** the system writes, sends, follows up, and handles replies — escalating only the judgment calls.

- Port `lib/cold-mail/*` → `outreach-writer` agent (extractFacts, draftWriter, reviser, verifiers, angles, judges, fewshot, followup — all of it). Eval graders = the cold-mail judges.
- `gmail.send` capability: port v1 `lib/gmail` send path + token auto-refresh + tracking pixel + tracked links + unsubscribe footer + `sendAt` scheduling + spam-score pre-check. `templates.render`: port the variable engine. `gmail.watchThread` + the Gmail Pub/Sub webhook (`apps/web/.../webhooks/gmail`) → emits `gmail/reply.received`; scheduled fn `gmail-watch-renew`.
- `conversation` agent: reply classification (Haiku) + extraction (address/rate/question) + response draft (Opus when needed).
- `creator-track` child workflow fully wired: extractFacts → outreach-writer → `approveOutreachSend` gate → `gmail.send` → reply loop (`step.sleep("3d")` / followup ≤N / classify → branch). `brand-campaign` fans out one `creator-track` per confirmed creator; `approveReplyResponse` gate for negotiating/question replies.
- Bounce webhook (Resend), suppression list, unsubscribe page.
- Mission Control: thread drill-down view (manual reply), outreach-send + reply-response approvals, the rest of the policy gates.

**Demo:** approve a shortlist → outreach drafts appear (with angle, spam score, judge scores) → approve a send batch → emails go out → a reply comes in → it's classified, an address extracted, the track moves to "agreed"; a different reply ("what's your rate?") → drafted response lands in the approval inbox.

---

## Phase 3 — Shipping + Content-verification slice (~2–3 wk) — *"the back half closes itself"*

- `shipment.create` / `shipment.track` capabilities (port v1 `api/shipping`); `logistics` agent; `approveShipment` gate; `shipment/tracking.updated` events.
- `tiktok-post-poller` scheduled fn → `tiktok/post.detected` events; `content-verify` agent (match hashtags/mentions, compute performance); 14d-no-post escalation.
- `creator-track` stages `shipping` → `content_review` wired; campaign auto-advances when tracks resolve.
- MC: shipment list/export view, content list view.

**Demo:** an "agreed" creator with an address → shipment created → tracking updates flow in → poller finds their TikTok post → it's matched & scored → the track shows "verified, 42k views, 3.1% engagement."

---

## Phase 4 — Analyst + Mission Control polish (~2 wk) — *"the report writes itself"*

- `analytics.compile` capability (port v1 ranking/analytics) + `analyst` agent + `report.deliver` (weekly, a recurring child workflow); `/share/[id]` reframed to share a report.
- `brand-campaign` stage `performance` wired; campaign `completed` lifecycle.
- MC: report view, the full timeline polish, the autonomy-level presets (`copilot`/`checkpointed`/`autonomous`), kill switch, cost dashboard (port v1 `/admin/usage-dashboard` + token monitor as the trace/cost views).
- **v1 parity reached for the brand-campaign loop, now autonomous.**

**Demo:** a full campaign from intake to a delivered weekly report, with the human only touching the gates they kept on. Flip a workspace to `autonomous` with `auto_unless` gates → run another campaign nearly hands-off.

---

## Phase 5 — Sales-lead campaign type (~2 wk) — *"the second loop"*

- `crm.*` capabilities + `crm_accounts` shared; `crm.enrich` (port v1 Modal+Kimi verbatim); `research` agent.
- `lead-campaign` workflow: import leads → enrich → outreach-writer tournament → conversation loop → on interest, hand off into a `brand-campaign`. (This is how we run our *own* GTM — dogfood.)
- MC: leads view, lead-campaign timeline.

**Demo:** drop in a list of K-beauty companies → they get enriched and prioritized → cold emails go out → a reply → it flows into a brand campaign. (= the v1 `STATUS.md` GTM plan, executed by the product.)

---

## Phase 6 — Cutover (~ongoing)

- Migrate existing v1 workspaces/users (one-time importer; campaign *history* already shared via Atlas).
- Run v1 and v2 side by side (v1 frozen, maintenance-only); move users over in cohorts; watch for shared-DB friction.
- Sunset v1 when the last user is migrated. Retire the Go/LangGraph backend.
- Backlog from here: i18n, the landing/marketing site port, admin views not yet rebuilt, any "conditional" CAPABILITIES.md rows that turned out to matter.

---

## Sequencing notes

- **Phase 1 ships value on its own** — "stop manually searching and vetting" is worth shipping even before outreach is automated.
- **Don't start a phase before the prior one's eval suite is green** — agentic regressions are silent; the golden sets are the guardrail (memory: "E2E for large mechanical work" — same logic applies to agents).
- **Codex adversarial pass before pushing src/ changes** (carry the v1 habit): `codex review --base main` to shrink review-bot rounds.
- Keep the v1 freeze honest: any v1 hotfix that touches a *shared* collection's schema must be checked against v2's reads first (FREEZE.md §7).
