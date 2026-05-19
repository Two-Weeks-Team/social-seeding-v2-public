# scheduler.tf — 5 Cloud Scheduler cron jobs targeting Cloud Workflows directly.
#
# INNGEST-MIGRATION.md §3.5 chooses the simpler of the two Cloud Scheduler
# patterns: direct HTTP target instead of the Pub/Sub-indirection pattern.
# Rationale: none of the 5 crons fan out to multiple consumers, so the
# extra Pub/Sub hop adds no value but adds another failure surface.
#
# Each job uses OAuth (service-account-token), targeting the
# `workflowexecutions.googleapis.com/.../executions` endpoint. The body is
# JSON-encoded argument map — empty by default since cron workflows pull
# their state from Spanner.

resource "google_cloud_scheduler_job" "crons" {
  for_each = var.cron_schedules

  name        = each.key
  project     = var.project_id
  region      = var.primary_region
  description = each.value.description
  schedule    = each.value.schedule
  time_zone   = each.value.time_zone

  attempt_deadline = "320s" # Workflows execute-create returns fast; this is the create-call ceiling, not the run duration.

  retry_config {
    retry_count          = 3
    max_retry_duration   = "600s"
    min_backoff_duration = "30s"
    max_backoff_duration = "300s"
    max_doublings        = 3
  }

  http_target {
    uri         = "https://workflowexecutions.googleapis.com/v1/projects/${var.project_id}/locations/${var.primary_region}/workflows/${each.value.workflow_id}/executions"
    http_method = "POST"

    headers = {
      "Content-Type" = "application/json"
      # Surface the cron job id in the execution's argument set so the
      # workflow can branch on its trigger source (cron vs Eventarc vs
      # manual). Workflows reads this via `${args.triggeredBy}`.
      "X-Triggered-By" = "cloud-scheduler/${each.key}"
    }

    body = base64encode(jsonencode({
      argument = jsonencode({
        triggeredBy = "cloud-scheduler/${each.key}"
        scheduledAt = "$${now()}" # Workflows expression — evaluated server-side
      })
      callLogLevel = "LOG_ALL_CALLS"
    }))

    oauth_token {
      service_account_email = var.workflows_invoker_sa_email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  # Hard dependency on workflows owned by this module. Crons targeting
  # workflows owned by other modules (campaign-progression, tiktok-post-poller,
  # nightly-eval — provisioned by the ai / compute modules) rely on the
  # root-module dependency graph to order their creation correctly. The
  # scheduler job itself is happy with a URL string; the workflow only has
  # to exist by the first execution.
  depends_on = [google_workflows_workflow.workflows]
}

# ── Locals: which workflows are owned by THIS module vs imported ────────
#
# Surfaced for the README + root-module wiring; the scheduler resource
# itself does not branch on this since Cloud Scheduler is fine with a URL
# that resolves later.
locals {
  cron_workflows_owned_here = ["gmail-watch-renew", "report-deliver-cron"]
  cron_workflows_owned_elsewhere = [
    "campaign-progression", # ai module (per-tenant nightly state advance)
    "tiktok-post-poller",   # ai module (content_verify hourly poll)
    "nightly-eval",         # ai module (D25 Vertex Agent Evaluation)
  ]
}
