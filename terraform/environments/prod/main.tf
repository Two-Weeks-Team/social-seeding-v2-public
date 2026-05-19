# =============================================================================
# main.tf — prod environment root config
#
# Decision anchors:
#   - D13 (Global active-active across us-central1 + europe-west4 +
#     asia-northeast3 — provisioned per-region by every module's `regions`
#     map/list input).
#   - D14 (Deterministic NAT egress IPs per region for RapidAPI allowlist).
#   - D20 (CMEK everywhere — 90 d rotation, 30 d destroy window).
#   - D21 (Model Armor max policy, INSPECT_AND_BLOCK enforce).
#   - D31 (Enterprise SLO 99.99% / p99 < 1s).
#   - D32 (PagerDuty + Slack + email + Chronicle SIEM).
#   - D38 (Workload Identity Federation; no SA JSON keys).
#   - D42 (agent_urls flow ai.agent_urls -> integration.agent_urls).
#   - D44 (per-env root; modules called by relative path).
#
# Apply order is identical to dev (see dev/main.tf header).
# =============================================================================

locals {
  common_labels = {
    managed_by  = "terraform-env-prod"
    d_id        = "D44"
    environment = "prod"
    product     = "social-seeding-v2"
  }
}

# -----------------------------------------------------------------------------
# 1. security — KMS keyrings (3 regions), Secret Manager, WIF, Model Armor.
# -----------------------------------------------------------------------------
module "security" {
  source = "../../modules/security"

  project_id     = var.project_id
  project_number = var.project_number
  org_id         = var.org_id

  # D13 trio — security module expects exactly us/eu/ap keys.
  regions = {
    us = "us-central1"
    eu = "europe-west4"
    ap = "asia-northeast3"
  }

  # Prod: 90 d rotation per NIST SP 800-57 §5.3.5 (module default).
  # Prod: HSM-backed billing root once Apigee per-view billing pipeline is live.
  enable_hsm_billing_root = true

  # Prod Model Armor enforces INSPECT_AND_BLOCK on both input + output.
  model_armor_enforce   = true
  model_armor_fail_open = false

  enable_scc_premium = true

  workforce_oidc_issuer_uri = var.workforce_oidc_issuer_uri
  workforce_oidc_client_id  = var.workforce_oidc_client_id

  identity_platform_google_oauth_client_id = var.identity_platform_google_oauth_client_id

  github_repo_owner = var.github_owner
  github_repo_name  = var.github_repository

  labels = local.common_labels
}

# -----------------------------------------------------------------------------
# 2. networking — Shared VPC, NAT (3 static IPs/region), Global LB, VPC-SC,
#                 Cloud Service Mesh.
# -----------------------------------------------------------------------------
module "networking" {
  source = "../../modules/networking"

  host_project_id     = var.host_project_id
  service_project_ids = [var.project_id]
  access_policy_id    = var.access_policy_id

  # D13 trio with per-region CIDR plan (no overlaps).
  regions = {
    "us-central1" = {
      primary_cidr    = "10.10.0.0/20"
      pods_cidr       = "10.20.0.0/14"
      services_cidr   = "10.24.0.0/20"
      psc_cidr        = "10.30.0.0/24"
      nat_ip_count    = 3
      psc_endpoint_ip = "10.30.0.10"
    }
    "europe-west4" = {
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

  name_prefix             = "ss-v2-prod"
  iap_brand_support_email = var.iap_brand_support_email
  iap_member_groups       = var.iap_member_groups

  # Prod VPC-SC: ramp from dry-run to enforce after audit logs are clean.
  # Default stays true (dry-run); operator flips to false once baseline observed.
  vpc_sc_dry_run    = true
  vpc_sc_corp_cidrs = var.vpc_sc_corp_cidrs

  # Prod Cloud Armor: adaptive ON, preview OFF (enforce).
  armor_enable_preview      = false
  armor_adaptive_protection = true

  enable_service_mesh = true

  labels = local.common_labels
}

# -----------------------------------------------------------------------------
# 3. data — Spanner multi-region (nam-eur-asia1), AlloyDB cross-region replicas,
#          Firestore per-region, BigQuery, GCS, Memorystore Valkey 8.
# -----------------------------------------------------------------------------
module "data" {
  source = "../../modules/data"

  project_id  = var.project_id
  name_prefix = "ss-v2-prod"
  environment = "prod"

  regions = {
    "us-central1" = {
      location              = "us-central1"
      firestore_location    = "nam5"
      alloydb_cpu_count     = 8
      alloydb_replica_cpu   = 4
      valkey_shard_count    = 3
      valkey_replica_count  = 1
      valkey_node_type      = "HIGHMEM_MEDIUM"
      valkey_engine_version = "VALKEY_8_0"
      bigquery_location     = "US"
    }
    "europe-west4" = {
      location              = "europe-west4"
      firestore_location    = "eur3"
      alloydb_cpu_count     = 4
      alloydb_replica_cpu   = 4
      valkey_shard_count    = 2
      valkey_replica_count  = 1
      valkey_node_type      = "HIGHMEM_MEDIUM"
      valkey_engine_version = "VALKEY_8_0"
      bigquery_location     = "EU"
    }
    "asia-northeast3" = {
      location              = "asia-northeast3"
      firestore_location    = "asia-northeast3"
      alloydb_cpu_count     = 4
      alloydb_replica_cpu   = 4
      valkey_shard_count    = 2
      valkey_replica_count  = 1
      valkey_node_type      = "HIGHMEM_MEDIUM"
      valkey_engine_version = "VALKEY_8_0"
      bigquery_location     = "asia-northeast3"
    }
  }

  # Per-region CMEK keys for stores, plus the multi-region key for Spanner.
  cmek_keys = {
    "us-central1"     = module.security.cmek_key_ids["us-spanner"]
    "europe-west4"    = module.security.cmek_key_ids["eu-spanner"]
    "asia-northeast3" = module.security.cmek_key_ids["ap-spanner"]
    # Spanner instance is multi-region; the security module places a
    # dedicated multi-region key in the us keyring as the canonical home.
    multi_region = module.security.cmek_key_ids["us-spanner"]
  }

  spanner_config = {
    instance_config  = "nam-eur-asia1"
    processing_units = 1000 # 1 node — bump as load grows
    edition          = "ENTERPRISE_PLUS"
  }

  vpc_networks = {
    "us-central1"     = module.networking.vpc_id
    "europe-west4"    = module.networking.vpc_id
    "asia-northeast3" = module.networking.vpc_id
  }

  alloydb_initial_password_secret = var.alloydb_initial_password_secret

  enable_deletion_protection = true # prod: hard guard

  labels = local.common_labels
}

# -----------------------------------------------------------------------------
# 4. ai — Vertex AI Vector Search, Memory Bank (nam5), Workbench, Discovery
#         Engine, Dialogflow CX skeleton, Agent Registry seed.
#
# Note: per D13 active-active, callers can instantiate the ai module per-region
# if region-isolated Vector Search is needed. For prod we instantiate once in
# us-central1 (Memory Bank is multi-region nam5; Vector Search is regional but
# the agent_urls map is global).
# -----------------------------------------------------------------------------
module "ai" {
  source = "../../modules/ai"

  project_id      = var.project_id
  project_number  = var.project_number
  region          = var.primary_region
  environment     = "prod"
  resource_prefix = "ssv2"

  network_self_link = module.networking.vpc_id

  agent_runtime_service_account_email  = "agent-runtime@${var.project_id}.iam.gserviceaccount.com"
  data_scientist_service_account_email = "data-science@${var.project_id}.iam.gserviceaccount.com"

  # Prod CMEK on Vector Search indexes (D20).
  cmek_key_name = module.security.cmek_key_ids["us-spanner"]

  staging_bucket_name = module.data.asset_buckets["us-central1"]

  memory_bank = {
    firestore_database_id = "agent-memory-bank"
    location_id           = "nam5"
    retention_days        = 14 # D33
  }

  feature_flags = {
    enable_vector_search         = true
    enable_workbench             = true
    enable_pipelines             = true
    enable_dialogflow_cx         = true
    enable_discovery_engine_app  = true
    enable_agent_registry_seed   = true
    fail_on_preview_resource_err = false # set true after Agent Gateway → GA
  }

  tags = local.common_labels
}

# -----------------------------------------------------------------------------
# 5. compute — Cloud Run services + jobs + worker pools, GKE Autopilot per region.
# -----------------------------------------------------------------------------
module "compute" {
  source = "../../modules/compute"

  project_id = var.project_id
  regions    = var.regions

  agent_runtime_count   = 1
  gke_autopilot_enabled = true # prod: Veo/Imagen GPU pods
  gpu_type              = "nvidia-l4"

  gke_gpu_accelerator = {
    "us-central1"     = "nvidia-h100-80gb"
    "europe-west4"    = "nvidia-l4"
    "asia-northeast3" = "nvidia-l4"
  }

  # D31 99.99% SLO requires non-zero min-instances + generous max headroom.
  mission_control_min_instances = 2
  mission_control_max_instances = 50
  worker_pool_instances         = 5

  service_account_runtime   = "agent-runtime@${var.project_id}.iam.gserviceaccount.com"
  service_account_workflows = "workflows-invoker@${var.project_id}.iam.gserviceaccount.com"

  network_self_links = { for r in var.regions : r => module.networking.vpc_id }
  subnet_self_links  = { for r in var.regions : r => module.networking.subnetwork_ids[r] }

  # D20: per-region CMEK on Cloud Run.
  cmek_key_ids = {
    "us-central1"     = module.security.cmek_key_ids["us-spanner"]
    "europe-west4"    = module.security.cmek_key_ids["eu-spanner"]
    "asia-northeast3" = module.security.cmek_key_ids["ap-spanner"]
  }

  labels = local.common_labels
}

# -----------------------------------------------------------------------------
# 6. integration — Pub/Sub, Cloud Tasks, Workflows, Scheduler, Eventarc, Apigee.
#
# Note: integration module is regionally pinned. For prod multi-region
# integration coverage, instantiate this block once per region by copying the
# `module "integration"` call with provider aliases and a different
# `primary_region`. The default below covers the primary (us-central1).
# -----------------------------------------------------------------------------
module "integration" {
  source = "../../modules/integration"

  project_id     = var.project_id
  primary_region = var.primary_region

  workflows_invoker_sa_email = "workflows-invoker@${var.project_id}.iam.gserviceaccount.com"
  pubsub_publisher_sa_email  = "pubsub-publisher@${var.project_id}.iam.gserviceaccount.com"

  cmek_key_id = module.security.cmek_key_ids["us-pubsub"]

  # Prod: 7-day retention (module default, D33 audit BigQuery 90 d covers the rest).
  message_retention_duration = "604800s"

  # Compute module output URIs once Cloud Run services land; until then point
  # the integration workflows at the primary-region Mission Control URI for
  # all generic capability shims (workflows resolve sub-paths via env vars).
  service_endpoints = {
    observability_url     = module.compute.mission_control_service_urls[var.primary_region]
    policy_url            = module.compute.mission_control_service_urls[var.primary_region]
    campaign_repo_url     = module.compute.mission_control_service_urls[var.primary_region]
    agent_runtime_url     = module.compute.mission_control_service_urls[var.primary_region]
    pick_shortlist_url    = module.compute.mission_control_service_urls[var.primary_region]
    creator_directory_url = module.compute.mission_control_service_urls[var.primary_region]
    callback_router_url   = module.compute.mission_control_service_urls[var.primary_region]
    approvals_api_url     = module.compute.mission_control_service_urls[var.primary_region]
    gate_predicate_url    = module.compute.mission_control_service_urls[var.primary_region]
  }

  # D42: agent URLs flow from ai module output (stubs in Phase 0; W7 fills in
  # real reasoningEngines URLs).
  agent_urls = module.ai.agent_urls

  apigee_config = {
    enabled                  = true
    organization_description = "Social Seeding v2 — per-view billing gateway (D28)."
    analytics_region         = "us-central1"
    runtime_type             = "CLOUD"
    billing_type             = "PAYG"
    authorized_network       = ""
    disable_vpc_peering      = true
  }

  api_hub_config = {
    enabled      = true
    region       = "us-central1"
    display_name = "Social Seeding v2 API Hub"
  }

  labels = local.common_labels
}

# -----------------------------------------------------------------------------
# 7. devops — Artifact Registry (3 regions), Cloud Build, Cloud Deploy canary,
#            Cloud Workstations, WIF for GitHub Actions.
# -----------------------------------------------------------------------------
module "devops" {
  source = "../../modules/devops"

  project_id     = var.project_id
  regions        = var.regions
  primary_region = var.primary_region

  github_owner      = var.github_owner
  github_repository = var.github_repository

  enable_workload_identity_federation = true

  # Prod: full canary 10 → 50 → 100 with SLO burn verify.
  deploy_canary_percentages = [10, 50]
  deploy_canary_verify      = true
  deploy_slo_burn_threshold = 2.0

  build_private_pool_machine_type = "e2-standard-4"
  artifact_cleanup_keep_count     = 50

  workstations_network    = var.workstations_network_self_link != "" ? var.workstations_network_self_link : module.networking.vpc_id
  workstations_subnetwork = var.workstations_subnetwork_self_link != "" ? var.workstations_subnetwork_self_link : module.networking.subnetwork_ids[var.primary_region]

  labels = local.common_labels
}

# -----------------------------------------------------------------------------
# 8. observability — SLOs (4 numbers per D31), dashboards, log-based metrics,
#                    budget alerts, Chronicle ingest topic.
# -----------------------------------------------------------------------------
module "observability" {
  source = "../../modules/observability"

  project_id               = var.project_id
  regions                  = var.regions
  audit_bigquery_location  = "US"
  archive_storage_location = "US"

  # D33: 90 d hot in BigQuery, 7 y in GCS archive.
  audit_log_retention_days = 90
  archive_retention_days   = 2555

  slo_hot_path_service_id    = "ss-v2-prod-hot-path"
  slo_availability_goal      = 0.9999 # D31
  slo_latency_threshold_ms   = 1000   # D31 p99 < 1s
  slo_latency_goal           = 0.99
  slo_error_rate_goal        = 0.999
  slo_cost_per_run_usd_goal  = 0.95
  cost_per_run_threshold_usd = 1.00

  billing_account_id = var.billing_account_id
  monthly_budget_usd = var.monthly_budget_usd

  email_alert_recipients          = var.email_alert_recipients
  pagerduty_service_key_secret_id = var.pagerduty_service_key_secret_id
  slack_webhook_secret_id         = var.slack_webhook_secret_id

  model_armor_block_threshold_per_minute = 10
  escalation_threshold_per_5min          = 25

  enable_prometheus = true
  enable_profiler   = true
  enable_trace      = true

  labels = local.common_labels
}
