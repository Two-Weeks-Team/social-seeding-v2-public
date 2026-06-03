# Post-PR#70 Follow-up — Reconciliation + Handoff

> Created 2026-06-03. **PR #70** (`feat/agent-engine-deploy`, "native-adoption §A — GT1–GT6 LIVE")
> is verified complete and self-contained (gates green, MERGEABLE, fully pushed). This doc tracks
> **everything else**: doc reconciliation that the GT work made necessary, plus the operator/Google
> handoff. It is the checklist the follow-up `/goal` drives.
>
> **Sequencing (hard):** the §A reconciliation edits the Native-Adoption section of
> `docs/IMPROVEMENT-MASTER-PLAN-STATUS.md`, which currently exists **only on the #70 branch**
> (commits de639c9/43c42c0/f1c8047/660415b are not yet in `main`). So §A must be done on a branch
> **off `main` AFTER PR #70 merges** — otherwise the edits collide with #70. Until then §A is blocked
> on the merge (an operator action, see §B-0).

---

## PR #70 — closure evidence (already done, for the record)
- Branch `feat/agent-engine-deploy` @ `d707b4c`, 8 commits, **MERGEABLE**, ahead/behind = 0/0.
- Gates on HEAD: `apps/web` ap2 vitest **83 passed** · `pnpm run verify-build` **7/7** · `pytest` (agents-adk) **2933 passed**.
- Live resources persist: reasoningEngines `2498295477225652224` (trace+recall) / `1587442452589969408` (Memory Bank) / `8794890706243026944` (B1); ragCorpus `…/us-west1/…/6917529027641081856`. Orphan empty corpus `4611686018427387904` deleted.
- Per-item GT1–GT6 proofs: `docs/NATIVE-ADOPTION-CHECKLIST.md` §A; repro: `scripts/native-adoption/`.

---

## §A — FOLLOW-UP RECONCILIATION (autonomous, `/goal`-tracked)
> Each item is verifiable from the conversation. Gates (`verify-build`·`pytest`·ap2 vitest) stay green.
> **All of §A is on a NEW branch off `main` after #70 merges**, and lands as a **separate PR**.

- [x] **FR1 — Master-board staleness audit + fix** ✅ 2026-06-03 — tracker-cell `⬜` 26→**0**; banner added; samples A3(`cad193c`→editedPayload)·A2(`f83b36e`→RateLimitMiddleware)·A8(`4465d4e`→conversation_responder_eval.py) verified in main.
  - `docs/IMPROVEMENT-MASTER-PLAN-STATUS.md` Sub-Sprint Tracker shows **26 `⬜`** task cells (A1–A11, B1–B11, X1·X2·X4·X6 — X3/X5 carry "merge"/"concurrent" notes, not `⬜`), but the "Final Status (2026-05-28)" section says all shipped via 10 commits (`cad193c`…`10ebb3f`), all confirmed in `main`, gates green.
  - Task: for each of the 26, confirm (a) its commit in the Final Status table is an ancestor of `main` AND (b) the claimed artifact exists in HEAD. Flip `⬜→✅` **only when both hold**; if an artifact is missing, mark it genuinely-open and list it. Add a one-line banner: "Sub-Sprint Tracker reconciled YYYY-MM-DD; Final Status section is authoritative."
  - **Proof**: `grep -c ⬜` in the tracker tables → 0 (or the exact residual list); 3 sampled IDs mapped to commit+artifact.

- [x] **FR2 — Native-Adoption section synced to PR #70 outcomes** ✅ 2026-06-03 — Phase-B 표: B2 auto-recall✅(GT2/2498…)·B3 RAG✅(GT4/6917…)·B4 VAPO✅(GT5 50→90%)·B5 Trace✅(GT1/dc063a2…).
  - The Phase-B table + 진행 로그 still say B2 auto-recall is "partial/blocked", and B3 RAG / B4 VAPO / B5 Trace are unstarted. PR #70 resolved these.
  - Task: mark **B2 auto-recall ✅** (GT2, engine `2498295477225652224`, env-pinned recall), **B3 RAG ✅** (GT4, corpus `6917529027641081856`), **B4 VAPO ✅** (GT5, 50%→90%), **B5 Cloud Trace ✅** (GT1, traceId `dc063a2af962770ff776b0c43ff8ac28`) — each with the PR #70 ref.
  - **Proof**: section shows the four ✅ with engine/corpus/trace IDs.

- [x] **FR3 — HONEST-SCOPE rows for the new live capabilities** ✅ 2026-06-03 — table 17→20 data rows: +18 GenAI Eval (client-side 3.x judge)·+19 RAG Engine (us-west1 allowlist)·+20 AP2 chain guard; rows 1/2/4 → demonstrated-live (GT5/GT1/GT2).
  - `scripts/demo/submission/HONEST-SCOPE.md` (currently 17 data rows) lacks the GT1–GT6 surfaces.
  - Task: add honest rows for: Cloud Trace (live), Memory auto-recall (live, env-pinned region fix), GenAI Evaluation (live; **managed autorater rejects 3.x → client-side gemini-3.5-flash judge**), RAG Engine (live, **us-west1 — new-project Spanner allowlist**), Prompt Optimizer (live, data-driven 50→90%), AP2 chain guard (route-wired). Keep stub/gated boundaries explicit.
  - **Proof**: row count delta (17 → N data rows) + the new rows printed.

- [x] **FR4 — Gate re-verify after doc edits** ✅ 2026-06-03 — verify-build **7/7 FULL TURBO** · pytest (agents-adk) **2933 passed** · ap2 vitest **83 passed**.

- [x] **FR5 — Separate follow-up PR** ✅ 2026-06-03 — branch `docs/post-pr70-reconcile` off `main` (no #70 commits); see PR proof in the goal turn.

**§A 완주 정의**: FR1–FR5 모두 `[x]` + 각 proof 대화 출력 + gates green.

---

## §B — OPERATOR HANDOFF (NOT `/goal` — human/owner actions)
- [ ] **B-0 — Merge PR #70** (`gh pr merge 70 --merge`, no-squash). **Unblocks all of §A.**
- [ ] **B-1 — Redeploys** (PR-ready from the 2026-05-28 P1 sprint, live-activation gated):
  - A2 ss-mcp-server rate-limit middleware → next ss-mcp redeploy
  - A6 serve.py 22/3 healthz disclosure → next ss-agents redeploy
  - A9 `_heuristic_rank` warning log → next ss-mcp redeploy
- [ ] **B-2 — Re-captures** (need ADC quota=ss-v2-prod): A4 agents-cli eval capture · A7 research grounded capture.
- [ ] **B-3 — A11** MC body Lighthouse a11y ≥ 0.90 (local stack + Chrome).
- [ ] **B-4 — Cleanup** us-central1 RAG engine config left `Unprovisioned` (no corpus there; restore to `Basic`/`Scaled` only if a us-central1 corpus is ever needed).

---

## §C — GOOGLE-GATED (track only, not actionable now)
- Agent Gateway mTLS — 🔴 Private-Preview 승인.
- Cloud Marketplace 등재 — 🔴 KR 결제권역(D2) → 해외 sub-entity(법무).
- 22/22 정확도 eval 게이트 — 🟡 per-agent domain predictor 22개.
- 22-fleet 번들링 기동 — 🟡 ss_agents lazy-init 리팩터(현재 build OK·startup health 타임아웃).
- Model Armor 인라인 전 플릿 — 🟡 신규 sanitize 프리미티브(live=Model Armor API).
- Gemini Enterprise Registry(ss-v2-prod) — 🟡 discoveryengine API + GE 앱.

> §B·§C는 `/goal` 완주 기준 **제외**. §A만 자율 완주 대상.
