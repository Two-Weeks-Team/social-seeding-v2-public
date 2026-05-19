# `deploy/` — social-seeding-v2 Cloud Run + Agent Runtime operator runbook

> **Audience**: human operator with `gcloud auth login` access to the GCP project, plus the deploy bot service account that Cloud Build runs as.
>
> **Promise**: once the day-1 setup is done, every deploy is **`make deploy-all`** — no manual `gcloud run deploy`, no copy-pasted YAML.

---

## 1. What lives in this folder

| File | Purpose | Cites |
|---|---|---|
| `web/Dockerfile` | Multi-stage Next.js 16 standalone image; non-root; `/api/healthz` HEALTHCHECK | D7, D26 |
| `web/cloudbuild.yaml` | Build → AR push → CVE scan → `gcloud run services replace` → smoke test | D7, D13, D32, D44 |
| `web/service.yaml` | Cloud Run Knative manifest for Mission Control (min 1, max 100, 2Gi, CPU always allocated) | D17, D26, D31 |
| `agents/Dockerfile` | Multi-stage Python 3.12-slim + uv image; non-root; `/healthz` HEALTHCHECK | D7, D17, D23, D35 |
| `agents/cloudbuild.yaml` | Same shape as web + step 6 deploys to Vertex AI Agent Runtime | D7, D13, D17, D23 |
| `agents/service.yaml` | Cloud Run fallback service (4Gi LLM workload) | D17, D31 |
| `agents/agent-runtime-deploy.sh` | Iterates 22 agents, runs `vertexai.agent_engines.create()` per agent, emits `agent-urls.auto.tfvars` for D42 wire-up | **D17**, D23, D42 |
| `Makefile` | One-line targets: `build-*`, `deploy-*`, `smoke-test-prod`, `rollback-*` | D43 |

---

## 2. One-time day-1 setup (operator hands)

Before the first deploy. **Do this once per environment** (dev / staging / prod). Most of these are owned by `day-1-setup.sh` (run from `terraform/environments/<env>/`), but the deploy folder assumes they are in place.

```bash
# 1. Authenticate.
gcloud auth login
gcloud config set project ss-v2-prod

# 2. APIs the deploy needs.
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  containerscanning.googleapis.com \
  aiplatform.googleapis.com \
  cloudkms.googleapis.com \
  secretmanager.googleapis.com

# 3. Artifact Registry repos (per-region per D13).
for region in us-central1 europe-west1 asia-northeast1; do
  gcloud artifacts repositories create ss-web \
    --repository-format=docker \
    --location=$region \
    --description="Social Seeding v2 Mission Control"
  gcloud artifacts repositories create ss-agents \
    --repository-format=docker \
    --location=$region \
    --description="Social Seeding v2 ADK agents"
done

# 4. Service accounts (least-privilege).
gcloud iam service-accounts create web-runner \
  --display-name="Mission Control runtime SA"
gcloud iam service-accounts create agents-runner \
  --display-name="ss-agents runtime SA"

# 5. IAM bindings for the runtime SAs.
PROJECT_NUM=$(gcloud projects describe ss-v2-prod --format='value(projectNumber)')
gcloud projects add-iam-policy-binding ss-v2-prod \
  --member="serviceAccount:web-runner@ss-v2-prod.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
gcloud projects add-iam-policy-binding ss-v2-prod \
  --member="serviceAccount:agents-runner@ss-v2-prod.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
gcloud projects add-iam-policy-binding ss-v2-prod \
  --member="serviceAccount:agents-runner@ss-v2-prod.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# 6. KMS keyrings + crypto-keys (CMEK per D20).
for region in us-central1 europe-west1 asia-northeast1; do
  gcloud kms keyrings create ss-web --location=$region
  gcloud kms keys create cloud-run --location=$region --keyring=ss-web \
    --purpose=encryption
  gcloud kms keyrings create ss-agents --location=$region
  gcloud kms keys create cloud-run --location=$region --keyring=ss-agents \
    --purpose=encryption
done

# 7. Secret Manager — placeholders (real values via `gcloud secrets versions add`).
for s in web-auth-secret identity-platform-tenant-id google-oauth-client-id \
         google-oauth-client-secret agents-sentry-dsn; do
  gcloud secrets create "$s" --replication-policy=automatic
done

# 8. GCS bucket for the agent-urls.auto.tfvars artifact.
gsutil mb -p ss-v2-prod -c STANDARD -l us-central1 gs://ss-v2-prod-tfstate
```

---

## 3. The deploy: one command

```bash
cd /Users/kimsejun/Documents/GitHub/social-seeding-v2/deploy

# Default vars — override per region/env on the CLI.
make deploy-all PROJECT_ID=ss-v2-prod REGION=us-central1 REVISION_TAG=v1

# Or just web / just agents:
make deploy-web   PROJECT_ID=ss-v2-prod REGION=us-central1 REVISION_TAG=v1
make deploy-agents PROJECT_ID=ss-v2-prod REGION=us-central1 REVISION_TAG=v1
```

Behind the scenes `make deploy-all` →

1. `gcloud builds submit --config=deploy/web/cloudbuild.yaml ...`
   - builds & pushes the web image
   - CVE scans
   - renders `deploy/web/service.yaml` with the new SHA
   - `gcloud run services replace` (atomic; new revision tagged `${REVISION_TAG}`)
   - smoke-tests `/api/healthz`
2. `gcloud builds submit --config=deploy/agents/cloudbuild.yaml ...`
   - same pipeline for the agents image
   - **then** runs `agent-runtime-deploy.sh` which deploys each of the 22 agents (D23) to Vertex AI Agent Runtime (D17)
   - writes `agent-urls.auto.tfvars` to GCS so `terraform apply` (D42) can wire each agent URL into the Cloud Workflows YAML

Total wall time: ~12 min for the cold path (full rebuild + 22 Agent Runtime deploys), ~3 min for incremental.

---

## 4. Verify

```bash
# Operator-level health check — this is the D43 canary; it MUST exit 0 before
# you record a demo or page the team off the pager.
make smoke-test-prod PROJECT_ID=ss-v2-prod REGION=us-central1
```

Or manually:

```bash
WEB=$(gcloud run services describe ss-web --region=us-central1 --format='value(status.url)')
AGENTS=$(gcloud run services describe ss-agents --region=us-central1 --format='value(status.url)')

curl -fsS "$WEB/api/healthz"
# → {"ok":true,"revision":"...","commit":"..."}

curl -fsS "$AGENTS/healthz"
# → {"ok":true,"agents":22,"capability_mode":"live"}
```

Expected 200 OK on both. Cloud Run posts revision metrics into Cloud Monitoring (D32); alert policies are owned by `terraform/modules/monitoring`.

---

## 5. Rollback

Cloud Run keeps every revision — rollback is a traffic split, not a rebuild.

```bash
# Pin all traffic to the prior tag.
make rollback-web    TAG=stable PROJECT_ID=ss-v2-prod REGION=us-central1
make rollback-agents TAG=stable PROJECT_ID=ss-v2-prod REGION=us-central1
```

For an **Agent Runtime** rollback (D17), the previous Agent Engine instance still exists — point Cloud Workflows at the previous URL by re-applying the prior `agent-urls.auto.tfvars`:

```bash
gsutil cp gs://ss-v2-prod-tfstate/agent-urls/<prior-sha>.auto.tfvars ./agent-urls.auto.tfvars
cd ../terraform/environments/prod
terraform apply -var-file=../../../deploy/agent-urls.auto.tfvars
```

---

## 6. Canary

Default `deploy-*` ships 100% of traffic to the new revision. To canary:

```bash
# Deploy as `canary` (not `stable`) — traffic stays at 0 until you split it.
make deploy-web REVISION_TAG=canary

# Manual split (5% canary, 95% stable).
gcloud run services update-traffic ss-web \
  --region=us-central1 \
  --to-tags=canary=5,stable=95

# Promote once SLOs hold for 15 min.
gcloud run services update-traffic ss-web \
  --region=us-central1 \
  --to-tags=canary=100
```

---

## 7. Multi-region

Per D13, the same deploy is applied to all three regions. Either run three `make deploy-all` invocations in parallel (CI does this) or use the `--region` flag explicitly:

```bash
for region in us-central1 europe-west1 asia-northeast1; do
  make deploy-all REGION=$region REVISION_TAG=v1 &
done
wait
```

The Global Load Balancer (terraform-managed) decides which region a request hits; this folder only owns the per-region service.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR: set $PROJECT_ID` | Env var not exported | `export PROJECT_ID=ss-v2-prod` or pass on `make` CLI |
| `gcloud not authenticated` | First-time setup not done | `gcloud auth login` + `gcloud auth application-default login` |
| Cloud Build step 4 fails with `PERMISSION_DENIED` on `run.services.replace` | Cloud Build SA missing `roles/run.developer` | Re-run day-1 step 5 |
| Cloud Build step 6 deploys but tfvars file is empty | `agent-runtime-deploy.sh` failing silently | Check Cloud Build logs for `ERROR: deploy of <name> failed` |
| Smoke test fails with 401 | Cloud Run service ingress set to `internal-only`; need IAM-authenticated curl | `curl -H "Authorization: Bearer $(gcloud auth print-identity-token)"` |
| Agent Runtime deploy hits quota | `aiplatform.googleapis.com/reasoning_engines_per_region` cap reached | Request quota increase or delete unused engines via `gcloud ai reasoning-engines list` |

---

## 9. What this folder DOES NOT own

- **Infrastructure provisioning** (KMS, Secret Manager, Artifact Registry repos, IAM bindings, VPC connectors, Cloud Armor, Global LB) — see `terraform/environments/<env>/`.
- **Workflows YAMLs** (Cloud Workflows definitions per D42) — see `workflows/` (P1-W3 deliverable).
- **Monitoring policies + dashboards** (D32) — see `terraform/modules/monitoring`.
- **Application code** — `apps/web/` and `packages/agents-adk/` are owned by their respective track agents; this folder only PACKAGES them.

---

## 10. Quick links

- D17 (Agent Runtime): `gcp-research/decisions/DECISIONS.md:66`
- D7 (Containerized): `gcp-research/decisions/DECISIONS.md:46`
- D32 (Cloud Monitoring): `gcp-research/decisions/DECISIONS.md:101`
- D13 (3 regions): `gcp-research/decisions/DECISIONS.md:57`
- D23 (22 agents): `gcp-research/decisions/DECISIONS.md:82`
- D42 (terraform wire-up): `gcp-research/decisions/DECISIONS.md:131`
- D43 (canary smoke test): `gcp-research/decisions/DECISIONS.md:132`
