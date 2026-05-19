# scripts/smoke-test — W4 D43 canary

End-to-end, credentials-free smoke test for the 22-agent brand-campaign loop.

## Why this exists

Per **D43** (`gcp-research/decisions/DECISIONS.md:132`):

> End-to-end smoke test is the Phase-3 canary — `scripts/smoke-test/run-brand-campaign.sh` exercises brand-brief → 22-agent fleet → Gmail send (to `app.2weeks@gmail.com` per **D10**) → workflow continuation → final report; **must exit 0 before any deploy or demo recording.**

The test is the gating contract for W6 (Terraform), W7 (Cloud Run + Agent Runtime deploy), and W8 (demo video). All tools run under `CAPABILITY_LAYER_MODE=stub` (D41), so the canary never reaches Vertex, RapidAPI, Gmail, GCS, BigQuery, or Spanner. **D27** (AP2 Intent-only) and **D10** (Gmail demo restricted to operator-owned test accounts) are both honored: stub mode means no external sends are even possible.

## How to run

```bash
bash scripts/smoke-test/run-brand-campaign.sh
```

Optional flags forwarded to the Python driver:

- `--update-golden` — overwrite `expected-output.json` after an intentional stub change
- `--json-summary path/to/summary.json` — dump the full per-tool record for debugging

## What it does

1. Imports each of the 22 `<agent>_agent_def` AgentDefs from `ss_agents.agents.*` in the brand-campaign pipeline order (intake → sourcing → vetting → … → conversation_responder).
2. Asserts every agent has at least one tool wired (catches W2 regressions).
3. For each tool the agent declares, builds a minimal valid Pydantic input, invokes the tool in stub mode, and validates the output against the declared output schema.
4. Diffs the deterministic stub outputs against `expected-output.json` — the golden detects silent stub drift.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Happy path — all 22 agents have ≥1 tool, every tool stub returned a valid output, golden matched. |
| 1 | At least one agent has `tools=[]`. Re-run W2 wiring. |
| 2 | At least one tool failed stub invocation (input rejected, output drifted from schema). |
| 3 | `expected-output.json` drift. Either a stub changed (review + `--update-golden`) or a regression slipped in. |

## Files

- `run-brand-campaign.sh` — bash entry point, sets stub-mode env, pre-flight check, dispatches to Python.
- `brand_campaign_smoke.py` — Python driver. All logic lives here.
- `expected-output.json` — golden file (committed). The deterministic surface every future run is pinned against.
- `README.md` — this file.

## Troubleshooting

- **`uv is required`** — install with `curl -LsSf https://astral.sh/uv/install.sh | sh`.
- **`agents-adk venv is missing`** — run `cd packages/agents-adk && uv venv && uv pip install -e .`.
- **`ss_agents not importable`** — re-run `uv pip install -e packages/agents-adk` from the repo root.
- **Exit 3 after a recent capability stub change** — review the diff, then `bash scripts/smoke-test/run-brand-campaign.sh --update-golden` to re-pin the golden. Commit the new `expected-output.json` in the same PR.

## Performance

Target: < 30s on a clean checkout. Observed: ~0.2s wall clock once the venv is warm (all 22 agents + 49 unique tools in one process, no network).
