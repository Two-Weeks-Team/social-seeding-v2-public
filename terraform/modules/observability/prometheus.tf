# prometheus.tf — Managed Service for Prometheus + D31 dashboard
#
# This module flips the API and creates the canonical SLO dashboard.
# PodMonitoring CRDs / OTel collectors live in compute/ since they bind to
# the GKE / Cloud Run resources there. Cites D31, NETSEC §3.2.

resource "google_project_service" "prometheus" {
  count              = var.enable_prometheus ? 1 : 0
  project            = var.project_id
  service            = "monitoring.googleapis.com"
  disable_on_destroy = false
}

# D31 SLO dashboard — single rollup across availability / latency / cost /
# Model Armor / escalations. JSON layout uses Cloud Monitoring's mosaic grid.

resource "google_monitoring_dashboard" "slo_overview" {
  project = var.project_id

  dashboard_json = jsonencode({
    displayName = "ss-v2 SLO overview (D31)"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          xPos = 0, yPos = 0, width = 6, height = 4
          widget = {
            title = "Hot path p99 latency (D31 #2, <${var.slo_latency_threshold_ms}ms)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"loadbalancing.googleapis.com/https/total_latencies\" resource.type=\"https_lb_rule\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_PERCENTILE_99"
                      crossSeriesReducer = "REDUCE_MAX"
                    }
                  }
                }
                plotType = "LINE"
              }]
              thresholds = [{
                value = var.slo_latency_threshold_ms, color = "RED", direction = "ABOVE", label = "D31 budget"
              }]
            }
          }
        },
        {
          xPos = 6, yPos = 0, width = 6, height = 4
          widget = {
            title = "Agent cost p99 by workspace (D31 #4)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.agent_distributions["agent.cost.usd"].name}\""
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_PERCENTILE_99"
                      crossSeriesReducer = "REDUCE_MEAN"
                      groupByFields      = ["metric.label.workspace_id"]
                    }
                  }
                }
                plotType = "HEATMAP"
              }]
            }
          }
        },
        {
          xPos = 0, yPos = 4, width = 6, height = 4
          widget = {
            title = "Model Armor blocks/min (D21/W3)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.model_armor_block_count.name}\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["metric.label.policy"]
                    }
                  }
                }
                plotType = "STACKED_AREA"
              }]
              thresholds = [{ value = var.model_armor_block_threshold_per_minute, color = "RED", direction = "ABOVE" }]
            }
          }
        },
        {
          xPos = 6, yPos = 4, width = 6, height = 4
          widget = {
            title = "Agent escalations by reason (W1)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.agent_escalation_count.name}\""
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["metric.label.reason"]
                    }
                  }
                }
                plotType = "STACKED_BAR"
              }]
            }
          }
        },
      ]
    }
  })

  depends_on = [
    google_logging_metric.agent_distributions,
    google_logging_metric.model_armor_block_count,
    google_logging_metric.agent_escalation_count,
  ]
}
