# golden/ — L1 Vertex AI Agent Evaluation (267-case structure)

> **Cites**: D37 (5-layer TDD), D23 (22-agent fleet), D25 (eval-driven
> development), D34 (4-locale parity). **MATRIX**: §2 + §8.
> **Source spec**: `gcp-research/tests/MATRIX.md` §2.1 case-count table.

---

## 1. What goes here

One `.evalset.json` per agent — the schema is Google's
`google.cloud.aiplatform.v1beta1.EvaluationDataset` (see
https://cloud.google.com/vertex-ai/generative-ai/docs/agents/eval-overview).
Per MATRIX §2.2 every case in a v2 `.golden.test.ts` ports to one entry
in the corresponding evalset, with input/expected pulled verbatim from
the test fixtures.

Per MATRIX §2.2, T1 agents must hit these minima:

| Agent | Min cases | Trajectory mode | Primary metric | File |
|---|---|---|---|---|
| sourcing | 12 | ANY_ORDER | tool_trajectory_avg_score ≥ 0.85 | tier1/sourcing.evalset.json |
| vetting | 15 | IN_ORDER | tool_trajectory_avg_score ≥ 0.90, fit_score_mae ≤ 0.08 | tier1/vetting.evalset.json |
| outreach_writer | 20 | IN_ORDER | response_match_v2 ≥ 0.75, spam_score == 0, judge_weighted ≥ 0.80 | tier1/outreach-writer.evalset.json |
| conversation | 25 | n/a | classification_f1 ≥ 0.92 | tier1/conversation.evalset.json |
| conversation_responder | 15 | ANY_ORDER | response_match_v2 ≥ 0.75, tone_consistency ≥ 0.80 | tier1/conversation-responder.evalset.json |
| logistics | 30 | n/a | structured_extract_accuracy ≥ 0.95 | tier1/logistics.evalset.json |
| content_verify | 20 | IN_ORDER | precision ≥ 0.95, recall ≥ 0.85 | tier1/content-verify.evalset.json |
| analyst | 10 | IN_ORDER | groundedness ≥ 0.90, numeric_accuracy ≥ 0.99 | tier1/analyst.evalset.json |
| research | 15 | ANY_ORDER | hallucinations_v1 ≤ 0.05, citation_count ≥ 3 | tier1/research.evalset.json |
| intake | 12 | n/a | task_completion ≥ 0.85, slot_fill_accuracy ≥ 0.90 | tier1/intake.evalset.json |
| lead_outreach_writer | 15 | IN_ORDER | response_match_v2 ≥ 0.75, spam_score == 0 | tier1/lead-outreach-writer.evalset.json |
| payment_mandate | 10 | EXACT | mandate_validity == 1.0 (zero tolerance) | tier1/payment-mandate.evalset.json |
| compliance | 25 | ANY_ORDER | false_clear_rate ≤ 0.01 (gated to 0) | tier1/compliance.evalset.json |
| creative | 8 | IN_ORDER | safety_v1 ≥ 0.95, brand_consistency ≥ 0.80 | tier1/creative.evalset.json |
| a11y | 20 | ANY_ORDER | a11y_compliance_score ≥ 0.90 | tier1/a11y.evalset.json |
| customer_success | 15 | IN_ORDER | activation_lift ≥ 0.10 | tier1/customer-success.evalset.json |
| **T1 total** | **267** | | | |

T2 (meta) and T3 (watchdog) get directory parity but their evaluation
is transitive:

| Agent | Layer route | File |
|---|---|---|
| coordinator (M1) | L4-only (Simulation) | tier2/coordinator.evalset.json (smoke set) |
| critic (M2) | L4-only + special "judge-of-judges" eval | tier2/critic.evalset.json |
| optimizer (M3) | L4 reward consumer, not subject | tier2/optimizer.evalset.json (smoke set) |
| anomaly_watch (W1) | L5 (Chaos) | tier3/anomaly-watch.evalset.json |
| cost_watch (W2) | L5 | tier3/cost-watch.evalset.json |
| security_watch (W3) | L5 | tier3/security-watch.evalset.json |

---

## 2. Schema

Each `.evalset.json` follows MATRIX §2.4. The shape is:

```jsonc
{
  "name": "<agent_id>_v1",
  "description": "human description, D-ID citation",
  "agent_spec_ref": "gs://ss-v2-agent-registry/<agent>/v(n).json",
  "trajectory_mode": "EXACT|IN_ORDER|ANY_ORDER",
  "metrics": ["tool_trajectory_avg_score", "response_match_v2", "<custom>"],
  "thresholds": { "<metric>": <float>, ... },
  "eval_cases": [
    {
      "name": "<case_id>",
      "locale": "ko|en|ja|zh",
      "tags": ["happy|edge|adversarial|compliance|..."],
      "input": { ... },
      "expected": {
        "tool_trajectory": [{"tool_name": "...", "tool_input": {...}}, ...],
        "reference_response": { ... }
      }
    }
  ]
}
```

The 16 tier-1 evalsets in this directory are **scaffolds** populated
with case headers (id, locale, tags) and placeholder bodies. Real
inputs/expected blocks are filled by ports from v2 `.golden.test.ts`
fixtures + the simulation seed scenarios in
`gcp-research/simulation/scenarios.yaml`.

---

## 3. Run order

1. **Local lint** — `python3 -c "import json; json.load(open(p))"` per file.
2. **Per-PR fast eval** — 5 cases per touched agent via
   `gcloud aiplatform evaluation-runs create --evalset-file=<path>`.
3. **Nightly full eval** — all 267 cases under `tier1/` + the smoke sets
   under `tier2/` and `tier3/`.

The driver script is `simulation/runner.py --layer=L1`.

---

## 4. Authoring rule

Every case must have:
- `name` matching pattern `<agent>_<locale>_<3-digit>` (e.g. `outreach_writer_ko_007`).
- `locale` ∈ {ko, en, ja, zh} per D34.
- ≥ 1 entry in `tags` from the allowlist
  `{happy, edge, adversarial, compliance, infra-fail, multimodal, multi-tenant}`.
- `input` conformant to the agent's Pydantic / Zod input schema in
  `packages/contracts/`.
- `expected.tool_trajectory` populated per the agent's trajectory_mode.

PRs that add cases must run `python test-harness/golden/validate.py`
(stub today, full schema check once jsonschema is wired).

---

## 5. Why this is L1's only home

Per MATRIX §2.5, L1 evaluation is the only layer that exercises real
Gemini calls inside CI. Vitest/pytest mocks in L2/L3 can pass while the
underlying model regresses; L1 catches that. The per-PR slice keeps it
affordable (~$0.40/PR per MATRIX §2.4); the nightly full sweep keeps it
comprehensive (~$25/night).
