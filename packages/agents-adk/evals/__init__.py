"""ss_agents golden-eval runner package.

H5 (GRAND-NARRATIVE-PLAN.md §5-1) — wire the golden evalset to a reproducible
OFFLINE runner with a holdout split so overfit is detectable.

D-IDs:
    D25 — Learning loop (Prompt + **Agent Evaluation** + SFT + Distillation +
          RLHF). This runner is the Agent-Evaluation rung that runs cheaply on
          every PR; the Vertex SFT/RLHF rungs sit downstream of it.
    D37 — 5-layer TDD pyramid. Layer 1 is "Vertex AI Agent Evaluation … per-agent
          .evalset.json". This package is the OFFLINE stand-in for Layer 1 that
          gates PRs without billing a live model (the live `gcloud aiplatform
          evaluation-runs create` path stays an operator/nightly job — see
          README.md "Honest scope").
    D5  — Gemini model tiers. The coordinator runs on gemini-2.5-flash; the
          eval scores a deterministic predictor (NOT the live Flash call) so the
          gate is reproducible and free.

Honest scope (RULES.md §7): this is a THIN runner, not ADK's `AgentEvaluator`.
ADK's evaluator drives a live `Runner`/`LlmAgent` (and an LLM-judge) and cannot
score against our offline deterministic stub — see README.md for the why.
"""
from __future__ import annotations
