# The Hardening Chapter — "We built it, then we hardened it"

> **Role**: Technical-30% evidence **and** Demo-20% top wow scene #1 (the
> Observability "정지→수리 / stall→repair" trace), folded into the single
> grand-narrative Track 3 submission per **D50** (GRAND-NARRATIVE-PLAN §2 arc,
> §5-1 H1-H4, §4 wow scene #1).
>
> **Honesty rule (RULES.md §Professional Honesty, GRAND-NARRATIVE-PLAN §7)**:
> every number below is printed by a committed, re-runnable script
> (`scripts/smoke-test/run-hardening-measure.sh`). Nothing is invented. The
> measured before/after comes from a **local, deterministic optimization pass**
> over a synthetic edge-case set that **emulates the optimize loop offline**.
> The GA **Vertex AI Prompt Optimizer (data-driven)** is the production path;
> its live submission is **wired (operator-gated)**; see "Honest scope".

---

## 1. The narrative (Build → Optimize)

We built a 22-agent fleet (D23) that runs the influencer-campaign loop
source → vet → outreach → reply → ship → verify → report. Then we **hardened**
it.

The weak point we narrate: when a creator reply is ambiguous — **interested,
but quietly negotiating a rate** ("Love it! my rate is ~$800, ok?") — the
`conversation_responder` (Tier-1 agent #5, Gemini 2.5 Pro) **stalled at the
auto-respond ↔ escalate boundary**. The 8-intent classifier (`conversation`,
agent #4) rounded the reply down to `interested`, so the rate signal never
triggered an escalation; the responder was sent down the drafting path with no
rate-handling fact, while its own prompt (step 7) told it to escalate
negotiations. The correct outcome for a negotiating creator is **escalate to a
human** (`runtime.Escalation`), not an auto-drafted reply — we never negotiate
rates or mint AP2 mandates from this agent (D27).

We made this measurable and fixed it with the Optimize toolchain, all offline:

- **Agent Simulation (H2)** — a synthetic edge-case set of **26 cases**
  (`test-harness/hardening/synthetic_cases.json`): explicit negotiation,
  interest-with-rate (the stall), decline disguised as interest, soft/hard no,
  out-of-scope, missing-context, mixed-emotion, across **ko / ja / zh-CN / en**.
- **Agent Observability (H3)** — captured the stalled reasoning path, then the
  repaired one (`scripts/demo/assets/observability-trace-{stalled,repaired}.json`).
- **Prompt Optimizer (H4)** — turned the baseline failures into the
  `agent_optimizer_tune.ObservedFailure` contract (the labeled examples the GA
  data-driven optimizer consumes), applied the improved triage rule in a local
  deterministic pass, and **re-measured**. The GA Vertex AI Prompt Optimizer
  (data-driven) is the production path; its live submission is wired
  (operator-gated) via the same `agent_optimizer_tune` capability.

---

## 2. The fix (H1) — a pre-LLM triage that closes the stall

We added a pure, deterministic `triage_inbound(turn, facts) -> TriageDecision`
to `packages/agents-adk/src/ss_agents/agents/conversation_responder.py` that
decides `respond` vs `escalate` **before** the expensive Pro draft, with an
explicit machine-readable `reason` tag. Two rule sets share the one function so
the before/after is measured on the **same surface**:

- `_baseline_triage` — the prompt-only era. Escalates on the literal
  `negotiating` class and on `has_minimum_context=False`, but **misses**
  interest-with-rate → wrongly routes it to `respond`. That is the stall.
- `_optimized_triage` — wired as the agent's **live** behavior (`triage_inbound`
  delegates to it). The rule that closes the stall:

  > **`interested`/`needs_info` + `extracted.proposed_rate_usd is not None`
  > → escalate (reason = `rate_signal_on_positive`)**

A proposed rate means terms are on the table even if the classifier said
"interested" — so it is a negotiation; escalate (D27). The same clarification
was added to the responder's system prompt as **step 9** so the LLM honors the
policy even if it ever runs without the triage gate.

---

## 3. The measured result (H4) — before → after

```
$ bash scripts/smoke-test/run-hardening-measure.sh
```

| Metric (triage_routing_accuracy) | Before (`_baseline_triage`) | After (`_optimized_triage`, live) |
|---|---|---|
| Synthetic cases | 26 | 26 |
| Passed | 11 | 26 |
| **Pass rate** | **42.3 %** | **100.0 %** |
| Delta | — | **+57.7 pp** |

**Headline: 42.3 % → 100.0 %.**

A "pass" requires the triage to match **both** the expected decision **and** the
expected reason tag — so a right-answer-for-the-wrong-reason cannot inflate the
score. The 15 baseline failures group (by the reason they should have produced)
into the `ObservedFailure` families fed to the Optimizer:

| Failure family (`ObservedFailure.kind`) | samples |
|---|---|
| `misrouted:rate_signal_on_positive` (the stall) | 7 |
| `misrouted:hard_no` (declined / unsubscribe) | 4 |
| `misrouted:soft_no` (not_now) | 2 |
| `misrouted:out_of_scope_class` (out_of_office / unrelated) | 2 |

The exact numbers above are written to
`scripts/demo/assets/hardening-before-after.json` by the same run that prints
them — re-run the script to reproduce.

---

## 4. The demo scene #1 assets (H3 — stall → repair)

- `scripts/demo/assets/observability-trace-stalled.json` — the baseline run on
  the canonical stall case `rate-positive-en-01`. `triage.action = respond`,
  `agent.outcome = ok`, and step 3 is flagged `"stall": true` with a note: the
  proposed rate (USD 800) is present but the baseline has no rule to read it, so
  it falls through to `respond` and oscillates at the boundary.
- `scripts/demo/assets/observability-trace-repaired.json` — the optimized run on
  the same case. `triage.action = escalate`,
  `triage.reason_tag = rate_signal_on_positive`, `agent.outcome = escalate`, and
  the new step 4 is flagged `"repaired": true`.

Span attribute names mirror `ss_agents.observability.agent_span` /
`record_outcome` (D32): `agent.id`, `agent.model`, `agent.trace_id`,
`agent.outcome`, plus a `triage.*` namespace for the decision path. The demo
renders the stalled graph, then the repaired graph flowing through.

---

## 5. Honest scope (the load-bearing disclosure)

- The before/after numbers are produced by a **local deterministic optimization
  pass** over the synthetic set that **emulates the optimize loop offline** —
  it is **not** the GA Vertex AI Prompt Optimizer (data-driven). The local pass
  demonstrates the before/after offline; the GA Prompt Optimizer is the
  production path.
- The GA **Vertex AI Prompt Optimizer (data-driven)** is a **batch / async**
  optimization job: you give it a labeled example dataset + a target eval metric
  + the system instruction to improve; it runs an iterative custom job and
  writes the improved instruction back to a GCS `output_path`
  ([docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/prompts/data-driven-optimizer)).
- That production path is now **wired (operator-gated)** in
  `ss_agents.tools.agent_optimizer_tune` (`CAPABILITY_LAYER_MODE=live`): it
  composes the data-driven-optimizer config (`system_instruction`,
  `eval_metrics_types`, `input_data_path`, `output_path`, …) from the observed
  failures + the target metric, uploads it to a GCS bucket, and submits the job
  via `vertexai.Client.prompt_optimizer.optimize(method=VAPO, …)`. Live runs
  require the operator to set `VERTEX_PROMPT_OPTIMIZER_GCS_BUCKET`,
  `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, and ADC — **not run in CI**.
- The measurement harness (default) queues the **stub**, which returns a
  deterministic receipt (`opt-conversation-responder-001`, `queued`) — proving
  the production capability surface and the `ObservedFailure` input contract are
  real while live submission stays operator-gated (GRAND-NARRATIVE-PLAN §7).
- The Observability trace artifacts are deterministic, offline renderings of the
  pure triage decision path — **not** captured live Cloud Trace spans. The OTel
  span shape (`observability.py`) is real; live export is the production path.
- The synthetic cases are hand-authored, not real creator data (D10).

---

## 6. How to reproduce / re-run

```bash
# Prints before → after and (re)writes the three asset files. Offline, $0.
bash scripts/smoke-test/run-hardening-measure.sh

# The unit + simulation tests that pin the claim:
cd packages/agents-adk
uv run --extra dev pytest -q tests/agents/test_conversation_responder.py tests/hardening
```

**Citations**: D5 (models), D23 (Tier-1 #5 / Tier-2 M3 optimizer), D25 (learning
loop), D27 (no mandate minting from this agent), D32 (observability), D50 (single
grand-narrative). Source plan: GRAND-NARRATIVE-PLAN.md §2, §4, §5-1, §7.
