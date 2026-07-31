locals {
  labels = merge(
    {
      application = "seer"
      environment = var.environment
      managed-by  = "opentofu"
    },
    var.labels,
  )

  services = toset([
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "cloudtasks.googleapis.com",
    "compute.googleapis.com",
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "identitytoolkit.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
    "workflowexecutions.googleapis.com",
    "workflows.googleapis.com",
  ])

  service_accounts = {
    api        = "Authenticated application API"
    build      = "Build and release automation"
    dispatcher = "Durable pipeline dispatcher"
    events     = "Transactional outbox relay"
    migrator   = "Database schema and migration operator"
    scheduler  = "Managed maintenance scheduler"
    worker     = "Private pipeline worker"
    workflow   = "Managed pipeline workflow"
  }

  project_roles = {
    api = toset([
      "roles/cloudsql.client",
      "roles/cloudsql.instanceUser",
      "roles/cloudtasks.enqueuer",
      "roles/identitytoolkit.admin",
      "roles/logging.logWriter",
      "roles/secretmanager.secretAccessor",
      "roles/workflows.invoker",
    ])
    build = toset([
      "roles/artifactregistry.writer",
      "roles/firebasehosting.admin",
      "roles/logging.logWriter",
      "roles/serviceusage.serviceUsageConsumer",
    ])
    dispatcher = toset([
      "roles/cloudsql.client",
      "roles/cloudsql.instanceUser",
      "roles/logging.logWriter",
      "roles/secretmanager.secretAccessor",
    ])
    events = toset([
      "roles/cloudsql.client",
      "roles/cloudsql.instanceUser",
      "roles/logging.logWriter",
      "roles/pubsub.publisher",
      "roles/secretmanager.secretAccessor",
    ])
    migrator = toset([
      "roles/cloudsql.client",
      "roles/cloudsql.instanceUser",
      "roles/logging.logWriter",
    ])
    scheduler = toset([
      "roles/workflows.invoker",
    ])
    worker = toset([
      "roles/cloudsql.client",
      "roles/cloudsql.instanceUser",
      "roles/logging.logWriter",
      "roles/secretmanager.secretAccessor",
    ])
    workflow = toset([
      "roles/cloudtasks.enqueuer",
      "roles/logging.logWriter",
      "roles/secretmanager.secretAccessor",
    ])
  }

  project_role_bindings = merge([
    for account, roles in local.project_roles : {
      for role in roles :
      "${account}:${role}" => {
        account = account
        role    = role
      }
    }
  ]...)

  secret_names = toset([
    "seer-ahrefs-api-key",
    "seer-anthropic-api-key",
    "seer-dataforseo-credentials",
    "seer-internal-service-token",
    "seer-workspace-oauth",
  ])

  database_runtime_accounts = toset([
    "api",
    "dispatcher",
    "events",
    "worker",
  ])
}

data "google_project" "current" {
  project_id = var.project_id
}

resource "google_project_service" "services" {
  for_each = local.services

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_project_iam_member" "cloud_build_connection_secret_admin" {
  project = var.project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-cloudbuild.iam.gserviceaccount.com"

  depends_on = [google_project_service.services]
}

resource "google_compute_network" "main" {
  project                 = var.project_id
  name                    = "${var.name_prefix}-${var.environment}"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"

  depends_on = [google_project_service.services]
}

resource "google_compute_subnetwork" "runtime" {
  project                  = var.project_id
  name                     = "${var.name_prefix}-${var.environment}-runtime"
  region                   = var.region
  network                  = google_compute_network.main.id
  ip_cidr_range            = var.network_cidr
  private_ip_google_access = true

  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_global_address" "private_services" {
  project       = var.project_id
  name          = "${var.name_prefix}-${var.environment}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.private_service_prefix_length
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

resource "google_artifact_registry_repository" "runtime" {
  project       = var.project_id
  location      = var.region
  repository_id = "${var.name_prefix}-runtime"
  description   = "Immutable SEER runtime images"
  format        = "DOCKER"
  labels        = local.labels

  depends_on = [google_project_service.services]
}

resource "google_service_account" "runtime" {
  for_each = local.service_accounts

  project      = var.project_id
  account_id   = "${var.name_prefix}-${each.key}"
  display_name = each.value

  depends_on = [google_project_service.services]
}

resource "google_project_iam_member" "runtime" {
  for_each = local.project_role_bindings

  project = var.project_id
  role    = each.value.role
  member  = google_service_account.runtime[each.value.account].member
}

resource "google_secret_manager_secret" "runtime" {
  for_each = local.secret_names

  project   = var.project_id
  secret_id = each.value
  labels    = local.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

resource "google_sql_database_instance" "main" {
  project             = var.project_id
  name                = "${var.name_prefix}-${var.environment}-postgres"
  region              = var.region
  database_version    = "POSTGRES_17"
  deletion_protection = var.deletion_protection

  settings {
    tier              = var.database_tier
    edition           = "ENTERPRISE"
    availability_type = var.database_availability_type
    disk_type         = "PD_SSD"
    disk_size         = var.database_disk_size_gb
    disk_autoresize   = true
    user_labels       = local.labels

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "02:00"
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    insights_config {
      query_insights_enabled  = true
      query_plans_per_minute  = 5
      query_string_length     = 4500
      record_application_tags = true
    }

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.main.id
      enable_private_path_for_google_cloud_services = true
    }

    maintenance_window {
      day          = 7
      hour         = 3
      update_track = "stable"
    }
  }

  depends_on = [
    google_project_service.services,
    google_service_networking_connection.private_services,
  ]
}

resource "google_sql_database" "application" {
  project  = var.project_id
  name     = "seer"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "runtime" {
  for_each = local.database_runtime_accounts

  project         = var.project_id
  instance        = google_sql_database_instance.main.name
  name            = trimsuffix(google_service_account.runtime[each.key].email, ".gserviceaccount.com")
  type            = "CLOUD_IAM_SERVICE_ACCOUNT"
  deletion_policy = "ABANDON"
}

resource "google_sql_user" "migrator" {
  project         = var.project_id
  instance        = google_sql_database_instance.main.name
  name            = trimsuffix(google_service_account.runtime["migrator"].email, ".gserviceaccount.com")
  type            = "CLOUD_IAM_SERVICE_ACCOUNT"
  database_roles  = ["cloudsqlsuperuser"]
  deletion_policy = "ABANDON"
}

resource "google_storage_bucket" "assets" {
  project                     = var.project_id
  name                        = "${var.project_id}-${var.name_prefix}-assets"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels

  versioning {
    enabled = true
  }
}

resource "google_storage_bucket" "exports" {
  project                     = var.project_id
  name                        = "${var.project_id}-${var.name_prefix}-exports"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels

  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket" "releases" {
  project                     = var.project_id
  name                        = "${var.project_id}-${var.name_prefix}-releases"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      age = 180
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.services]
}

resource "google_storage_bucket" "build_source" {
  project                     = var.project_id
  name                        = "${var.project_id}-${var.name_prefix}-build-source"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels

  lifecycle_rule {
    condition {
      age = 7
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.services]
}

resource "google_storage_bucket_iam_member" "api_assets" {
  bucket = google_storage_bucket.assets.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.runtime["api"].member
}

resource "google_storage_bucket_iam_member" "worker_assets" {
  bucket = google_storage_bucket.assets.name
  role   = "roles/storage.objectViewer"
  member = google_service_account.runtime["worker"].member
}

resource "google_storage_bucket_iam_member" "worker_exports" {
  bucket = google_storage_bucket.exports.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.runtime["worker"].member
}

resource "google_storage_bucket_iam_member" "api_exports" {
  bucket = google_storage_bucket.exports.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.runtime["api"].member
}

resource "google_service_account_iam_member" "api_self_token_creator" {
  service_account_id = google_service_account.runtime["api"].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = google_service_account.runtime["api"].member
}

resource "google_storage_bucket_iam_member" "build_releases" {
  bucket = google_storage_bucket.releases.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.runtime["build"].member
}

resource "google_storage_bucket_iam_member" "build_source" {
  bucket = google_storage_bucket.build_source.name
  role   = "roles/storage.objectViewer"
  member = google_service_account.runtime["build"].member
}

resource "google_cloud_tasks_queue" "provider" {
  for_each = var.task_queues

  project  = var.project_id
  location = var.region
  name     = "${var.name_prefix}-${each.key}"

  rate_limits {
    max_concurrent_dispatches = each.value.max_concurrent_dispatches
    max_dispatches_per_second = each.value.max_dispatches_per_second
  }

  retry_config {
    max_attempts       = 5
    max_retry_duration = "3600s"
    min_backoff        = "1s"
    max_backoff        = "300s"
    max_doublings      = 5
  }

  stackdriver_logging_config {
    sampling_ratio = 1
  }

  depends_on = [google_project_service.services]
}

resource "google_pubsub_topic" "pipeline_events" {
  project = var.project_id
  name    = "${var.name_prefix}-pipeline-events"
  labels  = local.labels

  message_retention_duration = "604800s"

  depends_on = [google_project_service.services]
}

resource "google_workflows_workflow" "pipeline" {
  count = var.runtime_enabled ? 1 : 0

  project             = var.project_id
  name                = "${var.name_prefix}-pipeline"
  region              = var.region
  description         = "Durable 19-stage SEER calculation pipeline"
  service_account     = google_service_account.runtime["workflow"].id
  deletion_protection = var.deletion_protection
  labels              = local.labels
  source_contents = templatefile(
    "${path.module}/../workflows/pipeline.yaml.tftpl",
    {
      internal_secret_id = google_secret_manager_secret.runtime["seer-internal-service-token"].secret_id
      project_id         = var.project_id
      worker_url         = google_cloud_run_v2_service.request_runtime["worker"].uri
    },
  )

  depends_on = [google_project_service.services]
}

resource "google_workflows_workflow" "maintenance" {
  count = var.runtime_enabled ? 1 : 0

  project             = var.project_id
  name                = "${var.name_prefix}-maintenance"
  region              = var.region
  description         = "Scheduled SEER maintenance operations"
  service_account     = google_service_account.runtime["workflow"].id
  deletion_protection = var.deletion_protection
  labels              = local.labels
  source_contents = templatefile(
    "${path.module}/../workflows/maintenance.yaml.tftpl",
    {
      api_url            = google_cloud_run_v2_service.request_runtime["api"].uri
      internal_secret_id = google_secret_manager_secret.runtime["seer-internal-service-token"].secret_id
      project_id         = var.project_id
    },
  )

  depends_on = [google_project_service.services]
}

locals {
  maintenance_schedules = {
    url-monitor-tick = {
      operation = "tick"
      schedule  = "*/5 * * * *"
    }
    url-monitor-prune = {
      operation = "prune"
      schedule  = "15 3 * * *"
    }
  }
}

resource "google_cloud_scheduler_job" "maintenance" {
  for_each = var.runtime_enabled ? local.maintenance_schedules : {}

  project          = var.project_id
  region           = var.region
  name             = "${var.name_prefix}-${each.key}"
  description      = "Run ${each.value.operation} URL monitor maintenance"
  schedule         = each.value.schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "900s"

  retry_config {
    retry_count          = 3
    min_backoff_duration = "5s"
    max_backoff_duration = "300s"
    max_doublings        = 4
  }

  http_target {
    http_method = "POST"
    uri = format(
      "https://workflowexecutions.googleapis.com/v1/projects/%s/locations/%s/workflows/%s/executions",
      var.project_id,
      var.region,
      google_workflows_workflow.maintenance[0].name,
    )
    body = base64encode(jsonencode({
      argument = jsonencode({ operation = each.value.operation })
    }))
    headers = {
      "Content-Type" = "application/json"
    }

    oauth_token {
      service_account_email = google_service_account.runtime["scheduler"].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [
    google_project_service.services,
    google_workflows_workflow.maintenance,
  ]
}

resource "google_firebase_project" "main" {
  provider = google-beta
  project  = var.project_id

  depends_on = [google_project_service.services]
}

resource "google_firebase_web_app" "web" {
  provider     = google-beta
  project      = var.project_id
  display_name = "SEER ${title(var.environment)}"

  depends_on = [google_firebase_project.main]
}

data "google_firebase_web_app_config" "web" {
  provider   = google-beta
  project    = var.project_id
  web_app_id = google_firebase_web_app.web.app_id
}

resource "google_firebase_hosting_site" "web" {
  provider = google-beta
  project  = var.project_id
  site_id  = coalesce(var.firebase_site_id, var.project_id)
  app_id   = google_firebase_web_app.web.app_id

  deletion_policy = var.deletion_protection ? "ABANDON" : "DELETE"
}

resource "google_identity_platform_config" "main" {
  provider = google-beta
  project  = var.project_id

  authorized_domains = distinct(
    concat(
      var.authorized_domains,
      [
        data.google_firebase_web_app_config.web.auth_domain,
        "${coalesce(var.firebase_site_id, var.project_id)}.web.app",
        "${coalesce(var.firebase_site_id, var.project_id)}.firebaseapp.com",
      ],
    ),
  )

  sign_in {
    email {
      enabled           = true
      password_required = true
    }

    phone_number {
      enabled = false
    }
  }

  depends_on = [google_project_service.services]
}
