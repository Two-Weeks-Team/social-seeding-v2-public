# cloud_deploy.tf — canary delivery pipeline + multi-region Cloud Run targets
#
# D37 + MATRIX §7.3: Cloud Build green → canary 10% → 5-min SLO check → 100%.
# D13: one Cloud Run target per region in `var.regions` (3 by default).
# D17: targets render Cloud Run today; swap to Agent Runtime custom target
#      when GCP ships a Cloud Deploy adapter for Vertex AI Agent Runtime.

resource "google_clouddeploy_target" "regional" {
  for_each = toset(var.regions)

  name             = "ss-v2-prod-${each.value}"
  project          = var.project_id
  location         = var.primary_region
  description      = "Production Cloud Run target in ${each.value} (D13 active-active region)."
  require_approval = false

  run {
    location = "projects/${var.project_id}/locations/${each.value}"
  }

  execution_configs {
    usages            = ["RENDER", "DEPLOY", "VERIFY"]
    service_account   = google_service_account.cloud_deploy.email
    execution_timeout = "1800s"
  }

  labels = merge(local.common_labels, { region = each.value, role = "agent-runtime" })

  depends_on = [google_project_service.this]
}

# DEVOPS §A.2 "Parallel deployment is GA" — one release fans out across N
# regional targets in serial pipeline stages with canary inside each.
resource "google_clouddeploy_delivery_pipeline" "agent" {
  name        = "ss-v2-agent-pipeline"
  project     = var.project_id
  location    = var.primary_region
  description = "Canary 10→50→100 across ${length(var.regions)} regions with SLO burn auto-rollback (D37 / MATRIX §7.3)."

  serial_pipeline {
    dynamic "stages" {
      for_each = var.regions
      content {
        target_id = google_clouddeploy_target.regional[stages.value].name
        profiles  = ["prod"]

        strategy {
          canary {
            runtime_config {
              cloud_run {
                automatic_traffic_control = true
                canary_revision_tags      = ["canary"]
                stable_revision_tags      = ["stable"]
                prior_revision_tags       = ["prior"]
              }
            }

            canary_deployment {
              percentages = var.deploy_canary_percentages
              verify      = var.deploy_canary_verify
            }
          }
        }
      }
    }
  }

  labels = local.common_labels

  depends_on = [google_clouddeploy_target.regional]
}

# Freeze windows block promotion during weekends / demo prep (DEVOPS §A.2).
# Caller passes a list of free-form descriptions; we emit one weekly window
# per entry. Empty list → resource is not created.
resource "google_clouddeploy_deploy_policy" "freeze" {
  count = length(var.deploy_freeze_windows) == 0 ? 0 : 1

  name        = "ss-v2-deploy-freeze"
  project     = var.project_id
  location    = var.primary_region
  description = "Blocks promotion during weekend / demo-prep windows."

  selectors {
    delivery_pipeline {
      id = google_clouddeploy_delivery_pipeline.agent.name
    }
  }

  rules {
    rollout_restriction {
      id      = "freeze-weekend"
      actions = ["ADVANCE", "APPROVE", "CREATE", "RETRY_JOB", "ROLLBACK"]

      time_windows {
        time_zone = "UTC"
        weekly_windows {
          days_of_week = ["SATURDAY", "SUNDAY"]
          start_time {
            hours = 0
          }
          end_time {
            hours = 24
          }
        }
      }
    }
  }

  depends_on = [google_clouddeploy_delivery_pipeline.agent]
}

# D32 — Cloud Deploy publishes Rollout events to clouddeploy-operations.
resource "google_pubsub_subscription" "deploy_failures" {
  count = var.notification_pubsub_topic == null ? 0 : 1

  name    = "ss-v2-deploy-failures"
  project = var.project_id
  topic   = "projects/${var.project_id}/topics/clouddeploy-operations"

  filter = "attributes.Action = \"Rollout\" AND attributes.ResourceType = \"Rollout\""

  push_config {
    push_endpoint = var.notification_pubsub_topic
    oidc_token {
      service_account_email = google_service_account.cloud_deploy.email
    }
  }

  ack_deadline_seconds = 60
  expiration_policy {
    ttl = ""
  }
  labels = local.common_labels
}
