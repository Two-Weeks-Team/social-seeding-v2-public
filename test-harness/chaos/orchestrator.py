#!/usr/bin/env python3
"""orchestrator.py — L5 Chaos engineering driver.

Cites: D13 (active-active), D31 (SLO 99.99/p99<1s/RTO60s/RPO30s), D32 (auto-runbook),
D37 (5-layer TDD).
MATRIX: §6 (chaos layer contract), §7 (CI integration), §8 (coverage).
Source spec: gcp-research/chaos/SCENARIOS.md §3 (24+ failure modes), §4 (toolchain),
§7 (pass/fail gates).

This module orchestrates chaos drills across four execution substrates:

    1. Litmus on GKE Autopilot       (Kubernetes-level fault injection)
    2. Native GCP control plane      (gcloud + Cloud Workflows)
    3. Custom application middleware (e.g. Spanner stale-read injection)
    4. Pub/Sub harness drivers       (message-drop, backlog, DLQ)

Each scenario YAML in `scenarios/` declares its `executor:` field; the
orchestrator routes accordingly.

In HARNESS_MODE=stub (default), no real injection occurs — the orchestrator
runs the validation block against pre-canned recovery payloads. This is
how the CI per-PR L5 stage (MATRIX §7.1 stage 6) stays under 2 minutes.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import yaml


HARNESS_MODE = os.environ.get("HARNESS_MODE", "stub")
PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "ss-v2-chaos-stub")

VALID_EXECUTORS = {"litmus", "native_gcp", "custom_middleware", "pubsub_harness"}
VALID_TIERS = {"edge", "identity", "compute", "data", "event", "model", "vendor", "chaos_canary"}


@dataclass
class ChaosResult:
    """Mirrors the BigQuery `chaos_results` schema in chaos/SCENARIOS.md §4.4."""

    scenario_id: str
    tier: str
    executor: str
    passed: bool
    observed_rto_s: float
    observed_rpo_s: float
    slo_budget_consumed_pct: float
    auto_runbook_fired: bool
    auto_runbook_succeeded: bool
    duration_s: float
    notes: str = ""
    error: str | None = None
    run_id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ChaosOrchestrator:
    """Drives all 25 chaos scenarios per chaos/SCENARIOS.md §3."""

    def __init__(self, *, mode: str = HARNESS_MODE, project_id: str = PROJECT_ID) -> None:
        self.mode = mode
        self.project_id = project_id

    # ---------------------------------------------------------------- public
    def load_scenario(self, path: str | Path) -> dict[str, Any]:
        """Parse a single chaos-*.yaml scenario file."""
        with open(path, "r", encoding="utf-8") as f:
            doc = yaml.safe_load(f)
        self._validate(doc, source=str(path))
        return doc

    def load_scenarios(self, directory: str | Path) -> list[dict[str, Any]]:
        """Load every chaos-*.yaml in `directory/`. Order: alphabetical."""
        directory = Path(directory)
        if not directory.is_dir():
            raise FileNotFoundError(directory)
        out: list[dict[str, Any]] = []
        for f in sorted(directory.glob("*.yaml")):
            out.append(self.load_scenario(f))
        return out

    def run_one(self, scenario: dict[str, Any]) -> ChaosResult:
        """Drive one chaos drill end-to-end."""
        sid = scenario["id"]
        t0 = time.time()
        if self.mode == "stub":
            result = self._stub_run(scenario)
        else:
            result = self._live_run(scenario)
        result.duration_s = time.time() - t0
        return result

    def run_subset(
        self,
        scenarios: list[dict[str, Any]],
        *,
        subset: str = "per_pr",
    ) -> list[ChaosResult]:
        """Run a tagged subset.

        Per chaos/SCENARIOS.md §5:
          subset='per_pr'  — fast 10, ≤ 10 min, gates PR merge
          subset='nightly' — all 25, ≤ 90 min
          subset='canary'  — 4 SLO-direct (chaos/SCENARIOS.md §7.2)
        """
        filtered = [s for s in scenarios if subset in (s.get("tags") or [])]
        return [self.run_one(s) for s in filtered]

    # ---------------------------------------------------------------- stub
    def _stub_run(self, scenario: dict[str, Any]) -> ChaosResult:
        """Pseudo-deterministic stub for CI.

        - `expected_pass` defaults to True (most drills succeed in stub).
        - Pass criteria can be overridden via `stub_override.pass: false`
          to validate failure detection.
        """
        sid = scenario["id"]
        override = scenario.get("stub_override", {})
        passed = override.get("pass", True)
        # Per D31 SLO envelope per scenario; if scenario declares slo, use those.
        rto_target = scenario.get("expected_rto_s", 60.0)
        rpo_target = scenario.get("expected_rpo_s", 30.0)
        observed_rto = rto_target * 0.7 if passed else rto_target * 1.5
        observed_rpo = min(rpo_target * 0.5, 10.0) if passed else rpo_target * 1.2
        runbook = scenario.get("auto_runbook")
        runbook_fired = bool(runbook)
        runbook_succeeded = passed and runbook_fired
        return ChaosResult(
            scenario_id=sid,
            tier=scenario.get("tier", "edge"),
            executor=scenario.get("executor", "litmus"),
            passed=passed,
            observed_rto_s=observed_rto,
            observed_rpo_s=observed_rpo,
            slo_budget_consumed_pct=2.5 if passed else 12.0,
            auto_runbook_fired=runbook_fired,
            auto_runbook_succeeded=runbook_succeeded,
            duration_s=0.0,  # filled by run_one
            notes=f"stub({sid})",
        )

    # ---------------------------------------------------------------- live
    def _live_run(self, scenario: dict[str, Any]) -> ChaosResult:
        """Real injection. Defensive imports; raises if libs missing.

        The actual injection logic is large and per-executor. We sketch the
        contract here; the production implementation lives behind the
        executor-specific drivers documented in chaos/SCENARIOS.md §4.1-§4.4.
        """
        sid = scenario["id"]
        executor = scenario.get("executor")
        if executor not in VALID_EXECUTORS:
            raise ValueError(
                f"scenario {sid}: executor {executor!r} not in "
                f"{sorted(VALID_EXECUTORS)} (chaos/SCENARIOS.md §4)."
            )
        # Real implementation hooks (sketched per chaos/SCENARIOS.md §4):
        #   if executor == "litmus":          self._run_litmus(scenario)
        #   elif executor == "native_gcp":    self._run_native(scenario)
        #   elif executor == "custom_middleware": self._run_custom(scenario)
        #   elif executor == "pubsub_harness":self._run_pubsub(scenario)
        # Each writes a row to BigQuery chaos_results and emits a Pub/Sub
        # `chaos.scenario.completed` event (chaos/SCENARIOS.md §4.4).
        raise NotImplementedError(
            f"live chaos injection not implemented; scenario={sid}. "
            "See chaos/SCENARIOS.md §9 C1-C5 for the open work."
        )

    # ---------------------------------------------------------------- validate
    def _validate(self, doc: dict[str, Any], *, source: str) -> None:
        for key in ("id", "tier", "executor", "auto_runbook", "tags"):
            if key not in doc:
                raise ValueError(f"{source}: missing required key `{key}` per chaos/SCENARIOS.md §3.")
        tier = doc["tier"]
        if tier not in VALID_TIERS:
            raise ValueError(f"{source}: tier {tier!r} not in {sorted(VALID_TIERS)}.")
        executor = doc["executor"]
        if executor not in VALID_EXECUTORS:
            raise ValueError(f"{source}: executor {executor!r} not in {sorted(VALID_EXECUTORS)}.")

    # ---------------------------------------------------------------- gate
    @staticmethod
    def evaluate_per_pr_gate(
        results: list[ChaosResult],
        *,
        baseline_rto_by_scenario: dict[str, float] | None = None,
    ) -> tuple[bool, list[str]]:
        """Per chaos/SCENARIOS.md §7.1 — PR cannot merge if:
        (1) any fast-subset scenario fails;
        (2) observed_rto_s > 1.2 × baseline;
        (3) observed_rpo_s > 30 s (D31 hard limit);
        (4) auto-runbook fails to fire when expected.

        Returns (gate_passed, failure_reasons).
        """
        baseline_rto_by_scenario = baseline_rto_by_scenario or {}
        reasons: list[str] = []
        for r in results:
            if not r.passed:
                reasons.append(f"{r.scenario_id}: scenario failed")
            baseline = baseline_rto_by_scenario.get(r.scenario_id)
            if baseline is not None and r.observed_rto_s > baseline * 1.2:
                reasons.append(
                    f"{r.scenario_id}: RTO regression "
                    f"({r.observed_rto_s:.1f}s > 1.2 × {baseline:.1f}s baseline)"
                )
            if r.observed_rpo_s > 30.0:
                reasons.append(
                    f"{r.scenario_id}: RPO budget breach ({r.observed_rpo_s:.1f}s > 30s)"
                )
            if r.auto_runbook_fired and not r.auto_runbook_succeeded:
                reasons.append(f"{r.scenario_id}: auto-runbook fired but failed")
        return (len(reasons) == 0, reasons)


# ---------------------------------------------------------------- CLI
def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--scenario", help="Path to a single chaos-*.yaml")
    g.add_argument("--scenarios-dir", help="Directory of chaos-*.yaml")
    p.add_argument("--subset", default="per_pr", choices=["per_pr", "nightly", "canary"])
    p.add_argument("--out", default=None, help="JSONL output file (default: stdout)")
    p.add_argument("--dry-run", action="store_true", help="Validate only")
    args = p.parse_args(argv)

    orch = ChaosOrchestrator()
    if args.scenario:
        scenarios = [orch.load_scenario(args.scenario)]
    else:
        scenarios = orch.load_scenarios(args.scenarios_dir)

    if args.dry_run:
        print(f"[dry-run] {len(scenarios)} chaos scenarios validated.")
        return 0

    if args.scenarios_dir:
        results = orch.run_subset(scenarios, subset=args.subset)
    else:
        results = [orch.run_one(s) for s in scenarios]

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            for r in results:
                f.write(json.dumps(r.to_dict()) + "\n")
    else:
        for r in results:
            print(json.dumps(r.to_dict()))

    # Per chaos/SCENARIOS.md §7.1 gate logic.
    gate_passed, reasons = ChaosOrchestrator.evaluate_per_pr_gate(results)
    if not gate_passed:
        print("[chaos] PR gate FAILED:", file=sys.stderr)
        for r in reasons:
            print(f"  • {r}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
