#!/usr/bin/env bash
# run-integration-a2a.sh — cross-component A2A integration smoke (Track 3 req #5).
#
# Exercises the load-bearing D45 edge (DECISIONS.md:139):
#   coordinator (M1, Track 2)
#     → a2a_invoke (capability layer, CAPABILITY_LAYER_MODE=live)
#     → tiktok-mcp-server.plan_creator_search (Track 3, A2A v0.3 over HTTP)
#
# Unlike run-brand-campaign.sh (D43, fully offline/stub), THIS smoke makes ONE
# real outbound HTTPS hop to the deployed ss-mcp-server. The coordinator LLM is
# still stubbed ($0); the remote ranker runs in stub-mode (~$0, no Gemini).
#
# Usage:
#   CAPABILITY_LAYER_MODE=live A2A_TARGET=https://ss-mcp-server-….run.app \
#     bash scripts/smoke-test/run-integration-a2a.sh
#
# The target URL comes from $A2A_TARGET (or the I1 default baked into the
# Python driver). It is NEVER read from .env and never hardcoded into the
# package source.
#
# Exit codes (forwarded from integration_a2a_smoke.py):
#   0 — coordinator routed to the remote A2A agent AND the live hop returned a
#       completed task with ≥1 creator.
#   1 — coordinator did not route to the remote A2A candidate.
#   2 — the live A2A hop failed (transport / non-2xx / non-completed task).
#   3 — the live A2A hop returned no creators.
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
[a2a-integration] agents-adk venv is missing at:
  ${VENV_PY}
Set it up with:
  cd ${AGENTS_PKG}
  uv venv && uv pip install -e .
EOF
    return 127
  fi

  if ! "${VENV_PY}" -c "import ss_agents" 2>/dev/null; then
    cat >&2 <<EOF
[a2a-integration] ss_agents not importable from venv. Run:
  cd ${AGENTS_PKG}
  uv pip install -e .
EOF
    return 127
  fi
}

preflight

# ---------------------------------------------------------------------------
# Live capability-layer mode is REQUIRED for this smoke — the whole point is to
# exercise a2a_invoke._live(). We force it on (the Python driver re-asserts it
# too) so the hop is real, but the agent runtime stays offline (no Vertex) so
# the coordinator's routing decision is the stub's deterministic output ($0).
# ---------------------------------------------------------------------------
export CAPABILITY_LAYER_MODE="live"
export SS_OFFLINE="1"          # coordinator LLM uses the stub model client
unset SS_LIVE || true
export PYTHONWARNINGS="ignore"
export GRPC_VERBOSITY="${GRPC_VERBOSITY:-ERROR}"

# Default target (I1 산출, ss-mcp-prod / us-central1) if the operator didn't set one.
export A2A_TARGET="${A2A_TARGET:-https://ss-mcp-server-1049119860518.us-central1.run.app}"

echo "[a2a-integration] CAPABILITY_LAYER_MODE=${CAPABILITY_LAYER_MODE} A2A_TARGET=${A2A_TARGET}"

# ---------------------------------------------------------------------------
# Run.
# ---------------------------------------------------------------------------
exec "${VENV_PY}" "${SCRIPT_DIR}/integration_a2a_smoke.py" "$@"
