output "artifact_registry_repository" {
  value = google_artifact_registry_repository.runtime.name
}

output "assets_bucket" {
  value = google_storage_bucket.assets.name
}

output "cloud_sql_connection_name" {
  value = google_sql_database_instance.main.connection_name
}

output "cloud_sql_private_ip" {
  value     = google_sql_database_instance.main.private_ip_address
  sensitive = true
}

output "cloud_sql_iam_database_users" {
  value = merge(
    {
      for name, user in google_sql_user.runtime :
      name => user.name
    },
    {
      migrator = google_sql_user.migrator.name
    },
  )
}

output "database_migration_job" {
  value = var.database_migration_job_enabled ? google_cloud_run_v2_job.database_migration[0].id : null
}

output "exports_bucket" {
  value = google_storage_bucket.exports.name
}

output "release_metadata_bucket" {
  value = google_storage_bucket.releases.name
}

output "firebase_hosting_url" {
  value = google_firebase_hosting_site.web.default_url
}

output "firebase_web_config" {
  value = {
    api_key     = data.google_firebase_web_app_config.web.api_key
    app_id      = google_firebase_web_app.web.app_id
    auth_domain = data.google_firebase_web_app_config.web.auth_domain
    project_id  = var.project_id
  }
}

output "runtime_service_urls" {
  value = var.runtime_enabled ? {
    api        = google_cloud_run_v2_service.request_runtime["api"].uri
    dispatcher = var.compatibility_dispatcher_enabled ? google_cloud_run_v2_service.dispatcher[0].uri : null
    events     = google_cloud_run_v2_service.events[0].uri
    worker     = google_cloud_run_v2_service.request_runtime["worker"].uri
  } : null
}

output "pipeline_workflow" {
  value = var.runtime_enabled ? google_workflows_workflow.pipeline[0].id : null
}

output "maintenance_schedules" {
  value = var.runtime_enabled ? {
    for name, schedule in google_cloud_scheduler_job.maintenance :
    name => schedule.id
  } : {}
}

output "maintenance_workflow" {
  value = var.runtime_enabled ? google_workflows_workflow.maintenance[0].id : null
}

output "service_accounts" {
  value = {
    for name, account in google_service_account.runtime :
    name => account.email
  }
}

output "task_queues" {
  value = {
    for name, queue in google_cloud_tasks_queue.provider :
    name => queue.id
  }
}
