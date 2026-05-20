#!/usr/bin/env bash
# scale-down.sh — force every essential Cloud Run service to min=0 (D46).
#
# Per D46 (DECISIONS.md:140) idle cost must be ~$0: the three challenge
# services scale to zero when no traffic arrives. This script is the manual
# lever (and the target of the cost_watch "scale_down" runbook) that asserts
# min-instances=0 across the fleet, even if a previous warm-up / debug session
# pinned min=1.
#
# What this does NOT do: it never touches max-instances (capacity headroom is
# free at min=0), never deletes a service, never touches the production
# social-seeding-backend (port 8080) — that service is not in _services.sh and
# must never be.
#
# Usage:
#   scale-down.sh                       # all services in the inventory
#   scale-down.sh ss-landing            # only the named service (any project)
#   scale-down.sh ss-v2-web:ss-v2-prod  # explicit service:project
#   scale-down.sh --dry-run             # print the gcloud calls, change nothing
#
# Exit codes:
#   0 — every targeted service is at (or set to) min=0
#   1 — a gcloud update failed
#   2 — a requested service name was not found in the inventory
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ops/_services.sh
source "${SCRIPT_DIR}/_services.sh"

DRY_RUN=0
declare -a REQUESTED=()

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help | -h)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "[scale-down] unknown flag: $arg" >&2
      exit 64
      ;;
    *) REQUESTED+=("$arg") ;;
  esac
done

# Build the working set: the full inventory, or only rows matching a requested
# "service" or "service:project" argument.
declare -a TARGETS=()
if [[ ${#REQUESTED[@]} -eq 0 ]]; then
  TARGETS=("${SS_SERVICES[@]}")
else
  for req in "${REQUESTED[@]}"; do
    matched=0
    for row in "${SS_SERVICES[@]}"; do
      read -r svc proj _region _path <<<"$(ss_split_row "$row")"
      if [[ "$req" == "$svc" || "$req" == "${svc}:${proj}" ]]; then
        TARGETS+=("$row")
        matched=1
      fi
    done
    if [[ $matched -eq 0 ]]; then
      echo "[scale-down] no inventory match for '$req' (known: ${SS_SERVICES[*]})" >&2
      exit 2
    fi
  done
fi

echo "[scale-down] forcing min-instances=0 on ${#TARGETS[@]} service(s)$([[ $DRY_RUN -eq 1 ]] && echo ' (DRY RUN)')"

rc=0
for row in "${TARGETS[@]}"; do
  read -r svc proj region _path <<<"$(ss_split_row "$row")"
  current=$(ss_service_min_scale "$svc" "$proj" "$region")
  cmd=(gcloud run services update "$svc"
    --region="$region" --project="$proj"
    --min-instances=0 --quiet)

  if [[ "$current" == "0" ]]; then
    echo "  ✓ ${svc} (${proj}) already min=0 — no change"
    continue
  fi

  echo "  → ${svc} (${proj}) min=${current} ⇒ 0"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    DRY: ${cmd[*]}"
    continue
  fi
  if ! "${cmd[@]}" >/dev/null 2>&1; then
    echo "  ✗ ${svc} (${proj}) update FAILED" >&2
    rc=1
  fi
done

if [[ $rc -eq 0 ]]; then
  echo "[scale-down] done — all targeted services at min=0 (idle cost ~\$0)."
else
  echo "[scale-down] completed with errors (rc=$rc)." >&2
fi
exit $rc
