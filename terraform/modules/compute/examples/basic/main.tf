# examples/basic/main.tf — minimal 3-region usage of the compute module.
#
# Provisions the full D13 active-active set with no CMEK, no shared VPC, and
# Google's sample container images so a fresh project can run
# `terraform apply` end-to-end without other modules wired in.
#
# For production wiring, see the parent module's README §Usage.

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.20.0, < 8.0.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 6.20.0, < 8.0.0"
    }
  }
}

variable "project_id" {
  description = "Target GCP project ID. Suggest `ss-v2-prod-demo` for a sandbox per ARCHITECTURE.md §O2."
  type        = string
}

provider "google" {
  project = var.project_id
}

provider "google-beta" {
  project = var.project_id
}

module "compute" {
  source = "../.."

  project_id = var.project_id

  # D13: full active-active across all three regions.
  regions = ["us-central1", "europe-west4", "asia-northeast3"]

  # Cost-friendly demo defaults — Autopilot off, single agent runtime per region.
  gke_autopilot_enabled = false
  agent_runtime_count   = 1

  # No CMEK / shared VPC / custom SAs in this example.
  cmek_key_ids       = {}
  network_self_links = {}
  subnet_self_links  = {}

  labels = {
    environment = "demo"
    example     = "basic"
  }
}

output "service_urls" {
  description = "Cloud Run service URLs per region (D26 Mission Control SSR adapter)."
  value       = module.compute.mission_control_service_urls
}

output "worker_pools" {
  description = "Cloud Run worker pool names per region (D18 fan-out)."
  value       = module.compute.worker_pool_names
}

output "agent_runtime_endpoints" {
  description = "Vertex AI Agent Runtime resource names (D17)."
  value       = module.compute.agent_runtime_endpoints
}
