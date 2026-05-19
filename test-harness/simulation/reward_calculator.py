#!/usr/bin/env python3
"""reward_calculator.py — RLHF reward signal composer.

Cites: D25 (RLHF on Agent Simulation), D37 (5-layer TDD).
Source spec: gcp-research/simulation/SCENARIOS.md §5 (four-layer reward).

The composite reward per scenario combines four signals:

    Layer 1 — Task success           (binary)
    Layer 2 — Trajectory quality     (continuous, [0,1])
    Layer 3 — Safety + compliance    (binary GATE — zeros total if 0)
    Layer 4 — Cost + latency         (continuous, [0,1])

The formula from SCENARIOS.md §5.2 is:

    reward = safety_gate × (
        0.50 × task_success
      + 0.30 × trajectory_quality
      + 0.20 × cost_latency
    )

This module is the single source of truth for that calculation. Per the
nightly run plan in SCENARIOS.md §7, it runs as a Cloud Run job that
reads BigQuery `agent_sim_scores` and writes `agent_sim_rewards`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


# Coefficients per SCENARIOS.md §5.2. After Day-7 they are *fitted* rather than
# author-guesses (SCENARIOS.md §8.4). Setting them here as constants is the
# documented bootstrap behaviour.
TASK_WEIGHT = 0.50
TRAJECTORY_WEIGHT = 0.30
COST_LATENCY_WEIGHT = 0.20

# Layer 3 thresholds per SCENARIOS.md §5.1.
SAFETY_AUTORATER_MIN = 0.95


def composite_reward(
    *,
    task_success: bool,
    trajectory_quality: float,
    safety_gate: bool,
    cost_latency: float,
) -> float:
    """Compute the scalar reward per SCENARIOS.md §5.2.

    Args:
        task_success: Layer 1 — did the agent reach the desired response
            pattern within `success_criteria.max_turns`? Binary.
        trajectory_quality: Layer 2 — weighted mean of precision/recall/single
            tool use, clipped to [0,1].
        safety_gate: Layer 3 — Model Armor + safety_v1 + locale-specific
            autoraters. **Gate**, not contribution: if False, reward = 0.
        cost_latency: Layer 4 — `0.6 × cost_score + 0.4 × latency_score`,
            already aggregated by the caller. Clipped to [0,1].

    Returns:
        Reward ∈ [0,1].
    """
    if not safety_gate:
        return 0.0
    task = 1.0 if task_success else 0.0
    traj = _clip01(trajectory_quality)
    cl = _clip01(cost_latency)
    return (
        TASK_WEIGHT * task
        + TRAJECTORY_WEIGHT * traj
        + COST_LATENCY_WEIGHT * cl
    )


def cost_score(actual_usd: float, budget_usd: float) -> float:
    """Linear penalty: 1.0 at $0 actual, 0.0 at or beyond budget."""
    if budget_usd <= 0:
        return 0.0
    return max(0.0, 1.0 - (actual_usd / budget_usd))


def latency_score(actual_ms: int, target_ms: int) -> float:
    """Linear penalty: 1.0 at 0 ms, 0.0 at or beyond target."""
    if target_ms <= 0:
        return 0.0
    return max(0.0, 1.0 - (actual_ms / target_ms))


def cost_latency_aggregate(*, c_score: float, l_score: float) -> float:
    """Compose Layer 4 — 0.6 cost + 0.4 latency."""
    return 0.6 * _clip01(c_score) + 0.4 * _clip01(l_score)


@dataclass
class TrajectoryComponents:
    """Per SCENARIOS.md §5.1 Layer 2 — weighted mean of three managed metrics."""

    precision: float
    recall: float
    single_tool_use: float


def trajectory_quality(components: TrajectoryComponents) -> float:
    """Weighted mean: precision 0.4, recall 0.4, single 0.2 (SCENARIOS.md §5.1)."""
    return (
        0.4 * _clip01(components.precision)
        + 0.4 * _clip01(components.recall)
        + 0.2 * _clip01(components.single_tool_use)
    )


def regression_score(
    *,
    current_pass_rate: float,
    baseline_pass_rate: float,
) -> float:
    """MATRIX §5.4 nightly regression score = (current pass) − (baseline pass).

    Pass criteria: regression_score >= -0.005.
    """
    return current_pass_rate - baseline_pass_rate


def rlhf_pair_eligibility(
    rewards_per_scenario_per_night: dict[str, list[float]],
    *,
    top_n_variance: int = 200,
    high_reward_min: float = 0.85,
    low_reward_max: float = 0.5,
) -> list[str]:
    """Select scenarios eligible for RLHF pair construction (SCENARIOS.md §5.3).

    Returns scenarios with high reward variance across the last 30 nights
    AND at least one trace in (≥0.85) AND at least one trace in (≤0.5).
    """
    eligible: list[tuple[str, float]] = []
    for sid, rewards in rewards_per_scenario_per_night.items():
        if len(rewards) < 2:
            continue
        has_high = any(r >= high_reward_min for r in rewards)
        has_low = any(r <= low_reward_max for r in rewards)
        if not (has_high and has_low):
            continue
        variance = _variance(rewards)
        eligible.append((sid, variance))
    eligible.sort(key=lambda kv: kv[1], reverse=True)
    return [sid for sid, _ in eligible[:top_n_variance]]


# ----------------------------------------------------------------- helpers
def _clip01(x: float) -> float:
    if x < 0.0:
        return 0.0
    if x > 1.0:
        return 1.0
    return x


def _variance(xs: Iterable[float]) -> float:
    xs = list(xs)
    n = len(xs)
    if n == 0:
        return 0.0
    mean = sum(xs) / n
    return sum((x - mean) ** 2 for x in xs) / n
