#!/usr/bin/env bash
# ============================================================================
# render-architecture.sh
# ----------------------------------------------------------------------------
# Renders both ARCHITECTURE-track2.mmd and ARCHITECTURE-track3.mmd to PNGs
# via mmdc (mermaid-cli). Output: 1600×900, transparent background.
#
# This file is committed so the Devpost form can include the PNGs without
# requiring every reviewer to install mmdc.
# ============================================================================

set -euo pipefail

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
cd "${DEMO_REPO_ROOT}/scripts/demo/submission"

if ! command -v mmdc >/dev/null 2>&1; then
  echo "FATAL — mmdc (mermaid-cli) not installed. Install via:" >&2
  echo "  npm install -g @mermaid-js/mermaid-cli" >&2
  exit 1
fi

for track in track2 track3; do
  echo "[render] ARCHITECTURE-${track}.mmd → ARCHITECTURE-${track}.png"
  mmdc \
    -i "ARCHITECTURE-${track}.mmd" \
    -o "ARCHITECTURE-${track}.png" \
    -w 1600 -H 900 \
    -b transparent \
    --theme neutral
done

echo
echo "[render] done. PNGs committed alongside .mmd sources."
exit 0
