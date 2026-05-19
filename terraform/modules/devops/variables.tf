# variables.tf — devops module inputs
#
# Decision anchors:
#   D13 — Global multi-region active-active (US + EU + APAC). 3-region fan-out.
#   D17 — Vertex AI Agent Runtime is the managed agent target.
#   D37 — 5-layer test pyramid + per-PR (8-stage, 12-min) + nightly.
#   D38 — Tier-3 worker agents each get a Cloud Workstation (per-agent dev env).
#   D39 — $1500 GCP credit envelope. Defaults sized for ~$570/mo devops spend.

variable "project_id" {
  description = "GCP project ID hosting all devops surfaces."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{5,29}$", var.project_id))
    error_message = "project_id must match GCP project-ID rules (6-30 chars, lowercase + digits + hyphens; starts with a letter)."
  }
}

variable "regions" {
  description = "Active-active regions (D13). Artifact Registry repos + Cloud Deploy targets fan out across this list."
  type        = list(string)
  default     = ["us-central1", "europe-west1", "asia-northeast3"]
  validation {
    condition     = length(var.regions) >= 1 && length(var.regions) <= 5
    error_message = "regions must contain between 1 and 5 entries."
  }
}

variable "primary_region" {
  description = "Region for singletons (Workstations cluster, Build private pool, Deploy pipeline). Must appear in `regions`."
  type        = string
  default     = "us-central1"
}

variable "labels" {
  description = "Common labels. Module appends module=devops + managed_by=terraform."
  type        = map(string)
  default     = {}
}

# Source control / WIF -------------------------------------------------------

variable "github_owner" {
  description = "GitHub org/user owning the repo. Wires Cloud Build triggers + WIF without service-account keys."
  type        = string
}

variable "github_repository" {
  description = "GitHub repository name without the owner prefix."
  type        = string
}

variable "github_main_branch" {
  description = "Branch regex that fires the per-PR pipeline (MATRIX §7.1)."
  type        = string
  default     = "^main$"
}

variable "enable_workload_identity_federation" {
  description = "Create the WIF pool + provider for GitHub Actions. Per workspace CLAUDE.md security rail (no SA JSON keys)."
  type        = bool
  default     = true
}

# Artifact Registry ----------------------------------------------------------

variable "artifact_repo_formats" {
  description = "Package formats provisioned per region. Default = DOCKER + PYTHON + NPM (D37 stack)."
  type        = list(string)
  default     = ["DOCKER", "PYTHON", "NPM"]
  validation {
    condition     = alltrue([for f in var.artifact_repo_formats : contains(["DOCKER", "PYTHON", "NPM", "MAVEN", "GO"], f)])
    error_message = "artifact_repo_formats may only contain DOCKER | PYTHON | NPM | MAVEN | GO."
  }
}

variable "artifact_cleanup_keep_count" {
  description = "Tagged images retained per repo. Older untagged images age out after 14 days. (DEVOPS §A.3)"
  type        = number
  default     = 50
}

variable "artifact_immutable_tags" {
  description = "Disallow re-tagging once a tag exists. Required for SLSA L3 chain (D37)."
  type        = bool
  default     = true
}

# Cloud Build ----------------------------------------------------------------

variable "build_private_pool_machine_type" {
  description = "Private-pool worker machine type. e2-standard-4 keeps PR budget tight; bump to n2d-standard-8 for nightly fan-out."
  type        = string
  default     = "e2-standard-4"
}

variable "build_private_pool_disk_size_gb" {
  description = "Disk size per Cloud Build worker (GB)."
  type        = number
  default     = 100
}

variable "build_private_pool_egress" {
  description = "PUBLIC_EGRESS keeps RapidAPI/GitHub direct; NO_PUBLIC_EGRESS routes through VPC (use once production secrets live behind PSC)."
  type        = string
  default     = "PUBLIC_EGRESS"
  validation {
    condition     = contains(["PUBLIC_EGRESS", "NO_PUBLIC_EGRESS"], var.build_private_pool_egress)
    error_message = "build_private_pool_egress must be PUBLIC_EGRESS or NO_PUBLIC_EGRESS."
  }
}

variable "build_pr_timeout_seconds" {
  description = "Hard cap for per-PR pipeline. MATRIX §7.1 = 12 min + 30% headroom."
  type        = number
  default     = 1000
}

variable "build_nightly_timeout_seconds" {
  description = "Hard cap for nightly pipeline. MATRIX §7.2 = 4.5h + 30% headroom."
  type        = number
  default     = 21000
}

variable "nightly_cron" {
  description = "Cron schedule (UTC) for the nightly pipeline. MATRIX §7.2 anchors to 02:00 UTC."
  type        = string
  default     = "0 2 * * *"
}

# Cloud Deploy ---------------------------------------------------------------

variable "deploy_canary_percentages" {
  description = "Canary phase percentages. Task brief: 10% → SLO check → 100%; we keep the 50% step DEVOPS §A.2 recommends so burn is sampled twice."
  type        = list(number)
  default     = [10, 50]
  validation {
    condition     = alltrue([for p in var.deploy_canary_percentages : p > 0 && p < 100])
    error_message = "Canary percentages must be strictly between 0 and 100."
  }
}

variable "deploy_canary_verify" {
  description = "Run verification between canary phases (wires the 5-min SLO burn check per MATRIX §7.3)."
  type        = bool
  default     = true
}

variable "deploy_slo_burn_threshold" {
  description = "SLO burn-rate multiplier that auto-rolls-back the canary. MATRIX §7.3 = 2x baseline."
  type        = number
  default     = 2.0
}

variable "deploy_freeze_windows" {
  description = "Free-form descriptions of freeze windows. Non-empty list adds a weekly weekend-freeze deploy policy."
  type        = list(string)
  default     = []
}

# Cloud Workstations (D38) ---------------------------------------------------

variable "workstations_network" {
  description = "Self-link of the VPC the Workstations cluster attaches to. Must reach Spanner / AlloyDB / Firestore via PSC."
  type        = string
}

variable "workstations_subnetwork" {
  description = "Self-link of the regional subnetwork inside `workstations_network`. Must live in `primary_region`."
  type        = string
}

variable "workstations_engineer_machine_type" {
  description = "Per-engineer workstation machine type. e2-standard-8 per DEVOPS §A.5."
  type        = string
  default     = "e2-standard-8"
}

variable "workstations_agent_worker_machine_type" {
  description = "Per-worker workstation machine type (D38 Tier-3). Smaller because workers are short-lived."
  type        = string
  default     = "e2-standard-4"
}

variable "workstations_idle_timeout_seconds" {
  description = "Idle seconds before auto-stop. DEVOPS §A.5 cost-control = 1h."
  type        = number
  default     = 3600
}

variable "workstations_running_timeout_seconds" {
  description = "Maximum continuous running time before forced refresh."
  type        = number
  default     = 36000
}

variable "workstations_disable_public_ip" {
  description = "Private workstations (no public IP). DEVOPS §A.5 + workspace CLAUDE.md security rail."
  type        = bool
  default     = true
}

# Notification routing (D32) -------------------------------------------------

variable "notification_pubsub_topic" {
  description = "Push endpoint that receives Build + Deploy failure events for PagerDuty / Slack fan-out. Null = skip wiring."
  type        = string
  default     = null
}
