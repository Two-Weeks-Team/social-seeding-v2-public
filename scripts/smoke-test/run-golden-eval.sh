#!/usr/bin/env bash
# run-golden-eval.sh — OFFLINE golden-eval runner for ss_agents (H5).
#
# Closes the 4-expert review gap "golden eval set not wired to a runner;
# expected==answer overfits with no holdout" (GRAND-NARRATIVE-PLAN.md §5-1, H5).
#
# What it does:
#   Drives a chosen ADK agent's DETERMINISTIC predictor against its
#   `.evalset.json` through the supported offline seam (`run_agent` with an
#   injected predictor model client), scores each case against the case's
#   `metadata` expected fields, splits the result into train/dev vs HOLDOUT,
#   and prints a pass/score summary. The holdout slice is never used to tune the
#   predictor, so a high train accuracy with a low holdout accuracy is the
#   overfit signal the gate reports.
#
# This is FULLY OFFLINE: no Vertex, no gcloud, no creds, no billing. The
# coordinator's gemini-2.5-flash call is replaced by a deterministic predictor
# ($0). It is NOT ADK's live `adk eval` / `AgentEvaluator` — see
# packages/agents-adk/evals/README.md "Honest scope" for why that path cannot
# run offline against our stub.
#
# D-IDs: D25 (Agent-Evaluation rung of the learning loop), D37 (Layer-1 of the
# TDD pyramid, run offline as a PR gate), D5 (Flash agent, scored predictor).
#
# Usage:
#   bash scripts/smoke-test/run-golden-eval.sh                 # coordinator, floor 0.70
#   bash scripts/smoke-test/run-golden-eval.sh --agent coordinator --holdout-floor 0.7
#
# Exit codes (forwarded from `python -m evals`):
#   0 — holdout slice exists AND meets the floor.
#   1 — holdout slice below the floor (overfit / regression).
#   4 — unknown agent / environment error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AGENTS_PKG="${REPO_ROOT}/packages/agents-adk"
VENV_PY="${AGENTS_PKG}/.venv/bin/python"

# ---------------------------------------------------------------------------
# Pre-flight — fail fast with an actionable message if the venv isn't ready.
# ---------------------------------------------------------------------------
preflight() {
  if [[ ! -x "${VENV_PY}" ]]; then
    cat >&2 <<EOF
[golden-eval] agents-adk venv is missing at:
  ${VENV_PY}
Set it up with:
  cd ${AGENTS_PKG}
  uv venv && uv pip install -e '.[dev]'
EOF
    return 4
  fi
  if ! "${VENV_PY}" -c "import ss_agents" 2>/dev/null; then
    cat >&2 <<EOF
[golden-eval] ss_agents not importable from venv. Run:
  cd ${AGENTS_PKG}
  uv pip install -e '.[dev]'
EOF
    return 4
  fi
}

preflight

# ---------------------------------------------------------------------------
# Force offline so no creds / Vertex / billing can be reached. The predictor is
# deterministic; the run is free.
# ---------------------------------------------------------------------------
export SS_OFFLINE="1"
export SS_LIVE="0"
export PYTHONWARNINGS="ignore"

# The `evals` package lives at the package root, so run from there (it is added
# to sys.path automatically by `-m`).
cd "${AGENTS_PKG}"
exec "${VENV_PY}" -m evals "$@"
