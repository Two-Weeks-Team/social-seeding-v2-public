# outputs.tf — devops module exports
#
# Outputs are grouped so sibling modules (compute, observability) can consume
# the bits they need without reaching into this module's resources directly.

# ---------------------------------------------------------------------------
# Service accounts (compute / observability consume these for IAM bindings)
# ---------------------------------------------------------------------------

output "cloud_build_service_account_email" {
  description = "Email of the Cloud Build runner SA. Used by compute module to grant log-ingest + secret-access roles."
  value       = google_service_account.cloud_build.email
}

output "cloud_deploy_service_account_email" {
  description = "Email of the Cloud Deploy executor SA. Used by compute module to grant Cloud Run deployer + Agent Runtime admin roles."
  value       = google_service_account.cloud_deploy.email
}

output "workstations_service_account_email" {
  description = "Email of the Workstations runtime SA. Used by data / ai modules to grant Spanner / Firestore / Vertex access."
  value       = google_service_account.workstations.email
}

# ---------------------------------------------------------------------------
# Artifact Registry — image-URI helpers for sibling modules
# ---------------------------------------------------------------------------

output "artifact_registry_repos" {
  description = "Map of artifact repository keys (`<region>-<format>`) → fully-qualified repository name. Compute module uses this to construct image URIs."
  value = {
    for k, repo in google_artifact_registry_repository.this :
    k => {
      name     = repo.name
      location = repo.location
      format   = repo.format
      url      = "${repo.location}-${lower(repo.format) == "docker" ? "docker" : lower(repo.format)}.pkg.dev/${var.project_id}/${repo.name}"
    }
  }
}

output "artifact_registry_docker_repo_url_primary" {
  description = "Convenience: Docker repository URL in the primary region. Empty string when DOCKER is not in var.artifact_repo_formats."
  value = contains(var.artifact_repo_formats, "DOCKER") ? (
    "${var.primary_region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.this["${var.primary_region}-docker"].name}"
  ) : ""
}

# ---------------------------------------------------------------------------
# Cloud Build
# ---------------------------------------------------------------------------

output "cloud_build_worker_pool_id" {
  description = "Fully-qualified ID of the Cloud Build private pool. Reference from any cloudbuild.yaml via `options.pool.name`."
  value       = google_cloudbuild_worker_pool.ci.id
}

output "cloud_build_per_pr_trigger_id" {
  description = "Trigger ID for the per-PR pipeline (MATRIX §7.1)."
  value       = google_cloudbuild_trigger.per_pr.trigger_id
}

output "cloud_build_nightly_trigger_id" {
  description = "Trigger ID for the nightly pipeline (MATRIX §7.2)."
  value       = google_cloudbuild_trigger.nightly.trigger_id
}

output "cloud_build_nightly_webhook_secret_name" {
  description = "Secret Manager resource name holding the nightly trigger webhook secret. Cloud Scheduler reads this to authenticate the trigger fire."
  value       = google_secret_manager_secret.nightly_webhook.name
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Cloud Deploy
# ---------------------------------------------------------------------------

output "cloud_deploy_pipeline_name" {
  description = "Name of the canary delivery pipeline."
  value       = google_clouddeploy_delivery_pipeline.agent.name
}

output "cloud_deploy_target_names" {
  description = "Map of region → Cloud Deploy target name. Compute module uses this when wiring per-region Cloud Run services."
  value       = { for r, t in google_clouddeploy_target.regional : r => t.name }
}

# ---------------------------------------------------------------------------
# Cloud Workstations
# ---------------------------------------------------------------------------

output "workstations_cluster_id" {
  description = "ID of the Cloud Workstations cluster. Engineers attach with `gcloud workstations start --cluster=<this>`."
  value       = google_workstations_workstation_cluster.this.workstation_cluster_id
}

output "workstations_engineer_config_id" {
  description = "Config ID for the human-engineer workstation template."
  value       = google_workstations_workstation_config.engineer.workstation_config_id
}

output "workstations_agent_worker_config_id" {
  description = "Config ID for the Tier-3 agent-worker workstation template (D38)."
  value       = google_workstations_workstation_config.agent_worker.workstation_config_id
}

# ---------------------------------------------------------------------------
# Binary Authorization
# ---------------------------------------------------------------------------

output "binary_authorization_attestor_id" {
  description = "Fully-qualified attestor resource name. Cloud Build inline attestation step references this."
  value       = google_binary_authorization_attestor.build.name
}

output "binary_authorization_kms_key_id" {
  description = "KMS crypto-key resource name used to sign attestations. Required when running `gcloud beta container binauthz attestations sign-and-create`."
  value       = google_kms_crypto_key.attestor.id
}

# ---------------------------------------------------------------------------
# Workload Identity Federation
# ---------------------------------------------------------------------------

output "workload_identity_provider" {
  description = "Fully-qualified WIF provider name to plug into github.com/google-github-actions/auth `workload_identity_provider`. Empty string when WIF disabled."
  value       = var.enable_workload_identity_federation ? google_iam_workload_identity_pool_provider.github[0].name : ""
}

output "workload_identity_pool_name" {
  description = "Resource name of the WIF pool (informational — used in IAM bindings + audit logs)."
  value       = var.enable_workload_identity_federation ? google_iam_workload_identity_pool.github[0].name : ""
}
