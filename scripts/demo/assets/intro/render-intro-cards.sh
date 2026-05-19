#!/usr/bin/env bash
# ============================================================================
# render-intro-cards.sh
# ----------------------------------------------------------------------------
# Generates the two 5-second intro cards for the demo videos via ImageMagick.
#
# Output:
#   scripts/demo/assets/intro/track2-intro-card.png  (1920×1080)
#   scripts/demo/assets/intro/track3-intro-card.png  (1920×1080)
#
# The overlay-burn.sh chain consumes these cards if they exist; if absent,
# the demo still ships without them.
# ============================================================================

set -euo pipefail

if ! command -v magick >/dev/null 2>&1; then
  echo "FATAL — ImageMagick (magick) not installed." >&2
  exit 1
fi

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
OUT="${DEMO_REPO_ROOT}/scripts/demo/assets/intro"
mkdir -p "$OUT"

render_card() {
  local track="$1"   # v2 | mcp
  local title="$2"
  local subtitle1="$3"
  local subtitle2="$4"
  local track_tag="$5"
  local outfile="${OUT}/${track}-intro-card.png"

  magick \
    -size 1920x1080 \
    canvas:'#0A0A0A' \
    \
    -fill '#FFFFFF' -font 'Inter-Bold'         -pointsize 96 \
    -gravity Center -annotate +0-160 "${title}" \
    \
    -fill '#FFD400' -font 'JetBrains-Mono-Bold' -pointsize 36 \
    -gravity Center -annotate +0+20  "${subtitle1}" \
    \
    -fill '#FFD400' -font 'JetBrains-Mono'      -pointsize 32 \
    -gravity Center -annotate +0+80  "${subtitle2}" \
    \
    -fill '#4285F4' -font 'Inter'               -pointsize 28 \
    -gravity Center -annotate +0+260 "${track_tag}" \
    \
    PNG24:"${outfile}"

  echo "[intro] wrote ${outfile}"
}

render_card "track2" \
  "social-seeding-v2" \
  "22-agent influencer campaign operator" \
  "Vertex AI Agent Runtime · Gemini 2.5 · ADK 2.0" \
  "Google for Startups · AI Agents Challenge · Track 2"

render_card "track3" \
  "tiktok-mcp-server" \
  "MCP + A2A v0.3 connector for Gemini Enterprise" \
  "Cloud Run · Vertex AI Agent Runtime · Apigee X" \
  "Google for Startups · AI Agents Challenge · Track 3"

echo
echo "Both cards rendered. They are referenced by overlay-burn.sh if present."
exit 0
