# Storyboard — Track 2 (`social-seeding-v2`, Mission Control + AP2 + Multi-agent)

> **Authority**: implements **D30** (8× speed real-mouse recording, no slides, no narration script) +
> **D34** (4 locales: ko/en/ja/zh-CN) + **D29** (three differentiation angles: Agent-as-function ·
> KR-region-gap · Multimodal+AP2+Multi-agent) per `gcp-research/decisions/DECISIONS.md`.
> Operating manual for the OBS session that produces `recording-track2-source.mov` (24 min raw).
>
> **Companion files**: `STORYBOARD-track3.md` (MCP server demo), `RECORDING-CHECKLIST.md`
> (pre-record gate), `ffmpeg-8x.sh` (8× compression + overlay burn), `subtitles/track2-*.srt`
> (skeletons keyed to the scenes below), `SUMMARY.md` (overview tying it all together).
>
> **Compression math**: 24 min source → 3:00 final at 8× (`setpts=PTS/8`, three chained
> `atempo=2.0` per `gcp-research/demo/SCRIPT.md` §2.3). Each scene below shows real-time and
> 8×-compressed duration; subtitle files use 8× timings.
>
> **What this storyboard adds** on top of `gcp-research/demo/SCRIPT.md`: the SCRIPT defines
> 6 narrative beats × 30 s of final video. This file decomposes those beats into the **actual
> mouse-clicks the operator must perform**, with per-scene D29 angle attribution and
> `__OPERATOR_CAPTURE__` markers so the operator never has to ad-lib at OBS time.

---

## 0. Operator at-a-glance

| | Real time | 8× final time |
|---|---|---|
| Total | **24:00** | **3:00** |
| Scenes | **12** | (same 12 with proportional shrink) |

12 scenes (not 6) because the narration-driven SCRIPT.md beats are too coarse for an operator's
mouse-click list. Each storyboard scene is one continuous mouse action sequence — no scene cuts,
no slide swaps, no narration overdub.

Tabs to open before pressing Record (in this exact left-to-right order in the browser tab strip):

1. **Tab 1**: `http://localhost:3000/campaigns/new` — intake (Scene 1, 5, 12 system check)
2. **Tab 2**: `http://localhost:3000/approvals` — approvals queue (Scene 3, 7, 9)
3. **Tab 3**: `http://localhost:3000/campaigns` — campaign detail + AP2 mandate page (Scene 2, 4, 6, 8)
4. **Tab 4**: `http://localhost:3000/usage` — cost ledger + Dialogflow CX widget (Scene 10, 11)

Terminal layout (OBS Scene C, split-source — only visible in Scenes 1, 6, 12):

- Left pane: `pnpm exec tsx scripts/run-demo.ts --type=brand` (live driver)
- Right pane: `python scripts/smoke-test/brand_campaign_smoke.py` (system check; Scene 12 only)

D-ID references for each scene point to:

- **`D29-A`** = Agent-as-function (each agent is a typed function with USD cap + Zod output)
- **`D29-B`** = KR-region-gap (Marketplace exclusion → A2A-only distribution path)
- **`D29-C`** = Multimodal + AP2 + Multi-agent (image+text+structured payloads, Intent Mandate)

---

## Scene 1 — Brand brief intake (Agent-as-function in action)

| Field | Value |
|---|---|
| **Real-time duration** | 90 s (00:00:00 → 00:01:30) |
| **8×-compressed duration** | ~11 s (final 00:00:00 → 00:00:11) |
| **D29 angle** | **D29-A** Agent-as-function — the intake collapses 4 prompts into one typed Zod call |
| **Tools visible** | Tab 1 (`/campaigns/new`), Terminal (left pane shows `run-demo.ts --type=brand` boot log) |

**Narrative bullet (what the viewer sees)**:

A brand marketer opens Mission Control. They paste a one-paragraph brief into the intake textarea
("We want 40 TikTok creators, MX$60-day window, beauty/lifestyle, gen-Z, $0.01/view budget").
Submit. The intake-agent function runs in the terminal pane: typed input ⇒ `BrandBriefSchema`
(Zod) ⇒ `IntakeAgent.exec()` returns `CampaignDraft`. The draft renders in-page in 4 seconds.

**Mouse-click sequence** (operator):

1. `__OPERATOR_CAPTURE__` Click into Tab 1.
2. Single-click into the textarea (already focused; no second click).
3. Paste the brief from clipboard (operator pre-stages it via `pbcopy`; see RECORDING-CHECKLIST.md §3).
4. Click "Submit brief" — the only primary button on the page.
5. Wait 4 s (real) for the `CampaignDraft` card to render. **Do not move the mouse during this wait.**
6. Hover over the `Cost cap: $400` chip for 2 s so the tooltip ("agent USD cap from D41") shows.
7. Hover the `Agent function: intake-v3` chip for 2 s.

**Why D29-A is provable on screen**: the chips ("Cost cap", "Agent function") are populated by the
agent's typed contract — there is no free-form text — and the tooltips name the Zod schema. The
viewer sees one click + structured output, not a chat-bot loop.

---

## Scene 2 — AP2 Intent Mandate signing (Multimodal + AP2 + Multi-agent)

| Field | Value |
|---|---|
| **Real-time duration** | 60 s (00:01:30 → 00:02:30) |
| **8×-compressed duration** | ~7.5 s (final 00:00:11 → 00:00:18.5) |
| **D29 angle** | **D29-C** Multimodal + AP2 + Multi-agent — explicit Intent Mandate per D27 |
| **Tools visible** | Tab 3 (`/campaigns/<id>/mandate`), Mission Control AP2 modal |

**Narrative bullet**:

The campaign detail page surfaces an "Authorize AP2 Intent Mandate" card. The marketer clicks it.
A modal appears showing the mandate fields: `actor=marketer`, `principal=brand_workspace_42`,
`scope=outreach+payment`, `cap=$400`, `expiry=72h`. The marketer reviews the JSON preview, clicks
"Sign with workspace key". The modal flashes "Mandate signed (Ed25519 sig: 0x9a3f…)" and the AP2
chip in the campaign header flips from grey to green.

**Mouse-click sequence**:

1. `__OPERATOR_CAPTURE__` Click Tab 3 (already on the new campaign detail page from Scene 1's redirect).
2. Scroll once to bring the "AP2 Intent Mandate" card into the upper third of the viewport.
3. Click "Review mandate" → modal opens.
4. Hover (do not click) the `scope: outreach+payment` row for 2 s so the inline help shows
   "Per D27 — Intent only. Cart/Payment Mandate deferred."
5. Click "Sign with workspace key" — the only primary action.
6. Wait 3 s — modal closes itself, chip flips to green, toast "Mandate AP2-Int-001 active" appears.
7. Hover the green AP2 chip in the header for 2 s so the verify-signature tooltip shows.

**Why D29-C is provable on screen**: the JSON preview is visible (not a black-box "approved"
button); the cryptographic signature line is visible; the chip change is the audit-evidence
proof.

---

## Scene 3 — Approvals page bulk-approve sourcing batch

| Field | Value |
|---|---|
| **Real-time duration** | 45 s (00:02:30 → 00:03:15) |
| **8×-compressed duration** | ~5.6 s (final 00:00:18.5 → 00:00:24.1) |
| **D29 angle** | **D29-A** Agent-as-function — sourcing agent returns 40 typed `CreatorMatch` rows |
| **Tools visible** | Tab 2 (`/approvals`) |

**Narrative bullet**:

The marketer switches to the Approvals tab. 40 sourcing-agent matches are stacked, each with
creator handle, follower count, niche-confidence, USD bid, and a "view profile" deep-link.
The marketer clicks "Select all in batch", then "Approve 40 → outreach". A green progress bar
fills as Inngest workflow steps fire.

**Mouse-click sequence**:

1. `__OPERATOR_CAPTURE__` Click Tab 2.
2. Click the "Filter: Pending sourcing" pill in the toolbar (already at top of list).
3. Click the master checkbox "Select all in current batch" (header row).
4. Wait 1 s so the count chip "40 selected" updates and the bulk-actions toolbar slides down.
5. Click the green "Approve 40 → outreach" button.
6. **Do not move the mouse** for 6 s while the SSE stream updates each row from "pending" → "approved"
   in turn. The 6 s is intentional — at 8× this becomes 0.75 s of visible progress animation.
7. Hover the toolbar-completed badge "40/40 approved · workflow=brand-campaign-v3" for 2 s.

**Why D29-A is provable on screen**: every row in the approval list has the agent name
(`sourcing-v2`), USD-spent ($0.012 per row), and the typed output contract version
(`CreatorMatch@1.4.0`). The bulk action is one click, not 40 clicks — the agent did the per-row
work.

---

## Scene 4 — Outreach agent drafts → human gate

| Field | Value |
|---|---|
| **Real-time duration** | 120 s (00:03:15 → 00:05:15) |
| **8×-compressed duration** | ~15 s (final 00:00:24.1 → 00:00:39.1) |
| **D29 angle** | **D29-A** + **D29-C** — typed agent fn + multimodal (image inspiration brief) |
| **Tools visible** | Tab 3 (`/campaigns/<id>/outreach`), Gmail in tab side-panel |

**Narrative bullet**:

The marketer clicks into the campaign's "Outreach drafts" pane. 12 draft emails are visible
(the outreach-agent generates one per top-12 creator, throttled). Each draft shows: creator
handle, draft subject, draft body, attached inspiration image (auto-selected by Gemini Vision),
predicted reply-rate (%). The marketer opens draft #3, edits the second sentence, clicks
"Send via Gmail". The Gmail compose pane on the right confirms the send to
`app.2weeks@gmail.com` (D10 test-account-only).

**Mouse-click sequence**:

1. Click "Outreach drafts" tab in the campaign sub-nav.
2. Wait 4 s for the 12-card grid to lazy-load (real OutreachAgent latency at p50).
3. Click draft card #3.
4. Detail pane opens on the right. `__OPERATOR_CAPTURE__` Click into the body textarea, position
   cursor at the start of sentence 2, **type one short sentence** ("Quick note: we love your
   Berlin haul series.") — this proves the human edit is real, not auto-generated.
5. Click the green "Send via Gmail" button.
6. Wait 5 s for the Gmail iframe in the right panel to reload with "Sent · just now".
7. Hover the "Sent" tag for 2 s so the receipt timestamp tooltip shows.
8. Click "Back to draft list".
9. Click draft #4 → click "Send via Gmail" (no edit this time — proves the agent's first-pass quality).
10. Wait 4 s. Repeat for draft #5 (third send to demonstrate consistency).
11. Hover the green-progress chip "3/12 sent" for 2 s.

**Why D29-A + D29-C is provable on screen**: typed `OutreachDraft` schema visible on each card;
multimodal because each draft has an attached image; the human gate (manual edit + click) is
explicit, satisfying D27's "agent plans, human approves payment" constraint.

---

## Scene 5 — Reply-agent listens for inbox reply (D29-B subtext)

| Field | Value |
|---|---|
| **Real-time duration** | 90 s (00:05:15 → 00:06:45) |
| **8×-compressed duration** | ~11 s (final 00:00:39.1 → 00:00:50.4) |
| **D29 angle** | **D29-A** Agent-as-function; voiced subtext: **D29-B** — no Marketplace path in KR, the agent IS the channel |
| **Tools visible** | Tab 4 (`/usage` first), then Tab 3 (`/campaigns/<id>/inbox`) |

**Narrative bullet**:

The marketer briefly checks Tab 4 (cost ledger — sees $1.34 spent so far, well under cap). Then
switches to the inbox sub-tab of the campaign. A creator has replied. The reply-agent has
already classified it as `interest=high, contract_terms_requested=true` (chip on the row). The
marketer clicks the row; the agent's suggested next action ("Generate AP2 Cart Mandate +
contract PDF") is queued in the approvals tray.

**Mouse-click sequence**:

1. Click Tab 4 once. **Do not interact** — just hover the "$1.34 / $400 cap" big-number for 3 s.
2. Click back to Tab 3.
3. Click "Inbox" in the campaign sub-nav.
4. Wait 5 s — an "unread reply" toast slides in (Inngest sub.publish fired by the reply-agent).
5. Click the unread row.
6. The detail pane shows: original reply text, agent's structured extraction
   (`InterestLevel=high`, `RequestedTerms=["NDA","Net-30"]`), and a suggested next action card.
7. `__OPERATOR_CAPTURE__` Click "Queue: Cart Mandate + contract PDF".
8. A toast appears "Queued in /approvals (pending human gate)".
9. Hover the toast's "View in approvals" link for 2 s so the underline animation plays.

**Why D29-B subtext is on screen**: a small grey banner above the inbox says *"Distributing via
A2A — no Marketplace listing required."* This is the only verbal D29-B cue in the demo; everything
else is visual.

---

## Scene 6 — Shipping logistics + delivery confirmation (Multi-agent fan-out)

| Field | Value |
|---|---|
| **Real-time duration** | 120 s (00:06:45 → 00:08:45) |
| **8×-compressed duration** | ~15 s (final 00:00:50.4 → 00:01:05.4) |
| **D29 angle** | **D29-C** Multi-agent — ship-agent + customs-agent + tracking-agent collaborate |
| **Tools visible** | Tab 3 (`/campaigns/<id>/shipping`), Terminal (left pane shows multi-agent log lines) |

**Narrative bullet**:

The marketer opens the Shipping tab. 12 logistics cards (one per shipped creator). Each card
shows three sub-agent statuses stacked vertically:
- `ship-agent`: carrier=DHL, weight=420g, label=printed
- `customs-agent`: HS-code=3304.99 (cosmetics), value=USD 80 — declared
- `tracking-agent`: ETA=2026-05-23, last scan=Singapore hub

The marketer scrolls through, hovers a card to see the fan-out trace
(`workflow.fanout.parallel=3`).

**Mouse-click sequence**:

1. Click "Shipping" sub-nav.
2. Wait 6 s — cards lazy-load in a staggered cascade (real fan-out latency; 8× compresses to
   crisp staggered slide-in).
3. Scroll once (one trackpad swipe) to bring card #6 into view.
4. Hover card #3 for 4 s — the trace tooltip expands showing the 3 sub-agent timing breakdown.
5. Switch to terminal pane briefly (Cmd+Tab to the terminal app).
6. Show the terminal log scrolling: `[ship-agent] HS-3304.99 ok`, `[customs-agent] declared
   USD 80`, `[tracking-agent] AWB 7234-1029 issued`. **Do not type anything.**
7. Cmd+Tab back to browser.
8. Hover the top-of-page "3 sub-agents · parallel" badge for 2 s.

**Why D29-C is provable**: three named agent functions visible per card (not "one ship robot");
the terminal pane shows them running in parallel via Inngest; the badge cites the contract.

---

## Scene 7 — Verify-agent confirms delivery + view count (KR-region-gap reframe surfaces)

| Field | Value |
|---|---|
| **Real-time duration** | 90 s (00:08:45 → 00:10:15) |
| **8×-compressed duration** | ~11 s (final 00:01:05.4 → 00:01:16.6) |
| **D29 angle** | **D29-B** KR-region-gap — verify-agent IS the distribution measurement (no Marketplace analytics) |
| **Tools visible** | Tab 2 (`/approvals`), Tab 3 (`/campaigns/<id>/verify`) |

**Narrative bullet**:

The marketer switches to Approvals. A new card is on top: "verify-agent: 12 creators reported
delivery — 9 posted within 72h, 3 outstanding". They click approve to release first-tranche
payment for the 9 confirmed. Then switches to the campaign's Verify tab — a TikTok view-count
graph populates live, showing $0.01/view metering per D28.

**Mouse-click sequence**:

1. Click Tab 2.
2. Click the topmost row (verify-agent result).
3. Detail pane on the right shows: 12 creator rows, each with `delivery_confirmed=YES/NO`,
   `posted=YES/NO`, `tiktok_url=...`, `current_views=N`.
4. Click "Approve 9 (confirmed) → release first-tranche $90".
5. Wait 3 s for SSE update — rows flip from "pending payment" → "paid".
6. Click Tab 3.
7. Click "Verify" sub-nav.
8. Wait 5 s — line chart renders showing current-views growth curve, with a per-view-cost
   ticker live-updating ($0.01 × views).
9. Hover the ticker for 3 s so the D28 tooltip ("Per-delivered-view pricing — ROI-linked") shows.
10. Scroll once to bring the per-creator view breakdown table into view.

**Why D29-B is provable**: the "no Marketplace" subtext repeats — the verify-agent is the only
proof-of-delivery; if this were a Marketplace listing, Marketplace would own this graph. The
agent owns it instead.

---

## Scene 8 — AP2 Cart Mandate (still Intent only per D27 — explicit on-screen)

| Field | Value |
|---|---|
| **Real-time duration** | 60 s (00:10:15 → 00:11:15) |
| **8×-compressed duration** | ~7.5 s (final 00:01:16.6 → 00:01:24.1) |
| **D29 angle** | **D29-C** — AP2 Cart Mandate **explicitly deferred**, screen shows the deferred-state UI |
| **Tools visible** | Tab 3 (`/campaigns/<id>/mandate?step=cart`) |

**Narrative bullet**:

The marketer navigates to the second-stage mandate. The Cart Mandate UI is deliberately a
**read-only preview** — per D27, only Intent Mandate is shipped day-1. The page shows the
Cart Mandate fields populated (line items: 9 creators × $10 = $90) with a banner "Cart Mandate
preview — final approval gate is human until D27 is relaxed". The marketer clicks "Approve
release as human" (the manual gate), and the payment Webhook fires.

**Mouse-click sequence**:

1. Click the breadcrumb "Mandate" in the campaign header.
2. Click the second tab "Cart Mandate (preview)".
3. Page renders with the orange banner "AP2 Cart Mandate preview — per D27 this is the
   human-approval-only stage. Cart auto-execution deferred."
4. Hover the banner for 3 s so the D27 link tooltip shows.
5. Scroll to bring the line-items table fully visible.
6. Click "Approve release ($90) as human".
7. Wait 4 s — banner flips green: "Payout webhook fired (stub: app.2weeks@gmail.com)".
8. Hover the new "Stripe payout ID stub_pi_4f29..." chip for 2 s.

**Why D29-C is provable as a *safety* statement**: the UI tells the truth — "we did not give the
agent the payment key". This is more credible than a fully-autonomous flow, and judges will
read it as compliance-aware.

---

## Scene 9 — Approval queue empties (final report card auto-generated)

| Field | Value |
|---|---|
| **Real-time duration** | 60 s (00:11:15 → 00:12:15) |
| **8×-compressed duration** | ~7.5 s (final 00:01:24.1 → 00:01:31.6) |
| **D29 angle** | **D29-A** — report-agent emits typed `CampaignReport` artifact |
| **Tools visible** | Tab 2 (`/approvals`), Tab 3 (`/campaigns/<id>/report`) |

**Narrative bullet**:

The marketer returns to /approvals. The queue is empty — the loop has closed. They click into
the campaign and tap "View report". The report-agent has produced a printable summary card:
spend, creators-shipped, posts-live, views-to-date, ROI projection. Multimodal: includes an
auto-generated visual recap (4 thumbnails of top-performing posts).

**Mouse-click sequence**:

1. Click Tab 2.
2. The empty-state hero "🎉 All caught up — 0 pending" is on screen. Hover for 2 s.
3. Click "Open recently-completed campaign" CTA.
4. The campaign detail page opens, defaulting to the Report tab.
5. Wait 4 s for the report card to render (real artifact-generation latency).
6. Hover the "report-agent · v2 · 12 ¢ spent" footer for 2 s.
7. Scroll once to bring the thumbnail strip into view.
8. Hover the top-performing thumbnail for 2 s — Gemini-vision caption tooltip appears.

**Why D29-A is provable**: the footer cites the agent name + cost + version — typed function
output, not a templated text dump.

---

## Scene 10 — Dialogflow CX widget answers a follow-up question

| Field | Value |
|---|---|
| **Real-time duration** | 90 s (00:12:15 → 00:13:45) |
| **8×-compressed duration** | ~11 s (final 00:01:31.6 → 00:01:42.9) |
| **D29 angle** | **D29-C** — the chatbot surface (per D26 — Mission Control + Dialogflow + Expo) |
| **Tools visible** | Tab 4 (`/usage`), Dialogflow CX widget overlaid |

**Narrative bullet**:

The marketer hits the chat-bubble in the lower-right of the cost-ledger page. The Dialogflow CX
widget opens. They type "What was the cost-per-view for campaign cmpgn_42?" The widget answers
with $0.0098, citing the per-view metering table. Then asks a follow-up: "Which creator had
highest engagement?" — widget answers with the creator handle + an inline thumbnail.

**Mouse-click sequence**:

1. Click Tab 4.
2. Click the chat-bubble FAB lower-right.
3. Widget slides up. `__OPERATOR_CAPTURE__` Click into the widget input.
4. **Type** (real typing — 8× compresses it to a blur, that's fine): `What was the cost-per-view
   for campaign cmpgn_42?` (45 characters; ~6 s real typing).
5. Press Enter.
6. Wait 3 s for the streaming response (real Dialogflow latency).
7. The answer appears: `$0.0098 per delivered view — see /usage#cmpgn_42 row`.
8. Click into the input again.
9. Type: `Which creator had highest engagement?` (37 chars; ~5 s real typing).
10. Press Enter.
11. Wait 3 s.
12. Answer renders with a thumbnail + handle.
13. Hover the thumbnail for 2 s.

**Why D29-C is provable**: the widget is a third surface (Mission Control + chatbot + future
Expo); the cited answer ties back to per-view metering (D28).

---

## Scene 11 — Cost ledger sweep (the per-tenant $/agent-call panel)

| Field | Value |
|---|---|
| **Real-time duration** | 75 s (00:13:45 → 00:15:00) |
| **8×-compressed duration** | ~9.4 s (final 00:01:42.9 → 00:01:52.3) |
| **D29 angle** | **D29-A** — every agent invocation is metered as a typed cost-attributed row |
| **Tools visible** | Tab 4 (`/usage`) full pane |

**Narrative bullet**:

The marketer scrolls the usage table: 173 agent invocations, total $1.34, broken down per agent
(intake $0.04, sourcing $0.48, outreach $0.36, reply $0.12, ship $0.18, customs $0.06, tracking
$0.04, verify $0.04, report $0.02). Per D39, the $1,500 GCP credit envelope is visible top-right
("$1,498.66 remaining"). The marketer downloads the CSV.

**Mouse-click sequence**:

1. Click Tab 4 (returns to the usage page even if already there).
2. Scroll to the top of the table — the credit-envelope banner is visible.
3. Hover the "$1,498.66 remaining of $1,500 credit" banner for 2 s.
4. Scroll the agent-cost breakdown into view.
5. Click the column header "USD per call" to sort descending.
6. Scroll once.
7. Click "Export CSV".
8. Wait 3 s — toast "usage-cmpgn_42.csv downloaded" appears.
9. Hover the toast's "Open in Sheets" link for 2 s.

**Why D29-A is provable**: every row has the agent name + USD + duration + p50 latency —
agents-as-functions in the most literal sense.

---

## Scene 12 — System health check (the smoke test running live)

| Field | Value |
|---|---|
| **Real-time duration** | 30 s (00:15:00 → 00:15:30) |
| **8×-compressed duration** | ~3.75 s (final 00:01:52.3 → 00:01:56.1) |
| **D29 angle** | All three (the smoke test runs every agent function — Agent-as-function — through a multi-agent loop — Multi-agent — invoked without any Marketplace dependency — KR-region-gap) |
| **Tools visible** | Terminal (right pane), Tab 1 idle in background |

**Narrative bullet**:

OBS switches to Scene C (terminal split). The right pane runs
`python scripts/smoke-test/brand_campaign_smoke.py`. Output streams: 22 agent steps, each
printing `[ok] agent=<name> latency=<ms> usd=<$>`. The final line reads
`PASS — 22/22 agents · 0 failures · total $1.34 · runtime 18.4 s`. This is the canary that
proves the system is real, today.

**Mouse-click sequence**:

1. (At 00:14:55 of real time, the operator should already have the terminal split visible from
   the Cmd+Tab in Scene 6 if they kept it; otherwise Cmd+Tab to terminal now.)
2. `__OPERATOR_CAPTURE__` Position cursor in the right-pane terminal.
3. **Type** the command (or hit ↑ to recall if pre-staged):
   `python scripts/smoke-test/brand_campaign_smoke.py` (operator can have it pre-typed and
   only need to press Enter — see RECORDING-CHECKLIST.md §4).
4. Press Enter.
5. Watch the streaming output for 28 s. **Do not move the mouse**.
6. The `PASS` line appears.
7. Hold for 2 s on the green PASS banner.

**Why this scene closes the demo**: the SCRIPT.md §10 quality bar says *"every approval click
visible"*. The smoke test is the meta-proof that all 22 of the underlying functions ran.

---

## 13. Hard-cap timing audit

Sum of real-time durations: 90 + 60 + 45 + 120 + 90 + 120 + 90 + 60 + 60 + 90 + 75 + 30 =
**930 s = 15:30**. The remaining 8:30 of source budget is **inter-scene pause** (3 s legal
inter-beat pause × 11 transitions + scroll-resets + the operator catching up). The
post-record-checklist.sh script (already in this folder) targets 24:00 ± 30 s — if the operator
exceeds 16:30 of *active* clicking, they are running too slow and should trim a hover-dwell.

Sum of 8×-compressed durations: 11 + 7.5 + 5.6 + 15 + 11 + 15 + 11 + 7.5 + 7.5 + 11 + 9.4 + 3.75
= **115.25 s = 1:55**. The remaining ~65 s of final-video budget is the intro card (5 s), outro
card (5 s), and inter-scene cross-fades. **Final target: 3:00 ± 2 s.**

---

## 14. What this storyboard does NOT decide

- **Cursor highlight + halo color** — set by `obs/cursor-highlight.lua` (already authored).
- **Audio narration** — per D30, **no narration**. Subtitles only. The
  `subtitles/track2-{ko,en,ja,zh-CN}.srt` files in this folder carry all verbal content.
- **Intro/outro cards** — `assets/intro/track2-intro-card.png` + `assets/outro/track2-outro-cta.png`
  are pre-rendered.
- **The 6 SCRIPT.md beats** — those still exist as the higher-level narrative spine; this
  storyboard's 12 scenes nest inside them (Scene 1-2 = Beat 1, 3-4 = Beat 2, 5-6 = Beat 3, 7-8 =
  Beat 4, 9-10 = Beat 5, 11-12 = Beat 6).

---

## 15. Cross-references

- D29 (three angles) → `gcp-research/decisions/DECISIONS.md` line 93
- D30 (8× format) → `gcp-research/decisions/DECISIONS.md` line 94
- D34 (4 locales) → `gcp-research/decisions/DECISIONS.md` line 103
- SCRIPT.md (6-beat narrative) → `gcp-research/demo/SCRIPT.md`
- Existing recording pipeline → `scripts/demo/README.md`
- Smoke test → `scripts/smoke-test/brand_campaign_smoke.py`
- PII gate → `scripts/demo/PII-OCR-GATE.md` (this folder)
- ffmpeg wrapper → `scripts/demo/ffmpeg-8x.sh` (this folder)

**End of STORYBOARD-track2.md.**
