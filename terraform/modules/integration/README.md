# terraform/modules/integration

Integration plane for Social Seeding v2: durable orchestration, event bus,
and per-view monetization gateway. Implements **D18** (Cloud Workflows +
Pub/Sub + Cloud Tasks + Eventarc Advanced — Inngest retired) and **D28**
(Apigee X for $0.01-per-delivered-view billing).

## What this module provisions

| Resource family       | Count | Source                              |
|-----------------------|-------|-------------------------------------|
| Pub/Sub topics        | 15    | `day-1-setup.sh` inventory (lines 254-270) |
| Pub/Sub DLQ topics    | 15    | one per topic (D32 alerting hook)   |
| Pub/Sub schemas (Avro)| 5     | `shared.asyncapi.yaml` messages     |
| Default subscriptions | 15    | operator debug surface              |
| Cloud Tasks queues    | 4     | `outreach-send`, `carrier-poll`, `fcm-push`, `cost-alert` |
| Cloud Workflows       | 5     | `brand-campaign`, `creator-track`, `gate`, `gmail-watch-renew`, `report-deliver-cron` |
| Cloud Scheduler jobs  | 5     | one per cron-triggered workflow     |
| Eventarc Advanced bus | 1     | + 8 enrollments                     |
| Apigee X organization | 1     | + instance + envgroup + 3 products  |
| API Hub instance      | 1     | + 2 catalog entries (REST + Async)  |

## Layout

```
integration/
├── versions.tf            # provider pins (google + google-beta)
├── variables.tf           # 11 inputs (project, region, endpoints, SAs, cmek, …)
├── main.tf                # locals: topic inventory, schemas, enrollments, products
├── pubsub.tf              # topics + schemas + subscriptions + DLQs + IAM
├── cloud_tasks.tf         # 4 queues with per-queue rate limits
├── workflows.tf           # 5 google_workflows_workflow resources
├── scheduler.tf           # 5 google_cloud_scheduler_job resources
├── eventarc.tf            # Advanced bus + pipelines + enrollments
├── apigee.tf              # org + instance + envgroup + env + 3 products
├── api_hub.tf             # hub instance + 2 catalog APIs
├── outputs.tf             # ids + URLs other modules consume
├── workflows/             # workflow YAML definitions (file()-loaded)
│   ├── brand-campaign.workflows.yaml
│   ├── creator-track.workflows.yaml
│   ├── gate.workflows.yaml
│   ├── gmail-watch-renew.workflows.yaml
│   └── report-deliver-cron.workflows.yaml
├── schemas/               # Avro schemas attached to Pub/Sub topics
│   ├── agent-invoked.avsc
│   ├── agent-completed.avsc
│   ├── agent-cost-recorded.avsc
│   ├── armor-block.avsc
│   └── anomaly-detected.avsc
└── examples/basic/        # minimal callable example
```

## Usage

See `examples/basic/`. Minimal:

```hcl
module "integration" {
  source = "../../modules/integration"

  project_id     = "ss-v2-prod"
  primary_region = "asia-northeast3"

  workflows_invoker_sa_email = module.security.workflows_invoker_sa_email
  pubsub_publisher_sa_email  = module.security.pubsub_publisher_sa_email
  cmek_key_id                = module.security.cmek_pubsub_key_id

  service_endpoints = {
    observability_url     = module.compute.observability_url
    policy_url            = module.compute.policy_url
    campaign_repo_url     = module.compute.campaign_repo_url
    agent_runtime_url     = module.ai.agent_runtime_url
    pick_shortlist_url    = module.compute.pick_shortlist_url
    creator_directory_url = module.compute.creator_directory_url
    callback_router_url   = module.compute.callback_router_url
    approvals_api_url     = module.compute.approvals_api_url
    gate_predicate_url    = module.compute.gate_predicate_url
  }
}
```

## Decision references

- **D18** — `gcp-research/decisions/DECISIONS.md` line 67. Orchestration =
  Cloud Workflows (durable) + Pub/Sub (fan-out) + Cloud Tasks (retry) +
  Eventarc Advanced (system events). Inngest retired.
- **D28** — `gcp-research/decisions/DECISIONS.md` line 92. Pricing =
  $0.01/delivered view; per-view metering pipeline (Pub/Sub event →
  BigQuery → Apigee) required.
- **D38** — `gcp-research/decisions/SERVICE-INVENTORY.md` line 222. API
  Hub catalog for OpenAPI + AsyncAPI specs.
- **D36** — Pub/Sub Schema Registry enforces AsyncAPI 3.0 schemas.
- **Workflow YAML samples** — `gcp-research/migrations/INNGEST-MIGRATION.md`
  §4.1, §4.2, §4.3 (deploy-ready; this module copies them verbatim into
  `workflows/`).
- **Billing pipeline** — `gcp-research/pricing/MODEL.md` §4.1 (event flow),
  §4.3 (Apigee monetization product specifics).

## Known open questions

- **O-S1** (`SERVICE-INVENTORY.md` line 323) — does Apigee X support
  `asia-northeast3` for monetization meter? This module defaults Apigee
  to `asia-northeast1` (Tokyo) via `var.apigee_config.analytics_region`
  pending the GA confirmation. Override at the root for Seoul rollout.
- **R3** (`INNGEST-MIGRATION.md` line 847) — per-tenant Cloud Tasks
  concurrency. We ship a single `outreach-send` queue with cluster-wide
  `maxConcurrentDispatches`. A per-tenant queue-fanout is a future
  refinement (the router-service pattern in §3.2 is ready for it).
- **R1** (`INNGEST-MIGRATION.md` line 845) — outbox-pattern publishing.
  Cloud Workflows' `googleapis.pubsub.v1.projects.topics.publish` is NOT
  atomic with the preceding step's commit. The compute module owns the
  outbox dispatcher Cloud Run service; this module just provides the
  topics it publishes to.
