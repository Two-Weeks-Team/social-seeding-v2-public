#!/usr/bin/env bash
# ============================================================================
# upload-youtube.sh
# ----------------------------------------------------------------------------
# Uploads the final per-track MP4 (English burned in) to YouTube as
# "Unlisted", scheduled-publish past the judging window, and attaches the
# other three locale SRT files as additional caption tracks via the
# YouTube Data API v3.
#
# Also mirrors all four MP4s to the public Cloud Storage bucket for direct-
# download redundancy (per SCRIPT.md §9.5: "judges in JP/CN regions
# sometimes have YouTube latency").
#
# Authority:
#   gcp-research/demo/SCRIPT.md §9.5 (distribution) + §2.6 (YouTube path)
#   gcp-research/demo-deliverables/SUBMISSION-PACKAGE.md §1.f (hosting)
#
# Secrets:
#   - GCP_SM_YT_CLIENT_SECRET    → Secret Manager: YouTube OAuth client_secret.json
#   - GCP_SM_YT_REFRESH_TOKEN    → Secret Manager: YouTube OAuth refresh_token
#   - GCS_BUCKET_PUBLIC          → gs://… public bucket name
#
# These are fetched at runtime via `gcloud secrets versions access` so no
# credential touches the script's filesystem persistently.
#
# Usage:
#   bash upload-youtube.sh <track:v2|mcp> <primary_locale:en>
#
# A YouTube video metadata file at:
#   scripts/demo/submission/${track}-youtube-metadata.json
# is written with: video_id, video_url, caption_track_ids per locale,
# GCS mirror URLs. The README templates read this file when generating the
# final READMEs.
# ============================================================================

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <track:v2|mcp> [primary_locale=en]" >&2
  exit 1
fi

track="$1"
primary_locale="${2:-en}"

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
: "${DEMO_FINAL_DIR:=${DEMO_REPO_ROOT}/scripts/demo/submission}"
: "${DEMO_SUB_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/subtitles}"
: "${GCP_PROJECT_ID:=ss-v2-prod-us-central1}"
: "${GCP_SM_YT_CLIENT_SECRET:=yt-uploader-client-secret}"
: "${GCP_SM_YT_REFRESH_TOKEN:=yt-uploader-refresh-token}"
: "${GCS_BUCKET_PUBLIC:=gs://ss-v2-demo-public}"
: "${YT_PRIVACY_STATUS:=unlisted}"
: "${YT_SCHEDULED_PUBLISH_AT:=2026-06-10T17:00:00Z}"

primary_mp4="${DEMO_FINAL_DIR}/${track}-final-${primary_locale}.mp4"
metadata_out="${DEMO_FINAL_DIR}/${track}-youtube-metadata.json"

if [[ ! -f "$primary_mp4" ]]; then
  echo "[upload-youtube] primary mp4 missing: $primary_mp4" >&2
  exit 1
fi

# --------------------------------------------------------------------------
# Block upload if the PII OCR scan has not produced a clean composite report.
# --------------------------------------------------------------------------
pii_report="${DEMO_FINAL_DIR}/${track}-pii-report.json"
if [[ ! -f "$pii_report" ]]; then
  echo "[upload-youtube] FATAL — $pii_report not found. Run pii-ocr-scan.sh first." >&2
  exit 2
fi
total=$(jq -r '.total_matches' "$pii_report" 2>/dev/null || echo 99999)
if (( total > 0 )); then
  echo "[upload-youtube] STOP — PII report shows $total matches. Refusing to upload." >&2
  echo "                 Fix per pii-ocr-scan.sh exit-1 instructions, then retry." >&2
  exit 3
fi

# --------------------------------------------------------------------------
# Fetch secrets.
# --------------------------------------------------------------------------
if ! command -v gcloud >/dev/null 2>&1; then
  echo "[upload-youtube] FATAL — gcloud not installed" >&2
  exit 4
fi

echo "[upload-youtube] fetching YouTube OAuth client secret from Secret Manager..."
client_secret_json=$(gcloud secrets versions access latest \
  --secret="${GCP_SM_YT_CLIENT_SECRET}" \
  --project="${GCP_PROJECT_ID}")

echo "[upload-youtube] fetching YouTube OAuth refresh token..."
refresh_token=$(gcloud secrets versions access latest \
  --secret="${GCP_SM_YT_REFRESH_TOKEN}" \
  --project="${GCP_PROJECT_ID}")

# --------------------------------------------------------------------------
# Title + description.
# --------------------------------------------------------------------------
if [[ "$track" == "v2" ]]; then
  yt_title="social-seeding-v2 — 22-agent influencer-campaign loop on GCP (Track 2)"
  yt_description=$(cat <<EOF
social-seeding-v2 — Google for Startups AI Agents Challenge, Track 2 (Optimize).

22-agent fleet (16 domain + 3 meta + 3 watchdog) on Vertex AI Agent Runtime,
orchestrated through Cloud Workflows + Pub/Sub + Cloud Tasks + Eventarc,
multi-region active-active (us-central1 / europe-west4 / asia-northeast3),
hybrid Spanner + AlloyDB AI + Firestore + Vertex Vector Search.

Recorded live at 1× over 24 minutes; compressed to 3:00 at 8× speed
per the D30 demo format. Transparent preview overlay carries section
markers, cost ticker, and live Mermaid diagram. Subtitles in
한국어 / English / 日本語 / 中文 简 per D34.

Repo: github.com/<repo>
Apache 2.0 + BUSL-1.1 (D9)
DECISIONS.md: gcp-research/decisions/DECISIONS.md

#GoogleForStartups #AIAgents #GCP #Vertex #Gemini
EOF
)
else
  yt_title="tiktok-mcp-server — A2A-distributable MCP connector on GCP (Track 3)"
  yt_description=$(cat <<EOF
tiktok-mcp-server — Google for Startups AI Agents Challenge, Track 3 (Refactor).

Dual-surface MCP connector + ADK orchestration agent. Four MCP tools on
Cloud Run, A2A v0.3 registration via agent.json, Marketplace listing
PENDING (Korea payment-region disclosure per D2 / D3 — the gap is the
contribution). Multi-region failover demonstrated live with a global LB
failover under 8 s per the D31 SLO.

Recorded live at 1× over 24 minutes; compressed to 3:00 at 8× speed
per the D30 demo format. Subtitles in 한국어 / English / 日本語 / 中文 简
per D34.

Repo: github.com/<repo>
BUSL-1.1 (D9)
DECISIONS.md: gcp-research/decisions/DECISIONS.md

#GoogleForStartups #AIAgents #MCP #A2A #GCP
EOF
)
fi

# --------------------------------------------------------------------------
# Run the Python uploader (resumable, multipart, with caption attachment).
# --------------------------------------------------------------------------
python3 - <<PY
import json
import os
import sys

try:
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
except ModuleNotFoundError as e:
    sys.stderr.write(f"[upload-youtube] missing python deps — pip install google-api-python-client google-auth-oauthlib: {e}\n")
    sys.exit(5)

client = json.loads('''$client_secret_json''')
creds = Credentials(
    token=None,
    refresh_token='''$refresh_token'''.strip(),
    token_uri=client.get("installed", client.get("web", {})).get("token_uri", "https://oauth2.googleapis.com/token"),
    client_id=client.get("installed", client.get("web", {})).get("client_id"),
    client_secret=client.get("installed", client.get("web", {})).get("client_secret"),
    scopes=["https://www.googleapis.com/auth/youtube.upload",
            "https://www.googleapis.com/auth/youtube.force-ssl"]
)

yt = build("youtube", "v3", credentials=creds, cache_discovery=False)

body = {
  "snippet": {
    "title": """$yt_title""",
    "description": """$yt_description""",
    "tags": ["Google for Startups", "AI Agents Challenge", "GCP", "Vertex AI", "ADK", "Gemini"],
    "categoryId": "28"
  },
  "status": {
    "privacyStatus": "$YT_PRIVACY_STATUS",
    "publishAt":      "$YT_SCHEDULED_PUBLISH_AT",
    "selfDeclaredMadeForKids": False,
    "license": "youtube"
  }
}

media = MediaFileUpload(
  "$primary_mp4",
  chunksize=8 * 1024 * 1024,
  resumable=True,
  mimetype="video/mp4"
)

req = yt.videos().insert(part="snippet,status", body=body, media_body=media)

response = None
while response is None:
    status, response = req.next_chunk()
    if status:
        sys.stderr.write(f"[upload-youtube] progress: {int(status.progress() * 100)}%\n")

video_id = response["id"]
video_url = f"https://youtu.be/{video_id}"
print(f"[upload-youtube] video_id={video_id}")
print(f"[upload-youtube] video_url={video_url}")

# Attach caption tracks for the other locales.
caption_ids = {"$primary_locale": "burned-in"}
for locale in ["ko", "en", "ja", "zh"]:
    if locale == "$primary_locale":
        continue
    srt_path = os.path.join("$DEMO_SUB_DIR", f"{locale}.srt")
    if not os.path.exists(srt_path):
        sys.stderr.write(f"[upload-youtube] caption {locale}: missing {srt_path}; skipping\n")
        continue
    cap_body = {
      "snippet": {
        "videoId": video_id,
        "language": locale,
        "name": f"{locale}.srt",
        "isDraft": False
      }
    }
    cap_media = MediaFileUpload(srt_path, mimetype="application/octet-stream", resumable=False)
    cap = yt.captions().insert(part="snippet", body=cap_body, media_body=cap_media).execute()
    caption_ids[locale] = cap["id"]
    print(f"[upload-youtube] caption {locale}: id={cap['id']}")

with open("$metadata_out", "w") as f:
  json.dump({
    "track":           "$track",
    "video_id":        video_id,
    "video_url":       video_url,
    "primary_locale":  "$primary_locale",
    "caption_track_ids": caption_ids,
    "privacy":         "$YT_PRIVACY_STATUS",
    "scheduled_publish_at": "$YT_SCHEDULED_PUBLISH_AT"
  }, f, indent=2)

print(f"[upload-youtube] metadata written to $metadata_out")
PY

py_ec=$?
if (( py_ec != 0 )); then
  echo "[upload-youtube] YouTube upload failed with exit $py_ec — see stderr for the underlying API error" >&2
  exit 6
fi

# --------------------------------------------------------------------------
# Mirror all 4 locales to GCS for direct-download redundancy.
# --------------------------------------------------------------------------
echo
echo "[upload-youtube] mirroring 4 locale MP4s to ${GCS_BUCKET_PUBLIC}/${track}/"

for locale in en ko ja zh; do
  src="${DEMO_FINAL_DIR}/${track}-final-${locale}.mp4"
  dst="${GCS_BUCKET_PUBLIC}/${track}/${track}-final-${locale}.mp4"
  if [[ ! -f "$src" ]]; then
    echo "[upload-youtube] skip $locale (missing $src)" >&2
    continue
  fi
  gcloud storage cp \
    --cache-control="public, max-age=3600" \
    --content-type="video/mp4" \
    "$src" "$dst"
  public_url="https://storage.googleapis.com/${GCS_BUCKET_PUBLIC#gs://}/${track}/${track}-final-${locale}.mp4"
  echo "[upload-youtube] mirrored: $public_url"
done

# Add the GCS mirror URLs to the metadata file.
jq --arg base "${GCS_BUCKET_PUBLIC#gs://}/${track}" \
   '.gcs_mirror_base = ("https://storage.googleapis.com/" + $base)' \
   "$metadata_out" > "${metadata_out}.next"
mv "${metadata_out}.next" "$metadata_out"

echo
echo "[upload-youtube] done. metadata at $metadata_out"
echo "[upload-youtube] paste $(jq -r '.video_url' "$metadata_out") into the Devpost submission form."
exit 0
