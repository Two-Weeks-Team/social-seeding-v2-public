# SCREENS.md — per-scene drawn surface

Maps each of the 24 storyboard scenes to the on-screen surface drawn by
`index.html`. One line per scene.

## Track 2 — Mission Control

| # | Scene title | Drawn surface | D29 | Interactive moment |
|---|---|---|---|---|
| 1 | Brand brief intake | `/campaigns/new` — textarea + intake-agent terminal pane | A | Cursor types brief, clicks Submit, CampaignDraft card appears |
| 2 | AP2 Intent Mandate | `/campaigns/cmpgn_42/mandate` — mandate card + modal w/ JSON preview | C | Click Review → modal → hover scope row → click Sign → chip flips green |
| 3 | Bulk-approve 40 sourcing matches | `/approvals` — table of 12 rows (representing 40), bulk toolbar | A | Master checkbox → select all → click "Approve 40 → outreach" → progress bar |
| 4 | Outreach drafts | `/campaigns/cmpgn_42/outreach` — 6-card grid + draft detail pane | A+C | Click card #3, type edit into body, click "Send via Gmail" |
| 5 | Reply-agent classification | Split: `/usage` (spend $1.34) + `/campaigns/cmpgn_42/inbox` | A+B | Spend hover, inbox row click, structured extraction reveal, queue button |
| 6 | Shipping fan-out | `/campaigns/cmpgn_42/shipping` — 6 cards × 3 sub-agents + terminal | C | Hover cards, watch ship/customs/tracking lines stream in terminal |
| 7 | Verify-agent + view-count graph | `/campaigns/cmpgn_42/verify` — SVG line chart + delivery table | B | Live view count animates 12 400 → 38 400, ticker updates |
| 8 | AP2 Cart Mandate (read-only) | `/campaigns/cmpgn_42/mandate?step=cart` — orange D27 banner + line items | C | Click "Approve release ($90) as human" → green payout-fired card |
| 9 | Empty queue + auto-report | `/approvals` empty-state hero → CampaignReport detail | A | Click "Open recently-completed campaign" → 4-thumbnail strip reveals |
| 10 | Dialogflow CX chatbot | `/usage` + chat-bubble FAB → 380×460 widget overlay | C | Click FAB, type Q1, bot answers, type Q2 with thumbnail answer |
| 11 | Cost ledger sweep | `/usage` — D39 credit envelope card + 9-row agent table | A | Click "Export CSV" → toast appears |
| 12 | System health check | Terminal split: run-demo (left) + brand_campaign_smoke.py (right) | ALL | Smoke streams 22 agent rows → final `PASS — 22/22 · $1.34` |

## Track 3 — tiktok-mcp-server

| # | Scene title | Drawn surface | D29 | Interactive moment |
|---|---|---|---|---|
| 1 | Marketplace KR gap + Cloud Run live | GCP Console mock: Marketplace seller wizard + Cloud Run detail | B | Open billing-country dropdown (KR row missing), then live Cloud Run card |
| 2 | A2A v0.3 AgentCard | Browser tab on `/.well-known/agent.json` w/ syntax-highlighted JSON | B+C | Static surface — 3 skills, 3 transports, JWS signature chips |
| 3 | Import into Gemini Enterprise | Gemini Enterprise "Add agent" form | B | Type URL, click Discover, click "Register all 3 skills", toast |
| 4 | MCP tools/call | `mcp dev` REPL terminal | A | Type `tools/list` → 3 tools, then `tools/call tiktok.lookup` → JSON-RPC response |
| 5 | A2A client → Cloud Run | Split terminal: a2a-client (left) + Cloud Run logs (right) | C | Type long a2a-client cmd → task_created / task_completed → matching log row |
| 6 | Model Armor blocks injection | Same split terminal w/ malicious payload | B+C | Type DROP-TABLE payload → task.failed model_armor_block → audit log with OIDC sub |
| 7 | Gemini Enterprise NL chat | Gemini Enterprise chat surface (one card, msg stream) | B | Type natural language question → "calling tool" → answer w/ trace link |
| 8 | Per-skill USD ledger | Cloud Monitoring saved view — 3 horizontal bars | A | Static surface — tiktok.lookup $0.094 / search $0.036 / profile $0.009 |
| 9 | Producer Portal pending | Producer Portal table + sticky note | B | Static — `pending_legal_entity` chip + operator-note reframe card |
| 10 | Multi-region active-active | Cloud Run revisions table + SVG geo-routing bar chart | C | Static — 30/50/20 routing split, 3 Identity Platform tenant chips |
| 11 | A2A streaming multimodal response | Terminal Pane C only | C | a2a-client multimodal command → 4 chunks stream (json + 2 images + markdown) |
| 12 | Health check + pytest smoke | Single terminal pane | ALL | `curl /healthz | jq` → ok body → pytest → `47 passed in 4.2s` PASS |

## Engine notes

- Each scene's keyframe array lives in `KEYFRAMES[track][idx]` inside
  `index.html`. Keyframes are addressed by `at` ∈ [0, 1] — proportion of the
  scene's 8×-compressed duration — so changing the global speed (0.5× … 8×)
  proportionally re-times every action without breaking causality.
- `setCursorToEl()` reads the live `getBoundingClientRect()` for the target
  element, so the cursor lands on real selectors regardless of layout shifts.
- `typeInto()` is a `requestAnimationFrame` worker that keys off the scene's
  `state.sceneElapsedMs` clock — it remains in sync with pause / scrub /
  speed-change events.
