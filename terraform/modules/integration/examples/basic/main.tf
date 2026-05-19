# examples/basic/main.tf — minimal callable example for the integration module.
#
# This example deploys the FULL set of integration resources against a real
# project. Service-account emails + service endpoints are wired with
# placeholder values — replace these before `terraform apply` against
# anything you care about.
#
# Run:
#   terraform init
#   terraform plan -var-file=terraform.tfvars
#
# DO NOT `terraform apply` without:
#   1. A real GCP project with the APIs from day-1-setup.sh enabled.
#   2. The security module already applied (KMS key + service accounts).
#   3. The compute module pre-applied so service_endpoints resolve.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.10.0, < 7.0.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 6.10.0, < 7.0.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.primary_region
}

provider "google-beta" {
  project = var.project_id
  region  = var.primary_region
}

variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "primary_region" {
  description = "Primary region (default asia-northeast3 per D13/D31)."
  type        = string
  default     = "asia-northeast3"
}

variable "workflows_invoker_sa_email" {
  description = "Service account email used by Workflows / Scheduler / Eventarc."
  type        = string
}

variable "pubsub_publisher_sa_email" {
  description = "Service account email used by agents + Apigee to publish."
  type        = string
}

variable "cmek_key_id" {
  description = "Cloud KMS CryptoKey for CMEK encryption (D20)."
  type        = string
}

# Service endpoints — replace with module outputs from compute / ai modules.
variable "observability_url" { type = string }
variable "policy_url" { type = string }
variable "campaign_repo_url" { type = string }
variable "agent_runtime_url" { type = string }
variable "pick_shortlist_url" { type = string }
variable "creator_directory_url" { type = string }
variable "callback_router_url" { type = string }
variable "approvals_api_url" { type = string }
variable "gate_predicate_url" { type = string }

module "integration" {
  source = "../.."

  project_id     = var.project_id
  primary_region = var.primary_region

  workflows_invoker_sa_email = var.workflows_invoker_sa_email
  pubsub_publisher_sa_email  = var.pubsub_publisher_sa_email
  cmek_key_id                = var.cmek_key_id

  service_endpoints = {
    observability_url     = var.observability_url
    policy_url            = var.policy_url
    campaign_repo_url     = var.campaign_repo_url
    agent_runtime_url     = var.agent_runtime_url
    pick_shortlist_url    = var.pick_shortlist_url
    creator_directory_url = var.creator_directory_url
    callback_router_url   = var.callback_router_url
    approvals_api_url     = var.approvals_api_url
    gate_predicate_url    = var.gate_predicate_url
  }

  labels = {
    example     = "basic"
    cost_center = "track2"
  }
}

# ── Surface a handful of the module outputs for quick verification ───────

output "topic_count" {
  description = "Should be 15 per D18 inventory."
  value       = length(module.integration.pubsub_topics)
}

output "queue_count" {
  description = "Should be 4 (outreach-send, carrier-poll, fcm-push, cost-alert)."
  value       = length(module.integration.cloud_tasks_queues)
}

output "workflow_count" {
  description = "Should be 5 (brand-campaign, creator-track, gate, gmail-watch-renew, report-deliver-cron)."
  value       = length(module.integration.workflows)
}

output "cron_count" {
  description = "Should be 5 cron jobs."
  value       = length(module.integration.scheduler_jobs)
}

output "summary" {
  description = "Single-line module summary."
  value       = module.integration.integration_summary
}
