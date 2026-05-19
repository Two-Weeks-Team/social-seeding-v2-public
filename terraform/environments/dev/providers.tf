# =============================================================================
# providers.tf — dev environment provider pinning
#
# Decision anchors:
#   - D44 (per-env root configs).
#   - Provider floor 6.20 satisfies every module's required_providers
#     constraint (compute/data >= 6.20.0; security ~> 6.20; integration
#     >= 6.10.0; ai ~> 6.0; networking/observability/devops >= 5.40.0).
#   - Upper bound < 7.0.0 protects against the next breaking major.
#
# Authentication:
#   - dev uses Application Default Credentials (ADC). Operators run
#     `gcloud auth application-default login` before `terraform init`. No
#     service-account JSON keys (D38 — WIF is enforced).
#   - For CI: GitHub Actions federates into the dev WIF pool emitted by the
#     security module (output `workload_pool_name`). The root config does not
#     embed any credential paths.
# =============================================================================

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.20"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.20"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.primary_region

  default_labels = {
    managed_by  = "terraform-env-dev"
    d_id        = "D44"
    environment = "dev"
    product     = "social-seeding-v2"
  }
}

provider "google-beta" {
  project = var.project_id
  region  = var.primary_region

  default_labels = {
    managed_by  = "terraform-env-dev"
    d_id        = "D44"
    environment = "dev"
    product     = "social-seeding-v2"
  }
}
