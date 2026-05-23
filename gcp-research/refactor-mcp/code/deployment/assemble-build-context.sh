#!/usr/bin/env bash
###############################################################################
# Assemble a REPRODUCIBLE build context for the multi-container ss-mcp-server
# image (deployment/Dockerfile.multi-container).
#
# Why: the Node MCP source lives in a sibling repo
# (social-seeding-platform/microservices/tiktok-mcp-server) and one patch must
# be applied on top. Earlier this was done ad-hoc in /tmp, which made the
# Cloud Build non-reproducible. This script makes it a single deterministic
# step so `gcloud builds submit <out>` (or a local docker build) is repeatable.
#
# Contents of the assembled context:
#   - Node MCP source at the root (package*.json, tsconfig.json, src/) — what
#     Dockerfile stages 1-2 (runtime-node) expect.
#   - mcp-structured-output.patch applied to src/ (the 4 tools + withLimit emit
#     structuredContent.data so the ADK ranker can read them). This is the only
#     patch still required: transport-streamable is upstream-merged and
#     identity-platform is unneeded for the loopback sidecar.
#   - agent/ + deployment/ from this repo — what stages 3-4 (runtime-adk) expect.
#
# Usage:
#   deployment/assemble-build-context.sh [OUT_DIR]
#   MCP_NODE_SRC=/path/to/tiktok-mcp-server deployment/assemble-build-context.sh
#
#   # then build (build-only, no deploy):
#   gcloud builds submit "$OUT" --config deployment/cloudbuild.build-only.yaml \
#     --project ss-mcp-prod --substitutions=_LOCATION=us-central1,_REPO=socialseed-mcp
###############################################################################
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # refactor-mcp/code
NODE_SRC="${MCP_NODE_SRC:-$HOME/Documents/GitHub/social-seeding-platform/microservices/tiktok-mcp-server}"
OUT="${1:-$HERE/.build-context}"
PATCH="$HERE/ts-patches/mcp-structured-output.patch"

if [ ! -f "$NODE_SRC/package.json" ]; then
  echo "ERROR: Node MCP source not found at: $NODE_SRC" >&2
  echo "       Set MCP_NODE_SRC to the tiktok-mcp-server checkout." >&2
  exit 1
fi
if [ ! -f "$PATCH" ]; then
  echo "ERROR: patch not found: $PATCH" >&2
  exit 1
fi

echo "Node source : $NODE_SRC"
echo "Output ctx  : $OUT"

rm -rf "$OUT"
mkdir -p "$OUT"

# 1. Node MCP source at the context root.
cp "$NODE_SRC/package.json" "$OUT/"
cp "$NODE_SRC/package-lock.json" "$OUT/"
cp "$NODE_SRC/tsconfig.json" "$OUT/"
cp -R "$NODE_SRC/src" "$OUT/src"

# 2. Apply the structured-output patch to the vendored src/.
( cd "$OUT" && git apply -p1 "$PATCH" )
echo "Applied: $(basename "$PATCH")"

# 3. Python ADK agent + deployment dir from this repo.
cp -R "$HERE/agent" "$OUT/agent"
cp -R "$HERE/deployment" "$OUT/deployment"

# 4. Prune machine-specific / build-irrelevant artifacts so the Cloud Build
#    upload stays small and the context is deterministic (the Dockerfile builds
#    the venv + node_modules fresh; it never copies these in).
find "$OUT" -type d \( \
  -name .venv -o -name node_modules -o -name __pycache__ -o \
  -name .pytest_cache -o -name .mypy_cache -o -name .ruff_cache -o \
  -name dist -o -name .git -o -name .build-context \
  \) -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT" -name "*.pyc" -delete 2>/dev/null || true

echo "OK — assembled reproducible build context at: $OUT"
echo "Context size: $(du -sh "$OUT" 2>/dev/null | cut -f1)"
