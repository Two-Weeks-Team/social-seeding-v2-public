# slo.tf — Cloud Monitoring service + 4 SLOs per D31
#
# D31 commits to four contracts on the hot path:
#   1. Availability 99.99%/yr
#   2. p99 latency < 1 s
#   3. Error rate ≤ 0.1%
#   4. Cost-per-run ceiling (≥95% of runs stay under $cost_per_run_threshold_usd)
#
# Cites D13 (multi-region), D31, chaos/SCENARIOS.md §1.1-1.5.

# The "hot path" is a custom Cloud Monitoring service. Cloud Run / GKE services
# would auto-register, but the hot path is a *composed* SLI across LB + Gateway
# + Agent Runtime, so we declare it explicitly.

resource "google_monitoring_custom_service" "hot_path" {
  project      = var.project_id
  service_id   = var.slo_hot_path_service_id
  display_name = "ss-v2 hot path (MC → LB → Gateway → Model Armor → Agent Runtime → Spanner)"

  user_labels = var.labels

  depends_on = [google_project_service.observability_apis]
}

# ──────────────────────────────────────────────────────────────────────────
# SLO 1: Availability 99.99% — D31
# ──────────────────────────────────────────────────────────────────────────

resource "google_monitoring_slo" "availability" {
  project      = var.project_id
  service      = google_monitoring_custom_service.hot_path.service_id
  slo_id       = "hot-path-availability"
  display_name = "Hot path availability (D31: 99.99%/yr)"

  goal                = var.slo_availability_goal
  rolling_period_days = 28

  request_based_sli {
    good_total_ratio {
      good_service_filter  = <<-EOT
        metric.type="logging.googleapis.com/user/agent.run.finish"
        AND resource.type="generic_task"
        AND metric.label.result="success"
      EOT
      total_service_filter = <<-EOT
        metric.type="logging.googleapis.com/user/agent.run.finish"
        AND resource.type="generic_task"
      EOT
    }
  }

  user_labels = var.labels
}

# ──────────────────────────────────────────────────────────────────────────
# SLO 2: p99 latency < 1 s on hot path — D31
# ──────────────────────────────────────────────────────────────────────────

resource "google_monitoring_slo" "latency_p99" {
  project      = var.project_id
  service      = google_monitoring_custom_service.hot_path.service_id
  slo_id       = "hot-path-latency-p99"
  display_name = "Hot path p99 < ${var.slo_latency_threshold_ms}ms (D31)"

  goal                = var.slo_latency_goal
  rolling_period_days = 28

  request_based_sli {
    distribution_cut {
      distribution_filter = <<-EOT
        metric.type="loadbalancing.googleapis.com/https/total_latencies"
        AND resource.type="https_lb_rule"
        AND resource.label.backend_target_name="${var.slo_hot_path_service_id}"
      EOT
      range {
        max = var.slo_latency_threshold_ms
      }
    }
  }

  user_labels = var.labels
}

# ──────────────────────────────────────────────────────────────────────────
# SLO 3: Error rate ≤ 0.1% (5xx) — D31
# ──────────────────────────────────────────────────────────────────────────

resource "google_monitoring_slo" "error_rate" {
  project      = var.project_id
  service      = google_monitoring_custom_service.hot_path.service_id
  slo_id       = "hot-path-error-rate"
  display_name = "Hot path error rate ≤ ${(1 - var.slo_error_rate_goal) * 100}% (D31)"

  goal                = var.slo_error_rate_goal
  rolling_period_days = 28

  request_based_sli {
    good_total_ratio {
      bad_service_filter   = <<-EOT
        metric.type="loadbalancing.googleapis.com/https/request_count"
        AND resource.type="https_lb_rule"
        AND metric.label.response_code_class="500"
        AND resource.label.backend_target_name="${var.slo_hot_path_service_id}"
      EOT
      total_service_filter = <<-EOT
        metric.type="loadbalancing.googleapis.com/https/request_count"
        AND resource.type="https_lb_rule"
        AND resource.label.backend_target_name="${var.slo_hot_path_service_id}"
      EOT
    }
  }

  user_labels = var.labels
}

# ──────────────────────────────────────────────────────────────────────────
# SLO 4: Cost-per-run — D31
# ──────────────────────────────────────────────────────────────────────────
#
# Definition: ≥ slo_cost_per_run_usd_goal fraction of agent runs cost less
# than cost_per_run_threshold_usd. Distribution cut on the `agent.cost.usd`
# log-based metric defined in main.tf.

resource "google_monitoring_slo" "cost_per_run" {
  project      = var.project_id
  service      = google_monitoring_custom_service.hot_path.service_id
  slo_id       = "agent-cost-per-run"
  display_name = "Agent cost-per-run ≤ $${var.cost_per_run_threshold_usd} (D31)"

  goal                = var.slo_cost_per_run_usd_goal
  rolling_period_days = 28

  request_based_sli {
    distribution_cut {
      distribution_filter = <<-EOT
        metric.type="logging.googleapis.com/user/${google_logging_metric.agent_distributions["agent.cost.usd"].name}"
        AND resource.type="generic_task"
      EOT
      range {
        max = var.cost_per_run_threshold_usd
      }
    }
  }

  user_labels = var.labels

  depends_on = [google_logging_metric.agent_distributions]
}
