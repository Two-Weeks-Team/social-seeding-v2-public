"""test_runner.py — L4 Agent Simulation harness tests.

Cites: D25 (RLHF), D37 (5-layer TDD).
MATRIX: §5 (L4 contract), §5.4 (pass criteria).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from simulation.runner import (
    ScenarioRunner,
    ScenarioResult,
    VALID_CATEGORIES,
    VALID_LOCALES,
)
from simulation.reward_calculator import (
    composite_reward,
    cost_score,
    latency_score,
    cost_latency_aggregate,
    trajectory_quality,
    TrajectoryComponents,
    regression_score,
    rlhf_pair_eligibility,
)


HARNESS_ROOT = Path(__file__).resolve().parents[2]
GCP_RESEARCH = HARNESS_ROOT.parent / "gcp-research"
LIVE_SCENARIOS = GCP_RESEARCH / "simulation" / "scenarios.yaml"


# ----------------------------------------------------------------- runner
class TestScenarioRunnerStub:
    """Stub mode is the per-PR / CI behavior. Must always pass."""

    def test_load_authoritative_catalog(self) -> None:
        runner = ScenarioRunner(mode="stub")
        scenarios = runner.load_scenarios(LIVE_SCENARIOS)
        assert len(scenarios) >= 100, (
            "Expected ≥100 seed scenarios per SCENARIOS.md §4. "
            f"Got {len(scenarios)}."
        )

    def test_every_scenario_has_required_fields(self) -> None:
        runner = ScenarioRunner(mode="stub")
        scenarios = runner.load_scenarios(LIVE_SCENARIOS)
        for s in scenarios:
            assert "id" in s
            assert "category" in s
            assert "locale" in s
            assert "agent_under_test" in s
            assert "inputs" in s

    def test_categories_within_taxonomy(self) -> None:
        runner = ScenarioRunner(mode="stub")
        scenarios = runner.load_scenarios(LIVE_SCENARIOS)
        for s in scenarios:
            assert s["category"] in VALID_CATEGORIES

    def test_locales_within_d34(self) -> None:
        runner = ScenarioRunner(mode="stub")
        scenarios = runner.load_scenarios(LIVE_SCENARIOS)
        for s in scenarios:
            assert s["locale"] in VALID_LOCALES, (
                f"{s['id']}: locale {s['locale']!r} outside D34 set."
            )

    def test_run_one_returns_scenario_result(self) -> None:
        runner = ScenarioRunner(mode="stub")
        scenarios = runner.load_scenarios(LIVE_SCENARIOS)
        r = runner.run_one(scenarios[0])
        assert isinstance(r, ScenarioResult)
        assert 0.0 <= r.reward <= 1.0
        assert r.scenario_id == scenarios[0]["id"]
        assert r.duration_ms > 0
        assert r.cost_usd >= 0.0

    def test_run_batch_with_limit(self) -> None:
        runner = ScenarioRunner(mode="stub")
        scenarios = runner.load_scenarios(LIVE_SCENARIOS)
        results = runner.run_batch(scenarios, limit=5)
        assert len(results) == 5

    def test_aggregate_shape(self) -> None:
        runner = ScenarioRunner(mode="stub")
        scenarios = runner.load_scenarios(LIVE_SCENARIOS)
        results = runner.run_batch(scenarios, limit=20)
        agg = runner.aggregate(results)
        assert agg["total"] == 20
        assert 0.0 <= agg["pass_rate"] <= 1.0
        assert "by_category" in agg
        assert "by_locale" in agg

    def test_aggregate_empty(self) -> None:
        runner = ScenarioRunner(mode="stub")
        agg = runner.aggregate([])
        assert agg["total"] == 0
        assert agg["pass_rate"] == 0.0

    def test_invalid_scenario_rejected(self, tmp_path: Path) -> None:
        bad = tmp_path / "bad.yaml"
        bad.write_text(yaml.safe_dump({
            "scenarios": [
                {"id": "X-001-en", "category": "C9", "locale": "en",
                 "agent_under_test": "sourcing", "inputs": {}},
            ]
        }))
        runner = ScenarioRunner(mode="stub")
        with pytest.raises(ValueError, match="C9"):
            runner.load_scenarios(bad)

    def test_invalid_locale_rejected(self, tmp_path: Path) -> None:
        bad = tmp_path / "bad.yaml"
        bad.write_text(yaml.safe_dump({
            "scenarios": [
                {"id": "C1-001-xx", "category": "C1", "locale": "xx",
                 "agent_under_test": "sourcing", "inputs": {}},
            ]
        }))
        runner = ScenarioRunner(mode="stub")
        with pytest.raises(ValueError, match="xx"):
            runner.load_scenarios(bad)


# ----------------------------------------------------------- reward calculator
class TestRewardCalculator:
    """SCENARIOS.md §5.2 composite formula — single source of truth."""

    def test_safety_gate_zeros_reward(self) -> None:
        # Even with perfect other layers, safety_gate=False ⇒ reward=0.
        r = composite_reward(
            task_success=True,
            trajectory_quality=1.0,
            safety_gate=False,
            cost_latency=1.0,
        )
        assert r == 0.0

    def test_perfect_score(self) -> None:
        r = composite_reward(
            task_success=True,
            trajectory_quality=1.0,
            safety_gate=True,
            cost_latency=1.0,
        )
        assert r == pytest.approx(1.0)

    def test_only_task_success(self) -> None:
        # Task only contributes 0.50.
        r = composite_reward(
            task_success=True,
            trajectory_quality=0.0,
            safety_gate=True,
            cost_latency=0.0,
        )
        assert r == pytest.approx(0.50)

    def test_clipping_above_one(self) -> None:
        r = composite_reward(
            task_success=True,
            trajectory_quality=10.0,  # absurd input
            safety_gate=True,
            cost_latency=10.0,
        )
        assert r == pytest.approx(1.0)

    def test_clipping_below_zero(self) -> None:
        r = composite_reward(
            task_success=False,
            trajectory_quality=-5.0,
            safety_gate=True,
            cost_latency=-5.0,
        )
        assert r == 0.0

    def test_cost_score(self) -> None:
        assert cost_score(0.0, 1.0) == pytest.approx(1.0)
        assert cost_score(0.5, 1.0) == pytest.approx(0.5)
        assert cost_score(1.0, 1.0) == pytest.approx(0.0)
        assert cost_score(2.0, 1.0) == pytest.approx(0.0)  # beyond
        assert cost_score(0.5, 0.0) == 0.0  # bad budget

    def test_latency_score(self) -> None:
        assert latency_score(0, 1000) == pytest.approx(1.0)
        assert latency_score(500, 1000) == pytest.approx(0.5)
        assert latency_score(1000, 1000) == pytest.approx(0.0)
        assert latency_score(2000, 1000) == pytest.approx(0.0)

    def test_cost_latency_aggregate(self) -> None:
        # 0.6 × cost + 0.4 × latency
        out = cost_latency_aggregate(c_score=1.0, l_score=0.5)
        assert out == pytest.approx(0.6 + 0.20)

    def test_trajectory_quality_weighted_mean(self) -> None:
        # precision 0.4, recall 0.4, single 0.2
        tq = trajectory_quality(TrajectoryComponents(
            precision=1.0, recall=1.0, single_tool_use=0.0,
        ))
        assert tq == pytest.approx(0.8)

    def test_trajectory_quality_clipping(self) -> None:
        tq = trajectory_quality(TrajectoryComponents(
            precision=2.0, recall=-1.0, single_tool_use=0.5,
        ))
        assert tq == pytest.approx(0.4 * 1.0 + 0.4 * 0.0 + 0.2 * 0.5)

    def test_regression_score_pass(self) -> None:
        # MATRIX §5.4: regression_score >= -0.005 passes.
        assert regression_score(current_pass_rate=0.95, baseline_pass_rate=0.96) == \
            pytest.approx(-0.01)

    def test_rlhf_pair_eligibility(self) -> None:
        history = {
            "C1-001": [0.90, 0.85, 0.50, 0.40],   # has hi+lo → eligible
            "C1-002": [0.95, 0.96, 0.93],          # all hi, no lo → skip
            "C1-003": [0.20, 0.15, 0.10],          # all lo, no hi → skip
            "C3-001": [0.95, 0.45, 0.90, 0.30],   # eligible
        }
        out = rlhf_pair_eligibility(history, top_n_variance=10)
        assert "C1-001" in out
        assert "C3-001" in out
        assert "C1-002" not in out
        assert "C1-003" not in out


# -------------------------------------------------------------- e2e smoke
class TestEndToEnd:
    """Smoke test the full happy-path: load → run-batch → aggregate."""

    def test_end_to_end_50_scenarios(self) -> None:
        # MATRIX §7.1 — per-PR L4 smoke is 50 scenarios.
        runner = ScenarioRunner(mode="stub")
        scenarios = runner.load_scenarios(LIVE_SCENARIOS)
        results = runner.run_batch(scenarios, limit=50)
        assert len(results) == min(50, len(scenarios))
        agg = runner.aggregate(results)
        # Per-PR gate (SCENARIOS.md §7.4): mean_reward >= 0.75 AND no
        # category < 0.6 AND no safety gate failures.
        # In stub mode we don't assert on the mean (it's deterministic but
        # not crafted to clear the gate) — only that the keys exist.
        assert "mean_reward" in agg
        assert "by_category" in agg


# -------------------------------------------------------------- locale parity
class TestLocaleParityInSeeds:
    """D34 — 4 locales required. Seeds must cover all 4."""

    def test_all_4_locales_present(self) -> None:
        runner = ScenarioRunner(mode="stub")
        scenarios = runner.load_scenarios(LIVE_SCENARIOS)
        locales = {s["locale"] for s in scenarios}
        assert locales == VALID_LOCALES, f"Missing locales: {VALID_LOCALES - locales}"

    def test_seed_distribution_not_lopsided(self) -> None:
        runner = ScenarioRunner(mode="stub")
        scenarios = runner.load_scenarios(LIVE_SCENARIOS)
        counts: dict[str, int] = {}
        for s in scenarios:
            counts[s["locale"]] = counts.get(s["locale"], 0) + 1
        # SCENARIOS.md §2.1 — seeds ~25-26 per locale; allow 5-50 in case the
        # 103-seed catalog gets re-cut.
        for loc, n in counts.items():
            assert 5 <= n <= 50, f"locale {loc}: {n} scenarios (suspicious)"
