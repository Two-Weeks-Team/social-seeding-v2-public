# GOAL-PROMPT.md — Copy-Paste /goal Prompt

> The autonomous `/goal` mode runs against this prompt verbatim. The Haiku evaluator inspects each turn for proof artifacts (per `GOAL-PROTOCOL.md` §2) and for done/blocked conditions (§4).

---

## Recommended /goal prompt (copy-paste)

```
/goal Complete Track 2 (social-seeding-v2) and Track 3 (tiktok-mcp-server) submission packages for the Google for Startups AI Agents Challenge (deadline 2026-06-05). Work autonomously, dispatch background expert agents, cite decision IDs.

**Source of truth** (read these every relevant turn, in order):
1. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/DECISIONS.md (39 active D-IDs, all binding)
2. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/GOAL-PROTOCOL.md (this run's contract)
3. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/WORK-QUEUE.md (prioritized remaining work)
4. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/DISPATCH-MATRIX.md (task → subagent routing)
5. /Users/kimsejun/Documents/GitHub/social-seeding-v2/packages/agents-adk/BUILD-NOTES.md (BN-9 tripwire and others)

**Operating rules** (non-negotiable):
- Print verification proof (build output, pytest output, git status, agent IDs) IN THE SAME TURN as any progress claim. Per GOAL-PROTOCOL §7, no false clears.
- Dispatch background subagents per DISPATCH-MATRIX. Parallel in single message when independent; sequential when dependent. Cap ≤8 parallel per message, ≤15 in flight total.
- Every architectural change cites a D-ID (D1-D39 active; D40+ for new decisions; supersede protocol per GOAL-PROTOCOL §5).
- Pre-existing test failures in BN-9 family (KR/JA/ZH prompt-guard regex) are W1 — fix them, don't work around them.
- Use Context7 (mcp__plugin_context7_context7__*) to look up the LATEST 2026 spec for any GCP/ADK/Terraform/Next.js API before writing code referencing it. v2 lesson: ADK 2.0 Beta and Agent Runtime APIs have shifted between drops.
- Korean prompt injection tests use particle-rich text after W1 lands. Pre-W1 work uses particle-free workaround.

**Priority order** (work this from top down, dispatching in parallel where possible):

P0 (must finish):
- W1: Fix BN-9 KR/JA/ZH prompt_guard regex (security-engineer; 1 file, 30 min)
- W2: Wire 32+ FunctionTools to 16 Tier-1 agents (python-expert × parallel; ~6-10 hr total)
- W3: Wire Cloud Workflows YAMLs to deployed agent endpoints (backend-architect; 2-3 hr)
- W4: End-to-end smoke test (quality-engineer + python-expert; 3-4 hr)

P1 (gates live deploy, operator-coordinated):
- W5: Operator runs day-1-setup.sh — escalate with exact command if BILLING_ACCOUNT not set (/goal clear and wait)
- W6: terraform apply per region (devops-architect; ~4-6 hr, mostly waiting)
- W7: Cloud Run + Agent Runtime deploy (devops-architect; 2-3 hr)
- W8: Demo video 8x recording (technical-writer + operator OBS recording; 4-6 hr)
- W9: Devpost submission package (technical-writer; 2-3 hr) — operator clicks the submit button on Devpost

**Blocking conditions** (per GOAL-PROTOCOL §3):
If BILLING_ACCOUNT empty, GCP project IDs unconfirmed (O2), Devpost console GAPs unanswered (O1), Agent Gateway allowlist pending (O7), or any operator-only decision arises:
1. Print exact command/decision needed
2. /goal clear
3. Wait for operator

If non-blocker (e.g. terraform CLI absent locally), note status:deferred_to_ci and continue.

**Budget guardrails** (D39 $1500 cap):
- < $300: continue autonomously
- $300-700: pause, post STATUS-REPORT.md, ask operator
- > $700: hard stop

**Done conditions** (per GOAL-PROTOCOL §4):
1. All P0 done with proof
2. P1 done or blocked-with-status-report
3. pytest >=1500 passing, <=5 failures (BN-9 fixes the 3 known)
4. Branch pushed, PR URL printed
5. D40+ decisions appended to DECISIONS.md §8
6. Final STATUS-REPORT.md printed: "GOAL ACHIEVED" or "GOAL BLOCKED + reason"

Begin with W1. Print first turn's plan + first agent dispatch.
```

---

## How to use this prompt

### Step 1 — Copy the block above

Everything between the triple-backtick markers. Don't edit it (the autonomous runner interprets it literally).

### Step 2 — Paste into a fresh Claude Code session

In the project directory `/Users/kimsejun/Documents/GitHub/social-seeding-v2/`:

```bash
cd /Users/kimsejun/Documents/GitHub/social-seeding-v2
# (open a new Claude Code session)
# paste the prompt
```

### Step 3 — Watch for operator-blocking turns

The runner will print operator-blocking conditions in this format:

```
[OPERATOR ACTION NEEDED]
Command to run:
  gcloud beta billing accounts list
  export BILLING_ACCOUNT="..."

/goal clear
```

When you see `/goal clear`, the autonomous run has paused. Run the requested action, then start a new `/goal` session referencing the same prompt (the runner will pick up via WORK-QUEUE.md state).

### Step 4 — Final STATUS-REPORT.md

The terminal turn produces `gcp-research/goal-mode/STATUS-REPORT.md`. Read this to confirm done vs blocked.

---

## Variations

### Variant A — P0 only (fastest convergence)

Replace the priority block with:

```
**Priority order** (this session — P0 only, stop after):
- W1, W2, W3, W4

After P0 done, write STATUS-REPORT.md and exit.
```

### Variant B — Live deploy push

Use when operator has already run W5 (Day-1 setup):

```
**Priority order** (this session — assume Day-1 setup done):
- Confirm W5 done: gcloud projects list shows ss-v2-prod + ss-mcp-prod
- Then: W6 → W7 → W8 → W9
```

### Variant C — Demo-only sprint

Use when code is shipping and we need to record the video fast:

```
**Priority order** (this session — demo polish only):
- Verify W7 deploy is live (curl /healthz both endpoints)
- W8 demo recording per scripts/demo/SCRIPT.md
- W9 Devpost write-up final pass
```

---

## Operator quick-reference cheat sheet

| Situation | What to do |
|---|---|
| `/goal clear` with "BILLING_ACCOUNT not set" | Run `gcloud beta billing accounts list`, copy ID, set env, restart /goal |
| `/goal clear` with "Devpost GAPs" | Open Devpost console, answer the 10 GAPs, paste back to /goal |
| `/goal clear` with "Agent Gateway allowlist" | File Google access request, restart /goal when granted (1-2 wk) |
| STATUS-REPORT.md says "GOAL ACHIEVED" | Open PR, run final review, click Devpost submit |
| STATUS-REPORT.md says "GOAL BLOCKED + reason X" | Resolve X, restart /goal |
| pytest failures > 5 | Don't ship; dispatch root-cause-analyst before any deploy |
| Cost > $300 | Approve continuation explicitly before continuing |

---

## Sanity check before pasting

Before you paste the /goal prompt, run this 3-command check:

```bash
cd /Users/kimsejun/Documents/GitHub/social-seeding-v2

# 1. On the right branch?
git branch --show-current
# Expected: feature/gcp-research-baseline (or successor)

# 2. Recent commits look right?
git log --oneline -3
# Expected: e9d8a4c docs(gcp-research): bake AI Agents Challenge research baseline (39 decisions + 67 files)

# 3. Goal-mode docs present?
ls gcp-research/goal-mode/
# Expected: DISPATCH-MATRIX.md  GOAL-PROMPT.md  GOAL-PROTOCOL.md  WORK-QUEUE.md
```

If any of those checks fail, do not paste the /goal prompt yet — the runner will start from a wrong baseline.

---

**Companion docs**:
- [`GOAL-PROTOCOL.md`](GOAL-PROTOCOL.md) — proof artifacts, blocking conditions, done definition
- [`WORK-QUEUE.md`](WORK-QUEUE.md) — W1-W12 prioritized backlog
- [`DISPATCH-MATRIX.md`](DISPATCH-MATRIX.md) — task → subagent routing + prompt templates
