# =============================================================================
# outputs.tf — AI module outputs
# Consumed by:
#   - terraform/modules/compute      (Mission Control + worker pools — need
#                                    Memory Bank / Sessions DB names + Agent
#                                    Runtime URIs)
#   - terraform/modules/security     (Agent Gateway binding feedback —
#                                    confirms which agents are registered)
#   - terraform/modules/observability (Dashboards key off agent names + the
#                                    Vector Search endpoint id for latency
#                                    SLOs per D31)
# =============================================================================

# --- Vector Search (D16) ------------------------------------------------------
output "vector_search_endpoint_id" {
  description = "Shared regional Vector Search endpoint resource id; empty when feature_flags.enable_vector_search = false."
  value = (
    var.feature_flags.enable_vector_search && length(google_vertex_ai_index_endpoint.shared) > 0
    ? google_vertex_ai_index_endpoint.shared[0].id
    : ""
  )
}

output "vector_search_indexes" {
  description = "Map of short-name → full index resource ids. Used by the agent code to wire sourcing/vetting/research vector lookups."
  value = {
    for k, v in google_vertex_ai_index.this : k => v.id
  }
}

output "vector_search_deployed_indexes" {
  description = "Map of short-name → deployed-index ids (the id agent code passes to find_neighbors RPCs)."
  value = {
    for k, v in google_vertex_ai_index_endpoint_deployed_index.this : k => v.deployed_index_id
  }
}

# --- Memory Bank + Sessions (D15 + D17 + D33) --------------------------------
output "memory_bank_database_name" {
  description = "Firestore Native database name backing Agent Memory Bank (D15). Pass to ADK as VertexAiMemoryBankService(... firestore_database=...) and into the application config."
  value       = google_firestore_database.agent_memory_bank.name
}

output "memory_bank_database_location" {
  description = "Multi-region location id of the Memory Bank database (D33 — drives PIPA data-residency claim per D22)."
  value       = google_firestore_database.agent_memory_bank.location_id
}

output "agent_sessions_database_name" {
  description = "Firestore Native database name backing Agent Sessions (D17)."
  value       = google_firestore_database.agent_sessions.name
}

# --- Agent Registry (D23) -----------------------------------------------------
output "agent_card_bucket_paths" {
  description = "GCS paths to every A2A v0.3 Agent Card published by the registry seed. Track-3 Marketplace listing references these."
  value = {
    for k, v in google_storage_bucket_object.agent_cards :
    k => "gs://${v.bucket}/${v.name}"
  }
}

output "agent_ids" {
  description = "The full list of registered agent ids — useful for observability dashboard generation + smoke tests."
  value       = keys(var.agent_registry)
}

output "agent_models" {
  description = "Per-agent resolved model id (D5 application). Pass into runtime so traces are tagged with the model that actually ran."
  value       = local.agent_model_id
}

# --- Agent Runtime (D17) ------------------------------------------------------
# We expose the *intent* of deployment as an output; the actual reasoning
# engine resource path is resolved at runtime by the agent code (it's
# emitted by deploy_agent.py to a known GCS marker file). Consumers should
# read the marker, not assume a TF-driven URI.
output "agent_runtime_deploy_marker" {
  description = "GCS prefix where deploy_agent.py writes per-agent reasoning engine ids. Format: gs://<staging>/runtime-markers/<agent>.json."
  value       = "gs://${var.staging_bucket_name}/runtime-markers"
}

output "agent_runtime_service_account" {
  description = "SA email used by Agent Runtime workloads (mirrored from input for downstream-module convenience)."
  value       = var.agent_runtime_service_account_email
}

# --- Agent endpoint URLs (D42 — wired by W3) ---------------------------------
# Phase-0 stub: emits `https://stub.local/<agent_id>` for every registered
# agent plus the 2 documented sub-route synonyms used by
# terraform/modules/integration/workflows/creator-track.workflows.yaml
# (`extract_facts` → outreach_writer runtime; `classify_reply` → conversation
# runtime). W7 (deploy) overwrites these stubs with the actual
# reasoningEngines invocation URLs read from the deploy-marker GCS files.
#
# The integration module consumes this via its `agent_urls` variable; the
# stub shape satisfies the variable's URL-format validation so
# `terraform validate` passes before W7 has run.
#
# Stable contract: every key in this map is a valid input for
# integration_module.agent_urls; the integration module's validation
# enforces the same set.
output "agent_urls" {
  description = <<-EOT
    Per-agent Vertex AI Agent Runtime invocation URL keyed by agent_id (D17 +
    D42). During Phase 0 each entry is the stub `https://stub.local/<id>`;
    W7 replaces these with the real reasoningEngines URLs.

    Consumed by:
      - terraform/modules/integration (variables.tf:agent_urls) — drives
        per-agent user_env_vars on every google_workflows_workflow, plus is
        designed to be re-emitted into Cloud Scheduler / Eventarc args
        payloads via `terraform output -json ai_module.agent_urls`.

    Keys: the registered agent_ids in var.agent_registry plus 2 sub-route
    synonyms (extract_facts → outreach_writer, classify_reply →
    conversation). See terraform/modules/integration/WIRE-NOTES.md §3.
  EOT
  value = merge(
    {
      for agent_id in keys(var.agent_registry) :
      agent_id => "https://stub.local/${agent_id}"
    },
    {
      # Sub-route synonyms used by creator-track.workflows.yaml. In Phase 0
      # they point at the same stub; W7 maps them to the parent agent's
      # actual reasoningEngines URL (or to a distinct sub-route URL if the
      # ADK deploy emits one).
      extract_facts  = "https://stub.local/extract_facts"
      classify_reply = "https://stub.local/classify_reply"
    }
  )
}

# --- Workbench (D25) ----------------------------------------------------------
output "workbench_instance_name" {
  description = "Workbench instance name; empty string when disabled."
  value = (
    var.feature_flags.enable_workbench && var.workbench_instance.enabled && length(google_workbench_instance.data_science) > 0
    ? google_workbench_instance.data_science[0].name
    : ""
  )
}

# --- Discovery Engine + Dialogflow CX (D26) ----------------------------------
output "discovery_engine_app_id" {
  description = "Discovery Engine chat engine id (= Gemini Enterprise app id). Track 3 listing references this."
  value = (
    var.feature_flags.enable_discovery_engine_app && var.gemini_enterprise.enable_app && length(google_discovery_engine_chat_engine.mission_control) > 0
    ? google_discovery_engine_chat_engine.mission_control[0].engine_id
    : ""
  )
}

output "dialogflow_cx_agent_id" {
  description = "Dialogflow CX agent resource id (D26 customer-support surface). Empty if dialogflow disabled."
  value = (
    var.feature_flags.enable_dialogflow_cx && length(google_dialogflow_cx_agent.support) > 0
    ? google_dialogflow_cx_agent.support[0].id
    : ""
  )
}

# --- Pipelines (D25) ----------------------------------------------------------
output "learning_loop_pipelines" {
  description = "Map of enabled pipelines (SFT / Distillation / RLHF on Simulation). The cron schedules are wired by the integration module via Cloud Scheduler."
  value = {
    for k, v in var.pipelines :
    k => {
      enabled       = v.enabled
      template      = v.template_gcs_path
      cron_schedule = v.cron_schedule
      description   = v.description
    }
    if v.enabled && var.feature_flags.enable_pipelines
  }
}

# --- Diagnostics --------------------------------------------------------------
output "module_summary" {
  description = "One-screen summary the observability dashboards key off (also handy in CI logs)."
  value = {
    agents_total                   = length(var.agent_registry)
    agents_tier_1                  = length(local.tier1_agents)
    agents_tier_2                  = length(local.tier2_agents)
    agents_tier_3                  = length(local.tier3_agents)
    vector_search_indexes_count    = var.feature_flags.enable_vector_search ? length(var.vector_indexes) : 0
    pipelines_active               = var.feature_flags.enable_pipelines ? length({ for k, v in var.pipelines : k => v if v.enabled }) : 0
    gateway_routed                 = local.use_gateway
    cmek_enabled                   = local.use_cmek
    region                         = var.region
    environment                    = var.environment
    preview_resource_strict_mode   = local.fail_on_pp_err
  }
}
