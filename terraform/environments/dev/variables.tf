# =============================================================================
# variables.tf — dev environment input declarations
#
# Decision anchors:
#   - D44 (per-env root config; this file only declares vars the operator
#     supplies via terraform.tfvars or env vars).
#   - Dev tier: single-region usage allowed for cost; modules still accept
#     `regions = ["us-central1"]` cleanly. CMEK + Spanner multi-region are
#     defaulted OFF to keep dev under the D39 $1500 credit envelope.
# =============================================================================

variable "project_id" {
  description = "GCP project ID hosting the dev workspace (e.g. ss-v2-dev-us)."
  type        = string
}

variable "project_number" {
  description = "Numeric GCP project number for `project_id`. Used by the security + ai modules for service-agent IAM bindings."
  type        = string
}

variable "org_id" {
  description = "Numeric GCP organization ID. Consumed by the security module (Workforce Identity Federation, SCC sources)."
  type        = string
}

variable "host_project_id" {
  description = "Shared VPC host project ID. For dev this is typically the same as `project_id` (single-project dev) or a dedicated `ss-shared-infra-dev` host."
  type        = string
}

variable "access_policy_id" {
  description = "Access Context Manager parent policy numeric ID (org-scoped). VPC-SC perimeter attaches here."
  type        = string
}

variable "billing_account_id" {
  description = "GCP billing account ID (AAAAAA-BBBBBB-CCCCCC). Required for budget alerts. Leave empty to skip budget resources."
  type        = string
  default     = ""
}

variable "primary_region" {
  description = "Primary region for dev singletons (Workstations cluster, Build private pool, integration module)."
  type        = string
  default     = "us-central1"
}

variable "regions" {
  description = "Regions to provision compute/observability across. Dev defaults to a single region for cost; flip to the full D13 trio when stress-testing replication paths."
  type        = list(string)
  default     = ["us-central1"]
}

variable "github_owner" {
  description = "GitHub repo owner/org for the dev WIF pool + Cloud Build trigger."
  type        = string
  default     = "ComBba"
}

variable "github_repository" {
  description = "GitHub repository name (without owner prefix)."
  type        = string
  default     = "social-seeding-v2"
}

variable "iap_brand_support_email" {
  description = "OAuth consent screen support email shown by IAP."
  type        = string
}

variable "alloydb_initial_password_secret" {
  description = "Secret Manager secret ID holding the AlloyDB bootstrap password. Operator creates the secret out-of-band; this references its short name."
  type        = string
  default     = "alloydb-bootstrap"
}

variable "workstations_network_self_link" {
  description = "VPC self-link for the Cloud Workstations cluster. Defaults to '' meaning the devops module will plumb the value from the networking module output."
  type        = string
  default     = ""
}

variable "workstations_subnetwork_self_link" {
  description = "Subnetwork self-link for the Workstations cluster (must be in primary_region)."
  type        = string
  default     = ""
}

variable "email_alert_recipients" {
  description = "Dev on-call email list. Empty list skips email notification channel creation."
  type        = list(string)
  default     = []
}
