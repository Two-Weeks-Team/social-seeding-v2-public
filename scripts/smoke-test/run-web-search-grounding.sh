#!/usr/bin/env bash
# run-web-search-grounding.sh — operator-gated LIVE Google Search grounding proof
# (D53 + D41). Proves the `web.search` capability does REAL grounding (gemini-3.5-flash
# + the built-in GoogleSearch tool) and returns cited sources from grounding_metadata —
# NOT a chat completion.
#
# Requires (operator sets; never read from .env):
#   gcloud auth application-default login
#   GOOGLE_CLOUD_PROJECT=ss-v2-prod  GOOGLE_CLOUD_LOCATION=global  (Gemini 3.x = global)
#
# Usage:
#   GOOGLE_CLOUD_PROJECT=ss-v2-prod GOOGLE_CLOUD_LOCATION=global \
#     bash scripts/smoke-test/run-web-search-grounding.sh "Korean vegan skincare TikTok creators 2026"
#
# Exit 0 = grounded sources returned; 3 = no sources; 4 = env/import error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AGENTS_PKG="${REPO_ROOT}/packages/agents-adk"

QUERY="${1:-Korean vegan skincare TikTok creators 2026 trends}"

export CAPABILITY_LAYER_MODE="live"
export GOOGLE_GENAI_USE_VERTEXAI="TRUE"
export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-ss-v2-prod}"
export GOOGLE_CLOUD_LOCATION="${GOOGLE_CLOUD_LOCATION:-global}"

echo "[web-grounding] query=${QUERY}"
echo "[web-grounding] project=${GOOGLE_CLOUD_PROJECT} location=${GOOGLE_CLOUD_LOCATION} (Gemini 3.x = global)"

cd "${AGENTS_PKG}"
exec uv run python "${SCRIPT_DIR}/web_search_grounding_smoke.py" "${QUERY}"
