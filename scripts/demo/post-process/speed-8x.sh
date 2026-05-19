#!/usr/bin/env bash
# ============================================================================
# speed-8x.sh
# ----------------------------------------------------------------------------
# Time-warps a 24-minute 1× source MKV down to a 3:00 8× MP4 using the
# canonical ffmpeg filter chain from gcp-research/demo/SCRIPT.md §2.3:
#
#   ffmpeg -i input.mkv \
#     -filter_complex "[0:v]setpts=0.125*PTS[v];[0:a]atempo=2.0,atempo=2.0,atempo=2.0[a]" \
#     -map "[v]" -map "[a]" \
#     -c:v libx264 -preset slow -crf 18 \
#     -c:a aac -b:a 192k \
#     output-8x.mp4
#
# Three chained atempo=2.0 are needed because each atempo accepts 0.5–2.0
# only; 2.0 × 2.0 × 2.0 = 8.0.
#
# If DEMO_SPEED=4 is set, this script routes to speed-4x.sh and uses the
# two-stage chain (setpts=0.25 + atempo=2.0,atempo=2.0). The fallback policy
# is documented in SCRIPT.md §11.
#
# Usage:
#   bash scripts/demo/post-process/speed-8x.sh <source.mkv> <track>
#   track ∈ {v2, mcp}
#
# Receipts:
#   $DEMO_WORK_DIR/.receipts/${track}-speed.ok
#
# Exit codes:
#   0  success
#   1  invalid arguments / missing input
#   2  ffmpeg failed
#   3  output verification failed
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
: "${DEMO_SPEED:=8}"

# Dispatch to 4× path if requested.
if [[ "$DEMO_SPEED" == "4" ]]; then
  echo "[speed-8x] DEMO_SPEED=4 → dispatching to speed-4x.sh (per SCRIPT.md §11 fallback)"
  exec bash "$(dirname "$0")/speed-4x.sh" "$source_path" "$track"
fi

if [[ "$DEMO_SPEED" != "8" ]]; then
  echo "[speed-8x] FATAL — DEMO_SPEED='$DEMO_SPEED' is unrecognized (allowed: 4, 8)" >&2
  exit 1
fi

if [[ ! -f "$source_path" ]]; then
  echo "[speed-8x] source not found: $source_path" >&2
  exit 1
fi

mkdir -p "$DEMO_WORK_DIR/.receipts"

output_path="${DEMO_WORK_DIR}/${track}-8x.mp4"
receipt="${DEMO_WORK_DIR}/.receipts/${track}-speed.ok"

# Idempotent skip per §6 of the top-level README.
if [[ -f "$receipt" && -f "$output_path" ]]; then
  if [[ "$output_path" -nt "$source_path" ]]; then
    echo "[speed-8x] [skipped] receipt at $receipt is newer than source — re-use $output_path"
    echo "                     (rm $receipt to force rebuild)"
    exit 0
  fi
fi

echo "[speed-8x] $source_path → $output_path"
echo "[speed-8x] filter chain: setpts=0.125*PTS + atempo=2.0 (× 3)"

# Run ffmpeg. -y overwrites the work file; -nostdin prevents the long encode
# from hanging on a stray keypress on the controlling terminal. The exact
# filter expression below MUST match SCRIPT.md §2.3 character-for-character —
# the test in tests/test_speed_filter.sh asserts this.
ffmpeg \
  -y -nostdin -hide_banner \
  -i "$source_path" \
  -filter_complex "[0:v]setpts=0.125*PTS[v];[0:a]atempo=2.0,atempo=2.0,atempo=2.0[a]" \
  -map "[v]" -map "[a]" \
  -c:v libx264 -preset slow -crf 18 \
  -c:a aac -b:a 192k \
  -movflags +faststart \
  "$output_path"

ec=$?
if (( ec != 0 )); then
  echo "[speed-8x] ffmpeg returned $ec — output discarded" >&2
  rm -f "$output_path"
  exit 2
fi

# Verify the duration is 3:00 ± 4 s. The source-to-final ratio is exactly
# 0.125, so 24-min source → 3:00 final; 23:30 source → 2:56 final; etc.
if command -v ffprobe >/dev/null 2>&1; then
  out_s=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$output_path")
  out_s_int=$(printf "%.0f" "$out_s")
  src_s=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$source_path")
  src_s_int=$(printf "%.0f" "$src_s")
  expected=$(awk "BEGIN {printf(\"%.0f\", $src_s / 8.0)}")
  diff=$(( out_s_int - expected ))
  abs_diff=${diff#-}
  echo "[speed-8x] source=${src_s_int}s → output=${out_s_int}s (expected≈${expected}s, drift ${diff}s)"
  if (( abs_diff > 6 )); then
    echo "[speed-8x] ERROR — output duration drifted >6s from source/8. Re-render." >&2
    exit 3
  fi
fi

date -u +%FT%TZ > "$receipt"
echo "[speed-8x] receipt: $receipt"
echo "[speed-8x] done. next: bash scripts/demo/post-process/overlay-burn.sh $track"
exit 0
