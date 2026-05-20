# packages/agents-adk/evals — offline golden-eval runner (H5)

Closes the 4-expert review gap (GRAND-NARRATIVE-PLAN.md §5-1, **H5**):

> golden evalset 러너 배선(현재 미배선) + 홀드아웃 분리(현재 expected=정답 오버핏 구조)
> — *"the golden eval set is not wired to a runner, and expected outputs are
> structured as expected==answer which overfits (no holdout)."*

This package wires the existing `.evalset.json` golden sets to a reproducible
**offline** runner and adds a **train/dev/holdout** split so overfit is
detectable.

D-IDs: **D25** (Agent-Evaluation rung of the learning loop), **D37** (Layer-1 of
the 5-layer TDD pyramid, run offline as a PR gate), **D5** (the coordinator runs
on `gemini-2.5-flash`; the runner scores a deterministic predictor, not the live
Flash call, so the gate is free and reproducible).

## How to run

```bash
# from the repo root
bash scripts/smoke-test/run-golden-eval.sh                       # coordinator, floor 0.70
bash scripts/smoke-test/run-golden-eval.sh --agent coordinator --holdout-floor 0.7

# or directly (must be inside the package so `evals` is importable)
cd packages/agents-adk
SS_OFFLINE=1 uv run python -m evals --agent coordinator
```

Exit code `0` = the holdout slice exists and meets the floor; `1` = holdout
below the floor (overfit / regression); `4` = unknown agent / env error.

The runner is **fully offline**: `SS_OFFLINE=1` forces the stub path in
`runtime.run_agent`, so no Vertex, no `gcloud`, no creds, no billing. The whole
run costs `$0`.

## How the runner works

1. **Load** an ADK-compatible `.evalset.json` (`eval_cases[]` with a single-turn
   `conversation` carrying `user_content` + `final_response` + per-case
   `metadata`). The per-case `metadata` holds the expected fields
   (`expected_chosen`, `should_escalate`).
2. **Load** the holdout manifest (`evals/holdout/<agent>.holdout.json`) — a
   `{train,dev,holdout}` list of `eval_id`s.
3. For each case, build the agent input from `user_content`, then drive the
   agent through the **supported offline seam** — `run_agent(agent_def, input,
   ctx)` with a `PredictorModelClient` injected as `ctx.model_client`. This
   exercises the FULL production path (input validation, prompt-guard, USD cap,
   output validation); only the model call itself is replaced.
4. **Score** the prediction against the case `metadata` (`evals/<agent>_eval.py`
   `score_*`).
5. **Bucket** results into train / dev / holdout and print a pass/score summary,
   including the **train↔holdout gap**.

## The anti-overfit core: a fallible predictor + a frozen holdout

The stored `.evalset.json` files put the golden answer in `final_response`
(`expected == answer`). Replaying that answer through a stub scores 100% by
construction — *that* is the overfit the review flagged.

Instead the runner scores a **deterministic predictor** (`evals/<agent>_eval.py`
`predict_*`) that sees **only the case input — never the expected answer**. For
the coordinator the predictor reproduces its documented decision rules
(`pick_best_candidate` + a keyword→capability matcher + the escalation rules).
The predictor can be **wrong**, so the score is meaningful.

- **`train`** — visible cases. The predictor's keyword/capability table and the
  agent system prompt MAY be tuned against these.
- **`dev`** — held lightly for prompt iteration; still visible.
- **`holdout`** — **frozen**. NEVER used to tune the predictor or prompt. Its
  accuracy is the overfit detector: a high train accuracy with a low holdout
  accuracy means the table was *memorised* against the visible cases rather than
  *generalised*. The runner prints the `train↔holdout gap` for exactly this.

Split policy (also in the manifest header): a new case is added to `train` or
`dev`; a case is promoted to `holdout` only at a calibration checkpoint and then
frozen. The split lives in a separate file so the boundary is auditable in git.

### Current coordinator result (honest)

```
train     8/8  accuracy=100.00%
dev       2/2  accuracy=100.00%
holdout   3/4  accuracy=75.00%
RESULT: PASS — holdout 75.00% ≥ floor 70%; train↔holdout gap +25.00%
```

The `+25%` gap and the single holdout failure (`coord_en_06_holdout_remote_only_blocked`)
are **left visible on purpose**: they prove the holdout catches a real
generalization weakness in the deterministic baseline (when `allowRemote=false`
strips the only capability-matching candidate, the baseline falls through to an
unrelated local agent instead of escalating). Tuning the predictor to pass that
holdout case would defeat the holdout. 75% still clears the 0.70 floor, so the
gate passes while the gap stays a documented finding to drive future work
(the live Flash model, or a follow-up predictor revision validated on a *new*
holdout, is the proper way to close it).

## Honest scope — why a thin runner, not ADK `adk eval` / `AgentEvaluator`

ADK 1.34 ships `google.adk.evaluation.agent_evaluator.AgentEvaluator`, but it
drives a **live** ADK `Runner`/`LlmAgent` (and an LLM-as-judge) against the
evalset. Our offline path (`runtime.is_offline()` → `_run_with_stub`) bypasses
the ADK `Runner` entirely and substitutes the stub model client, so
`AgentEvaluator` cannot score against it without a live Gemini call (creds +
billing + non-determinism). That live path is real but is an **operator/nightly
job** — `gcloud aiplatform evaluation-runs create` per `gcp-research/tests/MATRIX.md`
§2.4 — and is **not** wired here. This runner is therefore a deliberately thin,
offline stand-in for Layer-1 (D37) that gates every PR for free. It does **not**
claim the live Vertex AI Agent Evaluation service is connected (it isn't).

## Files

| Path | Role |
|---|---|
| `runner.py` | evalset/holdout loaders, `PredictorModelClient`, `run_eval`, report/gate |
| `coordinator_eval.py` | coordinator predictor (`predict_coordinator`) + scorer (`score_coordinator`) |
| `__main__.py` | CLI (`python -m evals --agent coordinator`) |
| `datasets/coordinator.evalset.json` | 14-case ADK-shape golden set |
| `holdout/coordinator.holdout.json` | train(8)/dev(2)/holdout(4) split manifest |
| `../tests/evals/test_eval_runner.py` | pytest coverage for the runner itself |
| `../../../scripts/smoke-test/run-golden-eval.sh` | runnable wrapper |

## Adding another agent

1. Write `evals/<agent>_eval.py` with `predict_<agent>(input) -> output` (input
   only — no peek at expected) and `score_<agent>(outcome, case) -> (bool, str)`.
2. Add `datasets/<agent>.evalset.json` (≥12 cases) + `holdout/<agent>.holdout.json`.
3. Register it in `__main__.py` `_REGISTRY`.
