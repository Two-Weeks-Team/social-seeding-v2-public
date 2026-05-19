# examples/basic/main.tf — minimum-viable invocation of modules/devops
#
# Use this for `terraform init && terraform validate` smoke tests after
# editing the module. It does NOT apply cleanly without a real project +
# real VPC (see comments below), but it exercises every required variable
# and the resource graph at plan time.

terraform {
  required_version = ">= 1.6.0"
}

provider "google" {
  project = var.project_id
  region  = "us-central1"
}

provider "google-beta" {
  project = var.project_id
  region  = "us-central1"
}

# In a real apply, these come from the networking module — for the basic
# example we accept them as inputs so the example is plan-clean against any
# pre-existing VPC.
variable "project_id" {
  type    = string
  default = "ss-v2-prod-shared"
}

variable "workstations_network" {
  type        = string
  description = "Self-link of an existing VPC. Pass `module.networking.vpc_self_link` in a real apply."
  default     = "projects/ss-v2-prod-shared/global/networks/default"
}

variable "workstations_subnetwork" {
  type        = string
  description = "Self-link of an existing regional subnetwork in us-central1. Pass `module.networking.subnet_self_links[\"us-central1\"]` in a real apply."
  default     = "projects/ss-v2-prod-shared/regions/us-central1/subnetworks/default"
}

# Minimum-viable invocation. Every other knob takes the module default.
module "devops" {
  source = "../.."

  project_id     = var.project_id
  primary_region = "us-central1"
  regions        = ["us-central1", "europe-west1", "asia-northeast3"]

  github_owner      = "ComBba"
  github_repository = "social-seeding-v2"

  workstations_network    = var.workstations_network
  workstations_subnetwork = var.workstations_subnetwork

  labels = {
    environment = "example"
    purpose     = "module-smoke-test"
  }
}

# Echo the most-consumed outputs so `terraform plan` lists them.
output "ci_sa" {
  value = module.devops.cloud_build_service_account_email
}

output "cd_sa" {
  value = module.devops.cloud_deploy_service_account_email
}

output "primary_docker_repo" {
  value = module.devops.artifact_registry_docker_repo_url_primary
}

output "wif_provider" {
  value = module.devops.workload_identity_provider
}
