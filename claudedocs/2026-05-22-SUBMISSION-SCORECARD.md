# Submission Readiness Scorecard — social-seeding-v2

> Living doc for the pre-submission polish goal (Google AI Agents Challenge,
> Track 3, deadline **2026-06-05**). Methodology upgraded from a sibling
> session's goal: **4 named judge lenses + Lighthouse + anti-fakery grep +
> CI-green gate + every gap → phase PR**. Updated each iteration.

Last update: 2026-05-22 (session start of polish goal).

---

## Gate evidence (surfaced, re-runnable)

| Gate | Command | Result |
|---|---|---|
| Build | `pnpm run verify-build` | **exit 0** · 7/7 turbo tasks (lint + type-check + build) |
| TS unit — observability | `pnpm --filter @ss/observability test` | **4 passed** |
| TS unit — agents | `pnpm --filter @ss/agents test` | **64 passed** |
| TS unit — capabilities | `pnpm --filter @ss/capabilities test` | **183 passed** |
| TS unit — workflows | `pnpm --filter @ss/workflows test` (isolated) | **103 passed** |
| TS unit — **total** | (4 README-counted packages) | **354 passed** ✅ matches README |
| Python — agents-adk | `uv run --directory packages/agents-adk pytest -q` | **2924 passed** ✅ |
| CI (GitHub Actions) | `gh run list --branch fix/d53-ss-mcp-gemini-3x` | **success** (verify + pytest-agents) |
| **TS unit — web** | `pnpm --filter @ss/web test` | **🔴 23 failed / 43 passed (66)** — see GAP-W1/W2 |

Live reachability (curl, this session):
- `ss-landing` demo → **HTTP 200**
- `ss-mcp-server /v1/message:send` no-token → **HTTP 401** (auth enforced live)
- gcloud ADC valid (`app.2weeks@gmail.com`, project `ss-v2-prod`)

---

## 4-Lens judge scorecard

> Scores are provisional and re-scored after each gap-closure pass. 0–100.

| # | Lens | Score (now) | Top gaps |
|---|---|---|---|
| i | **Technical / Architecture / Observability** | 93 ▲ | CI vitest gate landed (GAP-C1 ✅), DB isolation fixed (GAP-I1 ✅); residual: dead `not implemented` code (GAP-X1, low) |
| ii | **Design / UX — visual WOW** (Lighthouse + motion) | 95 ▲ | Demo Lighthouse (local, after PR #15): **A11y 96 · SEO 100 · Best-Practices 100 · Agentic 100** (was 84/90/100/50); residual color-contrast minor. Live re-measure pending ss-landing redeploy |
| iii | **Product / Story** (README · demo · onboarding) | 95 ▲ | D53 doc drift fixed across README/CLAUDE.md/STATUS/AGENTS/ARCHITECTURE/.env.example (PR #14 ✅); README is judge-grade w/ Track-3 table + honest scope |
| iv | **Adversarial skeptic** (what breaks / fake-or-incomplete) | 91 ▲ | 🟢 23 red web tests fixed + CI-gated (GAP-W1/W2/C1 ✅); partner-count claims corrected; ADK gmail tool a disclosed Phase-2 stub (off live demo path) |

---

## Row 4 — Third-party judge pass (decision-panel skill, 10 experts, 2026-05-23)

> The 4-lens table above is the agent's own assessment. THIS is the external multi-expert pass the goal required. Decision: "submit as-is, or which single +1 first?" Avg score **≈83/100**; all 6 Track-3 reqs confirmed met + honesty (HONEST-SCOPE) praised across the board.

**Vote tally** (no majority → plurality E; substance = the +1 findings, all verified before acting):

| Option | Votes | Voters |
|---|---|---|
| E — narrative + demo video | **4** | ROI Analyst, Risk Eng, Security Auditor, Pragmatist |
| B — real Vertex ADK ranking | 2 | Strategist, Domain Expert |
| C — full live E2E run | 2 | Devil's Advocate, Critical Reviewer |
| A — submit as-is (+ warm-up) | 1 | Operator |
| OTHER — B-thin (ADK + fallback) | 1 | Innovator |

Per-expert scores: 86/72/86/84/82/88/78/74/88/88.

**Verified findings → disposition:**
- ✅ **Implemented (PR #17)** — *(adversarial KICK)* the W7 `NotImplementedError` staging is **fleet-wide (47 tools), not just Imagen** (Devil's Advocate, verified) → HONEST-SCOPE now discloses the D41 stub/live seam up front; *(security KICK)* run-demo refuses live runs against the shared prod `social_seeding` Atlas (Security Auditor); pinned the `engagement_rate=0` quota artifact (Critical Reviewer).
- ❎ **False alarm, corrected** — "ADK ranker uses PRO_MODEL → 404" (Domain Expert, Innovator): verified stale; post-PR #12 `PRO_MODEL` = `gemini-3.5-flash`. No action.
- 🚩 **Flagged operator/deploy** — demo video + Devpost narrative (operator's task; scenario provided in `claudedocs/2026-05-23-demo-video-scenario.md`); ~~enable real ADK ranking live~~ ✅ **DONE (PRs #21–#23, rev `00008-ndg`)**; gate the GE demo endpoint with Cloud Run IAM (deploy); `min-instances=1` warm-up (the ADK rev already sets minScale=1).

**Dissent surfaced:** Devil's Advocate (C, 72) — "live judge interaction beyond the one rehearsed workflow likely hits stubbed tools"; mitigated by the HONEST-SCOPE seam disclosure. Security Auditor (E, 74) — "GE demo endpoint is unauthenticated (disclosed ≠ mitigated)"; flagged for operator IAM gating.

---

## Gap register

| ID | Lens | Severity | Gap | Status |
|---|---|---|---|---|
| GAP-W1 | iv/i | high | `@ss/web` 22 `.tsx` tests fail `ReferenceError: React is not defined` — vitest JSX-runtime misconfig | ✅ closed (PR-A: `esbuild.jsx=automatic` + `afterEach(cleanup)`) |
| GAP-W2 | iv | med | `mandate-helpers.test.ts` expects `PARTNER_COUNT ≥ 60`; registry has **58** (real curated AP2 subset) | ✅ closed (PR-A: assert real floor + uniqueness, precise comment) |
| GAP-C1 | i | high | CI `ci.yml` has `# - run: pnpm run test` commented out → TS vitest suite (354+web) never gated | ✅ closed (PR-A: `unit-tests` job gates web + 4 Mongo pkgs) |
| GAP-D1 | iii | med | docs (README/CLAUDE.md/STATUS/AGENTS/ARCHITECTURE/.env.example) listed `ANTHROPIC_API_KEY` / Opus·Haiku vs D53 Gemini-only — code already uses `GEMINI_API_KEY` | ✅ closed (PR #14) |
| GAP-D2 | iii | low | `README.md:461` machine-specific `-Users-sgwannabe-` memory path | ✅ closed (PR #14) |
| GAP-X1 | i | low | `packages/db/src/repositories/creator.repo.ts:36` throws `creatorRepo.search not implemented` — **zero callers** (dead code) | open (low; flagged) |
| GAP-I1 | i | low | Full `turbo run test` against one shared mongo-memory DB → cross-package interference | ✅ closed (PR #13: per-package `MONGODB_DB` in `scripts/test-all.ts`) |
| GAP-L1 | ii | med | Demo a11y 84<90: no `<main>`, unlabeled select/checkboxes, label-content mismatch, no meta-description | ✅ **closed LIVE** (PR #15 + ss-landing rev `00006-rr2`: **live** Lighthouse a11y 96 / SEO 100 / agentic 100 / BP 100) |
| GAP-K1 | iv | low | `.env.example` `KIMI_API_KEY` (Moonshot, 3P model) used by `crm.enrich` (lead-campaign) — not in D53's explicit Anthropic/2.5/pro ban, but a "Gemini-only" purist may question it | open (operator question) |
| PENDING-S1 | ii | — | Capture Mission Control + demo execution screenshots | ✅ `claudedocs/2026-05-22-ss-landing-demo.jpeg` |

Disclosed-and-acceptable (NOT gaps): ADK `gmail_send_stub` (Phase-2, off the live A2A creator-search demo path; real `gmail.send` lives in `packages/capabilities`), AP2 signature-chain "pending human auth" placeholders (by design), template `{{var}}` placeholders (feature, not a stub).

---

## +1 changelog (improvements landed this goal)

1. **PR #12 merged** — ss-mcp-server enterprise hardening (D53 + S2S auth + Model Armor live + structured MCP) landed on `main` (`d575c8e`); main now reflects the live production service. *(technical KICK)*
2. **PR-A `chore/submission-polish-web-tests`** — fixed 23 ungated red `@ss/web` tests → **0** (JSX automatic runtime, RTL `afterEach(cleanup)`, portable ICU currency assertion, WebAuthn-capable test env, honest partner-registry invariants) **and** added a CI `unit-tests` job that gates the full TS vitest suite (web + 354 Mongo-backed, isolated per-package DBs). Adversarial-skeptic + technical lenses both ▲. *(technical KICK)*
3. **Lighthouse baseline measured** on the live demo (desktop): Best-Practices **100**, SEO **90**, A11y **84**, Agentic **50** → gaps routed to PR-C. *(visual-WOW evidence)*
4. **PR #14 merged** — D53 doc consistency: `ANTHROPIC_API_KEY`→`GEMINI_API_KEY`, Opus/Haiku→gemini-3.5-flash/3.1-flash-lite, dead `OPENAI_API_KEY` dropped, pytest count 2925→2924, machine-specific memory path generalized. Product/story lens ▲. *(technical KICK + story)*
5. **PR #15 merged + ss-landing redeployed (rev `00006-rr2`)** — demo a11y/SEO: `<main>` landmark, labeled select + checkboxes, label/name match, meta-description → **LIVE** Lighthouse **a11y 84→96, SEO 90→100, agentic 50→100, BP 100** (re-measured on the live URL). Visual-WOW lens ▲. *(visual WOW)*
6. **Decision-panel judge pass (10 experts) + PR #17** — the required Row-4 third-party pass (avg ≈83/100). Landed the in-control +1s it surfaced: HONEST-SCOPE now discloses the fleet-wide D41 stub/live seam (47 tools, not just Imagen — the top hostile-judge attack vector) + the `engagement_rate=0` quota artifact; `run-demo.ts` refuses live runs against the shared prod Atlas. Corrected one panel false-alarm (ranker already `gemini-3.5-flash`). *(adversarial KICK + security KICK)*
7. **PRs #18–#20 (operator cleanup) merged** — dead-code + 22/11 agent-count clarity (#18); claudedocs preserved (#19); **KIMI (3P) → gemini-3.5-flash in `crm.enrich` → product is Gemini-only end-to-end** (#20, GAP-K1). *(technical KICK)*
8. **ADK ranker LIVE — PRs #21/#22/#23 + ss-mcp rev `00008-ndg`** — replaced the heuristic with the real ADK SequentialAgent (`gemini-3.5-flash` on Vertex `global`): Model Armor location decouple (#21), reproducible build (#22), an `await`-less `create_session` bug fix (#23). Done via a **no-traffic canary** that caught the config + the session bug before any traffic cut (live stayed on `00006-gg2`). Verified live: real LLM ranking (engagement>0, semantic fit_score + reasoning), no-token=401, Model Armor blocks jailbreak. HONEST-SCOPE row 8 → demonstrated-live. *(technical KICK — the panel's option B, done safely)*

### Deferred / operator-decision items (flagged, not silently dropped)
- **GAP-X1** — remove the dead `creatorRepo.search` `not implemented` throw (zero callers).
- **GAP-K1** — decide whether `KIMI_API_KEY` (3P model, `crm.enrich` only) is acceptable under the Gemini-only framing.
- **ss-landing redeploy** — push the PR #15 a11y fix live (`cd site && gcloud run deploy ss-landing --source=. --project=ss-shared-infra …`) so judges hit the 96-a11y version.
- **SMOKE-TEST-P3/P4/P5.md** still mention `ANTHROPIC_API_KEY` (historical runbooks); **DEVPOST.md** keeps the "built on Claude → lifted to Gemini" Build→Refactor narrative (intentional — operator's strategic copy).
- **Row 2 (live E2E `run-demo.ts`)** needs `.env.local` creds (operator); the live A2A path is independently verified (ss-mcp no-token 401 / demo 200 / documented workflow exec `9cc843c1`).
