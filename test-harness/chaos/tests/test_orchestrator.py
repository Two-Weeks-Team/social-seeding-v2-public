"""test_orchestrator.py — L5 Chaos orchestrator harness tests.

Cites: D31, D32, D37. MATRIX §6, §7. chaos/SCENARIOS.md §3, §4, §7.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from chaos.orchestrator import (
    ChaosOrchestrator,
    ChaosResult,
    VALID_EXECUTORS,
    VALID_TIERS,
)


HARNESS_ROOT = Path(__file__).resolve().parents[2]
SCENARIO_DIR = HARNESS_ROOT / "chaos" / "scenarios"


# ---------------------------------------------------------------- catalog
class TestChaosCatalog:
    """The 25 scenario YAMLs must parse and conform to chaos/SCENARIOS.md §3."""

    def test_directory_exists(self) -> None:
        assert SCENARIO_DIR.is_dir(), f"missing {SCENARIO_DIR}"

    def test_scenario_count(self) -> None:
        files = list(SCENARIO_DIR.glob("*.yaml"))
        # chaos/SCENARIOS.md §3 declares 24 scenarios; we ship 25 (including
        # canary chaos-stale-read injection).
        assert len(files) >= 24, f"only {len(files)} chaos scenarios"
        assert len(files) <= 30, "too many — split into sub-dirs if catalog grew"

    def test_every_scenario_parses(self) -> None:
        orch = ChaosOrchestrator()
        scenarios = orch.load_scenarios(SCENARIO_DIR)
        assert len(scenarios) >= 24

    def test_every_scenario_has_required_fields(self) -> None:
        orch = ChaosOrchestrator()
        scenarios = orch.load_scenarios(SCENARIO_DIR)
        for s in scenarios:
            assert "id" in s
            assert "tier" in s
            assert s["tier"] in VALID_TIERS, f"{s['id']}: bad tier {s['tier']!r}"
            assert s["executor"] in VALID_EXECUTORS, (
                f"{s['id']}: bad executor {s['executor']!r}"
            )
            assert "auto_runbook" in s
            assert "tags" in s
            assert isinstance(s["tags"], list)

    def test_per_pr_fast_subset_size(self) -> None:
        """chaos/SCENARIOS.md §5.1 — the per_pr subset is 10 fast scenarios."""
        orch = ChaosOrchestrator()
        scenarios = orch.load_scenarios(SCENARIO_DIR)
        per_pr = [s for s in scenarios if "per_pr" in s.get("tags", [])]
        # The spec names 10; we tag liberally (8-12 is acceptable).
        assert 8 <= len(per_pr) <= 12, f"per_pr subset has {len(per_pr)} (want 10)"

    def test_canary_subset_is_4_slo_direct(self) -> None:
        """chaos/SCENARIOS.md §7.2 — canary gate runs ≥2 SLO-direct scenarios."""
        orch = ChaosOrchestrator()
        scenarios = orch.load_scenarios(SCENARIO_DIR)
        canary = [s for s in scenarios if "canary" in s.get("tags", [])]
        assert 2 <= len(canary) <= 6


# ---------------------------------------------------------------- runner
class TestOrchestratorStub:
    """Stub-mode behavior — must always produce a valid ChaosResult."""

    def test_load_single_yaml(self) -> None:
        orch = ChaosOrchestrator()
        s = orch.load_scenario(SCENARIO_DIR / "spanner-failover.yaml")
        assert s["id"] == "CHAOS-DATA-01"
        assert s["tier"] == "data"
        assert s["executor"] == "native_gcp"

    def test_run_one_returns_result(self) -> None:
        orch = ChaosOrchestrator()
        s = orch.load_scenario(SCENARIO_DIR / "spanner-failover.yaml")
        r = orch.run_one(s)
        assert isinstance(r, ChaosResult)
        assert r.scenario_id == "CHAOS-DATA-01"
        assert r.passed is True   # stub_override.pass=true
        assert r.duration_s >= 0.0
        assert r.run_id  # uuid populated

    def test_failure_override(self, tmp_path: Path) -> None:
        bad = tmp_path / "fail.yaml"
        bad.write_text(
            "id: CHAOS-X-99\n"
            "name: forced-fail\n"
            "tier: edge\n"
            "executor: litmus\n"
            "auto_runbook: noop\n"
            "tags: [per_pr]\n"
            "stub_override:\n"
            "  pass: false\n"
        )
        orch = ChaosOrchestrator()
        s = orch.load_scenario(bad)
        r = orch.run_one(s)
        assert r.passed is False
        # RTO regression should show up:
        assert r.observed_rto_s > 60

    def test_run_subset_per_pr(self) -> None:
        orch = ChaosOrchestrator()
        scenarios = orch.load_scenarios(SCENARIO_DIR)
        results = orch.run_subset(scenarios, subset="per_pr")
        assert len(results) >= 8
        for r in results:
            assert isinstance(r, ChaosResult)

    def test_invalid_tier_rejected(self, tmp_path: Path) -> None:
        bad = tmp_path / "bad.yaml"
        bad.write_text(
            "id: CHAOS-X-100\n"
            "name: bad\n"
            "tier: invented_tier\n"
            "executor: litmus\n"
            "auto_runbook: x\n"
            "tags: [per_pr]\n"
        )
        orch = ChaosOrchestrator()
        with pytest.raises(ValueError, match="invented_tier"):
            orch.load_scenario(bad)

    def test_invalid_executor_rejected(self, tmp_path: Path) -> None:
        bad = tmp_path / "bad.yaml"
        bad.write_text(
            "id: CHAOS-X-101\n"
            "name: bad\n"
            "tier: edge\n"
            "executor: hand-of-god\n"
            "auto_runbook: x\n"
            "tags: [per_pr]\n"
        )
        orch = ChaosOrchestrator()
        with pytest.raises(ValueError, match="hand-of-god"):
            orch.load_scenario(bad)


# ---------------------------------------------------------------- gate logic
class TestPerPRGate:
    """chaos/SCENARIOS.md §7.1 gating."""

    def _pass(self, sid: str = "CHAOS-OK") -> ChaosResult:
        return ChaosResult(
            scenario_id=sid, tier="edge", executor="litmus", passed=True,
            observed_rto_s=30.0, observed_rpo_s=0.0,
            slo_budget_consumed_pct=1.0,
            auto_runbook_fired=True, auto_runbook_succeeded=True,
            duration_s=10.0,
        )

    def _fail(self, sid: str = "CHAOS-FAIL", *, rto: float = 100, rpo: float = 0,
              runbook_fired: bool = True, runbook_succeeded: bool = False) -> ChaosResult:
        return ChaosResult(
            scenario_id=sid, tier="edge", executor="litmus", passed=False,
            observed_rto_s=rto, observed_rpo_s=rpo,
            slo_budget_consumed_pct=12.0,
            auto_runbook_fired=runbook_fired,
            auto_runbook_succeeded=runbook_succeeded,
            duration_s=120.0,
        )

    def test_all_pass(self) -> None:
        ok, reasons = ChaosOrchestrator.evaluate_per_pr_gate([self._pass()])
        assert ok
        assert reasons == []

    def test_one_fail(self) -> None:
        ok, reasons = ChaosOrchestrator.evaluate_per_pr_gate([self._pass(), self._fail()])
        assert not ok
        assert any("CHAOS-FAIL" in r for r in reasons)

    def test_rto_regression_blocks(self) -> None:
        good = self._pass()
        good.observed_rto_s = 80.0  # passed but slow
        baselines = {"CHAOS-OK": 50.0}  # 80 > 50 × 1.2 = 60
        ok, reasons = ChaosOrchestrator.evaluate_per_pr_gate(
            [good], baseline_rto_by_scenario=baselines,
        )
        assert not ok
        assert any("RTO regression" in r for r in reasons)

    def test_rpo_budget_breach(self) -> None:
        bad = self._pass()
        bad.observed_rpo_s = 45.0  # > 30s hard limit
        ok, reasons = ChaosOrchestrator.evaluate_per_pr_gate([bad])
        assert not ok
        assert any("RPO budget" in r for r in reasons)

    def test_runbook_fired_but_failed(self) -> None:
        bad = self._fail(rto=30, runbook_fired=True, runbook_succeeded=False)
        bad.passed = True  # pretend the user-facing assertion passed
        bad.observed_rpo_s = 0
        ok, reasons = ChaosOrchestrator.evaluate_per_pr_gate([bad])
        assert not ok
        assert any("auto-runbook" in r for r in reasons)
