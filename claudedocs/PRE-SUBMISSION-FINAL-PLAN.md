# Pre-Submission Final Hardening & Gap-Closure Plan
**For autonomous `/goal` execution in the next session.** Target: Google for Startups AI Agents Challenge — Track 3. **D-day: 2026-06-05 17:00 PT.**

> Load via `/handon` (this plan) + `/goal` with the completion condition in §1. The `/goal` evaluator (Haiku) only sees the conversation — **print the proof in the same turn** you claim a step done (`pnpm run verify-build`, `git status`, the `curl`, the screenshot path, the smoke-test exit code).

---

## §0 Context (grounded 2026-05-22 by 3 parallel Explore audits)

Three audits ran: (A) submission readiness, (B) 30+ Google agent-platform coverage, (C) E2E/UI judge walkthrough. Synthesis:

- **Code/narrative are strong**; the gaps are mostly *operational + coherence*, not architectural.
- Challenge rubric: **Technical 30% · Business 30% · Innovation 20% · Demo 20%**. Rules at `gcp-research/track-rules/CHALLENGE-RULES.md`. 6 Track-3 requirements all met.
- ss-mcp-server is now hardened + live (PR #12): multi-container, auth enforced, Model Armor live, real data.

**Highest-priority findings to act on:**
1. 🔴 **D53 coherence risk**: the *demo path* (`scripts/run-demo.ts` → `packages/agents`, TypeScript) appears to still use **Opus 4.7 / Claude Haiku** (Agent C), while the *Track-3 claim* is the Gemini-3.x Python ADK fleet (`packages/agents-adk`). A Google submission must ship **Gemini 3.x only (D53, NO Anthropic)**. **Two fleets, possible divergence** — must verify + reconcile.
2. 🔴 **Demo deliverables**: 0/10 hero screenshots, no demo-video URL, Devpost console GAPs unanswered (Demo = 20% of score).
3. 🟠 **Judge can't run E2E easily**: auth test-login disabled, no single-command judge path; reply/ship/verify/report stages are mocked/Phase-gated.
4. 🟠 **Platform-narrative polish**: live Imagen/Veo take, A2A-hop observability trace, `TRACK3-COMPLIANCE.md`, VAPO/mTLS status disclosure, README hardening headline.
5. 🟡 **Honest-scope re-verification**: re-run every "demonstrated-live" claim; reconcile what the judge actually runs vs what's claimed.

---

## §1 COMPLETION CONDITION (the `/goal`)

The run is **done** when ALL of the following are true AND proven in-conversation:

1. **D53 coherence proven**: a grep/report shows **zero Anthropic/Opus/Haiku/`@anthropic-ai/sdk`/`gemini-2.5`/`*-pro`** runtime references in any judge-visible or demo-executed path (both `packages/agents` and `packages/agents-adk`), OR every residual is documented as dead/never-executed with evidence. `pnpm run verify-build` green.
2. **Judge E2E path works**: a single documented command sequence brings up the stack and runs the demo to a visible result; captured as `claudedocs/JUDGE-WALKTHROUGH.md` + at least one real run transcript/screenshot. Stages that are mocked are explicitly labeled in that doc.
3. **Submission assets generated** (everything an agent CAN do): 10 hero screenshots captured to `scripts/demo/submission/screenshots/` (live endpoints + local Mission Control via Playwright/chrome-devtools), a finalized demo-video **script** (`scripts/demo/submission/VIDEO-SCRIPT.md`), README hardening headline added, `TRACK3-COMPLIANCE.md` created, "What's live right now" section added. (Operator-only residue listed in §6.)
4. **Platform gaps closed or disclosed**: `TRACK3-COMPLIANCE.md` maps each requirement→evidence; the 30+ service coverage matrix is committed as `claudedocs/PLATFORM-COVERAGE.md`; the Tier-1 platform opportunities (live Imagen take, A2A trace, mTLS/VAPO status) are either demonstrated or explicitly disclosed with rationale.
5. **Honest-scope re-verified**: every `HONEST-SCOPE.md` "demonstrated-live" row re-run with proof printed; any drift corrected; the demo-fleet-vs-claim reconciliation written down.
6. **Judge simulation passed**: a multi-expert judge panel (see §4 Phase 7) scores the submission on the 4 rubric dimensions; the lowest-scoring gaps are closed or have a written mitigation; final simulated score + rationale captured in `claudedocs/JUDGE-SIM-REPORT.md`.
7. **Green + committed**: `pnpm run verify-build` green, all agent tests pass, all 3 live endpoints return 200, every change committed (small commits, one per task), and a final `claudedocs/PRE-SUBMISSION-READINESS.md` + updated handoff written.
8. **Gap register closed**: `claudedocs/PRE-SUBMISSION-GAPS.md` (seeded in §5) has every gap at status `closed` or `operator-only` or `disclosed` (none `open`).

If blocked on an irreducible operator action (video upload, Devpost form click, a missing credential, an external allowlist), **stop, state exactly what's needed, list it in §6, and `/goal clear`** — do not fake or hand the user "go test it".

---

## §2 OPERATING RULES (read before every phase)

- **🔴 Safety rails**: NEVER touch the protected production backend `:8080` / `backend.socialseed.ing` (read its data only via the existing public `/auth/login` path), NEVER edit `.env` without explicit in-turn user confirmation, NEVER share secrets across the customer (`oauth_*`) vs dashboard (`be_dashboard_*`) auth segments. Live deploys go to the NEW projects (`ss-v2-prod`/`ss-mcp-prod`/`ss-shared-infra`) only.
- **No faking**: never invent metrics, screenshots, or "demonstrated-live" claims. If something can't be shown, disclose it in HONEST-SCOPE. Verify directly or name the external blocker (see [[feedback_dont_offload_verification]]).
- **Gemini docs guard**: before changing ANY Gemini model id / behavior, invoke the `gemini-official-docs-guard` skill and verify against current official docs. Product is **Gemini 3.5-flash + 3.1-flash-lite on Vertex `global`** (D53).
- **bash hook**: the factory-policy hook blocks the literal token `eval` (even inside paths), `$(...)` substitution, heredocs, glob wildcards (`*`), and multiple quoted space-paths in one command. Use simple single commands, one path at a time, and `--body-file`/`-F` for bodies. (See [[project-challenge-submission]] env note.)
- **Korean**: write AskUserQuestion / interactive prompts in Korean (see [[feedback_ask_questions_in_korean]]).
- **Discipline**: one commit per task referencing the task; `pnpm run verify-build` must stay green; no unrelated drive-by changes; `codex review --base main` before pushing src changes if available.
- **Proof-in-turn**: this is a `/goal` run — when you claim a step done, print the command + its output in that same turn.
- **Maintain the gap register** (`claudedocs/PRE-SUBMISSION-GAPS.md`) continuously: every phase updates statuses.

---

## §3 SCREENSHOTS & E2E — tooling note
The runtime has **Playwright** and **chrome-devtools** MCP tools. Use them to drive a real browser and capture the hero screenshots from (a) the 3 live Cloud Run endpoints and (b) a locally-running Mission Control (`pnpm --filter @ss/web dev` + test-login). This makes most of the "0/10 screenshots" gap closable autonomously. Screenshots that require a privately-authenticated console (Devpost form, GCP console) are operator-only (§6).

---

## §4 PHASES (execute in order; each ends with a commit + gap-register update + printed proof)

### Phase 0 — Baseline & instrumentation (re-verify reality)
- Re-confirm live state: `curl` `/healthz`/`/livez` on ss-mcp-server, ss-v2-web, ss-landing → 200; ss-mcp-server `/v1/message:send` no-token → 401, allowlisted SA token → 200.
- Run all `scripts/smoke-test/*.sh` (hardening-measure, integration-a2a, model-garden-live, web-search-grounding) and record exit codes + key outputs.
- `pnpm run verify-build` + `cd gcp-research/refactor-mcp/code/agent && .venv/bin/python -m pytest` + `pnpm --filter @ss/agents test`. Snapshot the numbers.
- **Deliverable**: `claudedocs/PRE-SUBMISSION-BASELINE.md` (live state + test/smoke results, timestamped). Seed the gap register (§5).

### Phase 1 — 🔴 D53 coherence audit & reconciliation (highest priority)
- Grep BOTH fleets + all judge-visible surfaces for `@anthropic-ai/sdk`, `anthropic`, `opus`, `haiku`, `claude`, `gemini-2.5`, `-pro`, `ANTHROPIC_API_KEY`. Map every hit: is it executed in the demo path, judge-visible, dead code, or a comment?
- Determine the truth: does `scripts/run-demo.ts` → `packages/agents` actually call Anthropic at runtime, or was it migrated to `@google/genai` (per memory) and Agent C read stale strings? Trace the actual model client.
- If a real D53 violation exists in any executed/visible path: invoke `gemini-official-docs-guard`, replace with `gemini-3.5-flash`/`gemini-3.1-flash-lite` on Vertex `global`, keep tests green. If it's dead/never-run: delete it or document why it's inert.
- Reconcile the **two-fleet story**: write `claudedocs/FLEET-COHERENCE.md` — which fleet the judge runs (run-demo), which fleet the Track-3 claim rests on (ADK), and how they relate. Ensure the submission narrative is honest about this.
- **Deliverable**: clean D53 grep report + FLEET-COHERENCE.md + green build. Commit.

### Phase 2 — Third-party judge E2E dry-run (make it runnable)
- Stand up the full local stack (dev-mongo, inngest dev, Mission Control) per Agent C's walkthrough. Enable a SAFE judge path: `AUTH_TEST_LOGIN_ENABLED=true` + a generated secret in `.env.local` (NOT `.env`; confirm with user if `.env.local` doesn't exist) — OR document the exact operator step if auth can't be self-enabled.
- Run `pnpm exec tsx scripts/run-demo.ts --type=brand` end-to-end; watch Mission Control + Inngest. Capture the real result (creators sourced, gate, etc.).
- For the mocked stages (reply/ship/verify): either demonstrate via injected Inngest events (a documented "judge can inject a fake reply" path) or clearly label them roadmap in the walkthrough doc. Do NOT fake them as live.
- Write `claudedocs/JUDGE-WALKTHROUGH.md`: the exact one-block command sequence + what the judge sees at each screen + which stages are live vs roadmap. This is the doc a judge follows.
- **Deliverable**: JUDGE-WALKTHROUGH.md + a captured real run transcript. Commit.

### Phase 3 — Structure & docs evaluation + fixes
- README: add the **hardening headline** (40.5%→100% train / 71.4% holdout, ~3.7s A2A, ss-mcp hardened) to the hero; add a **"What's live right now"** section (the 3 endpoints that work without creds vs operator-gated paths); ensure the architecture diagram renders.
- Create `TRACK3-COMPLIANCE.md` mapping each of the 6 Track-3 requirements → code/evidence file paths (per Agent B's draft).
- Audit docs/ for coherence (STATUS, ARCHITECTURE, CAPABILITIES, ROADMAP) vs current reality (Phases 0-6 + ss-mcp hardening). Fix stale claims.
- Render `ARCHITECTURE-track3.mmd` to PNG (`render-architecture.sh`) for the gallery.
- **Deliverable**: updated README + TRACK3-COMPLIANCE.md + rendered diagram. Commit.

### Phase 4 — Execution-screen capture (10 hero screenshots + video script)
- Using Playwright/chrome-devtools, capture the live-endpoint + Mission Control screenshots defined in `SCREENSHOTS-MANIFEST.md` (S-01..S-10): agent.json 200, A2A cross-call, requirement gate table, Mission Control fleet/campaign, real data result, pytest count (re-capture at current number, not 2713), hardening before/after, ROI/TAM scene. Save to `scripts/demo/submission/screenshots/`.
- Write `scripts/demo/submission/VIDEO-SCRIPT.md`: a shot-by-shot 3–8 min demo-video script (English narration + ko/ja/zh-CN subtitle notes per D30) covering the judge walkthrough + the wow moments (A2A hop, Model Armor block, real data, hardening metric). The operator records/uploads; the agent provides the script + the exact screens to film.
- **Deliverable**: ≥10 screenshots + VIDEO-SCRIPT.md. Commit (screenshots may be large — confirm they belong in-repo vs a note; check existing manifest intent).

### Phase 5 — Platform-coverage gap closure (the 30+ services)
- Commit `claudedocs/PLATFORM-COVERAGE.md` (the 30+ service matrix from Agent B: USED/PARTIAL/NOT-USED + evidence).
- Close/disclose the Tier-1 opportunities:
  - **Live Imagen/Veo take**: if `CAPABILITY_LAYER_MODE=live` + quota allow, record ONE real generation (image/video) and capture it as a screenshot/asset; else disclose in HONEST-SCOPE with the exact env to enable.
  - **A2A hop observability trace**: enable `SS_OTEL_ENABLED` for one run, capture a Cloud Trace timeline showing coordinator → A2A POST → ss-mcp response; add as a demo scene.
  - **Agent Gateway mTLS / VAPO**: document the O7 timeline + the exact `*_MODE=live` switch + operator runbook; make the "pending infra" stance explicit (ops maturity, not a hole).
- **Deliverable**: PLATFORM-COVERAGE.md + closed/disclosed Tier-1 items. Commit.

### Phase 6 — Honest-scope re-verification
- Re-run every `HONEST-SCOPE.md` "demonstrated-live" row; print proof (exec ids, exit codes, curl outputs). Update dates/evidence.
- Reconcile the demo-fleet-vs-claim (from Phase 1) into HONEST-SCOPE so a judge running `run-demo.ts` isn't surprised.
- Re-verify the ss-mcp-server engagement-data caveat (backend Group-B quota): re-run a real `/v1/message:send` after quota window; if engagement now populates, capture it; else keep the disclosed caveat.
- **Deliverable**: re-verified HONEST-SCOPE.md with fresh proof. Commit.

### Phase 7 — Multi-expert judge simulation (3rd-party judges' eyes)
- Run a structured judge panel (use the `decision-panel` skill or dispatch parallel sub-agents) playing the 4 rubric roles + adversarial/skeptic voices: **Technical (30%)**, **Business (30%)**, **Innovation (20%)**, **Demo (20%)**. Each judge reviews the actual repo + live endpoints + the walkthrough doc and scores 0–100 with rationale + the single biggest gap they'd dock for.
- Synthesize: lowest-scoring dimension → close its top gap (loop back to the relevant phase) → re-score. Iterate until no dimension has an open blocking gap.
- **Deliverable**: `claudedocs/JUDGE-SIM-REPORT.md` (per-judge score + rationale + closed gaps + residual disclosed gaps). Commit.

### Phase 8 — Final submission assembly (agent-doable parts)
- Fill `scripts/demo/submission/devpost-track3.md` everywhere an agent can (narrative, links, evidence) — leave only the YouTube URL + Devpost-console GAP answers as operator placeholders, clearly marked.
- Verify `SCREENSHOTS-MANIFEST.md` matches the captured screenshots; update the pytest number reference.
- Produce an operator submission checklist delta (what only the operator must click) from `CHECKLIST.md`.
- **Deliverable**: submission folder ready except operator-only items. Commit.

### Phase 9 — Final verification + handoff
- `pnpm run verify-build` green; agent pytest + `@ss/agents` tests green; all 3 endpoints 200; ss-mcp auth + Model Armor + real-data re-checked.
- Write `claudedocs/PRE-SUBMISSION-READINESS.md` (final scorecard: rubric dimension → status → evidence) + a new handoff doc.
- Close the gap register (no `open` items). Open/refresh a PR if there are new commits.
- **Deliverable**: readiness report + handoff + green proof. This satisfies §1.

---

## §5 GAP REGISTER (seed — maintain in `claudedocs/PRE-SUBMISSION-GAPS.md`)
Each row: `id · gap · severity · rubric-dim · owner(agent|operator) · status(open|in-progress|closed|disclosed|operator-only)`.

| id | gap | sev | dim | owner | status |
|---|---|---|---|---|---|
| G1 | D53: demo fleet (packages/agents) may use Opus/Haiku/Anthropic | 🔴 | Tech | agent | open |
| G2 | 0/10 hero screenshots captured | 🔴 | Demo | agent (live) + operator (console) | open |
| G3 | No demo-video URL (script + record + upload) | 🔴 | Demo | agent (script) + operator (record/upload) | open |
| G4 | Devpost console GAPs unanswered (team/license/IP) | 🔴 | Demo | operator | open |
| G5 | Judge can't run E2E (auth test-login off, no 1-cmd path) | 🟠 | Demo/Tech | agent | open |
| G6 | Hardening metric not in README hero | 🟠 | Tech | agent | open |
| G7 | No TRACK3-COMPLIANCE.md (req→evidence map) | 🟠 | Tech | agent | open |
| G8 | No "what's live now" quickstart | 🟡 | Demo | agent | open |
| G9 | Live Imagen/Veo not shown (stubbed) | 🟠 | Demo | agent (if quota) / disclose | open |
| G10 | A2A hop not shown in an observability trace | 🟡 | Innovation | agent | open |
| G11 | Agent Gateway mTLS / VAPO status not disclosed | 🟡 | Innovation | agent (doc) | open |
| G12 | Spanner/AlloyDB/BigQuery/VectorSearch provisioned but not credited in diagram | 🟢 | Tech | agent | open |
| G13 | reply/ship/verify/report stages mocked/Phase-gated — must be honestly labeled in walkthrough | 🟠 | Demo | agent | open |
| G14 | pytest screenshot/refs show stale count (2713 vs current) | 🟡 | Tech | agent | open |
| G15 | engagement_rate=0 caveat (backend Group-B quota) — re-verify or keep disclosed | 🟡 | Demo | agent | open |
| G16 | Gemini Enterprise endpoint unauthenticated caveat — ensure judge-visible disclosure | 🟠 | Demo | agent (doc) + operator (allowlist) | open |

(Add new gaps as Phase 7 judges surface them.)

## §6 OPERATOR-ONLY (cannot be done by the agent — surface clearly, don't fake)
- Record + upload the demo video to YouTube (unlisted) → paste URL into devpost-track3.md.
- Answer Devpost console GAPs (team size, license confirm, repo visibility, IP grant).
- Capture any screenshot that requires a privately-authenticated console (Devpost form, GCP console) the agent can't log into.
- Click "Submit" on Devpost + save the confirmation URL → `CONFIRMATION.txt`.
- Gemini Enterprise allowlist / Cloud Support case (O7) — external Google gate.
- Decide the fate of the 7 differing untracked `" 2"` junk files (data-loss risk — agent won't delete).

## §7 KEY ASSET PATHS
- Rules/rubric: `gcp-research/track-rules/CHALLENGE-RULES.md` · Decisions: `gcp-research/decisions/DECISIONS.md` (D1-D53)
- Submission: `scripts/demo/submission/{HONEST-SCOPE,CHECKLIST,devpost-track3,SCREENSHOTS-MANIFEST,BUSINESS-CASE}.md` + `screenshots/`
- Smoke tests: `scripts/smoke-test/*.sh` · Demo: `scripts/run-demo.ts`, `scripts/run-demo-direct.ts`
- Fleets: `packages/agents-adk` (Python ADK, Gemini 3.x) · `packages/agents` (TS) · `packages/workflows` · `apps/web` (Mission Control)
- ss-mcp hardening: PR #12 · handoff `claudedocs/2026-05-22-ss-mcp-hardening-complete-handoff.md`
- Platform map: `gcp-research/GEMINI-ENTERPRISE-PLATFORM-MAP.md`

## §8 SUGGESTED `/goal` COMPLETION STRING (for the next session)
> "Pre-submission final pass complete: (1) D53 coherence proven across both fleets (no Anthropic/2.5/pro in any executed/visible path) with green build; (2) JUDGE-WALKTHROUGH.md + a real demo run captured; (3) ≥10 hero screenshots + VIDEO-SCRIPT.md + README hardening headline + TRACK3-COMPLIANCE.md committed; (4) PLATFORM-COVERAGE.md committed and Tier-1 platform gaps closed-or-disclosed; (5) every HONEST-SCOPE 'demonstrated-live' row re-verified with printed proof; (6) JUDGE-SIM-REPORT.md shows no open blocking gap on any rubric dimension; (7) verify-build + tests green, 3 endpoints 200, all committed; (8) PRE-SUBMISSION-GAPS.md has zero 'open' rows. Print proof for each."
