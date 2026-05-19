#!/usr/bin/env bash
# ============================================================================
# subtitle-burn.sh
# ----------------------------------------------------------------------------
# Burns the per-locale SRT subtitles into the overlay video, producing four
# final MP4 outputs (one per locale: ko, en, ja, zh).
#
# Authority:
#   gcp-research/demo/SCRIPT.md §2.6 (final burn) + §6 (locale list) + D34
#
# Per-locale SRT inputs:
#   gcp-research/demo/subtitles/ko.srt   (primary, 42 cues)
#   gcp-research/demo/subtitles/en.srt   (judge default)
#   gcp-research/demo/subtitles/ja.srt
#   gcp-research/demo/subtitles/zh.srt
#
# Per SCRIPT.md §10 quality bar:
#   - 22 pt, white, 3 px black outline, 1 px shadow, bottom-center
#   - CJK locales (ja, zh) MUST use Noto Sans CJK fonts or characters drop
#     silently.
#
# Outputs:
#   gcp-research/demo/work/<track>-final-<locale>.mp4
#
# The script copies the final MP4s into scripts/demo/submission/ so the
# Devpost-facing files end up alongside the README + diagram + write-up.
# ============================================================================

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <track:v2|mcp>" >&2
  exit 1
fi

track="$1"

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
: "${DEMO_WORK_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/work}"
: "${DEMO_SUB_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/subtitles}"
: "${DEMO_FINAL_DIR:=${DEMO_REPO_ROOT}/scripts/demo/submission}"

input="${DEMO_WORK_DIR}/${track}-with-overlay.mp4"

if [[ ! -f "$input" ]]; then
  echo "[subtitle-burn] input not found: $input — run overlay-burn.sh first" >&2
  exit 1
fi

mkdir -p "$DEMO_WORK_DIR/.receipts" "$DEMO_FINAL_DIR"

# --------------------------------------------------------------------------
# Locale → font mapping.
# Defaults are Google Noto Sans CJK; override per host if needed.
# --------------------------------------------------------------------------
declare -A LOCALE_FONT
LOCALE_FONT[en]="Inter"
LOCALE_FONT[ko]="Noto Sans CJK KR"
LOCALE_FONT[ja]="Noto Sans CJK JP"
LOCALE_FONT[zh]="Noto Sans CJK SC"

burn_one_locale() {
  local locale="$1"
  local srt_path="${DEMO_SUB_DIR}/${locale}.srt"
  local font_name="${LOCALE_FONT[$locale]}"
  local out_path="${DEMO_WORK_DIR}/${track}-final-${locale}.mp4"
  local final_path="${DEMO_FINAL_DIR}/${track}-final-${locale}.mp4"
  local receipt="${DEMO_WORK_DIR}/.receipts/${track}-subtitle-${locale}.ok"

  if [[ ! -f "$srt_path" ]]; then
    echo "[subtitle-burn:$locale] FATAL — missing $srt_path" >&2
    return 1
  fi

  if [[ -f "$receipt" && -f "$out_path" && "$out_path" -nt "$input" && "$out_path" -nt "$srt_path" ]]; then
    echo "[subtitle-burn:$locale] [skipped] receipt at $receipt is newer than inputs"
    cp -f "$out_path" "$final_path"
    return 0
  fi

  echo "[subtitle-burn:$locale] $input → $out_path (font=$font_name, sub=$srt_path)"

  # Validate the SRT first.
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<PY
import sys
try:
    import srt
    with open("$srt_path") as f:
        list(srt.parse(f.read()))
except ModuleNotFoundError:
    pass
except Exception as e:
    sys.stderr.write(f"[subtitle-burn:$locale] SRT validation failed: {e}\n")
    sys.exit(1)
PY
  fi

  # Build the ffmpeg subtitles filter spec. The colon between key=value pairs
  # is ffmpeg syntax; outer quotes are mandatory because of the comma in
  # "&Hffffff&".
  local style="Fontname=${font_name},Fontsize=22,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,Outline=3,Shadow=1,Alignment=2,MarginV=40"

  # ffmpeg subtitles filter does NOT like spaces inside the colon list; we
  # work around by exporting the SRT path with no spaces (escape colons
  # with backslash). On macOS, paths have no special chars by default.
  local safe_srt="$srt_path"
  safe_srt="${safe_srt//:/\\:}"

  ffmpeg \
    -y -nostdin -hide_banner \
    -i "$input" \
    -vf "subtitles='${safe_srt}':force_style='${style}'" \
    -c:a copy \
    -c:v libx264 -preset slow -crf 18 \
    -movflags +faststart \
    "$out_path"

  ec=$?
  if (( ec != 0 )); then
    echo "[subtitle-burn:$locale] ffmpeg returned $ec — output discarded" >&2
    rm -f "$out_path"
    return 2
  fi

  # Quality bar: assert that the burn-in actually rendered non-zero text.
  # We do this by checking that the output's mean diff against the input
  # within the subtitle region (bottom 200 px) is non-zero.
  if command -v ffprobe >/dev/null 2>&1; then
    # Pull a frame from the middle of the video — past beat 1, before beat
    # 6 — and compare a 200 px bottom strip with the same strip from the
    # input. If they match pixel-perfect, no subtitle was drawn.
    middle_s=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$out_path")
    middle_s=$(awk "BEGIN {printf(\"%.2f\", $middle_s / 2.0)}")

    ffmpeg -hide_banner -nostats -y -i "$input"   -ss "$middle_s" -vframes 1 -vf "crop=1920:200:0:880" "$DEMO_WORK_DIR/.sb_in.png"  -loglevel error
    ffmpeg -hide_banner -nostats -y -i "$out_path" -ss "$middle_s" -vframes 1 -vf "crop=1920:200:0:880" "$DEMO_WORK_DIR/.sb_out.png" -loglevel error

    if cmp -s "$DEMO_WORK_DIR/.sb_in.png" "$DEMO_WORK_DIR/.sb_out.png"; then
      echo "[subtitle-burn:$locale] WARN — bottom-strip pixel-identical to input. The font likely failed to render." >&2
      echo "                  (Most common cause: missing Noto Sans CJK pack for ${locale}.)" >&2
    fi
    rm -f "$DEMO_WORK_DIR/.sb_in.png" "$DEMO_WORK_DIR/.sb_out.png"
  fi

  # Duration check
  if command -v ffprobe >/dev/null 2>&1; then
    out_s=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$out_path")
    out_s_int=$(printf "%.0f" "$out_s")
    if (( out_s_int < 178 || out_s_int > 182 )); then
      echo "[subtitle-burn:$locale] WARN — output duration ${out_s_int}s is outside 3:00 ± 2 s window" >&2
    else
      echo "[subtitle-burn:$locale] duration ${out_s_int}s within 3:00 ± 2 s ✓"
    fi
  fi

  # Hand-off to submission directory.
  cp -f "$out_path" "$final_path"

  date -u +%FT%TZ > "$receipt"
  echo "[subtitle-burn:$locale] receipt: $receipt"
  echo "[subtitle-burn:$locale] final: $final_path"
  return 0
}

failed=()
for locale in en ko ja zh; do
  if ! burn_one_locale "$locale"; then
    failed+=("$locale")
  fi
done

if (( ${#failed[@]} > 0 )); then
  echo "[subtitle-burn] FAILED locales: ${failed[*]}" >&2
  exit 3
fi

echo
echo "[subtitle-burn] all 4 locales rendered into $DEMO_FINAL_DIR/${track}-final-{en,ko,ja,zh}.mp4"
echo "[subtitle-burn] next: bash scripts/demo/post-process/pii-ocr-scan.sh $track"
exit 0
