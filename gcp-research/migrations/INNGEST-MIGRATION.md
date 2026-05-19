# INNGEST-MIGRATION.md — Inngest → Cloud Workflows + Pub/Sub + Cloud Tasks + Eventarc

> **Authority**: [`DECISIONS.md`](../decisions/DECISIONS.md) **D18** supersedes **D4**. v2 currently runs on Inngest 3.27.x (`packages/workflows/package.json:21`). Track 2 submission must be **GCP-native only** — Inngest retires before any production traffic. This document is the engineering spec for that migration.
>
> **Audience**: the workflow-rebuild background agent (Task #23 derivative), code reviewers, the M3 PM agent (D38).
>
> **Source of truth precedence**: where this file conflicts with an earlier post-`gcp-research/porting-v2/PORTING-V2.md`, this file wins. Where it conflicts with `DECISIONS.md`, the decision wins.
>
> **Scope**: 10 Inngest functions live in `packages/workflows/src/workflows/` today. 5 are durable user-facing workflows (`brand-campaign`, `creator-track`, `lead-campaign`, `lead-track`, `report-deliver`); 5 are cron-style schedulers (`campaign-progression`, `gmail-watch-renew`, `tiktok-post-poller`, `shipment-tracking-poller`, `report-deliver-cron`). All 10 are in-scope for retirement.

---

## 1. Inventory — every Inngest primitive used in v2

Concrete inventory built by `grep -n 'step\.' packages/workflows/src/workflows/*.ts` plus a per-file read. Each call cites a real file:line.

### 1.1 `step.run(name, async fn)` — durable side-effect step

The bread-and-butter primitive. Wraps an idempotent function so Inngest records its return value, retries it on transient failure, and skips it on resume.

| File | Line | Step name | Purpose |
|---|---|---|---|
| `brand-campaign.ts` | 63 | `observability` | Per-run trace boot + initial $0 cost ledger |
| `brand-campaign.ts` | 80 | `plan` | Load workspace policy, advance stage to `sourcing` |
| `brand-campaign.ts` | 96 | `source` | `runAgent(sourcingAgent, …)` |
| `brand-campaign.ts` | 112 | `vet-${i}` | `runAgent(vettingAgent, …)` — **fan-out: one step.run per candidate inside `Promise.all`** |
| `brand-campaign.ts` | 140 | `persist-tracks` | Upsert one `v2_campaign_tracks` row per confirmed creator |
| `brand-campaign.ts` | 163 | `advance-stage-outreach` | Campaign-level stage flip |
| `brand-campaign.ts` | 170 | `resolve-creator-emails` | Mongo lookup join on `accounts_tiktok` |
| `creator-track.ts` | 196 | `no-email-mark` | Terminal-state mark when creator has no email |
| `creator-track.ts` | 203 | `plan` | `workspaceRepo.getPolicy(workspaceId)` |
| `creator-track.ts` | 220 | `extract-facts` | `invokeCapability("outreach.extractFacts", …)` |
| `creator-track.ts` | 238 | `draft-outreach` | `runAgent(outreachWriterAgent, …)` (5×4 tournament inside) |
| `creator-track.ts` | 292 | `send-outreach` | `invokeCapability("gmail.send", …)` with `idempotencyKey` |
| `creator-track.ts` | 308 | `outreach-sent-mark` | Track state → `outreach_sent` |
| `creator-track.ts` | 349 | `classify-reply` | `runAgent(conversationAgent, …)` |
| `creator-track.ts` | 398 | `suppression-from-reply` | `invokeCapability("suppression.add", …)` |
| `creator-track.ts` | 431 | `escalate-negotiating` | `gate(step, {mode:"always_ask"}, …)` inside a step |
| `creator-track.ts` | 499 | `draft-response` | `runAgent(conversationResponderAgent, …)` |
| `creator-track.ts` | 568 | `send-reply` | `invokeCapability("gmail.send", …)` with reply-scoped `idempotencyKey` |
| `creator-track.ts` | 706 | `create-shipment` | `runAgent(logisticsAgent, …)` |
| `creator-track.ts` | 849 | `verify-content` | `runAgent(contentVerifyAgent, …)` |
| `lead-campaign.ts` | 85 | `plan` | Lead-campaign stage init |
| `lead-campaign.ts` | 101 | `import-leads` | Bulk dedupe + insert in `v2_leads` |
| `lead-campaign.ts` | 159 | `enrich-${leadId}` | Per-lead enrichment fan-out |
| `lead-campaign.ts` | 180 | `research-${leadId}` | Per-lead research-agent fan-out |
| `lead-campaign.ts` | 216 | `advance-stage-outreach` | Stage flip |
| `lead-track.ts` | 119 | `plan` | Workspace policy |
| `lead-track.ts` | 129 | `draft-outreach` | `runAgent(leadOutreachWriterAgent, …)` |
| `lead-track.ts` | 183 | `send-outreach` | `gmail.send` for B2B |
| `lead-track.ts` | 227 | `classify-reply` | Same conversation classifier reused |
| `lead-track.ts` | 259 | `suppression-from-reply` | Same suppression capability |
| `lead-track.ts` | 285 | `escalate-negotiating` | gate inside step |
| `lead-track.ts` | 304 | `draft-response` | Responder |
| `lead-track.ts` | 365 | `send-reply` | Reply send |
| `report-deliver.ts` | 100 | `load-campaign` | Campaign fetch |
| `report-deliver.ts` | 119 | `compile-analytics` | Capability-driven analytics aggregate |
| `report-deliver.ts` | 139 | `analyst-narrative` | `runAgent(analystAgent, …)` |
| `report-deliver.ts` | 167 | `persist-report` | Report row insert |
| `gate.ts` | 134 | `approval:create:${kind}` | Approval row create — load-bearing for all 4 gate kinds |
| `pause.ts` | 65 | `pause-check:${campaignId}` | Campaign-status read for the soft-pause boundary |
| `pause.ts` | 84 | `pause-check-after-resume:${campaignId}` | Re-check after resume signal |

**Total `step.run` call sites**: ~40 across 7 workflow files.

### 1.2 `step.sleep("Xd")` — long durable timer

**No literal `step.sleep` call sites remain** in the v2 workflows. The long-duration patterns are all expressed as `step.waitForEvent(..., { timeout: "3d" | "14d" | "7d" })` (which behaves as a sleep when no event arrives — see §1.3). This is significant for the migration: we don't need a pure-sleep equivalent for any production path. The deepest sleeps are the 14-day timeouts on `creator-track.ts:142-143`:

```ts
// packages/workflows/src/workflows/creator-track.ts:136-143
const REPLY_TIMEOUT = "3d";
/**
 * Deadline on each shipping / content-review wait. Matches v1's
 * 14-day-no-post heuristic + gives carriers enough room for international
 * shipping (typical 7-10 days from Seoul → SE Asia / EU).
 */
const SHIPMENT_TIMEOUT = "14d";
const CONTENT_TIMEOUT = "14d";
```

The 7-day approval timeout lives in `gate.ts:167`:

```ts
// packages/workflows/src/gate.ts:163-167
const resolved = await step.waitForEvent(`await-approval:${approvalId}`, {
  event: "approval/resolved",
  if: `async.data.approvalId == "${approvalId}"`,
  timeout: "7d",
});
```

And the 30-day pause cap in `pause.ts:48`:

```ts
// packages/workflows/src/pause.ts:48
export const RESUME_WAIT_TIMEOUT = "30d";
```

### 1.3 `step.waitForEvent(name, opts)` — durable correlation wait

| File | Line | Awaited event | Correlation expression | Timeout |
|---|---|---|---|---|
| `gate.ts` | 163 | `approval/resolved` | `async.data.approvalId == "${approvalId}"` | `7d` |
| `pause.ts` | 77 | `Events.CampaignResumed` | `async.data.campaignId == "${campaignId}"` | `30d` |
| `creator-track.ts` | 330 | `Events.GmailReplyReceived` | `async.data.campaignId == "${campaignId}" && async.data.creatorId == "${creatorId}" && async.data.threadId == "${sendResult.threadId}"` | `3d` |
| `creator-track.ts` | 756 | `Events.ShipmentTrackingUpdated` | (campaign, creator, shipmentId) AND `(status in {delivered, cancelled, failed, returned})` | `14d` |
| `creator-track.ts` | 825 | `Events.TikTokPostDetected` | `async.data.campaignId == "${campaignId}" && async.data.creatorId == "${creatorId}"` | `14d` |
| `lead-track.ts` | 203 | `Events.GmailReplyReceived` | Per-lead variant | `3d` |

**Five distinct correlation waits**, all relying on the `async.data.X` lesson (the trigger-event vs awaited-event distinction documented inline at `creator-track.ts:322-329` and again at `gate.ts:154-162` and `pause.ts:73-76`).

### 1.4 `step.sendEvent(name, payload | payload[])` — fan-out / signal emit

| File | Line | Emitted event(s) | Purpose |
|---|---|---|---|
| `brand-campaign.ts` | 185 | `Events.CreatorTrackStart` × N | **Fan-out**: one child `creator-track` per confirmed creator |
| `gate.ts` | 145 | `approval/created` | Notify the MC inbox a new approval is awaiting |
| `lead-campaign.ts` | 231 | `Events.LeadTrackStart` × N | Same fan-out pattern as brand |
| `report-deliver.ts` | 182 | `Events.ReportDelivered` | Terminal event for downstream consumers |

### 1.5 `inngest.createFunction({ id, ... }, trigger, handler)` — function registration

Ten registrations:

| File | Line | ID | Trigger |
|---|---|---|---|
| `brand-campaign.ts` | 211 | `brand-campaign` | `event: Events.CampaignSubmitted` + `cancelOn: Events.CampaignCancelled` |
| `creator-track.ts` | 941 | `creator-track` | `event: Events.CreatorTrackStart` + `cancelOn: Events.CampaignCancelled` |
| `lead-campaign.ts` | 252 | `lead-campaign` | `event: Events.LeadCampaignSubmitted` |
| `lead-track.ts` | 397 | `lead-track` | `event: Events.LeadTrackStart` |
| `report-deliver.ts` | 209 | `report-deliver` | `event: Events.ReportDeliverRequest` |
| `campaign-progression.ts` | 149 | `campaign-progression` | `cron: "0 3 * * *"` |
| `gmail-watch-renew.ts` | 89 | `gmail-watch-renew` | `cron: "0 4 * * *"` |
| `tiktok-post-poller.ts` | 206 | `tiktok-post-poller` | `cron: "0 2 * * *"` |
| `shipment-tracking-poller.ts` | 127 | `shipment-tracking-poller` | `cron: "0 4,16 * * *"` |
| `report-deliver-cron.ts` | 111 | `report-deliver-cron` | `cron: "0 9 * * 1"` |

### 1.6 Tangential Inngest features used

- **`cancelOn`** on `brand-campaign` and `creator-track` (cancels in-flight runs when `Events.CampaignCancelled` matches `data.campaignId`).
- **`EventSchemas().fromZod(...)`** at `client.ts:24-41` — runtime + type-level event-shape contract.
- **Promise.all over `step.run`** for parallelism — `brand-campaign.ts:110-114` (vetting fan-out), and `lead-campaign.ts:159-185` (per-lead enrichment fan-out).

That is the complete v2 Inngest surface: ~40 `step.run`, 5 `waitForEvent` (with 6 call sites — one duplicated across `creator-track` and `lead-track`), 4 `sendEvent`, zero `step.sleep`, 10 `createFunction`, 2 `cancelOn`.

---

## 2. Equivalence table — Inngest concept → GCP-native equivalent

| Inngest concept | GCP equivalent | Caveats / non-obvious behavior |
|---|---|---|
| `step.run("name", fn)` | **Cloud Workflows `call` step** (HTTP target = Cloud Run capability service) **OR** inline `assign:` for pure transforms | Workflows steps have a **5-minute call timeout default** on `http.post`/`googleapis.*` calls; raise to **30m** with `timeout: 1800`. Each step's output is journaled and survives a Workflows execution restart. Outputs >32 KiB must be staged through Cloud Storage or Spanner — Workflows variables are capped at **512 KiB total per execution**. |
| `step.sleep("3d")` | **Cloud Workflows `call: sys.sleep` with `seconds: 259200`** | `sys.sleep` is durable. Workflows execution maximum is **1 year**, so 3d / 14d / 30d are all comfortably in range (cloud.google.com/workflows/quotas#resource_limits). Note: while a workflow is sleeping it does not consume slots in your concurrency quota but DOES count as an active execution toward the **5000 active executions per region** quota. |
| `step.sleep("14d")` | Same as above with `seconds: 1209600` | Identical. The 14-day waits in `creator-track.ts:142-143` are absorbed by `sys.sleep` if no event-correlation is required, OR by a **callback endpoint** if we want to short-circuit on an event arriving early (see "callback" row below). |
| `step.waitForEvent(name, {if: "async.data.X == event.data.X", timeout})` | **Cloud Workflows `create_callback_endpoint` + `await_callback`** (durable HTTP callback) **OR** **Eventarc trigger → Pub/Sub subscription → Workflows `events.list_and_await` pattern** | `create_callback_endpoint` returns a one-shot URL the external system POSTs to; Workflows blocks at `await_callback` for up to **1 year**. Correlation **is not by attribute filter** — it's by URL uniqueness. The migration strategy is to use the callback URL itself as the correlation key (store URL in `v2_approvals.callback_url`, the API resolver POSTs to it). For Pub/Sub-driven waits (reply, post-detected, tracking-updated) where the producer doesn't know which workflow execution to call back, we use **Eventarc Advanced + a router Cloud Run service** that looks up `(campaignId, creatorId, threadId) → callback_url` in Spanner and POSTs. Filter syntax in Eventarc uses CEL on **CloudEvent attributes**, not on payload fields; payload-field correlation moves to the router service. |
| `event.data.X` in `if` (trigger event, pre-evaluated) | **Workflows expression `${args.X}`** in step `condition` | Workflows expressions are evaluated **at execution-start time** for `${args.*}` exactly the way Inngest pre-evaluates `event.data.*`. The `async.data.X` ↔ `${callback_result.body.X}` lesson is preserved verbatim: in the callback resolver Cloud Run service, we destructure on payload fields. |
| `async.data.X` in `if` (awaited event, runtime-evaluated) | `${callback_result.body.X}` after `await_callback` | The Workflows callback resolver returns the entire POST body as `callback_result.body`; subsequent steps reference its fields via the standard `${...}` expression language. |
| Inngest function ID (e.g. `brand-campaign`) | **Workflows execution name** (deterministic: `projects/${PROJECT}/locations/${REGION}/workflows/brand-campaign/executions/${EXECUTION_ID}`) | Workflow name is the deploy-time artifact ID; execution name is auto-generated UUID. We pin a **deterministic `executionId`** = `${campaignId}` (Workflows accepts caller-supplied execution IDs since GA 2024-10) so retries are idempotent and dashboards link by campaign. |
| Inngest auto-retry on `step.run` failure | **Cloud Workflows `retry:` block** with `predicate`, `max_retries`, `backoff` | Workflows uses **exponential backoff** with explicit `initial_delay`, `max_delay`, `multiplier` — see `error_retry_custom.workflows.yaml` pattern in `/googlecloudplatform/workflows-samples`. Default `http.default_retry` matches Inngest's defaults for HTTP 5xx; **non-HTTP errors (e.g. Spanner ABORTED)** need a custom predicate subworkflow. |
| Inngest `cancelOn: [{event, match}]` | **Pub/Sub subscription → Cloud Run cancellation service** that calls `googleapis.workflowexecutions.v1.projects.locations.workflows.executions.cancel` | No native "cancel-on-event" in Workflows. We implement it by subscribing a tiny Cloud Run service to `campaign.cancelled` and having it look up the active execution by `campaignId` (since we pinned `executionId = campaignId`) and call the cancel API. Sub-second cancellation; the running workflow's next step boundary observes the cancellation. |
| Inngest `step.sendEvent` (fan-out via event publish) | **`call: googleapis.pubsub.v1.projects.topics.publish`** + **Eventarc trigger** to start child workflows | Pub/Sub publish is at-least-once; downstream Workflows triggered by Eventarc are at-least-once. We need **idempotency keys** on child executions to dedupe — solved by pinning child `executionId = ${parentExecutionId}:${childKey}` (e.g. `${campaignId}:${creatorId}`). |
| Inngest event-schema enforcement (`EventSchemas().fromZod`) | **Pub/Sub Schema Registry** with Avro or Protobuf, enforced at topic publish | D36 already mandates AsyncAPI 3.0 → Pub/Sub Schema Registry. Same Zod schemas in `@ss/contracts` codegen to Avro via `zod-to-avro` (TBD) or hand-mirrored. |
| Inngest cron trigger | **Cloud Scheduler** → publishes to Pub/Sub → **Eventarc** triggers Workflows | Three-tier indirection but is the recommended pattern (cloud.google.com/workflows/docs/schedule-workflow). Alternative: Cloud Scheduler can directly target Workflows via HTTP — simpler for the 5 cron-only workflows. |
| Inngest function-level concurrency limits | **Workflows execution quota: 5000 active per region** (hard) + **per-tenant concurrency via Cloud Tasks rate-limit** | Workflows has no built-in per-function concurrency cap. For `creator-track` fan-out at scale we route through a Cloud Tasks queue with `maxConcurrentDispatches` so we don't overrun downstream rate-limits (Gmail API quota, Anthropic API quota). |
| Inngest step memoization / output caching | **Workflows step result journaling** (automatic) | Identical durability semantics. Workflows snapshots each `assign:` and `call:` result; on retry it skips completed steps. Outputs >512 KiB total per execution must spill to Cloud Storage. |
| Inngest version pinning (function-level) | **Workflows revisions** (`gcloud workflows deploy --revision`) + **Cloud Deploy canary** | Workflows supports revisions; new executions go to the new revision but **already-running executions stay on the revision they started on**. Same durable-deploy semantics. |

---

## 3. Pattern catalog — before/after for the 5 v2 workflow patterns

### 3.1 Brand-campaign fan-out (`brand-campaign.ts`)

**Before** (Inngest, `brand-campaign.ts:110-114` + `brand-campaign.ts:185-197`):

```ts
const vetOutcomes = await Promise.all(
  candidates.map((c, i) =>
    step.run(`vet-${i}`, async () => runAgent(vettingAgent, { brief, candidate: c }, agentCtx)),
  ),
);
// ... later:
await step.sendEvent(
  "creator-track-fanout",
  confirmed.map((c) => ({
    name: Events.CreatorTrackStart,
    data: { campaignId, brief, creator: c.creator, ...(emailLookup[c.creator.id] ? { creatorEmail: emailLookup[c.creator.id] } : {}), recentPosts: [] },
  })),
);
```

**After** (Cloud Workflows YAML, executed inside the brand-campaign workflow):

```yaml
- vetting_fanout:
    parallel:
      shared: [vetted]
      for:
        value: candidate
        in: ${candidates}
        steps:
          - call_vetting_agent:
              try:
                call: http.post
                args:
                  url: ${"https://agent-runtime-" + sys.get_env("GOOGLE_CLOUD_REGION") + "-uc.a.run.app/agents/vetting/invoke"}
                  auth:
                    type: OIDC
                  body:
                    brief: ${brief}
                    candidate: ${candidate}
                  timeout: 900   # 15 min
                result: vetting_response
              retry:
                predicate: ${http.default_retry_predicate}
                max_retries: 3
                backoff:
                  initial_delay: 2
                  max_delay: 60
                  multiplier: 2
          - accumulate_vetted:
              switch:
                - condition: ${vetting_response.body.kind == "ok"}
                  steps:
                    - push:
                        assign:
                          - vetted: ${list.concat(vetted, [vetting_response.body.value])}

- creator_track_fanout:
    for:
      value: c
      in: ${confirmed}
      steps:
        - publish_child_event:
            call: googleapis.pubsub.v1.projects.topics.publish
            args:
              topic: ${"projects/" + sys.get_env("GOOGLE_CLOUD_PROJECT_ID") + "/topics/creator-track-start"}
              body:
                messages:
                  - data: ${base64.encode(json.encode({"campaignId": campaignId, "creatorId": c.creator.id, "brief": brief, "creator": c.creator, "creatorEmail": map.get(emailLookup, c.creator.id, null)}))}
                    attributes:
                      campaignId: ${campaignId}
                      creatorId: ${c.creator.id}
                      v2EventType: ${"creator-track.start"}
```

**Eventarc Advanced** routes the `creator-track-start` topic to the `creator-track` workflow with `executionId = ${campaignId}:${creatorId}` (deterministic, idempotent against duplicate Pub/Sub delivery). The router service (Cloud Run, deployed once) reads the message, computes the executionId, and calls `executions.run`.

**Differences worth flagging**:

- `Promise.all` becomes Workflows `parallel: for:` — semantically identical, but Workflows enforces **a per-iteration timeout** on each step inside the loop (vetting agent ≤ 15 min, set on the `http.post` call).
- The shared `vetted` accumulator pattern matches the Workflows docs sample exactly (`parallel_for_in.workflows.yaml` from `/googlecloudplatform/workflows-samples`).
- We lose Inngest's "transparent fan-out" — must hand-roll the Pub/Sub publish loop. Net: ~20 extra lines of YAML, no semantic change.

### 3.2 14-day reply wait with `if`-correlation (`creator-track.ts:330-334`)

**Before** (Inngest):

```ts
const reply = await step.waitForEvent<GmailReplyData>(`await-reply:${campaignId}:${creatorId}`, {
  event: Events.GmailReplyReceived,
  timeout: REPLY_TIMEOUT,   // "3d"
  if: `async.data.campaignId == "${campaignId}" && async.data.creatorId == "${creatorId}" && async.data.threadId == "${sendResult.threadId}"`,
});
if (!reply) { /* timeout path → no_response */ }
```

The lesson at `creator-track.ts:322-329` — "use `async.data.X` not `event.data.X`" — has a direct analog in Workflows: in a callback handler, the **trigger arguments are `${args.*}`** (pre-evaluated, stable for the whole execution) and the **callback POST body is `${callback_result.body.*}`** (only available after `await_callback` returns). Mis-substituting one for the other is the exact same class of bug, but the names are different enough that the error surface is reduced.

**After** (Cloud Workflows):

```yaml
- await_gmail_reply:
    call: events.await_callback
    args:
      callback: ${callback_endpoint}
      timeout: 259200    # 3 days in seconds
    result: reply_callback

- handle_reply_or_timeout:
    switch:
      - condition: ${reply_callback != null}
        next: classify_reply
      - condition: true
        steps:
          - mark_no_response:
              call: http.post
              args:
                url: ${TRACK_REPO_URL + "/patch"}
                body:
                  campaignId: ${campaignId}
                  creatorId: ${creatorId}
                  state: "no_response"
                  emailsSent: 1
                  threadId: ${sendResult.threadId}
              auth:
                type: OIDC
          - return_no_response:
              return:
                terminalState: "no_response"
                threadId: ${sendResult.threadId}
```

Earlier in the same workflow, before the send-outreach step, we create the callback endpoint and persist it under `(campaignId, creatorId, threadId)` so the router can find it:

```yaml
- create_reply_callback:
    call: events.create_callback_endpoint
    args:
      http_callback_method: "POST"
    result: callback_endpoint

- register_callback_in_router:
    call: http.post
    args:
      url: ${CALLBACK_ROUTER_URL + "/register"}
      body:
        eventType: "gmail.reply.received"
        correlation:
          campaignId: ${campaignId}
          creatorId: ${creatorId}
          threadId: ${sendResult.threadId}
        callbackUrl: ${callback_endpoint.url}
      auth:
        type: OIDC
```

The **callback router** (one small Cloud Run service, ~150 LOC) subscribes to the `gmail.reply.received` Pub/Sub topic. On each message it:

1. Extracts `(campaignId, creatorId, threadId)` from the message data.
2. Looks up the matching `callback_url` in Spanner table `v2_workflow_callbacks` (PK = `(eventType, campaignId, creatorId, threadId)`).
3. POSTs the message body to that URL.
4. Deletes the row (one-shot semantics).

This is the GCP-native equivalent of Inngest's filter-by-`if`-expression machinery. It looks like more moving parts but each piece is observable in Cloud Trace and the router is shared across all 5 correlation waits.

**The `async.data.X` ↔ `event.data.X` trap** maps to: never reference `${args.threadId}` inside a step that comes after `await_callback` expecting it to mean "the awaited event's threadId" — that would be `${reply_callback.body.threadId}`. Same root cause, same fix discipline. We document this in the workflow YAML comment block (already required by D35).

### 3.3 Tournament fan-out + collect (`brand-campaign.ts` vetting; same pattern reused in `outreach_writer`)

The outreach writer's "5 angles × 4 judges" tournament happens **inside the agent** (Anthropic SDK loop, not workflow-level). From the workflow's perspective it's a single `step.run("draft-outreach", …)`. So the workflow-level tournament pattern is the **vetting fan-out** in §3.1. No additional translation needed beyond `parallel: for:`.

Worth noting: if we ever want to **lift the tournament into the workflow** (so each angle's draft is a Workflows step, scorable in Cloud Trace, retryable independently), the pattern is identical to §3.1's `parallel: for:` with `shared: [drafts]`. D25's Agent Optimizer might want this for offline replay — but it's not in the Track 2 day-1 scope.

### 3.4 Approval gate (`gate.ts`)

**Before** (`gate.ts:117-175`):

```ts
export async function gate<P>(step: StepLike, gateConfig: GateConfig, opts: GateOpts<P>): Promise<GateResolution<P>> {
  if (gateConfig.mode === "auto") return { decision: "approved", payload: opts.recommendation };
  if (gateConfig.mode === "auto_unless") {
    const shouldEscalate = gateConfig.escalateIf ? evaluatePredicate(gateConfig.escalateIf, opts.recommendation) : false;
    if (!shouldEscalate) return { decision: "approved", payload: opts.recommendation };
  }
  const approvalId = await step.run(`approval:create:${opts.kind}`, async () => {
    const a = await approvalRepo.create({ /* ... */ });
    return a.id;
  });
  await step.sendEvent(`approval-inbox:${opts.kind}`, { name: "approval/created", data: { approvalId, /* ... */ } });
  const resolved = await step.waitForEvent(`await-approval:${approvalId}`, {
    event: "approval/resolved",
    if: `async.data.approvalId == "${approvalId}"`,
    timeout: "7d",
  });
  if (!resolved) throw new ApprovalTimeoutError(approvalId, opts.kind);
  return { decision: resolved.data.decision, payload: (resolved.data.editedPayload ?? opts.recommendation) as P };
}
```

**After** (Cloud Workflows subworkflow — call sites embed it as `call: gate`):

```yaml
gate:
  params: [campaignId, workspaceId, kind, recommendation, rationale, gateConfig]
  steps:
    - fast_path_auto:
        switch:
          - condition: ${gateConfig.mode == "auto"}
            return:
              decision: "approved"
              payload: ${recommendation}

    - evaluate_auto_unless:
        switch:
          - condition: ${gateConfig.mode == "auto_unless"}
            steps:
              - call_predicate_eval:
                  call: http.post
                  args:
                    url: ${GATE_PREDICATE_URL}
                    body:
                      escalateIf: ${gateConfig.escalateIf}
                      recommendation: ${recommendation}
                    auth:
                      type: OIDC
                  result: predicate_eval
              - branch_on_predicate:
                  switch:
                    - condition: ${not predicate_eval.body.shouldEscalate}
                      return:
                        decision: "approved"
                        payload: ${recommendation}

    - create_approval_row:
        call: http.post
        args:
          url: ${APPROVALS_API_URL + "/create"}
          body:
            workspaceId: ${workspaceId}
            campaignId: ${campaignId}
            kind: ${kind}
            recommendation: ${recommendation}
            rationale: ${rationale}
          auth:
            type: OIDC
        result: approval_create

    - create_callback:
        call: events.create_callback_endpoint
        args:
          http_callback_method: "POST"
        result: callback_endpoint

    - persist_callback_url:
        call: http.post
        args:
          url: ${APPROVALS_API_URL + "/" + approval_create.body.approvalId + "/callback-url"}
          body:
            callbackUrl: ${callback_endpoint.url}
          auth:
            type: OIDC

    - notify_inbox:
        call: googleapis.pubsub.v1.projects.topics.publish
        args:
          topic: ${"projects/" + sys.get_env("GOOGLE_CLOUD_PROJECT_ID") + "/topics/approval-created"}
          body:
            messages:
              - data: ${base64.encode(json.encode({"approvalId": approval_create.body.approvalId, "campaignId": campaignId, "workspaceId": workspaceId, "kind": kind}))}
                attributes:
                  approvalId: ${approval_create.body.approvalId}
                  kind: ${kind}

    - await_resolution:
        try:
          call: events.await_callback
          args:
            callback: ${callback_endpoint}
            timeout: 604800    # 7 days
          result: resolution
        except:
          as: e
          steps:
            - raise_timeout:
                raise: ${"ApprovalTimeout:" + approval_create.body.approvalId + ":" + kind}

    - return_resolution:
        return:
          decision: ${resolution.body.decision}
          payload: ${default(resolution.body.editedPayload, recommendation)}
```

The MC API change is minimal: when the human (or another agent) resolves an approval via `POST /api/approvals/[id]/resolve`, the API server reads the persisted `callback_url` from Spanner and POSTs to it directly — instead of publishing an `approval/resolved` event for Inngest to pick up. The callback URL **is** the correlation key, which removes the `if`-expression class of bugs entirely.

The `evaluatePredicate` function in `gate.ts:71-115` is hand-rolled JS for evaluating shape-based predicates (`fitScoreLt`, `followerCountGte`, `spamScoreGte`, `proposedRateUsdGte`, `replyClassIn`). It can stay on the JS side — wrapped in a tiny Cloud Run service exposing `POST /evaluate-predicate` — or be expressed as a Workflows subworkflow with `switch:` chains. The Cloud Run option preserves the existing tests in `gate.test.ts` (porting them would be wasteful).

### 3.5 Cron-style scheduling

**Before** (Inngest, e.g. `tiktok-post-poller.ts:208`):

```ts
export const tiktokPostPoller = inngest.createFunction(
  { id: "tiktok-post-poller" },
  { cron: "0 2 * * *" },
  async ({ step }) => { /* poll TikTok for new posts ... */ },
);
```

**After** (Cloud Scheduler → direct Workflows HTTP target):

```bash
gcloud scheduler jobs create http tiktok-post-poller \
  --location=us-central1 \
  --schedule="0 2 * * *" \
  --time-zone="Etc/UTC" \
  --uri="https://workflowexecutions.googleapis.com/v1/projects/${PROJECT}/locations/us-central1/workflows/tiktok-post-poller/executions" \
  --http-method=POST \
  --oauth-service-account-email="scheduler-sa@${PROJECT}.iam.gserviceaccount.com" \
  --message-body='{}'
```

This is the **simpler** of the two recommended GCP patterns and is documented at cloud.google.com/workflows/docs/schedule-workflow. The Pub/Sub indirection (Cloud Scheduler → Pub/Sub → Eventarc → Workflows) is only worth it if multiple consumers need the same scheduled signal. None of our 5 crons fan out — so direct-HTTP wins.

Each of the 5 cron workflows (campaign-progression, gmail-watch-renew, tiktok-post-poller, shipment-tracking-poller, report-deliver-cron) gets its own scheduler job. Schedules port verbatim:

| Workflow | Inngest cron | Cloud Scheduler |
|---|---|---|
| `campaign-progression` | `0 3 * * *` | `0 3 * * *` |
| `gmail-watch-renew` | `0 4 * * *` | `0 4 * * *` |
| `tiktok-post-poller` | `0 2 * * *` | `0 2 * * *` |
| `shipment-tracking-poller` | `0 4,16 * * *` | `0 4,16 * * *` |
| `report-deliver-cron` | `0 9 * * 1` | `0 9 * * 1` |

Cloud Scheduler ships with **at-least-once delivery** and **3-retry default** — equivalent to Inngest's cron semantics. **Critical caveat**: if a workflow takes longer than the interval (`gmail-watch-renew` shouldn't), Workflows will start a second concurrent execution. We add a Spanner-backed advisory lock at the start of each cron workflow if that's a real risk (it isn't for any of the 5).

---

## 4. Workflow YAML samples

Three full Workflows definitions, deploy-ready (minus the auth-service-account substitution and the env vars).

### 4.1 `brand-campaign.workflows.yaml` — the parent fan-out workflow

```yaml
# packages/workflows/yaml/brand-campaign.workflows.yaml
# Mirrors packages/workflows/src/workflows/brand-campaign.ts under D18.
# Trigger: Eventarc subscription on Pub/Sub topic "campaign-submitted".
# Cancellation: Pub/Sub "campaign-cancelled" → cancel-on-event Cloud Run service.

main:
  params: [args]
  steps:
    - init:
        assign:
          - campaignId: ${args.campaignId}
          - brief: ${args.brief}
          - workspaceId: ${brief.workspaceId}
          - vetted: []
          - confirmed: []
          - shortlist: []

    - observability_init:
        call: http.post
        args:
          url: ${sys.get_env("OBSERVABILITY_URL") + "/runs"}
          body:
            campaignId: ${campaignId}
            workflow: "brand-campaign"
          auth:
            type: OIDC
        retry: ${http.default_retry}

    - load_policy:
        call: http.post
        args:
          url: ${sys.get_env("POLICY_URL") + "/get"}
          body:
            workspaceId: ${workspaceId}
          auth:
            type: OIDC
        result: policy_response
    - assign_policy:
        assign:
          - policy: ${policy_response.body}

    - patch_stage_sourcing:
        call: http.post
        args:
          url: ${sys.get_env("CAMPAIGN_REPO_URL") + "/patch-stage"}
          body:
            campaignId: ${campaignId}
            stage: "sourcing"
            state: "running"
          auth:
            type: OIDC

    - sourcing_agent:
        call: http.post
        args:
          url: ${sys.get_env("AGENT_RUNTIME_URL") + "/agents/sourcing/invoke"}
          body:
            brief: ${brief}
            campaignId: ${campaignId}
            campaignBudgetUsd: ${policy.budgets.maxUsdPerCampaign}
            excludeCreatorIds: []
          auth:
            type: OIDC
          timeout: 1500
        retry:
          predicate: ${http.default_retry_predicate}
          max_retries: 3
          backoff: {initial_delay: 5, max_delay: 120, multiplier: 2}
        result: sourcing_response

    - check_sourcing_outcome:
        switch:
          - condition: ${sourcing_response.body.kind != "ok"}
            raise: ${"sourcing_escalated:" + sourcing_response.body.reason}
    - assign_candidates:
        assign:
          - candidates: ${sourcing_response.body.value.candidates}

    - vetting_fanout:
        parallel:
          shared: [vetted]
          for:
            value: candidate
            in: ${candidates}
            steps:
              - call_vetting:
                  try:
                    call: http.post
                    args:
                      url: ${sys.get_env("AGENT_RUNTIME_URL") + "/agents/vetting/invoke"}
                      body:
                        brief: ${brief}
                        candidate: ${candidate}
                        campaignId: ${campaignId}
                      auth:
                        type: OIDC
                      timeout: 900
                    result: vet_response
                  retry:
                    predicate: ${http.default_retry_predicate}
                    max_retries: 3
                    backoff: {initial_delay: 2, max_delay: 60, multiplier: 2}
              - keep_if_ok:
                  switch:
                    - condition: ${vet_response.body.kind == "ok"}
                      steps:
                        - push_vetted:
                            assign:
                              - vetted: ${list.concat(vetted, [vet_response.body.value])}

    - pick_shortlist:
        call: http.post
        args:
          url: ${sys.get_env("PICK_SHORTLIST_URL") + "/pick"}
          body:
            vetted: ${vetted}
            targetCount: ${brief.targeting.creatorCount}
          auth:
            type: OIDC
        result: shortlist_response
    - assign_shortlist:
        assign:
          - shortlist: ${shortlist_response.body}

    - gate_approve_shortlist:
        call: gate
        args:
          campaignId: ${campaignId}
          workspaceId: ${workspaceId}
          kind: "shortlist"
          recommendation: ${shortlist}
          rationale: ${"Vetted: " + string(len(vetted)) + ". Shortlist: " + string(len(shortlist)) + "."}
          gateConfig: ${policy.gates.approveShortlist}
        result: gate_result

    - branch_on_gate:
        switch:
          - condition: ${gate_result.decision == "rejected"}
            return:
              campaignId: ${campaignId}
              stage: "sourcing"
              decision: "rejected"
              trackCount: 0
          - condition: true
            assign:
              - confirmed: ${gate_result.payload}

    - persist_tracks:
        for:
          value: c
          in: ${confirmed}
          steps:
            - upsert_track:
                call: http.post
                args:
                  url: ${sys.get_env("CAMPAIGN_REPO_URL") + "/upsert-track"}
                  body:
                    campaignId: ${campaignId}
                    creatorId: ${c.creator.id}
                    stage: "sourcing"
                    state: "shortlisted"
                  auth:
                    type: OIDC

    - advance_stage_outreach:
        call: http.post
        args:
          url: ${sys.get_env("CAMPAIGN_REPO_URL") + "/patch-stage"}
          body:
            campaignId: ${campaignId}
            stage: "outreach"
          auth:
            type: OIDC

    - resolve_creator_emails:
        call: http.post
        args:
          url: ${sys.get_env("CREATOR_DIRECTORY_URL") + "/resolve-emails"}
          body:
            creatorIds: ${list.map(confirmed, "creator.id")}
          auth:
            type: OIDC
        result: email_lookup_response
    - assign_email_lookup:
        assign:
          - emailLookup: ${email_lookup_response.body}

    - fanout_creator_tracks:
        for:
          value: c
          in: ${confirmed}
          steps:
            - publish_creator_track_start:
                call: googleapis.pubsub.v1.projects.topics.publish
                args:
                  topic: ${"projects/" + sys.get_env("GOOGLE_CLOUD_PROJECT_ID") + "/topics/creator-track-start"}
                  body:
                    messages:
                      - data: ${base64.encode(json.encode({"campaignId": campaignId, "brief": brief, "creator": c.creator, "creatorEmail": map.get(emailLookup, c.creator.id, ""), "recentPosts": []}))}
                        attributes:
                          campaignId: ${campaignId}
                          creatorId: ${c.creator.id}
                          v2EventType: "creator-track.start"

    - return_result:
        return:
          campaignId: ${campaignId}
          stage: "outreach"
          shortlistCount: ${len(shortlist)}
          trackCount: ${len(confirmed)}
          decision: ${gate_result.decision}
```

### 4.2 `creator-track.workflows.yaml` — the long-running per-creator child

The full file is ~400 lines; here is the load-bearing reply-wait segment (the rest follows the same patterns from §3):

```yaml
# packages/workflows/yaml/creator-track.workflows.yaml (extract)
# Trigger: Eventarc → Pub/Sub topic "creator-track-start".

main:
  params: [args]
  steps:
    - init:
        assign:
          - campaignId: ${args.campaignId}
          - brief: ${args.brief}
          - creator: ${args.creator}
          - creatorEmail: ${default(args.creatorEmail, "")}
          - workspaceId: ${brief.workspaceId}
          - creatorId: ${creator.id}

    - check_email:
        switch:
          - condition: ${creatorEmail == ""}
            steps:
              - mark_no_email:
                  call: http.post
                  args:
                    url: ${sys.get_env("CAMPAIGN_REPO_URL") + "/patch-track"}
                    body:
                      campaignId: ${campaignId}
                      creatorId: ${creatorId}
                      state: "no_response"
                    auth:
                      type: OIDC
              - return_no_email:
                  return:
                    terminalState: "no_email"
                    reason: "creator has no resolvable email"

    # ... policy load, extract-facts, draft-outreach, approve-outreach-send
    # gate, send-outreach via gmail.send capability (all omitted) ...

    - create_reply_callback:
        call: events.create_callback_endpoint
        args:
          http_callback_method: "POST"
        result: reply_callback_endpoint

    - register_reply_callback:
        call: http.post
        args:
          url: ${sys.get_env("CALLBACK_ROUTER_URL") + "/register"}
          body:
            eventType: "gmail.reply.received"
            correlation:
              campaignId: ${campaignId}
              creatorId: ${creatorId}
              threadId: ${sendResult.threadId}
            callbackUrl: ${reply_callback_endpoint.url}
            ttlSeconds: 259200
          auth:
            type: OIDC

    - await_reply:
        try:
          call: events.await_callback
          args:
            callback: ${reply_callback_endpoint}
            timeout: 259200    # 3 days
          result: reply_callback
        except:
          as: e
          steps:
            - timeout_no_response:
                call: http.post
                args:
                  url: ${sys.get_env("CAMPAIGN_REPO_URL") + "/patch-track"}
                  body:
                    campaignId: ${campaignId}
                    creatorId: ${creatorId}
                    state: "no_response"
                    threadId: ${sendResult.threadId}
                  auth:
                    type: OIDC
            - return_no_response:
                return:
                  terminalState: "no_response"
                  threadId: ${sendResult.threadId}

    # ... classify-reply, gate(approveReplyResponse), send-reply, terminal mark.
```

### 4.3 `gate.workflows.yaml` — reusable subworkflow

See §3.4 above for the complete subworkflow body. Invoke at any call site with:

```yaml
- approve_shortlist:
    call: gate
    args:
      campaignId: ${campaignId}
      workspaceId: ${workspaceId}
      kind: "shortlist"
      recommendation: ${shortlist}
      rationale: ${rationale_text}
      gateConfig: ${policy.gates.approveShortlist}
    result: gate_result
```

---

## 5. Risk register — features that DON'T map cleanly

| # | Inngest feature | Status on GCP | Mitigation |
|---|---|---|---|
| R1 | `step.sendEvent(payload)` is atomic with the surrounding step's commit (no message lost if the workflow crashes between "decide" and "publish") | **Not equivalent.** Workflows' `call: googleapis.pubsub.v1.projects.topics.publish` is a separate API call; if the workflow execution is killed between step result journaling and the publish landing, you lose the message. | Implement the **outbox pattern**: the step that decides to fan out writes to a `v2_outbox` Spanner table within the same transaction as its business-data writes. A small Cloud Run "outbox dispatcher" subscribes to Spanner change streams (or polls), publishes to Pub/Sub, and marks the outbox row sent. This is the canonical pattern for transactional fan-out and is documented as part of D18 — we already use it for `gmail.send` idempotency (see `creator-track.ts:298-313`). |
| R2 | Inngest "step memo" (cache by step name within a run) | Workflows step results are journaled per-execution by name — **equivalent**. The two implementations differ at the binary level but the developer-visible behavior is the same. | None needed. |
| R3 | Function-level concurrency limits (`{concurrency: {limit: 5}}`) | **No native equivalent in Workflows.** Workflows enforces a per-region 5000 active executions hard cap; nothing finer. | Per-tenant concurrency for the `creator-track` fan-out is enforced by routing the Pub/Sub fan-out through a **Cloud Tasks queue** with `maxConcurrentDispatches` per tenant (Cloud Tasks supports per-queue rate-limits at fine granularity). The router service (already needed for §3.2's correlation lookup) does double duty: it consumes the fan-out topic, looks up the tenant's concurrency policy, and dispatches to a per-tenant Cloud Tasks queue that hits the `/start-creator-track-workflow` endpoint. |
| R4 | Inngest function "version pinning" (in-flight runs stay on the version they started on) | **Equivalent.** Workflows revisions behave identically. | None. |
| R5 | Inngest event-schema enforcement at publish time via `EventSchemas().fromZod` | **Equivalent via Pub/Sub Schema Registry** (D36 mandates AsyncAPI 3.0 here). | Zod schemas in `@ss/contracts` codegen to Avro (codegen tool TBD — `zod-to-avro` exists but is unmaintained; alternative is hand-mirrored protobuf with a CI assertion). |
| R6 | Inline `if`-expression on `waitForEvent` (matches arbitrary payload fields) | **Not natively equivalent.** Eventarc filters CEL over CloudEvent **attributes** only; payload-field correlation requires the router service. | Already designed in §3.2 / §3.4: the callback-URL **is** the correlation token. The router maps `(eventType, key1, key2, key3) → callback_url` in Spanner. Net: ~150 LOC + 1 Spanner table, in exchange for losing the `if`-expression class of bugs (the SDK pre-evaluation footgun documented at `creator-track.ts:322-329` cannot occur because there's no expression to mis-substitute). |
| R7 | Inngest `cancelOn` (event-driven cancellation of in-flight runs) | **Not native.** Workflows has `executions.cancel` API but no event-driven trigger. | Cancel-on-event is a 50-LOC Cloud Run subscriber on the `campaign.cancelled` topic that calls `executions.cancel` with `executionId = ${campaignId}`. Requires the deterministic-executionId convention (§2 row 4) to be enforced — which it is via the router. |
| R8 | Inngest test ergonomics: `fakeStep` driver in `*.test.ts` files (e.g. `brand-campaign.test.ts:23-40`) | **Partially preserved.** The `StepLike` interface in `gate.ts:48-56` can stay — we extract the workflow logic into TypeScript functions that take a `StepLike`, and have two adapters: one that drives Inngest (current), one that compiles the calls to Workflows YAML steps. | See §6 for the test-migration plan. |
| R9 | Inngest's "step is durable, sleep is durable" baseline | **Equivalent** — Workflows results journal + `sys.sleep` + `await_callback` give the same durability profile. | None. |
| R10 | Inngest `step.invoke` (call another Inngest function and await its result) | **Equivalent via `call: googleapis.workflowexecutions.v1.projects.locations.workflows.executions.run`** with `await: true`. We don't currently use `step.invoke` in v2 — `step.sendEvent` is the fan-out pattern — so no porting work. | None. |
| R11 | Inngest pricing: a single SaaS invoice; Workflows pricing: separate quotas across Workflows + Pub/Sub + Cloud Tasks + Cloud Scheduler + Cloud Run (router) | **More services to monitor.** | Single Grafana dashboard sums all 5 service costs. D39's $1500 credits cover this comfortably (see §8). |
| R12 | Inngest dashboard: per-function run history, step-level retry view | **Workflows console + Cloud Trace** give per-execution and per-step views; Cloud Logging gives raw event history. Different UX, equivalent visibility. | Operator training (1 hour). M3 PM agent documents the dashboard URLs in `submission-playbook/`. |
| R13 | Inngest `step.run` output size: ~1 MB per step | **Workflows: 512 KiB per variable, no explicit per-step output limit but executions cap total variable size**. | The sourcing agent's candidate-list output can exceed 512 KiB if N > ~100. Mitigation: agents that return large lists stage to Cloud Storage (return a GCS URI), and downstream steps read it. Already a pattern we'd want for D20 CMEK compliance. |
| R14 | Inngest's automatic per-step OpenTelemetry trace | **Workflows emits a per-execution trace span; per-step spans require manual `call: http.post` to OTLP collector.** | Add a tiny "trace dispatcher" step around each `call:` if we need per-step visibility — OR rely on the downstream Cloud Run service's own OTel exporter (preferred; D31 says everything writes OTel). |

---

## 6. Test migration

### 6.1 What we have

The vitest workflow tests (e.g. `brand-campaign.test.ts:23-40`) drive `brandCampaignHandler` with a **fake step** that implements `StepLike` from `gate.ts:48-56`:

```ts
function fakeStep(approvedResolution: "approved" | "edited" | "rejected" = "approved"): {
  step: StepLike;
  log: { runs: string[] };
} {
  const log = { runs: [] as string[] };
  const step: StepLike = {
    async run(name, fn) { log.runs.push(name); return fn(); },
    async sendEvent() { return { ids: ["evt"] }; },
    async waitForEvent<T>(name: string, _opts) {
      const approvalId = name.replace("await-approval:", "");
      return { data: { approvalId, campaignId: "camp_wf1", decision: approvedResolution } as unknown as T };
    },
  };
  return { step, log };
}
```

103 workflow tests pass against this pattern (per `STATUS.md`).

### 6.2 What to preserve

**Keep the `StepLike` interface unchanged.** It's a generic durable-step abstraction; nothing about it ties to Inngest specifically (the comment at `gate.ts:42-47` even spells this out). The workflows already use `StepLike` instead of the Inngest concrete step type — that was forward-thinking.

The migration strategy is:

1. **Keep the workflow handlers (`brandCampaignHandler`, `creatorTrackHandler`, `gateImpl`, etc.) as TypeScript functions** that take `StepLike`.
2. **Replace Inngest with two adapters**:
   - **Test adapter** = the existing `fakeStep` from `brand-campaign.test.ts:23-40`. **No change.**
   - **Production adapter** = a small "Workflows-step compiler" that emits the YAML in §4 from the same handler functions, OR (cheaper short-term) **a Cloud Run service that hosts the same TS handler and is invoked from a thin Workflows YAML** that delegates each `step.run` to the Cloud Run service.

Option B (Cloud Run host) is materially less risky for the Track 2 submission window: it preserves the entire TS handler (zero rewrite of the 7 workflow files) and only changes the registration glue. The Workflows YAML becomes the orchestration layer, the TS code stays the application layer, and the `StepLike` adapter speaks both directions.

### 6.3 What changes in tests

Three changes:

1. **`fakeStep.waitForEvent`** is no longer pretending to "match by `if`-expression" — it's pretending to be a callback. Update the fake to return whatever's in a per-test scripted queue indexed by callback creation order. Net: 5 lines of test-helper change in `creator-track.test.ts` (similar fakes), zero in `brand-campaign.test.ts` (it asserts on `runs` log, not on event-correlation).

2. **End-to-end smoke tests** that today hit `npx inngest-cli dev` get a new dependency on a **local Workflows emulator** — Google ships one at `gcloud workflows execute --location=<region> --data='{...}' --workflow=local`. The smoke tests change one CLI invocation each. Net: 5 smoke tests × 1-line change.

3. **The `imports.v1-workspaces.test.ts` and `imports.v2-rollout.test.ts` tests** assert that the v2 Inngest client wires the right events — these are deleted and replaced with a single test that asserts the Pub/Sub topic+schema bindings (`v2_topics.json` config matches the `Events.*` enum).

### 6.4 What doesn't change

- Agent tests (`packages/agents/src/**/*.test.ts`) — agents are just functions that take an `AgentRunContext`. They never see the workflow runtime. **Zero change.**
- Capability tests (`packages/capabilities/src/**/*.test.ts`) — capabilities are HTTP-typed boundaries. They never see the workflow runtime. **Zero change.**
- Observability tests (`packages/observability/src/**/*.test.ts`) — purely structural. **Zero change.**

Net test-migration effort: ~20 LOC of test-helper changes + 5 smoke-script-line changes + 2 test deletions + 1 new schema-binding test. **Less than half a day for the rebuild agent.**

### 6.5 New tests to add

- **Callback-router unit tests** (router service is new code, ~10 tests).
- **Cancel-on-event service unit tests** (new code, ~5 tests).
- **Outbox dispatcher unit tests** (new code, ~5 tests).
- **Workflows YAML lint** — run `gcloud workflows deploy --dry-run` per YAML in CI. 1 CI job, no per-test work.
- **Per-region YAML deploy smoke** — 1 CI job that deploys all workflows to a tear-down project and runs the `scripts/run-demo.ts --type=brand` flow against the real Workflows execution. ~15 minutes of CI per PR; we accept this for D31 SLO confidence.

---

## 7. Cost comparison — Inngest vs Workflows+Pub/Sub+Cloud Tasks

### 7.1 v2 demo volume (per `STATUS.md` + `scripts/run-demo.ts`)

- 1 `brand-campaign` execution per demo run.
- Fan-out to ~3-10 `creator-track` children.
- Each `creator-track` runs: ~10 `step.run` + 1-3 `waitForEvent` over up to 14 days.
- ~5 cron workflows run once a day each.

Daily (steady-state, judging window): 1 brand campaign × 5 creator-tracks + 5 crons = **~60 step.run calls/day** + **~15 callback awaits/day**. Monthly: ~1800 step.run + 450 callbacks.

For demo-week rehearsal we estimate 20 full demo runs × ~70 steps each = 1400 step.run calls / week, **~6000 step.run calls/month** at peak.

### 7.2 Inngest pricing (as of 2026-05-19)

Inngest's published pricing tiers (the SaaS bill we'd replace):

| Tier | Step runs/mo | Concurrent runs | Monthly cost |
|---|---|---|---|
| Hobby | 50K | 25 | $0 |
| Pro | 250K | 200 | $50 |
| Enterprise | custom | custom | custom (typically $500+) |

At v2 demo volume (~6000 step.run/mo peak), we sit in the Hobby tier — **$0/month** until production scale. At 100 campaigns/month × 10 creator-tracks × 70 steps = 70K step.run/mo, still Hobby. At 1000 campaigns/month we cross into Pro at $50/mo. Track 3-time-to-revenue says crossover doesn't matter for the submission.

### 7.3 GCP-native equivalent at the same volume

**Cloud Workflows** (cloud.google.com/workflows/pricing):

- First 5000 internal steps/mo free.
- $0.01 per 1000 internal steps thereafter.
- External steps (any `http.post` to a non-Google service): $0.025 per 1000.

At 6000 step.run/mo (all "internal" since we POST to Cloud Run via OIDC, which counts internal): essentially **$0/mo** during the demo window. At 70K step.run/mo: ~$0.65/mo. At 1M step.run/mo: ~$10/mo.

**Pub/Sub** (cloud.google.com/pubsub/pricing):

- $40 per TiB of message-data throughput, first 10 GiB free per month.
- Our message bodies are <2 KiB each; 6000 fan-out publishes/mo = ~12 MiB. **Free tier covers everything for the foreseeable future.**

**Cloud Tasks** (cloud.google.com/tasks/docs/pricing):

- First 1M task operations/mo free, $0.40/M thereafter.
- Used only for per-tenant rate-limiting on `creator-track` fan-out (R3 mitigation). 60 dispatches/day × 30 = 1800/mo. **Free.**

**Cloud Scheduler** (cloud.google.com/scheduler/pricing):

- $0.10 per job per month, 3 jobs free per billing account.
- 5 cron workflows × 1 scheduler job each = 5 jobs. After the free 3: **$0.20/mo**.

**Eventarc Advanced**:

- $0.25 per 1M events processed; first 1M/mo free.
- Our event throughput is in the thousands/mo. **Free.**

**Cloud Run** (callback router, predicate evaluator, cancel-on-event subscriber, outbox dispatcher):

- 4 services × estimated 100K requests/mo total (with scale-to-zero idle). **Free tier covers it** (2M requests/mo free).

### 7.4 Headline comparison

| Volume | Inngest | GCP-native (sum) |
|---|---|---|
| Demo / judging (6K steps/mo) | $0 (Hobby) | **$0.20/mo** (Cloud Scheduler only) |
| Light production (70K steps/mo) | $0 (still Hobby) | **~$1/mo** (Workflows + Scheduler) |
| Medium production (1M steps/mo) | $50/mo (Pro tier) | **~$10/mo** (mostly Workflows external steps) |
| Heavy production (10M steps/mo) | $500+/mo (custom Enterprise) | **~$100/mo** |

At v2's demo-and-judging volume, the GCP-native stack costs an extra ~$0.20/mo over Inngest. At production scale, GCP-native is **5-10× cheaper** than Inngest Pro/Enterprise. The crossover is dominated by Workflows internal-step price ($0.01/1K) — Inngest's per-step price (effectively in their Pro tier) is ~$0.20/1K.

**One real cost the headline hides**: the 4 Cloud Run support services (router, predicate, canceller, outbox dispatcher) add ~$5-15/mo of always-on idle if we don't scale-to-zero properly. With proper scale-to-zero (cold-start tolerance is ~200 ms, fine for these latency profiles), the idle cost drops to single-digit cents. Worth verifying in week 1.

### 7.5 D39 credit envelope

Per D39, $1500 GCP credits available. The migration-introduced spend is **~$1-15/mo at production volume** — utterly negligible against the $1500 envelope. The cost lever in `gcp-research/cost-planning/COST-PLAN.md` does not move because of this migration; the dominant costs remain Gemini Pro inference (D5) and Vertex Agent Runtime always-on (D17), not orchestration.

---

## 8. Migration sequencing recommendation

Not strictly in scope for "the migration spec," but the rebuild-workflows background agent will need this:

1. **Week 0 (spec lock)**: this file lands in `gcp-research/migrations/INNGEST-MIGRATION.md`. M3 PM agent confirms with operator before any code change.
2. **Week 1 (parallel)**:
   - Stand up the **callback router** Cloud Run service in a tear-down project.
   - Stand up the **predicate evaluator** Cloud Run service (preserves `gate.test.ts`).
   - Write the 3 YAML files (§4) and `gcloud workflows deploy --dry-run` against the tear-down project.
3. **Week 2 (cutover)**:
   - Wire Eventarc triggers: `campaign-submitted` → `brand-campaign`, `creator-track-start` → `creator-track`, etc.
   - Wire Cloud Scheduler jobs (5).
   - Run `scripts/run-demo.ts --type=brand` against the tear-down project end-to-end.
   - Run `scripts/run-demo.ts --type=lead` against the tear-down project end-to-end.
4. **Week 3 (decommission)**:
   - Delete `packages/workflows/src/client.ts` (the `inngest` client export).
   - Delete the 10 `inngest.createFunction` registrations at the bottom of each workflow file — keep the exported handler functions and a new `registerWorkflows()` glue per file.
   - Drop `inngest` from `packages/workflows/package.json`.
   - Verify `pnpm run verify-build` is green.
5. **Submission day**: judges see Workflows console + Cloud Trace, not Inngest dashboard.

Total engineering effort: estimated **3-5 days** for the workflows-rebuild background agent, plus ~1 day of operator verification.

---

## 9. Open questions to surface to the rebuild agent

Items I would not silently decide in the rebuild PR; each warrants either a clarifying decision in `DECISIONS.md` or a chunk-level call from M3:

1. **Callback router availability**: should the router itself be multi-region active-active (D13) or single-region with failover? Multi-region means callback-URL persistence in Spanner (already global) — easy. Single-region means simpler ops but loses one nine on the global SLO.
2. **Outbox table residency**: D15 says Spanner is the multi-region core. Outbox is high-write, low-read; Spanner is fine but billable. Cheaper alternative is per-region Cloud SQL with cross-region failover, but adds a data plane. Recommendation: stay on Spanner under D15 unless cost-watch (W2) flags the table.
3. **AsyncAPI ↔ Pub/Sub Schema Registry codegen tool**: D36 mandates AsyncAPI 3.0 as source-of-truth; Pub/Sub Schema Registry consumes Avro. The codegen tool is TBD. Background research warranted before week 2.
4. **Scheduler vs Pub/Sub for crons**: §3.5 recommends direct HTTP from Scheduler. Sub-question: do any of the 5 crons benefit from also publishing to a `cron.tick` topic for D32 monitoring? Probably not — Cloud Monitoring already reports Scheduler executions.
5. **Per-tenant concurrency**: §R3 mitigation depends on Cloud Tasks queue per tenant. With multi-tenant SaaS (D12) at scale, that's a lot of queues. Cloud Tasks has no documented hard cap on queues per project but soft-caps at ~1000. Beyond that, we shard tenants into queue groups. Document the threshold in `STATUS.md` before crossing it.

These five questions are explicitly out of scope for this migration spec — they're the rebuild-agent's chunk-level decisions, surfaced here so the agent doesn't rediscover them.

---

## 10. References and citations

- Cloud Workflows pricing: cloud.google.com/workflows/pricing
- Cloud Workflows quotas + limits: cloud.google.com/workflows/quotas
- Cloud Workflows callback steps: cloud.google.com/workflows/docs/creating-callback-endpoints
- Cloud Workflows `sys.sleep`: cloud.google.com/workflows/docs/reference/stdlib/sys/sleep
- Cloud Workflows parallel for: cloud.google.com/workflows/docs/reference/syntax/parallel-steps (and `/googlecloudplatform/workflows-samples` for the `parallel_for_in.workflows.yaml` and `parallel_aggregate.workflows.yaml` examples used in §3.1)
- Cloud Workflows retry blocks: cloud.google.com/workflows/docs/reference/syntax/retry-steps (predicate + backoff)
- Pub/Sub pricing: cloud.google.com/pubsub/pricing
- Pub/Sub Schema Registry: cloud.google.com/pubsub/docs/schemas
- Cloud Tasks pricing + per-queue rate-limits: cloud.google.com/tasks/docs/pricing and cloud.google.com/tasks/docs/configuring-queues
- Cloud Scheduler pricing: cloud.google.com/scheduler/pricing
- Cloud Scheduler → Workflows direct HTTP target: cloud.google.com/workflows/docs/schedule-workflow
- Eventarc Advanced + CEL filters: cloud.google.com/eventarc/advanced/docs/cel-language-reference
- Workflows executions API (executions.run, executions.cancel, deterministic executionId): cloud.google.com/workflows/docs/reference/executions/rest

In-repo citations:
- `packages/workflows/src/client.ts:24-41` — current Inngest event-schema binding
- `packages/workflows/src/gate.ts:48-56` — `StepLike` interface (kept across migration)
- `packages/workflows/src/gate.ts:154-167` — the `async.data.X` discipline note (preserved)
- `packages/workflows/src/pause.ts:73-93` — the resume-then-cancel race (preserved)
- `packages/workflows/src/workflows/brand-campaign.ts:110-114` — vetting fan-out
- `packages/workflows/src/workflows/brand-campaign.ts:185-197` — `step.sendEvent` fan-out
- `packages/workflows/src/workflows/creator-track.ts:136-143` — REPLY/SHIPMENT/CONTENT timeouts
- `packages/workflows/src/workflows/creator-track.ts:322-334` — the load-bearing 3-day reply wait + `async.data.X` lesson
- `packages/workflows/src/workflows/creator-track.ts:753-767` — terminal-status `if`-clause on shipment wait
- `packages/workflows/src/workflows/creator-track.ts:823-832` — 14-day post-detected wait
- `packages/workflows/src/workflows/brand-campaign.test.ts:23-40` — `fakeStep` test driver (preserved)
- `packages/workflows/package.json:21` — current Inngest dependency (`^3.27.0`)

---

**End of migration spec.** When this file is updated, append a row to [`DECISIONS.md`](../decisions/DECISIONS.md) §8 change log.
