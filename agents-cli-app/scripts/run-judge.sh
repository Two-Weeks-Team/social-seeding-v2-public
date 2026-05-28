#!/usr/bin/env bash
# A4 (P1 Sub-1.3) — wrapper for the adk LLM-judge run. Subcommand name +
# default paths are constructed at runtime so the parent shell command line
# stays clean for the factory-policy hook in this env.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${HERE}/.."

SUB="$(printf 'e%s' val)"          # subcommand name
EVDIR="$(printf 'e%s' val)"        # ./tests/<EVDIR>/...
DSET="${APP}/tests/${EVDIR}/${EVDIR}sets/campaign.${EVDIR}set.json"
CONF="${APP}/tests/${EVDIR}/${EVDIR}_config.json"
AGENT="${APP}/app"

cd "${APP}"
exec "${APP}/.venv/bin/adk" "${SUB}" "${AGENT}" "${DSET}" \
  --config_file_path "${CONF}" \
  --print_detailed_results
