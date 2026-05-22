# Architecture — Social Seeding v2

> Status: design (skeleton repo). This is the contract; the code grows into it.

## 0. The one-sentence reframe

v1 = "a TikTok-campaign **tool dashboard** the human operates, with an AI chat sidebar."
v2 = "a TikTok-campaign **autonomous operator** the human supervises, with a Mission Control surface."

Almost every "feature" in v1 becomes a **capability** (a typed function) that an **agent** calls; the orchestration the human did with clicks becomes a **durable workflow**.

---

## 1. The six layers

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ① MISSION CONTROL  (apps/web — Next.js 16)                                │
│    timeline of agent activity · approval inbox · autonomy-policy editor · │
│    drill-down/manual-override views (search, campaign, email, analytics — │
│    the v1 pages, demoted) · thin public API · webhook receivers ·         │
│    /api/inngest serve endpoint                                            │
└───────────────────────────────┬──────────────────────────────────────────┘
                  events ▲ │ ▼ approvals / signals
┌───────────────────────────────▼──────────────────────────────────────────┐
│ ② ORCHESTRATION  (packages/workflows — Inngest)                           │
│    brand-campaign  ── the 6-stage durable workflow (the product)          │
│      └─ fan out: creator-track  ── one durable child workflow per creator │
│    + scheduled fns (ported v1 cron): gmail-watch-renew, billing-recurring,│
│      workspace-cleanup, tiktok-post-poller, followup-tick                 │
│    step.run = atomic+retried · step.sleep[Until] = durable timer ·        │
│    step.waitForEvent = block on approval / Gmail reply / tracking update  │
└──────┬──────────────────────────────────────────────┬────────────────────┘
       │ runAgent(def, input, ctx)                    │ invokeCapability(name, input, ctx)
┌──────▼──────────────────────────┐      ┌────────────▼──────────────────────┐
│ ③ AGENTS  (packages/agents,      │ uses │ ④ CAPABILITIES  (packages/        │
│   Google genai SDK)              │  ───▶│   capabilities)                    │
│  sourcing · vetting ·            │      │  registry of typed fns:            │
│  outreach-writer (= v1 cold-mail │      │   tiktok.search / .getCreator      │
│  pipeline, wrapped) ·            │      │   gmail.send / .watchThread        │
│  conversation (reply triage +    │      │   blacklist.check                  │
│  response draft) · logistics ·   │      │   shipment.create / .track         │
│  content-verify · analyst        │      │   crm.enrich (Modal+Kimi)          │
│                                  │      │   ranking.score · ...              │
│  each: system prompt + curated   │      │  each: input/output Zod schema,    │
│  tool subset + structured output │      │  scope (read|write|external_send), │
│  contract + USD cap + escalation │      │  idempotency, rate-limit class.    │
│                                  │      │  HTTP API + agents both call here. │
│  NOT a free ReAct loop — a       │      │  → kills v1's 266-route sprawl.    │
│  function the workflow invokes.  │      │                                    │
└──────────────────────────────────┘      └────────────────────────────────────┘
       │                                              │
┌──────▼──────────────────────────────────────────────▼────────────────────┐
│ ⑤ CONTEXT / POLICY / MEMORY  (packages/db + contracts)                    │
│  Workspace context (durable): brand profile · products · past campaigns + │
│    outcomes · creator relationship history (who replied / flaked /        │
│    overperformed) · brand voice · budget norms · AUTONOMY POLICY (which    │
│    gates on, budget caps, banned phrases) ← this is what makes auto safe   │
│  Run context (ephemeral, per campaign): the plan · each creator's track · │
│    open Gmail threads · pending approvals                                  │
│  Storage: SHARED v1 collections (accounts_tiktok, blacklist, workspaces,  │
│    user_tokens, …) + new v2_* (v2_campaigns, v2_creator_tracks,           │
│    v2_workspace_policies, v2_approvals, v2_agent_traces, v2_cost_ledger)  │
└────────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────────┐
│ ⑥ OBSERVABILITY & SAFETY  (packages/observability)                          │
│  per-run trace: every agent/tool/LLM call, nested, with tokens · cost      │
│  ledger + soft-cap alerts ($50/$100/$200, carried from v1) + per-campaign  │
│  hard cap (throws) · kill switch (CampaignCancelled / pause events) ·      │
│  eval harness: golden sets for sourcing quality, reply-class accuracy,     │
│  draft quality — generalizes v1's vitest.eval + cold-mail judges           │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. The orchestrator ⇄ agent split (the load-bearing decision)

A campaign runs for ~6 weeks across dozens of creators, with retries, waits, human gates, and external events (a Gmail reply, a tracking update, a new TikTok post). If you hand that to a free-roaming agent loop it heads off the rails, burns money, and can't be debugged or resumed.

So: **the workflow is deterministic code; it calls agents for the judgment-heavy sub-tasks and treats their output as data.**

- Workflow (`packages/workflows`): "for each confirmed creator, spawn a track; in the track, write outreach, clear the send gate, send, then wait up to 3 days for a reply or follow up, repeat ≤ N times…" — choreography only. Uses `step.run` / `step.sleep` / `step.waitForEvent`. Never calls an LLM or the network directly.
- Agent (`packages/agents`): "given this brief and this creator's profile + recent posts, write a grounded outreach email that survives the brand/conversion/deliverability/skeptic judges and the spam-score check; if you don't have enough grounded facts, escalate." Bounded: a curated tool set, a Zod output contract, a USD cap, an escalation outcome.
- Capability (`packages/capabilities`): "search TikTok with these filters and return ranked creators" — a typed function with auth/rate-limit/idempotency baked in. The trust boundary: capabilities decide what's allowed; agents only ask.

This is exactly the shape v1's `lib/cold-mail` already uses (`extractFacts` → `draftWriter` → `reviser` loop → `verifiers`; tournament: angles → drafts → critic-revise → 4 judges → winner). v2 generalizes it from "one email" to "the whole campaign."

---

## 3. The 6 stages → the durable workflow

v1 made the human click through these. v2 runs them. (`packages/workflows/src/workflows/brand-campaign.ts` is the skeleton; `docs/ROADMAP.md` says which phase fills in which stage.)

| Stage (v1 name kept) | What the workflow does | Agents | Capabilities | Human gate (default ON) |
|---|---|---|---|---|
| 1. overview | accept brief, load workspace policy, generate + persist a plan | — | — | — |
| 2. sourcing | run sourcing agent → fan-out vetting agent per candidate → rank → shortlist | sourcing, vetting | `tiktok.search`, `tiktok.getCreator`, `blacklist.check`, `ranking.score` | **approveShortlist** |
| 3. outreach | per confirmed creator: extractFacts → outreach-writer → send → reply loop (wait 3d / follow up ≤N / classify reply) → agreement / decline | outreach-writer, conversation | `gmail.send`, `gmail.watchThread`, `templates.render` | **approveOutreachSend** (per batch), **approveReplyResponse** (for negotiating/question replies) |
| 4. shipping | for agreed creators with an address: create shipment, watch tracking | logistics | `shipment.create`, `shipment.track` | **approveShipment** |
| 5. content_review | poll TikTok for the creator's recent posts; match hashtags/mentions; compute performance; if no post after 14d → escalate | content-verify | `tiktok.getCreator`, `ranking.score` | (escalation only) |
| 6. performance | compile + narrate the report; deliver weekly; mark campaign completed when all tracks resolved | analyst | `analytics.compile` | — |
| (cross-cutting) | stage advance | — | — | **approveStageAdvance** |

Supporting cycles (v1 cron → v2 scheduled Inngest fns or workflow timers): Gmail watch renewal (daily), follow-up cadence (or just `step.sleep` inside `creator-track`), blacklist auto-detect (periodic, feeds `priorOutcome` memory), billing recurring (daily), workspace cleanup (frequent), TikTok post poller (drives stage 5).

The **sales-lead campaign** is a *second workflow type* on the same engine: `lead-campaign` = import leads → `crm.enrich` (Modal crawl + Kimi analysis) → outreach-writer tournament → conversation loop → on interest, hand off into a `brand-campaign`. (Phase 5.)

---

## 4. The human-checkpoint model (how "minimize human intervention" is made safe)

Every gate in §3 is a `GateConfig` in the workspace's `WorkspacePolicy` (`packages/contracts/src/policy.ts`), with one of three modes:

- `always_ask` — create an `Approval` row with the agent's recommendation pre-filled + its rationale; emit it to Mission Control's inbox; the workflow `step.waitForEvent("approval/resolved")`. The human approves / edits / rejects in one click. **This is the default for every gate.**
- `auto` — skip the human; use the agent's recommendation.
- `auto_unless` — auto, *unless* a predicate matches (`spamScoreGte`, `followerCountGte`, `proposedRateUsdGte`, `fitScoreLt`, `replyClassIn`) → then `always_ask`. This is the sweet spot: "auto-send outreach unless spam score ≥ 3 or follower count ≥ 100k."

`WorkspacePolicy.level` (`copilot` / `checkpointed` / `autonomous`) is a coarse preset that sets sensible gate defaults; individual gates always override it. New workspaces start `checkpointed`; owners ratchet toward `autonomous` as they build trust.

Budgets are part of the policy too: `maxUsdPerCampaign` (hard, throws `BudgetExceededError`) and `maxUsdPerWorkspaceMonthly` (soft-cap alerts, carried from v1's `cost-alert.service`). The orchestrator checks these via `@ss/observability` before invoking any agent.

---

## 5. Mission Control (apps/web) — what the surface actually is

Three regions, plus demoted v1 views:

1. **Campaigns in flight** — for each campaign: a read-only stage indicator (the 6 stages) + a reverse-chron **activity timeline** sourced from `v2_agent_traces` ("sourcing agent ran 3 queries → 240 candidates → 22 after blacklist+engagement floor"; "sent outreach to @x, @y, @z"; "@x replied: interested, asked for sample size — drafted reply, waiting on you").
2. **Approval inbox** — open `v2_approvals` across the workspace, batched by kind, each with the agent's pre-filled answer + rationale. Approve / edit / reject. Resolving emits `approval/resolved`.
3. **Policies** — the autonomy editor: per-gate mode, budget caps, brand voice notes, banned phrases. Changing a policy affects future checkpoints, not in-flight ones.
4. **Drill-down / manual override** — the v1 pages survive here, demoted: search creators by hand, look at a campaign's raw data, open an email thread, view analytics. For the cases the autopilot can't (or shouldn't) handle.

Auth: Auth.js v5 + Google OAuth (carry v1's Progressive-Permission — Gmail connect stays allowlist-gated) + the `/api/auth/test-login` JWT bypass for E2E.

---

## 6. What we deliberately don't carry from v1

- The Go backend / LangGraph split — gone; one runtime.
- 266 REST routes — collapsed into the capability layer + a thin public API + webhook receivers.
- The 6-step workflow board *as a manual UI* — replaced by the workflow + Mission Control (a read-only stage view remains).
- Migration flags, dual-key helpers, the Express/Go archaeology, the 2024 `IMPLEMENTATION_PLAN.md`.
- i18n auto-translation pipeline — port if/when needed; not core.
- `scheduler.ts` / `email-queue.ts` / `workflow-automation.ts` ad-hoc orchestration — Inngest is the engine now.

## 7. Risks & how the design absorbs them

| Risk | Mitigation in the design |
|---|---|
| Agents go off the rails / burn money | Agents are bounded functions (tools, output contract, USD cap, escalation), not free loops; per-campaign hard budget cap; per-run trace; kill switch |
| Autonomy ships too aggressive, sends bad emails | Default = every gate `always_ask`; `external_send` capabilities can *never* fire without a cleared gate; spam-score + 4-judge tournament before any outreach |
| v1 and v2 fight over the shared DB | v2 owns `v2_*` collections; reads v1 collections; v1 frozen + told not to make breaking schema changes (FREEZE.md §7); additive-only |
| Inngest can't handle the scale / we outgrow it | Workflow code is engine-agnostic-ish; `functions` array moves to a standalone `apps/worker` (or Temporal) with no workflow-logic change |
| Lost v1 domain knowledge | `docs/CAPABILITIES.md` maps every v1 feature to its v2 home; the hard IP (ranking, cold-mail, Gmail, enrichment) is *ported*, not reinvented |
| Long-running workflows are hard to test | Inngest replay + the eval harness (golden sets per agent) + `step`-level retries; `creator-track` isolated as a child so one creator's failure doesn't cascade |
