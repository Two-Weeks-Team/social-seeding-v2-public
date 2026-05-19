#!/usr/bin/env python3
"""runner.py — Vertex AI Agent Simulation driver (L4).

Cites: D25 (RLHF on Simulation), D34 (4-locale parity), D37 (5-layer TDD), D39 ($1500 envelope).
MATRIX: §5 (L4 Agent Simulation), §7.2 (nightly cadence), §9 (cost ledger).
Source spec: gcp-research/simulation/SCENARIOS.md §7 (nightly run plan).

This module reads scenarios.yaml (the 103-seed catalog + 900 generated per night)
and executes each scenario against Vertex AI Agent Simulation. In HARNESS_MODE=stub
(default), it skips the cloud call and produces deterministic fake traces so
pytest can validate the harness end-to-end without billing.

Live mode requires:
    HARNESS_MODE=live
    GOOGLE_CLOUD_PROJECT=ss-v2-sim   # MATRIX §5.2 dedicated sim project
    gcloud auth application-default login
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
PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "ss-v2-stub")

# Per MATRIX §5.1, scenarios MUST conform to this contract.
REQUIRED_SCENARIO_FIELDS = {"id", "category", "locale", "agent_under_test", "inputs"}
# Per simulation/SCENARIOS.md §2.1, 8 categories.
VALID_CATEGORIES = {"C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"}
# Per D34.
VALID_LOCALES = {"ko", "en", "ja", "zh"}


@dataclass
class ScenarioResult:
    """One row of L4 simulation output. Mirrors BigQuery agent_sim_rewards schema
    (simulation/SCENARIOS.md §5.2)."""

    scenario_id: str
    agent_under_test: str
    category: str
    locale: str
    passed: bool
    reward: float
    task_success: bool
    trajectory_quality: float
    safety_gate: bool
    cost_latency: float
    duration_ms: int
    cost_usd: float
    trace_uri: str | None = None
    error: str | None = None
    fault_seeds: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ScenarioRunner:
    """L4 Agent Simulation driver.

    In stub mode, returns deterministic results derived from scenario shape.
    In live mode, calls Vertex AI Agent Simulation per simulation/SCENARIOS.md §7.1.
    """

    def __init__(
        self,
        *,
        mode: str = HARNESS_MODE,
        project_id: str = PROJECT_ID,
        sim_model: str = "gemini-2.5-pro",
        max_concurrency: int = 50,
    ) -> None:
        self.mode = mode
        self.project_id = project_id
        self.sim_model = sim_model
        self.max_concurrency = max_concurrency
        self._client = None  # lazy-init in live mode

    # ------------------------------------------------------------------ public
    def load_scenarios(self, path: str | Path) -> list[dict[str, Any]]:
        """Parse the simulation/scenarios.yaml catalog."""
        with open(path, "r", encoding="utf-8") as f:
            doc = yaml.safe_load(f)
        if not isinstance(doc, dict) or "scenarios" not in doc:
            raise ValueError(
                f"{path}: missing top-level `scenarios:` list — see "
                f"simulation/SCENARIOS.md §3 schema."
            )
        scenarios = doc["scenarios"]
        if not isinstance(scenarios, list):
            raise ValueError(f"{path}: `scenarios:` must be a list.")
        for s in scenarios:
            self._validate(s)
        return scenarios

    def _validate(self, scenario: dict[str, Any]) -> None:
        missing = REQUIRED_SCENARIO_FIELDS - scenario.keys()
        if missing:
            raise ValueError(
                f"scenario {scenario.get('id', '<unknown>')}: missing required "
                f"fields {missing} per simulation/SCENARIOS.md §3."
            )
        cat = scenario.get("category")
        if cat not in VALID_CATEGORIES:
            raise ValueError(
                f"scenario {scenario['id']}: category {cat!r} not in "
                f"{sorted(VALID_CATEGORIES)} per SCENARIOS.md §2.1."
            )
        loc = scenario.get("locale")
        if loc not in VALID_LOCALES:
            raise ValueError(
                f"scenario {scenario['id']}: locale {loc!r} not in "
                f"{sorted(VALID_LOCALES)} per D34."
            )

    def run_one(self, scenario: dict[str, Any]) -> ScenarioResult:
        """Run a single scenario. Returns a ScenarioResult."""
        if self.mode == "stub":
            return self._stub_run(scenario)
        return self._live_run(scenario)

    def run_batch(
        self,
        scenarios: list[dict[str, Any]],
        *,
        limit: int | None = None,
    ) -> list[ScenarioResult]:
        """Run a list of scenarios sequentially (the live runner uses a Cloud
        Workflows fan-out for parallelism — see simulation/SCENARIOS.md §7)."""
        results: list[ScenarioResult] = []
        for i, s in enumerate(scenarios):
            if limit is not None and i >= limit:
                break
            try:
                results.append(self.run_one(s))
            except Exception as exc:  # noqa: BLE001
                results.append(
                    ScenarioResult(
                        scenario_id=s.get("id", f"<unknown-{i}>"),
                        agent_under_test=s.get("agent_under_test", "<unknown>"),
                        category=s.get("category", "<unknown>"),
                        locale=s.get("locale", "<unknown>"),
                        passed=False,
                        reward=0.0,
                        task_success=False,
                        trajectory_quality=0.0,
                        safety_gate=False,
                        cost_latency=0.0,
                        duration_ms=0,
                        cost_usd=0.0,
                        error=str(exc),
                    )
                )
        return results

    # ------------------------------------------------------------------ stub
    def _stub_run(self, scenario: dict[str, Any]) -> ScenarioResult:
        """Deterministic stub. Per the simulation schema, category C1 is the
        modal happy path (high reward), C3/C4 are adversarial/compliance (binary
        gates), C5 is infra failure (always exercises retry path)."""
        sid: str = scenario["id"]
        cat = scenario["category"]
        # Deterministic pseudo-random from id for repeatability.
        h = sum(ord(c) for c in sid) % 100
        # Category-driven shape.
        if cat == "C1":
            task = h >= 5
            traj = 0.85 + (h % 10) / 100
            safe = True
            cost = 0.85
        elif cat == "C2":
            task = h >= 15
            traj = 0.78 + (h % 15) / 100
            safe = True
            cost = 0.80
        elif cat == "C3":  # adversarial — safety gate is the test
            task = h >= 30
            traj = 0.70
            safe = h >= 10  # 10% safety failure rate in stub
            cost = 0.75
        elif cat == "C4":  # compliance — safety gate is the test
            task = h >= 20
            traj = 0.75
            safe = h >= 5  # 5% compliance failure rate in stub
            cost = 0.80
        elif cat == "C5":  # infra failure
            task = h >= 25  # 75% recovery rate in stub
            traj = 0.65 + (h % 20) / 100
            safe = True
            cost = 0.60
        elif cat == "C6":  # payment/AP2
            task = h >= 10
            traj = 0.90
            safe = h >= 2  # near-zero safety failure
            cost = 0.85
        elif cat == "C7":  # multi-tenant collision
            task = h >= 15
            traj = 0.80
            safe = h >= 5
            cost = 0.75
        else:  # C8 multimodal
            task = h >= 20
            traj = 0.78
            safe = h >= 8
            cost = 0.70
        # Compose using the reward calculator (avoid circular import via late):
        from .reward_calculator import composite_reward  # noqa: PLC0415
        reward = composite_reward(
            task_success=task,
            trajectory_quality=traj,
            safety_gate=safe,
            cost_latency=cost,
        )
        # Stubbed duration & cost: small fixed numbers.
        return ScenarioResult(
            scenario_id=sid,
            agent_under_test=scenario["agent_under_test"],
            category=cat,
            locale=scenario["locale"],
            passed=reward >= 0.5 and safe,
            reward=reward,
            task_success=task,
            trajectory_quality=traj,
            safety_gate=safe,
            cost_latency=cost,
            duration_ms=42_000 + (h * 100),  # ~45s/scenario per SCENARIOS.md §7.2
            cost_usd=0.04 if cat != "C8" else 0.06,  # SCENARIOS.md §1.4
            trace_uri=f"gs://ss-v2-stub-traces/{sid}.json",
            fault_seeds=list(scenario.get("inputs", {}).get("environment_context", {}).get("injected_failures", []) or []),
        )

    # ------------------------------------------------------------------ live
    def _live_run(self, scenario: dict[str, Any]) -> ScenarioResult:
        """Real Vertex AI Agent Simulation call. Imports defensively to avoid
        ImportError at module-load time in stub-only environments."""
        try:
            # google-cloud-aiplatform >= 1.62 ships the agent simulation client.
            from google.cloud import aiplatform  # noqa: PLC0415
        except ImportError as exc:
            raise RuntimeError(
                "google-cloud-aiplatform not installed — required for "
                "HARNESS_MODE=live. Install via `pip install "
                "google-cloud-aiplatform>=1.62.0`."
            ) from exc

        if self._client is None:
            aiplatform.init(project=self.project_id, location="us-central1")
            self._client = aiplatform.gapic.EvaluationServiceClient()

        t0 = time.time()
        # The actual call shape is documented in simulation/SCENARIOS.md §1.2
        # and §7.1. We omit a real implementation here because:
        # (a) it requires the agent_spec_ref (versioned snapshot) which the
        #     calling Cloud Workflows job populates from Agent Registry;
        # (b) the precise SDK names move between aiplatform pre-/post-1.62.
        # The contract is: emit a ScenarioResult, write trace to
        # gs://ss-v2-sim-traces/N/{cat}/{id}.json, append a row to
        # BigQuery ss-v2-prod.agent_evals.l4_runs.
        raise NotImplementedError(
            "Live Agent Simulation call lands once D17 Agent Runtime is wired. "
            "Track via MATRIX §11 T1. For now, set HARNESS_MODE=stub."
        )

    # ------------------------------------------------------------------ post
    def aggregate(self, results: list[ScenarioResult]) -> dict[str, Any]:
        """Aggregate pass-rate, reward distribution, locale parity, category
        coverage. Output mirrors the nightly regression score in MATRIX §5.4."""
        if not results:
            return {"total": 0, "pass_rate": 0.0, "regression_score": 0.0}
        passed = sum(1 for r in results if r.passed)
        total = len(results)
        mean_reward = sum(r.reward for r in results) / total
        by_cat: dict[str, list[ScenarioResult]] = {}
        by_loc: dict[str, list[ScenarioResult]] = {}
        for r in results:
            by_cat.setdefault(r.category, []).append(r)
            by_loc.setdefault(r.locale, []).append(r)
        total_cost = sum(r.cost_usd for r in results)
        return {
            "total": total,
            "passed": passed,
            "pass_rate": passed / total,
            "mean_reward": mean_reward,
            "by_category": {
                c: {"count": len(rs), "mean_reward": sum(r.reward for r in rs) / len(rs)}
                for c, rs in by_cat.items()
            },
            "by_locale": {
                lc: {"count": len(rs), "mean_reward": sum(r.reward for r in rs) / len(rs)}
                for lc, rs in by_loc.items()
            },
            "total_cost_usd": total_cost,
            "min_reward_category": min(
                by_cat.items(), key=lambda kv: sum(r.reward for r in kv[1]) / len(kv[1])
            )[0] if by_cat else None,
        }


# ----------------------------------------------------------------------- CLI
def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--scenarios",
        required=True,
        help="Path to scenarios.yaml (e.g. gcp-research/simulation/scenarios.yaml).",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Max scenarios to run (default: all). Per-PR smoke uses --limit=50.",
    )
    p.add_argument(
        "--out",
        default=None,
        help="Output JSONL file for ScenarioResult rows (default: stdout).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate scenarios.yaml only; do not run any scenario.",
    )
    args = p.parse_args(argv)

    runner = ScenarioRunner()
    scenarios = runner.load_scenarios(args.scenarios)
    if args.dry_run:
        print(
            f"[dry-run] mode={runner.mode}, project={runner.project_id}, "
            f"loaded {len(scenarios)} scenarios from {args.scenarios}"
        )
        return 0

    results = runner.run_batch(scenarios, limit=args.limit)
    agg = runner.aggregate(results)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            for r in results:
                f.write(json.dumps(r.to_dict()) + "\n")
        print(f"[runner] wrote {len(results)} results to {args.out}", file=sys.stderr)

    print(json.dumps(agg, indent=2))
    # Exit non-zero if regression_score is bad — wire when MATRIX §5.4 lands.
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
