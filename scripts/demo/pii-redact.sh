#!/usr/bin/env bash
# ============================================================================
# pii-redact.sh
# ----------------------------------------------------------------------------
# Companion to scripts/demo/post-process/pii-ocr-scan.sh.
#
# The scanner detects PII and writes a report. THIS script is the only path
# from "report has matches" → "final MP4 is safe to upload" that does NOT
# require a re-record. It is the second-best option per EC-7.01 — prefer
# re-recording when possible (see PII-OCR-GATE.md §5).
#
# Authority:
#   - D10 (Gmail demo: test-account-only) per gcp-research/decisions/DECISIONS.md
#   - D20 (DLP / PII redaction) per the same
#   - EC-7.01 (8× recording captures PII) per gcp-research/edge-cases/CATALOG.md
#
# What this script does:
#   - Reads gcp-research/demo/work/${track}-pii-report.json
#   - For each match: applies an ffmpeg boxblur over the bounding box for the
#     1-second window centered on the matched frame timestamp.
#   - Writes the redacted MP4 to submission/${track}-final-${locale}.redacted.mp4
#   - Does NOT overwrite the original — the operator must `mv` the redacted
#     file over the clean one after re-running pii-ocr-scan.sh to confirm
#     clean.
#
# What this script does NOT do:
#   - Find PII on its own (the scanner does that).
#   - Edit subtitles (subtitles are scene-keyed, not frame-keyed; if a subtitle
#     line itself contains PII, fix the .srt file directly).
#   - Re-encode losslessly — boxblur requires re-encoding the locale MP4.
#     CRF 18 is preserved.
#
# Usage modes:
#   bash pii-redact.sh <track:v2|mcp> --apply-report
#     → applies every match in the report to its corresponding locale MP4
#
#   bash pii-redact.sh <track> --apply-report --locale <ko|en|ja|zh>
#     → applies only matches for that locale
#
#   bash pii-redact.sh <track> --locale <loc> \
#       --start-s <S> --end-s <E> --x <X> --y <Y> --w <W> --h <H>
#     → manual one-shot — redact (X,Y,W,H) between timestamps S and E
#
# Exit codes:
#   0  one or more matches redacted, MP4 written
#   1  bad args / report missing
#   2  ffmpeg failed
#   3  no matches in report (nothing to do — caller should re-scan to verify)
# ============================================================================

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  pii-redact.sh <track:v2|mcp> --apply-report [--locale <ko|en|ja|zh>]
  pii-redact.sh <track:v2|mcp> --locale <loc> \
                --start-s <S> --end-s <E> --x <X> --y <Y> --w <W> --h <H>

Apply blur-redactions to final-locale MP4s based on the pii-ocr-scan report.
EOF
  exit 1
}

if [[ $# -lt 2 ]]; then usage; fi

TRACK="$1"; shift
case "$TRACK" in v2|mcp) : ;; *) echo "[pii-redact] track must be v2 or mcp" >&2; exit 1 ;; esac

APPLY_REPORT=0
LOCALE_FILTER=""
START_S=""
END_S=""
X_COORD=""
Y_COORD=""
W_COORD=""
H_COORD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply-report)    APPLY_REPORT=1 ; shift ;;
    --locale)          LOCALE_FILTER="$2" ; shift 2 ;;
    --start-s)         START_S="$2" ; shift 2 ;;
    --end-s)           END_S="$2" ; shift 2 ;;
    --x)               X_COORD="$2" ; shift 2 ;;
    --y)               Y_COORD="$2" ; shift 2 ;;
    --w)               W_COORD="$2" ; shift 2 ;;
    --h)               H_COORD="$2" ; shift 2 ;;
    -h|--help)         usage ;;
    *)                 echo "[pii-redact] unknown arg: $1" >&2 ; usage ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DEMO_REPO_ROOT:=$(cd "${SCRIPT_DIR}/.." && pwd)}"
: "${DEMO_WORK_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/work}"
: "${DEMO_FINAL_DIR:=${DEMO_REPO_ROOT}/scripts/demo/submission}"

REPORT="${DEMO_WORK_DIR}/${TRACK}-pii-report.json"

log()  { printf '[pii-redact] %s\n' "$*"; }
fail() { printf '[pii-redact] FAIL %s\n' "$*" >&2; }
ok()   { printf '[pii-redact] ok   %s\n' "$*"; }

# --------------------------------------------------------------------------
# Required tool sanity
# --------------------------------------------------------------------------
for tool in ffmpeg jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "required tool missing on PATH: $tool"
    exit 1
  fi
done

# --------------------------------------------------------------------------
# Core single-redact function:
#   apply_one <locale> <start_s> <end_s> <x> <y> <w> <h>
# --------------------------------------------------------------------------
apply_one() {
  local locale="$1" start_s="$2" end_s="$3" x="$4" y="$5" w="$6" h="$7"

  local input="${DEMO_FINAL_DIR}/${TRACK}-final-${locale}.mp4"
  local output="${DEMO_FINAL_DIR}/${TRACK}-final-${locale}.redacted.mp4"

  if [[ ! -f "$input" ]]; then
    fail "input not found: $input"
    return 1
  fi

  log "redact ${locale}: t=${start_s}-${end_s}s, bbox=(${x},${y},${w},${h})"
  log "  input:  $input"
  log "  output: $output"

  # The filter chain — applies boxblur only on frames whose timestamp t lies
  # between start_s and end_s, within the bounding box.
  #
  # We use the `enable='between(t,A,B)'` ffmpeg per-filter-instance gate to
  # restrict the boxblur to the timestamp window. Outside that window the
  # filter passes pixels through unchanged.
  #
  # boxblur=10:1 = a 10-px radius blur, applied once. Strong enough to
  # obscure 28pt text inside a tooltip; light enough that the surrounding
  # frame still tells the viewer "something used to be there".
  ffmpeg \
    -y -nostdin -hide_banner \
    -i "$input" \
    -filter_complex \
      "[0:v]crop=${w}:${h}:${x}:${y}:enable='between(t,${start_s},${end_s})'[crop];[crop]boxblur=10:1[blur];[0:v][blur]overlay=${x}:${y}:enable='between(t,${start_s},${end_s})'[v]" \
    -map "[v]" -map 0:a? \
    -c:v libx264 -preset slow -crf 18 \
    -c:a copy \
    -movflags +faststart \
    "$output"

  local ec=$?
  if (( ec != 0 )); then
    fail "ffmpeg returned $ec for $locale"
    return 2
  fi
  ok "wrote $output"
}

# --------------------------------------------------------------------------
# Mode A — apply-report: iterate over report.matches[]
# --------------------------------------------------------------------------
if (( APPLY_REPORT == 1 )); then
  if [[ ! -f "$REPORT" ]]; then
    fail "report not found: $REPORT"
    fail "  run scripts/demo/post-process/pii-ocr-scan.sh ${TRACK} first"
    exit 1
  fi

  local_count=$(jq '.matches | length' "$REPORT")
  if (( local_count == 0 )); then
    ok "no matches in report — nothing to redact"
    exit 3
  fi

  log "applying ${local_count} match(es) from $REPORT"

  # jq iterates each match → emit one TSV row → bash reads
  jq -r '.matches[] |
    [ (.locale_mp4 | capture("-(?<l>[a-z][a-z-]*)\\.mp4$").l),
      (.timestamp_s | tonumber),
      .bbox.x, .bbox.y, .bbox.w, .bbox.h
    ] | @tsv' "$REPORT" \
  | while IFS=$'\t' read -r locale ts x y w h; do
      # Optional locale filter
      if [[ -n "$LOCALE_FILTER" && "$locale" != "$LOCALE_FILTER" ]]; then
        log "skip ${locale} (locale-filter=${LOCALE_FILTER})"
        continue
      fi

      # 1-second window centered on the matched frame (0.5 s before, 0.5 s after).
      # awk to avoid bash floating-point pain.
      start_s=$(awk -v t="$ts" 'BEGIN{printf "%.3f", (t - 0.5 < 0 ? 0 : t - 0.5)}')
      end_s=$(awk   -v t="$ts" 'BEGIN{printf "%.3f", t + 0.5}')

      apply_one "$locale" "$start_s" "$end_s" "$x" "$y" "$w" "$h" || exit 2
    done

  ok "all matches applied"
  log "next: re-run scripts/demo/post-process/pii-ocr-scan.sh ${TRACK} to verify clean"
  log "      then mv submission/${TRACK}-final-<loc>.redacted.mp4 over the clean name"
  exit 0
fi

# --------------------------------------------------------------------------
# Mode B — manual one-shot
# --------------------------------------------------------------------------
if [[ -z "$LOCALE_FILTER" || -z "$START_S" || -z "$END_S" \
   || -z "$X_COORD" || -z "$Y_COORD" || -z "$W_COORD" || -z "$H_COORD" ]]; then
  fail "manual mode requires --locale, --start-s, --end-s, --x, --y, --w, --h"
  usage
fi

apply_one "$LOCALE_FILTER" "$START_S" "$END_S" "$X_COORD" "$Y_COORD" "$W_COORD" "$H_COORD"
log "next: re-run scripts/demo/post-process/pii-ocr-scan.sh ${TRACK} to verify clean"
exit 0
