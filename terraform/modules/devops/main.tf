# main.tf — locals, API enablement, service accounts
#
# Files in this module:
#   artifact_registry.tf — 3 formats × N regions repos (D37)
#   cloud_build.tf       — private pool + per-PR (8-stage) + nightly triggers (D37)
#   cloud_deploy.tf      — canary delivery pipeline + per-region targets (D37)
#   workstations.tf      — cluster + engineer + agent-worker configs (D38)
#   binary_auth.tf       — SLSA L3 attestor + REQUIRE_ATTESTATION policy (D37)
#   wif.tf               — Workload Identity Federation for GitHub (no SA keys)

locals {
  common_labels = merge(
    var.labels,
    { module = "devops", managed_by = "terraform" },
  )

  primary_region_valid = contains(var.regions, var.primary_region)

  # (region × format) cartesian product → keyed map for Artifact Registry.
  artifact_repo_combinations = {
    for pair in setproduct(var.regions, var.artifact_repo_formats) :
    "${pair[0]}-${lower(pair[1])}" => { region = pair[0], format = pair[1] }
  }

  # APIs the module enables. Each maps to a D-ID — see README for the table.
  required_apis = [
    "cloudbuild.googleapis.com",
    "clouddeploy.googleapis.com",
    "artifactregistry.googleapis.com",
    "containeranalysis.googleapis.com",
    "binaryauthorization.googleapis.com",
    "workstations.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudaicompanion.googleapis.com",
    "pubsub.googleapis.com",
    "cloudscheduler.googleapis.com",
    "secretmanager.googleapis.com",
  ]
}

# Fail at plan time if primary_region is not in regions — much cheaper than
# discovering halfway through apply.
resource "terraform_data" "primary_region_check" {
  input = local.primary_region_valid

  lifecycle {
    precondition {
      condition     = local.primary_region_valid
      error_message = "primary_region (${var.primary_region}) must be in regions (${join(",", var.regions)})."
    }
  }
}

resource "google_project_service" "this" {
  for_each = toset(local.required_apis)

  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

# Cloud Build runner SA. WIF principals from GitHub impersonate this.
resource "google_service_account" "cloud_build" {
  project      = var.project_id
  account_id   = "ss-v2-cloudbuild"
  display_name = "social-seeding-v2 Cloud Build runner"
  description  = "Per-PR + nightly CI identity (D37). Impersonated via WIF from GitHub."
  depends_on   = [google_project_service.this]
}

# Cloud Deploy executor SA — distinct from cloud_build so a compromised
# builder cannot also promote releases.
resource "google_service_account" "cloud_deploy" {
  project      = var.project_id
  account_id   = "ss-v2-clouddeploy"
  display_name = "social-seeding-v2 Cloud Deploy executor"
  description  = "Release execution + verification identity (D37)."
  depends_on   = [google_project_service.this]
}

# Workstations runtime SA — assumed by every workstation VM (D38).
resource "google_service_account" "workstations" {
  project      = var.project_id
  account_id   = "ss-v2-workstations"
  display_name = "social-seeding-v2 Cloud Workstations runtime"
  description  = "Default identity for Workstations VMs (D38). Grants Vertex AI access for dev."
  depends_on   = [google_project_service.this]
}

# Project-level IAM. Cloud Build: build/push/cut-releases. Cloud Deploy:
# admin Cloud Run + Agent Runtime + logs. Workstations: Vertex AI dev access.
locals {
  project_iam_bindings = {
    "cloud_build_artifact_writer"   = { sa = google_service_account.cloud_build.email, role = "roles/artifactregistry.writer" }
    "cloud_build_log_writer"        = { sa = google_service_account.cloud_build.email, role = "roles/logging.logWriter" }
    "cloud_build_release_creator"   = { sa = google_service_account.cloud_build.email, role = "roles/clouddeploy.releaser" }
    "cloud_deploy_run_admin"        = { sa = google_service_account.cloud_deploy.email, role = "roles/run.admin" }
    "cloud_deploy_aiplatform_admin" = { sa = google_service_account.cloud_deploy.email, role = "roles/aiplatform.admin" }
    "cloud_deploy_log_writer"       = { sa = google_service_account.cloud_deploy.email, role = "roles/logging.logWriter" }
    "cloud_deploy_sa_user"          = { sa = google_service_account.cloud_deploy.email, role = "roles/iam.serviceAccountUser" }
    "workstations_aiplatform_user"  = { sa = google_service_account.workstations.email, role = "roles/aiplatform.user" }
  }
}

resource "google_project_iam_member" "bindings" {
  for_each = local.project_iam_bindings

  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${each.value.sa}"
}

# Cloud Build impersonates Cloud Deploy SA to kick off a release.
resource "google_service_account_iam_member" "build_impersonates_deploy" {
  service_account_id = google_service_account.cloud_deploy.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.cloud_build.email}"
}
