# Compute module — `terraform/modules/compute`

> Multi-region compute primitives for the `social-seeding-v2` AI agent platform on GCP.
> Provisions Cloud Run services + jobs + worker pools, Vertex AI Agent Runtime endpoints,
> and GKE Autopilot clusters across the three active-active regions from D13.

## D-ID anchors

| D-ID | Decision | How this module honors it |
|---|---|---|
| **D13** | Global multi-region active-active (`us-central1` + `europe-west4` + `asia-northeast3`) | Every resource is keyed by `for_each = toset(var.regions)`; default regions match D13 |
| **D17** | Vertex AI Agent Runtime (managed) hosts all 22 agents | `google_vertex_ai_reasoning_engine.runtime` per region × `agent_runtime_count`; gcloud fallback for pre-provider-6.20.0 |
| **D18** | Cloud Workflows + Pub/Sub + Cloud Tasks (Inngest retired) | `google_cloud_run_v2_worker_pool.fanout` per region for queue-driven fan-out workers |
| **D20** | CMEK across all stores | Cloud Run `encryption_key`, GKE `database_encryption`, Agent Runtime `encryption_spec` — all read from `var.cmek_key_ids` |
| **D23** | "Max verifiable agents" + watchdog; sandboxed code exec | `google_container_cluster.autopilot` per region with GKE Agent Sandbox-ready Workload Identity binding |
| **D26** | Three UI surfaces; Mission Control = Next.js 16 SSR | `google_cloud_run_v2_service.mission_control` per region (instance-based billing, min=1, IAP-via-LB ingress) |
| **D31** | Enterprise SLO (99.99%, p99 < 1s, RTO 1m, RPO 30s) | Multi-region symmetric provisioning + `min_instance_count` defaults preventing cold-start tail latency |
| **D37** | Vertex AI Agent Evaluation + Agent Simulation | `google_cloud_run_v2_job.eval` per region with parallelism=10, max_retries=3 |

Also reads from:
- `gcp-research/decisions/ARCHITECTURE.md` §2 — per-region resource matrix
- `gcp-research/decisions/SERVICE-INVENTORY.md` §2 — Compute & Containers status table
- `gcp-research/compute/COMPUTE.md` — 2026 feature inventory (GPU types, worker pools GA, ephemeral disk, MCP server)

## What this module provisions per region

```
us-central1 / europe-west4 / asia-northeast3 (D13)
├── google_cloud_run_v2_service.mission_control       (Next.js 16 SSR adapter — D26)
├── google_cloud_run_v2_job.eval                      (eval / sim / scan — D37)
├── google_cloud_run_v2_worker_pool.fanout            (Pub/Sub fan-out workers — D18)
├── google_vertex_ai_reasoning_engine.runtime[*]      (Agent Runtime endpoints — D17)
└── google_container_cluster.autopilot                (Agent Sandbox + GPU — D23/D26)
```

Plus IAM:
- Workload Identity binding (`workloadIdentityUser`) for GKE pods → runtime SA
- Cloud Workflows SA → `run.invoker` on Mission Control services

## Usage

### Minimal (single region, no CMEK)

```hcl
module "compute" {
  source = "./modules/compute"

  project_id            = "ss-v2-prod"
  regions               = ["us-central1"]
  gke_autopilot_enabled = false
}
```

### Production (3 regions, CMEK, custom SAs, shared VPC)

```hcl
module "compute" {
  source = "./modules/compute"

  project_id = "ss-v2-prod"
  regions    = ["us-central1", "europe-west4", "asia-northeast3"]

  service_account_runtime   = module.iam.agent_runner_sa_email
  service_account_workflows = module.iam.workflows_sa_email

  cmek_key_ids       = module.security.cmek_keys_by_region
  network_self_links = module.networking.vpc_self_links
  subnet_self_links  = module.networking.run_subnet_self_links

  agent_runtime_count           = 1
  gke_autopilot_enabled         = true
  gpu_type                      = "nvidia-l4"
  mission_control_min_instances = 2
  mission_control_max_instances = 50
  worker_pool_instances         = 5

  labels = {
    environment = "prod"
    cost_center = "engineering"
  }
}
```

## Inputs

See `variables.tf`. Headline knobs:

| Variable | Default | Purpose |
|---|---|---|
| `project_id` | (required) | GCP project; same project hosts all 3 regions per D13 |
| `regions` | `["us-central1","europe-west4","asia-northeast3"]` | D13 active-active set |
| `agent_runtime_count` | `1` | Endpoints per region (D17) |
| `gke_autopilot_enabled` | `true` | Toggle GKE Autopilot cluster (D23/D26) |
| `gpu_type` | `"nvidia-l4"` | Cloud Run GPU class (L4 24GB or RTX PRO 6000 96GB per COMPUTE.md §1) |
| `agent_runtime_use_fallback` | `false` | Force gcloud-provisioner fallback if provider lacks the native resource |
| `cmek_key_ids` | `{}` | Map of region → KMS key for D20 CMEK |
| `service_account_runtime` | `null` | SA to attach to all compute primitives; if null, default Compute SA is used |

## Outputs

See `outputs.tf`. Highlights:

- `mission_control_service_urls` — region → `https://...` for Global LB backend wiring
- `worker_pool_names` — region → name for Pub/Sub subscription binding
- `agent_runtime_endpoints` — `"<region>-<idx>"` → full resource name (or `fallback:<key>` if gcloud-provisioned)
- `gke_cluster_endpoints` — sensitive; piped into kubeconfig by CD
- `gke_workload_identity_pool` — single string; same for all clusters

## Assumptions and follow-ups

1. **Container images**: defaults point at `us-docker.pkg.dev/cloudrun/container/{hello,job,worker-pool}` so the module is `terraform plan`-clean in a brand-new project. Override `container_image_*` variables once the deploy pipeline (D38 PreviewForge build agents) publishes real images to Artifact Registry.

2. **Agent Runtime payload**: a placeholder ADK agent (`files/agent-placeholder.tar.gz`) is shipped to keep `spec.source_code_spec` valid. Real ADK bundles from `packages/agents/` replace it via the CD step that runs `agents-cli deploy` (D38). To avoid re-replacing on every `terraform apply`, the deploy pipeline should patch the resource directly and let Terraform `ignore_changes = [spec]` (TODO once a real bundle exists).

3. **GPU on Cloud Run**: not enabled in `mission_control` by default — `gpu_type` is wired in for the SSR service, but Mission Control SSR is CPU-bound (the actual model calls go to Vertex). To enable, add `resources.limits["nvidia.com/gpu"] = "1"` and `node_selector.accelerator = var.gpu_type` to the service template. The default `gpu_type = "nvidia-l4"` is here so downstream modules (creative-agent GPU service) can read it without re-declaring.

4. **Cloud Run Sandboxes** (Coming Soon per COMPUTE.md §1) and **Cloud Run Instances** (Preview) are not provisioned. When they go GA the same `for_each` pattern applies.

5. **CREMA / external metrics autoscaler**: worker pools are deployed with `MANUAL` scaling (COMPUTE.md §3: pools do not autoscale by default). Wire CREMA in the integration/ module to scale on Pub/Sub backlog; do not move that controller into compute/.

6. **Native vs fallback Agent Runtime**: the module prefers `google_vertex_ai_reasoning_engine` (provider ≥ 6.20.0). If you must use an older provider, set `agent_runtime_use_fallback = true` and a `null_resource` runs `gcloud beta ai reasoning-engines create`. The fallback has no idempotent update — destroy + recreate to change config. Migrate to native as soon as feasible.

7. **GKE Agent Sandbox**: enabled implicitly via Autopilot + Workload Identity. Pods opt in via the namespace label `runtime.googleapis.com/sandbox=gvisor` (set in workload manifests, not this module). Requires GKE ≥ 1.35.2-gke.1269000 per COMPUTE.md §6 — Autopilot REGULAR channel meets this.

8. **CMEK on Cloud Run Jobs**: the `google_cloud_run_v2_job` resource accepts `encryption_key` at the top level just like services. The current module does not yet set it on jobs because the eval job writes only to GCS (which is encrypted via its own CMEK in the data/ module). Add `encryption_key = lookup(var.cmek_key_ids, each.key, null)` if a future job retains in-region state.

## Verification

```bash
cd terraform/modules/compute/examples/basic
terraform init
terraform fmt -recursive ..
terraform validate
terraform plan -var="project_id=YOUR_PROJECT"
```

## Provider versions

Pinned in `versions.tf`:

- `hashicorp/google` ≥ 6.20.0, < 8.0.0 (stable; brings `google_vertex_ai_reasoning_engine` to the non-beta provider)
- `hashicorp/google-beta` ≥ 6.20.0, < 8.0.0 (for fields still in beta — GKE Autopilot fleet flags, Agent Runtime preview fields)
- `hashicorp/null` ≥ 3.2.0 (fallback path only)
- `hashicorp/random` ≥ 3.6.0

Verified against `google-beta` v7.32.0 (released 2026-05-12).
