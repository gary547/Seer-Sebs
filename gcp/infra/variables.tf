variable "project_id" {
  description = "Existing isolated Google Cloud project ID."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid Google Cloud project ID."
  }
}

variable "environment" {
  description = "Deployment environment."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  description = "Primary region for regional services."
  type        = string
  default     = "europe-west2"
}

variable "name_prefix" {
  description = "Resource name prefix."
  type        = string
  default     = "seer"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must be a lowercase resource-name prefix."
  }
}

variable "labels" {
  description = "Additional labels applied to supported resources."
  type        = map(string)
  default     = {}
}

variable "deletion_protection" {
  description = "Protect stateful resources and Cloud Run services from deletion."
  type        = bool
  default     = true
}

variable "network_cidr" {
  description = "Direct VPC egress subnet CIDR."
  type        = string
  default     = "10.80.0.0/24"
}

variable "private_service_prefix_length" {
  description = "Prefix length reserved for private service access."
  type        = number
  default     = 16

  validation {
    condition     = var.private_service_prefix_length >= 16 && var.private_service_prefix_length <= 24
    error_message = "private_service_prefix_length must be between 16 and 24."
  }
}

variable "database_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-2-7680"
}

variable "database_disk_size_gb" {
  description = "Initial Cloud SQL SSD size."
  type        = number
  default     = 100

  validation {
    condition     = var.database_disk_size_gb >= 20
    error_message = "database_disk_size_gb must be at least 20."
  }
}

variable "database_availability_type" {
  description = "Cloud SQL availability type."
  type        = string
  default     = "REGIONAL"

  validation {
    condition     = contains(["REGIONAL", "ZONAL"], var.database_availability_type)
    error_message = "database_availability_type must be REGIONAL or ZONAL."
  }
}

variable "authorized_domains" {
  description = "Identity Platform authorized domains."
  type        = list(string)
  default     = []
}

variable "firebase_site_id" {
  description = "Globally unique Firebase Hosting site ID. Defaults to project_id."
  type        = string
  default     = null
  nullable    = true
}

variable "google_slides_template_id" {
  description = "Google Slides template copied for performance exports."
  type        = string
  default     = "1JTTA65ikwfYFahIfDhVUSNHi3wjovG4CiymrDWJjuec"

  validation {
    condition     = length(trimspace(var.google_slides_template_id)) > 10
    error_message = "google_slides_template_id must be a valid Drive file ID."
  }
}

variable "runtime_enabled" {
  description = "Deploy Cloud Run revisions after images and secret versions exist."
  type        = bool
  default     = false
}

variable "compatibility_dispatcher_enabled" {
  description = "Keep the local leased-queue dispatcher during a controlled compatibility rehearsal."
  type        = bool
  default     = false
}

variable "cloud_sql_proxy_image" {
  description = "Immutable official Cloud SQL Auth Proxy v2 image."
  type        = string
  default     = "gcr.io/cloud-sql-connectors/cloud-sql-proxy@sha256:54e23cad9aeeedbf88ab75f993146631b878035f702b31c51885a932e0c7286c"

  validation {
    condition     = can(regex("^gcr\\.io/cloud-sql-connectors/cloud-sql-proxy@sha256:[0-9a-f]{64}$", var.cloud_sql_proxy_image))
    error_message = "cloud_sql_proxy_image must be the official image pinned to an immutable sha256 digest."
  }
}

variable "database_migration_job_enabled" {
  description = "Create the explicitly executed Cloud Run database migration job."
  type        = bool
  default     = false
}

variable "database_migration_image" {
  description = "Immutable database migration image reference."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.database_migration_job_enabled ||
      can(regex("@sha256:[0-9a-f]{64}$", var.database_migration_image))
    )
    error_message = "database_migration_image must use an immutable sha256 digest when the migration job is enabled."
  }
}

variable "database_transfer_job_enabled" {
  description = "Create the explicitly executed archive and canonical source database transfer jobs."
  type        = bool
  default     = false
}

variable "database_transfer_image" {
  description = "Immutable managed database transfer image reference."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.database_transfer_job_enabled ||
      can(regex("@sha256:[0-9a-f]{64}$", var.database_transfer_image))
    )
    error_message = "database_transfer_image must use an immutable sha256 digest when database transfer jobs are enabled."
  }
}

variable "database_transfer_plan_sha256s" {
  description = "Approved archive and canonical transfer-plan checksums."
  type = object({
    archive   = string
    canonical = string
  })
  default = {
    archive   = ""
    canonical = ""
  }

  validation {
    condition = (
      !var.database_transfer_job_enabled ||
      alltrue([
        for checksum in values(var.database_transfer_plan_sha256s) :
        can(regex("^[0-9a-f]{64}$", checksum))
      ])
    )
    error_message = "database_transfer_plan_sha256s must contain approved SHA-256 checksums when database transfer jobs are enabled."
  }
}

variable "database_schema_ready" {
  description = "Explicit evidence gate confirming schema migration and IAM database role binding succeeded."
  type        = bool
  default     = false
}

variable "runtime_images" {
  description = "Immutable container image references for target services."
  type = object({
    api        = string
    dispatcher = string
    events     = string
    worker     = string
  })
  default = {
    api        = ""
    dispatcher = ""
    events     = ""
    worker     = ""
  }

  validation {
    condition = !var.runtime_enabled || (
      alltrue([
        for image in [
          var.runtime_images.api,
          var.runtime_images.events,
          var.runtime_images.worker,
        ] :
        can(regex("@sha256:[0-9a-f]{64}$", image))
      ]) &&
      (
        !var.compatibility_dispatcher_enabled ||
        can(regex("@sha256:[0-9a-f]{64}$", var.runtime_images.dispatcher))
      )
    )
    error_message = "runtime_images must use immutable sha256 image digests when runtime_enabled is true."
  }
}

variable "runtime_min_instances" {
  description = "Minimum instance counts for long-running compatibility services."
  type = object({
    dispatcher = number
    events     = number
  })
  default = {
    dispatcher = 1
    events     = 1
  }
}

variable "monitoring_enabled" {
  description = "Create the operational dashboard, log metric and baseline alert policies."
  type        = bool
  default     = true
}

variable "alert_notification_channel_ids" {
  description = "Existing Cloud Monitoring notification-channel resource IDs."
  type        = list(string)
  default     = []
}

variable "task_queues" {
  description = "Provider-specific queue limits."
  type = map(object({
    max_concurrent_dispatches = number
    max_dispatches_per_second = number
  }))
  default = {
    pipeline = {
      max_concurrent_dispatches = 20
      max_dispatches_per_second = 20
    }
    dataforseo = {
      max_concurrent_dispatches = 5
      max_dispatches_per_second = 5
    }
    ahrefs = {
      max_concurrent_dispatches = 3
      max_dispatches_per_second = 3
    }
    vertex = {
      max_concurrent_dispatches = 5
      max_dispatches_per_second = 5
    }
  }
}
