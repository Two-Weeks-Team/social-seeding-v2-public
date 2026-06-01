# CHECKLIST.md — final operator submission checklist (single grand-narrative Track 3 entry)

> **Goal**: paste the text into the **single** Devpost Track 3 form + click Submit before **2026-06-05 17:00 PT (2026-06-06 09:00 KST)**.
> **Strategy**: ONE Devpost entry under **Track 3 (Refactor)** telling the whole product as a single **Build → Optimize → Refactor** arc, aimed at the **Overall Grand Prize** (Refactor theme + APAC Regional in range as fallbacks). D50 (grand narrative, supersedes the dual-submission idea D1; D45 single-submission still holds). There is **no second form**.
> **Reference**: D50 (grand narrative, Grand Prize aim) · D45 (single submission) · D6 (Devpost gated invite) · D30 (8× demo recording) · D47-D49 (Track 3 requirement hardening) · D25 (optimize/learning loop).
> **Authority**: This file is the executable runbook. If anything here disagrees with `gcp-research/decisions/DECISIONS.md`, that file wins.
>
> **Time budget**: ~60 minutes wall time if all assets are ready. Add ~3 hours if the YouTube video still needs to upload + process. **Do not start within 3 hours of the deadline.**

---

## 0. Pre-flight gates (must be GREEN before opening Devpost)

| # | Gate | Verify with | Pass criteria | Reference |
|---|------|------------|---------------|-----------|
| G-0 | O1 Devpost console GAPs answered | Devpost team registration page | All 10 GAPs answered: team size, license, video length cap, repo visibility, multi-track rules, IP grant clauses | D6 / O1 |
| G-1 | pytest green | `pnpm exec pytest packages/agents-adk` | `0 failed`, **2932 passed** | brief 2026-05-20 |
| G-1b | **Hardening before/after + holdout reproducible** | `bash scripts/smoke-test/run-hardening-measure.sh` | prints **40.5% → 100.0% (train, +59.5pp)** and **holdout 71.4%** (28.6pp gap), 56 cases (42 train / 14 holdout); rewrites `hardening-before-after.json` + the two trace assets | D25 / D37 / D50 / `HARDENING-CHAPTER.md` |
| G-2 | **Cross-call smoke green within 24 h (now in-workflow)** | `bash scripts/smoke-test/run-integration-a2a.sh` | exit 0; coordinator → a2a_invoke → ss-mcp **inside the brand-campaign Cloud Workflow**; **~3.7s**; 5 creators | D45 |
| G-3 | Live A2A endpoint 200 | `curl -s https://ss-mcp-server-1049119860518.us-central1.run.app/.well-known/agent.json \| jq .protocolVersion` | `"0.3.0"` | I1 / req ④ |
| G-4 | Live Mission Control 200 | `curl -sI https://ss-v2-web-722660901814.us-central1.run.app/api/healthz` | HTTP 200 | I2 / req ② |
| G-5 | Live landing 200 | `curl -sI https://ss-landing-80064221403.us-central1.run.app/` | HTTP 200 | D46 |
| G-6 | The 10 ★ screenshots captured | `ls scripts/demo/submission/screenshots/*.png \| wc -l` | ≥ 10 (the ★ set from `SCREENSHOTS-MANIFEST.md §0`) | `SCREENSHOTS-MANIFEST.md` |
| G-7 | YouTube video uploaded + processing complete | YouTube Studio | Status = "Unlisted, Processing complete"; thumbnail rendered | D30 |
| G-8 | Repository visibility per O1 answer | GitHub repo settings | Public OR private-with-judge-access matching the O1 answer | O1 |
| G-9 | License files exist | `cat LICENSE` | BUSL-1.1 core IP + Apache-2.0 ancillary | D9 |
| G-10 | **Honest-scope table present** | `scripts/demo/submission/HONEST-SCOPE.md` | 16-row production-vs-shipped table (9 GA-real / 4 operator-deploy / 2 Google-Private-Preview); replaces scattered caveats | W5 / `RULES.md` |
| G-11 | **Live-deploy artifacts present** | `ls packages/agents-adk/serve.py gcp-research/refactor-mcp/code/Dockerfile terraform/modules/integration/workflows/brand-campaign-demo.workflows.yaml scripts/deploy/DEPLOY-RUNBOOK.md` | all 4 exist → a live Cloud Workflow execution is a ~3-command operator step | W3 / DEPLOY-RUNBOOK |

If any gate is RED, stop and resolve before proceeding. (G-7 is the only one that may legitimately stay pending while the video processes — do not click Submit until it is green.)

---

## 1. Track 3 official 6-requirement self-check (designed_guide.pdf p.6-7)

Confirm each is still true at submission time — these are the rubric-load-bearing claims:

- [ ] ① **B2B use case** — multi-tenant influencer-campaign SaaS (D11/D12).
- [ ] ② **Migrate to Cloud Run** — `ss-mcp-server` + `ss-v2-web` both live, 200 (G-3, G-4).
- [ ] ③ **Route LLMs through Model Garden** — `publishers/google/models/<id>` routing proven by offline publisher-path test + `deploy/model-garden/README.md` (D47); live smoke operator-gated.
- [ ] ④ **A2A protocol** — agent.json `protocolVersion 0.3.0`; `POST /v1/message:send` returns `task` (G-3).
- [ ] ⑤ **Multi-agent orchestration** — coordinator → a2a_invoke → ss-mcp **inside the brand-campaign Cloud Workflow**, ~3.7s, 5 creators (G-2); 22-agent fleet (D23).
- [ ] ⑥ **A2A intents documented** — `gcp-research/refactor-mcp/A2A-INTENTS.md` (5 exposed / 2 consumed) (D48).
- [ ] + **Agent Identity** — SPIFFE `spiffe://ss-mcp-prod.svc.id.goog/...` (`AGENT-IDENTITY.md`) (D48); mTLS declared, enforcement pending O7 (disclose, do not overclaim).
- [ ] **PDF Build Example #2 match** — `content_verify → get_brand_assets` is a **real A2A v0.3 hop on `ss-mcp`** (W3, transport-exact); callout present (D48/D49; `HONEST-SCOPE.md` row 9).
- [ ] **The 5 GA features (W2) referenced** — Cloud Trace spans, Model Armor sanitize, Vertex AI **Prompt Optimizer (data-driven)** (NOT "Agent Optimizer"), Memory Bank (Firestore default), signed agent card (JWS ES256) + JWKS — all real code, offline-tested, live operator-gated (`HONEST-SCOPE.md` rows 1-5).

## 1b. Grand-narrative (Build → Optimize → Refactor) self-check (D50)

The arc is what aims this at the Grand Prize. Confirm all three stages are evidenced:

- [ ] **BUILD** — 22-agent fleet runs the loop end-to-end (Mission Control demo + smoke).
- [ ] **OPTIMIZE (the hardening climax)** — the stall→repair Observability trace + the **40.5% → 100.0% (train, +59.5pp)** before/after bar are present in the demo AND the submission; reproducible via G-1b. The **holdout split (train 100% / holdout 71.4%, 28.6pp gap)** is shown, leading with the holdout number as the honest headline; the 4 holdout misses are visible (not tuned away). Honest-scope caption present (local deterministic pass; live Vertex AI Prompt Optimizer (data-driven) wired + operator-gated, not run in CI).
- [ ] **REFACTOR** — A2A hop wired into the live brand-campaign Cloud Workflow (~3.7s, 5 creators, G-2); Model Garden (req ③); Agent Identity (req +); real Imagen 4 (1024×1024, 950 KB, D49).

---

## 2. Open the single Devpost form

1. Go to the Devpost gated-invite URL (from D6).
2. Click **Submit a project** → choose **Track 3 — Refactor**. (Do NOT create a second submission for the platform — it is subsumed per D45.)
3. Project title: paste the "Project name" line from `devpost-track3.md`.

---

## 3. Paste each form field (in order)

Copy each matching section from `devpost-track3.md` and paste directly into Devpost. **Do not retype** — copy-paste preserves D-ID citations.

| Devpost field | Source section in `devpost-track3.md` | Word target | Verify |
|---|---|---|---|
| Tagline | "One-line tagline" | ≤ 200 chars | character count under 200 (trim the example numbers if rejected); leads with the 40.5%→100% train / 71.4% holdout + ~3.7s arc |
| Inspiration | "Inspiration" | 100–200 | KR gap → reframe as innovation (D2/D3); APAC Regional in range |
| What it does | "What it does" + "What we hardened" | 250–400 | the 3-stage arc: built fleet + hardened reliability + refactored A2A ecosystem |
| How we built it | "How we built it" | 450–600 | cites D47 (Model Garden), D48 (A2A intents/Identity), D18, D17; include the **6-requirement gate table** + **Build Example #2 match** here; A2A now **in the Cloud Workflow** |
| Challenges we ran into | "Challenges we ran into" | 250–350 | the ambiguous-reply stall (hardening) + KR gap + `/healthz` + Inngest→GCP + CJK (BN-9→D40) |
| Accomplishments | "Accomplishments we're proud of" | 150–250 | **40.5%→100% train / 71.4% holdout (28.6pp gap)** + A2A-in-workflow ~3.7s + 6 requirements + 2932 tests + real Imagen |
| What we learned | "What we learned" | 120–180 | 3 bullets, lead with reliability-as-measurement |
| What's next | "What's next" | 80–150 | Optimizer stub→prod + mTLS enforce + Gemini Enterprise approval + foreign sub-entity + DAM-agent A2A promote |
| Built With | `built-with-tags.txt` | ~80 tags | paste verbatim |
| Business case | "Business case" | 250–350 | $0.01/view (D28) + TAM/SAM/SOM with source labels; ~$1-5/mo envelope |
| Innovation framing | "Innovation framing" | 200–300 | D3 5-step pattern; 3-angle (D29); APAC Regional |
| Honest scope | "Honest scope" | 200–300 | local-pass before/after + Optimizer-stubbed + mTLS-declared + heuristic-ranker disclosures (do not drop) |

---

## 4. Upload images (the 10 ★ set, in order)

Order matters — Devpost shows the gallery in upload order. The grand-narrative arc puts the
**Optimize climax (the before/after bar)** first as the hero. From `SCREENSHOTS-MANIFEST.md §0`:

1. `hardening-before-after-train-100-holdout-71.png` (**hero** — triage routing accuracy 40.5% → 100.0% train, **71.4% holdout** (28.6pp gap kept visible))
2. `observability-stall-repair-trace.png` (the stall→repair reasoning graph, the climax visual)
3. `live-a2a-crosscall-in-workflow.png` (coordinator → a2a_invoke → ss-mcp inside the Cloud Workflow, ~3.7s, 5 creators)
4. `live-agent-json-200.png`
5. `req-gate-table.png`
6. `build-example-2-match.png`
7. `mission-control-fleet.png`
8. `real-imagen-generation.png` (1024×1024, 950 KB)
9. `wow-business-roi-tam.png`
10. `pytest-2932-passing.png`

> If the older screenshot filenames (`live-a2a-crosscall-318ms.png`, `pytest-2713-passing.png`,
> `pytest-2832-passing.png`, `hardening-before-after-42-to-100.png`, `a2a-animation-diagram.png`,
> `ap2-mandate-detail.png`) are still on disk, re-capture them to match the verified numbers (~3.7s,
> 2932, train 100% / holdout 71.4%) and the grand-narrative ordering before upload. The hero MUST be
> the hardening before/after bar (now with the holdout number on it) — it carries both Technical-30%
> and Demo-20%.

---

## 5. Video URL

1. Open YouTube Studio for the demo video.
2. Verify status = "Unlisted, Processing complete" (do NOT submit before processing finishes — Devpost previews the thumbnail and reviewers see a broken player otherwise).
3. Copy the URL (format `https://youtu.be/<11-char-id>`).
4. Paste into Devpost's "Video URL" field.

---

## 6. "Try it out" links

Paste in this order:

1. `https://ss-mcp-server-1049119860518.us-central1.run.app` (live A2A endpoint — probe `/.well-known/agent.json`)
2. `https://ss-v2-web-722660901814.us-central1.run.app` (live Mission Control)
3. `https://ss-landing-80064221403.us-central1.run.app` (live demo landing + report)
4. `https://github.com/Two-Weeks-Team/social-seeding-v2` (repository, BUSL-1.1 + Apache-2.0)
5. `scripts/smoke-test/run-hardening-measure.sh` (re-runnable, $0 — prints 40.5% → 100.0% train / 71.4% holdout)
6. `scripts/smoke-test/run-integration-a2a.sh` (cross-call smoke, exit 0 — ~3.7s, 5 creators)
7. `scripts/demo/submission/HONEST-SCOPE.md` (the single production-vs-shipped table)
8. `scripts/deploy/DEPLOY-RUNBOOK.md` (live Cloud Workflow execution — ~3-command operator step)

---

## 7. Final review before clicking Submit

- [ ] Read the entire Devpost form preview end-to-end one more time.
- [ ] Verify no `<YOUTUBE_URL>` placeholder remains.
- [ ] Verify the **Build → Optimize → Refactor arc** reads as one story (the lead paragraph + the "What we hardened" section + the gate table) — this is what aims it at the Grand Prize (D50).
- [ ] Verify the hardening before/after **40.5% → 100.0% train (+59.5pp)** appears, leading with the honest **holdout 71.4% (28.6pp gap)** + the honest-scope caption (local deterministic pass; Vertex AI Prompt Optimizer wired + operator-gated). Confirm the 4 holdout misses are shown, not hidden.
- [ ] Verify the A2A cross-call number reads **~3.7s, 5 creators**, described as **in the brand-campaign Cloud Workflow** (not just documented).
- [ ] Verify all three live URLs are exact and resolve (G-3, G-4, G-5).
- [ ] Verify the Tagline character count is ≤ 200.
- [ ] Verify the **Honest scope** content is present and references **`HONEST-SCOPE.md`** as the single production-vs-shipped table (the load-bearing headlines stay inline; the full 16-row table is the linked source) — do not silently drop it; honest disclosure is part of the Innovation contribution.
- [ ] Verify the **Imagen clarification** is present: the real 1024×1024 image is from the standalone `gen_sample_image.py`; the in-fleet `creative` agent's imagen tool is W7-staged (live = `NotImplementedError`). Do not imply the creative agent generated it live.
- [ ] Verify the **"Agent Optimizer" misnomer is corrected** everywhere — the GA product is the Vertex AI **Prompt Optimizer (data-driven / VAPO)**; the local deterministic pass demonstrates the before/after, the GA Prompt Optimizer is the production path.
- [ ] Verify the **5 GA features (W2)** are credited as real-code/offline-tested/live-operator-gated (Cloud Trace, Model Armor, Prompt Optimizer, Memory Bank, signed agent card + JWKS) and the **DAM hop reads as a real A2A v0.3 call** (W3).
- [ ] Verify the 6-requirement gate table renders (no broken markdown table).
- [ ] Verify all 10 screenshots upload successfully — confirm the **hero is the train-100%/holdout-71.4% before/after bar** (click each preview to confirm it loads).
- [ ] Verify the video URL preview shows the YouTube player with the correct thumbnail.
- [ ] Spot-check 3 random D-IDs cited in the paste actually exist in `DECISIONS.md`.

---

## 8. Click **Submit**

After clicking Submit:
- [ ] Save the confirmation URL (`https://<devpost-event>.devpost.com/submissions/<id>`) to `scripts/demo/submission/CONFIRMATION.txt`.
- [ ] Screenshot the confirmation page to `screenshots/devpost-confirmation.png`.

---

## 9. Post-submit verification

- [ ] Re-open the submission and verify Devpost rendered the markdown correctly (no broken links, no escaped backticks, table intact).
- [ ] Click your own video URL — verify YouTube serves the player without "Video unavailable".
- [ ] Click your own GitHub URL — verify the README renders.
- [ ] Click the three live URLs — verify all respond.
- [ ] Check Devpost team member list — verify all collaborators are tagged (per O1 team-size answer).
- [ ] Email yourself the confirmation URL as a permanent record.

---

## 10. Rollback / re-submit (if Devpost allows edits)

Devpost typically allows edits until the deadline. If a defect is found:

1. **Do not delete the submission.** Use the Edit button on the Devpost dashboard.
2. **Edit the specific field**, not the whole form (preserves any judge notes).
3. **Re-upload images only if necessary** — duplicate uploads count against the 10-per-submission limit until the page refreshes.
4. **Re-save** and verify the change rendered correctly.
5. Log the change in `scripts/demo/submission/EDIT-LOG.txt` with timestamp + field + reason.

If Devpost does NOT allow edits after submit (gated-invite events sometimes lock), the submission is final. Do not submit a duplicate; contact the Devpost moderator.

---

## 11. After-submit follow-ups (informational, not blocking)

- **Watch for judge questions** on the Devpost submission page; reply within 24 h.
- **Keep the three Cloud Run services warm** through the judging window (Cloud Scheduler warm-up cron, D46); they are `min=0` otherwise.
- **Tag the repo** at the submission SHA: `git tag -a v1.0.0-devpost-submission -m "Frozen at Devpost submission 2026-06-0X"`.
- **Update `STATUS-REPORT-UNIFIED.md`** with the confirmation URL + final closure note.
- **Track O7 Gemini Enterprise / Agent Gateway allowlist** weekly until it clears (Gemini Enterprise enrollment is on Google's 1-2 week window; Agent Gateway mTLS is in Google Private Preview).
- **Capture a live Cloud Workflow execution** via `scripts/deploy/DEPLOY-RUNBOOK.md` (~3-command operator step) if a judge asks for the live deploy beyond the offline proofs.
- **Track O10 foreign sub-entity** decision per the $1k MRR trigger.
- **Resolve O-A..O-E** to promote `ss-mcp-server` from the heuristic ranker to the full multi-container topology (`HONEST-SCOPE.md` row 8).

---

## 12. If anything is unclear

- **Operator's primary instruction**: paste text into the single Track 3 Devpost form + click Submit before 2026-06-05 17:00 PT. Nothing else.
- **For Devpost-form questions** (field location, character limit): the Devpost console preview is the source of truth.
- **For content questions** (is this claim right): `gcp-research/decisions/DECISIONS.md` is the source of truth; cite the D-ID in any edit.
- **For deadline questions**: deadline is **2026-06-05 17:00 PT** (= **2026-06-06 09:00 KST**) — per CLAUDE.md / Google's official announcement (corrects a prior 23:59 PT typo, issue #31). Submit ≥ 6 hours early to allow recovery from any Devpost or YouTube outage.

---

**End of `CHECKLIST.md`.** When the submission is confirmed, append the confirmation timestamp here as the final step.
