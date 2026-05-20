#!/usr/bin/env bash
# run-model-garden-live.sh — operator-gated LIVE Model Garden proof (Track 3 req #3, D47).
#
# This is the ONE-TAKE live counterpart to the always-on offline wiring proof
#   packages/agents-adk/tests/runtime/test_run_with_adk_integration.py
#
# It runs a single REAL `intake` invocation through runtime._run_with_adk with
# Model Garden routing on, so the agent's reasoning is served from the Vertex AI
# Model Garden publisher-model plane. It prints the resolved Model Garden model
# path, the response JSON, and usd_spent (~$0.005–0.01 per run).
#
# HARD SAFETY GATE: the Python driver REFUSES (exit 1) unless SS_LIVE=1 AND
# MODEL_GARDEN_ROUTING=true, so a routine run can never accidentally bill. This
# wrapper does NOT default SS_LIVE on — the operator must opt in explicitly.
#
# Usage (operator runs this; never CI, never .env):
#   gcloud auth application-default login
#   SS_LIVE=1 MODEL_GARDEN_ROUTING=true \
#   GOOGLE_GENAI_USE_VERTEXAI=TRUE \
#   GOOGLE_CLOUD_PROJECT=ss-v2-prod GOOGLE_CLOUD_LOCATION=us-central1 \
#     bash scripts/smoke-test/run-model-garden-live.sh
#
# Exit codes (forwarded from model_garden_live_smoke.py):
#   0 — live Model Garden call returned a validated outcome.
#   1 — refused: SS_LIVE!=1 or MODEL_GARDEN_ROUTING!=true (no billing happened).
#   2 — refused: missing GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION.
#   3 — invocation escalated (transport / auth / validation error).
#   4 — environment / import error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AGENTS_PKG="${REPO_ROOT}/packages/agents-adk"
VENV_PY="${AGENTS_PKG}/.venv/bin/python"

# ---------------------------------------------------------------------------
# Pre-flight — fail fast with an actionable message if the dev environment
# isn't ready. We don't auto-install; that's the operator's call.
# ---------------------------------------------------------------------------
preflight() {
  if [[ ! -x "${VENV_PY}" ]]; then
    cat >&2 <<EOF
[model-garden-live] agents-adk venv is missing at:
  ${VENV_PY}
Set it up with:
  cd ${AGENTS_PKG}
  uv venv && uv pip install -e .
EOF
    return 127
  fi

  if ! "${VENV_PY}" -c "import ss_agents" 2>/dev/null; then
    cat >&2 <<EOF
[model-garden-live] ss_agents not importable from venv. Run:
  cd ${AGENTS_PKG}
  uv pip install -e .
EOF
    return 127
  fi
}

preflight

# ---------------------------------------------------------------------------
# We do NOT default SS_LIVE / MODEL_GARDEN_ROUTING on — the Python driver gates
# on them and refuses (exit 1) if they are not explicitly set by the operator.
# We DO surface what the operator passed so the run is auditable.
# ---------------------------------------------------------------------------
export PYTHONWARNINGS="${PYTHONWARNINGS:-ignore}"
export GRPC_VERBOSITY="${GRPC_VERBOSITY:-ERROR}"

echo "[model-garden-live] SS_LIVE=${SS_LIVE:-<unset>} MODEL_GARDEN_ROUTING=${MODEL_GARDEN_ROUTING:-<unset>}"
echo "[model-garden-live] GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT:-<unset>} GOOGLE_CLOUD_LOCATION=${GOOGLE_CLOUD_LOCATION:-<unset>}"

# ---------------------------------------------------------------------------
# Run.
# ---------------------------------------------------------------------------
exec "${VENV_PY}" "${SCRIPT_DIR}/model_garden_live_smoke.py" "$@"
