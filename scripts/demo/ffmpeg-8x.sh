#!/usr/bin/env bash
# ============================================================================
# ffmpeg-8x.sh — one-shot operator wrapper around the existing post-process chain
# ----------------------------------------------------------------------------
# This script is the "press one button, get four locale MP4s out the back"
# wrapper around the existing scripts in `scripts/demo/post-process/`.
# It exists because the operator should not have to remember the 6-step
# `speed-8x → overlay-burn → subtitle-burn (× 4 locales) → pii-ocr-scan`
# sequence on recording night.
#
# Authority:
#   - D30 (8× speed real-mouse recording) per gcp-research/decisions/DECISIONS.md
#   - D34 (4 locales: ko / en / ja / zh-CN)
#   - D10 (PII gate via tesseract OCR pass — gcp-research/edge-cases/CATALOG.md EC-7.01)
#
# What this wrapper does:
#   1. Accept a raw source recording: `recording-track{2|3}-source.mov` (or .mkv).
#   2. Run speed-8x.sh                        → work/${track}-8x.mp4
#   3. Run overlay-burn.sh                    → work/${track}-with-overlay.mp4
#   4. For each locale in {ko en ja zh}: run subtitle-burn.sh → submission/track${TN}-${locale}.mp4
#      (where TN is "2" for v2 / "3" for mcp — the operator-facing name is `track2/3`,
#      the existing scripts use `v2/mcp` internally)
#   5. Run pii-ocr-scan.sh per locale → block upload if any PII match.
#
# What this wrapper does NOT do:
#   - Upload to YouTube (use `scripts/demo/youtube-upload.sh` after this passes).
#   - Re-render the source recording (out of scope; see ffmpeg invocation below).
#   - Tweak the filter chain (intentionally re-uses the canonical filter from
#     `scripts/demo/post-process/speed-8x.sh` which itself implements
#     `gcp-research/demo/SCRIPT.md §2.3`).
#
# Usage:
#   bash scripts/demo/ffmpeg-8x.sh <source-file> <track:2|3> [locales="ko en ja zh"]
#
# Examples:
#   bash scripts/demo/ffmpeg-8x.sh recording-track2-source.mov 2
#   bash scripts/demo/ffmpeg-8x.sh recording-track3-source.mkv 3 "en"
#   bash scripts/demo/ffmpeg-8x.sh ./raw/track2-source.mov 2 "ko ja"
#
# Output naming:
#   Per the W8prep brief, final locale files are named `track${TN}-${locale}.mp4`
#   (NOT the existing `v2-final-${locale}.mp4`). This wrapper produces both names
#   via a symlink for compatibility with the upload script.
#
# Exit codes:
#   0  every locale rendered + PII scan clean
#   1  invalid args / missing source
#   2  speed-8x failed
#   3  overlay-burn failed
#   4  one or more subtitle-burn passes failed
#   5  one or more PII OCR scans flagged content (DO NOT UPLOAD)
# ============================================================================

set -euo pipefail

if [[ $# -lt 2 ]]; then
  cat >&2 <<'USAGE'
usage: ffmpeg-8x.sh <source-file> <track:2|3> [locales]
  source-file : path to recording-track{2|3}-source.{mov|mkv} (24-min raw)
  track       : "2" (social-seeding-v2) or "3" (tiktok-mcp-server)
  locales     : space-separated subset of "ko en ja zh" (default: all four)
USAGE
  exit 1
fi

SOURCE_PATH="$1"
TRACK_NUM="$2"
LOCALES="${3:-ko en ja zh}"

if [[ ! -f "$SOURCE_PATH" ]]; then
  echo "[ffmpeg-8x] source not found: $SOURCE_PATH" >&2
  exit 1
fi

# Map operator-facing track number (2/3) → internal track name (v2/mcp)
case "$TRACK_NUM" in
  2) TRACK="v2" ;;
  3) TRACK="mcp" ;;
  *)
    echo "[ffmpeg-8x] track must be 2 or 3, got: $TRACK_NUM" >&2
    exit 1
    ;;
esac

# Resolve paths (mirroring scripts/demo/README.md §3.4 conventions)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DEMO_REPO_ROOT:=$(cd "${SCRIPT_DIR}/.." && pwd)}"
: "${DEMO_WORK_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/work}"
: "${DEMO_FINAL_DIR:=${DEMO_REPO_ROOT}/scripts/demo/submission}"

mkdir -p "$DEMO_WORK_DIR" "$DEMO_FINAL_DIR"

# Required tools (fail fast if missing)
for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[ffmpeg-8x] required tool missing on PATH: $tool" >&2
    echo "             install via: brew install ffmpeg" >&2
    exit 1
  fi
done

# Pretty logging
log()  { printf '[ffmpeg-8x] %s\n' "$*"; }
fail() { printf '[ffmpeg-8x] FAIL %s\n' "$*" >&2; }
ok()   { printf '[ffmpeg-8x] ok   %s\n' "$*"; }

# ----------------------------------------------------------------------------
# Step 1: 8× speed-warp
# Delegates to scripts/demo/post-process/speed-8x.sh (canonical filter chain).
# Per `scripts/demo/post-process/speed-8x.sh` line 87-95:
#   ffmpeg -i input.mkv \
#     -filter_complex "[0:v]setpts=0.125*PTS[v];[0:a]atempo=2.0,atempo=2.0,atempo=2.0[a]" \
#     -map "[v]" -map "[a]" -c:v libx264 -preset slow -crf 18 \
#     -c:a aac -b:a 192k -movflags +faststart output-8x.mp4
# Per D30 the audio is silent (mic muted during record). The atempo chain is
# preserved anyway so a future narrated re-take works without filter changes.
# ----------------------------------------------------------------------------
log "===== Step 1/3 — 8× speed-warp ($TRACK) ====="
if ! bash "${SCRIPT_DIR}/post-process/speed-8x.sh" "$SOURCE_PATH" "$TRACK"; then
  fail "speed-8x.sh exited non-zero"
  exit 2
fi
ok "speed-8x complete — work/${TRACK}-8x.mp4"

# ----------------------------------------------------------------------------
# Step 2: Lower-third + diagram overlay burn-in
# Delegates to scripts/demo/post-process/overlay-burn.sh. The overlay PNG
# sequence is produced by `scripts/gen-overlay.ts` (DEMO-1 follow-up in
# scripts/demo/README.md §10). If the overlay agent hasn't run yet, overlay-burn
# falls back to `_overlay_fallback.sh` (static lower-third per beat).
# ----------------------------------------------------------------------------
log "===== Step 2/3 — overlay burn (track-name + scene markers) ====="
if ! bash "${SCRIPT_DIR}/post-process/overlay-burn.sh" "$TRACK"; then
  fail "overlay-burn.sh exited non-zero"
  exit 3
fi
ok "overlay-burn complete — work/${TRACK}-with-overlay.mp4"

# ----------------------------------------------------------------------------
# Step 3: Per-locale subtitle burn-in + PII OCR gate
# Delegates to scripts/demo/post-process/subtitle-burn.sh per locale, then
# scripts/demo/post-process/pii-ocr-scan.sh for the final gate.
#
# The existing subtitle-burn.sh iterates over all 4 locales by default. We
# call it once for the full set, but allow a subset override via $LOCALES.
# ----------------------------------------------------------------------------
log "===== Step 3/3 — subtitle burn (locales: $LOCALES) ====="

# subtitle-burn.sh inputs its locales via DEMO_LOCALES env if set, otherwise
# iterates the default 4. Pass our LOCALES through.
if ! DEMO_LOCALES="$LOCALES" bash "${SCRIPT_DIR}/post-process/subtitle-burn.sh" "$TRACK"; then
  fail "subtitle-burn.sh exited non-zero (one or more locales failed)"
  exit 4
fi
ok "subtitle-burn complete (per-locale)"

# ----------------------------------------------------------------------------
# Step 4: PII OCR gate (per D10 + EC-7.01).
# Blocks all uploads if any locale's final MP4 contains PII-shaped text.
# ----------------------------------------------------------------------------
log "===== Step 4/4 — PII OCR scan (D10 / EC-7.01) ====="
if ! bash "${SCRIPT_DIR}/post-process/pii-ocr-scan.sh" "$TRACK"; then
  fail "pii-ocr-scan.sh detected PII — DO NOT UPLOAD"
  fail "report at: ${DEMO_WORK_DIR}/${TRACK}-pii-report.json"
  fail "remediation: see scripts/demo/PII-OCR-GATE.md"
  exit 5
fi
ok "PII OCR clean across all locales"

# ----------------------------------------------------------------------------
# Step 5: Produce operator-friendly aliases.
# The existing pipeline writes `${TRACK}-final-${locale}.mp4`. The W8prep brief
# names them `track${TN}-${locale}.mp4`. We create symlinks both ways so either
# name works with the downstream `youtube-upload.sh` / `pii-redact.sh` tools.
# ----------------------------------------------------------------------------
log "===== Creating operator-friendly symlinks ====="
for loc in $LOCALES; do
  src="${DEMO_FINAL_DIR}/${TRACK}-final-${loc}.mp4"
  alias_name="${DEMO_FINAL_DIR}/track${TRACK_NUM}-${loc}.mp4"
  if [[ -f "$src" ]]; then
    # ln -sf is idempotent; absolute path so the symlink is stable across cwd.
    ln -sf "$src" "$alias_name"
    ok "alias: $(basename "$alias_name") -> $(basename "$src")"
  else
    fail "expected final not present: $src"
  fi
done

# ----------------------------------------------------------------------------
# Final summary
# ----------------------------------------------------------------------------
log ""
log "===== DONE ====="
log "Source:    $SOURCE_PATH"
log "Track:     $TRACK_NUM ($TRACK internally)"
log "Locales:   $LOCALES"
log ""
log "Finals (existing names):"
for loc in $LOCALES; do
  printf '  %s\n' "${DEMO_FINAL_DIR}/${TRACK}-final-${loc}.mp4"
done
log "Aliases (W8prep names):"
for loc in $LOCALES; do
  printf '  %s\n' "${DEMO_FINAL_DIR}/track${TRACK_NUM}-${loc}.mp4"
done
log ""
log "Next step: bash scripts/demo/youtube-upload.sh ${TRACK_NUM} en"
exit 0
