# =============================================================================
# providers.tf — prod environment provider pinning
#
# Decision anchors:
#   - D13 (3-region active-active: us-central1, europe-west4, asia-northeast3
#     — provider declares the primary region, modules fan out via
#     for_each over var.regions).
#   - D38 (Workload Identity Federation — no SA JSON keys).
#   - D44 (per-env root configs).
#
# Provider pin rationale: ~> 6.20 is the floor every module needs (compute &
# data require 6.20+; security pins ~> 6.20; integration 6.10+; ai 6.x; the
# legacy 5.40+ modules accept ~> 6.20 because their constraints are open-ended
# upward). Upper bound < 7.0.0 guards against the next breaking major.
#
# Authentication (prod):
#   - Humans: WIF + ephemeral access tokens (`gcloud auth print-access-token`).
#   - CI: GitHub Actions federates via the WIF pool emitted by the security
#     module (output `workload_provider_name`). No JSON keys committed.
#   - Plan: dual operator approval (G2 gate) before any `terraform apply`.
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
    managed_by  = "terraform-env-prod"
    d_id        = "D44"
    environment = "prod"
    product     = "social-seeding-v2"
  }
}

provider "google-beta" {
  project = var.project_id
  region  = var.primary_region

  default_labels = {
    managed_by  = "terraform-env-prod"
    d_id        = "D44"
    environment = "prod"
    product     = "social-seeding-v2"
  }
}
