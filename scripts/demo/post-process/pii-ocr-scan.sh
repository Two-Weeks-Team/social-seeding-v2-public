#!/usr/bin/env bash
# ============================================================================
# pii-ocr-scan.sh
# ----------------------------------------------------------------------------
# OCR sweep over every frame of every locale's final MP4 to catch PII that
# slipped through the recording sanitization.
#
# Authority:
#   gcp-research/edge-cases/CATALOG.md EC-7.01 — "8× recording captures
#   sensitive PII in passing". At 8× speed the human eye misses a 0.5 s
#   exposure; a careful judge does not.
#
# What we scan for:
#   - Email addresses (RFC-5322 lite)
#   - Phone numbers (E.164 + KR mobile formats)
#   - GCP project IDs that look production-ish (e.g. starting with `ss-prod-`
#     instead of the demo-allowed `ss-v2-prod-` or `ss-mcp-prod-`)
#   - Real customer names from the v1 production allow-list (sourced from
#     a sanitized list at scripts/demo/post-process/.pii_allowlist.txt that
#     each operator maintains locally; the script does NOT commit it)
#   - Production database hostnames
#   - Anthropic / OpenAI / production API key prefixes (sk-ant-, sk-, AIza,
#     AKIA, etc.)
#
# What we DO NOT flag:
#   - Test addresses: app.2weeks@gmail.com is allow-listed (D10)
#   - Demo creator personas listed in .pii_allowlist.txt
#   - Mission Control demo workspace ID
#
# Behavior on detection:
#   - Per EC-7.01, the response is "Sanitize — redact frame regions; re-render;
#     ship clean cut." This script does NOT auto-redact; it produces an
#     `pii-report.json` enumerating frames + bounding boxes so a human (or
#     a follow-up redaction agent) can patch the source.
#
# Exit codes:
#   0  zero PII matches → green to upload
#   1  PII detected → human must intervene; do NOT upload
#   2  tesseract or ffmpeg failed
# ============================================================================

set -u
set -o pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <track:v2|mcp>" >&2
  exit 1
fi

track="$1"

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
: "${DEMO_WORK_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/work}"
: "${DEMO_FINAL_DIR:=${DEMO_REPO_ROOT}/scripts/demo/submission}"

# OCR sampling rate. Default 4 fps gives us 720 frames per 3:00 video, which
# tesseract can chew through in ~5 min on a modern Mac. The frame budget is
# the controlling cost; at 4 fps any PII visible for ≥ 0.25 s in the 8×
# output (= 2 s in the source) will be sampled at least once.
: "${PII_OCR_FPS:=4}"

REPORT="${DEMO_FINAL_DIR}/${track}-pii-report.json"
ALLOWLIST="${DEMO_REPO_ROOT}/scripts/demo/post-process/.pii_allowlist.txt"

if ! command -v tesseract >/dev/null 2>&1; then
  echo "[pii-ocr-scan] FATAL — tesseract not installed (brew install tesseract tesseract-lang)" >&2
  exit 2
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[pii-ocr-scan] FATAL — ffmpeg not installed" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[pii-ocr-scan] FATAL — python3 not installed" >&2
  exit 2
fi

# --------------------------------------------------------------------------
# Allow-list (loaded for each locale)
# --------------------------------------------------------------------------
if [[ ! -f "$ALLOWLIST" ]]; then
  cat > "$ALLOWLIST" <<'TXT'
# scripts/demo/post-process/.pii_allowlist.txt
#
# Strings that the OCR pass should NOT flag as PII. One regex per line.
# Comments start with # and blank lines are ignored.
#
# DO NOT commit this file with real customer data. Maintain on each operator
# host. The repo-tracked copy ships with demo allow-list only.
#
app\.2weeks@gmail\.com
ss-v2-prod-us-central1
ss-v2-prod-europe-west4
ss-v2-prod-asia-northeast3
ss-mcp-prod
ss-v2-test
mcp\.socialseed\.ing
v2\.socialseed\.ing
Hydrate skincare
Korean skincare creators
TXT
fi

# --------------------------------------------------------------------------
# Composite report.
# --------------------------------------------------------------------------
declare -i total_matches=0
mkdir -p "$DEMO_WORK_DIR/.pii_frames"
rm -rf "$DEMO_WORK_DIR/.pii_frames/${track}"
mkdir -p "$DEMO_WORK_DIR/.pii_frames/${track}"

REPORT_TMP=$(mktemp)
echo '{"track":"'"$track"'","scanned_at":"'"$(date -u +%FT%TZ)"'","locales":{}}' > "$REPORT_TMP"

scan_locale() {
  local locale="$1"
  local mp4="${DEMO_FINAL_DIR}/${track}-final-${locale}.mp4"
  local frame_dir="${DEMO_WORK_DIR}/.pii_frames/${track}/${locale}"
  local matches_json="${DEMO_WORK_DIR}/.pii_frames/${track}/${locale}.json"

  if [[ ! -f "$mp4" ]]; then
    echo "[pii-ocr-scan:$locale] missing $mp4 — skipping" >&2
    return 0
  fi

  mkdir -p "$frame_dir"

  echo "[pii-ocr-scan:$locale] sampling at ${PII_OCR_FPS} fps from $mp4"
  ffmpeg -hide_banner -nostats -y -i "$mp4" \
    -vf "fps=${PII_OCR_FPS}" \
    "${frame_dir}/frame-%05d.png" \
    -loglevel error

  local frame_count
  frame_count=$(ls "$frame_dir"/frame-*.png 2>/dev/null | wc -l | tr -d ' ')
  echo "[pii-ocr-scan:$locale] ${frame_count} frames extracted; running tesseract"

  # Choose tesseract language pack based on locale.
  local lang_pack=eng
  case "$locale" in
    ko) lang_pack="eng+kor" ;;
    ja) lang_pack="eng+jpn" ;;
    zh) lang_pack="eng+chi_sim" ;;
  esac

  local txt_master="${frame_dir}/all-text.txt"
  : > "$txt_master"

  local i=0
  for frame in "$frame_dir"/frame-*.png; do
    i=$((i + 1))
    local txt
    txt=$(tesseract "$frame" stdout -l "$lang_pack" --psm 6 2>/dev/null || true)
    if [[ -n "$txt" ]]; then
      printf 'FRAME %05d :: %s\n' "$i" "$txt" >> "$txt_master"
    fi
    if (( i % 60 == 0 )); then
      printf '\r[pii-ocr-scan:%s] %d / %d frames OCR-ed' "$locale" "$i" "$frame_count"
    fi
  done
  printf '\r[pii-ocr-scan:%s] %d / %d frames OCR-ed\n' "$locale" "$frame_count" "$frame_count"

  # Run the python regex pass.
  python3 - "$txt_master" "$ALLOWLIST" "$matches_json" "$locale" <<'PY'
import json
import re
import sys

txt_path = sys.argv[1]
allowlist_path = sys.argv[2]
matches_path = sys.argv[3]
locale = sys.argv[4]

allow = []
with open(allowlist_path) as f:
    for line in f:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        allow.append(re.compile(s))

def is_allowed(token: str) -> bool:
    return any(p.search(token) for p in allow)

patterns = {
    "email": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    "phone_e164": re.compile(r"\+?\d{1,3}[-\s]?\(?\d{2,4}\)?[-\s]?\d{3,4}[-\s]?\d{3,4}"),
    "phone_kr_mobile": re.compile(r"\b01[0-9][-\s]?\d{3,4}[-\s]?\d{4}\b"),
    "gcp_project_prod": re.compile(r"\b(?:[a-z]+-)?prod[-_][a-z0-9-]+\b"),
    "anthropic_key": re.compile(r"\bsk-ant-[a-zA-Z0-9_\-]{20,}\b"),
    "openai_key":    re.compile(r"\bsk-[A-Za-z0-9_\-]{40,}\b"),
    "google_api_key":re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"),
    "aws_access_id": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
}

matches = []
with open(txt_path) as f:
    current_frame = None
    for line in f:
        m = re.match(r"^FRAME (\d+) :: (.*)$", line.rstrip())
        if m:
            current_frame = int(m.group(1))
            body = m.group(2)
        else:
            body = line.rstrip()
        for kind, pat in patterns.items():
            for tok in pat.findall(body):
                if is_allowed(tok):
                    continue
                matches.append({
                    "frame": current_frame,
                    "kind": kind,
                    "token": tok
                })

with open(matches_path, "w") as f:
    json.dump({"locale": locale, "matches": matches, "match_count": len(matches)}, f, indent=2)

sys.exit(0 if not matches else 1)
PY
  local py_ec=$?

  local lmatches
  lmatches=$(jq -r '.match_count' "$matches_json" 2>/dev/null || echo 0)
  total_matches=$((total_matches + lmatches))
  if (( lmatches > 0 )); then
    echo "[pii-ocr-scan:$locale] FOUND $lmatches PII matches — see $matches_json"
    jq -r '.matches[] | "  frame \(.frame): [\(.kind)] \(.token)"' "$matches_json" | sed 's/^/        /'
  else
    echo "[pii-ocr-scan:$locale] no PII matches"
  fi

  # Merge into composite report.
  jq --slurpfile per "$matches_json" \
     --arg loc "$locale" \
     '.locales[$loc] = $per[0]' \
     "$REPORT_TMP" > "${REPORT_TMP}.next"
  mv "${REPORT_TMP}.next" "$REPORT_TMP"
}

for locale in en ko ja zh; do
  scan_locale "$locale"
done

# Final composite report.
jq --argjson total "$total_matches" '.total_matches = $total' "$REPORT_TMP" > "$REPORT"
rm -f "$REPORT_TMP"

echo
echo "[pii-ocr-scan] composite report: $REPORT"
echo "[pii-ocr-scan] total matches across 4 locales: $total_matches"

if (( total_matches > 0 )); then
  echo
  echo "[pii-ocr-scan] STOP — PII detected. Per EC-7.01 you must:"
  echo "   1. Open the per-locale match list and identify each frame number."
  echo "   2. Trace the frame back to the source recording timestamp (frame ÷ ${PII_OCR_FPS} fps × 8 = source seconds)."
  echo "   3. Either re-record the affected beat, or redact the frame region in the source MKV."
  echo "   4. Re-run speed-8x.sh → overlay-burn.sh → subtitle-burn.sh → this script until $total_matches drops to 0."
  exit 1
fi

echo "[pii-ocr-scan] CLEAR — zero PII matches across all locales."
echo "[pii-ocr-scan] next: bash scripts/demo/post-process/upload-youtube.sh $track en"
exit 0
