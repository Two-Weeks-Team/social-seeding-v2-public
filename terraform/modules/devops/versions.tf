# versions.tf — provider + Terraform pins for the devops module
#
# D37 (TDD layers — Cloud Build + Cloud Deploy + Agent Eval) and D38
# (PreviewForge-style agent hierarchy — workers run in Cloud Workstations)
# both require beta-tier features (Cloud Deploy canary verify on Cloud Run,
# Cloud Workstations idle-timeout per-config, Artifact Analysis attestation
# on push). Pin both `google` and `google-beta` against the same minimum.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.30.0, < 7.0.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 5.30.0, < 7.0.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
  }
}
