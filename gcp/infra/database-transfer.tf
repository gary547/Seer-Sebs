locals {
  database_transfer_jobs = {
    archive = {
      checkpoint_object = "database/archive-checkpoint.json"
      lock_object       = "database/archive.lock"
      plan_object       = "database/archive-plan.json"
    }
    canonical = {
      checkpoint_object = "database/canonical-checkpoint.json"
      lock_object       = "database/canonical.lock"
      plan_object       = "database/canonical-plan.json"
    }
  }
}

resource "google_cloud_run_v2_job" "database_transfer" {
  for_each = var.database_transfer_job_enabled ? local.database_transfer_jobs : {}

  project             = var.project_id
  name                = "${var.name_prefix}-database-${each.key}-transfer"
  location            = var.region
  deletion_protection = var.deletion_protection
  labels              = local.labels

  lifecycle {
    precondition {
      condition     = var.database_schema_ready
      error_message = "database_schema_ready must be true before database transfer jobs are enabled."
    }
  }

  template {
    parallelism = 1
    task_count  = 1

    template {
      service_account = google_service_account.runtime["migrator"].email
      timeout         = "3600s"
      max_retries     = 0

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"

        network_interfaces {
          network    = google_compute_network.main.name
          subnetwork = google_compute_subnetwork.runtime.name
          tags       = ["${var.name_prefix}-database-${each.key}-transfer"]
        }
      }

      containers {
        name  = "database-${each.key}-transfer"
        image = var.database_transfer_image

        resources {
          limits = {
            cpu    = "2"
            memory = "1Gi"
          }
        }

        env {
          name  = "CLOUD_SQL_CONNECTION_NAME"
          value = google_sql_database_instance.main.connection_name
        }

        env {
          name  = "SEER_DATABASE_TRANSFER_CHECKPOINT_OBJECT"
          value = each.value.checkpoint_object
        }

        env {
          name  = "SEER_DATABASE_TRANSFER_LOCK_OBJECT"
          value = each.value.lock_object
        }

        env {
          name  = "SEER_DATABASE_TRANSFER_PLAN_OBJECT"
          value = each.value.plan_object
        }

        env {
          name  = "SEER_DATABASE_TRANSFER_PLAN_SHA256"
          value = var.database_transfer_plan_sha256s[each.key]
        }

        env {
          name  = "SEER_MIGRATION_EVIDENCE_BUCKET"
          value = google_storage_bucket.migration_evidence.name
        }

        env {
          name  = "SEER_TARGET_DATABASE_URL"
          value = "postgresql://${urlencode(google_sql_user.migrator.name)}@127.0.0.1:5432/${google_sql_database.application.name}"
        }

        env {
          name  = "SEER_SOURCE_DATABASE_URL"
          value = "postgresql://${urlencode(google_sql_user.migrator.name)}@127.0.0.1:5432/${var.database_transfer_source_database}"
        }
      }
    }
  }

  depends_on = [
    google_project_iam_member.runtime,
    google_service_networking_connection.private_services,
    google_sql_database.application,
    google_sql_user.migrator,
    google_storage_bucket_iam_member.migrator_evidence,
  ]
}
