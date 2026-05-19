# outputs.tf — values exported to other modules / root
#
# Downstream modules (compute/, ai/, security/) consume these to:
#   - configure OTLP exporters to the right Cloud Trace endpoint
#   - publish into the Chronicle Pub/Sub topic
#   - bind workload IAM to the audit BigQuery dataset

output "audit_logs_dataset_id" {
  description = "BigQuery dataset id holding 90-day audit logs (D33)."
  value       = google_bigquery_dataset.audit_logs.dataset_id
}

output "audit_logs_dataset_self_link" {
  description = "Fully-qualified BigQuery dataset reference for SQL references."
  value       = "${var.project_id}.${google_bigquery_dataset.audit_logs.dataset_id}"
}

output "audit_archive_bucket" {
  description = "GCS bucket containing the long-term audit log archive."
  value       = google_storage_bucket.audit_archive.name
}

output "chronicle_ingest_topic" {
  description = "Pub/Sub topic that Chronicle SIEM pulls from (D32)."
  value       = google_pubsub_topic.chronicle_ingest.id
}

output "chronicle_ingest_topic_name" {
  description = "Short name of the Chronicle ingest Pub/Sub topic."
  value       = google_pubsub_topic.chronicle_ingest.name
}

output "hot_path_service_id" {
  description = "Cloud Monitoring custom service id for the hot path (D31)."
  value       = google_monitoring_custom_service.hot_path.service_id
}

output "slo_ids" {
  description = "Map of SLO name → slo id (D31 four numbers)."
  value = {
    availability = google_monitoring_slo.availability.slo_id
    latency_p99  = google_monitoring_slo.latency_p99.slo_id
    error_rate   = google_monitoring_slo.error_rate.slo_id
    cost_per_run = google_monitoring_slo.cost_per_run.slo_id
  }
}

output "log_based_metric_names" {
  description = "Map of log-based metric short names. Used by the agent runtime to confirm metric names match emitted log fields."
  value = {
    cost_usd          = google_logging_metric.agent_distributions["agent.cost.usd"].name
    tokens_input      = google_logging_metric.agent_distributions["agent.tokens.input"].name
    tokens_output     = google_logging_metric.agent_distributions["agent.tokens.output"].name
    model_armor_block = google_logging_metric.model_armor_block_count.name
    escalation        = google_logging_metric.agent_escalation_count.name
  }
}

output "notification_channels" {
  description = "All notification channel IDs (PagerDuty + Slack + email)."
  value       = local.notification_channel_ids
}

output "cost_notification_channels" {
  description = "Subset of channels used for cost alerts (Slack + email)."
  value       = local.cost_channel_ids
}

output "cost_watch_topic" {
  description = "Pub/Sub topic id receiving budget alert messages (W2)."
  value       = google_pubsub_topic.cost_watch.id
}

output "slo_dashboard_name" {
  description = "Cloud Monitoring dashboard resource name (D31 SLO overview)."
  value       = google_monitoring_dashboard.slo_overview.id
}

output "audit_data_access_services" {
  description = "Services for which Data Access audit logs were turned on (NETSEC §3.6)."
  value       = [for c in google_project_iam_audit_config.data_access : c.service]
}
