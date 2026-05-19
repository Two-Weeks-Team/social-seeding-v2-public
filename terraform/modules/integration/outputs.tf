# outputs.tf — surface IDs + URLs other modules depend on.
#
# Pattern: callers wire these into the compute module (Cloud Run env vars
# for the callback router, cancel-on-event subscriber, etc.) and the
# observability module (Pub/Sub topic counts, DLQ alerting, Workflow
# execution metrics).

# ── Pub/Sub ──────────────────────────────────────────────────────────────

output "pubsub_topics" {
  description = "Map of topic key → topic full resource name. 15 entries."
  value       = { for k, v in google_pubsub_topic.topics : k => v.id }
}

output "pubsub_topic_short_names" {
  description = "Map of topic key → short name (without project prefix). Used by Workflows YAML."
  value       = { for k, v in google_pubsub_topic.topics : k => v.name }
}

output "pubsub_dlq_topics" {
  description = "Map of topic key → DLQ topic resource ID. Observability module subscribes alerts here."
  value       = { for k, v in google_pubsub_topic.dlq_topics : k => v.id }
}

output "pubsub_default_subscriptions" {
  description = "Map of topic key → default pull subscription ID (operator debug surface)."
  value       = { for k, v in google_pubsub_subscription.default_subs : k => v.id }
}

output "pubsub_schema_ids" {
  description = "Map of schema name → Pub/Sub schema resource ID. Producer SDKs reference these."
  value       = { for k, v in google_pubsub_schema.schemas : k => v.id }
}

# ── Cloud Tasks ──────────────────────────────────────────────────────────

output "cloud_tasks_queues" {
  description = "Map of queue name → full Cloud Tasks queue resource path."
  value       = { for k, v in google_cloud_tasks_queue.queues : k => v.id }
}

output "cloud_tasks_queue_paths" {
  description = "Map of queue name → projects/P/locations/L/queues/Q form. Used by callers to enqueue."
  value = {
    for k, v in google_cloud_tasks_queue.queues :
    k => "projects/${var.project_id}/locations/${var.primary_region}/queues/${v.name}"
  }
}

# ── Workflows ────────────────────────────────────────────────────────────

output "workflows" {
  description = "Map of workflow name → resource ID."
  value       = { for k, v in google_workflows_workflow.workflows : k => v.id }
}

output "workflow_execution_endpoints" {
  description = "Map of workflow name → executions create URL. Cloud Scheduler + manual invokers POST here."
  value = {
    for k, v in google_workflows_workflow.workflows :
    k => "https://workflowexecutions.googleapis.com/v1/projects/${var.project_id}/locations/${var.primary_region}/workflows/${v.name}/executions"
  }
}

# ── Cloud Scheduler ──────────────────────────────────────────────────────

output "scheduler_jobs" {
  description = "Map of cron name → Cloud Scheduler job ID."
  value       = { for k, v in google_cloud_scheduler_job.crons : k => v.id }
}

# ── Eventarc ─────────────────────────────────────────────────────────────

output "eventarc_bus_id" {
  description = "Eventarc Advanced message bus resource ID. Forwarders POST CloudEvents to its ingest URL."
  value       = google_eventarc_message_bus.main.id
}

output "eventarc_enrollment_ids" {
  description = "Map of enrollment key → Eventarc enrollment resource ID."
  value       = { for k, v in google_eventarc_enrollment.enrollments : k => v.id }
}

# ── Apigee ───────────────────────────────────────────────────────────────

output "apigee_organization_id" {
  description = "Apigee X organization resource ID (null if disabled)."
  value       = var.apigee_config.enabled ? google_apigee_organization.main[0].id : null
}

output "apigee_instance_host" {
  description = "Apigee runtime instance host (gateway data plane endpoint)."
  value       = var.apigee_config.enabled ? google_apigee_instance.primary[0].host : null
}

output "apigee_envgroup_hostnames" {
  description = "Hostnames bound to the billing-gateway environment group."
  value       = var.apigee_config.enabled ? google_apigee_envgroup.billing_gateway[0].hostnames : []
}

output "apigee_api_product_ids" {
  description = "Map of API product key → Apigee product resource ID."
  value       = var.apigee_config.enabled ? { for k, v in google_apigee_api_product.products : k => v.id } : {}
}

# ── API Hub ──────────────────────────────────────────────────────────────

output "api_hub_instance_id" {
  description = "Apigee API Hub instance ID. DEFERRED: provider 6.50 lacks the resource — always null until restoration (see api_hub.tf + BN-11)."
  value       = null
}

output "api_hub_api_ids" {
  description = "API IDs registered in the hub catalog. DEFERRED: provider 6.50 lacks the resources — always empty until restoration (see api_hub.tf + BN-11)."
  value       = {}
}

# ── Summary ──────────────────────────────────────────────────────────────

output "integration_summary" {
  description = "Single-line summary of provisioned counts. Useful for CI smoke tests."
  value = {
    pubsub_topics        = length(google_pubsub_topic.topics)
    pubsub_dlqs          = length(google_pubsub_topic.dlq_topics)
    pubsub_schemas       = length(google_pubsub_schema.schemas)
    cloud_tasks_queues   = length(google_cloud_tasks_queue.queues)
    workflows            = length(google_workflows_workflow.workflows)
    scheduler_jobs       = length(google_cloud_scheduler_job.crons)
    eventarc_enrollments = length(google_eventarc_enrollment.enrollments)
    apigee_products      = var.apigee_config.enabled ? length(google_apigee_api_product.products) : 0
    # api_hub_apis is 0 until the Apigee API Hub resources ship in the provider
    # (see api_hub.tf + BN-11). The `enabled` toggle is intentionally ignored
    # here so callers don't get a misleading non-zero count.
    api_hub_apis = 0
    decisions    = "D18,D28,D38"
  }
}
