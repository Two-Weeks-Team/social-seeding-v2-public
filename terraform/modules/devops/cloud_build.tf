# cloud_build.tf — private pool + per-PR (8-stage / 12-min) + nightly triggers
#
# D37 / MATRIX §7.1: per-PR runs 8 stages (lint → vitest → pytest → L1-fast →
#   spec → chaos-smoke → binauthz → push). Total budget 12 min.
# D37 / MATRIX §7.2: nightly runs full L1 + L4 simulation (1000+) + L5 chaos +
#   mutation + cost regression. ~4.5h.

# Private pool — VPC-attached, /29 peered range (DEVOPS §A.1 latest).
resource "google_cloudbuild_worker_pool" "ci" {
  name     = "ss-v2-ci-pool"
  project  = var.project_id
  location = var.primary_region

  worker_config {
    machine_type   = var.build_private_pool_machine_type
    disk_size_gb   = var.build_private_pool_disk_size_gb
    no_external_ip = var.build_private_pool_egress == "NO_PUBLIC_EGRESS"
  }

  network_config {
    peered_network          = var.workstations_network
    peered_network_ip_range = "/29"
  }

  depends_on = [google_project_service.this]
}

# Per-PR trigger — inline 8-stage build (MATRIX §7.1).
# Inline (vs git_file_source) so IAM controls the pipeline shape: a PR cannot
# rewrite the stages to skip binauthz attestation.
resource "google_cloudbuild_trigger" "per_pr" {
  name        = "ss-v2-per-pr"
  project     = var.project_id
  location    = var.primary_region
  description = "MATRIX §7.1 — 8 stages, 12-min budget (D37)."

  service_account = google_service_account.cloud_build.id

  github {
    owner = var.github_owner
    name  = var.github_repository
    pull_request {
      branch          = var.github_main_branch
      comment_control = "COMMENTS_ENABLED_FOR_EXTERNAL_CONTRIBUTORS_ONLY"
    }
  }

  build {
    timeout = "${var.build_pr_timeout_seconds}s"

    options {
      logging             = "CLOUD_LOGGING_ONLY"
      substitution_option = "ALLOW_LOOSE"
      worker_pool         = google_cloudbuild_worker_pool.ci.id
    }

    # Stage 1: lint + type-check (~1m).
    step {
      id         = "stage1-lint"
      name       = "node:22-bookworm"
      entrypoint = "bash"
      args       = ["-c", "pnpm install --frozen-lockfile && pnpm run lint && pnpm exec tsc --noEmit"]
    }

    # Stage 2 + 3 run in parallel (MATRIX §7.1 fail-fast). Both wait_for stage1.
    step {
      id         = "stage2-vitest"
      name       = "node:22-bookworm"
      entrypoint = "bash"
      args       = ["-c", "pnpm --filter '@ss/capabilities' test && pnpm --filter '@ss/workflows' test && pnpm --filter '@ss/observability' test"]
      wait_for   = ["stage1-lint"]
    }

    step {
      id         = "stage3-pytest"
      name       = "python:3.12"
      entrypoint = "bash"
      args       = ["-c", "pip install -e packages/agents-adk[dev] && pytest packages/agents-adk -q -k 'TestInputContract or TestPlumbing or TestEscalation'"]
      wait_for   = ["stage1-lint"]
    }

    # Stage 4: L1 fast-eval (5 cases / touched agent, max 80).
    step {
      id         = "stage4-l1-fast"
      name       = "python:3.12"
      entrypoint = "bash"
      args       = ["-c", "python -m evals.run --mode fast --cases-per-agent 5 --threshold 0.85"]
      wait_for   = ["stage2-vitest", "stage3-pytest"]
    }

    # Stage 5: spec conformance — OpenAPI 3.1 + AsyncAPI 3.0 + JSON Schema.
    step {
      id         = "stage5-specs"
      name       = "node:22-bookworm"
      entrypoint = "bash"
      args       = ["-c", "pnpm run specs:validate"]
      wait_for   = ["stage4-l1-fast"]
    }

    # Stage 6: chaos smoke — 2 scenarios.
    step {
      id         = "stage6-chaos-smoke"
      name       = "python:3.12"
      entrypoint = "bash"
      args       = ["-c", "python -m chaos.smoke --scenarios regional_outage,vertex_429 --duration 90s"]
      wait_for   = ["stage5-specs"]
    }

    # Stage 7: Binary Authorization attestation (SLSA L3).
    step {
      id   = "stage7-binauthz"
      name = "gcr.io/google-cloud-build/binary-authorization-attestation"
      args = [
        "--artifact-url=${var.primary_region}-docker.pkg.dev/${var.project_id}/ss-v2-docker-${var.primary_region}/orchestrator:$SHORT_SHA",
        "--attestor=projects/${var.project_id}/attestors/ss-v2-build-attestor",
        "--keyversion=projects/${var.project_id}/locations/${var.primary_region}/keyRings/ss-v2-binauthz/cryptoKeys/attestor/cryptoKeyVersions/1",
      ]
      wait_for = ["stage6-chaos-smoke"]
    }

    # Stage 8: push to Artifact Registry.
    step {
      id         = "stage8-push"
      name       = "gcr.io/k8s-skaffold/pack"
      entrypoint = "pack"
      args = [
        "build",
        "${var.primary_region}-docker.pkg.dev/${var.project_id}/ss-v2-docker-${var.primary_region}/orchestrator:$SHORT_SHA",
        "--builder=gcr.io/buildpacks/builder:latest",
        "--publish",
      ]
      wait_for = ["stage7-binauthz"]
    }

    substitutions = {
      _PROJECT_ID     = var.project_id
      _PRIMARY_REGION = var.primary_region
    }
  }

  depends_on = [
    google_artifact_registry_repository.this,
    google_project_iam_member.bindings,
  ]
}

# Nightly trigger — webhook fired by Cloud Scheduler at var.nightly_cron.
# Body lives in cloudbuild.nightly.yaml in the repo so the M3 optimizer (D38)
# can evolve the nightly without `terraform apply`.
resource "random_password" "nightly_webhook_secret" {
  length  = 40
  special = false
}

resource "google_secret_manager_secret" "nightly_webhook" {
  project   = var.project_id
  secret_id = "ss-v2-nightly-webhook"
  replication {
    auto {}
  }
  labels     = local.common_labels
  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret_version" "nightly_webhook" {
  secret      = google_secret_manager_secret.nightly_webhook.id
  secret_data = random_password.nightly_webhook_secret.result
}

resource "google_cloudbuild_trigger" "nightly" {
  name        = "ss-v2-nightly"
  project     = var.project_id
  location    = var.primary_region
  description = "MATRIX §7.2 — full L1 + L4 sim 1000 + L5 chaos + mutation + cost regression."

  service_account = google_service_account.cloud_build.id

  webhook_config {
    secret = google_secret_manager_secret_version.nightly_webhook.id
  }

  source_to_build {
    uri       = "https://github.com/${var.github_owner}/${var.github_repository}"
    ref       = "refs/heads/main"
    repo_type = "GITHUB"
  }

  git_file_source {
    path      = "cloudbuild.nightly.yaml"
    uri       = "https://github.com/${var.github_owner}/${var.github_repository}"
    revision  = "refs/heads/main"
    repo_type = "GITHUB"
  }

  depends_on = [google_cloudbuild_worker_pool.ci]
}

resource "google_cloud_scheduler_job" "nightly" {
  name        = "ss-v2-nightly-trigger"
  project     = var.project_id
  region      = var.primary_region
  description = "Fires the nightly Cloud Build trigger (MATRIX §7.2)."
  schedule    = var.nightly_cron
  time_zone   = "UTC"

  attempt_deadline = "${var.build_nightly_timeout_seconds}s"

  http_target {
    http_method = "POST"
    uri         = "https://cloudbuild.googleapis.com/v1/projects/${var.project_id}/locations/${var.primary_region}/triggers/${google_cloudbuild_trigger.nightly.trigger_id}:webhook?secret=${random_password.nightly_webhook_secret.result}"

    oauth_token {
      service_account_email = google_service_account.cloud_build.email
    }
  }

  retry_config {
    retry_count          = 1
    max_retry_duration   = "600s"
    min_backoff_duration = "60s"
  }
}

# D32 — forward FAILURE / INTERNAL_ERROR / TIMEOUT events to PagerDuty/Slack.
resource "google_pubsub_subscription" "build_failures" {
  count = var.notification_pubsub_topic == null ? 0 : 1

  name    = "ss-v2-build-failures"
  project = var.project_id
  topic   = "projects/${var.project_id}/topics/cloud-builds"

  filter = "attributes.status = \"FAILURE\" OR attributes.status = \"INTERNAL_ERROR\" OR attributes.status = \"TIMEOUT\""

  push_config {
    push_endpoint = var.notification_pubsub_topic
    oidc_token {
      service_account_email = google_service_account.cloud_build.email
    }
  }

  ack_deadline_seconds = 60
  expiration_policy {
    ttl = ""
  }
  labels = local.common_labels
}
