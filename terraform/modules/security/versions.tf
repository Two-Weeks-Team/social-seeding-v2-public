# terraform/modules/security/versions.tf
#
# Provider pinning for the social-seeding-v2 security module.
#
# Per ARMOR-GATEWAY.md §6 the Model Armor + Agent Gateway resources are still
# on the google-beta surface, so both providers are required. Pinned to v6.x
# because google_model_armor_template and google_model_armor_floor_setting
# landed in google-beta v6.6.0+. (D21 — Model Armor max policy.)

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
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
