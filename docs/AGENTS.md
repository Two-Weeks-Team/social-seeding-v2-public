# Agents — Social Seeding v2

> An agent here is **not** a free-roaming ReAct loop. It's a *function the durable workflow invokes* for a judgment-heavy sub-task: a system prompt, a curated tool subset (capabilities), a Zod output contract, a USD cap, and an escalation outcome. This generalizes v1's `lib/cold-mail` pattern (`extractFacts` → `draftWriter` → `reviser` loop → `verifiers`; tournament: angles → drafts → critic-revise → 4 judges → winner) from "one email" to "the whole campaign."
>
> Defined in `packages/agents/src/*.agent.ts` via `defineAgent({...})`; run via `runAgent(def, input, ctx)` from `packages/agents/src/runtime.ts`.

## The roster

| # | Agent | Job | Tools (capability subset) | Output contract | Model | ~USD cap | Escalates when | Replaces (v1) |
|---|---|---|---|---|---|---|---|---|
| 1 | **sourcing** | Brief → ranked candidate list with match reasons; de-dupe vs. blacklist + prior-campaign creators | `tiktok.search`, `blacklist.check` | `{ candidates[], queriesUsed[], coverageNote }` | Opus 4.7 | 1.5 | can't find enough in-range creators (says so in `coverageNote`, doesn't pad) | the human clicking Search + Step 2 |
| 2 | **vetting** | Per candidate: pull profile+posts, compute engagement/avg-views, brand-safety, language, prior outcome → `fitScore` + flags | `tiktok.getCreator`, `blacklist.check`, `ranking.score` | `Candidate` (with `fitScore`, `flags`) | Haiku 4.5 | 0.1 (per candidate; workflow fans out) | (rarely) — surfaces flags instead | the human eyeballing Step 2's table |
| 3 | **outreach-writer** | One creator → grounded, personalized email; multi-angle tournament + 4-judge scoring + spam-score check | _(none — facts pre-extracted by the workflow; mirrors v1 `agent.ts`'s no-I/O boundary)_ | `OutreachDraft` | Opus 4.7 | 0.8 | not enough grounded facts to write something a human would reply to | "AI 작성" button + the human reviewing |
| 4 | **conversation** | A reply arrived → classify (interested/needs_info/negotiating/declined/…), extract (address/rate/question), draft a response or flag for human | `gmail.watchThread`, `templates.render` | `ConversationTurn` | Haiku 4.5 classify / Opus 4.7 draft | 0.3 | `negotiating`, legal/contract questions, anything `replyClassIn` the policy escalates | the human reading the Replies tab |
| 5 | **logistics** | Agreed creator + address → create shipment, watch tracking, handle exceptions | `shipment.create`, `shipment.track` | `{ shipmentId, trackingNumber, status }` | Haiku 4.5 | 0.05 | shipment creation fails / tracking stalls | the human in Step 4 |
| 6 | **content-verify** | Poll TikTok for the creator's recent posts; match campaign hashtags/mentions; compute performance | `tiktok.getCreator`, `ranking.score` | `{ posted: bool, postId?, metrics?, matchConfidence }` | Haiku 4.5 | 0.05 | no matching post after 14d ("escalate: creator hasn't posted") | the human in Step 5 |
| 7 | **analyst** | Compile + narrate the campaign report; weekly delivery | `analytics.compile` | `{ markdownReport, headlineMetrics }` | Opus 4.7 | 0.5 | — | the human in Step 6 |
| 8 | **research** _(Phase 5)_ | Lead's website → structured sales analysis (Modal crawl + Kimi) → outreach angle | `crm.enrich`, `crm.account.upsert` | the `crm.enrich` analysis shape | Kimi (via the capability) + Haiku | 0.1 | crawl fails / site has no usable content | the v1 CRM enrichment batch (already automated) |
| 9 | **intake** _(Phase 1)_ | A short structured conversation that turns a one-line ask into a `CampaignBrief` (the thing that replaces v1's 6-tab form) | _(none — pure dialogue)_ | `CampaignBrief` | Opus 4.7 | 0.3 | the human's answers are too vague to produce a valid brief | the 6-tab campaign-create form |

## The `runAgent` contract (what the runtime does)

```ts
runAgent(def, input, ctx) → { kind: "ok"; value: <def.output>; usd } | { kind: "escalate"; reason; partial?; usd }
```

1. **Budget gate** — `assertWithinBudget(ctx.campaignId, policy.budgets.maxUsdPerCampaign)` before the first LLM call; abort with `BudgetExceededError` if over.
2. **Tools** — resolve `def.tools` (dotted capability names) → their Zod schemas → Claude Agent SDK tool definitions. The agent can *only* call these, and every call goes through `invokeCapability` (schema-validated, rate-limited, scoped). `external_send`-scoped capabilities are *never* in an agent's tool set — those are workflow-only, behind a policy gate.
3. **Trace** — wrap every tool call and LLM call in `ctx.trace.span(...)` so Mission Control's timeline is complete.
4. **Output** — parse the final message against `def.output`. On parse failure, run **one** reviser pass (the cold-mail loop: feed the schema error back as a synthetic critique). Still failing → `{ kind: "escalate", reason: "agent could not produce valid output" }`.
5. **Cost** — `recordCost(...)` for each LLM call; soft-cap alerts at `COST_ALERT_THRESHOLDS`.

## How the workflow uses them (excerpt — `creator-track`)

```
extractFacts(brief, creator)                    // ports cold-mail/extract-facts; pure
  └─ !has_minimum_context → escalate("not enough context for @x")  // don't guess

runAgent(outreachWriterAgent, { brief, creator, ...voice })  // tournament + judges + spam-score → OutreachDraft

gate(step, policy.gates.approveOutreachSend, { recommendation: draft })   // always_ask | auto | auto_unless(spamScoreGte:3, followerCountGte:1e5)
  └─ if always_ask: create Approval, emit, step.waitForEvent("approval/resolved")

invokeCapability("gmail.send", { ...draft, idempotencyKey: `${campaignId}:${creatorId}:outreach` })

loop ≤ MAX_FOLLOWUPS:
  race( step.waitForEvent("gmail/reply.received", { timeout: "3d" }), timer )
    timer  → invokeCapability("gmail.send", followupText(...))   // cold-mail/followup
    reply  → runAgent(conversationAgent, { thread }) → switch turn.classification:
               "interested" + turn.extracted.shippingAddress → mark agreed, break
               "negotiating" | "needs_info"                   → gate(approveReplyResponse) → gmail.send(turn.draftedReply)
               "declined" | "unsubscribe"                     → mark declined, break (→ blacklist-autodetect input)
```

## Why this is more reliable than a single mega-agent

- **Bounded blast radius** — a bad `vetting` call mis-scores one creator; it doesn't derail the campaign. `creator-track` is a child workflow, so one creator's stuck thread doesn't block the other 21.
- **Cheap where it can be** — `vetting` / `logistics` / `content-verify` run on Haiku at fractions of a cent; only the judgment agents (`sourcing`, `outreach-writer`, `conversation`-draft, `analyst`, `intake`) get Opus.
- **Testable** — each agent has a golden-set eval (`pnpm --filter @ss/agents test:eval`): sourcing-quality, fit-score calibration, reply-class accuracy, draft quality (reuse the cold-mail judges as eval graders).
- **Auditable** — every decision is a trace span with its input, output, tokens, and (for agents) the rationale string that's also shown to the human in the approval inbox.
