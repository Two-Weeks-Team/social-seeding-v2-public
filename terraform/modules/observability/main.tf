# main.tf — observability module
#
# Cites: D31 (SLO), D32 (Chronicle + auto-runbook), D33 (audit 90d).
# Owns: API enablement, three log sinks, five log-based metrics, audit-log
# configs for sensitive services.

locals {
  audit_log_filter = <<-EOT
    logName:"cloudaudit.googleapis.com"
    OR logName:"modelarmor.googleapis.com"
    OR (resource.type="aiplatform.googleapis.com/ReasoningEngine" AND severity>=NOTICE)
  EOT

  # Chronicle SIEM filter (D32, NETSEC §2.11): audit + Model Armor + identity
  # + IAP + Cloud Armor — Chronicle minimum correlation set.
  chronicle_log_filter = <<-EOT
    logName:"cloudaudit.googleapis.com"
    OR logName:"modelarmor.googleapis.com"
    OR logName:"identitytoolkit.googleapis.com"
    OR logName:"iap.googleapis.com"
    OR logName:"compute.googleapis.com/cloud_armor"
  EOT

  archive_log_filter = "logName:* AND severity>=DEBUG"

  required_services = toset([
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "clouderrorreporting.googleapis.com",
    "bigquery.googleapis.com",
    "pubsub.googleapis.com",
    "storage.googleapis.com",
  ])

  optional_services = toset(compact([
    var.enable_trace ? "cloudtrace.googleapis.com" : "",
    var.enable_trace ? "telemetry.googleapis.com" : "",
    var.enable_profiler ? "cloudprofiler.googleapis.com" : "",
  ]))

  # Agent-emitted distribution metrics. All share the same workspace_id /
  # agent_name / model labels and filter on agent.run.finish, varying only
  # the value-extractor field and bucket layout.
  agent_distribution_metrics = {
    "agent.cost.usd" = {
      description = "Per-run USD cost (D31 cost SLO, W2 cost_watch)."
      field       = "cost_usd"
      buckets     = { explicit = [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 25.0, 100.0] }
    }
    "agent.tokens.input" = {
      description = "Input tokens per agent run."
      field       = "tokens_in"
      buckets     = { exp = { count = 16, growth = 2, scale = 100 } }
    }
    "agent.tokens.output" = {
      description = "Output tokens per agent run."
      field       = "tokens_out"
      buckets     = { exp = { count = 16, growth = 2, scale = 50 } }
    }
  }
}

# ──────────────────────────────────────────────────────────────────────────
# API enablement
# ──────────────────────────────────────────────────────────────────────────

resource "google_project_service" "observability_apis" {
  for_each           = local.required_services
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_project_service" "optional" {
  for_each           = local.optional_services
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# ──────────────────────────────────────────────────────────────────────────
# 1. BigQuery sink — audit logs, 90-day partition expiry (D33)
# ──────────────────────────────────────────────────────────────────────────

resource "google_bigquery_dataset" "audit_logs" {
  project                         = var.project_id
  dataset_id                      = "audit_logs"
  location                        = var.audit_bigquery_location
  description                     = "Audit log sink, D33 90-day retention."
  default_partition_expiration_ms = var.audit_log_retention_days * 24 * 60 * 60 * 1000
  delete_contents_on_destroy      = false
  labels                          = var.labels

  depends_on = [google_project_service.observability_apis]
}

resource "google_logging_project_sink" "bigquery_audit" {
  project                = var.project_id
  name                   = "audit-to-bigquery"
  destination            = "bigquery.googleapis.com/projects/${var.project_id}/datasets/${google_bigquery_dataset.audit_logs.dataset_id}"
  filter                 = local.audit_log_filter
  unique_writer_identity = true

  bigquery_options {
    use_partitioned_tables = true
  }
}

resource "google_bigquery_dataset_iam_member" "bigquery_audit_writer" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.audit_logs.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = google_logging_project_sink.bigquery_audit.writer_identity
}

# ──────────────────────────────────────────────────────────────────────────
# 2. Cloud Storage sink — long-term archive
# ──────────────────────────────────────────────────────────────────────────

resource "google_storage_bucket" "audit_archive" {
  project                     = var.project_id
  name                        = "${var.project_id}-audit-archive"
  location                    = var.archive_storage_location
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  force_destroy               = false
  labels                      = var.labels

  versioning { enabled = true }

  dynamic "lifecycle_rule" {
    for_each = {
      "30"  = "NEARLINE"
      "90"  = "COLDLINE"
      "365" = "ARCHIVE"
    }
    content {
      condition { age = tonumber(lifecycle_rule.key) }
      action {
        type          = "SetStorageClass"
        storage_class = lifecycle_rule.value
      }
    }
  }

  lifecycle_rule {
    condition { age = var.archive_retention_days }
    action { type = "Delete" }
  }

  depends_on = [google_project_service.observability_apis]
}

resource "google_logging_project_sink" "gcs_archive" {
  project                = var.project_id
  name                   = "logs-to-gcs-archive"
  destination            = "storage.googleapis.com/${google_storage_bucket.audit_archive.name}"
  filter                 = local.archive_log_filter
  unique_writer_identity = true
}

resource "google_storage_bucket_iam_member" "archive_writer" {
  bucket = google_storage_bucket.audit_archive.name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.gcs_archive.writer_identity
}

# ──────────────────────────────────────────────────────────────────────────
# 3. Pub/Sub sink — Chronicle SIEM (D32)
# ──────────────────────────────────────────────────────────────────────────

resource "google_pubsub_topic" "chronicle_ingest" {
  project                    = var.project_id
  name                       = var.chronicle_pubsub_topic_id
  message_retention_duration = "86400s"
  labels                     = var.labels

  depends_on = [google_project_service.observability_apis]
}

resource "google_pubsub_subscription" "chronicle" {
  project                    = var.project_id
  name                       = "${var.chronicle_pubsub_topic_id}-${var.chronicle_subscription_endpoint == "" ? "pull" : "push"}"
  topic                      = google_pubsub_topic.chronicle_ingest.name
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  labels                     = var.labels

  dynamic "push_config" {
    for_each = var.chronicle_subscription_endpoint == "" ? [] : [1]
    content {
      push_endpoint = var.chronicle_subscription_endpoint
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

resource "google_logging_project_sink" "chronicle" {
  project                = var.project_id
  name                   = "logs-to-chronicle"
  destination            = "pubsub.googleapis.com/projects/${var.project_id}/topics/${google_pubsub_topic.chronicle_ingest.name}"
  filter                 = local.chronicle_log_filter
  unique_writer_identity = true
}

resource "google_pubsub_topic_iam_member" "chronicle_writer" {
  project = var.project_id
  topic   = google_pubsub_topic.chronicle_ingest.name
  role    = "roles/pubsub.publisher"
  member  = google_logging_project_sink.chronicle.writer_identity
}

# ──────────────────────────────────────────────────────────────────────────
# 4. Log-based metrics — agent cost / tokens / Model Armor / escalations
# ──────────────────────────────────────────────────────────────────────────
# Filter on canonical `agent.run.finish` log emitted by packages/observability.
# Schema: agent_run_id, workspace_id, agent_name, cost_usd, tokens_in,
# tokens_out, latency_ms, model.

resource "google_logging_metric" "agent_distributions" {
  for_each = local.agent_distribution_metrics

  project         = var.project_id
  name            = each.key
  description     = each.value.description
  filter          = "jsonPayload.event=\"agent.run.finish\" AND jsonPayload.${each.value.field}>0"
  value_extractor = "EXTRACT(jsonPayload.${each.value.field})"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "DISTRIBUTION"
    unit         = "1"
    display_name = each.key

    labels {
      key         = "workspace_id"
      value_type  = "STRING"
      description = "Tenant id"
    }
    labels {
      key         = "agent_name"
      value_type  = "STRING"
      description = "Tier-1 agent name"
    }
    labels {
      key         = "model"
      value_type  = "STRING"
      description = "Model id"
    }
  }

  label_extractors = {
    workspace_id = "EXTRACT(jsonPayload.workspace_id)"
    agent_name   = "EXTRACT(jsonPayload.agent_name)"
    model        = "EXTRACT(jsonPayload.model)"
  }

  bucket_options {
    dynamic "explicit_buckets" {
      for_each = lookup(each.value.buckets, "explicit", null) == null ? [] : [each.value.buckets.explicit]
      content {
        bounds = explicit_buckets.value
      }
    }
    dynamic "exponential_buckets" {
      for_each = lookup(each.value.buckets, "exp", null) == null ? [] : [each.value.buckets.exp]
      content {
        num_finite_buckets = exponential_buckets.value.count
        growth_factor      = exponential_buckets.value.growth
        scale              = exponential_buckets.value.scale
      }
    }
  }

  depends_on = [google_project_service.observability_apis]
}

resource "google_logging_metric" "model_armor_block_count" {
  project     = var.project_id
  name        = "model_armor.block_count"
  description = "Model Armor blocks (D21, W3 security_watch)."
  filter      = "logName:\"modelarmor.googleapis.com\" AND (jsonPayload.action=\"BLOCK\" OR jsonPayload.verdict=\"BLOCKED\")"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Model Armor blocks"

    labels {
      key         = "workspace_id"
      value_type  = "STRING"
      description = "Tenant — quarantine threshold applied per tenant."
    }
    labels {
      key         = "policy"
      value_type  = "STRING"
      description = "Policy name (pi, jb, pii, rai, regex)."
    }
  }

  label_extractors = {
    workspace_id = "EXTRACT(jsonPayload.workspace_id)"
    policy       = "EXTRACT(jsonPayload.policy_name)"
  }

  depends_on = [google_project_service.observability_apis]
}

resource "google_logging_metric" "agent_escalation_count" {
  project     = var.project_id
  name        = "agent.escalation_count"
  description = "Agent escalations (W1 anomaly_watch). High rate = runaway agent."
  filter      = "jsonPayload.event=\"agent.escalation\" AND jsonPayload.reason!=\"\""

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Agent escalations"

    labels {
      key        = "workspace_id"
      value_type = "STRING"
    }
    labels {
      key        = "agent_name"
      value_type = "STRING"
    }
    labels {
      key         = "reason"
      value_type  = "STRING"
      description = "cost_cap | judge_reject | tool_error | policy_gate"
    }
  }

  label_extractors = {
    workspace_id = "EXTRACT(jsonPayload.workspace_id)"
    agent_name   = "EXTRACT(jsonPayload.agent_name)"
    reason       = "EXTRACT(jsonPayload.reason)"
  }

  depends_on = [google_project_service.observability_apis]
}

# ──────────────────────────────────────────────────────────────────────────
# 5. Audit-log Data Access configuration (NETSEC §3.6)
# ──────────────────────────────────────────────────────────────────────────
# Off by default in GCP. Explicitly enable for the 4 most-exfiltratable services.

resource "google_project_iam_audit_config" "data_access" {
  for_each = toset([
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "bigquery.googleapis.com",
    "storage.googleapis.com",
  ])

  project = var.project_id
  service = each.value

  audit_log_config { log_type = "ADMIN_READ" }
  audit_log_config { log_type = "DATA_READ" }
  audit_log_config { log_type = "DATA_WRITE" }
}
