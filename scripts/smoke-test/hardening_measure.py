#!/usr/bin/env python3
"""hardening_measure.py — H2/H3/H4 measurement driver (offline, deterministic).

Runs the conversation_responder triage "hardening" measurement and:
  1. prints the before → after triage pass-rate to stdout (the proof),
  2. (re)writes the committed artifacts:
       scripts/demo/assets/hardening-before-after.json        (H4 metrics)
       scripts/demo/assets/observability-trace-stalled.json    (H3, baseline)
       scripts/demo/assets/observability-trace-repaired.json   (H3, optimized)

No LLM, no GCP, no billing. Pure functions over
test-harness/hardening/synthetic_cases.json. Re-run via
scripts/smoke-test/run-hardening-measure.sh.

Exit codes:
  0 — measured + artifacts written; after ≥ before (hardening did not regress).
  4 — environment / import error.
  5 — measurement regressed (after < before) — the harness caught a bad change.

Citations: GRAND-NARRATIVE-PLAN §5-1 (H1-H4); D23/D25/D32/D5.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parents[1]
_ASSETS_DIR = _REPO_ROOT / "scripts" / "demo" / "assets"

# Make ss_agents importable when run via the venv python (the wrapper sets the
# interpreter); add the package src to path defensively for direct invocation.
_PKG_SRC = _REPO_ROOT / "packages" / "agents-adk" / "src"
if str(_PKG_SRC) not in sys.path:
    sys.path.insert(0, str(_PKG_SRC))


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main() -> int:
    try:
        from ss_agents.hardening.optimizer_pass import (
            build_trace_artifacts,
            run_optimizer_pass,
        )
    except ImportError as exc:  # pragma: no cover — env error
        print(f"[hardening] import error: {exc}", file=sys.stderr)
        print(
            "[hardening] run via scripts/smoke-test/run-hardening-measure.sh "
            "or `uv run` inside packages/agents-adk.",
            file=sys.stderr,
        )
        return 4

    metrics = run_optimizer_pass()
    traces = build_trace_artifacts()

    _write_json(_ASSETS_DIR / "hardening-before-after.json", metrics)
    _write_json(_ASSETS_DIR / "observability-trace-stalled.json", traces["stalled"])
    _write_json(_ASSETS_DIR / "observability-trace-repaired.json", traces["repaired"])

    before = metrics["before"]
    after = metrics["after"]

    print("=" * 68)
    print(" H2/H3/H4 — conversation_responder triage hardening (offline)")
    print("=" * 68)
    print(f"  synthetic cases : {before['total']}")
    print(f"  stall case      : {metrics['stall_case_id']}")
    print(f"  target metric   : {metrics['_meta']['target_metric']}")
    print("-" * 68)
    print(
        f"  BEFORE (baseline triage)  : "
        f"{before['passed']}/{before['total']} = {before['pass_rate_pct']}%"
    )
    print(f"    failed cases: {before['failed_case_ids']}")
    print(
        f"  AFTER  (optimized triage) : "
        f"{after['passed']}/{after['total']} = {after['pass_rate_pct']}%"
    )
    print(f"    failed cases: {after['failed_case_ids']}")
    print("-" * 68)
    print(f"  RESULT          : {metrics['headline']}  (+{metrics['delta_pp']} pp)")
    print(f"  fix rule        : {metrics['triage_fix_rule']}")
    print("-" * 68)
    lo = metrics["live_optimizer"]
    print(
        f"  live optimizer  : CAPABILITY_LAYER_MODE={lo['capability_layer_mode']} "
        f"→ receipt {lo['queued_receipt']}"
    )
    print(
        "  honest scope    : before/after = LOCAL deterministic pass over the "
        "synthetic set;"
    )
    print(
        "                    live Vertex AI Agent Optimizer is the production "
        "path (stubbed today, W7-deferred = NotImplementedError)."
    )
    print("-" * 68)
    print("  artifacts written:")
    for name in (
        "hardening-before-after.json",
        "observability-trace-stalled.json",
        "observability-trace-repaired.json",
    ):
        print(f"    scripts/demo/assets/{name}")
    print("=" * 68)

    if after["pass_rate"] < before["pass_rate"]:
        print(
            "[hardening] REGRESSION: after < before — a change broke the "
            "optimized triage.",
            file=sys.stderr,
        )
        return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
