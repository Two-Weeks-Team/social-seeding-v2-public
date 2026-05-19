# =============================================================================
# Module: ai  (TF-Module-7)
# Purpose: Vertex AI Agent Platform resources for social-seeding-v2.
#          Implements D17 (Agent Runtime), D18 (orchestration deps),
#          D19 (Agent Identity hooks), D20 (CMEK passthrough),
#          D21 (Model Armor — owned by `security` module; we *consume*),
#          D23 (22-agent fleet + watchdogs),
#          D24 (phased coordination),
#          D25 (learning loop: SFT + Distillation + RLHF on Simulation),
#          D26 (Dialogflow CX surface; Discovery Engine app target).
#
# Provider pin rationale:
#   - hashicorp/google      v6.x: stable resources (workbench, vertex_ai_index,
#     dialogflow_cx_agent, firestore_database, discovery_engine_data_store).
#   - hashicorp/google-beta v6.x: required for several Preview/Alpha surfaces:
#     - google_network_services_agent_gateway (D17/D21 governance ingress —
#       Private Preview per ARMOR-GATEWAY.md §2.2).
#     - google_vertex_ai_endpoint feature flags that may not yet be in GA.
#   - null + local + random: glue for the gcloud-fallback path (see §"Latest-
#     spec critical" in module brief — many Agent Platform resources lack a
#     first-class TF surface in 2026-05 and must be provisioned via
#     `gcloud beta agents …` until promotion).
#
# Migration path (inline-documented; revisit each quarter):
#   - When `google_vertex_ai_reasoning_engine`        moves to GA → replace
#     `null_resource.agent_runtime_*` blocks with the native resource.
#   - When `google_discovery_engine_agent`            ships              → replace
#     `null_resource.gemini_enterprise_agent_register` with the native resource.
#   - When `google_vertex_ai_pipelines_job` GA-stable → replace pipeline
#     null_resources (currently shell out to `gcloud ai pipelines run`).
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
