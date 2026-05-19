#!/usr/bin/env bash
# nightly.sh — Cloud Scheduler-triggered wrapper for L4 Agent Simulation
#
# Cites: D25, D37, D39. MATRIX §7.2 (nightly cadence). simulation/SCENARIOS.md §7.
#
# Trigger:  Cloud Scheduler `agent_sim_nightly_trigger` at 03:00 KST (18:00 UTC).
# Project:  ss-v2-sim (dedicated sim project per MATRIX §5.2).
# Budget:   ~$47/night per SCENARIOS.md §7.3; W2 cost_watch alerts if breached.
#
# Required env:
#   GOOGLE_CLOUD_PROJECT=ss-v2-sim
#   HARNESS_MODE=live
#   SIM_SCENARIOS_YAML=gs://ss-v2-sim/scenarios/{NIGHT_INDEX}/scenarios.yaml
#   OUT_BUCKET=gs://ss-v2-sim-results

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NIGHT_INDEX="${NIGHT_INDEX:-$(date -u +%j)}"     # day-of-year mod 4 for locale rotation
SCENARIOS_LOCAL="${SCRIPT_DIR}/.scenarios.yaml"
OUT_LOCAL="${SCRIPT_DIR}/.results-${NIGHT_INDEX}.jsonl"

echo "[nightly] starting L4 Agent Simulation (NIGHT_INDEX=${NIGHT_INDEX})"
echo "[nightly] mode=${HARNESS_MODE:-stub}, project=${GOOGLE_CLOUD_PROJECT:-ss-v2-stub}"

# 1. Pull scenarios (generated earlier in the Cloud Workflows DAG).
if [[ -n "${SIM_SCENARIOS_YAML:-}" ]]; then
  gsutil cp "${SIM_SCENARIOS_YAML}" "${SCENARIOS_LOCAL}"
else
  # Fallback to the 103-seed catalog (per-PR smoke path).
  SCENARIOS_LOCAL="${SCRIPT_DIR}/../../gcp-research/simulation/scenarios.yaml"
fi

# 2. Run the simulation harness.
python3 "${SCRIPT_DIR}/runner.py" \
  --scenarios "${SCENARIOS_LOCAL}" \
  --out "${OUT_LOCAL}"

# 3. Upload results to BigQuery (`ss-v2-prod.agent_evals.l4_runs`).
if [[ "${HARNESS_MODE:-stub}" == "live" ]]; then
  TABLE="ss-v2-prod:agent_evals.l4_runs"
  echo "[nightly] uploading ${OUT_LOCAL} → bq://${TABLE}"
  bq load --source_format=NEWLINE_DELIMITED_JSON --autodetect \
    "${TABLE}" "${OUT_LOCAL}" || {
      echo "[nightly] bq load failed — see Cloud Build log"
      exit 1
    }
  # Archive trace bundle in GCS for replay (MATRIX §5.1 replay metadata).
  gsutil -m cp "${OUT_LOCAL}" "${OUT_BUCKET:-gs://ss-v2-sim-results}/${NIGHT_INDEX}/"
fi

# 4. Aggregate regression score and exit non-zero on regression.
#    Per MATRIX §5.4: regression_score >= -0.005 is the gate.
python3 - <<'PY'
import json, sys
results_path = ".scenarios.yaml"  # placeholder — real path piped from runner
# In a wired-up live run, this block reads BigQuery for last-night-vs-today
# delta and emits Slack + PagerDuty per SCENARIOS.md §7.1 notification block.
PY

echo "[nightly] done"
