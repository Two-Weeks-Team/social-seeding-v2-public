# SCREENSHOTS-MANIFEST.md

> **Purpose**: every screenshot the operator must capture before clicking "Submit" on Devpost (per D30 demo recording + D6 Devpost gated invite). One entry per file, in capture order.
>
> **Naming convention**: `<track>-<scene>-<ordinal>.png` — lowercase, hyphens only. Target output directory: `scripts/demo/submission/screenshots/` (gitignored except `.gitkeep`). All PNG, sRGB, no alpha unless noted.
>
> **Tooling**: macOS `Cmd+Shift+4 + Space` for window-bound captures; Chrome DevTools "Capture full-size screenshot" for long-scrolling Mission Control views; `gcloud screenshot` not available — use the Cloud Console UI directly with browser zoom 100% for crispness.
>
> **Authoritative source**: `gcp-research/decisions/DECISIONS.md` (cited inline per D-ID); demo script in `gcp-research/demo/SCRIPT.md` §3 (Track 2) and §4 (Track 3).
>
> **Status as of 2026-05-19**: 24 captures required (14 Track 2 + 10 Track 3). Zero captured to date — operator captures during the live demo recording window, post W7 deploy.

---

## 1. Track 2 — `social-seeding-v2` (14 captures)

### 1.1 Mission Control intake (D26)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| T2-01 | `t2-mission-control-intake-01.png` | `<CLOUD_RUN_WEB_URL>/intake` — fresh brand brief form, empty | 1920 × 1080 | Show empty state with placeholder text and the "Conversational intake (Gemini 2.5 Flash)" badge top-right per D23 |
| T2-02 | `t2-mission-control-intake-02.png` | Same URL, brief filled in (paste demo brief from `gcp-research/demo/SCRIPT.md` §3.2) | 1920 × 1080 | Show the intake agent's clarifying questions in the right panel; Identity Platform tenant chip in nav bar |

### 1.2 22-agent fleet runtime view (D17 / D23)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| T2-03 | `t2-agent-fleet-overview.png` | `<CLOUD_RUN_WEB_URL>/agents` — all 22 agents listed with status | 1920 × 1080 | Each agent row shows: tier (1/2/3), model (2.5 Pro/Flash/Flash-Lite), tool count, last invocation, USD-day spend bar. Sortable by tier. |
| T2-04 | `t2-agent-runtime-deployed.png` | Cloud Console → Vertex AI → Agent Runtime → endpoints list, showing all 22 agents deployed across 3 regions | 1920 × 1080 | Per D17. Filter by region tag; show us-central1, europe-west4, asia-northeast3 columns populated |

### 1.3 AP2 mandate flow (D27)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| T2-05 | `t2-ap2-mandate-detail.png` | `<CLOUD_RUN_WEB_URL>/approvals/{mandate_id}` — Intent Mandate detail view | 1920 × 1080 | Show: mandate JSON (collapsible), creator identity, brand identity, USD ceiling, the gate name (`external_send`), Approve/Reject buttons, Decline-with-reason input. Cite D27 in caption. |
| T2-06 | `t2-approvals-bulk-approve.png` | `<CLOUD_RUN_WEB_URL>/approvals` — list view with multi-select | 1920 × 1080 | Show 12 pending mandates with checkboxes, "Approve selected" button highlighted, total-USD chip showing $34.27. |

### 1.4 Workflow + telemetry (D18 / D31)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| T2-07 | `t2-workflows-canvas.png` | Cloud Console → Workflows → `brand-campaign` → graph view | 1920 × 1080 | Show the `step.sleep(14d)` → `waitForCallback` rewrite as Cloud Workflows. Per D18 / D42. |
| T2-08 | `t2-cloud-trace-spans.png` | Cloud Console → Cloud Trace → trace for one full campaign run | 1920 × 1080 | Show spans for: Mission Control intake → Agent Gateway → 22 agents fan-out → Spanner / AlloyDB writes → Apigee meter. Per D31 hot-path < 1 s p99. |
| T2-09 | `t2-cost-watch-dashboard.png` | Managed Grafana dashboard for `cost_watch` (W2) | 1920 × 1080 | Per-tenant USD/day with 50/75/90/95% threshold ladder lines. Per D23 / D39. |

### 1.5 Dialogflow CX widget (D26)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| T2-10 | `t2-dialogflow-cx-widget.png` | `<CLOUD_RUN_WEB_URL>` with the chat widget open mid-conversation | 1280 × 720 | Show the operator asking "How is the Q3 vegan-skincare campaign going?" and the agent's response with links to live campaign data. Per D26. |

### 1.6 Build + test evidence (D37 / D43)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| T2-11 | `t2-smoke-test-green.png` | Terminal output of `scripts/smoke-test/run-brand-campaign.sh` showing exit 0 | 1280 × 800 | Per D43. Show: 22/22 agents validated, 50/50 tool invocations, 0.15 s wall, exit 0. Monospace dark theme. |
| T2-12 | `t2-pytest-2668-passing.png` | Terminal output of `pnpm exec pytest packages/agents-adk` showing 2,668 passed / 0 failed | 1280 × 800 | Per `STATUS-REPORT.md §2`. Show the last 30 lines of pytest summary. |
| T2-13 | `t2-cloud-deploy-canary.png` | Cloud Console → Cloud Deploy → pipeline for `social-seeding-v2` showing canary at 10% | 1920 × 1080 | Per D37. Show: 10% traffic split, SLO burn-rate gate, Binary Authorization "Approved" badge. |

### 1.7 Model Armor + Chronicle (D21 / D32)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| T2-14 | `t2-model-armor-policy.png` | Cloud Console → Security → Model Armor → policy details for the `social-seeding-v2` tenant | 1920 × 1080 | Show: PI/JB block ON, PII block ON, RAI default, custom regex (brand/competitor/influencer-handle) listed, Agent Anomaly Detection ON, threshold-driven auto-quarantine ON. Per D21. |

---

## 2. Track 3 — `tiktok-mcp-server` (10 captures)

### 2.1 Marketplace listing (D2 / D3)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| T3-01 | `t3-marketplace-pending.png` | Producer Portal → Listings → `Influencer Research Agent (TikTok) by Social Seeding` — status PENDING with timestamp visible | 1920 × 1080 | **The headline visual for Track 3.** Capture must include: PENDING status badge, KR-payment-region disclosure visible in the listing description preview, submission timestamp. Per D2 / D3. |
| T3-02 | `t3-marketplace-listing-page.png` | Marketplace catalog preview page (Producer Portal's "Preview" button) | 1920 × 1080 | Show: title, tagline ("Brand brief in. Ranked TikTok creators out."), screenshots strip, pricing tiers ($0 / $49 / $299 / Enterprise), the A2A skill + MCP tools list. |

### 2.2 ADK agent runtime (D17 / D24)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| T3-03 | `t3-cloud-run-agent-deployed.png` | Cloud Console → Cloud Run → `tiktok-mcp` service detail | 1920 × 1080 | Show: multi-container (`agent` + `mcp` sidecar per `REFACTOR-MCP.md §5.3`), us-central1 deployment, session affinity ON, scale-to-zero. |
| T3-04 | `t3-agent-runtime-card.png` | Cloud Console → Vertex AI → Agent Runtime → `influencer_research_coordinator` detail | 1920 × 1080 | Show: agent.json content (skills + mcp_tools dual surface), A2A v0.3 schema_version, Gemini 2.5 Flash + Pro routing config. Per D17 + D24. |

### 2.3 Gemini Enterprise A2A integration (D24 / D29)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| T3-05 | `t3-gemini-enterprise-chat.png` | Gemini Enterprise chat surface (or simulated mock via the demo recording) — operator asks "Find 10 TikTok creators for a vegan skincare launch in Korea targeting Gen-Z" | 1920 × 1080 | Show the agent's reasoning trace expanded: searcher keyword-fan-out, dedupe, ranker engagement-rate calc. Final ranked top-10 with reasoning. |
| T3-06 | `t3-a2a-well-known.png` | `curl -s https://mcp.socialseed.ing/.well-known/agent.json | jq` — terminal capture | 1280 × 800 | Show the full agent.json A2A card with `skills`, `mcp_tools`, OAuth issuer pointing at `securetoken.google.com`, schema_version 0.3.0. Per D24 / D29. |

### 2.4 Identity Platform + Apigee meter (D19 / D28)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| T3-07 | `t3-identity-platform-tenant.png` | Cloud Console → Identity Platform → tenant `mcp-socialseed-prod` → providers | 1920 × 1080 | Show: Google OAuth provider ON, multi-tenant config, sign-in methods, CORS origins for `mcp.socialseed.ing`. Per D19. |
| T3-08 | `t3-apigee-meter-dashboard.png` | Cloud Console → Apigee X → Analytics → `tiktok-mcp` proxy meter dashboard | 1920 × 1080 | Per-tenant call volume + USD billing, the three tiers (Free / Starter / Pro) visible. Per D28. |

### 2.5 Govern parity (D21 / D32)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| T3-09 | `t3-model-armor-block.png` | Cloud Logging query for `model_armor.action="BLOCK"` showing a real adversarial-brief block during the 50-adversarial-eval per `REFACTOR-MCP.md §6.4 step 2` | 1280 × 720 | Show: block reason (PI / JB / PII / custom regex), tenant ID redacted, timestamp. Per D21. |
| T3-10 | `t3-chronicle-evidence-pack.png` | Chronicle SecOps → search `principal:"tiktok-mcp-runner"` for the demo window | 1920 × 1080 | Show: audit log events, Agent Anomaly Detection signals, the 90-day BigQuery export sink. Per D32 / D33. |

---

## 3. Cross-track captures (shared evidence, 0 separate; reuse Track 2 numbering)

The Mission Control screenshots (T2-01, T2-02) can be cropped to 1280 × 720 for the Track 3 Devpost gallery if needed — Mission Control includes a Track 3 widget showing the v2 `sourcing` agent calling `plan_creator_search` over A2A. The cross-track integration test screenshot is part of T2-03 (look for the `sourcing` agent row's "A2A → mcp.socialseed.ing/plan_creator_search" tool chip).

---

## 4. Pre-capture checklist (operator)

Before opening Devpost:

1. **Verify W5 day-1 setup complete**: `gcloud projects list | grep ss-` returns three projects.
2. **Verify W7 deploy complete**: `gcloud run services list --region=us-central1 --filter='metadata.name~ss-v2-web|tiktok-mcp'` returns both services with status `Ready: True`.
3. **Verify demo run is green**: `bash scripts/smoke-test/run-brand-campaign.sh` exits 0 within the last 24 hours (D43 freshness gate).
4. **Verify Producer Portal status**: listing is PENDING with the KR-payment-region disclosure visible in the description preview (D2 / D3).
5. **Set browser zoom to 100%** and viewport to 1920 × 1080 for all desktop captures; 1280 × 720 for mobile-PWA captures.
6. **Disable browser extensions** (especially ad blockers and dark-mode forcers) — captures should match the deployed UI exactly.
7. **Use macOS `Cmd+Shift+4 + Space` + window selection** (not full-screen) for clean window captures with system shadow.
8. **Crop to remove menubar / dock** — captures should show only the application content.
9. **Verify no PII in captures**: redact tenant IDs, operator email (`app.2weeks@gmail.com` shows in Identity Platform views — redact with a black rectangle), real influencer handles per D10.

---

## 5. File-layout target

```
scripts/demo/submission/
├── SCREENSHOTS-MANIFEST.md         (this file)
├── screenshots/
│   ├── .gitkeep
│   ├── t2-mission-control-intake-01.png
│   ├── t2-mission-control-intake-02.png
│   ├── t2-agent-fleet-overview.png
│   ├── t2-agent-runtime-deployed.png
│   ├── t2-ap2-mandate-detail.png
│   ├── t2-approvals-bulk-approve.png
│   ├── t2-workflows-canvas.png
│   ├── t2-cloud-trace-spans.png
│   ├── t2-cost-watch-dashboard.png
│   ├── t2-dialogflow-cx-widget.png
│   ├── t2-smoke-test-green.png
│   ├── t2-pytest-2668-passing.png
│   ├── t2-cloud-deploy-canary.png
│   ├── t2-model-armor-policy.png
│   ├── t3-marketplace-pending.png
│   ├── t3-marketplace-listing-page.png
│   ├── t3-cloud-run-agent-deployed.png
│   ├── t3-agent-runtime-card.png
│   ├── t3-gemini-enterprise-chat.png
│   ├── t3-a2a-well-known.png
│   ├── t3-identity-platform-tenant.png
│   ├── t3-apigee-meter-dashboard.png
│   ├── t3-model-armor-block.png
│   └── t3-chronicle-evidence-pack.png
└── CHECKLIST.md
```

Devpost accepts up to **10 image uploads per submission**. Operator selects the 10 strongest per track:

- **Track 2 recommended order** (10 of 14): T2-01, T2-03, T2-05, T2-06, T2-07, T2-08, T2-10, T2-11, T2-13, T2-14
- **Track 3 recommended order** (10 of 10): T3-01, T3-02, T3-03, T3-04, T3-05, T3-06, T3-07, T3-08, T3-09, T3-10

The remaining Track 2 captures (T2-02, T2-04, T2-09, T2-12) are committed to the repository and linked from the README so judges can find them; they do not need to ride the Devpost gallery.

---

**End of `SCREENSHOTS-MANIFEST.md`.** When all 24 files exist in `screenshots/`, proceed to [`CHECKLIST.md`](CHECKLIST.md).
