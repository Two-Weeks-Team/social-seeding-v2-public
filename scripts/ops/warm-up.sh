#!/usr/bin/env bash
# warm-up.sh — Cloud Scheduler keep-alive cron for the judging window (D46).
#
# Per D46 + UNIFIED-TRACK3-PLAN §3: during the judging window
# (2026-06-05 → 2026-06-20) a top-of-the-hour HTTP GET to each essential
# service defeats Cloud Run cold-start, giving judges a min=1-like latency
# without paying for a pinned instance the rest of the month. Outside the
# window the jobs stay PAUSED, so idle cost stays at ~$0 (services scale to
# zero between pings).
#
# Why ping instead of --min-instances=1? A pinned instance bills 24×7 for
# ~6 weeks even when nobody is looking. An hourly ping warms the instance just
# before judging traffic and lets it scale back to zero in between — the same
# latency benefit at a fraction of the cost, and it self-disables outside the
# window. This is the literal "state-driven" lever D46 calls for.
#
# The cron lives in ss-shared-infra (SS_SCHEDULER_PROJECT) per the I4 brief.
# All three target services allow unauthenticated invocation (allUsers
# run.invoker), so the ping needs no OIDC token — a bare GET suffices. The
# warm-up path per service is container-reaching ("/" or "/api/healthz");
# Cloud Run's edge reserves the literal "/healthz" and 404s it before the
# container (see gcp-research/refactor-mcp/DEPLOY-STATUS.md), so we never use it.
#
# Usage:
#   warm-up.sh create            # create the 3 jobs, PAUSED (default; safe now)
#   warm-up.sh create --active   # create + resume (only during the window)
#   warm-up.sh pause             # pause all warm-up jobs (back to ~$0 idle)
#   warm-up.sh resume            # resume all warm-up jobs (judging starts)
#   warm-up.sh delete            # delete all warm-up jobs (after judging)
#   warm-up.sh status            # list warm-up jobs + state
#   warm-up.sh <verb> --dry-run  # print gcloud calls, change nothing
#
# Exit codes:
#   0 — success
#   1 — a gcloud call failed
#   64 — bad usage
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ops/_services.sh
source "${SCRIPT_DIR}/_services.sh"

# Every warm-up job id is prefixed so `status`/`pause`/`resume`/`delete` can
# select exactly our jobs and never touch an unrelated scheduler job.
JOB_PREFIX="ss-warmup-"
SCHEDULE="0 * * * *" # top of every hour
TIME_ZONE="Etc/UTC"

VERB="${1:-status}"
shift || true

DRY_RUN=0
ACTIVE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --active) ACTIVE=1 ;;
    --help | -h)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "[warm-up] unknown arg: $arg" >&2
      exit 64
      ;;
  esac
done

run() {
  # run <cmd...> — execute or (in dry-run) print. Returns the command's rc.
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    DRY: $*"
    return 0
  fi
  "$@"
}

job_name_for() { echo "${JOB_PREFIX}$1"; }

create_jobs() {
  echo "[warm-up] creating ${#SS_SERVICES[@]} keep-alive job(s) in ${SS_SCHEDULER_PROJECT}/${SS_SCHEDULER_LOCATION}"
  echo "[warm-up] window ${SS_WARMUP_WINDOW_START} → ${SS_WARMUP_WINDOW_END}; created $([[ $ACTIVE -eq 1 ]] && echo ACTIVE || echo PAUSED)"
  local rc=0
  for row in "${SS_SERVICES[@]}"; do
    read -r svc proj region path <<<"$(ss_split_row "$row")"
    local url
    url=$(ss_service_url "$svc" "$proj" "$region")
    if [[ -z "$url" ]]; then
      echo "  ✗ ${svc}: could not resolve Cloud Run URL — skipping" >&2
      rc=1
      continue
    fi
    local job
    job=$(job_name_for "$svc")
    local uri="${url}${path}"
    echo "  → ${job}  GET ${uri}  (@ '${SCHEDULE}')"

    # Idempotent create: if it already exists, fall through to an update.
    if gcloud scheduler jobs describe "$job" \
      --location="$SS_SCHEDULER_LOCATION" --project="$SS_SCHEDULER_PROJECT" \
      >/dev/null 2>&1; then
      run gcloud scheduler jobs update http "$job" \
        --location="$SS_SCHEDULER_LOCATION" --project="$SS_SCHEDULER_PROJECT" \
        --schedule="$SCHEDULE" --time-zone="$TIME_ZONE" \
        --uri="$uri" --http-method=GET \
        --description="D46 judging-window keep-alive for ${svc}" \
        --quiet || rc=1
    else
      run gcloud scheduler jobs create http "$job" \
        --location="$SS_SCHEDULER_LOCATION" --project="$SS_SCHEDULER_PROJECT" \
        --schedule="$SCHEDULE" --time-zone="$TIME_ZONE" \
        --uri="$uri" --http-method=GET \
        --description="D46 judging-window keep-alive for ${svc}" \
        --quiet || rc=1
    fi

    # gcloud creates scheduler jobs ENABLED. Unless --active was passed we
    # immediately pause so creating the cron today (before the window) costs
    # nothing and triggers no premature pings.
    if [[ $ACTIVE -eq 0 ]]; then
      run gcloud scheduler jobs pause "$job" \
        --location="$SS_SCHEDULER_LOCATION" --project="$SS_SCHEDULER_PROJECT" \
        --quiet || rc=1
    fi
  done
  return $rc
}

# for_each_job <gcloud-verb...> — apply a scheduler verb to every warm-up job.
for_each_job() {
  local rc=0
  for row in "${SS_SERVICES[@]}"; do
    read -r svc _proj _region _path <<<"$(ss_split_row "$row")"
    local job
    job=$(job_name_for "$svc")
    echo "  → ${job}: $1"
    run gcloud scheduler jobs "$1" "$job" \
      --location="$SS_SCHEDULER_LOCATION" --project="$SS_SCHEDULER_PROJECT" \
      --quiet || rc=1
  done
  return $rc
}

case "$VERB" in
  create) create_jobs ;;
  pause)
    echo "[warm-up] pausing warm-up jobs (idle cost back to ~\$0)"
    for_each_job pause
    ;;
  resume)
    echo "[warm-up] resuming warm-up jobs (judging window active)"
    for_each_job resume
    ;;
  delete)
    echo "[warm-up] deleting warm-up jobs"
    for_each_job delete
    ;;
  status)
    echo "[warm-up] jobs in ${SS_SCHEDULER_PROJECT}/${SS_SCHEDULER_LOCATION} matching '${JOB_PREFIX}*':"
    gcloud scheduler jobs list \
      --location="$SS_SCHEDULER_LOCATION" --project="$SS_SCHEDULER_PROJECT" \
      --filter="name~${JOB_PREFIX}" \
      --format='table(name.basename(), schedule, state)' 2>/dev/null \
      || echo "  (none / scheduler API unavailable)"
    ;;
  *)
    echo "[warm-up] usage: warm-up.sh {create|pause|resume|delete|status} [--active|--dry-run]" >&2
    exit 64
    ;;
esac
