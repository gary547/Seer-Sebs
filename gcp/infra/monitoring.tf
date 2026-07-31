resource "google_logging_metric" "runtime_errors" {
  count = var.monitoring_enabled ? 1 : 0

  project = var.project_id
  name    = "${var.name_prefix}_${var.environment}_runtime_errors"
  filter = join(" ", [
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=~\"${var.name_prefix}-(api|worker|events|dispatcher)\"",
    "severity>=ERROR",
  ])

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.services]
}

resource "google_monitoring_alert_policy" "runtime_errors" {
  count = var.monitoring_enabled ? 1 : 0

  project               = var.project_id
  display_name          = "SEER ${var.environment}: runtime errors"
  combiner              = "OR"
  notification_channels = var.alert_notification_channel_ids

  conditions {
    display_name = "Cloud Run error log rate"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"logging.googleapis.com/user/${google_logging_metric.runtime_errors[0].name}\"",
        "resource.type=\"cloud_run_revision\"",
      ])
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      threshold_value = 0

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "Inspect the affected Cloud Run revision, pipeline run ID and stage ID before retrying or rolling back."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "cloud_sql_cpu" {
  count = var.monitoring_enabled ? 1 : 0

  project               = var.project_id
  display_name          = "SEER ${var.environment}: Cloud SQL CPU saturation"
  combiner              = "OR"
  notification_channels = var.alert_notification_channel_ids

  conditions {
    display_name = "Cloud SQL CPU above 80 percent"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\"",
        "resource.type=\"cloudsql_database\"",
        "resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.main.name}\"",
      ])
      comparison      = "COMPARISON_GT"
      duration        = "300s"
      threshold_value = 0.8

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "Inspect Query Insights, connection pressure and the current pipeline workload before scaling the instance."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "task_queue_depth" {
  count = var.monitoring_enabled ? 1 : 0

  project               = var.project_id
  display_name          = "SEER ${var.environment}: task queue backlog"
  combiner              = "OR"
  notification_channels = var.alert_notification_channel_ids

  conditions {
    display_name = "A provider queue remains above 1000 tasks"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"cloudtasks.googleapis.com/queue/depth\"",
        "resource.type=\"cloud_tasks_queue\"",
      ])
      comparison      = "COMPARISON_GT"
      duration        = "900s"
      threshold_value = 1000

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "Check provider rate limits, oldest task age and worker errors. Do not raise concurrency until the upstream quota is confirmed."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_dashboard" "operations" {
  count = var.monitoring_enabled ? 1 : 0

  project = var.project_id
  dashboard_json = jsonencode({
    displayName = "SEER ${var.environment} operations"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          height = 4
          width  = 6
          widget = {
            title = "Cloud Run requests by response class"
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["metric.label.response_code_class", "resource.label.service_name"]
                    }
                    filter = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\""
                  }
                }
              }]
              yAxis = {
                label = "requests/s"
                scale = "LINEAR"
              }
            }
          }
        },
        {
          height = 4
          width  = 6
          xPos   = 6
          widget = {
            title = "Cloud SQL CPU utilization"
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_MEAN"
                    }
                    filter = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND resource.type=\"cloudsql_database\""
                  }
                }
              }]
              yAxis = {
                label = "ratio"
                scale = "LINEAR"
              }
            }
          }
        },
        {
          height = 4
          width  = 6
          yPos   = 4
          widget = {
            title = "Cloud Tasks queue depth"
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_MAX"
                    }
                    filter = "metric.type=\"cloudtasks.googleapis.com/queue/depth\" AND resource.type=\"cloud_tasks_queue\""
                  }
                }
              }]
              yAxis = {
                label = "tasks"
                scale = "LINEAR"
              }
            }
          }
        },
        {
          height = 4
          width  = 6
          xPos   = 6
          yPos   = 4
          widget = {
            title = "Runtime errors"
            xyChart = {
              dataSets = [{
                plotType = "STACKED_BAR"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.label.service_name"]
                    }
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.runtime_errors[0].name}\" AND resource.type=\"cloud_run_revision\""
                  }
                }
              }]
              yAxis = {
                label = "errors/s"
                scale = "LINEAR"
              }
            }
          }
        },
      ]
    }
  })
}
