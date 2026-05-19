# versions.tf — compute module
#
# Cites:
#   D13 — Global active-active across us-central1, europe-west4, asia-northeast3
#   D17 — Vertex AI Agent Runtime (managed) hosts all 22 agents
#   D26 — Three UI surfaces (Mission Control / Dialogflow CX / mobile PWA);
#          the Mission Control SSR adapter and webhook receivers live on Cloud Run
#   SERVICE-INVENTORY.md §2 — Cloud Run services + jobs + worker pools,
#          GKE Autopilot (Agent Sandbox + GPU pods for Veo/Imagen) are all GA in 2026
#   COMPUTE.md §1, §2, §3, §6 — latest-2026 resource shapes used below
#
# Provider pin rationale:
#   - google >= 6.10.0: introduces `google_cloud_run_v2_worker_pool` (GA 2026-04-14)
#     and the L4 / RTX PRO 6000 Blackwell GPU shape on `google_cloud_run_v2_service`.
#   - google >= 6.20.0: `google_vertex_ai_reasoning_engine` (Agent Runtime native
#     resource) reaches stable in the google provider; before that it was google-beta.
#   - google-beta minimum pinned alongside in case downstream wants preview fields
#     (e.g. ephemeral disk volumes, SSH, MCP server) that have not yet been promoted
#     to the stable provider as of 2026-05.
#   - Upper bound < 8.0.0: protect against breaking changes in the next major.
#
# If the consumer is still on google < 6.20.0 (i.e. Agent Runtime resource not
# present), the module falls back to a `null_resource` + gcloud provisioner — see
# main.tf for the `agent_runtime_use_fallback` toggle.

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.20.0, < 8.0.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 6.20.0, < 8.0.0"
    }
    null = {
      source  = "hashicorp/null"
      version = ">= 3.2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
  }
}
