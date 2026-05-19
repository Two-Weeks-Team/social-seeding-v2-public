#!/usr/bin/env bash
# day-1-setup.sh — Bootstrap GCP for Google for Startups AI Agents Challenge
# Source of truth: gcp-research/decisions/DECISIONS.md (D1-D39)
# Billing: app.2weeks@gmail.com credit accounts (vibeCat 수상 외)
# Mode: A + B parallel — spawn agents + provision GCP at the same time
#
# Usage:
#   ./day-1-setup.sh init           # one-shot: create v2 + mcp + shared projects, link billing, enable APIs
#   ./day-1-setup.sh apis [PROJECT] # enable / re-enable APIs only
#   ./day-1-setup.sh kms [PROJECT]  # provision KMS keyrings + CMEK keys
#   ./day-1-setup.sh secrets [PROJECT] # create empty Secret Manager slots
#   ./day-1-setup.sh budget [PROJECT]  # bind budget alerts
#   ./day-1-setup.sh artifacts [PROJECT] # create Artifact Registry repos
#   ./day-1-setup.sh verify [PROJECT]    # smoke test the setup
#   ./day-1-setup.sh all [PROJECT]       # apis + kms + secrets + budget + artifacts + verify
#
# Prerequisites:
#   gcloud auth login --account=app.2weeks@gmail.com
#   gcloud auth application-default login --account=app.2weeks@gmail.com
#   gcloud config set account app.2weeks@gmail.com

set -euo pipefail

# ============================================================================
# CONFIGURATION — override via env vars before running
# ============================================================================
: "${BILLING_ACCOUNT:?Set BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX before running. Find with: gcloud beta billing accounts list}"
: "${OPERATOR_EMAIL:=app.2weeks@gmail.com}"
: "${PROJECT_V2:=ss-v2-prod}"
: "${PROJECT_MCP:=ss-mcp-prod}"
: "${PROJECT_SHARED:=ss-shared-infra}"
: "${BUDGET_TOTAL_USD:=1500}"  # D39
: "${REGIONS:=us-central1 europe-west4 asia-northeast3}"   # D13
: "${PRIMARY_REGION:=asia-northeast3}"
: "${LANGS:=ko en ja zh}"       # D34

# All APIs required per SERVICE-INVENTORY.md
APIS=(
  # AI / Agents
  aiplatform.googleapis.com discoveryengine.googleapis.com
  dialogflow.googleapis.com generativelanguage.googleapis.com
  modelarmor.googleapis.com
  # Compute
  run.googleapis.com cloudfunctions.googleapis.com
  container.googleapis.com containerregistry.googleapis.com
  compute.googleapis.com
  # Workflows / events
  workflows.googleapis.com eventarc.googleapis.com
  cloudtasks.googleapis.com cloudscheduler.googleapis.com
  pubsub.googleapis.com
  # Data
  spanner.googleapis.com alloydb.googleapis.com
  firestore.googleapis.com bigquery.googleapis.com
  bigqueryconnection.googleapis.com bigquerydatatransfer.googleapis.com
  bigqueryreservation.googleapis.com
  dataform.googleapis.com dataflow.googleapis.com
  storage.googleapis.com storagetransfer.googleapis.com
  redis.googleapis.com
  # Security / IAM
  cloudkms.googleapis.com secretmanager.googleapis.com
  dlp.googleapis.com identitytoolkit.googleapis.com
  iap.googleapis.com iam.googleapis.com
  iamcredentials.googleapis.com sts.googleapis.com
  certificatemanager.googleapis.com
  binaryauthorization.googleapis.com
  containeranalysis.googleapis.com
  securitycenter.googleapis.com
  chronicle.googleapis.com
  # Networking
  servicenetworking.googleapis.com vpcaccess.googleapis.com
  networksecurity.googleapis.com networkservices.googleapis.com
  dns.googleapis.com
  # DevOps
  cloudbuild.googleapis.com artifactregistry.googleapis.com
  clouddeploy.googleapis.com
  sourcerepo.googleapis.com  # for migration reference only
  workstations.googleapis.com
  # Observability
  monitoring.googleapis.com logging.googleapis.com
  cloudtrace.googleapis.com cloudprofiler.googleapis.com
  clouderrorreporting.googleapis.com
  opentelemetry.googleapis.com
  # Integration
  apigee.googleapis.com apphub.googleapis.com
  integrations.googleapis.com connectors.googleapis.com
  # Specialized AI
  vision.googleapis.com speech.googleapis.com
  texttospeech.googleapis.com translate.googleapis.com
  documentai.googleapis.com
  # Firebase / hosting
  firebase.googleapis.com firebasehosting.googleapis.com
  firebaserules.googleapis.com firebaseappcheck.googleapis.com
  apphosting.googleapis.com fcm.googleapis.com
  # Management / orchestration
  cloudresourcemanager.googleapis.com cloudbilling.googleapis.com
  serviceusage.googleapis.com
  # Marketplace (Track 3)
  cloudcommerceconsumerprocurement.googleapis.com
  cloudcommerceproducer.googleapis.com
)

# ============================================================================
# Helpers
# ============================================================================
log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
err()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }

ensure_gcloud_auth() {
  local current
  current="$(gcloud config get-value account 2>/dev/null || true)"
  if [[ "${current}" != "${OPERATOR_EMAIL}" ]]; then
    err "Active gcloud account is '${current}'. Expected ${OPERATOR_EMAIL}."
    err "Run: gcloud auth login --account=${OPERATOR_EMAIL}"
    exit 1
  fi
  ok "gcloud authenticated as ${OPERATOR_EMAIL}"
}

create_project_if_absent() {
  local project="$1"
  local label="$2"
  if gcloud projects describe "${project}" >/dev/null 2>&1; then
    ok "project ${project} exists"
  else
    log "creating project ${project} (${label})"
    gcloud projects create "${project}" --name="${label}" --labels=owner=ss-ops,env=prod
    ok "created ${project}"
  fi
}

link_billing() {
  local project="$1"
  log "linking billing account ${BILLING_ACCOUNT} to ${project}"
  gcloud beta billing projects link "${project}" --billing-account="${BILLING_ACCOUNT}"
  ok "billing linked for ${project}"
}

enable_apis() {
  local project="$1"
  log "enabling ${#APIS[@]} APIs on ${project} (this takes 5-10 min)"
  # Enable in batches of 20 to avoid request size limits
  local i=0
  local batch=()
  for api in "${APIS[@]}"; do
    batch+=("${api}")
    i=$((i+1))
    if (( i % 20 == 0 )); then
      gcloud services enable "${batch[@]}" --project="${project}" --quiet || warn "batch enable returned non-zero (likely already enabled)"
      batch=()
    fi
  done
  if (( ${#batch[@]} > 0 )); then
    gcloud services enable "${batch[@]}" --project="${project}" --quiet || warn "tail batch enable returned non-zero"
  fi
  ok "APIs enabled on ${project}"
}

create_artifact_repos() {
  local project="$1"
  log "creating Artifact Registry repos on ${project}"
  for region in ${REGIONS}; do
    gcloud artifacts repositories create ss-docker \
      --repository-format=docker --location="${region}" \
      --description="SS agent + service container images (D37)" \
      --project="${project}" --quiet 2>/dev/null \
      && ok "artifacts/ss-docker/${region}" \
      || warn "ss-docker @ ${region} exists or failed"
    gcloud artifacts repositories create ss-python \
      --repository-format=python --location="${region}" \
      --description="SS python packages (ADK + capabilities)" \
      --project="${project}" --quiet 2>/dev/null \
      && ok "artifacts/ss-python/${region}" \
      || warn "ss-python @ ${region} exists or failed"
    gcloud artifacts repositories create ss-npm \
      --repository-format=npm --location="${region}" \
      --description="SS npm packages (Mission Control + Genkit)" \
      --project="${project}" --quiet 2>/dev/null \
      && ok "artifacts/ss-npm/${region}" \
      || warn "ss-npm @ ${region} exists or failed"
  done
}

create_kms() {
  local project="$1"
  log "creating KMS keyrings + CMEK keys on ${project} (D20)"
  for region in ${REGIONS}; do
    gcloud kms keyrings create ss-keyring \
      --location="${region}" --project="${project}" --quiet 2>/dev/null \
      || warn "keyring exists in ${region}"
    for key in spanner-cmek alloydb-cmek firestore-cmek storage-cmek bigquery-cmek pubsub-cmek; do
      gcloud kms keys create "${key}" \
        --keyring=ss-keyring --location="${region}" \
        --purpose=encryption --rotation-period=90d --next-rotation-time="$(date -u -v+90d +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -d '+90 days' +%Y-%m-%dT00:00:00Z)" \
        --project="${project}" --quiet 2>/dev/null \
        && ok "kms/${region}/${key}" \
        || warn "${key} @ ${region} exists or failed"
    done
  done
}

create_secrets() {
  local project="$1"
  log "creating Secret Manager slots on ${project} (D20 — empty seeds)"
  local secrets=(
    rapidapi-key                # D14
    gmail-oauth-refresh         # D10 (test account only)
    instagram-graph-token       # D14 (TBD)
    chronicle-api-key           # D32
    pagerduty-webhook           # D32
    slack-webhook               # D32
    identity-platform-sdk-key   # D19
    stripe-secret-key           # phase-2 fallback for AP2
  )
  for s in "${secrets[@]}"; do
    if gcloud secrets describe "${s}" --project="${project}" >/dev/null 2>&1; then
      warn "secret ${s} exists"
    else
      printf "PLACEHOLDER" | gcloud secrets create "${s}" \
        --replication-policy=user-managed \
        --locations="$(echo ${REGIONS} | tr ' ' ',')" \
        --project="${project}" --data-file=- --quiet
      ok "secrets/${s}"
    fi
  done
}

create_budget() {
  local project="$1"
  log "creating $${BUDGET_TOTAL_USD} budget with 9 alert thresholds on ${project}"
  gcloud billing budgets create \
    --billing-account="${BILLING_ACCOUNT}" \
    --display-name="${project}-budget" \
    --budget-amount="${BUDGET_TOTAL_USD}USD" \
    --threshold-rule=percent=0.10 \
    --threshold-rule=percent=0.25 \
    --threshold-rule=percent=0.50 \
    --threshold-rule=percent=0.75 \
    --threshold-rule=percent=0.90 \
    --threshold-rule=percent=0.95 \
    --threshold-rule=percent=1.00 \
    --threshold-rule=percent=0.50,basis=forecasted-spend \
    --threshold-rule=percent=0.90,basis=forecasted-spend \
    --filter-projects="projects/${project}" \
    --quiet 2>/dev/null \
    && ok "budget bound to ${project}" \
    || warn "budget may already exist for ${project}"
}

bootstrap_pubsub_topics() {
  local project="$1"
  log "creating canonical Pub/Sub topics on ${project} (D18)"
  local topics=(
    campaign.submitted
    campaign.shortlist.approved
    creator-track.fanout
    creator-track.outreach-sent
    creator-track.reply-received
    creator-track.shipment-tracking
    creator-track.post-detected
    gmail.reply.received
    gmail.watch.expire
    cost.threshold-breach
    armor.block-detected
    anomaly.detected
    approval.requested
    approval.resolved
    audit.event
  )
  for t in "${topics[@]}"; do
    gcloud pubsub topics create "${t}" \
      --message-retention-duration=7d \
      --project="${project}" --quiet 2>/dev/null \
      && ok "pubsub/${t}" \
      || warn "topic ${t} exists or failed"
  done
}

# ============================================================================
# Verify
# ============================================================================
verify_project() {
  local project="$1"
  log "verifying ${project}"
  echo "  ── project info ──"
  gcloud projects describe "${project}" --format='value(projectId,name,projectNumber,lifecycleState)'
  echo "  ── billing ──"
  gcloud beta billing projects describe "${project}" --format='value(billingAccountName,billingEnabled)'
  echo "  ── api count ──"
  local enabled
  enabled=$(gcloud services list --enabled --project="${project}" --format='value(NAME)' | wc -l | tr -d ' ')
  echo "  ${enabled} APIs enabled"
  echo "  ── artifact registry ──"
  gcloud artifacts repositories list --project="${project}" --format='table(name.basename(),format,location)' 2>/dev/null | head -20
  echo "  ── kms keyrings ──"
  for region in ${REGIONS}; do
    local count
    count=$(gcloud kms keys list --keyring=ss-keyring --location="${region}" --project="${project}" --format='value(name)' 2>/dev/null | wc -l | tr -d ' ')
    echo "  ${region}: ${count} keys"
  done
  echo "  ── secrets ──"
  gcloud secrets list --project="${project}" --format='value(name.basename())' | wc -l | xargs -I{} echo "  {} secrets"
  echo "  ── pubsub topics ──"
  gcloud pubsub topics list --project="${project}" --format='value(name.basename())' | wc -l | xargs -I{} echo "  {} topics"
}

# ============================================================================
# Sub-commands
# ============================================================================
cmd_init() {
  ensure_gcloud_auth
  for spec in "${PROJECT_V2}:Social Seeding v2 (Track 2)" \
              "${PROJECT_MCP}:Social Seeding MCP (Track 3)" \
              "${PROJECT_SHARED}:Social Seeding shared infra"; do
    local project="${spec%%:*}"
    local label="${spec##*:}"
    create_project_if_absent "${project}" "${label}"
    link_billing "${project}"
  done
  ok "init done — next: ./day-1-setup.sh all ${PROJECT_V2}"
}

cmd_all() {
  local project="${1:-${PROJECT_V2}}"
  ensure_gcloud_auth
  enable_apis "${project}"
  create_artifact_repos "${project}"
  create_kms "${project}"
  create_secrets "${project}"
  create_budget "${project}"
  bootstrap_pubsub_topics "${project}"
  verify_project "${project}"
  ok "all-setup done on ${project}"
}

case "${1:-}" in
  init)       cmd_init ;;
  apis)       ensure_gcloud_auth; enable_apis "${2:-${PROJECT_V2}}" ;;
  artifacts)  ensure_gcloud_auth; create_artifact_repos "${2:-${PROJECT_V2}}" ;;
  kms)        ensure_gcloud_auth; create_kms "${2:-${PROJECT_V2}}" ;;
  secrets)    ensure_gcloud_auth; create_secrets "${2:-${PROJECT_V2}}" ;;
  budget)     ensure_gcloud_auth; create_budget "${2:-${PROJECT_V2}}" ;;
  pubsub)     ensure_gcloud_auth; bootstrap_pubsub_topics "${2:-${PROJECT_V2}}" ;;
  verify)     ensure_gcloud_auth; verify_project "${2:-${PROJECT_V2}}" ;;
  all)        cmd_all "${2:-${PROJECT_V2}}" ;;
  ""|help|--help)
    cat <<EOF
day-1-setup.sh — usage:
  init                        Create 3 projects + link billing (run once first)
  all [PROJECT]               Run apis+artifacts+kms+secrets+budget+pubsub+verify
  apis [PROJECT]              Enable all 60+ APIs
  artifacts [PROJECT]         Create Docker/Python/npm repos in 3 regions
  kms [PROJECT]               Create CMEK keyrings + 6 keys in 3 regions
  secrets [PROJECT]           Create 8 empty Secret Manager slots
  budget [PROJECT]            Bind \$${BUDGET_TOTAL_USD} budget with 9 alerts
  pubsub [PROJECT]            Create 15 canonical Pub/Sub topics
  verify [PROJECT]            Print resource counts to confirm setup

Env vars (export before running):
  BILLING_ACCOUNT     billing account ID (find: gcloud beta billing accounts list)
  OPERATOR_EMAIL      default: app.2weeks@gmail.com
  PROJECT_V2          default: ss-v2-prod
  PROJECT_MCP         default: ss-mcp-prod
  PROJECT_SHARED      default: ss-shared-infra
  BUDGET_TOTAL_USD    default: 1500
  REGIONS             default: us-central1 europe-west4 asia-northeast3
EOF
    ;;
  *) err "unknown sub-command: $1"; exit 2 ;;
esac
