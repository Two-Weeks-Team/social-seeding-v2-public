# artifact_registry.tf — 3 formats × N regions repos (D37 / D13)
#
# Default = 3 × 3 = 9 repos. Each repo:
#   - Immutable tags (var.artifact_immutable_tags) → SLSA chain integrity
#   - Cleanup: keep latest N tags, drop untagged > 14d (DEVOPS §A.3)
#   - Co-located with Cloud Run region — cross-region pulls add cold-start

resource "google_artifact_registry_repository" "this" {
  for_each = local.artifact_repo_combinations

  project       = var.project_id
  location      = each.value.region
  repository_id = "ss-v2-${lower(each.value.format)}-${each.value.region}"
  format        = each.value.format
  description   = "${each.value.format} artifacts for ${each.value.region} (D37 CI/CD supply chain)."

  labels = merge(
    local.common_labels,
    { region = each.value.region, format = lower(each.value.format) },
  )

  mode = "STANDARD_REPOSITORY"

  docker_config {
    immutable_tags = each.value.format == "DOCKER" ? var.artifact_immutable_tags : false
  }

  cleanup_policies {
    id     = "keep-latest"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.artifact_cleanup_keep_count
    }
  }

  cleanup_policies {
    id     = "delete-old-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "1209600s"
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_artifact_registry_repository_iam_member" "deploy_reader" {
  for_each = google_artifact_registry_repository.this

  project    = each.value.project
  location   = each.value.location
  repository = each.value.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.cloud_deploy.email}"
}

resource "google_artifact_registry_repository_iam_member" "workstations_reader" {
  for_each = google_artifact_registry_repository.this

  project    = each.value.project
  location   = each.value.location
  repository = each.value.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.workstations.email}"
}
