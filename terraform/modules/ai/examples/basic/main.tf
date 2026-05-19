# =============================================================================
# examples/basic — minimum viable invocation of the AI module.
#
# Demonstrates:
#   - Single-region (us-central1) deployment.
#   - Default 22-agent fleet (D23).
#   - 3 Vector Search indexes (creators_v1, brands_v1, content_v1) per D16.
#   - Learning loop pipelines wired but with REPLACE_ME template paths
#     (operator must upload templates before running).
#   - Dialogflow CX skeleton + Discovery Engine app registered.
#
# Not demonstrated (kept out of "basic" scope on purpose):
#   - Multi-region active-active (D13) — see examples/multi-region (TODO).
#   - VPC-SC perimeter + CMEK passthrough — see examples/secure (TODO).
#   - Watchdog Cloud Run services — owned by the `compute` module.
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# -----------------------------------------------------------------------------
# Pre-reqs the operator MUST have already provisioned in sibling modules:
#   - `networking` module: VPC + reserved IP range for Vector Search.
#   - `security` module:   agent runtime SA, data scientist SA, KMS keys,
#                          (optionally) Agent Gateway.
#   - `data` module:       staging GCS bucket.
# We pull them by name here for visibility — in a real root config these
# values would flow as outputs from the sibling modules.
# -----------------------------------------------------------------------------
variable "project_id" {
  type        = string
  description = "GCP project id."
}

variable "project_number" {
  type        = string
  description = "GCP project number."
}

variable "region" {
  type        = string
  description = "Primary region."
  default     = "us-central1"
}

variable "network_self_link" {
  type        = string
  description = "VPC self-link for Vector Search peering."
}

variable "staging_bucket_name" {
  type        = string
  description = "Pre-created GCS bucket used for staging + agent cards."
}

variable "agent_runtime_sa_email" {
  type        = string
  description = "Service account email used by Agent Runtime."
}

variable "data_scientist_sa_email" {
  type        = string
  description = "Service account email used by Workbench notebooks."
}

# -----------------------------------------------------------------------------
# Module invocation
# -----------------------------------------------------------------------------
module "ai" {
  source = "../.."

  project_id     = var.project_id
  project_number = var.project_number
  region         = var.region
  environment    = "dev"
  resource_prefix = "ssv2"

  network_self_link                    = var.network_self_link
  vector_search_reserved_ip_range_name = "vertex-vector-search-range"

  agent_runtime_service_account_email  = var.agent_runtime_sa_email
  data_scientist_service_account_email = var.data_scientist_sa_email

  # CMEK left empty for the basic example — production roots should pass a
  # KMS key here. See D20.
  cmek_key_name = ""

  # Reference an already-created staging bucket (provisioned by the `data`
  # module). The AI module writes Agent Cards into this bucket.
  staging_bucket_name = var.staging_bucket_name

  # Defaults from variables.tf cover the 22-agent fleet, 3 vector indexes,
  # learning-loop pipelines, Discovery Engine app, and Dialogflow CX agent.
  # Overrides shown here are only for the dev-environment cost lever (D39).
  feature_flags = {
    enable_vector_search         = true
    enable_workbench             = true
    enable_pipelines             = false # turn on once pipeline templates uploaded
    enable_dialogflow_cx         = true
    enable_discovery_engine_app  = true
    enable_agent_registry_seed   = true
    fail_on_preview_resource_err = false
  }

  tags = {
    component   = "ai"
    module      = "tf-module-7"
    decision    = "d17-d25"
    environment = "dev"
    example     = "basic"
  }
}

# -----------------------------------------------------------------------------
# Re-export the summary so `terraform output` shows the agent fleet at a glance.
# -----------------------------------------------------------------------------
output "summary" {
  value = module.ai.module_summary
}

output "agent_ids" {
  value = module.ai.agent_ids
}

output "memory_bank_database" {
  value = module.ai.memory_bank_database_name
}

output "vector_search_endpoint" {
  value = module.ai.vector_search_endpoint_id
}
