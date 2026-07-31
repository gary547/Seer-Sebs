resource "google_cloud_run_v2_job" "database_migration" {
  count = var.database_migration_job_enabled ? 1 : 0

  project             = var.project_id
  name                = "${var.name_prefix}-database-migration"
  location            = var.region
  deletion_protection = var.deletion_protection
  labels              = local.labels

  template {
    parallelism = 1
    task_count  = 1

    template {
      service_account = google_service_account.runtime["migrator"].email
      timeout         = "1800s"
      max_retries     = 0

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"

        network_interfaces {
          network    = google_compute_network.main.name
          subnetwork = google_compute_subnetwork.runtime.name
          tags       = ["${var.name_prefix}-database-migration"]
        }
      }

      containers {
        name  = "database-migration"
        image = var.database_migration_image

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "CLOUD_SQL_CONNECTION_NAME"
          value = google_sql_database_instance.main.connection_name
        }

        env {
          name  = "DATABASE_NAME"
          value = google_sql_database.application.name
        }

        env {
          name  = "MIGRATOR_DATABASE_USER"
          value = google_sql_user.migrator.name
        }

        env {
          name  = "API_DATABASE_USER"
          value = google_sql_user.runtime["api"].name
        }

        env {
          name  = "WORKER_DATABASE_USER"
          value = google_sql_user.runtime["worker"].name
        }

        env {
          name  = "DISPATCHER_DATABASE_USER"
          value = google_sql_user.runtime["dispatcher"].name
        }

        env {
          name  = "EVENTS_DATABASE_USER"
          value = google_sql_user.runtime["events"].name
        }
      }
    }
  }

  depends_on = [
    google_project_iam_member.runtime,
    google_service_networking_connection.private_services,
    google_sql_database.application,
    google_sql_user.migrator,
    google_sql_user.runtime,
  ]
}
