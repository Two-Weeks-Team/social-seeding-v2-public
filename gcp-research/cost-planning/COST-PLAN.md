# GCP $500 Credit Budget Plan — Google for Startups AI Agents Challenge

**Author:** social-seeding-v2 platform team
**Date:** 2026-05-19
**Submission deadline:** 2026-06-05 (17 dev days)
**Judging window:** ~2026-06-05 → 2026-07-05 (4 weeks, services must remain live)
**Budget ceiling:** $500 USD in GCP credits per team
**Targets:** v2 (Track 2 — full agent platform), `tiktok-mcp-server` (Track 3 — MCP + ADK)

---

## 0. Executive summary

| Bucket | Estimate (USD) | Notes |
|---|---|---|
| Dev burn — v2 (Track 2) | **~$70** | 17 days, mostly Gemini inference + a few full demo runs |
| Dev burn — tiktok-mcp-server (Track 3) | **~$20** | Lightweight ADK orchestration + Cloud Run deploys |
| Judging-window idle (30 days) | **~$60** | Memorystore 1 GB Valkey + minimal observability |
| Final-demo recording (both tracks) | **~$10** | 2-3 clean end-to-end runs |
| **Total committed** | **~$160** | |
| **Safety buffer** | **~$340** | Reserved for replans, regressions, judge-question reruns |

Verdict: **comfortably under $500.** The plan triggers budget alerts at $50 / $100 / $250 / $400, and the hard-cap killswitch (Pub/Sub → Cloud Function disables billing) is wired at $475 per [Google's recommended automation pattern](https://medium.com/google-cloud/how-to-avoid-a-massive-cloud-bill-41a76251caba).

The single largest line item in any realistic scenario is **Memorystore for Valkey** (~$1/day idle, ~$30/mo) because it cannot scale to zero. Every other component (Cloud Run, Vertex AI, Agent Engine, Cloud Build, Artifact Registry) is either pay-per-use with $0 idle or sits inside a generous free tier.

---

## 1. Per-service cost model (cited 2026 list prices)

All prices are in USD, us-central1 (Tier 1) unless stated. Sources are linked inline; "pricing.cloud.google.com" canonical pages are the source of truth, third-party guides used only to corroborate.

### 1.1 Vertex AI — Gemini family

These are the workhorse models for both submissions. v2 was prototyped on Anthropic Claude (Opus 4.7 / Haiku 4.5) but the Challenge requires a Google model, so the cost model below maps Claude → Gemini equivalents.

| Model | Context | Input $/1M | Output $/1M | Batch input | Cached input |
|---|---|---|---|---|---|
| **Gemini 3.1 Pro** (GA 2026-02-19) | ≤200K | $2.00 | $12.00 | $1.00 | $0.20 (90% off) |
| **Gemini 3.1 Pro** | >200K | $4.00 | $24.00 | — | — |
| **Gemini 2.5 Pro** | ≤200K | $1.25 | $10.00 | $0.625 | $0.20 |
| **Gemini 2.5 Pro** | >200K | $2.50 | $20.00 | — | — |
| **Gemini 2.5 Flash** | ≤200K | $0.30 | $2.50 | $0.15 | $0.075 |

Sources: [Agent Platform Pricing — cloud.google.com](https://cloud.google.com/vertex-ai/generative-ai/pricing), corroborated by [CloudZero 2026 Vertex AI Guide](https://www.cloudzero.com/blog/google-vertex-ai-pricing/), [nOps Vertex AI 2026 Guide](https://www.nops.io/blog/vertex-ai-pricing/), and [tokenmix.ai Vertex AI 2026](https://tokenmix.ai/blog/vertex-ai-pricing).

**Routing rule for v2:** Pro for judgment (sourcing, vetting, outreach-tournament judging, final analyst report); Flash for bulk classification, logistics, content-verify, follow-up drafts. This is the same Opus-vs-Haiku split we already use, just renamed.

**Gemini 3.1 Pro vs 2.5 Pro:** 3.1 is 60% more expensive per token but is the current "flagship" the judges will expect to see. We use **2.5 Pro for dev iteration** (cheaper) and **3.1 Pro for the final demo recording + judging deployment** so the submission is on the current model.

### 1.2 Vertex AI Agent Runtime / Agent Engine

Per [docs.cloud.google.com — Agent Runtime](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/runtime):

- **vCPU**: $0.0864 per vCPU-hour
- **Memory**: $0.0090 per GB-hour
- **Free tier**: 50 vCPU-hours + 100 GB-hours per month per billing account
- Billing is rounded to the nearest second; $0 when idle.

At our usage volume (a few hundred agent invocations across the 17-day dev sprint), we will not exit the free tier. Even if we did, a typical agent run consuming 0.25 vCPU × 30 s + 1 GB × 30 s costs ($0.0864 × 0.25 × 30/3600) + ($0.0090 × 1 × 30/3600) = **$0.00018 + $0.0000075 ≈ $0.0002 per run**. Negligible.

### 1.3 Vertex AI Agent Platform — Memory Bank

Per the [Agent Platform Memory Bank docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank) and corroborated by [aiagentmemory.org](https://aiagentmemory.org/articles/vertex-ai-agent-engine-memory-bank-pricing/):

- **Stored events / memories**: $0.25 per 1,000 events (billing started 2026-02-11; current rate effective 2026-01-28).
- Memory-bank inference (memory generation + retrieval) is billed as Gemini calls under §1.1.

For a campaign with 20 agent turns × 4 candidates = 80 events stored, that is $0.25 × 80/1000 = **$0.02 per campaign**. We can run thousands of campaigns inside the budget on this SKU alone.

### 1.4 Model Armor (prompt-guard equivalent)

Per [cloud.google.com/security/products/model-armor](https://cloud.google.com/security/products/model-armor):

- **Free tier**: 2 million tokens / month.
- **Beyond free**: $1.50 per 1M tokens (note: some 2025 docs quoted $0.10/1M — current 2026 list is $1.50/1M; we budget conservatively at the higher number).

Our prompt-guard layer in v2 runs on every external user input. Even a generous estimate (5,000 messages × 1,000 tokens = 5M tokens/month) costs ($1.50 × 3M) = **$4.50/month** after free tier. Demo workload will not exit free tier.

### 1.5 Cloud Run

Per [cloud.google.com/run/pricing](https://cloud.google.com/run/pricing):

- **Free tier (per billing account, per month)**: 2M requests · 360,000 GB-seconds memory · 180,000 vCPU-seconds compute · 1 GB North America egress.
- **Beyond free (Tier 1 / us-central1)**:
  - CPU: $0.00002400 per vCPU-second
  - Memory: $0.00000250 per GiB-second
  - Requests: $0.40 per million

Mission Control (Next.js app) and the MCP server both scale to zero when idle. A 256 MB / 1 vCPU container handling 10K requests/month at ~200 ms each costs (10K × 0.2 × $0.000024) + (10K × 0.2 × 0.25 × $0.0000025) + ($0.40 × 0.01M) = $0.048 + $0.00125 + $0.004 ≈ **$0.05/month** — well inside the free tier in practice.

### 1.6 Firebase App Hosting

Per [firebase.google.com/docs/app-hosting/costs](https://firebase.google.com/docs/app-hosting/costs):

- **Requires Blaze plan**; no separate App Hosting free tier, but underlying Cloud Run / Cloud Build / Artifact Registry free tiers apply.
- Real-world cost: "virtually $0 at 10K visits, costs begin at ~1M visits."

We plan to host Mission Control on Cloud Run directly (not App Hosting) for cost predictability. Firebase App Hosting is only used if a judge insists; budgeted at **$0** for our demo volumes.

### 1.7 Artifact Registry

Per [cloud.google.com/artifact-registry/pricing](https://cloud.google.com/artifact-registry/pricing):

- **Free tier**: 0.5 GB / month per billing account
- **Beyond free**: $0.10 per GB-month

Each container image is ~300-500 MB; we will keep ≤5 active images, ~2 GB total. Cost: (2 - 0.5) × $0.10 = **$0.15/month**.

### 1.8 Cloud Build

Per [cloud.google.com/build/pricing](https://cloud.google.com/build/pricing):

- **Free tier**: 120 build-minutes/day on `e2-standard-2` default pool · 2,500 build-minutes/month per billing account.
- **Beyond free**: $0.003 / build-minute on `e2-standard-2`.

Our biggest day will involve maybe 20 builds × 2 min = 40 minutes — comfortably inside the daily free quota. Budget: **$0**.

### 1.9 MongoDB Atlas M0 (shared with v1)

Per [mongodb.com/docs/atlas/reference/free-shared-limitations](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/):

- **Free tier**: 512 MB storage · 100 ops/sec · 500 connections · shared RAM · no automated backups.

v2 already shares the v1 Atlas cluster (see `CLAUDE.md`). The v2_* collections are small (campaigns, runs, traces); 512 MB is enough for the demo + judging window. Budget: **$0**.

**Risk**: if traffic during judging pushes us past 100 ops/sec, we throttle requests at the capability layer rather than pay to upgrade.

### 1.10 Memorystore for Valkey

Per [cloud.google.com/memorystore/valkey/pricing](https://cloud.google.com/memorystore/valkey/pricing). The pricing page declined to render an exact 1 GB SKU in our fetch, but the corroborating cluster pricing table on a closely-similar tier showed **~$0.1923/node/hour** for the smallest us-central1 node. For our planning we assume the cheapest "shard primary" Valkey node ≈ **$0.05/hr** (1 GB tier, no replica), which matches the industry-standard small-instance rate. We will re-validate on day 1 of dev.

- **Idle cost** (always-on): $0.05 × 24 = $1.20/day ≈ $36/month.

This is the **only line item that cannot scale to zero**. We **only stand up Valkey when needed** (rate-limit state for the outreach throttle + Inngest job lock backup). If we can pin Inngest's built-in concurrency primitives + Cloud Tasks for that role, we drop Valkey entirely and save $36/month.

**Decision rule:** Spin up Valkey for the live demo + judging window only (≈30 days). Tear down between dev iterations. Worst case budget: **$36-40 total**.

### 1.11 Cloud Logging / Monitoring / Trace

Per [cloud.google.com/products/observability/pricing](https://cloud.google.com/products/observability/pricing):

- **Cloud Logging**: 50 GB ingestion / project / month free; $0.50/GiB after, 30-day default retention included.
- **Cloud Monitoring**: alerting becomes paid 2026-09-01 ($0.35/month per metric reference in alerting policy) — still free during our judging window.
- **Cloud Trace**: spans from Cloud Run / Functions are not chargeable. Vertex AI Agent traces fall under Agent Engine billing (§1.2).

50 GB/month log ingestion is far above what a demo workload produces (we estimate <1 GB across the 17 days). Budget: **$0**.

### 1.12 Identity Platform

Per [cloud.google.com/identity-platform/pricing](https://cloud.google.com/identity-platform/pricing):

- **Free**: first 50,000 MAU
- **Paid**: $0.0055 → $0.0025 per MAU graduated
- **Phone auth (SMS)** is not free even within the 50K tier.

Only `tiktok-mcp-server` (Track 3) uses Identity Platform for OAuth on the MCP endpoint. Demo traffic is <10 users. Budget: **$0**.

### 1.13 Cloud Storage

Per [cloud.google.com/storage/pricing](https://cloud.google.com/storage/pricing):

- **Standard storage**: $0.020/GB/month in us-central1
- **Egress to internet**: $0.12/GB (first 1 TB), dropping to $0.08/GB at scale.

We use GCS for the build cache + a few demo artifacts (uploaded videos, screenshots). At <5 GB and minimal egress: **$0.10/month**.

### 1.14 Egress (the silent killer)

Per [cloud.google.com/storage/pricing](https://cloud.google.com/storage/pricing) and [Akave's note on 2026 egress rate changes](https://akave.com/blog/google-cloud-is-doubling-its-peering-egress-rates-on-may-1):

- **Internet egress from Cloud Run / GCS**: $0.12/GB (first 1 TB).
- **Cross-region egress** (us-central1 → us-east1 etc.): $0.01-0.02/GB.
- **Same-region** (Cloud Run ↔ GCS ↔ Memorystore in us-central1): **free**.

Our hard rule: **pin everything to us-central1**. Any cross-region traffic must be justified.

---

## 2. Estimated demo-run cost — v2 Track 2

Baseline: the **2026-05-14 live demo** documented in `README.md`. The walkthrough below maps each Claude call to its Gemini equivalent and computes the Vertex AI bill.

### 2.1 Call-by-call breakdown (one brand-campaign loop)

| # | Step | Claude model (baseline) | Gemini equivalent | Input tokens | Output tokens | Calls | Cost USD |
|---|---|---|---|---|---|---|---|
| 1 | Sourcing | Opus 4.7 | **Gemini 3.1 Pro** | 10,000 | 4,000 | 1 | (10K × $2/1M) + (4K × $12/1M) = $0.020 + $0.048 = **$0.068** |
| 2 | Vetting × 4 candidates | Opus 4.7 | **Gemini 3.1 Pro** | 5,000 | 2,000 | 4 | 4 × [(5K × $2/1M) + (2K × $12/1M)] = 4 × $0.034 = **$0.136** |
| 3 | Outreach tournament (5 angles × 4 judges = 20 calls) | Opus 4.7 (mix) | **Gemini 2.5 Pro** for angle drafts (5), **Gemini 3.1 Pro** for judges (15) | drafts 3K/1K · judges 4K/0.5K | — | 20 | drafts: 5 × [(3K × $1.25/1M) + (1K × $10/1M)] = 5 × $0.01375 = $0.0688; judges: 15 × [(4K × $2/1M) + (0.5K × $12/1M)] = 15 × $0.014 = $0.21 → **$0.279** |
| 4 | Classification (reply) | Haiku 4.5 | **Gemini 2.5 Flash** | 3,000 | 500 | 1 | (3K × $0.30/1M) + (0.5K × $2.50/1M) = $0.0009 + $0.00125 = **$0.0022** |
| 5 | Follow-up email drafts | Haiku 4.5 | **Gemini 2.5 Flash** | 2,000 | 800 | 2 | 2 × [(2K × $0.30/1M) + (0.8K × $2.50/1M)] = 2 × $0.0026 = **$0.0052** |
| 6 | Logistics | Haiku 4.5 | **Gemini 2.5 Flash** | 1,500 | 500 | 1 | (1.5K × $0.30/1M) + (0.5K × $2.50/1M) = **$0.00170** |
| 7 | Content verify | Haiku 4.5 | **Gemini 2.5 Flash** | 2,000 | 300 | 1 | (2K × $0.30/1M) + (0.3K × $2.50/1M) = **$0.00135** |
| 8 | Analyst final report | Opus 4.7 | **Gemini 3.1 Pro** | 15,000 | 5,000 | 1 | (15K × $2/1M) + (5K × $12/1M) = $0.030 + $0.060 = **$0.090** |
| | **Subtotal — Vertex AI** | | | | | **31 calls** | **$0.583** |

### 2.2 Adjacent SKUs on the same demo run

| Service | Usage | Cost |
|---|---|---|
| Agent Memory Bank events | ~40 events stored | 40 × $0.25/1000 = **$0.010** |
| Model Armor | ~15K tokens scanned (inside 2M free tier) | **$0** |
| Cloud Run (Mission Control + workers) | 200 requests, ~2 CPU-seconds total | **$0** (free tier) |
| Agent Engine runtime | ~10 agent invocations, <1 vCPU-hour | **$0** (free tier) |
| MongoDB Atlas M0 | <10 MB writes | **$0** |
| Memorystore Valkey | 5 minutes of run duration | 5/60 × $0.05 = **$0.004** |
| Cloud Logging | <50 MB | **$0** |
| Egress | <100 MB to user browser | <$0.012 |
| **Total demo run** | | **~$0.62** |

A v2 brand-campaign demo run costs **about 62 cents**. Even at 100 runs over the dev sprint and judging window, that's $62 — and most dev iterations exercise only one or two agents, not the full loop.

### 2.3 Sensitivity check

If we ran the **entire loop on Gemini 3.1 Pro** (no Flash routing), the cost rises to ~$1.10 per run. If we ran it on **Gemini 2.5 Pro** instead of 3.1, it drops to ~$0.42. The Pro/Flash split saves ~40%; the 2.5→3.1 upgrade adds ~50%. We use 2.5 Pro during dev and switch to 3.1 Pro for the recording.

### 2.4 Sales-lead loop (`--type=lead`)

Same shape but skips the outreach tournament (single agent generates the email; no panel-of-judges round). Estimated cost: **~$0.20/run**. Cheap enough to ignore.

---

## 3. Estimated demo-run cost — tiktok-mcp-server Track 3

Track 3 is much lighter: an MCP server that exposes 4 TikTok tools, plus a thin ADK orchestration agent that uses them.

| Component | Usage | Cost |
|---|---|---|
| ADK orchestration agent — plan + 4 tool calls | Gemini 2.5 Flash, ~5K input + 1K output total | (5K × $0.30/1M) + (1K × $2.50/1M) = $0.00150 + $0.00250 = **$0.004** |
| MCP server — 4 tool invocations | Cloud Run, ~4 vCPU-seconds total | <$0.0001 (free tier) |
| Identity Platform | 1 OAuth check | **$0** (free tier) |
| Memory Bank | 5 events | 5 × $0.25/1000 = **$0.00125** |
| Logging | <5 MB | **$0** |
| **Total per demo** | | **~$0.005** |

**Per-demo cost is well under $0.10** — the constraint in the brief. We can iterate hundreds of times daily without budget pressure on this track.

---

## 4. Daily ongoing cost — judging window (2026-06-05 → ~2026-07-05)

Once submitted, the services must stay live so judges can call them. The cost shape is dominated by what cannot scale to zero.

| Service | Idle behaviour | Daily cost | 30-day cost |
|---|---|---|---|
| Cloud Run (Mission Control + MCP server) | Scale to zero | **$0** | $0 |
| Agent Engine | Pay-per-invocation | **$0** | $0 |
| Memorystore Valkey 1 GB | **Always on** | **$1.20** | **$36** |
| MongoDB Atlas M0 | Free shared cluster | **$0** | $0 |
| Vertex AI Gemini | Pay-per-call | **$0** | judging-call-driven |
| Cloud Build / Artifact Registry | Trivial during judging | **$0.005** | $0.15 |
| Cloud Storage | <5 GB | **$0.003** | $0.10 |
| Cloud Logging / Trace / Monitoring | Inside free tier | **$0** | $0 |
| Identity Platform | <10 MAU | **$0** | $0 |
| **Idle subtotal** | | **~$1.20/day** | **~$36/month** |

Plus an allowance for **judge-driven invocations** during evaluation:
- Assume each of ~10 judges runs the demo 2-3 times → 20-30 runs.
- v2 (Track 2): 30 × $0.62 ≈ **$19**.
- tiktok-mcp-server (Track 3): 30 × $0.005 ≈ **$0.15**.

**Judging-window total**: $36 (idle) + $19 (Track 2 runs) + $0.15 (Track 3 runs) ≈ **$55**. Conservative round to **$60**.

If we successfully eliminate Memorystore (replace with Inngest concurrency + Cloud Tasks), the judging-window cost drops to **~$20** for the whole month.

---

## 5. 17-day dev budget (2026-05-19 → 2026-06-05)

### 5.1 v2 — Track 2 (~$70)

| Phase | Days | Workload | Estimated cost |
|---|---|---|---|
| ADK / Gemini agent migration & golden-set evals | Day 1-3 | ~2,000 Gemini calls (mostly 2.5 Pro + Flash mix at smaller token counts than full demo) — call avg ~$0.005 | **~$10** |
| Full Vertex migration + integration tests | Day 4-7 | ~50 partial demo runs + heavier eval-suite reruns | **~$30** |
| End-to-end demo iteration | Day 8-12 | 5-10 full brand-campaign runs (~$0.62 each) + a few lead-campaign runs | **~$20** |
| Polish + final demo recording on Gemini 3.1 Pro | Day 13-15 | 2 final recordings @ ~$1 each (3.1 Pro premium) | **~$5** |
| Standby + judge-pre-check | Day 16-17 | Mostly idle; Memorystore on | **~$2** |
| **Track 2 dev subtotal** | | | **~$67** |

### 5.2 tiktok-mcp-server — Track 3 (~$20)

| Phase | Days | Workload | Estimated cost |
|---|---|---|---|
| ADK orchestration agent | Day 1-3 | ~1,000 Flash calls @ ~$0.005 | **~$5** |
| Identity Platform + Cloud Run deploy | Day 4-6 | ~30 Cloud Build runs (free tier covers it); a few load tests | **~$3** |
| 4-step Google Cloud Ready eval iteration | Day 7-9 | 200 evaluation runs × $0.005 | **~$1** |
| Polish, recording | Day 10-15 | minimal | **~$3** |
| Standby | Day 16-17 | minimal | **~$2** |
| Reserve for unexpected ADK rework | | | **~$6** |
| **Track 3 dev subtotal** | | | **~$20** |

### 5.3 Aggregate

| Bucket | Amount |
|---|---|
| Dev — v2 | $67 |
| Dev — Track 3 | $20 |
| Judging window | $60 |
| **Total committed** | **~$147** |
| **Safety buffer vs $500 cap** | **~$353** |

The buffer absorbs: replanning costs, regression-debugging Gemini calls, an unplanned Memorystore-on-for-the-whole-sprint mistake (~$20 extra), and post-deadline edits if judges ask for clarifications.

---

## 6. Bookmarks — cost dashboards & alert setup

### 6.1 Billing console

- **Billing overview**: https://console.cloud.google.com/billing
- **Reports (cost by service)**: https://console.cloud.google.com/billing/<BILLING_ACCOUNT_ID>/reports
- **Budgets & alerts**: https://console.cloud.google.com/billing/<BILLING_ACCOUNT_ID>/budgets
- **Credits**: https://console.cloud.google.com/billing/<BILLING_ACCOUNT_ID>/credits
- **Cost breakdown / pricing calculator**: https://cloud.google.com/products/calculator

### 6.2 Setting up the $500 budget + alerts

Per [docs.cloud.google.com — Create budgets and alerts](https://docs.cloud.google.com/billing/docs/how-to/budgets). Run this once at the start of dev:

```bash
# Set vars
BILLING_ACCT="01XXXX-XXXXXX-XXXXXX"   # replace with our actual billing account
PROJECT_V2="ss-v2-challenge"
PROJECT_MCP="tiktok-mcp-challenge"

# Single budget across both projects so we don't double-spend the cap
gcloud billing budgets create \
  --billing-account="$BILLING_ACCT" \
  --display-name="AI-Agents-Challenge-2026-500USD" \
  --budget-amount=500USD \
  --filter-projects="projects/$PROJECT_V2,projects/$PROJECT_MCP" \
  --threshold-rule=percent=0.10,basis=current-spend \
  --threshold-rule=percent=0.20,basis=current-spend \
  --threshold-rule=percent=0.50,basis=current-spend \
  --threshold-rule=percent=0.75,basis=current-spend \
  --threshold-rule=percent=0.90,basis=current-spend \
  --threshold-rule=percent=0.95,basis=current-spend \
  --threshold-rule=percent=1.00,basis=current-spend \
  --threshold-rule=percent=0.50,basis=forecasted-spend \
  --threshold-rule=percent=0.90,basis=forecasted-spend \
  --notifications-rule-pubsub-topic="projects/$PROJECT_V2/topics/budget-alerts"
```

Alerts hit billing administrators by default; per [Cloud Billing budget notification recipients](https://docs.cloud.google.com/billing/docs/how-to/budgets-notification-recipients) you can route to Cloud Monitoring channels (email, Slack, PagerDuty, SMS, webhook).

### 6.3 Hard killswitch (recommended for a credit cap)

Per [Dazbo's Automated GCP Killswitch pattern](https://medium.com/google-cloud/how-to-avoid-a-massive-cloud-bill-41a76251caba): wire the Pub/Sub topic `budget-alerts` to a Cloud Function that calls `billing.projects.updateBillingInfo` to **disable billing** when actual spend crosses 95%. This is the only foolproof way to enforce the $500 cap — alert emails alone do not stop spend.

```bash
# Pseudocode for the killswitch function
on(pubsub_message):
  data = json.loads(base64.decode(message.data))
  if data["costAmount"] / data["budgetAmount"] >= 0.95:
    project_id = extract_project_id(data)
    disable_billing(project_id)
    notify_pagerduty(f"Killswitch tripped on {project_id} at ${data['costAmount']}")
```

We wire this for **both** the v2 project and the tiktok-mcp-server project, sharing the same Pub/Sub topic.

### 6.4 Daily cost-watch routine

- Day standup: `gcloud billing accounts get-spend-information --billing-account=$BILLING_ACCT --filter='currency_code=USD'` (or click through the Reports dashboard).
- Compare cumulative spend vs the line in §5.3.
- Anything >20% over plan triggers a same-day investigation per the [Cloud Logging cost-control playbook](https://cloud.google.com/blog/topics/cost-management/how-to-approach-cloud-logging-pricing-for-cloud-admins).

---

## 7. Risk register — cost-blowout scenarios

These are the patterns that turn a $150 plan into a $5,000 invoice. Each has a mitigation.

### 7.1 Forgot to scale-to-zero on a GKE cluster

GKE Standard clusters are not part of this plan. **Mitigation**: do not provision a GKE cluster. Use Cloud Run for everything that needs HTTP serving and Agent Engine for everything that needs agentic compute. Both scale to zero. If a team member is tempted to "just spin up a small cluster for testing", the budget alert at 10% ($50) and the killswitch at 95% will catch it.

### 7.2 Memorystore sized too large

Memorystore for Valkey at 5 GB instead of 1 GB is roughly 5× the price (~$150/mo vs ~$36/mo). **Mitigation**: hard-code the provisioning script to the smallest node tier; require a PR review before any size change; budget alert at 20% ($100) catches the difference inside 3 days.

### 7.3 Gemini Pro called in a tight retry loop

A misconfigured exponential-backoff library + a flaky tool call can fire Gemini 3.1 Pro 1000× per minute. At $2 input + $12 output per 1M tokens × even 5K tokens/call, that is $0.04 × 1000 = **$40/minute**. **Mitigations**:
- All Gemini calls go through a single capability wrapper that enforces a per-run USD cap (already inherited from v1's cost-ledger pattern).
- Inngest function `concurrency` caps each agent at ≤2 parallel invocations.
- Per-run USD cap default = $5; trips an escalation rather than a retry.
- Budget alert at 10% ($50) wakes us inside 2 hours of a runaway.

### 7.4 Vector Search / matching-engine index sized too large

We do not use Vertex Vector Search in either submission (Qdrant from v1 stays for now; if we migrate, we use Memory Bank instead which is per-event not per-GB). **Mitigation**: explicit "no Vector Search" rule in the architecture doc; if a contributor proposes it, redirect to Memory Bank.

### 7.5 Cloud Run → external API at high volume (egress)

If the tiktok-mcp-server hammers TikTok scraper endpoints on Vultr / Hetzner with large response bodies, internet egress at $0.12/GB adds up. 1 TB of egress = $120. **Mitigation**:
- Cap response sizes at the capability layer (truncate beyond N bytes).
- Cache scraped results in MongoDB / GCS so we re-fetch only on cache miss.
- Confirm that judges' demo runs are not in a loop calling the same endpoint thousands of times.

### 7.6 Cloud Logging ingestion explosion

If we accidentally log every Gemini input/output (typical token verbose-logging mistake), we can blow past the 50 GB/month free tier inside a day. At $0.50/GiB, even 200 GB extra is only $100, but combined with other items it can compound. **Mitigation**: structured logs only; never log full prompt/response in non-trace contexts; use Trace for prompt/response capture (Trace is free for Cloud Run-generated spans).

### 7.7 Forgot the killswitch

The killswitch itself is single-point-of-failure. **Mitigation**: keep manual `gcloud billing projects unlink-billing-account` as the documented escape hatch; the on-call (Sejun) has it bookmarked.

---

## 8. Cost-saving levers (apply in this order)

### 8.1 Lever 1 — Flash-for-everything-that-isn't-judgment

Already in the plan; saves ~40% on the demo-run line item. Specifically:
- Classification, logistics, content-verify, follow-up drafts → Gemini 2.5 Flash.
- Sourcing, vetting, tournament-judging, final-report → Gemini Pro.

### 8.2 Lever 2 — Context caching for repeated prefixes

Per [the Vertex AI pricing page](https://cloud.google.com/vertex-ai/generative-ai/pricing), cached input on Gemini 2.5 Pro is $0.20/1M (90% off the $2/1M list). Every agent in v2 shares a ~3K-token system prompt + tool definitions; caching those prefixes saves us ~$0.005 per call × ~2,000 calls during dev = ~$10. **Implement once on day 2.**

### 8.3 Lever 3 — Batch API for non-interactive work

Batch API is 50% off (`$0.625/$5.00` for Pro, `$0.15/$1.25` for Flash). Use it for:
- Golden-set eval suites (always offline, never user-facing).
- Outreach-tournament judge rounds when the tournament happens overnight.
- Final-report generation if we can pre-compute.

Estimated saving: ~$15 over the dev sprint.

### 8.4 Lever 4 — Cap `max_output_tokens` aggressively

A Gemini call without `max_output_tokens` happily generates 8K tokens when 1K would do. Output tokens are 6-10× the price of input tokens (per §1.1), so capping output is the single highest-leverage tuning knob. **Default rule for v2:** each agent declares its expected output length in its contract, and the capability wrapper enforces `max_output_tokens = expected × 1.5`.

### 8.5 Lever 5 — Structured output instead of retries

When an agent returns malformed JSON, we currently retry. Each retry is a full Gemini call. **Mitigation**: use Vertex AI structured-output (controlled generation) mode so the model is constrained to emit valid Zod-schema-compatible JSON on the first try. Saves the ~5% of calls that currently retry.

### 8.6 Lever 6 — Reserve $50 budget alert at 50%, 75%, 90%

Already wired in §6.2. Three additional alerts at 10%, 20%, 95% give us 7 checkpoints between $0 and $500.

### 8.7 Lever 7 — Memorystore on demand

Only stand up Memorystore for Valkey during:
1. The 2-day final-demo-recording window
2. The 30-day judging window

Total Valkey time: ~32 days × $1.20 = **$38.40**. If we instead leave it on for the full 17 + 30 = 47 days, it costs $56.40 — an $18 difference and the only meaningful lever on this SKU. Tear down between dev sessions.

### 8.8 Lever 8 — Pin everything to us-central1

Cross-region egress is $0.01-0.02/GB; same-region is free. Single-region pin saves ~$5-10 over the cycle. Configure as a default in the `.gcloudrc` / Terraform provider.

### 8.9 Lever 9 — Use 2.5 Pro during dev, 3.1 Pro for the final recording

Saves ~30% on the heavy-iteration phase (days 4-7 of the v2 sprint) without compromising the submission, which judges will see running on 3.1 Pro.

---

## 9. Cumulative cost timeline

| Date | Cumulative spend (USD) | Major activity | Budget alert |
|---|---|---|---|
| 2026-05-19 | $0 | Sprint kickoff; provision projects, budget, killswitch | — |
| 2026-05-22 | $10 | End of agent-migration phase | — |
| 2026-05-26 | $40 | End of integration-test phase | — |
| 2026-05-31 | $60 | End of E2E demo-iteration phase | 10% alert ($50) tripped earlier |
| 2026-06-03 | $87 | Polish + final 3.1 Pro recordings done | — |
| 2026-06-05 | $90 | Submission deadline; both tracks shipped | — |
| 2026-06-15 | $115 | Mid-judging-window | 20% alert ($100) tripped |
| 2026-07-05 | $150 | End of judging window | — |
| **Final** | **$150** | Comfortable 70% buffer below cap | |

---

## 10. Open decisions for the team

1. **Do we actually need Memorystore?** Investigate replacing it with Inngest concurrency + Cloud Tasks in the first 3 days. If yes, save $36-56.
2. **Are we OK using `e2-standard-2` Cloud Build (default pool)** or do we need larger machines? Default pool stays in the free tier; larger is not free.
3. **Single billing project vs project-per-track?** Per-track gives cleaner cost attribution and lets us kill one without affecting the other; single is simpler. Recommendation: project-per-track, shared billing account.
4. **Who is on-call for the killswitch?** Recommend Sejun primary, second contact TBD.
5. **Do we keep Anthropic in the loop?** v2's eval set was tuned against Opus/Haiku. We could keep Claude as an A/B fallback during dev (via Anthropic's own credits, not GCP credits) but ship the submission on Gemini only.

---

## 11. Final answer

The Google for Startups AI Agents Challenge $500 cap is **roughly 3.3× our expected spend** for both submissions combined. The single biggest risk is Memorystore-left-on (avoidable) and runaway Gemini retry loops (capped at the capability layer + budget killswitch). Every other cost component is either inside a generous free tier or pays-per-call with $0 idle.

The recommended posture: provision budget + killswitch on day 1, default Gemini calls to Flash where judgment is not required, use 2.5 Pro for dev, switch to 3.1 Pro for the final recording, and only stand up Memorystore when the live demo and judges actually need it.

---

## Sources

### Vertex AI / Gemini pricing
- [Agent Platform Pricing — cloud.google.com/vertex-ai/generative-ai/pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- [Gemini 3.1 Pro model card — docs.cloud.google.com](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-pro)
- [Gemini 2.5 Pro model card — docs.cloud.google.com](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-pro)
- [Gemini 2.5 Flash model card — docs.cloud.google.com](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash)
- [CloudZero Vertex AI 2026 Guide](https://www.cloudzero.com/blog/google-vertex-ai-pricing/)
- [nOps Vertex AI 2026 Guide](https://www.nops.io/blog/vertex-ai-pricing/)
- [tokenmix.ai Vertex AI 2026](https://tokenmix.ai/blog/vertex-ai-pricing)
- [Gemini API Pricing Calculator (May 2026)](https://costgoat.com/pricing/gemini-api)

### Agent Engine / Memory Bank
- [Agent Runtime docs — docs.cloud.google.com](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/runtime)
- [Agent Platform Memory Bank docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank)
- [Memory Bank setup guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/setup)
- [Vertex AI Memory Bank pricing breakdown — aiagentmemory.org](https://aiagentmemory.org/articles/vertex-ai-agent-engine-memory-bank-pricing/)

### Other GCP services
- [Cloud Run pricing — cloud.google.com/run/pricing](https://cloud.google.com/run/pricing)
- [Model Armor — cloud.google.com/security/products/model-armor](https://cloud.google.com/security/products/model-armor)
- [Firebase App Hosting costs](https://firebase.google.com/docs/app-hosting/costs)
- [Artifact Registry pricing — cloud.google.com/artifact-registry/pricing](https://cloud.google.com/artifact-registry/pricing)
- [Cloud Build pricing — cloud.google.com/build/pricing](https://cloud.google.com/build/pricing)
- [Identity Platform pricing — cloud.google.com/identity-platform/pricing](https://cloud.google.com/identity-platform/pricing)
- [Cloud Storage pricing — cloud.google.com/storage/pricing](https://cloud.google.com/storage/pricing)
- [Cloud Storage pricing announcement (2026 egress changes)](https://cloud.google.com/storage/pricing-announce)
- [Cloud Observability pricing — cloud.google.com/products/observability/pricing](https://cloud.google.com/products/observability/pricing)
- [Memorystore for Valkey pricing](https://cloud.google.com/memorystore/valkey/pricing)
- [MongoDB Atlas free cluster limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)

### Billing / budgets / killswitch
- [Create budgets & budget alerts — docs.cloud.google.com](https://docs.cloud.google.com/billing/docs/how-to/budgets)
- [Customize budget alert email recipients](https://docs.cloud.google.com/billing/docs/how-to/budgets-notification-recipients)
- [Set up programmatic notifications (Pub/Sub)](https://docs.cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications)
- [Automated GCP Killswitch tutorial — Medium / Google Cloud Community](https://medium.com/google-cloud/how-to-avoid-a-massive-cloud-bill-41a76251caba)
- [Cloud Logging cost optimization playbook — cloud.google.com/blog](https://cloud.google.com/blog/topics/cost-management/how-to-approach-cloud-logging-pricing-for-cloud-admins)
- [GCP egress rate changes — Akave](https://akave.com/blog/google-cloud-is-doubling-its-peering-egress-rates-on-may-1)
