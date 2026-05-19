# terraform/modules/networking/variables.tf
#
# Inputs for TF-Module-3.
# Decision anchors:
#   D13  Global multi-region active-active (US + EU + APAC)
#   D14  RapidAPI egress requires deterministic NAT IPs
#   D19  IAP + Workforce IF for staff break-glass
#   D20  CMEK + VPC-SC perimeter around Vertex / Spanner / Firestore / GCS
#   D26  Mission Control + Dialogflow CX + mobile PWA (Cloud DNS subdomains)
#   D31  Enterprise SLO -> Cloud Service Mesh (mTLS) and global LB

###############################################################################
# Identity / project layout
###############################################################################

variable "host_project_id" {
  description = "Shared VPC host project ID. Per D20 / SERVICE-INVENTORY §13 = `ss-shared-infra`."
  type        = string
}

variable "service_project_ids" {
  description = "Service projects that attach to the Shared VPC. Typical: ss-v2-prod-us, ss-v2-prod-eu, ss-v2-prod-apac, ss-mcp-prod."
  type        = list(string)
  default     = []
}

variable "access_policy_id" {
  description = "Access Context Manager parent policy numeric ID (org-scoped). VPC-SC perimeter (D20) attaches here. Format: `1234567890`."
  type        = string
}

variable "labels" {
  description = "Labels merged onto every labelable resource."
  type        = map(string)
  default = {
    managed-by = "terraform"
    module     = "networking"
    decisions  = "d13-d20-d31"
  }
}

###############################################################################
# Regions (D13 — active-active across US + EU + APAC)
###############################################################################

variable "regions" {
  description = <<-EOT
    Per-region subnet + NAT + PSC + Service Mesh wiring (D13).
    `nat_ip_count` controls how many static IPs the deterministic NAT pool reserves per region (D14).
    `psc_cidr` must not overlap subnet primary or pod/service secondaries.
  EOT
  type = map(object({
    primary_cidr   = string
    pods_cidr      = string
    services_cidr  = string
    psc_cidr       = string
    nat_ip_count   = number
    psc_endpoint_ip = string
  }))
  default = {
    "us-central1" = {
      primary_cidr    = "10.10.0.0/20"
      pods_cidr       = "10.20.0.0/14"
      services_cidr   = "10.24.0.0/20"
      psc_cidr        = "10.30.0.0/24"
      nat_ip_count    = 3
      psc_endpoint_ip = "10.30.0.10"
    }
    "europe-west1" = {
      primary_cidr    = "10.40.0.0/20"
      pods_cidr       = "10.50.0.0/14"
      services_cidr   = "10.54.0.0/20"
      psc_cidr        = "10.60.0.0/24"
      nat_ip_count    = 3
      psc_endpoint_ip = "10.60.0.10"
    }
    "asia-northeast3" = {
      primary_cidr    = "10.70.0.0/20"
      pods_cidr       = "10.80.0.0/14"
      services_cidr   = "10.84.0.0/20"
      psc_cidr        = "10.90.0.0/24"
      nat_ip_count    = 3
      psc_endpoint_ip = "10.90.0.10"
    }
  }
}

###############################################################################
# Naming / VPC
###############################################################################

variable "name_prefix" {
  description = "Prefix applied to every named resource. Keeps multi-env collision risk low."
  type        = string
  default     = "ss-v2"
}

variable "vpc_routing_mode" {
  description = "Global routing keeps inter-region traffic on Google backbone (required for D13 active-active)."
  type        = string
  default     = "GLOBAL"
  validation {
    condition     = contains(["GLOBAL", "REGIONAL"], var.vpc_routing_mode)
    error_message = "vpc_routing_mode must be GLOBAL or REGIONAL."
  }
}

variable "vpc_mtu" {
  description = "MTU for the Shared VPC. 1500 is safest cross-cloud; 1460 is GCP default."
  type        = number
  default     = 1500
}

###############################################################################
# DNS (D26)
###############################################################################

variable "dns_zones" {
  description = "Public managed zones keyed by short name. Per D26 socialseed.ing + mcp.socialseed.ing."
  type = map(object({
    dns_name   = string
    dnssec     = bool
    visibility = string # public | private
  }))
  default = {
    apex = {
      dns_name   = "socialseed.ing."
      dnssec     = true
      visibility = "public"
    }
    mcp = {
      dns_name   = "mcp.socialseed.ing."
      dnssec     = true
      visibility = "public"
    }
  }
}

variable "private_dns_zone" {
  description = "Private DNS zone used by Cloud Service Mesh + internal Cloud Run services."
  type        = string
  default     = "internal.socialseed."
}

###############################################################################
# TLS / Certificate Manager
###############################################################################

variable "managed_cert_domains" {
  description = "Google-managed cert domains attached to the global HTTPS LB. Per D26 covers Mission Control + Dialogflow CX admin + APIs."
  type        = list(string)
  default = [
    "app.socialseed.ing",
    "api.socialseed.ing",
    "admin.socialseed.ing",
    "mcp.socialseed.ing",
  ]
}

###############################################################################
# Cloud Armor (D21 says enforce, NETSEC §1.4 says start preview)
###############################################################################

variable "armor_enable_preview" {
  description = "If true every WAF rule lands in preview mode (NETSEC §1.4 onboarding pattern). Flip to false to enforce after baseline observed."
  type        = bool
  default     = false
}

variable "armor_rate_limit_threshold" {
  description = "req/min per IP for the /api/agent/run hot path (NETSEC §1.4)."
  type        = number
  default     = 30
}

variable "armor_adaptive_protection" {
  description = "Enable Cloud Armor Adaptive Protection (L7 DDoS auto-baseline). Per D21 watchdog feed."
  type        = bool
  default     = true
}

###############################################################################
# IAP (D19 — staff break-glass into Mission Control + Dialogflow CX admin)
###############################################################################

variable "iap_brand_support_email" {
  description = "OAuth consent screen support email shown by IAP. Must be a domain user or workspace group."
  type        = string
}

variable "iap_member_groups" {
  description = "Workforce IF / Google groups that may pass IAP into internal endpoints."
  type        = list(string)
  default     = []
}

###############################################################################
# VPC Service Controls (D20)
###############################################################################

variable "vpc_sc_restricted_services" {
  description = <<-EOT
    Services pulled inside the VPC-SC perimeter per D20.
    Default = the four services the brief calls out explicitly + the ones that hold prompts/PII.
  EOT
  type        = list(string)
  default = [
    "aiplatform.googleapis.com",
    "spanner.googleapis.com",
    "firestore.googleapis.com",
    "storage.googleapis.com",
    "bigquery.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "pubsub.googleapis.com",
    "cloudfunctions.googleapis.com",
    "run.googleapis.com",
  ]
}

variable "vpc_sc_dry_run" {
  description = "Start the perimeter in dry-run (NETSEC §1.5 best practice). Flip to false after audit logs are clean."
  type        = bool
  default     = true
}

variable "vpc_sc_corp_cidrs" {
  description = "Corp CIDR ranges allowed to break glass through VPC-SC ingress (D19 staff path)."
  type        = list(string)
  default     = []
}

###############################################################################
# Cloud Service Mesh (D31)
###############################################################################

variable "enable_service_mesh" {
  description = "Enable Cloud Service Mesh fleet feature for mTLS across Cloud Run + Agent Runtime + GKE (D31 enterprise SLO)."
  type        = bool
  default     = true
}
