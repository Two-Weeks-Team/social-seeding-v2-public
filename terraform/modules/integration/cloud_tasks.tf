# cloud_tasks.tf — 4 Cloud Tasks queues for per-task retry + per-tenant
# concurrency caps (D18 + INNGEST-MIGRATION §3.2 R3 risk mitigation).
#
# Cloud Workflows has no native per-function concurrency cap — the only
# control is the per-region 5000-active-executions hard quota. To respect
# downstream API quotas (Gmail send: 250 quota units/user/second; carrier
# APIs: undocumented but tight; FCM: 600k QPS but per-project-soft), we
# route fan-out through Cloud Tasks queues with `maxConcurrentDispatches`
# and `maxDispatchesPerSecond`.
#
# Per pricing/MODEL.md §4 the cost-alert queue is the "Apigee notification
# rule → Pub/Sub → Cloud Tasks → Slack/PagerDuty webhook" pipeline; it
# needs aggressive retry because alert delivery is operationally critical.

resource "google_cloud_tasks_queue" "queues" {
  for_each = var.cloud_tasks_queues

  name     = each.key
  project  = var.project_id
  location = var.primary_region

  rate_limits {
    max_concurrent_dispatches = each.value.max_concurrent_dispatches
    max_dispatches_per_second = each.value.max_dispatches_per_second
  }

  retry_config {
    max_attempts       = each.value.max_attempts
    max_retry_duration = each.value.max_retry_duration
    min_backoff        = each.value.min_backoff
    max_backoff        = each.value.max_backoff
    max_doublings      = each.value.max_doublings
  }

  # Stackdriver logging on sampling (D31 observability) — every task
  # produces a structured log line for replay + Cloud Trace correlation.
  stackdriver_logging_config {
    sampling_ratio = 1.0
  }
}

# Workflows invoker SA must be able to create tasks (workflow YAMLs that
# need rate-limited fan-out call cloudtasks.tasks.create).
resource "google_cloud_tasks_queue_iam_member" "workflows_enqueuer" {
  for_each = google_cloud_tasks_queue.queues

  project  = var.project_id
  location = each.value.location
  name     = each.value.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${var.workflows_invoker_sa_email}"
}
