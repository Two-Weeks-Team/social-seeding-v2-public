#!/usr/bin/env bash
# ============================================================================
# _overlay_fallback.sh
# ----------------------------------------------------------------------------
# Helper used by overlay-burn.sh when scripts/gen-overlay.ts has not yet
# produced the rich PNG sequence (per SCRIPT.md §12 — agent #11 owns DEMO-1).
#
# The fallback writes one 1920×1080 RGBA PNG per second of the final video
# (180 PNGs for a 3:00 cut). Each PNG contains:
#
#   - top bar:    "Beat N / 6 — <label>"               (1920×64 @ #1A1A1A 70%)
#   - cost ticker:"$0.18 / $1.50 budget"                (top-right 360×80)
#   - agent tag:  "vetting × 12 · Gemini 2.5 Pro"       (bottom-left 540×48)
#
# It does NOT render the Mermaid mini-diagram — that requires per-beat .mmd
# files plus a renderer chain. The fallback simply leaves the diagram region
# (top-right 540×320) transparent.
#
# The mapping from second-of-video → beat/section/cost/agent comes from
# scripts/demo/assets/overlays/<track>-beats.tsv (data file authored
# separately so designers can edit copy without touching this script). If
# the TSV is missing, this helper falls back to a generic 6×30s split.
#
# Tooling: ImageMagick 7.x (magick).
# ============================================================================

set -euo pipefail

track="$1"
out_dir="$2"

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"

mkdir -p "$out_dir"

beats_tsv="${DEMO_REPO_ROOT}/scripts/demo/assets/overlays/${track}-beats.tsv"

# Default 6×30s split with copy from SCRIPT.md §3 and §4.
if [[ ! -f "$beats_tsv" ]]; then
  cat > "$beats_tsv" <<'TSV'
# Generated default for fallback overlay. Edit copy here; do NOT delete columns.
# tsv format: beat_index<TAB>start_s<TAB>end_s<TAB>section_label<TAB>cost_ticker<TAB>agent_tag
#
# v2 track defaults (SCRIPT.md §3):
1	0	30	Beat 1 / 6 — Brief intake + sourcing	$0.00 → $0.04	Gemini 2.5 Pro · Agent Runtime · Vector Search
2	30	60	Beat 2 / 6 — Vetting fan-out	$0.04 → $0.18	parallel × 12 · Gemini 2.5 Pro · critic M2
3	60	90	Beat 3 / 6 — Outreach tournament + approval	$0.18 → $0.31	5 × 4 tournament · AP2 Intent Mandate · human gate
4	90	120	Beat 4 / 6 — Real send + reply	$0.31 → $0.39	Gmail API · real timestamp · classify + respond
5	120	150	Beat 5 / 6 — Logistics + verify	$0.39 → $0.52	+5d durable timer · Vision AI · brand logo detect
6	150	180	Beat 6 / 6 — Report + cost ledger	$0.62 TOTAL	Agent Runtime · Workflows · Model Armor · Spanner
TSV

  # Track 3 needs different copy — overwrite if mcp.
  if [[ "$track" == "mcp" ]]; then
    cat > "$beats_tsv" <<'TSV'
1	0	30	Beat 1 / 6 — Public MCP endpoint	Cloud Run · MCP spec · 4 tools live	mcp.socialseed.ing · /tools/*
2	30	60	Beat 2 / 6 — ADK orchestration	ADK · Agent Engine · Gemini 2.5 Flash	tiktok-mcp-orchestrator
3	60	90	Beat 3 / 6 — A2A registration	A2A v0.3 · agent.json · cross-agent invoke	verified · public · agent.json
4	90	120	Beat 4 / 6 — Model Armor block	Model Armor max · PI block · audit log	403 policy_violation · prompt_injection
5	120	150	Beat 5 / 6 — KR-gap reframing	D2 · D3 · A2A-only distribution	Marketplace PENDING · A2A live
6	150	180	Beat 6 / 6 — Multi-region failover	Global LB · 3 regions · 8 s failover	D31 SLO · 99.99% / yr · RTO 1 min
TSV
  fi
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "[overlay-fallback] FATAL — ImageMagick (magick) not installed. Install via:" >&2
  echo "                  brew install imagemagick   # macOS" >&2
  echo "                  apt install imagemagick   # Linux" >&2
  exit 1
fi

# Read the TSV.
echo "[overlay-fallback] reading $beats_tsv"

frames_total=180
existing=$(ls "$out_dir"/overlay-*.png 2>/dev/null | wc -l | tr -d ' ')
if (( existing >= frames_total )); then
  echo "[overlay-fallback] $existing frames already present in $out_dir; skipping regenerate"
  exit 0
fi

generate_frame() {
  local idx="$1"   # 0..179
  local section="$2"
  local cost="$3"
  local agent="$4"
  local out_png="$5"

  # Use ImageMagick draw primitives. The order matters: later draws sit on
  # top of earlier ones.
  magick -size 1920x1080 xc:none \
    \
    -fill "#1A1A1A" -draw "rectangle 0,0 1920,64" \
    -fill "#FFFFFF" -font "Inter-Bold" -pointsize 28 -gravity NorthWest -annotate +24+20 "${section}" \
    \
    -fill "#0A0A0A" -draw "rectangle 1540,16 1900,80" \
    -fill "#FFD400" -font "JetBrains-Mono-Bold" -pointsize 22 -gravity NorthEast -annotate +30+30 "${cost}" \
    \
    -fill "#4285F4" -draw "rectangle 24,1010 564,1062" \
    -fill "#FFFFFF" -font "Inter-Bold" -pointsize 20 -gravity SouthWest -annotate +36+24 "${agent}" \
    \
    PNG32:"$out_png"
}

frame_idx=0
while IFS=$'\t' read -r beat start end section cost agent; do
  case "$beat" in ""|"#"*) continue ;; esac
  for sec in $(seq "$start" $((end - 1))); do
    out_png=$(printf "%s/overlay-%04d.png" "$out_dir" "$sec")
    generate_frame "$sec" "$section" "$cost" "$agent" "$out_png"
    frame_idx=$((frame_idx + 1))
    if (( frame_idx % 30 == 0 )); then
      echo "[overlay-fallback] generated $frame_idx / $frames_total frames"
    fi
  done
done < "$beats_tsv"

echo "[overlay-fallback] generated $frame_idx PNGs in $out_dir"
exit 0
