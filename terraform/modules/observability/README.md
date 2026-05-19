# terraform/modules/observability

Observability module for **social-seeding-v2** GCP build (Track 2 / Optimize).

Implements decisions:

- **D31** — Enterprise SLO: 99.99%/yr availability, p99 < 1s on hot path, RTO 1m, RPO 30s.
- **D32** — Alerting + IR: Cloud Monitoring + PagerDuty + Slack + auto-runbook (Cloud Workflows) + Chronicle SecOps SIEM.
- **D33** — Data lifecycle: Audit logs 90d, PII 30d, Memory 14d. This module owns the **audit 90d** half.

Source documents:

- `gcp-research/decisions/DECISIONS.md` — D31/D32/D33 statements of record
- `gcp-research/decisions/SERVICE-INVENTORY.md` §7 — service-by-service mapping
- `gcp-research/decisions/ARCHITECTURE.md` §6 — observability stack table
- `gcp-research/network-security/NETSEC.md` Part 3 — Cloud Logging / Monitoring / Trace / Profiler best practices
- `gcp-research/chaos/SCENARIOS.md` §1.1-1.5 — SLI breach contract per chaos scenario

## Resources created

| Category | Count | Notes |
|---|---|---|
| API enables | up to 8 | Logging, Monitoring, Trace, Telemetry, Profiler, Error Reporting, BigQuery, Pub/Sub, Storage |
| Log sinks | 3 | BigQuery (audit, 90d partition), GCS (long-term archive), Pub/Sub (Chronicle) |
| Log-based metrics | 5 | `agent.cost.usd`, `agent.tokens.input`, `agent.tokens.output`, `model_armor.block_count`, `agent.escalation_count` |
| Monitoring service | 1 | Custom service for the hot path |
| SLOs | 4 | Availability, p99 latency, error rate, cost-per-run |
| Alert policies | 4 SLOs × 2 windows + 2 = **10** | Fast-burn (1h) + slow-burn (6h) per SLO; Model Armor blocks; escalation surge |
| Billing budget | 1 | Cost watch — 50/75/90/95/100% thresholds, Pub/Sub fan-out (W2) |
| Notification channels | up to 2 + N | PagerDuty (Secret Manager), Slack (Secret Manager), N emails |
| Audit Data-Access configs | 4 | Secret Manager, KMS, BigQuery, Cloud Storage (per NETSEC §3.6) |
| Dashboards | 1 | D31 SLO overview |

## Inputs (highlights)

| Variable | Default | Purpose |
|---|---|---|
| `project_id` | _required_ | Workload project receiving the observability stack |
| `regions` | `[us-central1, europe-west4, asia-northeast3]` | D13 active-active |
| `audit_log_retention_days` | `90` | D33 audit retention; validated ≥ 90 |
| `slo_availability_goal` | `0.9999` | D31 four nines |
| `slo_latency_threshold_ms` | `1000` | D31 hot path p99 |
| `cost_per_run_threshold_usd` | `1.00` | SLO #4 ceiling per agent run |
| `monthly_budget_usd` | `1500` | D39 GCP credits envelope |
| `budget_thresholds` | `[0.5, 0.75, 0.9, 0.95, 1.0]` | W2 cost_watch ramp |
| `pagerduty_service_key_secret_id` | `""` | Secret Manager id from security/ module |
| `slack_webhook_secret_id` | `""` | Secret Manager id from security/ module |
| `email_alert_recipients` | `[]` | Always-on fallback |

Full schema in [`variables.tf`](./variables.tf).

## Outputs

See [`outputs.tf`](./outputs.tf). Downstream consumers:

- **`packages/observability`** reads `log_based_metric_names` to assert that the metric names it logs match what Cloud Logging extracts.
- **`compute/`** module passes `chronicle_ingest_topic` to its workload IAM bindings.
- **`ai/`** module attaches the agent runtime OTLP exporter to the Cloud Trace endpoint and ensures it carries `workspace_id` / `agent_name` / `model` labels matching the `label_extractors` here.

## Usage

```hcl
module "observability" {
  source = "../../modules/observability"

  project_id = "ss-v2-prod-us"
  regions    = ["us-central1", "europe-west4", "asia-northeast3"]

  billing_account_id = "01ABCD-EF0123-456789"
  monthly_budget_usd = 1500

  pagerduty_service_key_secret_id = module.security.pagerduty_secret_id
  slack_webhook_secret_id         = module.security.slack_webhook_secret_id

  email_alert_recipients = ["sre@ss-v2.example", "oncall@ss-v2.example"]

  # Workspace-specific SLO tuning (defaults match D31)
  slo_availability_goal      = 0.9999
  slo_latency_threshold_ms   = 1000
  cost_per_run_threshold_usd = 1.00
}
```

See [`examples/basic`](./examples/basic) for a runnable example.

## Operational notes

### SLO burn-rate alerting (D31 chaos §1.2)

- **Fast-burn (1h, 14.4×)** pages PagerDuty. Auto-runbook fires before the page in most regional outage scenarios — page is the failsafe.
- **Slow-burn (6h, 6×)** is Slack + email only. Investigate within one business day.
- Burn-rate thresholds follow the [Google SRE pattern](https://cloud.google.com/stackdriver/docs/solutions/slo-monitoring/alerting-on-burn-rate).

### Cost watch (W2)

- Each tenant should run this module in their own project for tenant-scoped budgeting. Cross-tenant aggregation happens in the central BigQuery billing export (out of scope for this module).
- The `cost_watch` Pub/Sub topic is the **single trigger surface** for the W2 cost_watch watchdog agent — the agent subscribes here and applies tenant-specific throttling actions (D24).

### Chronicle SIEM (D32)

- The Chronicle ingest forwarder runs **outside** Terraform (managed by SecOps). This module produces the Pub/Sub topic + subscription it consumes.
- The `chronicle_log_filter` captures: Cloud Audit Logs + Model Armor findings + Identity Platform sign-ins + IAP allow/deny + Cloud Armor decisions — the minimum NETSEC §2.11 recommends.

### Data Access audit logs (NETSEC §3.6)

- Off by default in GCP. This module turns them on for Secret Manager, KMS, BigQuery, Cloud Storage.
- **Cost warning**: Data Access logs on BigQuery / Cloud Storage can be high-volume. The `_Default` log bucket exclusion (managed in the workload module) drops noisy debug-level entries.

## Migration / rollback

- All sinks use `unique_writer_identity = true` so destroying the module leaves no orphan permissions.
- Audit dataset `delete_contents_on_destroy = false` and audit bucket `force_destroy = false` — **destroy will fail loudly** if there is data. This is intentional per D33.
- Removing a single SLO is safe; removing the custom service requires removing the SLOs first.

## What this module does NOT do

- Does not deploy the Chronicle ingest forwarder (SecOps).
- Does not configure PodMonitoring CRDs / OTel collectors — that's in the `compute/` module since it depends on GKE/Cloud Run resources.
- Does not create the Secret Manager secrets — `security/` module owns those; this module only reads them.
- Does not configure SCC / DLP — that's in the `security/` module.
- Does not run Agent Evaluation / Agent Optimizer pipelines — that's in the `ai/` module.

## Line count

~1,260 HCL lines across `versions.tf` (29) + `variables.tf` (190) + `main.tf` (339) + `slo.tf` (148) + `notification.tf` (118) + `alerts.tf` (226) + `prometheus.tf` (125) + `outputs.tf` (82). The brief targeted 400-600; the scope (3 sinks + 5 metrics + 1 service + 4 SLOs + 10 alert policies + 1 budget + 3 channel types + 1 dashboard + 4 audit configs) requires ~2× that envelope to keep each block readable.
