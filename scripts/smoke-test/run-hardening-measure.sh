#!/usr/bin/env bash
# run-hardening-measure.sh — re-runnable proof of the "we hardened it" chapter.
#
# Runs the conversation_responder triage hardening measurement (H2/H3/H4) and
# prints the BEFORE → AFTER triage pass-rate. Fully offline + deterministic:
# no LLM, no GCP credentials, no billing. The numbers it prints are the SAME
# numbers written to scripts/demo/assets/hardening-before-after.json — nothing
# is fabricated; this script IS the proof, re-run it any time.
#
# Honest scope (GRAND-NARRATIVE-PLAN §7, RULES.md §Professional Honesty):
#   The before/after comes from a LOCAL deterministic optimization pass over the
#   synthetic edge-case set. The live Vertex AI Agent Optimizer is the
#   production path and is stubbed today (W7-deferred = NotImplementedError).
#
# Usage:
#   bash scripts/smoke-test/run-hardening-measure.sh
#
# Exit codes (forwarded from hardening_measure.py):
#   0 — measured + artifacts written; hardening did not regress.
#   4 — environment / import error.
#   5 — regression (after < before).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AGENTS_PKG="${REPO_ROOT}/packages/agents-adk"
VENV_PY="${AGENTS_PKG}/.venv/bin/python"

# Force offline + stub everywhere — this measurement must never touch Vertex,
# gcloud, or billing. Mirrors conftest.py's SS_OFFLINE pin.
export SS_OFFLINE="1"
export SS_LIVE="0"
export SS_OTEL_ENABLED="false"
export CAPABILITY_LAYER_MODE="${CAPABILITY_LAYER_MODE:-stub}"
export PYTHONWARNINGS="ignore"

# Prefer the package venv; fall back to `uv run` if the venv isn't built yet.
if [[ -x "${VENV_PY}" ]]; then
  exec "${VENV_PY}" "${SCRIPT_DIR}/hardening_measure.py" "$@"
elif command -v uv >/dev/null 2>&1; then
  echo "[hardening] venv not found at ${VENV_PY}; using 'uv run'." >&2
  cd "${AGENTS_PKG}"
  exec uv run --extra dev python "${SCRIPT_DIR}/hardening_measure.py" "$@"
else
  cat >&2 <<EOF
[hardening] No usable Python. Build the agents-adk venv first:
  cd ${AGENTS_PKG}
  uv venv && uv pip install -e '.[dev]'
EOF
  exit 4
fi
