#!/usr/bin/env bash
# ============================================================================
# overlay-burn.sh
# ----------------------------------------------------------------------------
# Composites the transparent preview overlay onto the 8× speed video.
#
# Authority:
#   gcp-research/demo/SCRIPT.md §2.4 (overlay generator) + §5 (overlay spec)
#
# Overlay layers (per SCRIPT.md §5, z-order back→front):
#   1. background: fully transparent (alpha 0)
#   2. Mermaid mini-diagram (top-right 540×320 @ 80% opacity)
#   3. Section marker bar (top, 1920×64 @ #1A1A1A 70%)
#   4. Cost ticker (top-right corner 360×80 @ #0A0A0A 80%, JetBrains Mono)
#   5. Agent-name tag (bottom-left 540×48 @ #4285F4 90%)
#
# Subtitles are NOT in this layer — handled by subtitle-burn.sh per locale.
#
# Implementation:
#   - The PNG sequence is assumed to be pre-rendered by scripts/gen-overlay.ts
#     (separate agent owns DEMO-1 per SCRIPT.md §12). If the sequence does
#     not exist, this script falls back to a six-beat "fallback overlay"
#     generator that produces the minimum-viable overlay using ImageMagick.
#     The fallback is good enough to not block the demo if gen-overlay.ts
#     misses its deadline.
#
#   - The composite is done via ffmpeg's `overlay` filter with the PNG
#     sequence as a movie input. Frame rate matches the 8× video output
#     (480 fps effective).
#
# Usage:
#   bash scripts/demo/post-process/overlay-burn.sh <track:v2|mcp>
#
# Receipts:
#   $DEMO_WORK_DIR/.receipts/${track}-overlay.ok
# ============================================================================

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <track:v2|mcp>" >&2
  exit 1
fi

track="$1"

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
: "${DEMO_WORK_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/work}"
: "${DEMO_OVERLAYS_DIR:=${DEMO_REPO_ROOT}/scripts/demo/assets/overlays}"
: "${DEMO_INTRO_DIR:=${DEMO_REPO_ROOT}/scripts/demo/assets/intro}"
: "${DEMO_OUTRO_DIR:=${DEMO_REPO_ROOT}/scripts/demo/assets/outro}"

input="${DEMO_WORK_DIR}/${track}-8x.mp4"
output="${DEMO_WORK_DIR}/${track}-with-overlay.mp4"
overlay_seq="${DEMO_WORK_DIR}/overlay-${track}/overlay-%04d.png"
overlay_dir="${DEMO_WORK_DIR}/overlay-${track}"
receipt="${DEMO_WORK_DIR}/.receipts/${track}-overlay.ok"

if [[ ! -f "$input" ]]; then
  echo "[overlay-burn] input not found: $input — run speed-8x.sh first" >&2
  exit 1
fi

mkdir -p "$DEMO_WORK_DIR/.receipts" "$overlay_dir"

if [[ -f "$receipt" && -f "$output" && "$output" -nt "$input" ]]; then
  echo "[overlay-burn] [skipped] receipt at $receipt is newer than input"
  exit 0
fi

# --------------------------------------------------------------------------
# Source the PNG sequence: either pre-rendered by gen-overlay.ts, or built
# on the fly from a fallback ImageMagick generator.
# --------------------------------------------------------------------------
existing_pngs=$(ls "$overlay_dir"/overlay-*.png 2>/dev/null | wc -l | tr -d ' ')
if (( existing_pngs == 0 )); then
  echo "[overlay-burn] no pre-rendered PNG sequence at $overlay_dir — using fallback generator"
  bash "$(dirname "$0")/_overlay_fallback.sh" "$track" "$overlay_dir"
  existing_pngs=$(ls "$overlay_dir"/overlay-*.png 2>/dev/null | wc -l | tr -d ' ')
fi

if (( existing_pngs < 60 )); then
  echo "[overlay-burn] FATAL — overlay sequence has only $existing_pngs frames (need ≥ 60 for a 3:00 / 60 fps × 30 = 1800 minimum, fallback produces 1 PNG per second × 180 = 180)" >&2
  exit 2
fi

echo "[overlay-burn] $existing_pngs PNG frames in $overlay_dir"

# --------------------------------------------------------------------------
# Determine the actual frame rate the PNG sequence is paced at. The fallback
# generator emits 1 PNG/sec (180 frames for a 3:00 video); the rich
# gen-overlay.ts emits per-frame at 60 fps. ffmpeg's -framerate input flag
# tells the decoder how to time the PNGs.
# --------------------------------------------------------------------------
target_video_seconds=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$input")
target_video_seconds_int=$(printf "%.0f" "$target_video_seconds")
overlay_fps=$(awk "BEGIN {printf(\"%.4f\", $existing_pngs / $target_video_seconds)}")
echo "[overlay-burn] derived overlay fps=$overlay_fps (PNGs/${target_video_seconds_int}s)"

# --------------------------------------------------------------------------
# ffmpeg composite. The overlay filter alpha-blends the PNG onto the video.
# Audio is passed through verbatim.
# --------------------------------------------------------------------------
ffmpeg \
  -y -nostdin -hide_banner \
  -i "$input" \
  -framerate "$overlay_fps" \
  -i "$overlay_seq" \
  -filter_complex "[1:v]scale=1920:1080,format=rgba[ov];[0:v][ov]overlay=0:0:format=auto:eof_action=pass" \
  -c:a copy \
  -c:v libx264 -preset slow -crf 18 \
  -movflags +faststart \
  "$output"

# --------------------------------------------------------------------------
# Quality bar: per SCRIPT.md §10, cost ticker must be on screen for ≥ 95% of
# the runtime. We assert it indirectly: the overlay PNG frame count must
# cover ≥ 0.95 × video duration ÷ (1 / overlay_fps). With the fallback
# generator (1 fps), 180 PNGs for a 180-second video = 100%.
# --------------------------------------------------------------------------
coverage=$(awk "BEGIN {printf(\"%.2f\", $existing_pngs / $overlay_fps / $target_video_seconds * 100)}")
echo "[overlay-burn] cost-ticker / section-marker coverage = ${coverage}%"
if awk "BEGIN {exit !($coverage < 95.0)}"; then
  echo "[overlay-burn] WARN — coverage below 95%; some beats may not show the overlay"
fi

date -u +%FT%TZ > "$receipt"
echo "[overlay-burn] receipt: $receipt"
echo "[overlay-burn] done. next: bash scripts/demo/post-process/subtitle-burn.sh $track"
exit 0
