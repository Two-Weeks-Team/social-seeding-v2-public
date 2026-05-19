# terraform/modules/networking/examples/basic/variables.tf

variable "host_project_id" {
  description = "Shared VPC host project (default per SERVICE-INVENTORY §13: ss-shared-infra)."
  type        = string
  default     = "ss-shared-infra"
}

variable "service_project_ids" {
  description = "Per-region service projects that attach to the Shared VPC (D13)."
  type        = list(string)
  default = [
    "ss-v2-prod-us",
    "ss-v2-prod-eu",
    "ss-v2-prod-apac",
  ]
}

variable "access_policy_id" {
  description = "Access Context Manager org-level policy numeric ID. `gcloud access-context-manager policies list`."
  type        = string
}

variable "iap_brand_support_email" {
  description = "OAuth consent screen support email shown by IAP (D19)."
  type        = string
  default     = "ops@socialseed.ing"
}

variable "iap_member_groups" {
  description = "Google / Workforce IF groups allowed through IAP."
  type        = list(string)
  default = [
    "group:agent-operators@socialseed.ing",
  ]
}

variable "corp_cidrs" {
  description = "Office / VPN CIDRs eligible for VPC-SC break-glass access level (D19)."
  type        = list(string)
  default     = []
}
