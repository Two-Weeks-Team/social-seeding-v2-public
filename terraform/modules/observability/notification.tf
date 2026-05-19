# notification.tf — Cloud Monitoring notification channels (D32)
#
# Channels:
#   1. PagerDuty   — for SLO fast-burn + Model Armor block bursts (auth from Secret Manager)
#   2. Slack       — for cost_watch + slow-burn warnings (webhook URL from Secret Manager)
#   3. Email       — always-on fallback (no secrets)
#
# Secrets are pulled by `data` lookups against Secret Manager — the secrets
# themselves are created in terraform/modules/security/.
# A real-world caller passes `*_secret_id`; the module reads the latest version.

data "google_secret_manager_secret_version" "pagerduty_key" {
  count = var.pagerduty_service_key_secret_id == "" ? 0 : 1

  project = var.project_id
  secret  = var.pagerduty_service_key_secret_id
  version = "latest"
}

data "google_secret_manager_secret_version" "slack_webhook" {
  count = var.slack_webhook_secret_id == "" ? 0 : 1

  project = var.project_id
  secret  = var.slack_webhook_secret_id
  version = "latest"
}

# ──────────────────────────────────────────────────────────────────────────
# PagerDuty — for SLO fast-burn + security_watch
# ──────────────────────────────────────────────────────────────────────────
#
# Cloud Monitoring's PagerDuty channel uses the `service_key` (integration key)
# rather than the v2 routing key. Both work with Events API v2; service_key is
# the Cloud-Monitoring-native field.

resource "google_monitoring_notification_channel" "pagerduty" {
  count = var.pagerduty_service_key_secret_id == "" ? 0 : 1

  project      = var.project_id
  display_name = "PagerDuty — ss-v2 on-call (D32)"
  type         = "pagerduty"

  sensitive_labels {
    service_key = data.google_secret_manager_secret_version.pagerduty_key[0].secret_data
  }

  user_labels = merge(var.labels, {
    channel = "pagerduty"
    purpose = "slo-fast-burn-and-security"
  })

  enabled = true
}

# ──────────────────────────────────────────────────────────────────────────
# Slack webhook
# ──────────────────────────────────────────────────────────────────────────

resource "google_monitoring_notification_channel" "slack" {
  count = var.slack_webhook_secret_id == "" ? 0 : 1

  project      = var.project_id
  display_name = "Slack — ss-v2 ops channel (D32)"
  type         = "slack"

  labels = {
    channel_name = "#ss-v2-alerts"
  }

  sensitive_labels {
    auth_token = data.google_secret_manager_secret_version.slack_webhook[0].secret_data
  }

  user_labels = merge(var.labels, {
    channel = "slack"
    purpose = "cost-watch-and-slow-burn"
  })

  enabled = true
}

# ──────────────────────────────────────────────────────────────────────────
# Email — always-on fallback
# ──────────────────────────────────────────────────────────────────────────

resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.email_alert_recipients)

  project      = var.project_id
  display_name = "Email — ${each.value}"
  type         = "email"

  labels = {
    email_address = each.value
  }

  user_labels = merge(var.labels, {
    channel = "email"
  })

  enabled = true
}

locals {
  # Aggregated channel list for downstream alert policies.
  # PagerDuty first (highest priority), then Slack, then email fallback.
  notification_channel_ids = concat(
    [for c in google_monitoring_notification_channel.pagerduty : c.id],
    [for c in google_monitoring_notification_channel.slack : c.id],
    [for c in google_monitoring_notification_channel.email : c.id],
  )

  # Lower-priority subset for cost_watch (Slack + email only — don't page on $$).
  cost_channel_ids = concat(
    [for c in google_monitoring_notification_channel.slack : c.id],
    [for c in google_monitoring_notification_channel.email : c.id],
  )
}
