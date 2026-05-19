#!/usr/bin/env bash
# ============================================================================
# render-outro-cards.sh
# ----------------------------------------------------------------------------
# Generates the two 5-second outro CTA cards. They overlay onto the last 5
# seconds of each demo video — the spec from SUBMISSION-PACKAGE.md §1.
# ============================================================================

set -euo pipefail

if ! command -v magick >/dev/null 2>&1; then
  echo "FATAL — ImageMagick (magick) not installed." >&2
  exit 1
fi

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
: "${GITHUB_OWNER:=social-seeding}"

OUT="${DEMO_REPO_ROOT}/scripts/demo/assets/outro"
mkdir -p "$OUT"

render_card() {
  local track="$1"
  local repo="$2"
  local domain="$3"
  local license="$4"
  local outfile="${OUT}/${track}-outro-cta.png"

  magick \
    -size 1920x1080 \
    canvas:'#0A0A0A' \
    \
    -fill '#FFFFFF' -font 'JetBrains-Mono-Bold' -pointsize 56 \
    -gravity Center -annotate +0-180 "github.com/${GITHUB_OWNER}/${repo}" \
    \
    -fill '#4285F4' -font 'JetBrains-Mono-Bold' -pointsize 48 \
    -gravity Center -annotate +0-40  "${domain}" \
    \
    -fill '#FFD400' -font 'Inter-Bold'           -pointsize 36 \
    -gravity Center -annotate +0+100 "${license}" \
    \
    -fill '#7A7A7A' -font 'Inter'                -pointsize 22 \
    -gravity Center -annotate +0+220 "Google for Startups · AI Agents Challenge 2026" \
    \
    PNG24:"${outfile}"

  echo "[outro] wrote ${outfile}"
}

render_card "track2" "social-seeding-v2"  "v2.socialseed.ing"  "Apache 2.0 + BUSL-1.1 (D9)"
render_card "track3" "tiktok-mcp-server"  "mcp.socialseed.ing" "BUSL-1.1 (D9)"

echo "Done. Operator may regenerate with a different GITHUB_OWNER env var."
exit 0
