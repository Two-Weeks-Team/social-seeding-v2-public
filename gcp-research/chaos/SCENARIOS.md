# chaos/SCENARIOS.md — Chaos Engineering Scenarios for social-seeding-v2

> **Owner**: devops-architect (background agent #8)
> **Cites**: D13 (Global active-active) · D31 (Enterprise SLO) · D32 (Auto-runbook IR) · D37 (Chaos engineering as a TDD layer)
> **Status**: Authoritative pre-code spec. All failure modes below MUST have a corresponding test in `packages/chaos/` (TBD) before Phase-1 Cloud Deploy promotion.
> **Audience**: SRE on-call, the chaos lead, the 13 background-build agents, and judges reviewing D37 evidence.

---

## 1. D31 SLO refresher — what each measure means and what must survive

D31 commits the platform to four numbers. Each one is a **measurable contract** between SRE and the rest of the org, and each implies a different chaos-test discipline. Without restating D31, here is what the platform must defend.

### 1.1 99.99% availability per year — the "four nines" budget

A 99.99% annual availability target burns **52 minutes 35 seconds of error budget per year**, or roughly **4 minutes 23 seconds per month**. Anything more — across all SLI dimensions combined — means the on-call rotation owes the org a retrospective and a budget freeze on feature work until the burn rate drops.

What this means for chaos: every drill below MUST measure how much error budget it consumes. A drill that consumes >10% of monthly budget in a single run is itself a P1 finding even if the system "recovered correctly". Google's SRE Workbook defines this discipline precisely (see <https://sre.google/workbook/error-budget-policy/>).

The 99.99% target applies to the **hot path** only: the request flow `Mission Control → Global LB → Identity Platform → Agent Gateway → Model Armor → Vertex AI Agent Runtime → Spanner read (tenant lookup)`. Cold-path workflows (campaign creation, outreach send, reporting) get a softer 99.9% target — three nines, ~43 minutes/month budget.

### 1.2 p99 < 1 second on the hot path

The p99 latency measure is computed on a rolling 5-minute window via Cloud Monitoring SLI (custom metric `slo.hot_path.latency_ms` produced by the Agent Gateway). A 30-second sustained breach of p99 > 1s burns budget at 60× the normal rate; this is the canonical "fast-burn" alert per <https://cloud.google.com/stackdriver/docs/solutions/slo-monitoring/alerting-on-burn-rate>.

What must survive every chaos scenario: tail latency on the hot path. Drills that succeed on availability but blow p99 are still failures.

### 1.3 RTO 1 minute — Recovery Time Objective

From the **start of an outage signal** (a synthetic probe failing or an SLO alert firing) to **service restoration** (probe succeeding again from at least two of three regions), no more than 60 seconds may elapse. This is the operational meaning, and it forbids:

- Manual DNS changes — TTLs alone eat the budget.
- Manual Spanner failover — `gcloud spanner instances failover` is required to be **scripted** and **pre-authorized**, not approved interactively.
- Page-then-click responses — automation must take the first action; the human approves the *next* action.

This number forces every chaos drill to validate that the **D32 auto-runbook** fires and finishes inside 60 seconds for the failure modes it claims to handle (see §3.4). For modes outside the auto-runbook coverage, the drill must validate that **paging + human action** can still complete inside 60 seconds when the scenario is well-rehearsed (game day, §6).

### 1.4 RPO 30 seconds — Recovery Point Objective

No more than 30 seconds of committed customer data may be lost in a regional failover. For each data store:

- **Spanner multi-region (`nam-eur-asia1`)**: native synchronous replication; RPO = 0 by design. The 30-second budget is consumed only if the failover script itself is slow.
- **AlloyDB AI per-region**: cross-region replication via Datastream is **asynchronous**. To meet RPO 30s, replication lag must stay <30 s — and a chaos drill MUST verify lag never spikes during failure. Reference: <https://cloud.google.com/alloydb/docs/cross-region-replication-overview>.
- **Firestore Native (regional `nam5`/`eur3`/`asia-northeast3`)**: Memory Bank backing. PITR window is 7 days but cross-region is **export-restore**, not live replication. Drills must show that Memory Bank state can be reconstructed from BigQuery audit logs within 30 s of write, or accept a degraded "fresh memory" mode for that tenant.
- **BigQuery**: not in the hot path; RPO measured per dataset against its multi-region copy.
- **Cloud Storage**: bucket-level multi-region or dual-region (per matrix); replication is asynchronous with usually <15 minute consistency. Assets are not on the RPO 30 s contract; only metadata is.

What must survive: every committed `INSERT`, `UPDATE`, or `agent_action` event written within 30 seconds of an outage must replay or remain readable in the surviving region.

### 1.5 Summary: what every chaos drill must measure

Every scenario in §3 has four observed-value rows: **availability impact (yes/no SLI breach)**, **observed p99 delta**, **observed RTO**, **observed RPO**. A scenario passes only if all four stay inside D31's envelope, except where explicitly noted as "degraded mode acceptable" (e.g. Memory Bank reset on regional failover).

---

## 2. The chaos engineering layer in D37's 5-layer test pyramid

D37 declares chaos engineering as the **5th and outermost layer** of the test pyramid, below Vertex AI Agent Evaluation, Vitest, pytest, and Agent Simulation. The chaos layer's job is **not** to find logic bugs (the four inner layers catch those) but to find **emergent failure** — what happens when a healthy component meets an unhealthy dependency. The principles Google's own SRE practice puts on this discipline are documented at <https://cloud.google.com/blog/products/management-tools/reliability-engineering-using-chaos-engineering-on-google-cloud> and the open-source Litmus framework at <https://litmuschaos.io/>.

Chaos drills run continuously: **fast subset on every PR**, **full suite nightly**, **quarterly game day** with human-in-loop. §5 and §6 spec these. The §3 catalog below is the menu the runner draws from.

---

## 3. Failure mode catalog (24 scenarios across 7 tiers)

Each scenario block contains:

- **Trigger** — exact command, API call, or Litmus manifest to induce the failure.
- **Expected RTO / RPO** — D31 envelope this scenario must respect.
- **Observed SLI breach** — which Cloud Monitoring SLO alert is expected to fire.
- **Auto-runbook (D32)** — does the failure mode have an auto-remediation workflow registered, and which one?
- **Recovery validation** — concrete probe or query to confirm restoration.
- **Pass/fail** — what counts as "test passed" for CI promotion (see §7).

### 3.1 Edge tier

#### CHAOS-EDGE-01 — Global LB backend service unhealthy in one region

The hot-path entry. If a regional backend service goes unhealthy, the Global LB should route 100% of new connections to the surviving regions within seconds. <https://cloud.google.com/load-balancing/docs/health-check-concepts>.

- **Trigger**:
  ```bash
  gcloud compute backend-services update ss-v2-hot-path \
    --health-checks=ss-v2-fail-injection \
    --global
  ```
  The `ss-v2-fail-injection` health check is a pre-built pointer at a 503 endpoint, applied only to `us-central1` NEGs.
- **Expected RTO / RPO**: RTO < 30 s (Global LB convergence is faster than D31 budget); RPO = 0 (stateless edge).
- **Observed SLI breach**: `slo.hot_path.availability` fast-burn alert (regional slice).
- **Auto-runbook**: `runbook-edge-eject-region` — pages SRE, drains region from LB, opens a Cloud Workflows ticket. Should fire within 10 s.
- **Recovery validation**: synthetic probe from `us-central1` returns from `europe-west4` or `asia-northeast3` (header `Via:` shows the substitution); aggregate `slo.hot_path.availability` returns to 100% within 60 s of probe rotation.
- **Pass/fail**: probe success rate ≥ 99.9% over 5 minutes after fault injection; observed RTO ≤ 60 s.

#### CHAOS-EDGE-02 — Cloud Armor rule mass-block (false positive)

A regex tightening pushed to Cloud Armor's adaptive protection causes legitimate traffic to be 403'd. This is a real Google-published failure mode <https://cloud.google.com/armor/docs/security-policy-overview>.

- **Trigger**:
  ```bash
  gcloud compute security-policies rules create 9000 \
    --security-policy=ss-v2-edge \
    --expression='request.path.matches(".*/api/.*")' \
    --action=deny-403 \
    --description='CHAOS-EDGE-02 injection'
  ```
- **Expected RTO / RPO**: RTO < 60 s (rule rollback via Cloud Deploy revision); RPO = 0.
- **Observed SLI breach**: hot-path availability fast-burn + 4xx rate spike on Cloud Logging.
- **Auto-runbook**: `runbook-armor-rollback` — detects 4xx surge > 5% baseline, rolls back the last Cloud Armor policy revision automatically.
- **Recovery validation**: synthetic probe returns 200 across all regions; `severity:WARNING resource.type:http_load_balancer` log query is quiet for 60 s.
- **Pass/fail**: rollback completes inside 60 s.

#### CHAOS-EDGE-03 — Cloud CDN cache poisoning / stale-content event

A stale, miss-cached asset gets pinned at the edge. The lever: `Cache-Control: max-age=86400` on a 500 response. <https://cloud.google.com/cdn/docs/troubleshooting-steps>.

- **Trigger**: deploy a deliberately bad `og:image` asset to Cloud Storage origin with a 24 h max-age header.
- **Expected RTO / RPO**: RTO < 5 minutes (CDN invalidation lag), but the hot path is API-only, so this is a **cold-path** scenario; cold-path RTO budget is 5 minutes.
- **Observed SLI breach**: `slo.cdn.cache_hit_ratio` regression alert.
- **Auto-runbook**: `runbook-cdn-invalidate` — `gcloud compute url-maps invalidate-cdn-cache --path=/og/*`.
- **Recovery validation**: cache-status header on probe = `MISS` then `HIT` with correct content; user-perceived asset correct within 5 minutes.
- **Pass/fail**: invalidation completes; no propagation outside 5 minutes.

#### CHAOS-EDGE-04 — DNS resolution glitch (Cloud DNS)

The platform's `api.socialseeding.app` SOA record is mutated to point at an invalid IP. Reference: <https://cloud.google.com/dns/docs/best-practices>.

- **Trigger**: temporarily edit a recordset in a chaos-only DNS zone that overlays prod via a `dns-policy`:
  ```bash
  gcloud dns record-sets update api.socialseeding.app \
    --rrdatas=192.0.2.1 --ttl=30 --type=A \
    --zone=ss-v2-chaos-zone
  ```
- **Expected RTO / RPO**: RTO < 60 s (TTL pinned to 30 s in prod by policy).
- **Observed SLI breach**: external synthetic probe fails from all regions.
- **Auto-runbook**: `runbook-dns-revert` — Cloud Deploy revision pin on the DNS zone; revert is one `gcloud` call.
- **Recovery validation**: `dig +short api.socialseeding.app @8.8.8.8` returns the LB anycast IP within 60 s.
- **Pass/fail**: external probe restored < 60 s.

### 3.2 Identity tier

#### CHAOS-IDP-01 — Identity Platform tenant outage (single tenant)

A single tenant's auth provider becomes unreachable. Multi-tenant Identity Platform's blast radius is supposed to be **per-tenant**, not global. <https://cloud.google.com/identity-platform/docs/multi-tenancy>.

- **Trigger**: in the chaos tenant `chaos-injection-tenant`, disable all sign-in providers via the Admin SDK. Other tenants should be unaffected.
- **Expected RTO / RPO**: per-tenant; chaos tenant degraded; other tenants RTO = 0.
- **Observed SLI breach**: `slo.auth.success_rate{tenant="chaos-injection-tenant"}` only — global SLO untouched.
- **Auto-runbook**: `runbook-tenant-isolation-verify` — confirms tenants other than the affected one still serve.
- **Recovery validation**: rolling sign-in probes across 5 non-chaos tenants succeed; chaos tenant returns expected 503 with `tenant_unavailable` error.
- **Pass/fail**: zero collateral impact on other tenants; isolation verified within 30 s.

#### CHAOS-IDP-02 — Cloud KMS key rotation glitch (CMEK)

The CMEK key for Spanner's tenant ring is rotated; the prior key version is accidentally disabled before all data has been re-encrypted. <https://cloud.google.com/kms/docs/key-rotation>.

- **Trigger**:
  ```bash
  gcloud kms keys versions disable 5 \
    --location=us-central1 \
    --keyring=ss-v2-spanner \
    --key=tenant-cmek
  ```
- **Expected RTO / RPO**: RTO < 60 s (re-enable key version); RPO = 0 (no data lost, only inaccessible).
- **Observed SLI breach**: Spanner read error rate spike → hot-path availability fast-burn.
- **Auto-runbook**: `runbook-kms-version-restore` — auto-enable the most recent disabled version of any CMEK key.
- **Recovery validation**: Spanner read probe returns the canary row; KMS audit log shows the re-enable.
- **Pass/fail**: re-enable completes inside 60 s; Spanner reads recover.

#### CHAOS-IDP-03 — Workforce IF SAML IdP unreachable (staff lockout)

Staff cannot reach the Workforce Identity Federation IdP. This is non-customer-impacting but a Tier-1 incident for SRE.

- **Trigger**: block egress to the staff IdP via VPC-SC restriction (chaos-only egress policy).
- **Expected RTO / RPO**: degraded staff console access; customer SLI untouched.
- **Observed SLI breach**: `slo.staff.console.success_rate` regression; **no** customer SLO breach.
- **Auto-runbook**: `runbook-staff-bypass-prep` — opens a break-glass workflow for staff fallback to gcloud `--impersonate-service-account` flows.
- **Recovery validation**: VPC-SC restriction removed; Workforce IF probe returns OK.
- **Pass/fail**: customer SLO unaffected; break-glass workflow documented and exercised.

### 3.3 Compute tier

#### CHAOS-COMP-01 — Vertex AI Agent Runtime cold start spike

A traffic burst causes Agent Runtime to scale from 0 to N instances simultaneously. Cold-start latency can spike to several seconds. <https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview>.

- **Trigger**: ramp synthetic load from 10 RPS to 500 RPS in 30 s via Locust against the canary endpoint.
- **Expected RTO / RPO**: RTO = N/A (no outage, but p99 budget at risk); RPO = 0.
- **Observed SLI breach**: `slo.hot_path.latency.p99` exceeds 1 s.
- **Auto-runbook**: `runbook-agent-runtime-prewarm` — increases the **min instances** floor on the runtime endpoint for the next 30 minutes.
- **Recovery validation**: p99 returns below 1 s within 5 minutes (min-instances pre-warm).
- **Pass/fail**: p99 stays under 1.5 s during the burst (degraded but not breach-of-budget), returns to <1 s after pre-warm.

#### CHAOS-COMP-02 — GKE Autopilot node preemption (Agent Sandbox)

A Spot VM hosting the Agent Sandbox (Veo/Imagen workloads) is preempted. <https://cloud.google.com/kubernetes-engine/docs/concepts/spot-vms>.

- **Trigger** (Litmus manifest, see §4.1):
  ```yaml
  apiVersion: litmuschaos.io/v1alpha1
  kind: ChaosEngine
  metadata:
    name: gke-node-preemption
  spec:
    engineState: active
    experiments:
      - name: node-drain
        spec:
          components:
            env:
              - name: TARGET_NODE
                value: gke-autopilot-sandbox-spot-xyz
  ```
- **Expected RTO / RPO**: RTO < 90 s (Autopilot reschedules); RPO = 0 (sandboxes are stateless, work is requeued via Cloud Tasks).
- **Observed SLI breach**: cold-path latency on creative agent jobs.
- **Auto-runbook**: `runbook-sandbox-requeue` — finds Cloud Tasks queue entries with stuck leases and resets them.
- **Recovery validation**: a canary Veo job submitted before the preemption finishes within 5 min.
- **Pass/fail**: requeue completes; no human action.

#### CHAOS-COMP-03 — Cloud Run cold start cascade

A Cloud Run worker pool (Pub/Sub push subscriber) hits min-instances=0 just as a burst arrives. <https://cloud.google.com/run/docs/configuring/min-instances>.

- **Trigger**: set `--min-instances=0` on `ss-v2-worker-outreach`, then publish 500 messages to its Pub/Sub topic in 5 s.
- **Expected RTO / RPO**: cold-path; SLI: queue depth alert.
- **Observed SLI breach**: `pubsub.subscription.num_undelivered_messages` over 1000.
- **Auto-runbook**: `runbook-worker-floor-raise` — Cloud Workflows raises min-instances to 2 for 1 hour.
- **Recovery validation**: queue depth returns to baseline within 5 min.
- **Pass/fail**: no message lost; queue drains.

#### CHAOS-COMP-04 — Agent Runtime endpoint regional failure

The entire Agent Runtime endpoint in `europe-west4` becomes unhealthy. Global LB should route to `us-central1` and `asia-northeast3`.

- **Trigger**: disable the regional endpoint:
  ```bash
  gcloud ai endpoints undeploy-model \
    --region=europe-west4 \
    --endpoint=agent-runtime-prod \
    --deployed-model-id=DEPLOYED_ID
  ```
- **Expected RTO / RPO**: RTO < 60 s (D31 hot-path); RPO = 0.
- **Observed SLI breach**: EU-region SLI shows fail, global aggregate stays inside budget thanks to active-active.
- **Auto-runbook**: `runbook-region-drain` — already triggered by EDGE-01 sibling logic.
- **Recovery validation**: re-deploy; EU SLI recovers within 5 min after re-enable.
- **Pass/fail**: zero customer impact (global aggregate stays > 99.99%) during the EU outage.

### 3.4 Data tier

#### CHAOS-DATA-01 — Spanner regional failover

The headline data-plane test. Spanner multi-region (`nam-eur-asia1`) should provide zero data loss; failover is automatic for some leadership changes, manual for others. <https://cloud.google.com/spanner/docs/instance-configurations#multi-region-configs> and <https://cloud.google.com/spanner/docs/disaster-recovery>.

- **Trigger**:
  ```bash
  # Force leader change in the multi-region instance
  gcloud spanner instances move-leader ss-v2-prod \
    --target-config=nam-eur-asia1 \
    --target-region=europe-west4
  ```
  (For drill-only: use a dedicated chaos Spanner instance, not prod.)
- **Expected RTO / RPO**: RTO < 60 s; RPO = 0 (synchronous replication).
- **Observed SLI breach**: brief Spanner read-write latency spike; hot-path may dip but should self-heal.
- **Auto-runbook**: `runbook-spanner-failover-verify` — confirms leadership change completed, runs the canary CRUD probe, alerts SRE only if probe fails.
- **Recovery validation**:
  ```sql
  -- canary table assertion
  SELECT canary_id, last_write_ts FROM chaos_canary
  WHERE canary_id = @run_id;
  ```
  Result must match the value written 5 seconds before failover (RPO 30 s test).
- **Pass/fail**: zero rows lost; p99 returns inside 1 s within 90 s; observed RTO ≤ 60 s.

#### CHAOS-DATA-02 — AlloyDB AI primary failure with read-replica promotion

An AlloyDB primary in one region fails. Per-region replicas exist; the cross-region async replica must promote. <https://cloud.google.com/alloydb/docs/cross-region-replication-overview>.

- **Trigger**:
  ```bash
  gcloud alloydb clusters failover ss-v2-feature \
    --region=us-central1
  ```
- **Expected RTO / RPO**: RTO < 5 min (cold path); RPO < 30 s (per D31 envelope).
- **Observed SLI breach**: feature-store query latency alert.
- **Auto-runbook**: `runbook-alloydb-promote` — promotes the secondary; updates the AlloyDB connection name in Secret Manager; restarts dependent Cloud Run pools.
- **Recovery validation**: a canary `INSERT` issued 30 s before failover is visible in the promoted primary; replication lag at failover moment was <30 s.
- **Pass/fail**: zero rows lost beyond the RPO budget; promotion completes within 5 min.

#### CHAOS-DATA-03 — Firestore write quota exceeded

A runaway agent hammers Firestore Memory Bank, hitting the `WritesPerSecond` per-database quota. <https://cloud.google.com/firestore/docs/quotas>.

- **Trigger**: a chaos script that issues 1,500 writes/sec to a chaos collection in the chaos Firestore database.
- **Expected RTO / RPO**: degraded; not in hot-path RPO envelope (Memory Bank loss is acceptable per D33 14-day TTL).
- **Observed SLI breach**: 429 rate on Memory Bank writes.
- **Auto-runbook**: `runbook-firestore-quota` — pages SRE, opens a quota-increase ticket, and triggers a per-agent rate-limiter via Memorystore.
- **Recovery validation**: Memory Bank writes return below 1,000/s baseline; no other tenant impacted.
- **Pass/fail**: only the offending tenant is throttled; the global Memory Bank stays writable for others.

#### CHAOS-DATA-04 — BigQuery slot exhaustion

A scheduled `analyst` agent's report consumes 100% of the on-demand slot pool, blocking other tenants' analytics queries. <https://cloud.google.com/bigquery/docs/slots>.

- **Trigger**: submit 50 concurrent CPU-heavy queries against `agent_evals` partitioned table.
- **Expected RTO / RPO**: cold-path degradation only.
- **Observed SLI breach**: `bigquery.query.execution_time.p95` regression.
- **Auto-runbook**: `runbook-bq-reservation` — auto-creates a tenant-isolated reservation for the offending tenant; remaining slots restored for others.
- **Recovery validation**: a baseline query from a non-offending tenant completes within p95 baseline.
- **Pass/fail**: reservation created; no cross-tenant impact.

#### CHAOS-DATA-05 — Spanner stale-read regression (custom injection)

In active-active mode, an agent that reads stale data (e.g. via `read_only_staleness`) might serve a tenant a 5-minute-old view of their campaign. This is a correctness drill rather than an outage drill — it validates the agent's defensive reads.

- **Trigger**: route 10% of read traffic via a chaos middleware that forces `read_only_staleness=300s`. (Custom GCP fault injection, see §4.2.)
- **Expected RTO / RPO**: N/A (no outage); a correctness regression.
- **Observed SLI breach**: agent-eval drop on `data_freshness_v1` metric.
- **Auto-runbook**: none — this is a regression test, escalates to humans.
- **Recovery validation**: middleware disabled; reads return to strong consistency.
- **Pass/fail**: agents detect staleness and fall back to strong reads (validates retry/fallback code path).

### 3.5 Event tier

#### CHAOS-EVT-01 — Pub/Sub message drop

A subscriber acks but doesn't process; the message is silently lost. We simulate a randomly-dropping subscriber to validate that the `at-least-once + idempotency-key` contract holds. <https://cloud.google.com/pubsub/docs/exactly-once-delivery>.

- **Trigger**: in a chaos subscriber, ack 5% of messages without processing them. Run for 10 minutes.
- **Expected RTO / RPO**: zero message loss tolerated (workflow correlation handles re-emission).
- **Observed SLI breach**: workflow correlation timeout alert (signal expected but not received).
- **Auto-runbook**: `runbook-workflow-replay` — re-emits any Pub/Sub message whose correlation is missing after timeout.
- **Recovery validation**: a canary event tagged with `chaos_run_id` is observed processed downstream within 5 min, even if its first delivery was dropped.
- **Pass/fail**: zero canaries lost; replay path exercised at least once.

#### CHAOS-EVT-02 — Cloud Tasks queue stuck (head-of-line block)

A poison message in Cloud Tasks holds up the queue with infinite retries. <https://cloud.google.com/tasks/docs/dual-overview>.

- **Trigger**: enqueue a task with a payload guaranteed to throw — for example a malformed `recipient.email`.
- **Expected RTO / RPO**: cold-path; queue drain stalls.
- **Observed SLI breach**: `cloudtasks.queue.depth` regression on the affected queue.
- **Auto-runbook**: `runbook-tasks-poison-isolate` — moves messages with retry count > 5 to a DLQ topic; resumes queue.
- **Recovery validation**: queue depth returns to baseline; DLQ contains the poisoned task with full trace.
- **Pass/fail**: queue drains within 5 min; no cross-tenant queue impact.

#### CHAOS-EVT-03 — Cloud Workflows execution timeout

A long-running brand-campaign workflow execution exceeds the 1-year hard limit OR the per-step 30-minute step limit (e.g. an `awaitEvent` mis-tuned). <https://cloud.google.com/workflows/quotas>.

- **Trigger**: start a chaos workflow with `awaitEvent(timeout=PT30M)` that intentionally never receives its event.
- **Expected RTO / RPO**: workflow fails fast; cold-path.
- **Observed SLI breach**: `workflows.execution.error_rate` regression on a per-workflow basis.
- **Auto-runbook**: `runbook-workflow-resume-canary` — for time-boxed workflows, re-issues the event from the saved campaign state.
- **Recovery validation**: workflow execution either completes via replay or is gracefully marked failed with operator notification.
- **Pass/fail**: no orphaned workflows; tenant inbox shows the failure surface in Mission Control.

### 3.6 Model tier

#### CHAOS-MODEL-01 — Vertex AI 429 quota exhaustion

The platform hits per-region Gemini 2.5 Pro `requests-per-minute` quota during a vetting fan-out. <https://cloud.google.com/vertex-ai/generative-ai/docs/quotas>.

- **Trigger**: ramp synthetic vetting traffic until 429s appear; or temporarily lower the quota in the chaos project.
- **Expected RTO / RPO**: degraded throughput; no outage.
- **Observed SLI breach**: `vertex.gemini.errors.429` rate alert.
- **Auto-runbook**: `runbook-model-fallback` — switches the affected agent's default model from Pro to Flash for 15 min; queues backed-off requests on Cloud Tasks.
- **Recovery validation**: agent eval scores on Flash stay within tolerance (`eval_score >= 0.85 × pro_baseline`).
- **Pass/fail**: no campaign halted; eval scores within tolerance; auto-recovery from fallback when 429s clear.

#### CHAOS-MODEL-02 — Model Armor false positive

A legitimate outreach message is blocked by the Model Armor `pii_block` policy because a creator's TikTok handle matches a regex. <https://cloud.google.com/security-command-center/docs/model-armor-overview>.

- **Trigger**: send 100 outreach drafts where 50 contain a regex-matching string deliberately.
- **Expected RTO / RPO**: false-positive rate is a correctness metric.
- **Observed SLI breach**: `model_armor.block_rate` exceeds the historical baseline by > 2σ.
- **Auto-runbook**: `runbook-armor-escalate` — routes the blocked content to the `critic` (M2) agent for second-opinion review; if M2 clears, the content is allowed with an audit log entry.
- **Recovery validation**: blocked-but-cleared cases reach Gmail send; blocked-and-confirmed cases stay blocked.
- **Pass/fail**: false-positive rate < 1% after escalation; zero true-positive bypass.

#### CHAOS-MODEL-03 — Gemini 3.1 Preview deprecation mid-run

A workflow opens a long-lived agent session pinned to Gemini 3.1 Preview, which Google deprecates on date X. <https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference>.

- **Trigger**: simulate the deprecation by returning HTTP 410 from a mocked endpoint for `gemini-3.1-pro-preview`.
- **Expected RTO / RPO**: cold-path; sessions must auto-migrate to GA or to a fallback model.
- **Observed SLI breach**: `vertex.gemini.errors.410` rate alert.
- **Auto-runbook**: `runbook-model-migrate` — atomically swaps to `gemini-2.5-pro` for sessions affected; logs the swap.
- **Recovery validation**: session continues; eval scores stay within tolerance.
- **Pass/fail**: no campaign aborted; eval scores within tolerance.

### 3.7 Vendor tier

#### CHAOS-VEND-01 — RapidAPI 5xx storm

The TikTok or Instagram source on RapidAPI returns 5xx for 5 minutes. <https://rapidapi.com/blog/api-glossary/status-codes/>.

- **Trigger**: rotate the chaos environment's `RAPIDAPI_BASE_URL` to a deliberately-failing chaos proxy.
- **Expected RTO / RPO**: cold-path; sourcing degraded.
- **Observed SLI breach**: `rapidapi.errors.5xx` rate alert.
- **Auto-runbook**: `runbook-source-degrade` — sourcing agent switches to cached candidates from Vertex Vector Search; logs the degradation.
- **Recovery validation**: when the proxy recovers, the sourcing agent resumes live calls.
- **Pass/fail**: degraded mode visible in Mission Control; no campaign halted.

#### CHAOS-VEND-02 — Gmail OAuth refresh failure

A tenant's Gmail OAuth refresh token expires or is revoked. <https://developers.google.com/identity/protocols/oauth2#expiration>.

- **Trigger**: invalidate a chaos tenant's stored refresh token via Secret Manager edit.
- **Expected RTO / RPO**: per-tenant degradation; not in hot-path SLO.
- **Observed SLI breach**: `gmail.send.errors.401` rate per tenant.
- **Auto-runbook**: `runbook-oauth-reconnect` — surfaces a re-auth prompt in Mission Control for the affected tenant; pauses outreach sends for that tenant only.
- **Recovery validation**: a test send completes after a re-auth flow in the chaos tenant.
- **Pass/fail**: zero cross-tenant impact; tenant prompted to re-auth, not silently failing.

#### CHAOS-VEND-03 — Stripe (phase-2) webhook drop

Phase-2 only: a Stripe webhook event is dropped or arrives out of order. <https://stripe.com/docs/webhooks/best-practices>.

- **Trigger**: drop 10% of inbound webhook deliveries at the chaos proxy.
- **Expected RTO / RPO**: cold-path; billing reconciliation MUST stay correct.
- **Observed SLI breach**: `billing.reconciliation.discrepancy` non-zero alert.
- **Auto-runbook**: `runbook-stripe-reconcile` — runs a periodic reconciliation that queries Stripe's `/events` endpoint and replays missing events.
- **Recovery validation**: reconciliation discrepancy returns to zero within 1 hour.
- **Pass/fail**: zero permanent revenue loss; reconciliation passes.

---

## 4. Test framework — how the scenarios run

The chaos engine is a thin orchestration layer over four execution substrates. The choice of substrate per scenario is encoded in the scenario manifest under `executor:`.

### 4.1 Litmus on GKE Autopilot (Kubernetes-level chaos)

Litmus is the open-source CNCF chaos framework. It runs as a set of CRDs (`ChaosEngine`, `ChaosExperiment`, `ChaosResult`) inside the GKE Autopilot cluster that already hosts the Agent Sandbox. <https://litmuschaos.io/> and the GKE-specific guide at <https://docs.litmuschaos.io/docs/concepts/agents/>.

What Litmus drives:

- **CHAOS-COMP-02** (node preemption)
- Other future Kubernetes-level pod-kill, network-loss, CPU-stress, memory-stress drills against any GKE-hosted workload (Agent Sandbox primarily)

Litmus runs in a `chaos-system` namespace, gated by an admission webhook so only the chaos service account can create `ChaosEngine` CRDs. Drills are triggered from the chaos workflow harness via `kubectl apply -f <manifest.yaml>` against the GKE Autopilot cluster's control plane.

### 4.2 Native GCP fault injection (managed-service-level chaos)

For everything that isn't GKE-hosted, native GCP levers are used:

- **Cloud Run revision traffic split** — point 50% of traffic at a deliberately-broken revision. See <https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration>.
- **Pub/Sub message backlog injection** — publish high-volume messages to a chaos topic that fans into a slow subscriber.
- **Spanner `move-leader`** — already documented in CHAOS-DATA-01.
- **AlloyDB `clusters failover`** — already in CHAOS-DATA-02.
- **Cloud Armor policy revisions** — induce false-positive blocks (CHAOS-EDGE-02).
- **VPC-SC restrictions** — to simulate "unreachable" dependencies (CHAOS-IDP-03).

These are scripted in `scripts/chaos/native/*.sh` (TBD). Each script must:

1. Validate it is running against a chaos environment, NOT prod (`gcloud config list project` + name regex).
2. Tag every artifact with a `chaos_run_id` label for cleanup.
3. Emit an OTLP span named `chaos.injection.start` and `chaos.injection.stop`.

### 4.3 Custom Spanner stale-read injection

CHAOS-DATA-05 requires injecting a stale-read at the application layer. The mechanism: a sidecar middleware in the capability layer (`packages/capabilities/src/db/spanner-chaos.ts`, TBD) that, when `CHAOS_STALE_READ_PROBABILITY` env var is non-zero, wraps `db.snapshot()` calls with `staleness({ exactStaleness: { seconds: 300 } })`. The wrapper is **never** present in prod builds (verified by a build-time assertion on `process.env.NODE_ENV !== 'production'`).

This pattern generalizes: any custom injection that the GCP control plane can't induce gets a sidecar middleware in the capability layer, gated by env vars, build-time-excluded from prod.

### 4.4 Workflow harness — scenario runner

The runner is `packages/chaos/src/runner.ts` (TBD):

1. Reads the scenario manifest (`scenarios/chaos-*.yaml`).
2. Records pre-state: queries Cloud Monitoring SLOs, captures baseline metrics.
3. Triggers the failure (Litmus / native / custom).
4. Polls Cloud Monitoring during the drill, collecting:
   - SLO burn rate
   - Hot-path p99
   - Per-service availability
   - Auto-runbook execution status (queried via Cloud Workflows API)
5. Triggers cleanup (un-inject the failure).
6. Validates recovery (executes the scenario's `recovery_validation` block).
7. Writes a result row to BigQuery `chaos_results` table, with fields `run_id`, `scenario_id`, `pass/fail`, `observed_rto_s`, `observed_rpo_s`, `slo_budget_consumed_pct`, `auto_runbook_fired`, `auto_runbook_succeeded`, `notes`.
8. Emits a Pub/Sub `chaos.scenario.completed` event so dashboards and the security_watch (W3) agent can react.

Every drill MUST produce a result row; orphaned drills are themselves a CI failure (caught by a `chaos_results` recency query).

---

## 5. CI integration — three cadences

Per D37, chaos engineering is a TDD layer; it runs on every PR (subset), nightly (all), and weekly (game day, see §6).

### 5.1 Per-PR fast subset (≤ 10 scenarios, target ≤ 10 minutes)

Cloud Build trigger on every PR runs the following 10 fast scenarios. Each is bounded at 60 seconds of actual injection time.

| # | Scenario | Why in fast set |
|---|----------|-----------------|
| 1 | CHAOS-EDGE-01 | LB convergence is core to D31 RTO; any regression must block merge. |
| 2 | CHAOS-EDGE-02 | Cloud Armor rollback is a one-command recovery; cheap to drill. |
| 3 | CHAOS-IDP-01 | Tenant isolation is a security boundary; cheap to verify with a chaos tenant. |
| 4 | CHAOS-COMP-01 | Cold-start budget is a frequent regression source. |
| 5 | CHAOS-COMP-03 | Cloud Run cold start cascade — similar reason. |
| 6 | CHAOS-DATA-01 | Spanner failover — the single most important data-plane drill; runs against a chaos Spanner instance. |
| 7 | CHAOS-EVT-01 | Pub/Sub message drop — at-least-once contract is foundational. |
| 8 | CHAOS-EVT-02 | Cloud Tasks poison — DLQ path must always work. |
| 9 | CHAOS-MODEL-01 | Vertex 429 fallback — model-tier failure is the most likely production incident. |
| 10 | CHAOS-VEND-01 | RapidAPI 5xx — the platform's primary external dependency. |

Failure of any one of these blocks the PR. The fast subset runs in parallel across three Cloud Build workers, completing inside 10 minutes. Cost per PR is bounded at ~$0.30 against the D39 $1,500 credit envelope.

### 5.2 Nightly full suite (all 24 scenarios, target ≤ 90 minutes)

A Cloud Scheduler job kicks the runner at 02:00 UTC daily. The full suite runs in 4 parallel waves (one per tier-bucket: edge, identity+compute, data+event, model+vendor) to minimize wall-clock time. Results are written to BigQuery `chaos_results`. A nightly Slack digest summarizes pass/fail by tier.

Persistent failure in the nightly suite (the same scenario fails twice consecutive nights) auto-creates a P2 Jira-equivalent ticket and pages the on-call rotation at the next business day's standup.

### 5.3 Weekly extended (cross-region multi-failure, target ≤ 4 hours)

On Saturday 02:00 UTC, the runner executes **combined-failure** scenarios that the nightly suite can't drill safely:

- CHAOS-EDGE-01 (drop EU region) + CHAOS-DATA-02 (AlloyDB EU failover) simultaneously.
- CHAOS-MODEL-01 (Vertex 429) + CHAOS-VEND-01 (RapidAPI 5xx) simultaneously.
- CHAOS-COMP-04 (regional Agent Runtime) + CHAOS-EVT-01 (Pub/Sub drop) simultaneously.

These drills validate that auto-runbooks compose correctly under multi-failure. They run in a dedicated chaos project (`ss-v2-chaos-weekly`) that mirrors prod's architecture but holds no customer data.

---

## 6. Game day playbook — quarterly human-in-loop chaos

Every quarter, the platform holds a **game day** — a 4-hour scheduled chaos session with the on-call SRE, an exec sponsor, and the chaos lead in a war-room channel. The pattern is borrowed from Google's own SRE game day discipline (<https://sre.google/sre-book/testing-reliability/>) and AWS's well-known FIS game days.

### 6.1 Pre-game day (T-7 days)

- Chaos lead selects 3-5 scenarios from §3 that have **never been combined** before.
- On-call rotation publishes a written runbook hypothesis for each scenario.
- Exec sponsor (CTO or VPE) reviews and approves the scenario set.
- Customer-facing comms team is briefed; status page is configured for a "scheduled maintenance" window labeled "internal reliability exercise".

### 6.2 Game day (T-0)

**Hour 1 — Single-failure drills**
- Each scenario is injected into the chaos project (NOT prod) with the on-call rotation discovering it via the same alerts as a real incident.
- Time-to-detect (TTD), time-to-page (TTP), time-to-mitigate (TTM), and time-to-resolve (TTR) are measured live.
- Auto-runbook firing is recorded; SRE may NOT intervene unless the auto-runbook fails.

**Hour 2 — Compound-failure drills**
- Two scenarios injected simultaneously (e.g. EDGE-01 + DATA-02).
- The on-call rotation prioritizes; the runner records decision points and outcomes.

**Hour 3 — Adversarial drill (red-team chaos)**
- The chaos lead introduces a failure NOT on the published scenario list — typically a permutation of a recent real-world Google Cloud incident (e.g. a regional `*.googleapis.com` resolution delay).
- The on-call rotation responds blind.

**Hour 4 — Hot wash + scoreboard**
- All participants debrief.
- Three written outputs:
  1. **Updated `chaos/SCENARIOS.md`** with new scenarios derived from this game day.
  2. **Updated `claudedocs/runbook-*.md`** with corrections to any runbook that didn't fire correctly.
  3. **Updated D32 auto-runbook coverage** — any scenario that needed >60s manual intervention is filed as a candidate for new auto-runbook automation.

### 6.3 Post-game day (T+7 days)

- Chaos lead publishes a "Game day {YYYY-Q#}" memo to `claudedocs/`.
- New scenarios discovered are added to §3 of this file with a fresh CHAOS-ID.
- Runbook gaps are filed as Tier-2 outstanding questions in DECISIONS.md §6 if they require an architectural decision.

---

## 7. Pass/fail gates — what blocks Cloud Deploy promotion (D37)

Per D37, Cloud Deploy promotion from canary to 100% is gated by chaos test results. The gating logic is encoded in a Cloud Deploy custom verification step.

### 7.1 Per-PR gate (blocks merge)

A PR cannot merge to `main` if:

1. Any scenario in §5.1 (fast subset) **fails** in the PR's Cloud Build run.
2. The PR introduces a regression in observed RTO or RPO **versus the 7-day rolling baseline** for any fast-subset scenario:
   - `observed_rto_s` is more than 20% worse than baseline, OR
   - `observed_rpo_s` exceeds D31's hard limit (30 s), OR
   - `slo_budget_consumed_pct` is more than 2× baseline.
3. Any auto-runbook that was expected to fire (per the scenario's `auto_runbook` field) **fails to fire** or **fires but does not succeed**.

Gate logic implemented as a BigQuery-backed check in Cloud Build:

```sql
SELECT scenario_id, observed_rto_s, baseline_rto_s
FROM `ss-v2.chaos_results.fast_subset_runs`
WHERE pr_id = @pr_id
  AND (pass = FALSE OR observed_rto_s > baseline_rto_s * 1.2)
```

If the query returns any row, the Cloud Build step exits non-zero and the merge is blocked.

### 7.2 Per-deploy gate (blocks Cloud Deploy promotion 10% → 100%)

Cloud Deploy's canary phase routes 10% of traffic to the new revision for 5 minutes. During this window, **two chaos checks run automatically**:

1. **CHAOS-COMP-01** (cold start) — validates that the new revision's cold start does not regress p99 beyond 1.5 s.
2. **CHAOS-MODEL-01** (Vertex 429 fallback) — validates that the new revision honors the model fallback path.

If either check fails, Cloud Deploy auto-rolls back per the canary policy in `clouddeploy.yaml` (TBD). The promotion to 100% is gated by:

```yaml
# clouddeploy.yaml fragment (illustrative)
strategy:
  canary:
    canaryDeployment:
      percentages: [10, 50, 100]
      verify: true
verify:
  actions:
    - id: chaos-canary-validation
      timeout: 300s
      containerImage: us-docker.pkg.dev/ss-v2/chaos/canary-verify:latest
```

### 7.3 Nightly gate (blocks "fleet-wide" release tag)

A "fleet-wide" release tag (`v*.*.*`-prefixed) is only created if the **last 3 consecutive nightly chaos runs** have:

- No `tier=hot-path` scenario failures (CHAOS-EDGE-01, CHAOS-IDP-01, CHAOS-COMP-04, CHAOS-DATA-01).
- D31 envelope respected for all 24 scenarios.
- Auto-runbook fire rate at the expected 100% for scenarios that declare an auto-runbook.

The fleet-wide release tag is what gates a **multi-region Cloud Deploy rollout** (as opposed to a single-region canary). The check is implemented as a Cloud Workflows job that queries BigQuery `chaos_results` and refuses to push the tag otherwise.

### 7.4 Pass/fail summary

| Gate | Frequency | Blocks | Failure condition |
|---|---|---|---|
| Per-PR fast subset | Every PR | Merge to `main` | Any of 10 fast scenarios fails OR ≥20% RTO regression OR auto-runbook fails |
| Per-deploy canary | Every Cloud Deploy | Promote 10% → 100% | Cold-start regression OR model-fallback regression during canary window |
| Nightly full suite | Every night | None (alerts only); 3-night failure blocks next fleet-wide tag | Persistent regression in any of 24 scenarios |
| Weekly extended | Every Saturday | Quarterly game day prep | Compound-failure regression |
| Quarterly game day | Every quarter | New scenarios added to catalog | Auto-runbook gap discovered |

### 7.5 Escape hatch

The chaos lead, on-call SRE, and CTO together can issue a **chaos-bypass token** for a specific PR or deploy. The token is logged in Chronicle SecOps and audited weekly. Bypass is allowed only when:

- The failing scenario is unrelated to the change (e.g. flaky external vendor on the day of the PR).
- A retry of the chaos run produces a green result.
- A follow-up issue is filed to investigate the original failure.

Bypass tokens auto-expire after 24 hours and never grant access to the per-deploy or fleet-wide gates — only the per-PR gate.

---

## 8. Where this file feeds the rest of the platform

This document is cited by, and feeds into:

- **`DECISIONS.md` D31, D32, D37** — restates and operationalizes them.
- **`tests/MATRIX.md`** (Task #26, pending) — the chaos layer's row references the scenarios here.
- **`simulation/SCENARIOS.md`** (Task #27 derivative, pending) — Agent Simulation scenarios reuse chaos failure modes to validate agent behavior under failure.
- **`claudedocs/runbook-*.md`** (per runbook, pending) — each auto-runbook from §3 needs a full markdown spec.
- **D37 evidence package** — submission/DEVPOST.md will cite this catalog and the BigQuery `chaos_results` table as proof of the chaos engineering layer.

When code lands in `packages/chaos/`, the scenario manifests in `scenarios/chaos-*.yaml` must cross-reference a CHAOS-ID above. Any new scenario added in code must first be appended to §3 here with the M3 PM agent's approval.

---

## 9. Open follow-ups (not yet decided)

| ID | Item | Owner | Trigger |
|---|---|---|---|
| C1 | Chaos environment provisioning script (Terraform module for the chaos project mirror) | devops-architect | Before first nightly run |
| C2 | Litmus admission webhook configuration | devops-architect | Before CHAOS-COMP-02 ships |
| C3 | `clouddeploy.yaml` verify action container image build | devops-architect | Before per-deploy gate is wired |
| C4 | BigQuery `chaos_results` schema + retention policy (90 d, aligns with D33 audit retention) | data-engineer | Before per-PR gate is wired |
| C5 | Auto-runbook spec files (`claudedocs/runbook-*.md`) for each scenario | sre + devops-architect | Before per-PR gate is wired |
| C6 | Game-day-Q1 date + scenarios | chaos lead + CTO | First quarter post-launch |

---

## 10. References

Cited Google Cloud and CNCF documentation:

- <https://sre.google/workbook/error-budget-policy/> — error budget discipline.
- <https://cloud.google.com/stackdriver/docs/solutions/slo-monitoring/alerting-on-burn-rate> — fast-burn alerting on SLOs.
- <https://cloud.google.com/blog/products/management-tools/reliability-engineering-using-chaos-engineering-on-google-cloud> — chaos engineering on GCP.
- <https://litmuschaos.io/> — Litmus open-source chaos framework (CNCF).
- <https://cloud.google.com/load-balancing/docs/health-check-concepts> — Global LB health checks.
- <https://cloud.google.com/armor/docs/security-policy-overview> — Cloud Armor policies.
- <https://cloud.google.com/cdn/docs/troubleshooting-steps> — Cloud CDN troubleshooting.
- <https://cloud.google.com/dns/docs/best-practices> — Cloud DNS best practices.
- <https://cloud.google.com/identity-platform/docs/multi-tenancy> — Identity Platform multi-tenancy.
- <https://cloud.google.com/kms/docs/key-rotation> — Cloud KMS key rotation.
- <https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview> — Vertex AI Agent Runtime overview.
- <https://cloud.google.com/kubernetes-engine/docs/concepts/spot-vms> — GKE Spot VMs.
- <https://cloud.google.com/run/docs/configuring/min-instances> — Cloud Run min instances.
- <https://cloud.google.com/spanner/docs/instance-configurations#multi-region-configs> — Spanner multi-region.
- <https://cloud.google.com/spanner/docs/disaster-recovery> — Spanner DR.
- <https://cloud.google.com/alloydb/docs/cross-region-replication-overview> — AlloyDB cross-region replication.
- <https://cloud.google.com/firestore/docs/quotas> — Firestore quotas.
- <https://cloud.google.com/bigquery/docs/slots> — BigQuery slots.
- <https://cloud.google.com/pubsub/docs/exactly-once-delivery> — Pub/Sub delivery semantics.
- <https://cloud.google.com/tasks/docs/dual-overview> — Cloud Tasks overview.
- <https://cloud.google.com/workflows/quotas> — Cloud Workflows quotas.
- <https://cloud.google.com/vertex-ai/generative-ai/docs/quotas> — Vertex AI Generative AI quotas.
- <https://cloud.google.com/security-command-center/docs/model-armor-overview> — Model Armor overview.
- <https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference> — Gemini model references and deprecation.
- <https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration> — Cloud Run traffic split.
- <https://developers.google.com/identity/protocols/oauth2#expiration> — Google OAuth 2.0 token expiration.
- <https://stripe.com/docs/webhooks/best-practices> — Stripe webhook best practices.
- <https://sre.google/sre-book/testing-reliability/> — Google SRE book testing chapter.
- <https://rapidapi.com/blog/api-glossary/status-codes/> — RapidAPI status codes.

End of `chaos/SCENARIOS.md`.
