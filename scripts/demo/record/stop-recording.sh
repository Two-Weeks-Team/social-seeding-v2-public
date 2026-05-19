#!/usr/bin/env bash
# ============================================================================
# stop-recording.sh
# ----------------------------------------------------------------------------
# Sends the StopRecord command to OBS Studio over obs-websocket v5, verifies
# the output file landed at the expected path, and (best-effort) prints the
# media duration so the operator can sanity-check before invoking the
# post-record checklist.
#
# Authority:
#   gcp-research/demo/SCRIPT.md §8 (recording checklist — stop + file save)
# ============================================================================

set -euo pipefail

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
: "${DEMO_TRACK:=v2}"
: "${DEMO_RAW_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/raw}"
: "${OBS_WEBSOCKET_HOST:=127.0.0.1}"
: "${OBS_WEBSOCKET_PORT:=4455}"
: "${OBS_WEBSOCKET_PASSWORD:=}"

target="${DEMO_RAW_DIR}/${DEMO_TRACK}-source.mkv"

CLIENT=""
if python3 -c "import websockets" >/dev/null 2>&1; then
  CLIENT="python"
elif command -v wscat >/dev/null 2>&1; then
  CLIENT="wscat"
fi

stop_recording_python() {
  python3 - <<'PY'
import asyncio, base64, hashlib, json, os, sys
import websockets

HOST = os.environ.get("OBS_WEBSOCKET_HOST", "127.0.0.1")
PORT = int(os.environ.get("OBS_WEBSOCKET_PORT", "4455"))
PWD  = os.environ.get("OBS_WEBSOCKET_PASSWORD", "")

URL = f"ws://{HOST}:{PORT}"

async def run():
    async with websockets.connect(URL, max_size=4_000_000, ping_interval=20) as ws:
        hello = json.loads(await ws.recv())
        identify = {"op": 1, "d": {"rpcVersion": 1}}
        if "authentication" in hello.get("d", {}):
            auth_info = hello["d"]["authentication"]
            challenge = auth_info["challenge"]
            salt = auth_info["salt"]
            secret_b64 = base64.b64encode(
                hashlib.sha256((PWD + salt).encode()).digest()
            ).decode()
            auth = base64.b64encode(
                hashlib.sha256((secret_b64 + challenge).encode()).digest()
            ).decode()
            identify["d"]["authentication"] = auth
        await ws.send(json.dumps(identify))
        await ws.recv()  # identified

        await ws.send(json.dumps({
            "op": 6,
            "d": {"requestType": "StopRecord", "requestId": "stop-rec"}
        }))
        msg = json.loads(await ws.recv())
        result = msg.get("d", {}).get("responseData") or msg.get("d", {})
        out_path = (result.get("outputPath") or "").strip()
        ok = msg.get("d", {}).get("requestStatus", {}).get("result", False)
        print(json.dumps({"ok": ok, "outputPath": out_path}))

asyncio.run(run())
PY
}

stop_recording_wscat() {
  cat <<'JS' > /tmp/obs-stop-recording.js
const WebSocket = require('ws');
const crypto = require('crypto');

const host = process.env.OBS_WEBSOCKET_HOST || '127.0.0.1';
const port = process.env.OBS_WEBSOCKET_PORT || '4455';
const pwd  = process.env.OBS_WEBSOCKET_PASSWORD || '';

const ws = new WebSocket(`ws://${host}:${port}`);
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.op === 0) {
    const identify = { op: 1, d: { rpcVersion: 1 } };
    if (msg.d.authentication) {
      const { challenge, salt } = msg.d.authentication;
      const secret = crypto.createHash('sha256').update(pwd + salt).digest('base64');
      identify.d.authentication = crypto.createHash('sha256').update(secret + challenge).digest('base64');
    }
    ws.send(JSON.stringify(identify));
  } else if (msg.op === 2) {
    ws.send(JSON.stringify({ op: 6, d: { requestType: 'StopRecord', requestId: 'stop-rec' } }));
  } else if (msg.op === 7) {
    const ok = msg.d.requestStatus.result;
    const path = (msg.d.responseData && msg.d.responseData.outputPath) || '';
    console.log(JSON.stringify({ ok, outputPath: path }));
    ws.close();
    process.exit(ok ? 0 : 4);
  }
});
ws.on('error', (e) => { console.error(e.message); process.exit(5); });
JS
  node /tmp/obs-stop-recording.js
}

stop_recording_applescript() {
  case "$(uname -s)" in
    Darwin)
      echo "[stop-recording] using AppleScript fallback (Cmd+F10 hotkey from profile.json)"
      osascript -e 'tell application "OBS" to activate' \
                -e 'delay 0.3' \
                -e 'tell application "System Events" to key code 109 using {command down}'
      echo '{"ok": true, "outputPath": ""}'
      ;;
    *)
      echo "[stop-recording] FATAL — no client available." >&2
      exit 6
      ;;
  esac
}

case "$CLIENT" in
  python) resp=$(stop_recording_python) ;;
  wscat)  resp=$(stop_recording_wscat) ;;
  *)      resp=$(stop_recording_applescript) ;;
esac

echo "[stop-recording] OBS response: $resp"

# Give OBS up to 10 s to flush the final muxer state.
echo "[stop-recording] waiting up to 10s for the MKV to flush..."
for _ in $(seq 1 20); do
  if [[ -f "$target" ]]; then
    size_kb=$(du -k "$target" 2>/dev/null | awk '{print $1}')
    if [[ -n "${size_kb:-}" && "$size_kb" -gt 1024 ]]; then
      echo "[stop-recording] $target present (${size_kb} KB)"
      break
    fi
  fi
  # Pick up whichever file OBS dropped — name may include a timestamp.
  newest=$(ls -t "$DEMO_RAW_DIR"/*.mkv 2>/dev/null | head -n 1 || true)
  if [[ -n "$newest" && "$newest" != "$target" ]]; then
    mv "$newest" "$target"
    echo "[stop-recording] renamed $newest → $target"
    break
  fi
  sleep 0.5
done

if [[ ! -f "$target" ]]; then
  echo "[stop-recording] ERROR — expected MKV not found at $target" >&2
  exit 7
fi

# Print duration + size for visual sanity.
if command -v ffprobe >/dev/null 2>&1; then
  duration=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$target")
  size_mb=$(du -m "$target" | awk '{print $1}')
  printf "[stop-recording] file=%s\n                size=%s MB\n                duration=%s s\n" "$target" "$size_mb" "$duration"
fi

echo
echo "[stop-recording] next step: bash scripts/demo/record/post-record-checklist.sh"
exit 0
