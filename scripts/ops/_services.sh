#!/usr/bin/env bash
# _services.sh — single source of truth for the D46 essential-asset inventory.
#
# Sourced by scale-down.sh / warm-up.sh. NOT executable on its own.
#
# Per D46 (DECISIONS.md:140) "Essential-asset retention + state-driven
# auto-scale": exactly three Cloud Run services stay reachable through the
# judging window. Everything heavier (Spanner/AlloyDB/KMS) is created on
# demand and torn down by teardown-heavy.sh.
#
# ⚠️ SAFETY (CLAUDE.md hard rail): the production social-seeding-backend
# (port 8080, project social-seeding) is NOT in this list and MUST NEVER be.
# These ops scripts only ever touch the three SS-v2 challenge services below.
#
# Each row: "<service>:<project>:<region>:<warmup_path>"
#   warmup_path is the container-reaching URL a keep-alive ping hits.
#   NOTE: Cloud Run's HTTP edge RESERVES the literal "/healthz" path and
#   404s it before the container sees it (proven in
#   gcp-research/refactor-mcp/DEPLOY-STATUS.md). So we ping container-reaching
#   paths: "/" for the landing + mcp roots, "/api/healthz" for the Next.js
#   Mission Control (its own route, not the reserved bare /healthz).

# Guard against direct execution — this file only provides data + helpers.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "[_services] this file is meant to be sourced, not run directly" >&2
  exit 64
fi

# The canonical inventory. Order is stable so output is deterministic.
SS_SERVICES=(
  "ss-landing:ss-shared-infra:us-central1:/"
  "ss-v2-web:ss-v2-prod:us-central1:/api/healthz"
  "ss-mcp-server:ss-mcp-prod:us-central1:/"
)

# Project that hosts the Cloud Scheduler warm-up cron (per I4 brief: cron lives
# in ss-shared-infra). Scheduler is a regional resource; us-central1 colocates
# with every service to minimise cross-region ping latency.
SS_SCHEDULER_PROJECT="ss-shared-infra"
SS_SCHEDULER_LOCATION="us-central1"

# Judging warm-up window (per D46 + UNIFIED-TRACK3-PLAN §3). Outside this
# window the cron stays PAUSED so idle cost stays at ~$0 (min=0 scale-to-zero).
SS_WARMUP_WINDOW_START="2026-06-05"
SS_WARMUP_WINDOW_END="2026-06-20"

# ── helpers ─────────────────────────────────────────────────────────────────

# ss_split_row <row> — echo "svc proj region path" (space-separated) from a
# colon-delimited inventory row. Used by callers that want positional fields.
ss_split_row() {
  local row="$1"
  local IFS=':'
  # shellcheck disable=SC2206  # intentional word-split on the IFS we set
  local parts=($row)
  printf '%s %s %s %s\n' "${parts[0]}" "${parts[1]}" "${parts[2]}" "${parts[3]}"
}

# ss_service_url <service> <project> <region> — resolve the live Cloud Run URL.
# Returns empty string (and non-zero) if the service is not found.
ss_service_url() {
  local svc="$1" proj="$2" region="$3"
  gcloud run services describe "$svc" \
    --region="$region" --project="$proj" \
    --format='value(status.url)' 2>/dev/null
}

# ss_service_min_scale <service> <project> <region> — echo the current minScale
# annotation, or "0" when unset (the Cloud Run scale-to-zero default).
ss_service_min_scale() {
  local svc="$1" proj="$2" region="$3"
  local v
  v=$(gcloud run services describe "$svc" \
    --region="$region" --project="$proj" \
    --format='value(spec.template.metadata.annotations."autoscaling.knative.dev/minScale")' \
    2>/dev/null)
  echo "${v:-0}"
}
