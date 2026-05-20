# DEPLOY-RUNBOOK — Executable brand-campaign demo (Wave 3 / Track 3)

Turns the **already-wired** brand-campaign Cloud Workflow into a **genuinely
live, executable** end-to-end multi-agent orchestration. ~3 operator commands
after a one-time setup.

> **Operator-gated.** These commands need YOUR ADC / billing / IAM. Claude wrote
> the artifacts; it does **not** run `gcloud` or deploy. Run these yourself.
>
> **Safety rails (CLAUDE.md):** never touch prod port 8080, `ss-landing`, or any
> `.env`. Everything below lives in **new projects only** — `ss-v2-prod` (agents
> + workflow) and `ss-mcp-prod` (the existing A2A node). No production service is
> restarted or modified.

---

## What gets deployed

| Artifact | Project | What it is |
|---|---|---|
| `ss-agents` (Cloud Run) | `ss-v2-prod` | `packages/agents-adk/serve.py` — `POST /<agent_id>` for `coordinator`, `sourcing`, `vetting`. Makes the workflow's `http.post` steps reachable (was `https://stub.local/<id>`). |
| `ss-mcp-server` (Cloud Run) | `ss-mcp-prod` | The OSS tiktok-mcp A2A node. **Already deployed + live** at `https://ss-mcp-server-1049119860518.us-central1.run.app` (`REQUIRE_AUTH=false`). No redeploy needed for the demo. |
| `brand-campaign-demo` (Workflows) | `ss-v2-prod` | `terraform/modules/integration/workflows/brand-campaign-demo.workflows.yaml` — the trimmed, executable orchestration. |
| `workflows-invoker` (SA) | `ss-v2-prod` | Service account the Workflow runs as; granted `run.invoker` on `ss-agents` (same project) **and cross-project on `ss-mcp-server`** (only matters if ss-mcp's auth is ever turned on). |

The headline edge: **coordinate_sourcing (ss-agents `/coordinator`) →
branch_on_route → a2a_invoke_remote (ss-mcp `/v1/message:send`, A2A v0.3) →
check_a2a_outcome → return RankedCreators**, executed by Workflows itself.

---

## 0. Prerequisites (one-time)

```bash
export PROJECT=ss-v2-prod
export REGION=us-central1
export MCP_PROJECT=ss-mcp-prod
export REPO=ss                                  # Artifact Registry repo
export AR_HOST="${REGION}-docker.pkg.dev"

gcloud config set project "$PROJECT"
gcloud auth login            # or: gcloud auth application-default login

# Enable APIs (agents project)
gcloud services enable \
  run.googleapis.com \
  workflows.googleapis.com \
  workflowexecutions.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  aiplatform.googleapis.com \
  --project "$PROJECT"

# Artifact Registry repo for the image (skip if it already exists)
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker --location="$REGION" --project "$PROJECT" \
  || echo "repo exists, continuing"
```

IAM you need on yourself (or a deploy SA): `roles/run.admin`,
`roles/iam.serviceAccountAdmin`, `roles/workflows.admin`,
`roles/cloudbuild.builds.editor`, `roles/artifactregistry.writer`.

---

## 1. Build + push the ss-agents image

```bash
export IMG="${AR_HOST}/${PROJECT}/${REPO}/ss-agents:demo-$(date +%Y%m%d-%H%M)"

gcloud builds submit packages/agents-adk \
  --tag "$IMG" \
  --project "$PROJECT"
```

(Build context is `packages/agents-adk/`; the `Dockerfile` + `.dockerignore`
there keep it to `src/`, `serve.py`, `pyproject.toml`, `README.md`.)

---

## 2. Deploy ss-agents to Cloud Run

```bash
# Create the SA the agents run as (Vertex calls when SS_LIVE=1)
gcloud iam service-accounts create ss-agents-runtime \
  --project "$PROJECT" --display-name "ss-agents runtime" || true
export AGENTS_SA="ss-agents-runtime@${PROJECT}.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:${AGENTS_SA}" --role roles/aiplatform.user

gcloud run deploy ss-agents \
  --image "$IMG" \
  --project "$PROJECT" --region "$REGION" \
  --service-account "$AGENTS_SA" \
  --no-allow-unauthenticated \
  --port 8080 \
  --memory 1Gi --cpu 1 --timeout 300 \
  --set-env-vars "SS_LIVE=1,GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=${PROJECT},GOOGLE_CLOUD_LOCATION=${REGION},MODEL_GARDEN_ROUTING=true,SS_DEFAULT_MAX_USD=0.20,SS_DEFAULT_CAMPAIGN_BUDGET_USD=25.00"

export AGENTS_URL="$(gcloud run services describe ss-agents \
  --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo "ss-agents → $AGENTS_URL"

# Sanity (you'll be prompted for an identity token since --no-allow-unauthenticated):
curl -sS -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "$AGENTS_URL/healthz" | python3 -m json.tool
# → {"status":"ok","service":"ss-agents-adk","agents":["coordinator","sourcing","vetting"]}
```

> Keep `SS_LIVE=1` for the real demo (Gemini routing decisions + live agents).
> Set `SS_LIVE=0` for a zero-cost dry run that uses the deterministic offline
> stub path. `MODEL_GARDEN_ROUTING=true` pins reasoning to the Vertex Model
> Garden plane (D47).

---

## 3. Workflows invoker SA + IAM

```bash
gcloud iam service-accounts create workflows-invoker \
  --project "$PROJECT" --display-name "brand-campaign-demo invoker" || true
export WF_SA="workflows-invoker@${PROJECT}.iam.gserviceaccount.com"

# Invoke ss-agents (same project, OIDC).
gcloud run services add-iam-policy-binding ss-agents \
  --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:${WF_SA}" --role roles/run.invoker

# Cross-project invoke on ss-mcp-server. The demo deploy of ss-mcp runs
# REQUIRE_AUTH=false so this binding is NOT required for the demo to work — but
# grant it anyway so the same workflow keeps working if ss-mcp's auth is later
# enabled at the Cloud Run layer. (No-op / harmless if ss-mcp stays open.)
gcloud run services add-iam-policy-binding ss-mcp-server \
  --project "$MCP_PROJECT" --region "$REGION" \
  --member "serviceAccount:${WF_SA}" --role roles/run.invoker \
  || echo "skip: needs run.admin on $MCP_PROJECT, not required while ss-mcp is open"
```

---

## 4. Deploy the demo workflow

```bash
gcloud workflows deploy brand-campaign-demo \
  --project "$PROJECT" --location "$REGION" \
  --service-account "$WF_SA" \
  --source terraform/modules/integration/workflows/brand-campaign-demo.workflows.yaml
```

(Or `cd terraform && terraform apply` — the workflow is registered in
`modules/integration/workflows.tf` as `brand-campaign-demo`. Raw `gcloud` is the
fastest path for the demo.)

---

## 5. Run it (the ~1-command demo)

`agent_urls` is passed at runtime (D42) so **no URL is ever hardcoded** in the
YAML. The remote node id `tiktok-mcp-search` matches the `^tiktok-mcp` branch.

```bash
export MCP_URL="https://ss-mcp-server-1049119860518.us-central1.run.app"

gcloud workflows run brand-campaign-demo \
  --project "$PROJECT" --location "$REGION" \
  --data "$(cat <<JSON
{
  "campaignId": "cmp_demo_$(date +%s)",
  "budgetRemainingUsd": 2.50,
  "brief": {
    "workspaceId": "ws_demo_serve_0001",
    "createdBy": "operator@social-seeding.test",
    "brandProduct": {
      "name": "Freshly Vitamin C Serum",
      "category": "skincare/serum",
      "description": "Brightening Vitamin C serum with hyaluronic acid.",
      "keyClaims": ["10% vitamin C", "fragrance-free", "vegan"]
    },
    "targeting": {
      "creatorCount": 20, "minEngagementRate": 0.03,
      "languages": ["ko"], "hashtags": ["스킨케어", "비타민C"]
    },
    "logistics": { "shipsSamples": true },
    "goals": { "targetLivePosts": 15, "deadline": "2026-06-30T23:59:00Z" }
  },
  "agent_urls": {
    "coordinator": "${AGENTS_URL}/coordinator",
    "sourcing": "${AGENTS_URL}/sourcing",
    "tiktok-mcp-search": "${MCP_URL}"
  }
}
JSON
)"
```

Expected execution result (the `coordinate_sourcing → a2a_invoke_remote` path):

```json
{
  "campaignId": "cmp_demo_...",
  "decision": "completed",
  "route": "a2a_remote",
  "chosenAgentId": "tiktok-mcp-search",
  "routingRationale": "...",
  "a2aState": "completed",
  "rankedCreators": [ /* REAL RankedCreators from ss-mcp */ ],
  "trackCount": 5
}
```

Inspect the run + per-step trace:

```bash
gcloud workflows executions list brand-campaign-demo \
  --project "$PROJECT" --location "$REGION" --limit 1
```

---

## OIDC vs Identity Platform — the ss-mcp hop (read this)

ss-mcp does **not** verify Cloud Run OIDC tokens. Its `require_identity`
dependency (`gcp-research/refactor-mcp/code/agent/src/tiktok_orchestrator/main.py`)
verifies an **Identity Platform** Bearer ID token (issuer = Identity Platform,
audience = the IP project), and only when `REQUIRE_AUTH=true`. A Cloud Run OIDC
token minted for the `run.invoker` audience would be **rejected** by ss-mcp's
verifier — the audiences don't match.

**Decision for the demo:** the `a2a_invoke_remote` step in
`brand-campaign-demo.workflows.yaml` sends **no `auth:` block**. The live ss-mcp
demo service runs `REQUIRE_AUTH=false` (confirmed in `deployment/agent.json`
`x-securityPosture.note`), so it accepts the A2A `message:send` unauthenticated.
This is the honest, reachable posture for the open Track-3 demo — and it's why
the cross-project `run.invoker` grant in step 3 is optional today.

**Production path (when ss-mcp turns auth on):** the workflow must present an
Identity Platform ID token, not a Cloud Run OIDC token. Two options:
1. **Token-exchange shim** — a tiny Cloud Run service (or a step that calls the
   Identity Platform `signInWithCustomToken` REST API with a Secret-Manager
   service-account key) mints an IP ID token for ss-mcp's audience; the workflow
   reads it and sets `headers.Authorization: "Bearer <token>"` on the A2A step.
2. **Front ss-mcp with Cloud Run OIDC** — flip ss-mcp to also accept Cloud Run
   IAM (`--no-allow-unauthenticated` + `run.invoker`) and add `auth: {type: OIDC}`
   to the A2A step. This is the simpler path but changes ss-mcp's auth model.

Until then, **demo = unauthenticated ss-mcp hop**, documented and intentional.

---

## Cost note

- Live Gemini calls happen only with `SS_LIVE=1`. Each agent is capped:
  `coordinator` $0.005/invocation, `sourcing` $2.50, `vetting` $0.03 (the
  per-invocation `max_usd` raises `BudgetExceeded` → escalation before overspend).
  The per-campaign ceiling is `SS_DEFAULT_CAMPAIGN_BUDGET_USD=25.00` (D39).
- The demo's `a2a_remote` route invokes the coordinator (~$0.005) + ss-mcp (the
  ss-mcp side bills its own Gemini/MCP usage in `ss-mcp-prod`). One demo run is
  well under $0.05 on the `ss-v2-prod` side.
- Cloud Run scales to zero; Workflows + Cloud Build are pennies. Set `SS_LIVE=0`
  to rehearse the whole orchestration at **zero** model cost (offline stub path).

---

## `deploy_agent.py` — the Reasoning-Engine null_resource

`terraform/modules/ai/main.tf` §8 (`null_resource.agent_runtime_deploy`) invokes
`python -m packages.agents.deploy.deploy_agent` — historically a Vertex AI
**Reasoning Engine** (Agent Engine) deploy, a Preview API with no first-class TF
resource. **Wave 3 replaces that with the Cloud Run path above** (serve.py +
this runbook), which is GA and demonstrable.

The shim `packages/agents/deploy/deploy_agent.py` now exists and, by default
(`--mode=cloud-run`), resolves the deployed `ss-agents` URL and writes the
per-agent runtime marker terraform/`agent_urls` consume — it does **not** create
a Reasoning Engine. Offline check (no GCP calls):

```bash
python3 packages/agents/deploy/deploy_agent.py \
  --agent-id=coordinator --project=ss-v2-prod --region=us-central1 --mode=print
```

To record markers after a real Cloud Run deploy:

```bash
for a in coordinator sourcing vetting; do
  python3 packages/agents/deploy/deploy_agent.py \
    --agent-id="$a" --project="$PROJECT" --region="$REGION" \
    --service ss-agents --staging-bucket "gs://${PROJECT}-staging" \
    --mode=cloud-run
done
```
