# alerts.tf — Cloud Monitoring alerting + cost budget (D32)
#
# Policies:
#   1. SLO burn-rate — fast (1h, 14.4×, page) + slow (6h, 6×, slack)
#      following https://cloud.google.com/stackdriver/docs/solutions/slo-monitoring/alerting-on-burn-rate
#   2. Model Armor block-rate (D21, W3)
#   3. Agent escalation surge (W1)
#   4. Billing budget at 50/75/90/95/100% (W2 cost_watch)

locals {
  burn_rate_slos = {
    availability = google_monitoring_slo.availability.slo_id
    latency_p99  = google_monitoring_slo.latency_p99.slo_id
    error_rate   = google_monitoring_slo.error_rate.slo_id
    cost_per_run = google_monitoring_slo.cost_per_run.slo_id
  }

  # Cartesian product of {slo} × {window}. Keys: "<slo>:<window>".
  burn_rate_alerts = merge([
    for slo_name, slo_id in local.burn_rate_slos : {
      "${slo_name}:fast" = {
        slo_id       = slo_id
        slo_display  = slo_name
        window       = "3600s"
        window_label = "1h"
        threshold    = 14.4
        severity     = "CRITICAL"
        duration     = "60s"
        channels     = local.notification_channel_ids
        auto_close   = "1800s"
        doc          = "Fast-burn (1h, 14.4×) — pages PagerDuty. Auto-runbook should already be running per D32."
      }
      "${slo_name}:slow" = {
        slo_id       = slo_id
        slo_display  = slo_name
        window       = "21600s"
        window_label = "6h"
        threshold    = 6
        severity     = "WARNING"
        duration     = "300s"
        channels     = local.cost_channel_ids
        auto_close   = "604800s"
        doc          = "Slow-burn (6h, 6×) — investigate within one business day."
      }
    }
  ]...)
}

resource "google_monitoring_alert_policy" "slo_burn" {
  for_each = local.burn_rate_alerts

  project      = var.project_id
  display_name = "SLO ${each.value.window_label}-burn — ${each.value.slo_display} (D31/D32)"
  combiner     = "OR"
  severity     = each.value.severity

  conditions {
    display_name = "${each.value.window_label} burn over ${each.value.threshold}×"

    condition_threshold {
      filter          = "select_slo_burn_rate(\"projects/${var.project_id}/services/${var.slo_hot_path_service_id}/serviceLevelObjectives/${each.value.slo_id}\", \"${each.value.window}\")"
      threshold_value = each.value.threshold
      comparison      = "COMPARISON_GT"
      duration        = each.value.duration

      trigger { count = 1 }
    }
  }

  notification_channels = each.value.channels

  documentation {
    content   = "## SLO ${each.value.window_label}-burn (${each.value.slo_display})\n\n${each.value.doc}\n\n**Decisions**: D31 (Enterprise SLO), D32 (auto-runbook + Chronicle). Ref: chaos/SCENARIOS.md §1.2."
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = each.value.auto_close
  }

  user_labels = merge(var.labels, {
    burn_window = each.value.window_label
    slo         = each.value.slo_display
  })
}

# ──────────────────────────────────────────────────────────────────────────
# 2. Model Armor block-rate (D21, W3)
# ──────────────────────────────────────────────────────────────────────────

resource "google_monitoring_alert_policy" "model_armor_blocks" {
  project      = var.project_id
  display_name = "Model Armor blocks > ${var.model_armor_block_threshold_per_minute}/min (D21/W3)"
  combiner     = "OR"
  severity     = "CRITICAL"

  conditions {
    display_name = "Model Armor blocks per minute"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.model_armor_block_count.name}\" AND resource.type=\"generic_task\""
      threshold_value = var.model_armor_block_threshold_per_minute
      comparison      = "COMPARISON_GT"
      duration        = "60s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.workspace_id"]
      }

      trigger { count = 1 }
    }
  }

  notification_channels = local.notification_channel_ids

  documentation {
    content   = "## Model Armor block surge\n\nBurst of blocks indicates a prompt-injection campaign or misconfigured template. W3 security_watch auto-quarantines per D21. Cites D21, D32 (Chronicle correlation)."
    mime_type = "text/markdown"
  }

  alert_strategy { auto_close = "3600s" }
  user_labels = merge(var.labels, { watchdog = "w3-security" })

  depends_on = [google_logging_metric.model_armor_block_count]
}

# ──────────────────────────────────────────────────────────────────────────
# 3. Escalation surge (W1)
# ──────────────────────────────────────────────────────────────────────────

resource "google_monitoring_alert_policy" "escalation_surge" {
  project      = var.project_id
  display_name = "Agent escalations > ${var.escalation_threshold_per_5min}/5m (W1)"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "Agent escalation surge"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.agent_escalation_count.name}\" AND resource.type=\"generic_task\""
      threshold_value = var.escalation_threshold_per_5min
      comparison      = "COMPARISON_GT"
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.workspace_id", "metric.label.reason"]
      }

      trigger { count = 1 }
    }
  }

  notification_channels = local.cost_channel_ids

  documentation {
    content   = "## Agent escalation surge (W1 anomaly_watch)\n\nReasons drive auto-runbook: cost_cap → freeze; tool_error → 3rd-party check; judge_reject → review prompt diff; policy_gate → escalate to compliance agent."
    mime_type = "text/markdown"
  }

  alert_strategy { auto_close = "3600s" }
  user_labels = merge(var.labels, { watchdog = "w1-anomaly" })

  depends_on = [google_logging_metric.agent_escalation_count]
}

# ──────────────────────────────────────────────────────────────────────────
# 4. Billing budget — W2 cost_watch (D32 / D39)
# ──────────────────────────────────────────────────────────────────────────

resource "google_pubsub_topic" "cost_watch" {
  project = var.project_id
  name    = "cost-watch-budget-alerts"
  labels  = merge(var.labels, { watchdog = "w2-cost" })

  depends_on = [google_project_service.observability_apis]
}

resource "google_billing_budget" "cost_watch" {
  count = var.billing_account_id == "" ? 0 : 1

  billing_account = var.billing_account_id
  display_name    = "ss-v2 cost_watch — ${var.project_id} (W2 / D32)"

  budget_filter {
    projects               = ["projects/${var.project_id}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(floor(var.monthly_budget_usd))
    }
  }

  dynamic "threshold_rules" {
    for_each = var.budget_thresholds
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  dynamic "threshold_rules" {
    for_each = [for t in var.budget_thresholds : t if t >= 0.90]
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "FORECASTED_SPEND"
    }
  }

  all_updates_rule {
    pubsub_topic                     = google_pubsub_topic.cost_watch.id
    schema_version                   = "1.0"
    monitoring_notification_channels = local.cost_channel_ids
    disable_default_iam_recipients   = false
  }
}
