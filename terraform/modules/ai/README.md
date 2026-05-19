# terraform/modules/ai

**TF-Module-7** — Vertex AI Agent Platform resources for `social-seeding-v2`.

Implements the AI / Agents / Vertex slice of the GCP service inventory
(`gcp-research/decisions/SERVICE-INVENTORY.md` §3) per the decisions
recorded in `gcp-research/decisions/DECISIONS.md`:

| D-ID | What this module provisions |
|---|---|
| **D5**  | Model Garden access pins (Gemini 2.5 Pro / Flash / Flash-Lite + 3.1 Pro Preview demo only). |
| **D15** | Firestore Native database backing Agent Memory Bank. |
| **D16** | 3 × Vertex AI Vector Search indexes (`creators_v1`, `brands_v1`, `content_v1`) + 1 shared regional endpoint. |
| **D17** | Agent Runtime deploys for 19 of 22 agents (Tier 1 + Tier 2). Watchdog Cloud Run services (Tier 3) live in the `compute` module. |
| **D19** | IAM bindings tying the Agent Runtime SA to `aiplatform.user` + `aiplatform.serviceAgent`. |
| **D20** | CMEK passthrough hook (`var.cmek_key_name`) for Vector Search + Firestore. |
| **D21** | Routing flag (`var.agent_gateway_id`) into the Model-Armor-fronted Agent Gateway provisioned by the `security` module. |
| **D23** | 22 A2A v0.3 Agent Cards published to GCS + Agent Registry seed. |
| **D24** | Tier 1 (domain) / Tier 2 (meta — `coordinator`/`critic`/`optimizer`) / Tier 3 (watchdog) split. |
| **D25** | Vertex AI Pipelines: SFT + Distillation (Pro→Flash) + RLHF on Agent Simulation. |
| **D26** | Discovery Engine app (= Gemini Enterprise app) + Dialogflow CX skeleton for the customer-support surface. |
| **D33** | Memory Bank TTL of 14 days; Sessions TTL of 24 hours. |
| **D39** | Cost feature flags so dev environments can disable Vector Search / Workbench / pipelines. |

## Status of underlying APIs (2026-05)

| Resource | Provider surface | Maturity | Migration path |
|---|---|---|---|
| `google_vertex_ai_index*` | `hashicorp/google` | GA | none |
| `google_vertex_ai_index_endpoint*` | `hashicorp/google` | GA | none |
| `google_firestore_database` | `hashicorp/google` | GA | none |
| `google_firestore_field` (TTL) | `hashicorp/google` | GA | none |
| `google_workbench_instance` | `hashicorp/google` | GA | none |
| `google_dialogflow_cx_agent`/`webhook` | `hashicorp/google` | GA | none |
| `google_discovery_engine_*` | `hashicorp/google` | GA | none |
| Agent Runtime (Reasoning Engine deploy) | **no TF surface** | Preview API | `null_resource` → `python -m packages.agents.deploy.deploy_agent`. Replace with `google_vertex_ai_reasoning_engine` when GA. |
| Agent Registry registration | **no TF surface** | Preview API | `null_resource` → `gcloud beta agents register`. Replace with `google_agent_registry_agent` when GA. |
| Discovery Engine "agent attach" | **no TF surface** | Preview API | `null_resource` → REST POST to `v1alpha/.../agents`. Replace with `google_discovery_engine_agent` when GA. |
| Vertex AI Pipelines recurring schedule | partial | GA (one-shot) | `null_resource` for run-on-apply; Cloud Scheduler (in `integration` module) drives recurring. |

The Preview-only paths are wrapped with a configurable `|| true` suffix
(driven by `var.feature_flags.fail_on_preview_resource_err`) so that the
module **does not break a root `terraform apply`** if a Private Preview
endpoint is unavailable in the operator's allow-listed regions.

## Inputs (highlights)

See `variables.tf` for the full list. Mandatory:

- `project_id`, `project_number`, `region`
- `network_self_link`
- `agent_runtime_service_account_email`
- `data_scientist_service_account_email`
- `staging_bucket_name`

Defaulted-but-tunable:

- `agent_registry` — 22-agent map (D23). Each entry carries tier, model
  tier (`judgment | bulk | classifier`), skills, memory strategy, eval
  criteria, autonomy gate (`always_ask | ask_on_external_send |
  autonomous_with_caps`), USD cap per run, escalation target.
- `vector_indexes` — 3 indexes by default. Tune `min_replica_count` /
  `max_replica_count` to balance D39 credits vs. D31 latency SLO.
- `pipelines` — SFT / Distillation / RLHF templates. **You must upload
  the YAML template files to GCS first** (paths default to
  `gs://REPLACE_ME/...` which intentionally fails fast in dry-runs).
- `feature_flags` — cost levers; flip to `false` for dev.

## Outputs (highlights)

- `memory_bank_database_name`, `agent_sessions_database_name` — wired
  into the agent code at startup.
- `vector_search_endpoint_id`, `vector_search_indexes`,
  `vector_search_deployed_indexes` — passed to sourcing / vetting /
  research agents.
- `agent_card_bucket_paths` — fed to Cloud Marketplace listing flow
  (Track 3 path per `AI-AGENTS.md` §C3).
- `discovery_engine_app_id`, `dialogflow_cx_agent_id` — Mission Control
  surface IDs (D26).
- `module_summary` — one-screen status object (count of agents per tier,
  pipelines active, cmek/gateway flags). Consumed by the observability
  dashboards.

## Usage

See `examples/basic` for the minimum invocation.

```hcl
module "ai" {
  source = "./terraform/modules/ai"

  project_id     = var.project_id
  project_number = var.project_number
  region         = "us-central1"

  network_self_link                    = module.networking.vpc_self_link
  vector_search_reserved_ip_range_name = module.networking.vertex_vector_range_name

  agent_runtime_service_account_email  = module.security.agent_runtime_sa_email
  data_scientist_service_account_email = module.security.data_scientist_sa_email
  cmek_key_name                        = module.security.vertex_cmek_key

  staging_bucket_name = module.data.staging_bucket_name

  # Optional: route through Agent Gateway when security module has it ready.
  agent_gateway_id = module.security.agent_gateway_id
}
```

## What is intentionally NOT in this module

- **Model Armor templates + floor settings** — owned by the `security`
  module per `ARMOR-GATEWAY.md` §5. We only set the routing flag.
- **Agent Gateway resource** — also owned by `security`. This module
  *consumes* its id via `var.agent_gateway_id`.
- **Watchdog Cloud Run services** (Tier-3 `anomaly_watch`, `cost_watch`,
  `security_watch`) — they're cheaper as Cloud Run; the `compute`
  module owns them. Their *registry* entries do still live here (so
  Tier-2 `coordinator` can discover them via Agent Registry).
- **Pub/Sub topics / Cloud Workflows definitions** — owned by the
  `integration` module per D18.
- **BigQuery audit dataset / Cloud Logging sinks** — owned by the
  `observability` module per D32.

## Test plan

The module has no Terraform-native unit tests; validation strategy:

1. `terraform init -upgrade && terraform validate` against
   `examples/basic` after pointing the variables at a sandbox project.
2. `terraform plan` and confirm:
   - 22 × `google_storage_bucket_object.agent_cards`
   - 3 × `google_vertex_ai_index.this`
   - 1 × `google_vertex_ai_index_endpoint.shared`
   - 3 × `google_vertex_ai_index_endpoint_deployed_index.this`
   - 2 × `google_firestore_database` (`agent-memory-bank` + `agent-sessions`)
   - 1 × `google_dialogflow_cx_agent` + webhook
   - 1 × `google_discovery_engine_chat_engine`
   - 19 × `null_resource.agent_runtime_deploy` (Tier 1 + 2)
3. Smoke-test the Agent Cards: `gsutil cat
   $(terraform output -raw agent_card_bucket_paths)/sourcing.json | jq .`
   should print a valid A2A v0.3 schema.
4. Vector Search round-trip: deploy a 2-dimensional toy index using
   `vector_indexes` override, push a vector via the agent SDK, run
   `find_neighbors`, confirm < 50 ms p99 per D31.
