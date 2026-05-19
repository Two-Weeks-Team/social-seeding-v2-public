#!/usr/bin/env bash
# ============================================================================
# speed-4x.sh
# ----------------------------------------------------------------------------
# Fallback path per gcp-research/demo/SCRIPT.md §11. The human operator
# decides to switch to 4× after watching the first 8× pre-record and judging
# that "the cursor halo cannot keep up" or "the cost ticker is unreadable".
#
# Canonical filter chain (SCRIPT.md §11):
#
#   ffmpeg -i v2-source.mkv \
#     -filter_complex "[0:v]setpts=0.25*PTS[v];[0:a]atempo=2.0,atempo=2.0[a]" \
#     -map "[v]" -map "[a]" \
#     -c:v libx264 -preset slow -crf 18 \
#     -c:a aac -b:a 192k -movflags +faststart \
#     v2-4x.mp4
#
# Two chained atempo=2.0 because 2.0 × 2.0 = 4.0; setpts=0.25*PTS = 1/4.
#
# The source recording length differs in the 4× path — SCRIPT.md §11 calls
# for 12 minutes of source instead of 24 (so 12 × 4 = 48 s of audio
# narration → 3:00 of final video). The operator is responsible for that
# difference at recording time; this script trusts the source.
#
# Usage:
#   DEMO_SPEED=4 bash scripts/demo/post-process/speed-8x.sh <src> <track>
#   (the 8x script dispatches to this one when DEMO_SPEED=4)
#
# Direct invocation:
#   bash scripts/demo/post-process/speed-4x.sh <src> <track>
# ============================================================================

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <source.mkv> <track:v2|mcp>" >&2
  exit 1
fi

source_path="$1"
track="$2"

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
: "${DEMO_WORK_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/work}"

if [[ ! -f "$source_path" ]]; then
  echo "[speed-4x] source not found: $source_path" >&2
  exit 1
fi

mkdir -p "$DEMO_WORK_DIR/.receipts"

# Note the 4x suffix is preserved in the output filename so downstream steps
# (overlay-burn.sh, subtitle-burn.sh) can detect the variant without an env
# look-up. We DO NOT name the output file differently per speed — the rest of
# the pipeline expects ${track}-8x.mp4 — so we write to ${track}-8x.mp4 and
# log the actual ratio in the receipt.
output_path="${DEMO_WORK_DIR}/${track}-8x.mp4"
receipt="${DEMO_WORK_DIR}/.receipts/${track}-speed.ok"

if [[ -f "$receipt" && -f "$output_path" && "$output_path" -nt "$source_path" ]]; then
  echo "[speed-4x] [skipped] receipt at $receipt is newer than source"
  exit 0
fi

echo "[speed-4x] $source_path → $output_path"
echo "[speed-4x] filter chain: setpts=0.25*PTS + atempo=2.0 (× 2)"

ffmpeg \
  -y -nostdin -hide_banner \
  -i "$source_path" \
  -filter_complex "[0:v]setpts=0.25*PTS[v];[0:a]atempo=2.0,atempo=2.0[a]" \
  -map "[v]" -map "[a]" \
  -c:v libx264 -preset slow -crf 18 \
  -c:a aac -b:a 192k \
  -movflags +faststart \
  "$output_path"

ec=$?
if (( ec != 0 )); then
  echo "[speed-4x] ffmpeg returned $ec" >&2
  rm -f "$output_path"
  exit 2
fi

if command -v ffprobe >/dev/null 2>&1; then
  out_s=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$output_path")
  src_s=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$source_path")
  expected=$(awk "BEGIN {printf(\"%.0f\", $src_s / 4.0)}")
  echo "[speed-4x] source=$(printf %.0f $src_s)s → output=$(printf %.0f $out_s)s (expected≈${expected}s)"
fi

printf '%s\nspeed=4\n' "$(date -u +%FT%TZ)" > "$receipt"
echo "[speed-4x] receipt: $receipt"
echo "[speed-4x] done. next: bash scripts/demo/post-process/overlay-burn.sh $track"
exit 0
