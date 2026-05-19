# GOAL-PROTOCOL.md — /goal Autonomous Mode Contract

> **Purpose**: Binding contract between the operator and the autonomous `/goal` runner. The Haiku evaluator that watches a `/goal` session only sees the current conversation — it cannot read files, cannot run commands, cannot see prior sessions. This document defines what **proof artifacts** must be printed each turn, what **blocking conditions** must escalate to the operator, and what counts as **done**.
>
> **Authority**: Subordinate to `DECISIONS.md` (39 D-IDs). Compatible with `RULES.md` and `PRINCIPLES.md` from `~/.claude/`. If conflict, `DECISIONS.md` wins.
>
> **Status as of 2026-05-19**: 22-agent fleet complete (Phase 0-8 done). Remaining work in `WORK-QUEUE.md`.

---

## 1. The /goal evaluator's blind spot

Per the v2 `CLAUDE.md` lesson (encoded in 2026-05-13 retro):

> The `/goal` evaluator (Haiku) only sees the conversation — when you claim a goal is met, **run and print the proof in that turn** (`pnpm run verify-build`, `git status`, the `curl`, the Inngest dashboard state).

Translation: every turn that claims progress MUST include a verifiable artifact printed *in the same turn*. Filesystem changes that aren't echoed to stdout don't count.

---

## 2. Mandatory proof artifacts (printed each turn)

When claiming any meaningful progress, the assistant **prints these to stdout** before the goal evaluator inspects the turn:

| Artifact | When to print | Command |
|---|---|---|
| Build status | After code changes | `pnpm run verify-build` (TS) or `uv run pytest -q` (Python) |
| Test count | After test changes | `pytest -q --tb=no -ra` |
| Git status | After file changes | `git status --short` (or `git log --oneline -5`) |
| Spawned agents | After dispatching | "Spawned N background agents: A1=..., A2=..., A3=..." with agent IDs |
| Live endpoint | After deploy | `curl -s ${URL}/healthz` |
| Cost ticker | After billable operation | `gcloud billing budgets describe ... | grep amount` |

**Anti-pattern**: "Done." with no artifact. The Haiku evaluator marks this incomplete.

---

## 3. Blocking conditions — when to `/goal clear`

Per the v2 retro:

> If blocked on a missing env var or an irreducible human decision (e.g. `docs/SCOPE-DECISIONS.md` = P0-8 needs the human to choose which "conditional" features are in v2 day-1), **stop, say exactly what's needed, and `/goal clear`**.

### Blockers requiring operator action (`/goal clear` then wait for operator)

| Trigger | Operator action needed |
|---|---|
| `BILLING_ACCOUNT` env var empty | `gcloud beta billing accounts list` + paste ID |
| GCP project IDs unconfirmed (O2) | `./day-1-setup.sh init` (creates 3 projects) |
| `gcloud auth` not as `app.2weeks@gmail.com` | `gcloud auth login --account=app.2weeks@gmail.com` |
| Devpost console GAPs unanswered (O1) | Operator reads Devpost rules, fills 10 fields |
| Agent Gateway Private Preview not allowlisted (O7) | Operator files Google access request |
| Instagram email feasibility decision (O3/O4) | Operator picks RapidAPI provider + budget |
| Foreign sub-entity not decided (O10) | Operator/legal decides US/SG/JP sub strategy |
| Any DECISIONS.md D-ID supersede candidate | Operator approves new D40+ before code uses it |

### Non-blockers (proceed autonomously)

| Condition | Action |
|---|---|
| Test failure in unrelated agent | Note BN-N tripwire, continue with primary work |
| Background agent socket error mid-stream | Retry with `Agent` tool (smaller scope), don't escalate |
| `terraform validate` not available locally | Note `terraform_validate_status: deferred_to_ci` |
| Cloud Run / Agent Engine deploy needs creds | Note `deploy_status: pending_operator_setup` and continue with code |

---

## 4. Done conditions

A `/goal` session is done when ALL of these are true:

1. **Code**: all `WORK-QUEUE.md` `P0` items completed + `P1` items completed unless blocked by §3.
2. **Tests**: `pytest -q` shows ≥95% pass rate on `packages/agents-adk/`; `vitest run` green on `apps/web/`.
3. **Proof**: a final `STATUS-REPORT.md` written + printed to stdout summarizing what shipped + what's left.
4. **PR**: feature branch pushed + PR URL printed; PR description cites D-IDs.
5. **Outstanding**: any new D40+ decisions appended to `DECISIONS.md` §8 change log.

The assistant explicitly states "GOAL ACHIEVED" or "GOAL BLOCKED" in the final turn. No ambiguous endings.

---

## 5. Decision recording protocol

Every architectural decision made during `/goal` execution **must** be recorded:

1. If supersedes existing D-ID: edit `DECISIONS.md`, mark old as `🔁 superseded by Dn`, add new entry.
2. If new: append D40+ entry with same shape (ID + Decision + Source + Status + Implication).
3. Update `DECISIONS.md` §8 change log: `2026-05-19 | Dn | <one-line> | autonomous /goal session`.
4. Add `git commit` body line: `Implements Dn`.

**Hard rule**: code must cite a D-ID. If no D-ID exists for the change, the assistant pauses, drafts a D-ID, and proceeds.

---

## 6. Agent dispatch contract

`/goal` runs may dispatch background subagents — see `DISPATCH-MATRIX.md` for the task → subagent_type table.

Mandatory dispatch hygiene:
- **Single message, multiple Agent calls** when work is independent (per CLAUDE.md "If you intend to call multiple tools and there are no dependencies").
- **Sequential** when work has a dependency (e.g. Phase 3 → Phase 4 → integration).
- Each subagent's prompt MUST be **self-contained** (the subagent doesn't see conversation context).
- Each subagent prompt **MUST cite the input files** (DECISIONS.md, ARCHITECTURE.md, specs/*).
- **Wait for completion notifications** before claiming progress on dispatched work — don't claim a subagent finished if no notification arrived this turn.

---

## 7. The "no false-clear" gate

When a `/goal` turn says "tests pass" or "build green", the next text **must** include the literal command output that proves it. Failure to do so triggers a self-correction:

```
ASSISTANT: All tests pass.
[NEXT MUST INCLUDE]
$ uv run pytest packages/agents-adk/ -q --tb=no
======== 1542 passed in 4.21s ========
```

If the output isn't printed, the assistant explicitly retracts the claim:

```
ASSISTANT: Earlier I claimed "all tests pass" without printing proof. Retracting until the test command actually runs.
```

This mirrors the `compliance` agent's `precision_no_false_clear ≥ 0.99` invariant — the false-clear cost is too high.

---

## 8. Budget guardrails (per D39 $1500 cap)

The autonomous run consumes GCP credits. Hard rules:

| Threshold | Action |
|---|---|
| < $100 spent | Continue autonomously |
| $100-$300 | Run `cost_watch` summary in proof artifact; continue |
| $300-$700 | Pause, post `STATUS-REPORT.md`, ask operator to approve continuation |
| > $700 | Hard stop, `/goal clear`, operator must `gcloud billing budgets describe` and decide |

---

## 9. Self-correction protocol

If during a `/goal` turn the assistant realizes a previous turn was wrong:

1. Open the next turn with `CORRECTION:` and explain what was wrong.
2. Quote the prior turn's mistaken claim verbatim.
3. State the corrected truth + the proof.
4. Update `DECISIONS.md` change log if the mistake affected a D-ID.
5. Continue with the work.

Don't pretend the mistake didn't happen. The Haiku evaluator catches inconsistency.

---

## 10. Quick reference

```
PRINTING PROOF                  → mandatory each progress turn
BLOCKING ON OPERATOR            → say what's needed, `/goal clear`, wait
CITING D-ID                     → every commit + every architectural change
DISPATCHING SUBAGENTS           → self-contained prompts, single-message parallel
DONE                            → explicit "GOAL ACHIEVED" or "GOAL BLOCKED" with status report
COST > $300                     → pause and ask
TEST CLAIM WITHOUT OUTPUT       → self-correct in next turn
```

---

**Companion docs**:
- [`WORK-QUEUE.md`](WORK-QUEUE.md) — what to work on, in priority order
- [`DISPATCH-MATRIX.md`](DISPATCH-MATRIX.md) — which subagent type handles which task
- [`GOAL-PROMPT.md`](GOAL-PROMPT.md) — the actual `/goal` prompt to copy-paste
