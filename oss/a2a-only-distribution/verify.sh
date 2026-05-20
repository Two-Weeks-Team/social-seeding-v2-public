#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
#
# Boots the A2A-only skeleton, then proves the template works end to end:
#   1. GET  /.well-known/agent.json  returns a valid A2A v0.3 card
#   2. GET  /.well-known/jwks.json   returns a JWKS doc
#   3. POST /v1/message:send         returns a completed A2A task envelope
#   4. examples/client.py            discovers + invokes the agent
#
# Pure stdlib: needs only python3 and curl. No pip install.
#
# Usage:  ./verify.sh         (picks a free-ish port, default 8077)
#         PORT=9123 ./verify.sh
set -euo pipefail

PORT="${PORT:-8077}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="http://localhost:${PORT}"
PASS=0
FAIL=0

note()  { printf '\n=== %s ===\n' "$1"; }
ok()    { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad()   { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# --- boot the skeleton in the background -----------------------------------
note "booting skeleton on :${PORT}"
PORT="${PORT}" python3 "${HERE}/skeleton/server.py" &
SERVER_PID=$!
cleanup() { kill "${SERVER_PID}" 2>/dev/null || true; }
trap cleanup EXIT

# wait for liveness (max ~5s)
for _ in $(seq 1 25); do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

# --- 1. agent card ----------------------------------------------------------
note "GET /.well-known/agent.json"
CARD="$(curl -fsS "${BASE}/.well-known/agent.json")"
echo "${CARD}" | python3 -m json.tool >/dev/null && ok "card is valid JSON" || bad "card not JSON"
echo "${CARD}" | python3 -c "import sys,json;c=json.load(sys.stdin);assert c['protocolVersion']=='0.3.0';assert c['skills'];print('  protocolVersion:',c['protocolVersion']);print('  name:',c['name'])" \
  && ok "card declares A2A v0.3 + >=1 skill" || bad "card missing v0.3/skills"

# --- 2. jwks ---------------------------------------------------------------
note "GET /.well-known/jwks.json"
JWKS="$(curl -fsS "${BASE}/.well-known/jwks.json")"
echo "${JWKS}" | python3 -c "import sys,json;d=json.load(sys.stdin);assert 'keys' in d;print('  keys:',len(d['keys']))" \
  && ok "jwks has a keys[] array" || bad "jwks malformed"

# --- 3. message:send -------------------------------------------------------
note "POST /v1/message:send"
RESP="$(curl -fsS -X POST "${BASE}/v1/message:send" \
  -H 'Content-Type: application/json' \
  -d '{"message":{"role":"user","parts":[{"kind":"text","text":"hello template"}]}}')"
echo "${RESP}" | python3 -c "
import sys, json
t = json.load(sys.stdin)
assert t['kind'] == 'task', 'not a task envelope'
assert t['status']['state'] == 'completed', 'task not completed'
data = t['artifacts'][0]['parts'][0]['data']
assert data['echo_text'] == 'hello template', 'echo mismatch'
print('  task id:', t['id'])
print('  state:  ', t['status']['state'])
print('  echo:   ', data['echo_text'])
" && ok "message:send returns a completed task with the echoed result" || bad "message:send envelope wrong"

# --- 4. client example -----------------------------------------------------
note "examples/client.py end-to-end"
python3 "${HERE}/examples/client.py" "${BASE}" "verify-script client call" \
  && ok "client discovered + invoked the agent" || bad "client example failed"

# --- summary ---------------------------------------------------------------
note "summary"
printf '  %d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ] || exit 1
echo "  A2A-only template verified end to end."
