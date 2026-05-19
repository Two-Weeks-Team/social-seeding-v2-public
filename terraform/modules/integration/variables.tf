# variables.tf — inputs for the integration module
#
# The module is region-pinnable (D31 multi-region readiness) but defaults to
# a single primary region. The 5 cron schedules and Apigee organization are
# global; Pub/Sub topics are global but their subscriptions are regional;
# Workflows + Cloud Tasks + Scheduler + Eventarc are regional resources.

variable "project_id" {
  description = "GCP project ID hosting all integration resources (single project per D18 inventory)."
  type        = string
}

variable "primary_region" {
  description = "Primary region for regional resources (Workflows, Cloud Tasks, Cloud Scheduler, Eventarc bus). D13 multi-region active-active deploys this module twice."
  type        = string
  default     = "asia-northeast3"
}

variable "service_endpoints" {
  description = <<-EOT
    Service URLs the Workflows YAML resolves via sys.get_env(). These are
    Cloud Run / Agent Runtime URLs created by the compute module. Pass empty
    strings for endpoints not yet deployed — the workflow YAML files have
    safe defaults but executions will fail at runtime.

    Required keys:
      - observability_url       (packages/observability runs API)
      - policy_url              (workspace policy lookup)
      - campaign_repo_url       (campaign / track repository capability)
      - agent_runtime_url       (Vertex AI Agent Runtime — sourcing, vetting, etc.)
      - pick_shortlist_url      (deterministic shortlist picker)
      - creator_directory_url   (creator → email resolver)
      - callback_router_url     (correlation lookup → Workflows callback URL)
      - approvals_api_url       (POST /create + PATCH callback-url)
      - gate_predicate_url      (POST /evaluate-predicate — preserves gate.test.ts)
  EOT
  type = object({
    observability_url     = string
    policy_url            = string
    campaign_repo_url     = string
    agent_runtime_url     = string
    pick_shortlist_url    = string
    creator_directory_url = string
    callback_router_url   = string
    approvals_api_url     = string
    gate_predicate_url    = string
  })
}

variable "workflows_invoker_sa_email" {
  description = "Service account that Cloud Scheduler / Eventarc / Pub/Sub push subscriptions use to invoke Cloud Workflows. Created by the security module."
  type        = string
}

variable "pubsub_publisher_sa_email" {
  description = "Service account that Apigee, Cloud Run capabilities, and agents use to publish to Pub/Sub topics. Created by the security module."
  type        = string
}

variable "cmek_key_id" {
  description = "Fully-qualified Cloud KMS CryptoKey ID for Pub/Sub + Cloud Tasks payload encryption (D20 CMEK across all stores). Format: projects/P/locations/L/keyRings/R/cryptoKeys/K."
  type        = string
}

variable "message_retention_duration" {
  description = "Pub/Sub topic message retention. day-1-setup.sh uses 7d; we keep that default (D33 audit log lifecycle leaves Pub/Sub at 7d, BigQuery does the 90d retention)."
  type        = string
  default     = "604800s" # 7 days
}

variable "dead_letter_max_attempts" {
  description = "Max delivery attempts before a Pub/Sub message routes to its DLQ topic. Aligns with Cloud Tasks default of 5 (D32 alerting catches DLQ growth)."
  type        = number
  default     = 5

  validation {
    condition     = var.dead_letter_max_attempts >= 5 && var.dead_letter_max_attempts <= 100
    error_message = "Dead-letter max attempts must be in [5, 100] per Pub/Sub limits."
  }
}

variable "subscription_ack_deadline_seconds" {
  description = "Default ack deadline for Pub/Sub pull subscriptions. 600s matches Cloud Run request timeout ceiling."
  type        = number
  default     = 600
}

variable "cloud_tasks_queues" {
  description = <<-EOT
    Cloud Tasks queue configuration. Per D18 + INNGEST-MIGRATION §3.2/R3:
      - outreach-send : per-tenant concurrency cap to respect Gmail quotas
      - carrier-poll  : shipment tracking poll (carrier rate-limits)
      - fcm-push      : mobile PWA push notifications (FCM quota: 600k/min)
      - cost-alert    : cost_watch notifications (low volume, high priority)
  EOT
  type = map(object({
    max_concurrent_dispatches = number
    max_dispatches_per_second = number
    max_attempts              = number
    max_retry_duration        = string
    min_backoff               = string
    max_backoff               = string
    max_doublings             = number
  }))
  default = {
    "outreach-send" = {
      max_concurrent_dispatches = 50
      max_dispatches_per_second = 10
      max_attempts              = 5
      max_retry_duration        = "3600s"
      min_backoff               = "10s"
      max_backoff               = "600s"
      max_doublings             = 4
    }
    "carrier-poll" = {
      max_concurrent_dispatches = 20
      max_dispatches_per_second = 5
      max_attempts              = 8
      max_retry_duration        = "21600s" # 6h — carriers can be flaky
      min_backoff               = "60s"
      max_backoff               = "1800s"
      max_doublings             = 5
    }
    "fcm-push" = {
      max_concurrent_dispatches = 200
      max_dispatches_per_second = 100
      max_attempts              = 3
      max_retry_duration        = "300s"
      min_backoff               = "5s"
      max_backoff               = "60s"
      max_doublings             = 3
    }
    "cost-alert" = {
      max_concurrent_dispatches = 10
      max_dispatches_per_second = 5
      max_attempts              = 10
      max_retry_duration        = "7200s"
      min_backoff               = "30s"
      max_backoff               = "600s"
      max_doublings             = 4
    }
  }
}

variable "cron_schedules" {
  description = <<-EOT
    Cloud Scheduler cron expressions for the 5 timed workflows. Ports verbatim
    from INNGEST-MIGRATION.md §3.5 except nightly-eval (D25 learning loop, 02:00 KST).
    Timezone is per-job — Asia/Seoul for KR-business jobs, Etc/UTC for others.
  EOT
  type = map(object({
    schedule    = string
    time_zone   = string
    description = string
    workflow_id = string
  }))
  default = {
    "campaign-progression" = {
      schedule    = "0 3 * * *"
      time_zone   = "Etc/UTC"
      description = "Daily campaign-progression workflow trigger (D18)."
      workflow_id = "campaign-progression"
    }
    "gmail-watch-renew" = {
      schedule    = "0 4 * * 1"
      time_zone   = "Etc/UTC"
      description = "Weekly Gmail watch renew (Gmail watch TTL = 7d; INNGEST-MIGRATION §3.5)."
      workflow_id = "gmail-watch-renew"
    }
    "report-deliver-cron" = {
      schedule    = "0 9 * * *"
      time_zone   = "Asia/Seoul"
      description = "Daily 09:00 KST campaign report delivery (TF-Module-8 brief; INNGEST-MIGRATION §3.5 had this as weekly Mon 09:00 — the brief promotes it to daily for fresher numbers)."
      workflow_id = "report-deliver-cron"
    }
    "tiktok-post-poller" = {
      schedule    = "0 * * * *"
      time_zone   = "Etc/UTC"
      description = "Hourly TikTok post visibility poll (D23 content_verify; TF-Module-8 brief promotes the daily cron in INNGEST-MIGRATION §3.5 to hourly so view counts feed the per-view billing pipeline within the §4.2 latency budget)."
      workflow_id = "tiktok-post-poller"
    }
    "nightly-eval" = {
      schedule    = "0 2 * * *"
      time_zone   = "Asia/Seoul"
      description = "Nightly 02:00 KST Vertex AI Agent Evaluation run (D25 learning loop)."
      workflow_id = "nightly-eval"
    }
  }
}

variable "apigee_config" {
  description = <<-EOT
    Apigee X organization configuration for the per-view monetization gateway (D28).
    Per pricing/MODEL.md §4.3 we run a single Apigee org with three API products:
      - per-view-billing    : the $0.01/$0.008/$0.006 metered product
      - free-tier           : first 10K views/month with quota enforcement
      - enterprise          : custom-commit, 40% discount, SLA 99.99%
    Apigee X uses runtime instances; we keep one instance in the primary region
    to satisfy the open question O-S1 (asia-northeast3 monetization support).
  EOT
  type = object({
    enabled                  = bool
    organization_description = string
    analytics_region         = string
    runtime_type             = string
    billing_type             = string
    authorized_network       = string
    disable_vpc_peering      = bool
  })
  default = {
    enabled                  = true
    organization_description = "Social Seeding v2 — per-view billing gateway (D28)."
    analytics_region         = "asia-northeast1"
    runtime_type             = "CLOUD"
    billing_type             = "PAYG"
    authorized_network       = ""
    disable_vpc_peering      = true
  }
}

variable "api_hub_config" {
  description = "Apigee API Hub (D38) catalog config. The hub indexes OpenAPI + AsyncAPI specs from gcp-research/specs/_common/."
  type = object({
    enabled      = bool
    region       = string
    display_name = string
  })
  default = {
    enabled      = true
    region       = "asia-northeast1"
    display_name = "Social Seeding v2 API Hub"
  }
}

variable "labels" {
  description = "Labels applied to every resource that supports them. Combine with module-managed labels."
  type        = map(string)
  default     = {}
}

variable "workflow_yaml_dir" {
  description = "Local path containing the Workflows YAML definitions. Defaults to the workflows/ subdirectory of this module (terraform/modules/integration/workflows)."
  type        = string
  default     = "workflows"
}

variable "agent_urls" {
  description = <<-EOT
    Per-agent Vertex AI Agent Runtime (D17) endpoint URLs, keyed by agent_id
    from terraform/modules/ai/variables.tf:agent_registry. Sourced from the
    AI module output `agent_urls`, populated at deploy time from
    `terraform output -json` per environment (D42).

    Each YAML workflow resolves its agent endpoint via:
      $${default(map.get(args.agent_urls, "<id>"), sys.get_env("AGENT_URL_<ID>"))}

    The map is exposed in two ways inside the workflow runtime:
      1. As `args.agent_urls` when the caller (manual exec, augmented Cloud
         Scheduler payload, augmented Eventarc transform) injects it.
      2. As individual user_env_vars `AGENT_URL_<UPPER_ID>` (always populated
         from this variable) — the fallback branch.

    Allowed keys: the 22 agent_ids from the registry plus 2 sub-route IDs
    used by creator-track.workflows.yaml ("extract_facts" routes to
    outreach_writer runtime; "classify_reply" routes to conversation runtime).
    See WIRE-NOTES.md §3.

    During Phase 0 (pre-W7) the AI module emits stub URLs of the shape
    "https://stub.local/<agent_id>" so terraform validate passes; W7 fills in
    the actual reasoningEngines URLs.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for k in keys(var.agent_urls) :
      contains([
        # Tier 1 (16)
        "sourcing", "vetting", "outreach_writer", "conversation",
        "conversation_responder", "logistics", "content_verify", "analyst",
        "research", "intake", "lead_outreach_writer", "payment_mandate",
        "compliance", "creative", "a11y", "customer_success",
        # Tier 2 (3)
        "coordinator", "critic", "optimizer",
        # Tier 3 (3)
        "anomaly_watch", "cost_watch", "security_watch",
        # Sub-route synonyms used in creator-track.workflows.yaml
        "extract_facts", "classify_reply",
      ], k)
    ])
    error_message = "agent_urls keys must be a subset of the 22 registry agent_ids plus the 2 documented sub-route synonyms (extract_facts, classify_reply). See WIRE-NOTES.md §3."
  }

  validation {
    condition = alltrue([
      for url in values(var.agent_urls) :
      can(regex("^https?://", url))
    ])
    error_message = "Every agent_urls value must start with http:// or https:// (stub URLs of the form https://stub.local/<id> are acceptable during Phase 0)."
  }
}
