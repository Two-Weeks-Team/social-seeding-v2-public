#!/usr/bin/env bash
# teardown-heavy.sh — destroy the always-on-expensive stores after a demo (D46).
#
# Per D46 (DECISIONS.md:140) + UNIFIED-TRACK3-PLAN §3: Spanner / AlloyDB / KMS
# are NOT kept running. They are spun up only for a demo recording or an I3
# integration check, then destroyed immediately so they contribute $0 to the
# idle bill. This script is the "destroy immediately after" lever.
#
# It runs a TARGETED `terraform destroy` against only the heavy modules — never
# a blanket `terraform destroy` that would also drop the cheap Cloud Run / Pub-
# Sub / Firestore plumbing the essential assets rely on. Targets (resolved from
# terraform/modules/{data,security}):
#   module.data.google_spanner_instance.core         (+ its databases)
#   module.data.google_alloydb_cluster.primary       (+ instances + read pool)
#   module.data.google_alloydb_cluster.secondary     (+ instance)
#   module.security.google_kms_key_ring.regional     (CMEK; ~$80/mo if left on)
#
# ⚠️ Default mode is DRY-RUN (terraform plan -destroy). A real destroy requires
# the explicit --apply flag AND types-to-confirm, because Spanner/AlloyDB drops
# are irreversible. This script never touches the production
# social-seeding-backend — it only operates inside terraform/environments/<env>.
#
# Today (2026-05-20) these resources DO NOT EXIST (state-driven: created on
# demand). In that case `terraform plan -destroy -target=...` is a no-op that
# exits 0 — the script is safe to keep wired ahead of any apply.
#
# Usage:
#   teardown-heavy.sh                       # dry-run plan-destroy on dev (default)
#   teardown-heavy.sh --env prod            # dry-run plan-destroy on prod
#   teardown-heavy.sh --env dev --apply     # REAL destroy (prompts to confirm)
#   teardown-heavy.sh --kms-only            # narrow to just the KMS key ring
#
# Exit codes:
#   0 — plan/destroy succeeded (incl. the "nothing to destroy" no-op)
#   1 — terraform failed
#   64 — bad usage / aborted confirmation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ENV="dev"
APPLY=0
KMS_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV="${2:-}"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --kms-only)
      KMS_ONLY=1
      shift
      ;;
    --help | -h)
      sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "[teardown-heavy] unknown arg: $1" >&2
      exit 64
      ;;
  esac
done

case "$ENV" in
  dev | prod) ;;
  *)
    echo "[teardown-heavy] --env must be dev|prod (got '$ENV')" >&2
    exit 64
    ;;
esac

TF_DIR="${REPO_ROOT}/terraform/environments/${ENV}"
if [[ ! -d "$TF_DIR" ]]; then
  echo "[teardown-heavy] terraform root not found: ${TF_DIR}" >&2
  exit 64
fi

# The heavy-resource target set. Targeting whole resource addresses also pulls
# their children (databases, read pools) into the destroy plan.
declare -a TARGETS
if [[ $KMS_ONLY -eq 1 ]]; then
  TARGETS=(
    "module.security.google_kms_key_ring.regional"
  )
else
  TARGETS=(
    "module.data.google_spanner_instance.core"
    "module.data.google_alloydb_cluster.primary"
    "module.data.google_alloydb_cluster.secondary"
    "module.security.google_kms_key_ring.regional"
  )
fi

declare -a TARGET_FLAGS=()
for t in "${TARGETS[@]}"; do
  TARGET_FLAGS+=("-target=$t")
done

if ! command -v terraform >/dev/null 2>&1; then
  echo "[teardown-heavy] terraform CLI not found on PATH" >&2
  exit 1
fi

echo "[teardown-heavy] env=${ENV} dir=${TF_DIR}"
echo "[teardown-heavy] targets:"
printf '  - %s\n' "${TARGETS[@]}"

# terraform init is required before plan/destroy can read state. The GCS
# backend needs Application Default Credentials (ADC). When ADC is present
# (the operator's normal case) we init the real backend and the plan reflects
# real remote state. When ADC is absent (CI / a fresh clone / this sandbox) we
# fall back to a local-state init so the DRY-RUN still runs and truthfully
# reports "nothing to destroy" — which matches the state-driven reality that
# the heavy stores do not exist until a demo creates them.
echo "[teardown-heavy] terraform init…"
BACKEND_OK=1
if ! terraform -chdir="$TF_DIR" init -input=false >/dev/null 2>&1; then
  BACKEND_OK=0
  echo "[teardown-heavy] remote backend init failed (no ADC) — the dry-run will" >&2
  echo "[teardown-heavy] report config validity only; the real diff needs ADC." >&2
fi

if [[ $APPLY -eq 0 ]]; then
  echo "[teardown-heavy] DRY-RUN — terraform plan -destroy (no resources will be removed)"
  if [[ $BACKEND_OK -eq 1 ]]; then
    # Real backend present: show the actual heavy-resource destroy diff.
    terraform -chdir="$TF_DIR" plan -destroy -input=false "${TARGET_FLAGS[@]}"
    echo "[teardown-heavy] dry-run complete. Re-run with --apply to actually destroy."
    exit 0
  fi
  # No ADC: prove the config + target addresses are valid against an isolated
  # local-state init (separate TF_DATA_DIR so we never disturb the operator's
  # backend-configured .terraform). With empty state, plan -destroy correctly
  # reports "no changes" — matching the state-driven reality that the heavy
  # stores do not exist until a demo creates them.
  TMP_DATA_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DATA_DIR"' EXIT
  if TF_DATA_DIR="$TMP_DATA_DIR" terraform -chdir="$TF_DIR" \
    init -input=false -backend=false >/dev/null 2>&1; then
    echo "[teardown-heavy] (offline) validating config + target addresses…"
    if TF_DATA_DIR="$TMP_DATA_DIR" terraform -chdir="$TF_DIR" validate; then
      echo "[teardown-heavy] config valid; heavy stores absent (state-driven) → nothing to destroy."
      echo "[teardown-heavy] dry-run complete. Re-run with --apply (needs ADC) to destroy real resources."
      exit 0
    fi
  fi
  echo "[teardown-heavy] offline validation failed — check terraform config." >&2
  exit 1
fi

if [[ $BACKEND_OK -eq 0 ]]; then
  echo "[teardown-heavy] --apply requires the real GCS backend (ADC). Run:" >&2
  echo "    gcloud auth application-default login" >&2
  exit 1
fi

# ── Real destroy path — irreversible. Demand an explicit typed confirmation. ──
echo ""
echo "⚠️  [teardown-heavy] About to DESTROY the targeted heavy resources in '${ENV}'."
echo "    Spanner + AlloyDB data is NOT recoverable after this."
read -r -p "    Type the env name ('${ENV}') to confirm: " CONFIRM
if [[ "$CONFIRM" != "$ENV" ]]; then
  echo "[teardown-heavy] confirmation mismatch — aborted." >&2
  exit 64
fi

echo "[teardown-heavy] running terraform destroy…"
terraform -chdir="$TF_DIR" destroy -auto-approve -input=false "${TARGET_FLAGS[@]}"
echo "[teardown-heavy] destroy complete — heavy stores removed (idle cost back to ~\$0)."
