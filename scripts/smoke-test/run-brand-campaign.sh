#!/usr/bin/env bash
# run-brand-campaign.sh — W4 end-to-end smoke entry point (D43 canary).
#
# Per DECISIONS.md:132 (D43) "End-to-end smoke test is the Phase-3 canary
# gating deploy/demo — scripts/smoke-test/run-brand-campaign.sh exercises
# brand-brief → 22-agent fleet → … → final report; must exit 0 before any
# deploy or demo recording."
#
# Constraints (D43 + W4 brief):
#   - No network access (CAPABILITY_LAYER_MODE=stub for every tool).
#   - No live GCP, no real Gmail (D10: even live demos restrict to operator-
#     owned test accounts), no real RapidAPI.
#   - <30s wall time on a clean checkout.
#
# Exit codes (forwarded from brand_campaign_smoke.py):
#   0 — happy path
#   1 — at least one agent has tools=[]
#   2 — at least one tool failed stub-mode invocation
#   3 — expected-output.json drift detected
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
  if ! command -v uv >/dev/null 2>&1; then
    cat >&2 <<EOF
[smoke-test] uv is required.
  curl -LsSf https://astral.sh/uv/install.sh | sh
EOF
    return 127
  fi

  if [[ ! -x "${VENV_PY}" ]]; then
    cat >&2 <<EOF
[smoke-test] agents-adk venv is missing at:
  ${VENV_PY}
Set it up with:
  cd ${AGENTS_PKG}
  uv venv && uv pip install -e .
EOF
    return 127
  fi

  if ! "${VENV_PY}" -c "import ss_agents" 2>/dev/null; then
    cat >&2 <<EOF
[smoke-test] ss_agents not importable from venv. Run:
  cd ${AGENTS_PKG}
  uv pip install -e .
EOF
    return 127
  fi
}

preflight

# ---------------------------------------------------------------------------
# Stub-mode environment. We force the canonical capability-layer mode at the
# shell level so even subprocesses (none today, but future-proof) inherit it.
# CAPABILITY_LAYER_MODE=stub is the D41 anchor for offline runs.
# ---------------------------------------------------------------------------
export CAPABILITY_LAYER_MODE="stub"
export SS_OFFLINE="1"
unset SS_LIVE || true
# Quiet Google libraries so the smoke-test output stays parseable.
export PYTHONWARNINGS="ignore"
export GRPC_VERBOSITY="${GRPC_VERBOSITY:-ERROR}"

# ---------------------------------------------------------------------------
# Run.
# ---------------------------------------------------------------------------
exec "${VENV_PY}" "${SCRIPT_DIR}/brand_campaign_smoke.py" "$@"
