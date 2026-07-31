locals {
  cloud_sql_proxy_args = [
    "--address=0.0.0.0",
    "--auto-iam-authn",
    "--lazy-refresh",
    "--port=5432",
    "--private-ip",
    "--structured-logs",
    google_sql_database_instance.main.connection_name,
  ]

  request_runtime_services = {
    api = {
      entrypoint      = "dist/gcp/apps/api/src/index.js"
      image           = var.runtime_images.api
      ingress         = "INGRESS_TRAFFIC_ALL"
      service_account = google_service_account.runtime["api"].email
      environment = {
        CORS_ALLOWED_ORIGINS = join(",", distinct(concat(
          [
            google_firebase_hosting_site.web.default_url,
            "https://${coalesce(var.firebase_site_id, var.project_id)}.firebaseapp.com",
          ],
          [for domain in var.authorized_domains : "https://${domain}"],
        )))
        GCS_ASSETS_BUCKET            = google_storage_bucket.assets.name
        GCS_EXPORTS_BUCKET           = google_storage_bucket.exports.name
        API_SERVICE_ACCOUNT_EMAIL    = google_service_account.runtime["api"].email
        GOOGLE_SLIDES_TEMPLATE_ID    = var.google_slides_template_id
        IDENTITY_PLATFORM_API_KEY    = data.google_firebase_web_app_config.web.api_key
        IDENTITY_PLATFORM_PROJECT_ID = var.project_id
        PIPELINE_WORKFLOW_NAME       = "${var.name_prefix}-pipeline"
        PIPELINE_WORKFLOW_REGION     = var.region
        REGISTRATION_CONTINUE_URL    = "${google_firebase_hosting_site.web.default_url}/auth"
        SEER_ENVIRONMENT             = var.environment
        DATABASE_URL                 = "postgresql://${urlencode(trimsuffix(google_service_account.runtime["api"].email, ".gserviceaccount.com"))}@127.0.0.1:5432/seer"
      }
      secrets = {
        ANTHROPIC_API_KEY      = "seer-anthropic-api-key"
        GOOGLE_WORKSPACE_OAUTH = "seer-workspace-oauth"
        INTERNAL_SERVICE_TOKEN = "seer-internal-service-token"
      }
    }
    worker = {
      entrypoint      = "dist/gcp/apps/worker/src/index.js"
      image           = var.runtime_images.worker
      ingress         = "INGRESS_TRAFFIC_INTERNAL_ONLY"
      service_account = google_service_account.runtime["worker"].email
      environment = {
        SEER_ENVIRONMENT = var.environment
        DATABASE_URL     = "postgresql://${urlencode(trimsuffix(google_service_account.runtime["worker"].email, ".gserviceaccount.com"))}@127.0.0.1:5432/seer"
      }
      secrets = {
        AHREFS_API_KEY         = "seer-ahrefs-api-key"
        ANTHROPIC_API_KEY      = "seer-anthropic-api-key"
        DATAFORSEO_CREDENTIALS = "seer-dataforseo-credentials"
        INTERNAL_SERVICE_TOKEN = "seer-internal-service-token"
      }
    }
  }
}

resource "google_cloud_run_v2_service" "request_runtime" {
  for_each = var.runtime_enabled ? local.request_runtime_services : {}

  project             = var.project_id
  name                = "${var.name_prefix}-${each.key}"
  location            = var.region
  ingress             = each.value.ingress
  deletion_protection = var.deletion_protection
  labels              = local.labels

  lifecycle {
    precondition {
      condition     = var.database_schema_ready
      error_message = "database_schema_ready must be true before Cloud Run runtime services are enabled."
    }
  }

  template {
    service_account = each.value.service_account
    timeout         = "900s"

    scaling {
      min_instance_count = 0
      max_instance_count = 20
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = google_compute_network.main.name
        subnetwork = google_compute_subnetwork.runtime.name
        tags       = ["${var.name_prefix}-${each.key}"]
      }
    }

    containers {
      name       = each.key
      image      = each.value.image
      command    = ["node"]
      args       = [each.value.entrypoint]
      depends_on = ["cloud-sql-proxy"]

      ports {
        container_port = 8080
      }

      resources {
        cpu_idle = true
        limits = {
          cpu    = "2"
          memory = each.key == "worker" ? "2Gi" : "1Gi"
        }
      }

      dynamic "env" {
        for_each = each.value.environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = each.value.secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.runtime[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 1
        timeout_seconds       = 5
        period_seconds        = 5
        failure_threshold     = 24

        http_get {
          path = "/readyz"
        }
      }

      liveness_probe {
        timeout_seconds   = 5
        period_seconds    = 10
        failure_threshold = 3

        http_get {
          path = "/healthz"
        }
      }
    }

    containers {
      name  = "cloud-sql-proxy"
      image = var.cloud_sql_proxy_image
      args  = local.cloud_sql_proxy_args

      resources {
        cpu_idle = true
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }

      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 2
        period_seconds        = 2
        failure_threshold     = 30

        tcp_socket {
          port = 5432
        }
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_service_networking_connection.private_services,
    google_sql_database.application,
    google_sql_user.runtime,
  ]
}

resource "google_cloud_run_v2_service" "dispatcher" {
  count = var.runtime_enabled && var.compatibility_dispatcher_enabled ? 1 : 0

  project             = var.project_id
  name                = "${var.name_prefix}-dispatcher"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = var.deletion_protection
  labels              = local.labels

  lifecycle {
    precondition {
      condition     = var.database_schema_ready
      error_message = "database_schema_ready must be true before the compatibility dispatcher is enabled."
    }
  }

  template {
    service_account = google_service_account.runtime["dispatcher"].email
    timeout         = "900s"

    scaling {
      min_instance_count = var.runtime_min_instances.dispatcher
      max_instance_count = var.runtime_min_instances.dispatcher
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = google_compute_network.main.name
        subnetwork = google_compute_subnetwork.runtime.name
        tags       = ["${var.name_prefix}-dispatcher"]
      }
    }

    containers {
      name       = "dispatcher"
      image      = var.runtime_images.dispatcher
      command    = ["node"]
      args       = ["dist/gcp/apps/dispatcher/src/index.js"]
      depends_on = ["cloud-sql-proxy"]

      ports {
        container_port = 8080
      }

      resources {
        cpu_idle = false
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      env {
        name  = "POLL_MILLISECONDS"
        value = "250"
      }

      env {
        name  = "SEER_ENVIRONMENT"
        value = var.environment
      }

      env {
        name  = "DATABASE_URL"
        value = "postgresql://${urlencode(trimsuffix(google_service_account.runtime["dispatcher"].email, ".gserviceaccount.com"))}@127.0.0.1:5432/seer"
      }

      env {
        name  = "WORKER_AUDIENCE"
        value = google_cloud_run_v2_service.request_runtime["worker"].uri
      }

      env {
        name  = "WORKER_URL"
        value = google_cloud_run_v2_service.request_runtime["worker"].uri
      }

      env {
        name = "INTERNAL_SERVICE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.runtime["seer-internal-service-token"].secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 1
        timeout_seconds       = 5
        period_seconds        = 5
        failure_threshold     = 24

        http_get {
          path = "/readyz"
        }
      }

      liveness_probe {
        timeout_seconds   = 5
        period_seconds    = 10
        failure_threshold = 3

        http_get {
          path = "/healthz"
        }
      }
    }

    containers {
      name  = "cloud-sql-proxy"
      image = var.cloud_sql_proxy_image
      args  = local.cloud_sql_proxy_args

      resources {
        cpu_idle = false
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }

      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 2
        period_seconds        = 2
        failure_threshold     = 30

        tcp_socket {
          port = 5432
        }
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_service_networking_connection.private_services,
    google_sql_database.application,
    google_sql_user.runtime,
  ]
}

resource "google_cloud_run_v2_service" "events" {
  count = var.runtime_enabled ? 1 : 0

  project             = var.project_id
  name                = "${var.name_prefix}-events"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = var.deletion_protection
  labels              = local.labels

  lifecycle {
    precondition {
      condition     = var.database_schema_ready
      error_message = "database_schema_ready must be true before the event relay is enabled."
    }
  }

  template {
    service_account = google_service_account.runtime["events"].email
    timeout         = "900s"

    scaling {
      min_instance_count = var.runtime_min_instances.events
      max_instance_count = var.runtime_min_instances.events
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = google_compute_network.main.name
        subnetwork = google_compute_subnetwork.runtime.name
        tags       = ["${var.name_prefix}-events"]
      }
    }

    containers {
      name       = "events"
      image      = var.runtime_images.events
      command    = ["node"]
      args       = ["dist/gcp/apps/events/src/index.js"]
      depends_on = ["cloud-sql-proxy"]

      ports {
        container_port = 8080
      }

      resources {
        cpu_idle = false
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      env {
        name  = "POLL_MILLISECONDS"
        value = "250"
      }

      env {
        name  = "SEER_ENVIRONMENT"
        value = var.environment
      }

      env {
        name  = "DATABASE_URL"
        value = "postgresql://${urlencode(trimsuffix(google_service_account.runtime["events"].email, ".gserviceaccount.com"))}@127.0.0.1:5432/seer"
      }

      env {
        name  = "PUBSUB_PROJECT_ID"
        value = var.project_id
      }

      env {
        name  = "PUBSUB_TOPIC_ID"
        value = google_pubsub_topic.pipeline_events.name
      }

      startup_probe {
        initial_delay_seconds = 1
        timeout_seconds       = 5
        period_seconds        = 5
        failure_threshold     = 24

        http_get {
          path = "/readyz"
        }
      }

      liveness_probe {
        timeout_seconds   = 5
        period_seconds    = 10
        failure_threshold = 3

        http_get {
          path = "/healthz"
        }
      }
    }

    containers {
      name  = "cloud-sql-proxy"
      image = var.cloud_sql_proxy_image
      args  = local.cloud_sql_proxy_args

      resources {
        cpu_idle = false
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }

      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 2
        period_seconds        = 2
        failure_threshold     = 30

        tcp_socket {
          port = 5432
        }
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_service_networking_connection.private_services,
    google_sql_database.application,
    google_sql_user.runtime,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public_api" {
  count = var.runtime_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.request_runtime["api"].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "dispatcher_worker" {
  count = var.runtime_enabled && var.compatibility_dispatcher_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.request_runtime["worker"].name
  role     = "roles/run.invoker"
  member   = google_service_account.runtime["dispatcher"].member
}

resource "google_cloud_run_v2_service_iam_member" "workflow_worker" {
  count = var.runtime_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.request_runtime["worker"].name
  role     = "roles/run.invoker"
  member   = google_service_account.runtime["workflow"].member
}
