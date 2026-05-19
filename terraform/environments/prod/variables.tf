# =============================================================================
# variables.tf — prod environment input declarations
#
# Decision anchors:
#   - D13 (3-region active-active: us-central1, europe-west4, asia-northeast3).
#   - D20 (CMEK everywhere — rotation 90 d via module default).
#   - D31 (Enterprise SLO 99.99% / p99 < 1s / RTO 1m / RPO 30s).
#   - D44 (per-env root config).
#
# Most production sensitive values arrive via:
#   - `terraform.tfvars` (operator-managed, NOT committed; tracked example in
#     `terraform.tfvars.example`),
#   - or environment variables `TF_VAR_<name>`.
# Never commit real billing-account ids, project numbers, or access-policy ids.
# =============================================================================

variable "project_id" {
  description = "GCP project ID hosting the prod workspace (e.g. ss-v2-prod-us). Per O2 the canonical IDs are ss-v2-prod-{us|eu|ap}; this module is invoked once per project."
  type        = string
}

variable "project_number" {
  description = "Numeric GCP project number for `project_id`."
  type        = string
}

variable "org_id" {
  description = "Numeric GCP organization ID."
  type        = string
}

variable "host_project_id" {
  description = "Shared VPC host project ID. Per D20 + SERVICE-INVENTORY §13 = `ss-shared-infra` in production."
  type        = string
}

variable "access_policy_id" {
  description = "Access Context Manager parent policy numeric ID (org-scoped). VPC-SC perimeter attaches here."
  type        = string
}

variable "billing_account_id" {
  description = "GCP billing account ID (AAAAAA-BBBBBB-CCCCCC) — required in prod for budget alerts (W2 cost_watch)."
  type        = string
}

variable "primary_region" {
  description = "Primary region for singletons (Workstations cluster, Build private pool, integration module). Per D13 use one of us-central1 | europe-west4 | asia-northeast3."
  type        = string
  default     = "us-central1"
}

variable "regions" {
  description = "Active-active regions per D13. Must be three for prod."
  type        = list(string)
  default     = ["us-central1", "europe-west4", "asia-northeast3"]

  validation {
    condition     = length(var.regions) == 3
    error_message = "Production must run in exactly three regions per D13."
  }
}

variable "github_owner" {
  description = "GitHub repo owner/org for the prod WIF pool + Cloud Build trigger."
  type        = string
  default     = "ComBba"
}

variable "github_repository" {
  description = "GitHub repository name (without owner prefix)."
  type        = string
  default     = "social-seeding-v2"
}

variable "iap_brand_support_email" {
  description = "OAuth consent screen support email shown by IAP. Must be a domain user or workspace group."
  type        = string
}

variable "iap_member_groups" {
  description = "Workforce IF / Google groups that may pass IAP into internal endpoints."
  type        = list(string)
  default     = []
}

variable "vpc_sc_corp_cidrs" {
  description = "Corp CIDR ranges allowed to break-glass through VPC-SC ingress (D19 staff path)."
  type        = list(string)
  default     = []
}

variable "workforce_oidc_issuer_uri" {
  description = "OIDC issuer URI for staff SSO (Google Workspace / Okta)."
  type        = string
}

variable "workforce_oidc_client_id" {
  description = "OIDC client ID for staff SSO."
  type        = string
}

variable "identity_platform_google_oauth_client_id" {
  description = "Google OAuth client ID for the customer-facing tenant's Sign-in-with-Google button."
  type        = string
  default     = ""
}

variable "alloydb_initial_password_secret" {
  description = "Secret Manager secret ID holding the AlloyDB bootstrap password (operator-created out-of-band)."
  type        = string
  default     = "alloydb-bootstrap"
}

variable "workstations_network_self_link" {
  description = "VPC self-link for the Cloud Workstations cluster (passed through from the networking module)."
  type        = string
  default     = ""
}

variable "workstations_subnetwork_self_link" {
  description = "Subnetwork self-link for the Workstations cluster (must be in primary_region)."
  type        = string
  default     = ""
}

variable "email_alert_recipients" {
  description = "Production on-call email list. Per D32 always-on fallback channel."
  type        = list(string)
}

variable "pagerduty_service_key_secret_id" {
  description = "Secret Manager secret ID holding the PagerDuty integration key."
  type        = string
  default     = ""
}

variable "slack_webhook_secret_id" {
  description = "Secret Manager secret ID holding the Slack incoming-webhook URL."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "Per-project monthly USD ceiling. W2 cost_watch fires at 50/75/90/95/100 %."
  type        = number
  default     = 5000
}
