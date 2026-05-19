# =============================================================================
# main.tf — dev environment root config
#
# Decision anchors:
#   - D13 (Global active-active) — dev runs in a single region for cost; the
#     same modules are reused via `source = "../../modules/<name>"` in the prod
#     root (D44).
#   - D20 (CMEK) — defaulted ON by the security module; dev keeps default
#     rotation period.
#   - D39 ($1500 credit envelope) — dev sets feature_flags off where they cost
#     real money (Workbench, Pipelines, Apigee, Vector Search).
#   - D42 (agent_urls injected by Terraform output, no hardcoded URLs).
#   - D44 (per-env root config; modules called by relative path).
#
# Apply order (modules implicitly ordered by `depends_on` of outputs/inputs):
#   1. security    (KMS, Secret Manager, WIF) — feeds CMEK keys to data + ai.
#   2. networking  (VPC, NAT, LB, VPC-SC)     — feeds VPC self-links + perimeter.
#   3. data        (Spanner, AlloyDB, BQ)      — feeds DB endpoints.
#   4. ai          (Vertex AI, Memory Bank)    — emits agent_urls (stubs).
#   5. compute     (Cloud Run, GKE Autopilot)  — feeds service URLs.
#   6. integration (Workflows, Pub/Sub, Apigee) — consumes ai + compute outputs.
#   7. devops      (Artifact Registry, Deploy) — orthogonal; depends on net + sec.
#   8. observability (SLOs, dashboards)        — read-only of every module.
# =============================================================================

locals {
  common_labels = {
    managed_by  = "terraform-env-dev"
    d_id        = "D44"
    environment = "dev"
    product     = "social-seeding-v2"
  }
}

# -----------------------------------------------------------------------------
# 1. security — KMS keyrings, Secret Manager, WIF, Model Armor templates.
# -----------------------------------------------------------------------------
module "security" {
  source = "../../modules/security"

  project_id     = var.project_id
  project_number = var.project_number
  org_id         = var.org_id

  # Dev single region — the module's `regions` schema requires us/eu/ap keys.
  regions = {
    us = "us-central1"
    eu = "us-central1" # dev: collapse eu/ap onto us-central1 to avoid 3x KMS cost
    ap = "us-central1"
  }

  # Dev: skip the HSM billing root (expensive); rely on standard CMEK.
  enable_hsm_billing_root = false

  # Model Armor: dev runs in audit-only (INSPECT_ONLY) so engineers iterate
  # without 4xx surprises.
  model_armor_enforce   = false
  model_armor_fail_open = true

  # SCC Premium org-level activation is out of scope for dev.
  enable_scc_premium = false

  workforce_oidc_issuer_uri = "" # dev uses ADC only; no staff SSO
  workforce_oidc_client_id  = ""

  github_repo_owner = var.github_owner
  github_repo_name  = var.github_repository

  labels = local.common_labels
}

# -----------------------------------------------------------------------------
# 2. networking — Shared VPC, NAT (deterministic IPs), Global LB, VPC-SC.
# -----------------------------------------------------------------------------
module "networking" {
  source = "../../modules/networking"

  host_project_id     = var.host_project_id
  service_project_ids = [] # dev is single-project
  access_policy_id    = var.access_policy_id

  regions = {
    "us-central1" = {
      primary_cidr    = "10.10.0.0/20"
      pods_cidr       = "10.20.0.0/14"
      services_cidr   = "10.24.0.0/20"
      psc_cidr        = "10.30.0.0/24"
      nat_ip_count    = 1 # dev: single NAT IP (cost)
      psc_endpoint_ip = "10.30.0.10"
    }
  }

  name_prefix             = "ss-v2-dev"
  iap_brand_support_email = var.iap_brand_support_email

  # Dev keeps VPC-SC in dry-run forever — production flips this.
  vpc_sc_dry_run = true

  # Dev: keep Cloud Armor in preview (no enforcement).
  armor_enable_preview      = true
  armor_adaptive_protection = false

  # Dev: skip service mesh fleet feature to save fleet hub cost.
  enable_service_mesh = false

  labels = local.common_labels
}

# -----------------------------------------------------------------------------
# 3. data — Spanner (single-region in dev), AlloyDB, Firestore, BigQuery, GCS,
#          Memorystore Valkey 8.
# -----------------------------------------------------------------------------
module "data" {
  source = "../../modules/data"

  project_id  = var.project_id
  name_prefix = "ss-v2-dev"
  environment = "dev"

  regions = {
    "us-central1" = {
      location              = "us-central1"
      firestore_location    = "nam5"
      alloydb_cpu_count     = 2 # dev: smallest AlloyDB primary
      alloydb_replica_cpu   = 2
      valkey_shard_count    = 1
      valkey_replica_count  = 0 # dev: no replica
      valkey_node_type      = "STANDARD_SMALL"
      valkey_engine_version = "VALKEY_8_0"
      bigquery_location     = "US"
    }
  }

  # Dev: collapse multi-region key onto the single regional key.
  cmek_keys = {
    "us-central1" = module.security.cmek_key_ids["us-spanner"]
    multi_region  = module.security.cmek_key_ids["us-spanner"]
  }

  spanner_config = {
    instance_config  = "regional-us-central1"
    processing_units = 100 # dev: 0.1 node — minimal cost
    edition          = "STANDARD"
  }

  vpc_networks = {
    "us-central1" = module.networking.vpc_id
  }

  alloydb_initial_password_secret = var.alloydb_initial_password_secret

  enable_deletion_protection = false # dev: allow teardown

  labels = local.common_labels
}

# -----------------------------------------------------------------------------
# 4. ai — Vertex AI Vector Search, Memory Bank, Workbench, Discovery Engine.
# -----------------------------------------------------------------------------
module "ai" {
  source = "../../modules/ai"

  project_id      = var.project_id
  project_number  = var.project_number
  region          = var.primary_region
  environment     = "dev"
  resource_prefix = "ssv2dev"

  network_self_link = module.networking.vpc_id

  agent_runtime_service_account_email  = "agent-runtime@${var.project_id}.iam.gserviceaccount.com"
  data_scientist_service_account_email = "data-science@${var.project_id}.iam.gserviceaccount.com"

  cmek_key_name = "" # dev: CMEK off for Vector Search (still on for stores)

  staging_bucket_name = module.data.asset_buckets["us-central1"]

  # Dev cost guards: keep heavyweight surfaces dark.
  feature_flags = {
    enable_vector_search         = false
    enable_workbench             = false
    enable_pipelines             = false
    enable_dialogflow_cx         = false
    enable_discovery_engine_app  = false
    enable_agent_registry_seed   = true # cheap — just GCS objects
    fail_on_preview_resource_err = false
  }

  tags = local.common_labels
}

# -----------------------------------------------------------------------------
# 5. compute — Cloud Run services + jobs + worker pools, GKE Autopilot.
# -----------------------------------------------------------------------------
module "compute" {
  source = "../../modules/compute"

  project_id = var.project_id
  regions    = var.regions

  agent_runtime_count   = 1
  gke_autopilot_enabled = false # dev: Cloud Run only, no Autopilot cost
  gpu_type              = "nvidia-l4"

  mission_control_min_instances = 0 # dev: scale to zero
  mission_control_max_instances = 3
  worker_pool_instances         = 1

  service_account_runtime   = "agent-runtime@${var.project_id}.iam.gserviceaccount.com"
  service_account_workflows = "workflows-invoker@${var.project_id}.iam.gserviceaccount.com"

  network_self_links = { for r in var.regions : r => module.networking.vpc_id }
  subnet_self_links  = { for r in var.regions : r => module.networking.subnetwork_ids[r] }

  cmek_key_ids = {} # dev: no CMEK on Cloud Run

  labels = local.common_labels
}

# -----------------------------------------------------------------------------
# 6. integration — Pub/Sub, Cloud Tasks, Workflows, Scheduler, Eventarc, Apigee.
# -----------------------------------------------------------------------------
module "integration" {
  source = "../../modules/integration"

  project_id     = var.project_id
  primary_region = var.primary_region

  workflows_invoker_sa_email = "workflows-invoker@${var.project_id}.iam.gserviceaccount.com"
  pubsub_publisher_sa_email  = "pubsub-publisher@${var.project_id}.iam.gserviceaccount.com"

  cmek_key_id = module.security.cmek_key_ids["us-pubsub"]

  # Dev: short retention to keep storage cost low.
  message_retention_duration = "86400s" # 1 day

  service_endpoints = {
    observability_url     = "https://stub.local/observability"
    policy_url            = "https://stub.local/policy"
    campaign_repo_url     = "https://stub.local/campaigns"
    agent_runtime_url     = "https://stub.local/agent-runtime"
    pick_shortlist_url    = "https://stub.local/pick-shortlist"
    creator_directory_url = "https://stub.local/creator-directory"
    callback_router_url   = "https://stub.local/callback-router"
    approvals_api_url     = "https://stub.local/approvals"
    gate_predicate_url    = "https://stub.local/gate-predicate"
  }

  # D42: inject agent URLs from the ai module output (stubs in Phase 0, real
  # reasoningEngines URLs after W7).
  agent_urls = module.ai.agent_urls

  # Dev: disable Apigee + API Hub (expensive runtime instances).
  apigee_config = {
    enabled                  = false
    organization_description = "dev (disabled)"
    analytics_region         = "us-central1"
    runtime_type             = "CLOUD"
    billing_type             = "PAYG"
    authorized_network       = ""
    disable_vpc_peering      = true
  }

  api_hub_config = {
    enabled      = false
    region       = "us-central1"
    display_name = "Social Seeding v2 API Hub (dev)"
  }

  labels = local.common_labels
}

# -----------------------------------------------------------------------------
# 7. devops — Artifact Registry, Cloud Build, Cloud Deploy, Workstations, WIF.
# -----------------------------------------------------------------------------
module "devops" {
  source = "../../modules/devops"

  project_id     = var.project_id
  regions        = var.regions
  primary_region = var.primary_region

  github_owner      = var.github_owner
  github_repository = var.github_repository

  enable_workload_identity_federation = true

  # Dev: smaller pool / fewer artifacts.
  build_private_pool_machine_type = "e2-standard-2"
  artifact_cleanup_keep_count     = 10

  # Dev: canary skipped (apply 100% straight away).
  deploy_canary_percentages = [10]
  deploy_canary_verify      = false

  workstations_network    = var.workstations_network_self_link != "" ? var.workstations_network_self_link : module.networking.vpc_id
  workstations_subnetwork = var.workstations_subnetwork_self_link != "" ? var.workstations_subnetwork_self_link : module.networking.subnetwork_ids[var.primary_region]

  labels = local.common_labels
}

# -----------------------------------------------------------------------------
# 8. observability — SLOs, dashboards, log-based metrics, budget alerts.
# -----------------------------------------------------------------------------
module "observability" {
  source = "../../modules/observability"

  project_id               = var.project_id
  regions                  = var.regions
  audit_bigquery_location  = "US"
  archive_storage_location = "US"

  # Dev: minimum-required retention.
  audit_log_retention_days = 90
  archive_retention_days   = 90

  slo_hot_path_service_id    = "ss-v2-dev-hot-path"
  slo_availability_goal      = 0.99 # dev: 99% only
  slo_latency_threshold_ms   = 2000 # dev: relaxed
  slo_latency_goal           = 0.95
  slo_error_rate_goal        = 0.99
  slo_cost_per_run_usd_goal  = 0.90
  cost_per_run_threshold_usd = 1.00

  billing_account_id = var.billing_account_id
  monthly_budget_usd = 500 # dev cap

  email_alert_recipients = var.email_alert_recipients

  enable_prometheus = false # dev: skip GMP cost
  enable_profiler   = true
  enable_trace      = true

  labels = local.common_labels
}
