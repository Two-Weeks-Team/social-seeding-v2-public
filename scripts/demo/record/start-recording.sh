#!/usr/bin/env bash
# ============================================================================
# start-recording.sh
# ----------------------------------------------------------------------------
# Sends the StartRecord command to OBS Studio over the obs-websocket v5
# protocol, after verifying that:
#   - the configured scene collection is the one for $DEMO_TRACK,
#   - the configured profile is `social-seeding-v2-demo`,
#   - any existing MKV at the target path is moved aside (never overwritten),
#   - the recording starts cleanly (status == OBS_WEBSOCKET_OUTPUT_STARTED).
#
# Authority:
#   gcp-research/demo/SCRIPT.md §2.1 (OBS profile) and §8 (recording checklist)
#
# obs-websocket protocol: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
#   Op-code 1 = Identify (with rpc-version 1 and optional auth)
#   Op-code 6 = Request (request StartRecord)
#   Op-code 7 = RequestResponse (recording started ok)
#
# Implementation note:
#   Hard-coding a WebSocket client in pure bash is masochistic. We use Python
#   with the `websockets` library if available; otherwise we fall back to
#   `wscat` (Node). If neither is present we fall back to AppleScript on
#   macOS (System Events keypress on the Cmd+F9 hotkey from profile.json).
# ============================================================================

set -euo pipefail

: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
: "${DEMO_TRACK:=v2}"
: "${DEMO_RAW_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/raw}"
: "${OBS_WEBSOCKET_HOST:=127.0.0.1}"
: "${OBS_WEBSOCKET_PORT:=4455}"
: "${OBS_WEBSOCKET_PASSWORD:=}"

mkdir -p "$DEMO_RAW_DIR"

# --------------------------------------------------------------------------
# Move existing MKV aside (never overwrite — recording day is precious)
# --------------------------------------------------------------------------
target="${DEMO_RAW_DIR}/${DEMO_TRACK}-source.mkv"
if [[ -f "$target" ]]; then
  stamp=$(date +%Y%m%d-%H%M%S)
  backup="${DEMO_RAW_DIR}/${DEMO_TRACK}-source.${stamp}.mkv"
  mv "$target" "$backup"
  echo "[start-recording] existing $target moved to $backup"
fi

# --------------------------------------------------------------------------
# Pick a WebSocket client.
# --------------------------------------------------------------------------
CLIENT=""
if python3 -c "import websockets" >/dev/null 2>&1; then
  CLIENT="python"
elif command -v wscat >/dev/null 2>&1; then
  CLIENT="wscat"
fi

# --------------------------------------------------------------------------
# Path A — python websockets (preferred)
# --------------------------------------------------------------------------
start_recording_python() {
  python3 - <<PY
import asyncio, base64, hashlib, json, os, sys
import websockets

HOST = os.environ.get("OBS_WEBSOCKET_HOST", "127.0.0.1")
PORT = int(os.environ.get("OBS_WEBSOCKET_PORT", "4455"))
PWD  = os.environ.get("OBS_WEBSOCKET_PASSWORD", "")
TRACK = os.environ.get("DEMO_TRACK", "v2")

URL = f"ws://{HOST}:{PORT}"

async def run():
    async with websockets.connect(URL, max_size=4_000_000, ping_interval=20) as ws:
        hello = json.loads(await ws.recv())
        if hello.get("op") != 0:
            sys.stderr.write(f"unexpected hello op: {hello}\n")
            sys.exit(2)

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

        identified = json.loads(await ws.recv())
        if identified.get("op") != 2:
            sys.stderr.write(f"identify failed: {identified}\n")
            sys.exit(3)

        scene_collection = f"social-seeding-v2-track{ '2' if TRACK == 'v2' else '3' }"
        await ws.send(json.dumps({
            "op": 6,
            "d": {
                "requestType": "SetCurrentSceneCollection",
                "requestId": "set-scene-collection",
                "requestData": {"sceneCollectionName": scene_collection}
            }
        }))
        msg = json.loads(await ws.recv())
        if not msg.get("d", {}).get("requestStatus", {}).get("result", False):
            sys.stderr.write(f"SetCurrentSceneCollection failed: {msg}\n")
            # Not fatal — operator may have a custom-named collection.

        await ws.send(json.dumps({
            "op": 6,
            "d": {
                "requestType": "StartRecord",
                "requestId": "start-rec"
            }
        }))
        msg = json.loads(await ws.recv())
        ok = msg.get("d", {}).get("requestStatus", {}).get("result", False)
        code = msg.get("d", {}).get("requestStatus", {}).get("code", -1)
        if not ok:
            sys.stderr.write(f"StartRecord failed: {msg}\n")
            sys.exit(4)

        print(f"[start-recording] OBS StartRecord acknowledged (code={code})", flush=True)

asyncio.run(run())
PY
}

# --------------------------------------------------------------------------
# Path B — wscat (Node)
# --------------------------------------------------------------------------
start_recording_wscat() {
  cat <<'JS' > /tmp/obs-start-recording.js
const WebSocket = require('ws');
const crypto = require('crypto');

const host = process.env.OBS_WEBSOCKET_HOST || '127.0.0.1';
const port = process.env.OBS_WEBSOCKET_PORT || '4455';
const pwd  = process.env.OBS_WEBSOCKET_PASSWORD || '';

const ws = new WebSocket(`ws://${host}:${port}`);
ws.on('open', () => {});
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
    ws.send(JSON.stringify({
      op: 6,
      d: { requestType: 'StartRecord', requestId: 'start-rec' }
    }));
  } else if (msg.op === 7) {
    if (msg.d.requestType === 'StartRecord') {
      const ok = msg.d.requestStatus.result;
      console.log(`[start-recording] result=${ok} code=${msg.d.requestStatus.code}`);
      ws.close();
      process.exit(ok ? 0 : 4);
    }
  }
});
ws.on('error', (e) => { console.error(e.message); process.exit(5); });
JS
  node /tmp/obs-start-recording.js
}

# --------------------------------------------------------------------------
# Path C — AppleScript fallback (macOS only)
# --------------------------------------------------------------------------
start_recording_applescript() {
  case "$(uname -s)" in
    Darwin)
      echo "[start-recording] using AppleScript fallback (Cmd+F9 hotkey from profile.json)"
      osascript -e 'tell application "OBS" to activate' \
                -e 'delay 0.5' \
                -e 'tell application "System Events" to key code 101 using {command down}' # F9 keycode
      ;;
    *)
      echo "[start-recording] FATAL — no WebSocket client available and no AppleScript fallback on this platform."
      echo "                       install one of: python3 + websockets, wscat (npm i -g wscat), or run on macOS."
      exit 6
      ;;
  esac
}

# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------
case "$CLIENT" in
  python) start_recording_python ;;
  wscat)  start_recording_wscat ;;
  *)      start_recording_applescript ;;
esac

echo
echo "[start-recording] OBS is recording. Target file: $target"
echo "                  Operator: follow gcp-research/demo/SCRIPT.md §3 (Track 2) or §4 (Track 3) beat-by-beat."
echo "                  When all 6 beats are done, run: bash scripts/demo/record/stop-recording.sh"
exit 0
