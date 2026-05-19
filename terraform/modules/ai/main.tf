# =============================================================================
# main.tf — AI module resources
#
# Layout (each block cites the decision it implements):
#   §1. Required-API enablement                      (D17 + D25 + D26)
#   §2. Model Garden enablement / publisher pins     (D5 + D39)
#   §3. Vertex AI Vector Search (3 indexes)          (D16)
#   §4. Firestore Native — Agent Memory Bank backing (D15 + D33)
#   §5. Agent Sessions DB (Firestore secondary)      (D17)
#   §6. Vertex AI Workbench instance                 (D25)
#   §7. Agent Registry seed (Agent Cards in GCS)     (D23 — 22 agents)
#   §8. Agent Runtime deploy (null_resource fallback)(D17 — Preview)
#   §9. Agent Gateway endpoint binding               (D17 + D21)
#  §10. Vertex AI Pipelines (SFT + Distill + RLHF)   (D25)
#  §11. Discovery Engine app + agent registration    (D26 + AI-AGENTS.md §C1)
#  §12. Dialogflow CX skeleton                       (D26)
# =============================================================================

locals {
  prefix         = var.resource_prefix
  use_cmek       = var.cmek_key_name != ""
  use_gateway    = var.agent_gateway_id != ""
  fail_on_pp_err = var.feature_flags.fail_on_preview_resource_err

  # Shorthand: agents grouped by tier for IAM + memory bindings.
  tier1_agents = { for k, v in var.agent_registry : k => v if v.tier == 1 }
  tier2_agents = { for k, v in var.agent_registry : k => v if v.tier == 2 }
  tier3_agents = { for k, v in var.agent_registry : k => v if v.tier == 3 }

  # Model resolution per registry entry (D5).
  agent_model_id = {
    for k, v in var.agent_registry :
    k => lookup({
      judgment   = var.model_defaults.judgment
      bulk       = var.model_defaults.bulk
      classifier = var.model_defaults.classifier
    }, v.model_tier, var.model_defaults.bulk)
  }

  # Standard label set + per-resource overlays.
  base_labels = merge(var.tags, {
    environment = var.environment
    region      = var.region
  })

  # Discovery Engine app fully-qualified name (used in null_resource exec
  # blocks for the C1 registration flow).
  discovery_engine_app_name = "projects/${var.project_id}/locations/${var.gemini_enterprise.app_location}/collections/default_collection/engines/${var.gemini_enterprise.app_id}/assistants/default_assistant"

  # PreviewForge-style guard expression for null_resource exec:
  # we want failures to log+continue (default) unless the operator explicitly
  # set fail_on_preview_resource_err = true.
  preview_guard_suffix = local.fail_on_pp_err ? "" : " || true"
}

# -----------------------------------------------------------------------------
# §1. Required-API enablement (D17 + D25 + D26)
# Citations:
#   - aiplatform.googleapis.com         → D17 Agent Runtime + D16 Vector Search + D25 Pipelines
#   - discoveryengine.googleapis.com    → AI-AGENTS.md §C1, D26 Gemini Enterprise app
#   - dialogflow.googleapis.com         → D26 customer-support surface
#   - notebooks.googleapis.com          → D25 Workbench notebook (data scientist)
#   - firestore.googleapis.com          → D15 Memory Bank backing
#   - generativelanguage.googleapis.com → D5 Gemini Model Garden (Gemini API)
# -----------------------------------------------------------------------------
resource "google_project_service" "required" {
  for_each = toset([
    "aiplatform.googleapis.com",
    "discoveryengine.googleapis.com",
    "dialogflow.googleapis.com",
    "notebooks.googleapis.com",
    "firestore.googleapis.com",
    "generativelanguage.googleapis.com",
    "storage.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
  ])
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

# -----------------------------------------------------------------------------
# §2. Model Garden — IAM hook so Agent Runtime SA can invoke Gemini publisher
# models (D5). Note: there is NO TF resource that "enables a specific
# publisher model"; access is granted by IAM on the project. The Gemini 3.1
# Pro Preview model (var.model_defaults.demo) is gated by an allowlist
# application that is OUT OF SCOPE for Terraform (manual console action
# tracked as outstanding O7 in DECISIONS.md §6).
# -----------------------------------------------------------------------------
resource "google_project_iam_member" "agent_runtime_aiplatform_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${var.agent_runtime_service_account_email}"

  depends_on = [google_project_service.required]
}

resource "google_project_iam_member" "agent_runtime_aiplatform_serviceAgent" {
  project = var.project_id
  role    = "roles/aiplatform.serviceAgent"
  member  = "serviceAccount:${var.agent_runtime_service_account_email}"

  depends_on = [google_project_service.required]
}

# -----------------------------------------------------------------------------
# §3. Vertex AI Vector Search (D16 — 3 indexes: creators_v1, brands_v1, content_v1)
# -----------------------------------------------------------------------------
# Endpoint is shared across all indexes within a region to amortize the
# replica-hour cost (D39 — $1500 credit budget). Each index gets its own
# deployed_index that maps onto the shared endpoint.
resource "google_vertex_ai_index" "this" {
  for_each = var.feature_flags.enable_vector_search ? var.vector_indexes : {}

  provider     = google
  project      = var.project_id
  region       = var.region
  display_name = "${local.prefix}-${each.value.display_name}"
  description  = "D16 Vertex AI Vector Search index for ${each.key}. Updated method: ${each.value.update_method}."

  metadata {
    contents_delta_uri = each.value.contents_gcs_uri

    config {
      dimensions                  = each.value.dimensions
      approximate_neighbors_count = each.value.approximate_neighbors_count
      shard_size                  = each.value.shard_size
      distance_measure_type       = each.value.distance_measure

      algorithm_config {
        tree_ah_config {
          leaf_node_embedding_count    = each.value.leaf_node_embedding_count
          leaf_nodes_to_search_percent = each.value.leaf_nodes_to_search_percent
        }
      }
    }
  }

  index_update_method = each.value.update_method
  labels              = merge(local.base_labels, { index = each.key })

  # D20 CMEK passthrough — only emit the block when the key is provided so
  # dev environments without KMS bootstrapping still apply cleanly.
  dynamic "encryption_spec" {
    for_each = local.use_cmek ? [1] : []
    content {
      kms_key_name = var.cmek_key_name
    }
  }

  depends_on = [google_project_service.required]
}

# Single shared private endpoint for the region (D13/D31 latency target =
# p99 < 50ms on Vector Search → keep endpoint and Agent Runtime co-regional).
resource "google_vertex_ai_index_endpoint" "shared" {
  count = var.feature_flags.enable_vector_search ? 1 : 0

  provider     = google
  project      = var.project_id
  region       = var.region
  display_name = "${local.prefix}-vector-endpoint-${var.region}"
  description  = "Shared Vector Search endpoint for ${local.prefix} fleet (D16 + D39 cost amortization)."
  network      = var.network_self_link
  labels       = local.base_labels

  depends_on = [google_project_service.required]
}

resource "google_vertex_ai_index_endpoint_deployed_index" "this" {
  for_each = var.feature_flags.enable_vector_search ? var.vector_indexes : {}

  provider              = google
  region                = var.region
  deployed_index_id     = replace("${local.prefix}_${each.key}", "-", "_")
  display_name          = "${local.prefix}-${each.value.display_name}-deployed"
  index                 = google_vertex_ai_index.this[each.key].id
  index_endpoint        = google_vertex_ai_index_endpoint.shared[0].id
  reserved_ip_ranges    = [var.vector_search_reserved_ip_range_name]
  enable_access_logging = true

  # Auto-scale within the per-index envelope set in var.vector_indexes.
  dedicated_resources {
    machine_spec {
      machine_type = "e2-standard-16"
    }
    min_replica_count = each.value.min_replica_count
    max_replica_count = each.value.max_replica_count
  }

  depends_on = [
    google_vertex_ai_index.this,
    google_vertex_ai_index_endpoint.shared,
  ]
}

# -----------------------------------------------------------------------------
# §4. Firestore Native — Agent Memory Bank backing (D15 + D33: 14-day TTL)
# -----------------------------------------------------------------------------
# Memory Bank stores its consolidated facts in a Firestore database that the
# operator provisions. We pin the **multi-region** location (`nam5`, `eur3`,
# or `asia-northeast1`) to match the regional Agent Runtime placement (D13).
resource "google_firestore_database" "agent_memory_bank" {
  project                           = var.project_id
  name                              = "${local.prefix}-${var.memory_bank.firestore_database_id}"
  location_id                       = var.memory_bank.location_id
  type                              = "FIRESTORE_NATIVE"
  database_edition                  = "ENTERPRISE"
  concurrency_mode                  = "OPTIMISTIC"
  app_engine_integration_mode       = "DISABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = var.environment == "prod" ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
  deletion_policy                   = var.environment == "prod" ? "ABANDON" : "DELETE"

  depends_on = [google_project_service.required]
}

# Collection-schema docs are not provisioned by Terraform — Firestore is
# schemaless. Instead we ship the schema *contract* as a JSON sidecar that
# the agent code reads on startup. The TTL field (`expireAt`) is enforced by
# a Firestore TTL policy that we create below (D33 = 14 days).
resource "google_firestore_field" "memory_bank_ttl" {
  project    = var.project_id
  database   = google_firestore_database.agent_memory_bank.name
  collection = "memories"
  field      = "expireAt"

  ttl_config {}

  index_config {
    indexes {
      order       = "ASCENDING"
      query_scope = "COLLECTION_GROUP"
    }
  }
}

# -----------------------------------------------------------------------------
# §5. Agent Sessions DB — short-term conversation state (D17). A separate
# Firestore DB so retention + scaling policies diverge from Memory Bank.
# Per AI-AGENTS.md §13, Sessions persists per-session events + tool calls.
# -----------------------------------------------------------------------------
resource "google_firestore_database" "agent_sessions" {
  project                           = var.project_id
  name                              = "${local.prefix}-agent-sessions"
  location_id                       = var.memory_bank.location_id
  type                              = "FIRESTORE_NATIVE"
  database_edition                  = "ENTERPRISE"
  concurrency_mode                  = "OPTIMISTIC"
  app_engine_integration_mode       = "DISABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = var.environment == "prod" ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
  deletion_policy                   = var.environment == "prod" ? "ABANDON" : "DELETE"

  depends_on = [google_project_service.required]
}

# Sessions retain for 24h by default (orthogonal to Memory Bank's 14-day
# retention).  D33 only constrains Memory Bank; Sessions follows a hot-path
# need-not-persist heuristic.
resource "google_firestore_field" "sessions_ttl" {
  project    = var.project_id
  database   = google_firestore_database.agent_sessions.name
  collection = "sessions"
  field      = "expireAt"

  ttl_config {}

  index_config {
    indexes {
      order       = "ASCENDING"
      query_scope = "COLLECTION_GROUP"
    }
  }
}

# -----------------------------------------------------------------------------
# §6. Vertex AI Workbench instance for the data-scientist tuning workflow (D25)
# -----------------------------------------------------------------------------
resource "google_workbench_instance" "data_science" {
  count = var.feature_flags.enable_workbench && var.workbench_instance.enabled ? 1 : 0

  project  = var.project_id
  name     = "${local.prefix}-${var.workbench_instance.name_suffix}"
  location = var.workbench_instance.location_zone

  gce_setup {
    machine_type = var.workbench_instance.machine_type

    service_accounts {
      email = var.data_scientist_service_account_email
    }

    metadata = {
      idle-timeout-seconds = "3600"          # auto-suspend after 1h idle (D39 cost lever)
      report-system-health = "TRUE"
    }

    disable_public_ip = true
  }

  labels = merge(local.base_labels, { surface = "workbench" })

  depends_on = [google_project_service.required]
}

# -----------------------------------------------------------------------------
# §7. Agent Registry seed (D23 — 22 agents per ARCHITECTURE.md §3)
# -----------------------------------------------------------------------------
# Each agent publishes an A2A v0.3 Agent Card JSON file into the staging
# bucket. The file is consumed by:
#   - Cloud Marketplace listing flow (AI-AGENTS.md §C3, Track 3 commercial
#     path) — the URL is referenced from the Producer Portal listing.
#   - Agent Registry manual-register flow (AI-AGENTS.md §C2) — fed into
#     `gcloud beta agents register` via null_resource below.
resource "google_storage_bucket_object" "agent_cards" {
  for_each = var.feature_flags.enable_agent_registry_seed ? var.agent_registry : {}

  bucket = var.staging_bucket_name
  name   = "agent-cards/${each.key}.json"

  content = jsonencode({
    protocolVersion    = "0.3"
    name               = each.value.display_name
    description        = each.value.description
    url                = "https://agent-gateway.${var.region}.googleapis.com/${local.prefix}/agents/${each.key}"
    version            = "1.0.0"
    defaultInputModes  = ["text/plain", "application/json"]
    defaultOutputModes = ["text/plain", "application/json"]
    capabilities = {
      streaming    = true
      pushNotifications = each.value.tier == 1
    }
    skills = [
      for skill in each.value.skills :
      {
        id          = replace(skill, ".", "_")
        name        = skill
        description = "Capability ${skill} (see packages/capabilities)."
      }
    ]
    # Custom Social Seeding extension fields — read by the orchestrator to
    # enforce D23 USD caps + D27 autonomy gates.
    "x-social-seeding" = {
      tier              = each.value.tier
      model             = local.agent_model_id[each.key]
      memoryStrategy    = each.value.memory_strategy
      evalCriteria      = each.value.eval_criteria
      autonomy          = each.value.autonomy
      usdCapPerRun      = each.value.usd_cap_per_run
      escalationTarget  = each.value.escalation_target
      modelArmorEnabled = true # D21 — always-on
    }
  })

  content_type = "application/json"
}

# Manual registration into Agent Registry via gcloud (no GA TF resource as
# of 2026-05 — AI-AGENTS.md §C2). Re-runs are idempotent because we use
# `agents update --if-exists` semantics; the trigger hash makes Terraform
# only fire when an Agent Card actually changes.
resource "null_resource" "agent_registry_register" {
  for_each = var.feature_flags.enable_agent_registry_seed ? var.agent_registry : {}

  triggers = {
    card_hash = google_storage_bucket_object.agent_cards[each.key].md5hash
    agent_id  = each.key
    project   = var.project_id
    region    = var.region
  }

  provisioner "local-exec" {
    command = <<-EOC
      set -e
      gcloud beta agents register \
        --project=${var.project_id} \
        --location=${var.region} \
        --agent-id=${local.prefix}-${each.key} \
        --agent-card=gs://${var.staging_bucket_name}/agent-cards/${each.key}.json \
        --quiet${local.preview_guard_suffix}
    EOC
  }

  depends_on = [google_storage_bucket_object.agent_cards]
}

# -----------------------------------------------------------------------------
# §8. Agent Runtime (Reasoning Engine) deploy — null_resource fallback
# (D17 — Preview; no first-class TF resource as of 2026-05).
# Each Tier-1+2 agent gets a Reasoning Engine; Tier-3 watchdogs run as Cloud
# Run services and live in the `compute` module instead.
# -----------------------------------------------------------------------------
locals {
  runtime_agents = merge(local.tier1_agents, local.tier2_agents)
}

resource "null_resource" "agent_runtime_deploy" {
  for_each = local.runtime_agents

  triggers = {
    card_hash    = google_storage_bucket_object.agent_cards[each.key].md5hash
    agent_id     = each.key
    project      = var.project_id
    region       = var.region
    staging_bkt  = var.staging_bucket_name
    model_id     = local.agent_model_id[each.key]
    runtime_sa   = var.agent_runtime_service_account_email
    use_gateway  = local.use_gateway
    gateway_id   = var.agent_gateway_id
  }

  # The actual `vertexai.Client().agent_engines.create(...)` call lives in
  # `packages/agents/deploy/deploy_agent.py` (see AI-AGENTS.md §10). We
  # invoke it via `python -m` so the same code path runs from CI + Terraform.
  provisioner "local-exec" {
    command = <<-EOC
      set -e
      python -m packages.agents.deploy.deploy_agent \
        --agent-id=${each.key} \
        --project=${var.project_id} \
        --region=${var.region} \
        --staging-bucket=gs://${var.staging_bucket_name} \
        --model=${local.agent_model_id[each.key]} \
        --service-account=${var.agent_runtime_service_account_email} \
        ${local.use_gateway ? "--agent-gateway=${var.agent_gateway_id}" : ""} \
        --enable-agent-identity${local.preview_guard_suffix}
    EOC
  }

  depends_on = [
    null_resource.agent_registry_register,
    google_firestore_database.agent_memory_bank,
    google_firestore_database.agent_sessions,
  ]
}

# -----------------------------------------------------------------------------
# §9. Agent Gateway routing wire-up (D17 + D21)
# The actual gateway is provisioned by the `security` module (see
# ARMOR-GATEWAY.md §5). Here we only set IAM that lets the gateway invoke
# the Reasoning Engines on behalf of the user.
# -----------------------------------------------------------------------------
resource "google_project_iam_member" "gateway_invoker" {
  count = local.use_gateway ? 1 : 0

  project = var.project_id
  role    = "roles/aiplatform.reasoningEngineServiceAgent"
  # The gateway's Google-managed service agent. See ARMOR-GATEWAY.md §2.4.
  member = "serviceAccount:service-${var.project_number}@gcp-sa-networkservices.iam.gserviceaccount.com"

  depends_on = [google_project_service.required]
}

# -----------------------------------------------------------------------------
# §10. Vertex AI Pipelines — SFT + Distillation + RLHF on Simulation (D25)
# -----------------------------------------------------------------------------
# No GA TF resource yet for `google_vertex_ai_pipeline_job` recurring schedule;
# we invoke `gcloud ai pipelines run` (one-shot on apply) plus Cloud
# Scheduler (provisioned by the `integration` module) for recurring runs.
resource "null_resource" "vertex_pipeline" {
  for_each = var.feature_flags.enable_pipelines ? {
    for k, v in var.pipelines : k => v if v.enabled
  } : {}

  triggers = {
    template = each.value.template_gcs_path
    cron     = each.value.cron_schedule
    project  = var.project_id
    region   = var.region
    params   = jsonencode(each.value.pipeline_parameters)
  }

  provisioner "local-exec" {
    command = <<-EOC
      set -e
      gcloud ai pipelines run \
        --project=${var.project_id} \
        --region=${var.region} \
        --display-name=${local.prefix}-${each.key}-bootstrap \
        --template-path=${each.value.template_gcs_path} \
        --service-account=${var.data_scientist_service_account_email} \
        --parameter-values='${jsonencode(each.value.pipeline_parameters)}' \
        --quiet${local.preview_guard_suffix}
    EOC
  }

  depends_on = [google_project_service.required]
}

# -----------------------------------------------------------------------------
# §11. Discovery Engine app + Gemini Enterprise agent registration
# (D26 — UI surface + AI-AGENTS.md §C1 Track 3 listing flow)
# -----------------------------------------------------------------------------
resource "google_discovery_engine_data_store" "knowledge_base" {
  count = var.feature_flags.enable_discovery_engine_app && var.gemini_enterprise.enable_app ? 1 : 0

  project           = var.project_id
  location          = var.gemini_enterprise.app_location
  data_store_id     = "${local.prefix}-knowledge-base"
  display_name      = "${local.prefix} Knowledge Base"
  industry_vertical = var.gemini_enterprise.industry_vertical
  content_config    = "NO_CONTENT"
  solution_types    = ["SOLUTION_TYPE_CHAT", "SOLUTION_TYPE_SEARCH"]

  depends_on = [google_project_service.required]
}

resource "google_discovery_engine_chat_engine" "mission_control" {
  count = var.feature_flags.enable_discovery_engine_app && var.gemini_enterprise.enable_app ? 1 : 0

  project           = var.project_id
  location          = var.gemini_enterprise.app_location
  collection_id     = "default_collection"
  engine_id         = var.gemini_enterprise.app_id
  display_name      = "${local.prefix} Mission Control"
  industry_vertical = var.gemini_enterprise.industry_vertical
  data_store_ids    = [google_discovery_engine_data_store.knowledge_base[0].data_store_id]

  common_config {
    company_name = var.gemini_enterprise.company_name
  }

  chat_engine_config {
    dialogflow_agent_to_link = var.feature_flags.enable_dialogflow_cx ? google_dialogflow_cx_agent.support[0].id : null
    allow_cross_region       = true
  }

  depends_on = [google_discovery_engine_data_store.knowledge_base]
}

# Register the ADK coordinator agent against the Gemini Enterprise app
# (AI-AGENTS.md §C1 Step 3). No GA TF resource yet — we shell out to the
# Discovery Engine REST API. Migrate to `google_discovery_engine_agent`
# when it ships (tracked in versions.tf migration path).
resource "null_resource" "gemini_enterprise_agent_register" {
  count = (
    var.feature_flags.enable_discovery_engine_app
    && var.gemini_enterprise.enable_app
    && var.gemini_enterprise.register_default_agent
  ) ? 1 : 0

  triggers = {
    app_id    = var.gemini_enterprise.app_id
    agent_id  = var.gemini_enterprise.register_default_agent_name
    region    = var.region
    project   = var.project_id
  }

  provisioner "local-exec" {
    command = <<-EOC
      set -e
      ACCESS_TOKEN=$(gcloud auth print-access-token)
      REASONING_ENGINE=$(gcloud ai reasoning-engines list \
        --project=${var.project_id} --region=${var.region} \
        --filter="displayName:${local.prefix}-${var.gemini_enterprise.register_default_agent_name}" \
        --format="value(name)" --limit=1)
      [ -z "$REASONING_ENGINE" ] && { echo "reasoning engine not found"; exit 0; }
      curl -X POST \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -H "X-Goog-User-Project: ${var.project_id}" \
        "https://us-discoveryengine.googleapis.com/v1alpha/${local.discovery_engine_app_name}/agents" \
        -d "{
          \"displayName\": \"Social Seeding Operator\",
          \"description\": \"D26 Mission Control entry point for the 22-agent fleet.\",
          \"adkAgentDefinition\": {
            \"provisionedReasoningEngine\": {
              \"reasoningEngine\": \"$REASONING_ENGINE\"
            }
          }
        }"${local.preview_guard_suffix}
    EOC
  }

  depends_on = [
    google_discovery_engine_chat_engine.mission_control,
    null_resource.agent_runtime_deploy,
  ]
}

# -----------------------------------------------------------------------------
# §12. Dialogflow CX skeleton — D26 customer-support surface
# -----------------------------------------------------------------------------
resource "google_dialogflow_cx_agent" "support" {
  count = var.feature_flags.enable_dialogflow_cx ? 1 : 0

  project               = var.project_id
  display_name          = "${local.prefix}-support"
  location              = var.gemini_enterprise.dialogflow_agent_location
  default_language_code = var.gemini_enterprise.dialogflow_language
  time_zone             = var.gemini_enterprise.dialogflow_time_zone
  description           = "D26 customer-support surface; routes to customer_success agent via webhook."
  enable_stackdriver_logging = true
  enable_spell_correction    = true

  # delete_chat_engine_on_destroy ensures the auto-created chat engine is
  # garbage-collected with the agent in non-prod environments.
  delete_chat_engine_on_destroy = var.environment != "prod"

  depends_on = [google_project_service.required]
}

resource "google_dialogflow_cx_webhook" "agent_bridge" {
  count = var.feature_flags.enable_dialogflow_cx ? 1 : 0

  parent       = google_dialogflow_cx_agent.support[0].id
  display_name = "AgentRuntimeBridge"
  generic_web_service {
    # Points at the Mission Control webhook handler that adapts Dialogflow
    # CX requests into Agent Runtime invocations. The actual Cloud Run URL
    # is wired in by the `compute` module via its outputs.
    uri = "https://${local.prefix}-dialogflow-bridge-${var.region}.run.app/dialogflow"
  }

  timeout = "30s"
}
