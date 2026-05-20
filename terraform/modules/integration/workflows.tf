# workflows.tf — 5 Cloud Workflows definitions (durable orchestration, D18).
#
# Per INNGEST-MIGRATION.md §4, the YAML bodies live in workflows/*.yaml and
# are loaded via file() rather than embedded HCL heredocs. Rationale:
#   - YAML stays valid for `gcloud workflows deploy` smoke tests.
#   - Editor tooling (yaml-language-server, GCP Workflows VS Code ext)
#     works without HCL escape gymnastics.
#   - Diffs in PRs read as workflow changes, not Terraform churn.
#
# The 5 workflows below:
#   - brand-campaign      : parent fan-out (INNGEST-MIGRATION §4.1)
#   - creator-track       : per-creator child with 14d reply-callback (§4.2)
#   - gate                : reusable approval subworkflow (§4.3)
#   - gmail-watch-renew   : weekly cron — Gmail watch TTL refresh
#   - report-deliver-cron : weekly Monday 09:00 KST report dispatch
#
# Cron schedules are wired in scheduler.tf — the workflows themselves are
# trigger-agnostic (Eventarc OR Scheduler OR direct API can invoke them).
#
# Env vars passed via env_vars become accessible inside the YAML via
# `${sys.get_env("KEY")}` — this is how we plumb the Cloud Run service URLs
# without hardcoding them into the YAML (var.service_endpoints).

locals {
  workflow_definitions = {
    "brand-campaign" = {
      yaml_file   = "brand-campaign.workflows.yaml"
      description = "Brand-campaign parent fan-out (D18; mirrors v2 packages/workflows/src/workflows/brand-campaign.ts)."
    }
    "brand-campaign-demo" = {
      yaml_file   = "brand-campaign-demo.workflows.yaml"
      description = "Wave 3 / Track 3 trimmed demo: coordinate_sourcing → branch_on_route → a2a_invoke_remote (real ss-mcp) → check_a2a_outcome → return RankedCreators. Executable end-to-end multi-agent orchestration take (D23/D24/D45)."
    }
    "creator-track" = {
      yaml_file   = "creator-track.workflows.yaml"
      description = "Per-creator child workflow with durable callbacks for reply + post-detected (INNGEST-MIGRATION §3.2)."
    }
    "gate" = {
      yaml_file   = "gate.workflows.yaml"
      description = "Reusable approval gate subworkflow (INNGEST-MIGRATION §3.4 / gate.ts port)."
    }
    "gmail-watch-renew" = {
      yaml_file   = "gmail-watch-renew.workflows.yaml"
      description = "Weekly Gmail watch TTL refresh (Gmail watch expires every 7d)."
    }
    "report-deliver-cron" = {
      yaml_file   = "report-deliver-cron.workflows.yaml"
      description = "Weekly Monday 09:00 KST campaign report delivery."
    }
  }

  # Common env vars exposed to all workflows. Workflows YAML reads these via
  # sys.get_env(). Keep this dictionary explicit — Workflows does not have
  # ${var.*} interpolation.
  #
  # AGENT_RUNTIME_URL is retained as a transition-period fallback for any
  # YAML branch we missed; W7 (deploy) will drop it once per-agent URLs are
  # confirmed populated for every workspace.
  workflow_base_env_vars = {
    GOOGLE_CLOUD_PROJECT_ID = var.project_id
    OBSERVABILITY_URL       = var.service_endpoints.observability_url
    POLICY_URL              = var.service_endpoints.policy_url
    CAMPAIGN_REPO_URL       = var.service_endpoints.campaign_repo_url
    AGENT_RUNTIME_URL       = var.service_endpoints.agent_runtime_url
    PICK_SHORTLIST_URL      = var.service_endpoints.pick_shortlist_url
    CREATOR_DIRECTORY_URL   = var.service_endpoints.creator_directory_url
    CALLBACK_ROUTER_URL     = var.service_endpoints.callback_router_url
    APPROVALS_API_URL       = var.service_endpoints.approvals_api_url
    GATE_PREDICATE_URL      = var.service_endpoints.gate_predicate_url
  }

  # Per-agent endpoint env vars derived from var.agent_urls (D42).
  # Key shape: AGENT_URL_<UPPER_AGENT_ID>. The YAML reads this via
  # `${sys.get_env("AGENT_URL_SOURCING")}` as the fallback branch of the
  # `default(map.get(args.agent_urls, "<id>"), …)` pattern. See
  # terraform/modules/integration/WIRE-NOTES.md for the full contract.
  #
  # Note: `coordinator` is one of the 22 registry agents, so when it is present
  # in var.agent_urls this loop already emits AGENT_URL_COORDINATOR — the
  # env-var fallback brand-campaign.workflows.yaml's coordinate_sourcing step
  # relies on (G1 / D23). `tiktok-mcp-search`, if injected at runtime, would map
  # to AGENT_URL_TIKTOK_MCP_SEARCH here; the dedicated AGENT_URL_TIKTOK_MCP
  # below is the canonical name the YAML's a2a_invoke_remote step reads.
  workflow_agent_env_vars = {
    for agent_id, url in var.agent_urls :
    format("AGENT_URL_%s", upper(replace(agent_id, "-", "_"))) => url
  }

  # Remote A2A node env-var fallback (G1 / D45). The OSS tiktok-mcp-server is a
  # Cloud Run A2A endpoint (var.tiktok_mcp_endpoint), not a Vertex Agent Runtime
  # agent, so it is wired explicitly here rather than via the agent_urls loop.
  # brand-campaign.workflows.yaml's a2a_invoke_remote step resolves it as
  # `default(map.get(args.agent_urls, "tiktok-mcp-search"),
  # sys.get_env("AGENT_URL_TIKTOK_MCP"))` — same D42 args/env layering, still
  # zero hardcoded hostnames in the YAML.
  workflow_a2a_env_vars = var.tiktok_mcp_endpoint == "" ? {} : {
    AGENT_URL_TIKTOK_MCP = var.tiktok_mcp_endpoint
  }

  workflow_env_vars = merge(
    local.workflow_base_env_vars,
    local.workflow_agent_env_vars,
    local.workflow_a2a_env_vars,
  )
}

resource "google_workflows_workflow" "workflows" {
  for_each = local.workflow_definitions

  name            = each.key
  region          = var.primary_region
  project         = var.project_id
  description     = each.value.description
  service_account = var.workflows_invoker_sa_email

  source_contents = file("${path.module}/${var.workflow_yaml_dir}/${each.value.yaml_file}")

  user_env_vars = local.workflow_env_vars

  labels = local.labels

  # Workflows revisions stay on the revision they started on (D18 R4
  # equivalent to Inngest version pinning). Cloud Deploy handles canary.
  call_log_level = "LOG_ALL_CALLS"
}
