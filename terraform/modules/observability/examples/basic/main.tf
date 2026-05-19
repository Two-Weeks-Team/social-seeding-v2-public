# examples/basic/main.tf — minimum-viable invocation of the observability module
#
# Demonstrates wiring the module against a single workload project with:
#   - PagerDuty + Slack channels backed by Secret Manager secrets created by
#     `terraform/modules/security`
#   - D33 90-day audit retention defaults
#   - D31 SLO defaults (99.99% / 1s p99 / 0.1% error / 95% cost-per-run)
#   - W2 cost_watch budget at $1500/mo (D39 envelope)
#
# Run:
#   terraform init
#   terraform plan -var="project_id=ss-v2-prod-us" -var="billing_account_id=01ABCD-EF0123-456789"

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.40.0, < 7.0.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 5.40.0, < 7.0.0"
    }
  }
}

variable "project_id" {
  description = "Workload project that receives the observability stack."
  type        = string
}

variable "billing_account_id" {
  description = "GCP billing account id for the cost_watch budget."
  type        = string
  default     = ""
}

variable "region" {
  description = "Primary region for provider operations (multi-region resources span all D13 regions)."
  type        = string
  default     = "us-central1"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# In a real deployment these Secret Manager IDs come from the security/ module.
# For the example we hard-code suggested IDs — the secrets themselves must
# already exist (and contain the PagerDuty integration key / Slack webhook).
module "observability" {
  source = "../.."

  project_id = var.project_id
  regions    = ["us-central1", "europe-west4", "asia-northeast3"]

  # D33 — audit logs 90 days, archive long-tail
  audit_log_retention_days = 90
  archive_retention_days   = 2555 # 7 years

  # D31 — Enterprise SLO
  slo_hot_path_service_id    = "ss-v2-hot-path"
  slo_availability_goal      = 0.9999
  slo_latency_threshold_ms   = 1000
  slo_latency_goal           = 0.99
  slo_error_rate_goal        = 0.999
  slo_cost_per_run_usd_goal  = 0.95
  cost_per_run_threshold_usd = 1.00

  # D32 cost_watch / W2 — 50/75/90/95/100% ramp
  billing_account_id = var.billing_account_id
  monthly_budget_usd = 1500 # D39 GCP credits envelope
  budget_thresholds  = [0.50, 0.75, 0.90, 0.95, 1.00]

  # D32 notification channels — secrets created by terraform/modules/security
  pagerduty_service_key_secret_id = "obs-pagerduty-key"
  slack_webhook_secret_id         = "obs-slack-webhook"
  email_alert_recipients = [
    "sre@ss-v2.example",
    "oncall@ss-v2.example",
  ]

  model_armor_block_threshold_per_minute = 10
  escalation_threshold_per_5min          = 25

  labels = {
    module      = "observability"
    decisions   = "d31-d32-d33"
    managed     = "terraform"
    environment = "prod"
  }
}

output "audit_dataset" {
  value       = module.observability.audit_logs_dataset_self_link
  description = "BigQuery dataset holding 90-day audit logs (D33)."
}

output "chronicle_topic" {
  value       = module.observability.chronicle_ingest_topic
  description = "Pub/Sub topic for Chronicle SIEM ingest (D32)."
}

output "slo_ids" {
  value       = module.observability.slo_ids
  description = "Four SLO IDs created per D31."
}

output "log_metric_names" {
  value       = module.observability.log_based_metric_names
  description = "Log-based metric names — must match what packages/observability emits."
}
