# terraform/modules/networking/versions.tf
#
# Provider pinning for TF-Module-3 (networking).
# - google         5.40+   (Cloud Armor advanced_options_config, IAP settings GA, NAT64)
# - google-beta    5.40+   (Cloud Service Mesh fleet feature, VPC-SC granular controls)
# We use google-beta for resources still in beta as of 2026-05:
#   * google_gke_hub_feature["servicemesh"] (Cloud Service Mesh enablement)
#   * google_access_context_manager_service_perimeter granular ingress/egress
#   * google_compute_security_policy advanced bot-management fields

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.40.0, < 7.0.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 5.40.0, < 7.0.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
