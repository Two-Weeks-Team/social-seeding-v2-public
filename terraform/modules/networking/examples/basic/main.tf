# terraform/modules/networking/examples/basic/main.tf
#
# Minimal-viable invocation of the networking module.
# Run order:
#   terraform init
#   terraform plan -var-file=basic.tfvars
#   terraform apply -var-file=basic.tfvars
#
# Expectations:
#   - The host project (ss-shared-infra) already exists and the runner has
#     `roles/resourcemanager.projectIamAdmin` + `roles/compute.xpnAdmin`.
#   - An Access Context Manager access policy exists at the org level.
#   - DNS zones for socialseed.ing are either delegated to Google or the operator
#     will add the emitted CNAMEs at the upstream registrar after this apply.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    google      = { source = "hashicorp/google", version = ">= 5.40.0, < 7.0.0" }
    google-beta = { source = "hashicorp/google-beta", version = ">= 5.40.0, < 7.0.0" }
  }
}

provider "google" {
  project = var.host_project_id
  region  = "us-central1"
}

provider "google-beta" {
  project = var.host_project_id
  region  = "us-central1"
}

module "networking" {
  source = "../../"

  host_project_id     = var.host_project_id
  service_project_ids = var.service_project_ids
  access_policy_id    = var.access_policy_id

  # D26 — production hostnames
  managed_cert_domains = [
    "app.socialseed.ing",
    "api.socialseed.ing",
    "admin.socialseed.ing",
    "mcp.socialseed.ing",
  ]

  iap_brand_support_email = var.iap_brand_support_email
  iap_member_groups       = var.iap_member_groups

  # Stage 1: observe before enforce.
  vpc_sc_dry_run       = true
  armor_enable_preview = true
  vpc_sc_corp_cidrs    = var.corp_cidrs
}

output "global_lb_ip" {
  description = "Point your DNS A records here once Terraform finishes."
  value       = module.networking.global_lb_ip
}

output "nat_egress_ips" {
  description = "Hand these to RapidAPI for the allowlist (D14)."
  value       = module.networking.nat_ip_addresses
}

output "dns_authorization_records" {
  description = "Add these CNAMEs upstream to unblock managed-cert issuance."
  value       = module.networking.dns_authorization_records
}

output "service_perimeter_name" {
  description = "Verify this perimeter is in dry-run for the first 7 days."
  value       = module.networking.service_perimeter_name
}

output "decision_audit" {
  description = "Decision-trace map. Read in /sc:reflect."
  value       = module.networking.decision_audit
}
