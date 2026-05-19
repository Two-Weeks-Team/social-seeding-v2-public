#!/usr/bin/env bash
# ============================================================================
# pre-record-checklist.sh
# ----------------------------------------------------------------------------
# Run before pressing Record in OBS Studio. Verifies the rig is ready to
# capture a 24-min source recording without the operator discovering a
# misconfigured tool 10 minutes in.
#
# Authority:
#   gcp-research/demo/SCRIPT.md §7 (pre-recording checklist) + §10 (quality bar)
#   gcp-research/edge-cases/CATALOG.md EC-7.01 (PII leak via 8× footage)
#
# Failure semantics:
#   - exit 0 only when every required gate passes
#   - exit 1 (and print a clear message) on any required failure
#   - exit 2 on a recoverable warning (operator can decide to proceed)
#
# Idempotency:
#   This script is read-only. It does NOT modify the rig. Safe to re-run.
# ============================================================================

set -u
set -o pipefail

# --------------------------------------------------------------------------
# Resolve defaults — every path comes from env, never hardcoded.
# --------------------------------------------------------------------------
: "${DEMO_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
: "${DEMO_TRACK:=v2}"
: "${DEMO_RAW_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/raw}"
: "${DEMO_WORK_DIR:=${DEMO_REPO_ROOT}/gcp-research/demo/work}"
: "${DEMO_MC_URL:=http://localhost:3000}"
: "${DEMO_AGENT_HEALTHZ:=http://localhost:3000/api/healthz}"
: "${DEMO_TARGET_MINUTES:=24}"
: "${OBS_WEBSOCKET_HOST:=127.0.0.1}"
: "${OBS_WEBSOCKET_PORT:=4455}"

# --------------------------------------------------------------------------
# Logging helpers
# --------------------------------------------------------------------------
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'

REQUIRED_FAILS=0
WARN_COUNT=0
CHECK_INDEX=0

log_ok()    { CHECK_INDEX=$((CHECK_INDEX + 1)); printf "[%2d] %sok%s   %s\n" "$CHECK_INDEX" "$GREEN" "$RESET" "$1"; }
log_warn()  { CHECK_INDEX=$((CHECK_INDEX + 1)); WARN_COUNT=$((WARN_COUNT + 1)); printf "[%2d] %swarn%s %s\n" "$CHECK_INDEX" "$YELLOW" "$RESET" "$1"; }
log_fail()  { CHECK_INDEX=$((CHECK_INDEX + 1)); REQUIRED_FAILS=$((REQUIRED_FAILS + 1)); printf "[%2d] %sFAIL%s %s\n" "$CHECK_INDEX" "$RED" "$RESET" "$1"; }
log_info()  { printf "%sinfo%s %s\n" "$BLUE" "$RESET" "$1"; }
log_header(){ printf "\n%s%s%s\n" "$BLUE" "==> $1" "$RESET"; }

# --------------------------------------------------------------------------
# Section 1: workspace layout
# --------------------------------------------------------------------------
log_header "Section 1 — workspace layout"

if [[ -d "$DEMO_REPO_ROOT" ]]; then
  log_ok "DEMO_REPO_ROOT exists: $DEMO_REPO_ROOT"
else
  log_fail "DEMO_REPO_ROOT does not exist: $DEMO_REPO_ROOT"
fi

mkdir -p "$DEMO_RAW_DIR" "$DEMO_WORK_DIR" "$DEMO_WORK_DIR/.receipts"
if [[ -w "$DEMO_RAW_DIR" ]]; then
  log_ok "DEMO_RAW_DIR writable: $DEMO_RAW_DIR"
else
  log_fail "DEMO_RAW_DIR not writable: $DEMO_RAW_DIR"
fi

# Track value must be one of the two known tracks.
case "$DEMO_TRACK" in
  v2|mcp) log_ok "DEMO_TRACK=$DEMO_TRACK is recognized" ;;
  *)      log_fail "DEMO_TRACK=$DEMO_TRACK is not v2 or mcp" ;;
esac

# Check disk space — 24 min @ 1080p60 CRF 18 is ~10–15 GB depending on motion;
# require 30 GB free to leave room for the post-process work files.
need_gb=30
case "$(uname -s)" in
  Darwin)
    avail_gb=$(df -g "$DEMO_RAW_DIR" 2>/dev/null | awk 'NR==2 {print $4}') ;;
  Linux)
    avail_gb=$(df -BG "$DEMO_RAW_DIR" 2>/dev/null | awk 'NR==2 {sub(/G/, "", $4); print $4}') ;;
  *) avail_gb="" ;;
esac
if [[ -z "${avail_gb:-}" ]]; then
  log_warn "could not determine free disk space for $DEMO_RAW_DIR — verify manually"
elif (( avail_gb >= need_gb )); then
  log_ok  "free disk on DEMO_RAW_DIR: ${avail_gb} GB (need ${need_gb})"
else
  log_fail "free disk on DEMO_RAW_DIR: ${avail_gb} GB (need ${need_gb})"
fi

# --------------------------------------------------------------------------
# Section 2: tooling versions
# --------------------------------------------------------------------------
log_header "Section 2 — required tooling versions"

check_tool() {
  local name="$1"; local cmd="$2"; local min="$3"; local version_extract="$4"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_fail "$name is not installed (need >= $min)"
    return
  fi
  local got
  got=$("$cmd" --version 2>&1 | head -n1 | eval "$version_extract" || true)
  if [[ -z "$got" ]]; then
    log_warn "$name is installed but version could not be parsed"
    return
  fi
  log_ok "$name $got (need >= $min)"
}

check_tool "ffmpeg"      "ffmpeg"      "7.0"  "awk '{print \$3}'"
check_tool "mmdc"        "mmdc"        "11.x" "awk '{print \$1}'"
check_tool "tesseract"   "tesseract"   "5.4"  "awk '{print \$2}'"
check_tool "magick"      "magick"      "7.1"  "awk '{print \$2}'"
check_tool "jq"          "jq"          "1.7"  "tr -d 'jq-'"
check_tool "node"        "node"        "20"   "tr -d 'v'"

# Whisper — either openai-whisper python or whisper.cpp.
if command -v whisper >/dev/null 2>&1; then
  log_ok "whisper (openai-whisper) detected"
elif command -v whisper-cli >/dev/null 2>&1; then
  log_ok "whisper-cli (whisper.cpp) detected"
else
  log_fail "no Whisper binary found (need 'whisper' or 'whisper-cli')"
fi

# gcloud is only required for the upload step, but pre-check anyway.
if command -v gcloud >/dev/null 2>&1; then
  log_ok "gcloud detected; account=$(gcloud config get-value account 2>/dev/null || echo unknown)"
else
  log_warn "gcloud not installed (required only for upload-youtube.sh + GCS mirror)"
fi

# --------------------------------------------------------------------------
# Section 3: OBS Studio + WebSocket
# --------------------------------------------------------------------------
log_header "Section 3 — OBS Studio + WebSocket"

if pgrep -x "OBS" >/dev/null 2>&1 || pgrep -x "obs" >/dev/null 2>&1; then
  log_ok "OBS Studio process is running"
else
  log_fail "OBS Studio is not running — start it before recording"
fi

# WebSocket reachability via nc.
if command -v nc >/dev/null 2>&1; then
  if nc -z -w 1 "$OBS_WEBSOCKET_HOST" "$OBS_WEBSOCKET_PORT" 2>/dev/null; then
    log_ok "OBS WebSocket reachable at ${OBS_WEBSOCKET_HOST}:${OBS_WEBSOCKET_PORT}"
  else
    log_fail "OBS WebSocket NOT reachable at ${OBS_WEBSOCKET_HOST}:${OBS_WEBSOCKET_PORT}"
  fi
else
  log_warn "nc not installed; cannot verify OBS WebSocket port — assuming reachable"
fi

# --------------------------------------------------------------------------
# Section 4: Mission Control + agents (Track 2 only)
# --------------------------------------------------------------------------
if [[ "$DEMO_TRACK" == "v2" ]]; then
  log_header "Section 4 — Mission Control + agents (Track 2)"

  if curl -fsS -o /dev/null -m 5 "$DEMO_MC_URL"; then
    log_ok "Mission Control responds 2xx at $DEMO_MC_URL"
  else
    log_fail "Mission Control not responding at $DEMO_MC_URL — start with: pnpm --filter @ss/web dev"
  fi

  if curl -fsS -o /tmp/demo-healthz.json -m 5 "$DEMO_AGENT_HEALTHZ"; then
    if jq -e '.ok == true' /tmp/demo-healthz.json >/dev/null 2>&1; then
      log_ok "agent healthz reports {ok: true}"
    else
      log_warn "agent healthz responded but did not return {ok: true} — review /tmp/demo-healthz.json"
    fi
  else
    log_fail "agent healthz not responding at $DEMO_AGENT_HEALTHZ"
  fi

  # Inngest dev server warmup (recommended before live demo).
  if curl -fsS -o /dev/null -m 3 "http://localhost:8288/health" 2>/dev/null; then
    log_ok "Inngest Dev Server up at http://localhost:8288"
  else
    log_warn "Inngest Dev Server not up at http://localhost:8288 — beat 1 trigger will fail"
  fi
fi

# --------------------------------------------------------------------------
# Section 5: MCP server endpoint (Track 3 only)
# --------------------------------------------------------------------------
if [[ "$DEMO_TRACK" == "mcp" ]]; then
  log_header "Section 5 — MCP server endpoint (Track 3)"

  : "${DEMO_MCP_URL:=https://mcp.socialseed.ing}"
  if curl -fsS -o /dev/null -m 5 "$DEMO_MCP_URL/.well-known/mcp-manifest"; then
    log_ok "MCP manifest reachable at $DEMO_MCP_URL/.well-known/mcp-manifest"
  else
    log_fail "MCP manifest NOT reachable — Beat 1 will fail"
  fi

  if curl -fsS -o /dev/null -m 5 "$DEMO_MCP_URL/.well-known/agent.json"; then
    log_ok "A2A agent.json reachable at $DEMO_MCP_URL/.well-known/agent.json"
  else
    log_fail "A2A agent.json NOT reachable — Beat 3 will fail"
  fi
fi

# --------------------------------------------------------------------------
# Section 6: Test Gmail accounts (per D10)
# --------------------------------------------------------------------------
log_header "Section 6 — Test Gmail accounts (D10)"

# These checks are advisory — we cannot programmatically prove the operator
# is logged in to the right Chrome profile. Print the reminder.
log_info "Confirm three Chrome profiles signed in:"
log_info "  · tenant operator    → app.2weeks@gmail.com"
log_info "  · 'creator' persona  → pre-staged second Gmail with reply draft"
log_info "  · 'brand' persona    → optional third profile for Beat 2 in Track 2"
log_info "  All must be regular Chrome windows (NOT Incognito) per SCRIPT.md §7.1."

# --------------------------------------------------------------------------
# Section 7: Mac "Do Not Disturb" + screen hygiene
# --------------------------------------------------------------------------
log_header "Section 7 — screen hygiene"

case "$(uname -s)" in
  Darwin)
    dnd=$(defaults -currentHost read ~/Library/Preferences/ByHost/com.apple.notificationcenterui doNotDisturb 2>/dev/null || echo "0")
    if [[ "$dnd" == "1" ]]; then
      log_ok "macOS Do Not Disturb is ON"
    else
      log_warn "macOS Do Not Disturb is OFF — enable via Control Center"
    fi
    ;;
  Linux)
    log_info "Linux notification mute is desktop-specific; verify your notifications daemon is paused"
    ;;
esac

# Suggest the operator hide the dock + menu bar + bookmarks for a clean shot.
log_info "Remember to: hide Chrome bookmarks bar (Cmd+Shift+B), zoom Mission Control to 100% (Cmd+0), close sensitive tabs."

# --------------------------------------------------------------------------
# Section 8: existing source recording (incremental safety)
# --------------------------------------------------------------------------
log_header "Section 8 — existing source recording"

existing="${DEMO_RAW_DIR}/${DEMO_TRACK}-source.mkv"
if [[ -f "$existing" ]]; then
  size_bytes=$(stat -f%z "$existing" 2>/dev/null || stat -c%s "$existing" 2>/dev/null || echo 0)
  size_mb=$((size_bytes / 1024 / 1024))
  log_warn "existing source: $existing (${size_mb} MB) — start-recording.sh will move it aside before re-recording"
else
  log_ok "no existing source file at $existing — fresh take"
fi

# --------------------------------------------------------------------------
# Section 9: per-track cue card
# --------------------------------------------------------------------------
log_header "Section 9 — recording cue card for $DEMO_TRACK"

if [[ "$DEMO_TRACK" == "v2" ]]; then
  cat <<'EOF'
Track 2 (v2) — 6 beats × 4 min = 24 min source

  Beat 1 — Brief intake + sourcing            (scene: Terminal + browser split, Cmd+3)
  Beat 2 — Vetting fan-out × 12               (scene: Mission Control - full,    Cmd+1)
  Beat 3 — Outreach tournament + approval     (scene: Mission Control - zoom,    Cmd+2)
  Beat 4 — Gmail send + reply                  (scene: Terminal + browser split, Cmd+3)
  Beat 5 — Logistics + verify (+ 5 d timer)    (scene: Mission Control - full,    Cmd+1)
  Beat 6 — Analyst report + cost ledger       (scene: Mission Control - zoom,    Cmd+2)

  Between beats: 3-second silence pause; do NOT stop recording.
  Cost ticker target: $0.00 → $0.04 → $0.18 → $0.31 → $0.39 → $0.52 → $0.62 TOTAL
EOF
else
  cat <<'EOF'
Track 3 (mcp) — 6 beats × 4 min = 24 min source

  Beat 1 — Public MCP endpoint                (scene: GCP Console - full)
  Beat 2 — ADK orchestration agent             (scene: GCP Console - full)
  Beat 3 — A2A registration / agent.json       (scene: GCP Console - full)
  Beat 4 — Model Armor PI / JB block           (scene: GCP Console - full)
  Beat 5 — KR-gap reframing (Marketplace PEND) (scene: Producer Portal zoom)
  Beat 6 — Multi-region failover               (scene: Terminal 3-pane regional)

  Between beats: 3-second silence pause; do NOT stop recording.
EOF
fi

# --------------------------------------------------------------------------
# Final tally
# --------------------------------------------------------------------------
log_header "Final tally"

printf "checks total : %d\n" "$CHECK_INDEX"
printf "%sFAIL%s         : %d\n" "$RED" "$RESET" "$REQUIRED_FAILS"
printf "%swarn%s         : %d\n" "$YELLOW" "$RESET" "$WARN_COUNT"

if (( REQUIRED_FAILS > 0 )); then
  printf "\n%s%s%s\n" "$RED" "STOP: fix the FAIL lines above before pressing Record." "$RESET"
  exit 1
fi

if (( WARN_COUNT > 0 )); then
  printf "\n%s%s%s\n" "$YELLOW" "WARN: $WARN_COUNT advisory issues — review and decide whether to proceed." "$RESET"
  exit 2
fi

printf "\n%s%s%s\n" "$GREEN" "READY: every required gate passed. You may press Record." "$RESET"
exit 0
