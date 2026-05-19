#!/usr/bin/env bash
# ============================================================================
# youtube-upload.sh — operator-facing wrapper around upload-youtube.sh
# ----------------------------------------------------------------------------
# The W8prep brief defines this as the "press one button, the videos go up"
# entrypoint. The real work is done by scripts/demo/post-process/upload-youtube.sh
# (existing, already authored), which talks to the YouTube Data API v3
# directly using service-account refresh tokens stored in Secret Manager.
#
# This wrapper:
#   1. Resolves the operator-facing track number (2/3) to the internal name (v2/mcp)
#   2. Verifies the PII OCR gate has passed (otherwise refuses to run)
#   3. Verifies the 8 final MP4s exist on disk
#   4. Delegates to the real upload script, one per (track × primary_locale) pair
#   5. Prints the YouTube URLs and SRT side-car upload status
#
# The reason there are two scripts (this wrapper + the underlying one) is that
# the underlying one needs OAuth interactive flow on first run on a new
# workstation. If the operator does NOT have the YouTube OAuth refresh-token
# in Secret Manager yet, this wrapper exits 4 with `OPERATOR_MANUAL` and prints
# the manual upload path.
#
# Usage:
#   bash scripts/demo/youtube-upload.sh <track:2|3> [primary_locale=en]
#
# Examples:
#   bash scripts/demo/youtube-upload.sh 2 en   # upload track 2, English burned-in
#   bash scripts/demo/youtube-upload.sh 3 en   # upload track 3, English burned-in
#
# Per scripts/demo/post-process/upload-youtube.sh — the "primary" locale is the
# one whose MP4 is uploaded to YouTube as the video file; the other three
# locales are attached as caption tracks via the YouTube Data API.
#
# Authority:
#   - D34 (4 locales) per gcp-research/decisions/DECISIONS.md
#   - SCRIPT.md §9.5 (YouTube Unlisted + GCS mirror for CN/JP regions)
#   - The PII gate per scripts/demo/PII-OCR-GATE.md
#
# Exit codes:
#   0  uploads complete (or OPERATOR_MANUAL printed with clear instructions)
#   1  bad args
#   2  PII gate not green / missing final MP4s
#   3  underlying upload script failed
#   4  OAuth not configured — operator must run manual one-time setup
# ============================================================================

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: youtube-upload.sh <track:2|3> [primary_locale=en]" >&2
  exit 1
fi

TRACK_NUM="$1"
PRIMARY_LOCALE="${2:-en}"

case "$TRACK_NUM" in
  2) TRACK="v2" ;;
  3) TRACK="mcp" ;;
  *) echo "[youtube-upload] track must be 2 or 3, got: $TRACK_NUM" >&2; exit 1 ;;
esac

case "$PRIMARY_LOCALE" in
  en|ko|ja|zh) : ;;
  *) echo "[youtube-upload] primary_locale must be one of {en, ko, ja, zh}" >&2; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DEMO_REPO_ROOT:=$(cd "${SCRIPT_DIR}/.." && pwd)}"
: "${DEMO_WORK_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/work}"
: "${DEMO_FINAL_DIR:=${DEMO_REPO_ROOT}/scripts/demo/submission}"

log()  { printf '[youtube-upload] %s\n' "$*"; }
fail() { printf '[youtube-upload] FAIL %s\n' "$*" >&2; }
ok()   { printf '[youtube-upload] ok   %s\n' "$*"; }

# --------------------------------------------------------------------------
# Pre-flight: PII gate must have produced an OK receipt
# --------------------------------------------------------------------------
pii_receipt="${DEMO_WORK_DIR}/.receipts/${TRACK}-pii-ocr.ok"
if [[ ! -f "$pii_receipt" ]]; then
  fail "PII OCR receipt missing: $pii_receipt"
  fail "run: bash scripts/demo/post-process/pii-ocr-scan.sh ${TRACK}"
  fail "(this gate is mandatory per scripts/demo/PII-OCR-GATE.md)"
  exit 2
fi
ok "PII OCR gate passed (receipt: $pii_receipt)"

# --------------------------------------------------------------------------
# Pre-flight: every locale MP4 must exist
# --------------------------------------------------------------------------
missing=0
for loc in ko en ja zh; do
  fp="${DEMO_FINAL_DIR}/${TRACK}-final-${loc}.mp4"
  if [[ ! -f "$fp" ]]; then
    fail "missing final MP4: $fp"
    missing=$((missing + 1))
  fi
done
if (( missing > 0 )); then
  fail "${missing} locale MP4(s) missing — re-run scripts/demo/ffmpeg-8x.sh"
  exit 2
fi
ok "all 4 locale MP4s present in ${DEMO_FINAL_DIR}"

# --------------------------------------------------------------------------
# Pre-flight: OAuth credentials must be reachable (refresh-token in Secret Manager).
# If not, fall back to OPERATOR_MANUAL mode (interactive upload via YouTube Studio).
# --------------------------------------------------------------------------
oauth_ready=1
if ! command -v gcloud >/dev/null 2>&1; then
  oauth_ready=0
  fail "gcloud not on PATH"
elif ! gcloud secrets versions access latest \
        --secret="${GCP_SM_YT_REFRESH_TOKEN:-yt-uploader-refresh-token}" \
        --project="${GCP_PROJECT_ID:-ss-v2-prod-us-central1}" \
        >/dev/null 2>&1; then
  oauth_ready=0
  fail "cannot fetch YouTube OAuth refresh-token from Secret Manager"
fi

if (( oauth_ready == 0 )); then
  cat >&2 <<EOF

============================================================================
OPERATOR_MANUAL — automated upload requires one-time OAuth setup.

The underlying upload script (scripts/demo/post-process/upload-youtube.sh)
expects a refresh-token in Secret Manager at:

  projects/\${GCP_PROJECT_ID}/secrets/\${GCP_SM_YT_REFRESH_TOKEN}

If you have not done the one-time OAuth setup yet, the only way to upload
right now is via YouTube Studio in the browser:

  1. Go to https://studio.youtube.com
  2. Sign in as the demo account (per RECORDING-CHECKLIST.md §3).
  3. Click "Create" → "Upload video".
  4. Upload:   ${DEMO_FINAL_DIR}/${TRACK}-final-${PRIMARY_LOCALE}.mp4
  5. Visibility: Unlisted.
  6. Title:    "Social Seeding v2 — Track ${TRACK_NUM} Demo (3 min, ${PRIMARY_LOCALE})"
  7. Description: paste the content of ${DEMO_FINAL_DIR}/devpost-track${TRACK_NUM}.md
                  (first 5000 chars).
  8. After upload, open the video → "Subtitles" → "Add" → upload these
     .srt files as additional caption tracks:
$(for loc in ko en ja zh; do
    if [[ "\$loc" != "${PRIMARY_LOCALE}" ]]; then
      echo "       - ${DEMO_REPO_ROOT}/scripts/demo/subtitles/track${TRACK_NUM}-\${loc}.srt"
    fi
  done)

  9. Schedule publish: 2026-06-15 (post-judging window per D33 / SCRIPT.md §9.5).
 10. Copy the video URL and paste into scripts/demo/submission/README-track${TRACK_NUM}.md.

To unblock the automated path:

  # one-time OAuth dance (interactive, opens browser):
  gcloud auth application-default login
  python3 ${DEMO_REPO_ROOT}/scripts/demo/post-process/_oauth_bootstrap.py \\
    --client-secret ${DEMO_REPO_ROOT}/.secrets/yt-client-secret.json \\
    --secret-id \${GCP_SM_YT_REFRESH_TOKEN}

  # Then re-run THIS script.
============================================================================
EOF
  exit 4
fi
ok "YouTube OAuth refresh-token reachable in Secret Manager"

# --------------------------------------------------------------------------
# Delegate to the existing scripts/demo/post-process/upload-youtube.sh.
# That script accepts (track, primary_locale), uploads the primary MP4,
# attaches the other 3 SRTs as caption tracks, mirrors all 4 MP4s to GCS,
# and writes scripts/demo/submission/${track}-youtube-metadata.json.
# --------------------------------------------------------------------------
log "delegating to scripts/demo/post-process/upload-youtube.sh ..."
if ! bash "${SCRIPT_DIR}/post-process/upload-youtube.sh" "$TRACK" "$PRIMARY_LOCALE"; then
  fail "upload-youtube.sh exited non-zero"
  exit 3
fi
ok "upload-youtube.sh complete"

# --------------------------------------------------------------------------
# Surface the result
# --------------------------------------------------------------------------
meta="${DEMO_FINAL_DIR}/${TRACK}-youtube-metadata.json"
if [[ -f "$meta" ]]; then
  if command -v jq >/dev/null 2>&1; then
    video_url=$(jq -r '.video_url' "$meta" 2>/dev/null || echo "<see $meta>")
    gcs_url=$(jq -r '.gcs_mirror_url // ""' "$meta" 2>/dev/null || echo "")
    log ""
    log "===== UPLOAD COMPLETE ====="
    log "YouTube (unlisted): $video_url"
    [[ -n "$gcs_url" ]] && log "GCS mirror:         $gcs_url"
    log "Metadata:           $meta"
    log ""
    log "Next: paste these URLs into scripts/demo/submission/README-track${TRACK_NUM}.md"
    log "      then re-confirm scripts/demo/submission/devpost-track${TRACK_NUM}.md"
  else
    log "metadata at: $meta (install jq for prettier output)"
  fi
fi

exit 0
