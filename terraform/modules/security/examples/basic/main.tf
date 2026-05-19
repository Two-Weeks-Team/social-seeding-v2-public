# terraform/modules/security/examples/basic/main.tf
#
# Minimum-viable invocation of the social-seeding-v2 security module against a
# single dev project. Adapt the locals block to your project IDs, then run:
#
#   terraform init
#   terraform plan -out=tfplan
#   terraform apply tfplan
#
# Expected post-apply state:
#   - 3 KMS keyrings (US + EU + APAC), 18 CMEK keys, 8 secrets
#   - Identity Platform multi-tenant config + template tenant
#   - Workload Identity Pool wired to the ComBba/social-seeding-v2 GitHub repo
#   - ss-input + ss-output Model Armor templates in INSPECT_AND_BLOCK mode
#   - Binary Authorization policy requiring attestations from ss-prod-attestor
#   - SCC custom source + Chronicle audit-log BQ sink

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.20"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.20"
    }
  }
}

locals {
  # Replace with the dev project you're targeting. Per O2 the canonical names
  # for production are ss-v2-prod-{us|eu|ap}; for dev use ss-v2-dev.
  project_id     = "ss-v2-dev"
  project_number = "000000000000" # gcloud projects describe ss-v2-dev --format='value(projectNumber)'
  org_id         = "123456789012" # gcloud organizations list
}

provider "google" {
  project = local.project_id
}

provider "google-beta" {
  project = local.project_id
}

module "security" {
  source = "../../"

  project_id     = local.project_id
  project_number = local.project_number
  org_id         = local.org_id

  # Dev profile: lighter regions list won't work because Secret Manager
  # user-managed replication is wired across all 3, so keep the default.
  # regions = { us = "us-central1", eu = "europe-west4", ap = "asia-northeast3" }

  # Start in shadow mode so we can tune SDP templates before blocking traffic.
  model_armor_enforce = false

  # Lock GitHub Actions federation to a specific dev fork if needed.
  github_repo_owner = "ComBba"
  github_repo_name  = "social-seeding-v2"

  # Leave IdPs disabled for the dev project — Identity Platform IdPs are only
  # configured against staging + prod tenants.
  # identity_platform_google_oauth_client_id = ""
  # workforce_oidc_issuer_uri                = ""

  labels = {
    product    = "social-seeding-v2"
    managed-by = "terraform"
    module     = "security"
    env        = "dev"
  }
}

# --- Sample consumption ----------------------------------------------------
# These outputs surface a handful of common downstream lookups so the example
# doubles as documentation of how sibling modules will consume this module.

output "spanner_cmek_us" {
  description = "CMEK key ID for the US Spanner instance (consumed by modules/data)."
  value       = module.security.cmek_key_ids["us-spanner"]
}

output "firestore_cmek_eu" {
  description = "CMEK key ID for the EU Firestore database."
  value       = module.security.cmek_key_ids["eu-firestore"]
}

output "rapidapi_secret_id" {
  description = "Secret Manager resource ID for the RapidAPI key (consumed by modules/compute env mount)."
  value       = module.security.secret_ids["rapidapi"]
}

output "github_workload_provider" {
  description = "Pass this to google-github-actions/auth via the workload_identity_provider input."
  value       = module.security.workload_provider_name
}

output "model_armor_templates" {
  description = "Wire these into Agent Runtime / Agent Gateway extension config (modules/ai)."
  value = {
    input  = module.security.model_armor_input_template
    output = module.security.model_armor_output_template
    mode   = module.security.model_armor_enforcement_mode
  }
}
