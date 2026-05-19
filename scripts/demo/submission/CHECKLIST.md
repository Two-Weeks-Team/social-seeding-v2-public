# CHECKLIST.md — final operator submission checklist

> **Goal**: paste the text into Devpost forms + click Submit before **2026-06-05 23:59 PT (2026-06-06 15:59 KST)**.
> **Reference**: D6 (Devpost gated invite accepted) + D1 (dual submission) + D30 (8× demo recording).
> **Authority**: This file is the executable runbook for the submission. If anything in this file disagrees with `gcp-research/decisions/DECISIONS.md`, that file wins.
>
> **Time budget**: ~90 minutes wall time for both submissions if all assets are ready. Add ~3 hours if YouTube videos still need to upload + process. **Do not start within 3 hours of the deadline.**

---

## 0. Pre-flight gates (must be GREEN before opening Devpost)

| # | Gate | Verify with | Pass criteria | Reference |
|---|------|------------|---------------|-----------|
| G-0 | O1 Devpost console GAPs answered | Inspect Devpost team registration page | All 10 GAPs answered: team size, license, video length cap, repo visibility, multi-track rules, IP grant clauses | D6 / O1 |
| G-1 | `pnpm run verify-build` green | Run in repo root | exit 0; lint + tsc + build all pass | D43 |
| G-2 | Smoke test green within 24 h | `bash scripts/smoke-test/run-brand-campaign.sh` | exit 0; 22/22 agents; 50/50 tools; <30 s wall | D43 |
| G-3 | pytest 2,668 passing | `pnpm exec pytest packages/agents-adk` | `0 failed`, ≥2,668 passed | `STATUS-REPORT.md §2` |
| G-4 | All 24 screenshots captured | `ls scripts/demo/submission/screenshots/*.png \| wc -l` | ≥24 | `SCREENSHOTS-MANIFEST.md` |
| G-5 | YouTube videos uploaded + processing complete | Visit YouTube Studio for each | Both videos status = "Unlisted, Processing complete"; thumbnail rendered | D30 |
| G-6 | Track 3 Marketplace Producer Portal submitted | Producer Portal → Listings → `tiktok-mcp` | Status = PENDING with KR disclosure visible | D2 / D3 |
| G-7 | Live demo URLs reachable | `curl -sI <CLOUD_RUN_WEB_URL>` + `curl -sI https://mcp.socialseed.ing/.well-known/agent.json` | Both return HTTP 200 | W7 |
| G-8 | Repository is public OR private-with-judge-access per O1 answer | GitHub repo visibility settings | Matches the O1 answer | O1 |
| G-9 | License files exist on both repos | `cat LICENSE` on each repo | `BUSL-1.1` core IP, `Apache-2.0` for ancillary code in Track 3 | D9 |

If any gate is RED, stop and resolve before proceeding.

---

## 1. Track 2 — `social-seeding-v2` Devpost submission

### 1.1 Open the form

1. Go to `https://socialseed.ing.devpost.com` (or the actual gated-invite URL from D6).
2. Click **Submit a project** → choose **Track 2 — Optimize an existing prototype**.
3. Project title: paste `social-seeding-v2` from `devpost-track2.md` "Project name" section.

### 1.2 Paste each form field (in order)

For each field below, copy the matching section from `devpost-track2.md` and paste it directly into Devpost. **Do not retype** — copy-paste preserves D-ID citations.

| Devpost field | Source section in `devpost-track2.md` | Word target | Verify |
|---------------|---------------------------------------|-------------|--------|
| Tagline | "One-line tagline" | ≤200 chars | character count under 200 |
| Inspiration | "Inspiration (Devpost field: Inspiration)" | 100–200 | one paragraph, narrative |
| What it does | "What it does" | 100–200 | mentions 22-agent fleet, AP2 gates |
| How we built it | "How we built it" | 400–500 | cites D15, D17, D18, D21, D25, D27, D31 inline |
| Challenges we ran into | "Challenges we ran into" | 200–300 | Inngest migration + KR gap + AP2 preview |
| Accomplishments | "Accomplishments we're proud of" | 150–250 | 8× cost drop + 354 tests + 22 agents |
| What we learned | "What we learned" | 100–150 | 3 bullets |
| What's next | "What's next" | 80–150 | 7 bullets; includes cost_watch RLHF + Bigtable + foreign sub-entity |
| Built With | `built-with-tags.txt` Track 2 section, comma-separated | ~80 tags | paste verbatim |
| Business case | "Business case" section | 250–350 | $10K MRR + TAM/SAM/SOM napkin math |
| Differentiation | "Differentiation" section | 250–350 | 3 angles, each with proof |

### 1.3 Upload images (≤10 of T2-01..T2-14)

Order matters — Devpost shows the gallery in upload order. Recommended order from `SCREENSHOTS-MANIFEST.md §5`:

1. `t2-mission-control-intake-01.png` (hero)
2. `t2-agent-fleet-overview.png`
3. `t2-ap2-mandate-detail.png`
4. `t2-approvals-bulk-approve.png`
5. `t2-workflows-canvas.png`
6. `t2-cloud-trace-spans.png`
7. `t2-dialogflow-cx-widget.png`
8. `t2-smoke-test-green.png`
9. `t2-cloud-deploy-canary.png`
10. `t2-model-armor-policy.png`

### 1.4 Video URL

1. Open YouTube Studio for the Track 2 video.
2. Verify status = "Unlisted, Processing complete" (do NOT submit before processing finishes — Devpost previews the thumbnail and reviewers see a broken player otherwise).
3. Copy the URL from the address bar (format `https://youtu.be/<11-char-id>`).
4. Paste into Devpost's "Video URL" field.

### 1.5 "Try it out" links

Paste these in the order shown:

1. `https://github.com/Two-Weeks-Team/social-seeding-v2`
2. `<CLOUD_RUN_WEB_URL>` (the live Mission Control)
3. `https://github.com/Two-Weeks-Team/social-seeding-v2/pull/1` (the W1-W4 + Phase 6-8 baseline PR)

### 1.6 Final review before clicking Submit

- [ ] Read the entire Devpost form preview end-to-end one more time.
- [ ] Verify no `<YOUTUBE_TRACK2_URL>` or `<CLOUD_RUN_WEB_URL>` placeholders remain.
- [ ] Verify all D-IDs cited in the paste actually exist in `DECISIONS.md` (spot-check 3 random IDs).
- [ ] Verify the Tagline character count is ≤ 200.
- [ ] Verify all 10 screenshots upload successfully (Devpost shows previews; click each to verify it loads).
- [ ] Verify the video URL preview shows the YouTube player with the correct thumbnail.

### 1.7 Click **Submit** for Track 2

After clicking Submit:
- [ ] Save the submission confirmation URL (`https://socialseed.ing.devpost.com/submissions/<id>`) to `scripts/demo/submission/CONFIRMATION-TRACK-2.txt`.
- [ ] Take a screenshot of the confirmation page to `screenshots/t2-devpost-confirmation.png`.

---

## 2. Track 3 — `tiktok-mcp-server` Devpost submission

### 2.1 Open the form

1. Same Devpost gated-invite URL.
2. Click **Submit a project** → choose **Track 3 — Refactor for Cloud Marketplace / Gemini Enterprise**.
3. Project title: paste `tiktok-mcp-server` from `devpost-track3.md`.

### 2.2 Paste each form field

| Devpost field | Source section in `devpost-track3.md` | Word target | Verify |
|---------------|---------------------------------------|-------------|--------|
| Tagline | "One-line tagline" | ≤200 chars | character count under 200 |
| Inspiration | "Inspiration" | 100–200 | KR gap + reframe as innovation (D2/D3) |
| What it does | "What it does" | 100–200 | dual MCP + A2A surfaces, 4 tools |
| How we built it | "How we built it" | 400–500 | cites D14, D17, D19, D21, D28, D32 |
| Challenges we ran into | "Challenges we ran into" | 200–300 | KR gap + Watchtower cutover + MCP session affinity |
| Accomplishments | "Accomplishments we're proud of" | 150–250 | PENDING listing + 4-step eval + A2A native |
| What we learned | "What we learned" | 100–150 | 2 bullets |
| What's next | "What's next" | 80–150 | foreign sub-entity + Instagram + SOC2 + AP2 Cart |
| Built With | `built-with-tags.txt` Track 3 section, comma-separated | ~60 tags | paste verbatim |
| Business case | "Business case" section | 250–350 | $3K MRR + TAM/SAM/SOM napkin math |
| Differentiation | "Differentiation" section | 200–300 | 3 angles |
| Innovation framing | "Korean-region gap section" | 250 | D3 reframing, 5-step pattern |

### 2.3 Upload images (10 of T3-01..T3-10)

Order:

1. `t3-marketplace-pending.png` (hero — the PENDING listing visual)
2. `t3-marketplace-listing-page.png`
3. `t3-gemini-enterprise-chat.png`
4. `t3-cloud-run-agent-deployed.png`
5. `t3-agent-runtime-card.png`
6. `t3-a2a-well-known.png`
7. `t3-identity-platform-tenant.png`
8. `t3-apigee-meter-dashboard.png`
9. `t3-model-armor-block.png`
10. `t3-chronicle-evidence-pack.png`

### 2.4 Video URL

Same as Track 2 §1.4, with the Track 3 YouTube URL.

### 2.5 "Try it out" links

1. `https://github.com/Two-Weeks-Team/tiktok-mcp-server`
2. `https://mcp.socialseed.ing` (the live MCP endpoint)
3. `https://mcp.socialseed.ing/.well-known/agent.json` (the A2A surface)

### 2.6 Final review before clicking Submit

- [ ] Read the entire Devpost form preview end-to-end.
- [ ] Verify no `<YOUTUBE_TRACK3_URL>` or `<CLOUD_RUN_MCP_URL>` placeholders remain.
- [ ] Verify the KR-payment-region disclosure is visible in the Inspiration + Innovation sections (the contribution per D3).
- [ ] Verify the PENDING listing screenshot is the first gallery image (hero).
- [ ] Verify the Tagline character count is ≤ 200.

### 2.7 Click **Submit** for Track 3

After clicking Submit:
- [ ] Save the confirmation URL to `scripts/demo/submission/CONFIRMATION-TRACK-3.txt`.
- [ ] Screenshot the confirmation page to `screenshots/t3-devpost-confirmation.png`.

---

## 3. Post-submit verification

- [ ] **Re-open both submissions** and verify Devpost rendered the markdown correctly (no broken links, no escaped backticks).
- [ ] **Click your own video URL** — verify YouTube serves the player without "Video unavailable".
- [ ] **Click your own GitHub URL** — verify the README renders.
- [ ] **Click the live demo URLs** — verify both Cloud Run endpoints respond.
- [ ] **Check Devpost team member list** — verify all collaborators are tagged correctly (per O1 team-size answer).
- [ ] **Email yourself** the two confirmation URLs as a permanent record.

---

## 4. Rollback / re-submit (if Devpost allows edits)

Devpost typically allows edits until the deadline. If a defect is found:

1. **Do not delete the submission.** Use the Edit button on the Devpost dashboard.
2. **Edit the specific field**, not the whole form (preserves any judge notes).
3. **Re-upload images only if necessary** — duplicate uploads count against the 10-per-track limit until the page is refreshed.
4. **Re-save** and verify the change rendered correctly.
5. Log the change in `scripts/demo/submission/EDIT-LOG.txt` with timestamp + field + reason.

If Devpost does NOT allow edits after submit (gated-invite challenges sometimes lock), the submission is final. Do not submit a duplicate; contact the Devpost moderator.

---

## 5. After-submit follow-ups (informational, not blocking)

- **Watch for judge questions** on the Devpost submission page; reply within 24 h.
- **Pause the demo Cloud Run services** at the end of the judging window to save on D39 credits (`gcloud run services update --no-traffic` per region).
- **Tag the repo** at the submission SHA: `git tag -a v1.0.0-devpost-submission -m "Frozen at Devpost submission 2026-06-0X"` on both repos.
- **Update `STATUS-REPORT.md`** with submission confirmation URLs and the W9 final closure note.
- **Track O7 Agent Gateway Private Preview allowlist** application status weekly until it clears.
- **Track O10 foreign sub-entity** decision per the $1k MRR threshold trigger.

---

## 6. If anything is unclear

- **Operator's primary instruction** (per the W9 brief): paste text into Devpost forms + click Submit before 2026-06-05 23:59 PT. Nothing else.
- **For Devpost-form questions** (where does this field live, what is the character limit): the Devpost console preview is the source of truth.
- **For content questions** (is this paragraph right, does this claim hold): `gcp-research/decisions/DECISIONS.md` is the source of truth; cite the D-ID in any edit.
- **For deadline questions**: deadline is **2026-06-05 23:59 PT** (= **2026-06-06 15:59 KST**). Do not push to the wire — submit ≥ 6 hours early to allow recovery from any Devpost or YouTube outage.

---

**End of `CHECKLIST.md`.** When both submissions are confirmed, append the confirmation timestamps to this file as the final step.
