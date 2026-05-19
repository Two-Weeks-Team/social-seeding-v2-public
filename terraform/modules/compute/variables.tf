# variables.tf — compute module
#
# Inputs follow ARCHITECTURE.md §2 (per-region matrix) and DECISIONS.md
# D13 (regions), D17 (Agent Runtime), D23/D26 (GKE Autopilot + GPU).

variable "project_id" {
  description = "GCP project ID. Per D13, the same project hosts all three regions of the active-active deployment (single-tenant per project, multi-tenant via Identity Platform per D12/D19)."
  type        = string
}

variable "regions" {
  description = <<-EOT
    Regions to provision compute resources in.
    Default = the three active-active regions from D13:
      - us-central1       (Americas)
      - europe-west4      (EU)
      - asia-northeast3   (Seoul / APAC, also primary for KR-startup region-gap per D2/D3)
    Each region gets its own Cloud Run service, jobs config, worker pool,
    Vertex AI Agent Runtime endpoint, and GKE Autopilot cluster.
  EOT
  type        = list(string)
  default     = ["us-central1", "europe-west4", "asia-northeast3"]

  validation {
    condition     = length(var.regions) >= 1 && length(var.regions) <= 5
    error_message = "regions must contain 1 to 5 entries (D13 active-active assumes 3)."
  }
}

variable "agent_runtime_count" {
  description = <<-EOT
    Number of Vertex AI Agent Runtime endpoints to provision per region (D17).
    Default = 1 (one shared endpoint per region; the 22 agents from D23 are
    multiplexed via Agent Gateway). Increase if isolation between tenant
    cohorts is required for compliance (D22 PIPA).
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.agent_runtime_count >= 1 && var.agent_runtime_count <= 10
    error_message = "agent_runtime_count must be between 1 and 10."
  }
}

variable "gke_autopilot_enabled" {
  description = <<-EOT
    Whether to provision the GKE Autopilot cluster per region (D23/D26 — Agent
    Sandbox + GPU pods for Veo/Imagen creative agent). Set false for low-cost
    dev environments where Cloud Run alone is sufficient.
  EOT
  type        = bool
  default     = true
}

variable "gpu_type" {
  description = <<-EOT
    GPU accelerator class for Cloud Run services that need on-demand inference.
    Per COMPUTE.md §1 the supported values in 2026 are:
      - nvidia-l4              (24 GB, default — cost-tuned)
      - nvidia-rtx-pro-6000    (96 GB, RTX PRO 6000 Blackwell, GA 2026-04-13)
    GKE Autopilot GPU node selection is independent (see gke_gpu_accelerator).
  EOT
  type        = string
  default     = "nvidia-l4"

  validation {
    condition     = contains(["nvidia-l4", "nvidia-rtx-pro-6000"], var.gpu_type)
    error_message = "gpu_type must be one of: nvidia-l4, nvidia-rtx-pro-6000."
  }
}

variable "gke_gpu_accelerator" {
  description = <<-EOT
    GPU accelerator class for GKE Autopilot pods (Veo/Imagen heavy lifters per
    ARCHITECTURE.md §2: H100 in us-central1, A3 elsewhere). Map of region to
    accelerator string consumed by the Pod nodeSelector
    `cloud.google.com/gke-accelerator`.
  EOT
  type        = map(string)
  default = {
    "us-central1"     = "nvidia-h100-80gb"
    "europe-west4"    = "nvidia-l4"
    "asia-northeast3" = "nvidia-l4"
  }
}

variable "container_image_mission_control" {
  description = "Container image URI for the Mission Control SSR adapter Cloud Run service (D26). Defaults to a placeholder Google sample image so `terraform plan` is green in fresh projects."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "container_image_jobs" {
  description = "Container image URI for the Cloud Run jobs (eval / agent simulation / license scan per D37)."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/job"
}

variable "container_image_workers" {
  description = "Container image URI for the Cloud Run worker pools (Pub/Sub fan-out workers per D18). Per COMPUTE.md §3 the worker pool is the canonical home for queue-driven agent loops."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/worker-pool"
}

variable "service_account_runtime" {
  description = <<-EOT
    Email of the service account assigned to Cloud Run services + worker pools
    + jobs + Agent Runtime endpoints. Workload Identity for GKE pods uses this
    same SA via the binding emitted in main.tf. Created in the iam/ module;
    pass it in here. If unset (default), each resource uses the default
    Compute Engine SA — only acceptable for the basic example.
  EOT
  type        = string
  default     = null
}

variable "service_account_workflows" {
  description = "Email of the Cloud Workflows service account (D18). The compute module references it for OIDC auth between Workflows steps and Cloud Run targets."
  type        = string
  default     = null
}

variable "cmek_key_ids" {
  description = <<-EOT
    Map of region to fully-qualified Cloud KMS CryptoKey resource ID for CMEK
    (D20). Example:
      {
        "us-central1"     = "projects/p/locations/us-central1/keyRings/r/cryptoKeys/k"
        "europe-west4"    = "projects/p/locations/europe-west4/keyRings/r/cryptoKeys/k"
        "asia-northeast3" = "projects/p/locations/asia-northeast3/keyRings/r/cryptoKeys/k"
      }
    Created by the security/ module. If empty, CMEK is omitted — only OK for
    non-production sandboxes.
  EOT
  type        = map(string)
  default     = {}
}

variable "network_self_links" {
  description = "Map of region to VPC network self-link for Direct VPC egress (COMPUTE.md §1 best-practices). Created in networking/ module. If empty, services run with the public egress default."
  type        = map(string)
  default     = {}
}

variable "subnet_self_links" {
  description = "Map of region to VPC subnetwork self-link for Direct VPC egress. Must be paired with network_self_links."
  type        = map(string)
  default     = {}
}

variable "agent_runtime_use_fallback" {
  description = <<-EOT
    Force the `null_resource` + gcloud fallback for Agent Runtime instead of
    the native `google_vertex_ai_reasoning_engine` resource. Set true if the
    consumer pins to a provider version older than 6.20.0 (where the native
    resource is missing), or if a 2026-mid Preview field (e.g. context_spec
    options not yet in the provider) is required. TODO: remove once the
    native resource is universally available and feature-complete.
  EOT
  type        = bool
  default     = false
}

variable "mission_control_min_instances" {
  description = "min-instances for the Mission Control Cloud Run service (D26 / COMPUTE.md §1: keep ≥ 1 for any user-facing surface to avoid cold starts)."
  type        = number
  default     = 1
}

variable "mission_control_max_instances" {
  description = "max-instances cap for the Mission Control Cloud Run service. Per D31 99.99% SLO, leave generous headroom."
  type        = number
  default     = 20
}

variable "worker_pool_instances" {
  description = "Fixed manual instance count per Cloud Run worker pool (D18 fan-out). Per COMPUTE.md §3, worker pools do not autoscale by default; for spiky queues, wire CREMA externally."
  type        = number
  default     = 3
}

variable "labels" {
  description = "Additional labels merged into the per-resource label set. The module always adds {managed_by = \"terraform-compute\", d_id = \"D13_D17_D26\"}."
  type        = map(string)
  default     = {}
}
