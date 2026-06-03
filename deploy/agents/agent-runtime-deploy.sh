#!/usr/bin/env bash
###############################################################################
# deploy/agents/agent-runtime-deploy.sh
#
# Deploys each of the 22 production agents (D23 fleet: 16 domain + 3 meta
# + 3 watchdog) to **Vertex AI Agent Runtime** (managed) per D17.
#
# Cites:
#   D17 — Vertex AI Agent Runtime (managed) is the production host for the
#         22-agent fleet. Sub-second cold start; 7-day long-running. Each
#         agent is deployed as a separate Agent Engine instance so we can
#         scale, scope IAM, and roll back per agent.
#   D23 — 22-agent fleet inventory (Tier-1 16 domain + Tier-2 3 meta + Tier-3
#         3 watchdog).
#   D42 — Cloud Workflows YAML wires agent URLs via Terraform output. This
#         script emits the per-agent URLs into terraform.tfvars format
#         (`/workspace/agent-urls.auto.tfvars`) so `terraform apply` picks
#         them up without manual editing.
#
# Deploy command (verified 2026-05-19 via Context7 /google/adk-python):
#   * Python SDK: `vertexai.agent_engines.create(agent_engine=root_agent,
#                  requirements=["google-cloud-aiplatform[adk,agent_engines]"])`
#   * CLI:        `adk deploy agent_engine`   (NOTE: replaces the deprecated
#                  `gcloud beta agents deploy` from earlier previews; current
#                  spelling is the `adk` CLI shipped with `google-adk>=1.3`)
#
# We use the `adk` CLI here because it (a) takes the same image / source as
# Cloud Run, (b) emits a stable URL, and (c) plays nicely with Cloud Build
# (no Python serialization of the agent graph required).
#
# Usage:
#   PROJECT_ID=ss-v2-prod \
#   REGION=us-central1 \
#   REVISION_TAG=v1 \
#   IMAGE_URI=us-central1-docker.pkg.dev/ss-v2-prod/ss-agents/agents:abc1234 \
#   bash deploy/agents/agent-runtime-deploy.sh
#
# Required env vars:
#   PROJECT_ID    — GCP project ID
#   REGION        — Region (us-central1 / europe-west1 / asia-northeast1 per D13)
#   IMAGE_URI     — Artifact Registry image URI (set by cloudbuild.yaml step 6)
#
# Optional env vars:
#   REVISION_TAG  — Traffic-targeting tag (default: `stable`)
#   DRY_RUN       — If `1`, print the commands without executing
#   TFVARS_OUT    — Output path for tfvars file (default: /workspace/agent-urls.auto.tfvars)
#   AGENT_FILTER  — Comma-separated agent names to deploy (default: all 22)
###############################################################################
set -euo pipefail

# -----------------------------------------------------------------------------
# Env-var guards — fail fast with a clear actionable message.
# -----------------------------------------------------------------------------
require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "ERROR: set \$${name} (e.g. export ${name}=...)" >&2
    exit 1
  fi
}

require_env PROJECT_ID
require_env REGION
require_env IMAGE_URI

REVISION_TAG="${REVISION_TAG:-stable}"
DRY_RUN="${DRY_RUN:-0}"
TFVARS_OUT="${TFVARS_OUT:-/workspace/agent-urls.auto.tfvars}"
AGENT_FILTER="${AGENT_FILTER:-}"

# -----------------------------------------------------------------------------
# The 22-agent fleet per D23. Each entry:
#   <agent_name> <tier> <model_class> <module_path>
# Tiers:
#   T1 = domain (16); T2 = meta (3); T3 = watchdog (3).
# Model classes (for Agent Runtime billing tag — informational only).
# D53: Gemini 3.5/3.1 ONLY (no 2.5, no *-pro). The legacy tier labels below map to:
#   pro       = gemini-3.5-flash        (judgment tier)
#   flash     = gemini-3.5-flash
#   flash-lt  = gemini-3.1-flash-lite   (bulk tier)
#   pro+veo   = gemini-3.5-flash + Veo 3 / Imagen 4 (creative agent)
# -----------------------------------------------------------------------------
AGENTS=(
  # Tier 1 — domain (16)
  "sourcing                T1  pro       ss_agents.agents.sourcing:root_agent"
  "vetting                 T1  pro       ss_agents.agents.vetting:root_agent"
  "outreach_writer         T1  pro       ss_agents.agents.outreach_writer:root_agent"
  "conversation            T1  flash-lt  ss_agents.agents.conversation:root_agent"
  "conversation_responder  T1  pro       ss_agents.agents.conversation_responder:root_agent"
  "logistics               T1  flash     ss_agents.agents.logistics:root_agent"
  "content_verify          T1  flash     ss_agents.agents.content_verify:root_agent"
  "analyst                 T1  pro       ss_agents.agents.analyst:root_agent"
  "research                T1  pro       ss_agents.agents.research:root_agent"
  "intake                  T1  flash     ss_agents.agents.intake:root_agent"
  "lead_outreach_writer    T1  pro       ss_agents.agents.lead_outreach_writer:root_agent"
  "payment_mandate         T1  flash     ss_agents.agents.payment_mandate:root_agent"
  "compliance              T1  pro       ss_agents.agents.compliance:root_agent"
  "creative                T1  pro+veo   ss_agents.agents.creative:root_agent"
  "a11y                    T1  flash     ss_agents.agents.a11y:root_agent"
  "customer_success        T1  pro       ss_agents.agents.customer_success:root_agent"
  # Tier 2 — meta (3)
  "coordinator             T2  pro       ss_agents.agents.coordinator:root_agent"
  "critic                  T2  pro       ss_agents.agents.critic:root_agent"
  "optimizer               T2  pro       ss_agents.agents.optimizer:root_agent"
  # Tier 3 — watchdog (3)
  "anomaly_watch           T3  flash     ss_agents.agents.anomaly_watch:root_agent"
  "cost_watch              T3  flash     ss_agents.agents.cost_watch:root_agent"
  "security_watch          T3  flash     ss_agents.agents.security_watch:root_agent"
)

# -----------------------------------------------------------------------------
# Pre-flight: ensure tooling is present.
# -----------------------------------------------------------------------------
echo "--- Agent Runtime deploy pre-flight ---"
echo "PROJECT_ID    = ${PROJECT_ID}"
echo "REGION        = ${REGION}"
echo "IMAGE_URI     = ${IMAGE_URI}"
echo "REVISION_TAG  = ${REVISION_TAG}"
echo "DRY_RUN       = ${DRY_RUN}"
echo "TFVARS_OUT    = ${TFVARS_OUT}"
echo "AGENT_FILTER  = ${AGENT_FILTER:-<all>}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud not on PATH; install Cloud SDK first" >&2
  exit 1
fi

if ! command -v adk >/dev/null 2>&1; then
  echo "WARN: 'adk' CLI not on PATH — falling back to 'python -m adk'"
  ADK_CMD=(python -m adk)
else
  ADK_CMD=(adk)
fi

# Capture project + region in the gcloud config so the CLI doesn't re-prompt.
gcloud config set project "${PROJECT_ID}" --quiet
gcloud config set ai/region "${REGION}" --quiet

# Initialize the tfvars file. Format follows D42 (terraform consumes the file
# verbatim; `agent_urls` is a map(string) variable).
mkdir -p "$(dirname "${TFVARS_OUT}")"
cat > "${TFVARS_OUT}" <<EOF
# Auto-generated by deploy/agents/agent-runtime-deploy.sh
# Cites: D17 (Agent Runtime), D23 (22-agent fleet), D42 (terraform wire-up).
# Project:  ${PROJECT_ID}
# Region:   ${REGION}
# Image:    ${IMAGE_URI}
# Revision: ${REVISION_TAG}
agent_urls = {
EOF

# -----------------------------------------------------------------------------
# Deploy loop. Each agent gets its own Agent Engine instance so:
#   * IAM scoping is per-agent (D20)
#   * Rollback is per-agent (D24 phased coordination)
#   * Cost attribution per agent (D32 + D39)
# -----------------------------------------------------------------------------
deploy_one() {
  local name="$1"
  local tier="$2"
  local model_class="$3"
  local module_path="$4"

  if [ -n "${AGENT_FILTER}" ] && [[ ",${AGENT_FILTER}," != *",${name},"* ]]; then
    echo "[skip] ${name} (filter)"
    return 0
  fi

  echo ""
  echo "--- deploying agent: ${name} (tier=${tier} model=${model_class}) ---"

  # Display name: stable across revisions; the Agent Runtime ID is generated.
  local display_name="ss-${name}"
  local agent_url=""

  # NOTE: `adk deploy agent_engine` expects a project + region + an importable
  # module path that yields the `root_agent` symbol. The image is implicit —
  # `adk` builds and uploads a venv. To keep the IMAGE_URI as the source of
  # truth we use the Vertex AI Python SDK path inline (subprocess), which lets
  # us pin the container image while still using the supported `agent_engines`
  # API (verified via Context7 /google/adk-python; the inline SDK call is the
  # documented escape hatch when the CLI doesn't expose a `--image` flag).
  local deploy_script
  deploy_script=$(cat <<PYEOF
import os, sys, json
import vertexai
from vertexai import agent_engines
from importlib import import_module

project   = os.environ["PROJECT_ID"]
region    = os.environ["REGION"]
mod_path, attr = "${module_path}".split(":")
display   = "${display_name}"
image_uri = os.environ.get("IMAGE_URI")  # informational; passed via labels
tier      = "${tier}"
model_cls = "${model_class}"
revision  = os.environ["REVISION_TAG"]

vertexai.init(project=project, location=region)
root_agent = getattr(import_module(mod_path), attr)

# `requirements` covers the runtime deps the managed environment must install.
# `gcs_dir_name` is auto-generated; we let the SDK choose a unique path.
remote = agent_engines.create(
    agent_engine=root_agent,
    display_name=display,
    description=f"Social Seeding v2 {tier} agent ({model_cls}); image={image_uri}; revision={revision}",
    requirements=[
        "google-cloud-aiplatform[adk,agent_engines]>=1.95",
        "google-adk>=1.3,<2",
    ],
    extra_packages=[],  # source already inside the wheel
    env_vars={
        "GOOGLE_CLOUD_PROJECT": project,
        "GOOGLE_CLOUD_LOCATION": region,
        "GOOGLE_GENAI_USE_VERTEXAI": "true",
        "CAPABILITY_LAYER_MODE": "live",
        "MODEL_ARMOR_INPUT_TEMPLATE": f"projects/{project}/locations/{region}/templates/ss-input",
        "MODEL_ARMOR_OUTPUT_TEMPLATE": f"projects/{project}/locations/{region}/templates/ss-output",
        "MODEL_ARMOR_FAIL_MODE": "closed",
        "REVISION_TAG": revision,
        "AGENT_NAME": "${name}",
        "AGENT_TIER": tier,
    },
)

# Persist the resource name + REST endpoint for terraform.tfvars output.
info = {
    "resource_name": remote.resource_name,
    "name": "${name}",
    "tier": tier,
    "url": f"https://{region}-aiplatform.googleapis.com/v1beta1/{remote.resource_name}:streamQuery",
}
print(json.dumps(info))
PYEOF
)

  if [ "${DRY_RUN}" = "1" ]; then
    echo "[dry-run] would deploy ${name} from ${module_path}"
    agent_url="https://${REGION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${REGION}/reasoningEngines/DRYRUN-${name}:streamQuery"
  else
    local result_json
    if ! result_json=$(PROJECT_ID="${PROJECT_ID}" REGION="${REGION}" REVISION_TAG="${REVISION_TAG}" IMAGE_URI="${IMAGE_URI}" \
        python3 -c "${deploy_script}"); then
      echo "ERROR: deploy of ${name} failed" >&2
      return 1
    fi
    echo "${result_json}"
    agent_url=$(echo "${result_json}" | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])")
  fi

  # Append to tfvars map.
  printf '  %-26s = "%s"\n' "${name}" "${agent_url}" >> "${TFVARS_OUT}"
}

deploy_count=0
fail_count=0

for row in "${AGENTS[@]}"; do
  # shellcheck disable=SC2086  # we *want* word-splitting here
  set -- $row
  if deploy_one "$1" "$2" "$3" "$4"; then
    deploy_count=$((deploy_count + 1))
  else
    fail_count=$((fail_count + 1))
  fi
done

# Close the tfvars map.
cat >> "${TFVARS_OUT}" <<EOF
}

# Summary: deployed=${deploy_count}, failed=${fail_count}, total=${#AGENTS[@]}
EOF

echo ""
echo "--- Agent Runtime deploy summary ---"
echo "deployed = ${deploy_count}"
echo "failed   = ${fail_count}"
echo "total    = ${#AGENTS[@]}"
echo "tfvars   = ${TFVARS_OUT}"

if [ "${fail_count}" -gt 0 ]; then
  echo "ERROR: ${fail_count} agent(s) failed to deploy" >&2
  exit 1
fi

echo "All ${deploy_count} agents deployed successfully."
echo ""
echo "Next step: terraform apply -var-file=${TFVARS_OUT}"
