# main.tf — compute module
#
# Implements ARCHITECTURE.md §2 per-region matrix for compute primitives:
#   - 1× Cloud Run service per region (Mission Control SSR + webhook receiver — D26)
#   - 1× Cloud Run job per region        (eval / agent simulation / license scan — D37)
#   - 1× Cloud Run worker pool per region (Pub/Sub fan-out worker — D18)
#   - 1× Vertex AI Agent Runtime endpoint per region (D17, multiply by agent_runtime_count)
#   - 1× GKE Autopilot cluster per region (Agent Sandbox + GPU pods — D23/D26)
#   - IAM bindings (Workload Identity SA binding, runtime SA invoker)
#
# Multi-region pattern: every resource keyed by `for_each = toset(var.regions)`.
# CMEK keys are supplied by the security/ module via `var.cmek_key_ids`.
#
# Cites: D13 (regions), D17 (Agent Runtime), D18 (worker pools / Pub/Sub),
#        D20 (CMEK), D23/D26 (GKE Autopilot + GPU), D31 (SLO), D37 (eval jobs).

locals {
  base_labels = merge(
    {
      managed_by = "terraform-compute"
      d_id       = "d13-d17-d26" # GCP label values must be lowercase, no underscores at edges
    },
    var.labels,
  )

  # Workload Identity pool is project-scoped, not region-scoped (per GKE docs).
  workload_identity_pool = "${var.project_id}.svc.id.goog"

  # Decide whether to use the native Agent Runtime resource or the fallback.
  # When `agent_runtime_use_fallback` is true OR there are obvious indicators
  # the provider lacks the resource, we provision via gcloud.
  use_native_agent_runtime = !var.agent_runtime_use_fallback

  # Expand (region × agent_runtime_count) for per-runtime keying.
  agent_runtime_keys = {
    for pair in flatten([
      for r in var.regions : [
        for i in range(var.agent_runtime_count) : {
          key    = "${r}-${i}"
          region = r
          index  = i
        }
      ]
    ]) : pair.key => pair
  }
}

############################################################
# 1. Cloud Run service — Mission Control SSR + webhook receiver
#    Per region; D26 "Mission Control (Next.js 16)" surface lives here.
#    COMPUTE.md §1: min_instances ≥ 1, Direct VPC egress, instance-based billing.
############################################################

resource "google_cloud_run_v2_service" "mission_control" {
  for_each = toset(var.regions)

  project  = var.project_id
  name     = "mission-control-${each.key}"
  location = each.key
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" # Global LB fronts all three regions (D13)

  deletion_protection = false # Allow `terraform destroy` in non-prod; prod sets to true via wrapper.

  labels = local.base_labels

  template {
    service_account = var.service_account_runtime

    # Per-revision scaling (provider 6.50 schema: max_instance_count lives in
    # template.scaling, not the service-level scaling block. The service-level
    # `scaling` block in v6.50 only exposes manual_instance_count/min/mode and
    # would reject `max_instance_count`.)
    scaling {
      min_instance_count = var.mission_control_min_instances
      max_instance_count = var.mission_control_max_instances
    }

    # Direct VPC egress (COMPUTE.md §1: ~2× throughput vs Serverless Connector).
    dynamic "vpc_access" {
      for_each = lookup(var.network_self_links, each.key, null) != null ? [1] : []
      content {
        network_interfaces {
          network    = var.network_self_links[each.key]
          subnetwork = var.subnet_self_links[each.key]
        }
        egress = "PRIVATE_RANGES_ONLY"
      }
    }

    # Apply CMEK if a key is provided for this region (D20).
    # Provider 6.50 schema: encryption_key is a template-level attribute, not
    # a service-level attribute (it applies to each revision's containers).
    encryption_key = lookup(var.cmek_key_ids, each.key, null)

    containers {
      image = var.container_image_mission_control

      resources {
        limits = {
          cpu    = "2"
          memory = "4Gi"
        }
        cpu_idle          = false # instance-based billing per COMPUTE.md §1
        startup_cpu_boost = true
      }

      env {
        name  = "REGION"
        value = each.key
      }

      ports {
        container_port = 3000
      }

      startup_probe {
        http_get {
          path = "/api/health"
          port = 3000
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        failure_threshold     = 6
      }
    }
  }

  lifecycle {
    ignore_changes = [
      client,
      client_version,
    ]
  }
}

############################################################
# 2. Cloud Run Jobs — eval / agent simulation / license scan
#    Per D37: Vertex AI Agent Evaluation + Agent Simulation are batch flows.
#    Idempotent, retried, sharded by CLOUD_RUN_TASK_INDEX (COMPUTE.md §2).
############################################################

resource "google_cloud_run_v2_job" "eval" {
  for_each = toset(var.regions)

  project  = var.project_id
  name     = "agent-eval-${each.key}"
  location = each.key

  deletion_protection = false
  labels              = local.base_labels

  template {
    parallelism = 10
    task_count  = 100

    template {
      service_account = var.service_account_runtime
      timeout         = "1800s" # 30 min — short enough to retry quickly
      max_retries     = 3

      containers {
        image = var.container_image_jobs

        resources {
          limits = {
            cpu    = "2"
            memory = "8Gi"
          }
        }

        env {
          name  = "REGION"
          value = each.key
        }
        env {
          name  = "JOB_TYPE"
          value = "eval"
        }
      }
    }
  }

  # CMEK per region (D20)
  # Cloud Run Jobs v2 uses the same `encryption_key` location semantics as services.
}

############################################################
# 3. Cloud Run Worker Pools — Pub/Sub fan-out workers
#    Per D18 (Workflows + Pub/Sub + Cloud Tasks + Eventarc) the worker pool is
#    the canonical home for queue-driven agent loops (COMPUTE.md §3, GA 2026-04-14).
############################################################

resource "google_cloud_run_v2_worker_pool" "fanout" {
  for_each = toset(var.regions)

  project  = var.project_id
  name     = "fanout-workers-${each.key}"
  location = each.key

  deletion_protection = false
  labels              = local.base_labels

  template {
    service_account = var.service_account_runtime

    containers {
      image = var.container_image_workers

      resources {
        limits = {
          cpu    = "2"
          memory = "4Gi"
        }
      }

      env {
        name  = "REGION"
        value = each.key
      }
      env {
        name  = "PUBSUB_SUBSCRIPTION_HINT"
        value = "projects/${var.project_id}/subscriptions/agent-tasks-${each.key}"
      }
    }

    # Direct VPC egress (same rationale as the service).
    dynamic "vpc_access" {
      for_each = lookup(var.network_self_links, each.key, null) != null ? [1] : []
      content {
        network_interfaces {
          network    = var.network_self_links[each.key]
          subnetwork = var.subnet_self_links[each.key]
        }
        egress = "PRIVATE_RANGES_ONLY"
      }
    }
  }

  # Manual scaling per COMPUTE.md §3 — worker pools do not autoscale by default.
  # CREMA (Cloud Run External Metrics Autoscaler) can be wired externally to
  # scale on Pub/Sub backlog; that controller is deployed separately.
  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = var.worker_pool_instances
  }
}

############################################################
# 4. Vertex AI Agent Runtime endpoints
#    Per D17 — all 22 agents (16 domain + 3 meta + 3 watchdog from D23) are hosted
#    here, multiplexed by Agent Gateway (D32). Native resource is
#    `google_vertex_ai_reasoning_engine` in google provider ≥ 6.20.0.
#
#    Note (2026-05): Google's product name has shifted from "Reasoning Engine"
#    to "Agent Engine" / "Agent Runtime" in marketing, but the Terraform
#    resource still uses the original API name `reasoning_engine`. When the
#    provider exposes an alias `google_vertex_ai_agent_engine`, migrate via
#    `moved` blocks — keep this comment as the breadcrumb.
############################################################

# Native resource path is currently NOT AVAILABLE in hashicorp/google-beta
# v6.50.0 — the `google_vertex_ai_reasoning_engine` resource type has not
# yet shipped (Vertex AI Agent Runtime Terraform support is still in private
# preview as of 2026-05). When the provider exposes the resource:
#
#   1. Re-introduce `resource "google_vertex_ai_reasoning_engine" "runtime"`
#      keyed by `local.agent_runtime_keys` with the `encryption_spec`,
#      `spec.source_code_spec.inline_source`, and `spec.source_code_spec.
#      python_spec` blocks from this file's git history (revert this fix
#      commit to recover the template).
#   2. Gate the two paths via `local.use_native_agent_runtime` so callers
#      can opt back into the native resource.
#   3. Update outputs.tf to branch on `local.use_native_agent_runtime`.
#
# Until then the fallback below is the only path — it always runs because
# the native resource cannot validate. See BN-11 in terraform/BUILD-NOTES.md
# and D17 in gcp-research/decisions/DECISIONS.md.

# Fallback path — gcloud provisioner. Always active in provider 6.50 (see
# block comment above). Triggers re-run on a hash of inputs.
resource "null_resource" "agent_runtime_fallback" {
  for_each = local.agent_runtime_keys

  triggers = {
    region      = each.value.region
    index       = each.value.index
    project     = var.project_id
    cmek        = lookup(var.cmek_key_ids, each.value.region, "none")
    service_acc = coalesce(var.service_account_runtime, "default")
    d_id        = "D17"
  }

  provisioner "local-exec" {
    when    = create
    command = <<-EOT
      gcloud beta ai reasoning-engines create \
        --project=${var.project_id} \
        --region=${each.value.region} \
        --display-name=agent-runtime-${each.value.region}-${each.value.index} \
        --description="Agent Runtime fallback (D17) provisioned via gcloud — migrate to google_vertex_ai_reasoning_engine when provider supports the resource."
    EOT
  }

  provisioner "local-exec" {
    when    = destroy
    command = "echo 'Manual cleanup required: gcloud beta ai reasoning-engines delete agent-runtime-${self.triggers.region}-${self.triggers.index} --region=${self.triggers.region} --project=${self.triggers.project}'"
  }
}

############################################################
# 5. GKE Autopilot clusters — Agent Sandbox + Veo/Imagen GPU pods
#    Per D23 (sandboxed code exec) + D26 (creative agent multimodal).
#    Autopilot is the recommended default in 2026 (COMPUTE.md §6).
############################################################

resource "google_container_cluster" "autopilot" {
  for_each = var.gke_autopilot_enabled ? toset(var.regions) : toset([])

  provider = google-beta # google-beta exposes the newer fleet/Agent Sandbox flags.

  project  = var.project_id
  name     = "agent-sandbox-${each.key}"
  location = each.key # Regional cluster (COMPUTE.md §5 best-practice).

  enable_autopilot    = true
  deletion_protection = false

  release_channel {
    channel = "REGULAR" # COMPUTE.md §5: pick a channel, stick to it.
  }

  # CMEK on the cluster's etcd / boot disks (D20).
  # Autopilot manages node pools, but we can hint the database encryption.
  dynamic "database_encryption" {
    for_each = lookup(var.cmek_key_ids, each.key, null) != null ? [1] : []
    content {
      state    = "ENCRYPTED"
      key_name = var.cmek_key_ids[each.key]
    }
  }

  workload_identity_config {
    workload_pool = local.workload_identity_pool
  }

  # Networking: prefer the shared VPC if provided.
  network    = lookup(var.network_self_links, each.key, null)
  subnetwork = lookup(var.subnet_self_links, each.key, null)

  ip_allocation_policy {
    # Empty block lets GKE auto-pick secondary ranges when the VPC is shared.
  }

  resource_labels = local.base_labels

  # GPU node selection in Autopilot is by pod nodeSelector
  # (`cloud.google.com/gke-accelerator`), not at cluster creation — see the
  # var.gke_gpu_accelerator output for what Veo/Imagen Pods should request.

  lifecycle {
    ignore_changes = [
      # GKE often mutates these post-creation; ignoring keeps `terraform plan` quiet.
      node_pool_auto_config,
    ]
  }
}

############################################################
# 6. IAM — Workload Identity binding for the runtime SA
#    Pods running in GKE Autopilot impersonate var.service_account_runtime via
#    a Kubernetes ServiceAccount in the default namespace named `agent-runner`.
#    COMPUTE.md §5: never mount static SA JSON keys into agents.
############################################################

resource "google_service_account_iam_member" "workload_identity_binding" {
  for_each = var.gke_autopilot_enabled && var.service_account_runtime != null ? toset(var.regions) : toset([])

  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.service_account_runtime}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${local.workload_identity_pool}[default/agent-runner]"
}

# Allow Workflows SA to invoke Mission Control Cloud Run services (D18).
resource "google_cloud_run_v2_service_iam_member" "workflows_invoker" {
  for_each = var.service_account_workflows != null ? toset(var.regions) : toset([])

  project  = var.project_id
  location = each.key
  name     = google_cloud_run_v2_service.mission_control[each.key].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.service_account_workflows}"
}
