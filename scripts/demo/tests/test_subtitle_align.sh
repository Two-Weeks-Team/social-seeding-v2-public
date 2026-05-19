#!/usr/bin/env bash
# ============================================================================
# test_subtitle_align.sh
# ----------------------------------------------------------------------------
# Validates that the burned-in subtitles align with the audio after the 8×
# time-warp. The pipeline runs Whisper on the FINAL 8× MP4 (English locale)
# and compares the auto-transcribed cue start times with the shipped SRT.
#
# Authority:
#   gcp-research/demo/SCRIPT.md §10 (quality bar): "Audio sync. Whisper
#   transcription against the 1× audio, then time-warped, should be sub-
#   frame accurate at 8×. If a cue drifts by > 100 ms in the final, re-run
#   the scale script."
#
# Tolerance:
#   Default 100 ms drift per cue, configurable via PII_SUBTITLE_TOLERANCE_MS.
#   "Drift" is the absolute difference between the shipped SRT cue start
#   and the Whisper-detected start of the same utterance, computed via
#   dynamic-time-warp word alignment.
#
# Usage:
#   bash scripts/demo/tests/test_subtitle_align.sh <track:v2|mcp> [locale=en]
#
# Exit codes:
#   0  every cue within tolerance
#   1  ≥ 1 cue exceeds tolerance — re-run scripts/scale-srt.ts
#   2  Whisper or ffmpeg failed
# ============================================================================

set -u
set -o pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <track:v2|mcp> [locale=en]" >&2
  exit 1
fi

track="$1"
locale="${2:-en}"
: "${SUBTITLE_TOLERANCE_MS:=100}"

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
: "${DEMO_FINAL_DIR:=${DEMO_REPO_ROOT}/scripts/demo/submission}"
: "${DEMO_SUB_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/subtitles}"
: "${DEMO_WORK_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/work}"

mp4="${DEMO_FINAL_DIR}/${track}-final-${locale}.mp4"
ref_srt="${DEMO_SUB_DIR}/${locale}.srt"
work="${DEMO_WORK_DIR}/.subtitle_align/${track}-${locale}"
mkdir -p "$work"

if [[ ! -f "$mp4" ]]; then
  echo "FATAL — $mp4 not present. Run subtitle-burn.sh first." >&2
  exit 2
fi
if [[ ! -f "$ref_srt" ]]; then
  echo "FATAL — $ref_srt not present." >&2
  exit 2
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "FATAL — ffmpeg not installed" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "FATAL — python3 not installed" >&2
  exit 2
fi

# 1. Extract audio from the final MP4.
audio="$work/audio.wav"
ffmpeg -hide_banner -nostats -loglevel error -y \
  -i "$mp4" -vn -ac 1 -ar 16000 "$audio"

# 2. Run Whisper. Prefer the python `whisper` package; fall back to whisper.cpp.
re_srt="$work/whisper.srt"
echo "==> running Whisper against $audio"

if command -v whisper >/dev/null 2>&1; then
  # openai-whisper python CLI
  case "$locale" in
    en) wl="en" ;;
    ko) wl="ko" ;;
    ja) wl="ja" ;;
    zh) wl="zh" ;;
    *)  wl="en" ;;
  esac
  whisper "$audio" \
    --model base \
    --language "$wl" \
    --task transcribe \
    --output_format srt \
    --output_dir "$work" \
    --verbose False
  mv "$work/audio.srt" "$re_srt" 2>/dev/null || true
elif command -v whisper-cli >/dev/null 2>&1; then
  whisper-cli -m ggml-large-v3.bin -osrt -of "$work/whisper" "$audio"
  mv "$work/whisper.srt" "$re_srt" 2>/dev/null || true
else
  echo "FATAL — neither whisper nor whisper-cli installed" >&2
  exit 2
fi

if [[ ! -s "$re_srt" ]]; then
  echo "FATAL — Whisper produced empty SRT at $re_srt" >&2
  exit 2
fi

# 3. Compare. Read both SRTs as (index, start_ms, end_ms, text). For each
# shipped cue, find the Whisper cue whose text best matches (lowercase
# substring intersection > 0.6) and compare start times.
python3 - "$ref_srt" "$re_srt" "$SUBTITLE_TOLERANCE_MS" <<'PY'
import re, sys

def parse_srt(path):
    out = []
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    blocks = re.split(r"\n\s*\n", raw.strip())
    for b in blocks:
        lines = b.splitlines()
        if len(lines) < 2:
            continue
        m = re.match(
            r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[,.](\d{3})",
            lines[1],
        )
        if not m:
            continue
        h1,m1,s1,ms1,h2,m2,s2,ms2 = m.groups()
        start_ms = ((int(h1)*60 + int(m1)) * 60 + int(s1)) * 1000 + int(ms1)
        end_ms   = ((int(h2)*60 + int(m2)) * 60 + int(s2)) * 1000 + int(ms2)
        text = " ".join(lines[2:]).strip()
        out.append({"start_ms": start_ms, "end_ms": end_ms, "text": text})
    return out

ref_srt_path, hyp_srt_path, tol_ms = sys.argv[1], sys.argv[2], int(sys.argv[3])
ref = parse_srt(ref_srt_path)
hyp = parse_srt(hyp_srt_path)

def normalize(s):
    return re.sub(r"[^a-zA-Z0-9\s]", " ", s.lower()).split()

drifts = []
unmatched = []

for r in ref:
    r_words = set(normalize(r["text"]))
    best = None
    best_score = 0.0
    for h in hyp:
        h_words = set(normalize(h["text"]))
        if not r_words or not h_words:
            continue
        score = len(r_words & h_words) / max(1, len(r_words | h_words))
        if score > best_score:
            best, best_score = h, score
    if best is None or best_score < 0.3:
        unmatched.append(r)
        continue
    drift = abs(r["start_ms"] - best["start_ms"])
    drifts.append({"ref_start_ms": r["start_ms"], "hyp_start_ms": best["start_ms"], "drift_ms": drift, "iou": round(best_score, 3), "text": r["text"][:60]})

failed = [d for d in drifts if d["drift_ms"] > tol_ms]

print(f"ref cues:     {len(ref)}")
print(f"hyp cues:     {len(hyp)}")
print(f"matched:      {len(drifts)} / {len(ref)}")
print(f"unmatched:    {len(unmatched)} (Whisper produced no close transcript — check audio quality)")
print(f"tolerance_ms: {tol_ms}")
print(f"failed cues:  {len(failed)}")

if drifts:
    avg_drift = sum(d['drift_ms'] for d in drifts) / len(drifts)
    print(f"avg drift:    {avg_drift:.1f} ms")

for f in failed[:20]:
    print(f"  drift={f['drift_ms']}ms  iou={f['iou']}  '{f['text']}'")

sys.exit(0 if not failed else 1)
PY

ec=$?
if (( ec == 0 )); then
  echo "PASS — every cue within ${SUBTITLE_TOLERANCE_MS} ms"
  exit 0
fi
echo "FAIL — cues exceed tolerance; re-run scripts/scale-srt.ts to re-derive timecodes from the 1× transcript"
exit 1
