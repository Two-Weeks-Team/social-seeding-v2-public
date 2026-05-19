# versions.tf — observability module
#
# Cites: D31 (Enterprise SLO 99.99% / p99 < 1s / RTO 1m / RPO 30s),
#        D32 (Cloud Monitoring + PagerDuty + Slack + Auto-runbook + Chronicle),
#        D33 (PII 30d / Audit 90d / Memory 14d)
#
# Provider pinning intentionally conservative: google-beta is required for
# managed-prometheus dashboards, log-based metric `value_extractor`s with
# regex bucketization, and the dataplex-style audit-log routing rules added
# in 2026-Q1.

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
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
  }
}
