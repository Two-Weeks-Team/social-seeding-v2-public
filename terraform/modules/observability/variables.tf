# variables.tf — observability module inputs
#
# Cites D31/D32/D33. All defaults pre-tuned to the social-seeding-v2 SLO
# envelope; callers override only what is policy-specific to their workspace.

variable "project_id" {
  description = "GCP project that owns the observability resources (typically the workload project, not the security project)."
  type        = string
}

variable "regions" {
  description = "Regions the workload is deployed in (D13 multi-region active-active). Used for SLO slicing and BigQuery dataset locations."
  type        = list(string)
  default     = ["us-central1", "europe-west4", "asia-northeast3"]
}

variable "audit_bigquery_location" {
  description = "BigQuery multi-region for the audit_logs dataset. Pinned to a multi-region to survive single-region outage."
  type        = string
  default     = "US"
}

variable "audit_log_retention_days" {
  description = "Partition expiration for the audit_logs BigQuery dataset, per D33 (Audit 90d)."
  type        = number
  default     = 90

  validation {
    condition     = var.audit_log_retention_days >= 90
    error_message = "D33 requires audit logs retained for at least 90 days."
  }
}

variable "archive_storage_location" {
  description = "Cloud Storage location for the long-term audit-archive bucket. Use a multi-region or dual-region."
  type        = string
  default     = "US"
}

variable "archive_retention_days" {
  description = "Lifecycle retention for the audit-archive GCS bucket. Long-tail retention beyond BigQuery's hot 90 days."
  type        = number
  default     = 2555 # ~7 years
}

variable "chronicle_pubsub_topic_id" {
  description = "Pub/Sub topic name (in this project) that Chronicle SIEM (D32) pulls from. The Chronicle ingest forwarder is configured outside Terraform."
  type        = string
  default     = "chronicle-ingest"
}

variable "chronicle_subscription_endpoint" {
  description = "Optional push endpoint for Chronicle ingestion. If empty, Chronicle pulls via subscription."
  type        = string
  default     = ""
}

# ──────────────────────────────────────────────────────────────────────────
# SLO targets — D31
# ──────────────────────────────────────────────────────────────────────────

variable "slo_hot_path_service_id" {
  description = "Cloud Monitoring Service ID for the hot path (MC → LB → Identity → Gateway → Model Armor → Agent Runtime → Spanner)."
  type        = string
  default     = "ss-v2-hot-path"
}

variable "slo_availability_goal" {
  description = "D31 99.99%/yr availability goal expressed as a fraction."
  type        = number
  default     = 0.9999
}

variable "slo_latency_threshold_ms" {
  description = "D31 hot-path p99 latency budget in milliseconds."
  type        = number
  default     = 1000
}

variable "slo_latency_goal" {
  description = "Fraction of requests required to stay under slo_latency_threshold_ms."
  type        = number
  default     = 0.99
}

variable "slo_error_rate_goal" {
  description = "Fraction of requests that MUST be non-5xx."
  type        = number
  default     = 0.999
}

variable "slo_cost_per_run_usd_goal" {
  description = "Per D31 cost-per-run SLO: fraction of agent runs whose cost stays under cost_per_run_threshold_usd."
  type        = number
  default     = 0.95
}

variable "cost_per_run_threshold_usd" {
  description = "Per-agent-run USD ceiling considered 'good' for the cost SLO."
  type        = number
  default     = 1.00
}

# ──────────────────────────────────────────────────────────────────────────
# Cost-watch budget (D32 cost_watch / W2)
# ──────────────────────────────────────────────────────────────────────────

variable "billing_account_id" {
  description = "GCP billing account ID (format: AAAAAA-BBBBBB-CCCCCC). Required for budget alerts. Leave empty to skip budget resources."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "Per-tenant or per-project monthly USD ceiling. W2 cost_watch fires at 50/75/90/95/100%."
  type        = number
  default     = 1500 # D39: $1500 GCP credits envelope
}

variable "budget_thresholds" {
  description = "Budget alert thresholds (fraction of monthly_budget_usd) per D32 cost_watch policy."
  type        = list(number)
  default     = [0.50, 0.75, 0.90, 0.95, 1.00]
}

# ──────────────────────────────────────────────────────────────────────────
# Notification channels — D32 (PagerDuty + Slack + email)
# ──────────────────────────────────────────────────────────────────────────

variable "pagerduty_service_key_secret_id" {
  description = "Secret Manager secret ID (in security/ module) holding the PagerDuty integration key. Empty disables PagerDuty channel."
  type        = string
  default     = ""
}

variable "slack_webhook_secret_id" {
  description = "Secret Manager secret ID (in security/ module) holding the Slack incoming-webhook URL. Empty disables Slack channel."
  type        = string
  default     = ""
}

variable "email_alert_recipients" {
  description = "List of email addresses for on-call alerts. Per D32 always-on fallback channel."
  type        = list(string)
  default     = []
}

variable "model_armor_block_threshold_per_minute" {
  description = "Threshold for Model Armor block alert (D21 + W3 security_watch). Above this rate triggers PagerDuty."
  type        = number
  default     = 10
}

variable "escalation_threshold_per_5min" {
  description = "Threshold for agent escalation alert (5-min window). Above this rate indicates a runaway agent or auth degradation."
  type        = number
  default     = 25
}

# ──────────────────────────────────────────────────────────────────────────
# Labels / housekeeping
# ──────────────────────────────────────────────────────────────────────────

variable "labels" {
  description = "Common labels applied to every resource that supports them."
  type        = map(string)
  default = {
    module    = "observability"
    decisions = "d31-d32-d33"
    managed   = "terraform"
  }
}

variable "enable_prometheus" {
  description = "Whether to enable Managed Service for Prometheus collection. Disable only for greenfield validation."
  type        = bool
  default     = true
}

variable "enable_profiler" {
  description = "Whether to activate Cloud Profiler API. Profiler agents are wired in workload modules; this only flips the API."
  type        = bool
  default     = true
}

variable "enable_trace" {
  description = "Whether to activate Cloud Trace + Telemetry API."
  type        = bool
  default     = true
}
