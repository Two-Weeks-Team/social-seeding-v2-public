#!/usr/bin/env bash
# ============================================================================
# test_speed_filter.sh
# ----------------------------------------------------------------------------
# Validates that scripts/demo/post-process/speed-8x.sh reproduces the exact
# ffmpeg filter chain mandated by gcp-research/demo/SCRIPT.md §2.3:
#
#   [0:v]setpts=0.125*PTS[v];[0:a]atempo=2.0,atempo=2.0,atempo=2.0[a]
#
# This is a contract check, not a runtime check — it inspects the source of
# speed-8x.sh and (optionally) runs the filter against a 10-second synthetic
# input to confirm the output duration is 1.25 s ± 0.1 s.
#
# It also validates the 4× fallback chain:
#
#   [0:v]setpts=0.25*PTS[v];[0:a]atempo=2.0,atempo=2.0[a]
#
# Exit codes:
#   0  every contract passes
#   1  contract violation in script source
#   2  ffmpeg runtime validation failed
# ============================================================================

set -u
set -o pipefail

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"

SPEED_8X_SH="${DEMO_REPO_ROOT}/scripts/demo/post-process/speed-8x.sh"
SPEED_4X_SH="${DEMO_REPO_ROOT}/scripts/demo/post-process/speed-4x.sh"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
FAILS=0

check_chain_in_file() {
  local file="$1"; local needle="$2"; local label="$3"
  # `--` ends grep option parsing so needles starting with `-` (e.g.
  # `-c:v libx264`) are treated as the search expression.
  if grep -F -q -- "$needle" "$file"; then
    printf '%sok%s   %s — chain present\n' "$GREEN" "$RESET" "$label"
  else
    printf '%sFAIL%s %s — chain NOT in %s\n' "$RED" "$RESET" "$label" "$file"
    FAILS=$((FAILS + 1))
  fi
}

# --------------------------------------------------------------------------
# Static contract: source must contain the exact filter chain.
# --------------------------------------------------------------------------
echo "==> static checks"

check_chain_in_file "$SPEED_8X_SH" \
  '[0:v]setpts=0.125*PTS[v];[0:a]atempo=2.0,atempo=2.0,atempo=2.0[a]' \
  "8× setpts + atempo×3"

check_chain_in_file "$SPEED_8X_SH" \
  '-c:v libx264 -preset slow -crf 18' \
  "8× libx264 preset slow crf 18"

check_chain_in_file "$SPEED_8X_SH" \
  '-c:a aac -b:a 192k' \
  "8× AAC 192k"

check_chain_in_file "$SPEED_4X_SH" \
  '[0:v]setpts=0.25*PTS[v];[0:a]atempo=2.0,atempo=2.0[a]' \
  "4× setpts + atempo×2"

check_chain_in_file "$SPEED_4X_SH" \
  '-c:v libx264 -preset slow -crf 18' \
  "4× libx264 preset slow crf 18"

# --------------------------------------------------------------------------
# Runtime contract: run the 8× chain against a 10-second synthetic input
# and assert the output is 1.25 s ± 0.1 s.
# --------------------------------------------------------------------------
if ! command -v ffmpeg >/dev/null 2>&1; then
  printf '%swarn%s ffmpeg not installed — skipping runtime test\n' "$YELLOW" "$RESET"
else
  echo
  echo "==> runtime check (8× chain on a 10-second synthetic input)"

  workdir=$(mktemp -d)
  trap "rm -rf '$workdir'" EXIT

  # Synthesize a 10-second 1920×1080@60fps test pattern + 1 kHz sine tone.
  ffmpeg -hide_banner -nostats -loglevel error -y \
    -f lavfi -i "testsrc=duration=10:size=1920x1080:rate=60" \
    -f lavfi -i "sine=frequency=1000:duration=10:sample_rate=48000" \
    -c:v libx264 -preset ultrafast -crf 30 \
    -c:a aac -b:a 128k -shortest \
    "$workdir/in.mkv"

  # Apply the 8× filter chain.
  ffmpeg -hide_banner -nostats -loglevel error -y \
    -i "$workdir/in.mkv" \
    -filter_complex "[0:v]setpts=0.125*PTS[v];[0:a]atempo=2.0,atempo=2.0,atempo=2.0[a]" \
    -map "[v]" -map "[a]" \
    -c:v libx264 -preset ultrafast -crf 30 \
    -c:a aac -b:a 128k \
    "$workdir/out-8x.mp4"

  out_s=$(ffprobe -v error -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 "$workdir/out-8x.mp4")

  if awk "BEGIN {exit !($out_s > 1.15 && $out_s < 1.35)}"; then
    printf '%sok%s   8× output is %.3fs (target 1.25s ± 0.10)\n' \
      "$GREEN" "$RESET" "$out_s"
  else
    printf '%sFAIL%s 8× output is %.3fs (target 1.25s ± 0.10)\n' \
      "$RED" "$RESET" "$out_s"
    FAILS=$((FAILS + 1))
  fi

  # Apply the 4× filter chain.
  ffmpeg -hide_banner -nostats -loglevel error -y \
    -i "$workdir/in.mkv" \
    -filter_complex "[0:v]setpts=0.25*PTS[v];[0:a]atempo=2.0,atempo=2.0[a]" \
    -map "[v]" -map "[a]" \
    -c:v libx264 -preset ultrafast -crf 30 \
    -c:a aac -b:a 128k \
    "$workdir/out-4x.mp4"

  out_s=$(ffprobe -v error -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 "$workdir/out-4x.mp4")

  if awk "BEGIN {exit !($out_s > 2.40 && $out_s < 2.60)}"; then
    printf '%sok%s   4× output is %.3fs (target 2.50s ± 0.10)\n' \
      "$GREEN" "$RESET" "$out_s"
  else
    printf '%sFAIL%s 4× output is %.3fs (target 2.50s ± 0.10)\n' \
      "$RED" "$RESET" "$out_s"
    FAILS=$((FAILS + 1))
  fi

  # NOTE — ffmpeg 7.x widened atempo's accepted range from 0.5–2.0 to
  # 0.5–100.0, so a single-stage atempo=8.0 no longer errors out. The
  # canonical chain (2.0 × 3) is still preferred per SCRIPT.md §2.3 because
  # chaining produces higher audio quality at extreme tempo factors:
  # each stage uses smaller WSOLA window shifts, reducing phasing
  # artefacts on speech. We verify quality indirectly: the chained output
  # must retain a non-zero peak in the speech band (1 kHz test tone in
  # this synthetic case).
  # volumedetect emits its measurements at `info` level — we must NOT pass
  # `-loglevel error` here or the output is suppressed. Example line:
  #   [Parsed_volumedetect_0 @ 0x…] max_volume: -17.0 dB
  peak=$(ffmpeg -hide_banner -nostats -i "$workdir/out-8x.mp4" \
    -af volumedetect -f null /dev/null 2>&1 \
    | grep -F 'max_volume:' | grep -F ' dB' | awk -F': ' '{print $2}' | awk '{print $1}' | head -n 1)
  if [[ -n "$peak" ]] && awk "BEGIN {exit !($peak > -45)}"; then
    printf '%sok%s   chained 8× audio retains signal (peak %s dBFS)\n' "$GREEN" "$RESET" "$peak"
  else
    printf '%sFAIL%s chained 8× audio is below -45 dBFS — atempo chain broken\n' "$RED" "$RESET"
    FAILS=$((FAILS + 1))
  fi
fi

echo
if (( FAILS == 0 )); then
  printf '%sPASS%s — all speed-filter contract checks succeeded\n' "$GREEN" "$RESET"
  exit 0
fi

printf '%sFAIL%s — %d contract check(s) failed\n' "$RED" "$RESET" "$FAILS"
exit 1
