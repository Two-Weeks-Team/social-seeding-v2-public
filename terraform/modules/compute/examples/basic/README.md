# examples/basic — minimal 3-region usage of the compute module

Provisions the D13 active-active compute set (Cloud Run service + job + worker pool +
Vertex AI Agent Runtime endpoint per region) with sample container images, no CMEK,
and GKE Autopilot disabled. Intended as a `terraform plan` smoke test, not a
production deployment.

## Usage

```bash
cd terraform/modules/compute/examples/basic
terraform init
terraform plan -var="project_id=ss-v2-demo"
terraform apply -var="project_id=ss-v2-demo"
```

Expect provisioning to take ~5–8 min (Cloud Run is fast; Agent Runtime endpoints
dominate wall-clock).

## What you get

- 3× `google_cloud_run_v2_service.mission_control` (Hello sample image)
- 3× `google_cloud_run_v2_job.eval`
- 3× `google_cloud_run_v2_worker_pool.fanout`
- 3× `google_vertex_ai_reasoning_engine.runtime` (placeholder ADK agent)
- 0× GKE Autopilot cluster (toggled off in this example)

Outputs print the Cloud Run URLs and Agent Runtime resource names so you can
follow up with `gcloud run services describe` / `gcloud ai reasoning-engines describe`.

## Production wiring

This example deliberately leaves CMEK, VPC, custom SAs, and Autopilot out so the
module can stand on its own in a fresh project. The full production wiring lives
in `terraform/envs/prod/main.tf` (not in this directory) and pulls
`cmek_key_ids` from the security module, VPC links from networking, and SA
emails from iam — per D20 (CMEK) + D19 (IDP) + D31 (SLO).

## D-IDs touched

D13, D17, D18, D23, D26, D37 — see the parent module's `README.md` D-ID table for the full mapping.
