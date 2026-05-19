# wif.tf — Workload Identity Federation (no SA JSON keys, workspace CLAUDE.md rail)
#
# GitHub Actions presents an OIDC token; STS exchanges it for a short-lived
# Google token bound to the Cloud Build SA. Locked to one repo via
# attribute_condition AND a principalSet IAM binding (defense in depth).

resource "google_iam_workload_identity_pool" "github" {
  count = var.enable_workload_identity_federation ? 1 : 0

  project                   = var.project_id
  workload_identity_pool_id = "ss-v2-github-pool"
  display_name              = "social-seeding-v2 GitHub WIF pool"
  description               = "OIDC pool for GitHub Actions → Cloud Build SA. No JSON keys."

  depends_on = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count = var.enable_workload_identity_federation ? 1 : 0

  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions OIDC"
  description                        = "Scoped to ${var.github_owner}/${var.github_repository}."

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.ref"              = "assertion.ref"
    "attribute.workflow"         = "assertion.workflow"
  }

  attribute_condition = "assertion.repository_owner == \"${var.github_owner}\" && assertion.repository == \"${var.github_owner}/${var.github_repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "wif_impersonates_cloud_build" {
  count = var.enable_workload_identity_federation ? 1 : 0

  service_account_id = google_service_account.cloud_build.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository/${var.github_owner}/${var.github_repository}"
}
