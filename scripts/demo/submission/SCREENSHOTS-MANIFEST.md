# SCREENSHOTS-MANIFEST.md — single Track 3 submission (whole platform)

> **Purpose**: every screenshot the operator captures before clicking "Submit" on the **single** Devpost Track 3 entry (D45 — one submission subsuming the whole platform). One entry per file, in capture order.
>
> **Submission strategy**: ONE Devpost form (Track 3 / Refactor). The platform (former Track 2) is absorbed; there is no second gallery. Devpost accepts up to **10 image uploads per submission** — the recommended final 10 are marked ★ below.
>
> **Naming convention**: `<scene>-<ordinal>.png` — lowercase, hyphens only. Output directory: `scripts/demo/submission/screenshots/` (gitignored except `.gitkeep`). All PNG, sRGB, no alpha unless noted.
>
> **Tooling**: macOS `Cmd+Shift+4 + Space` for window-bound captures; Chrome DevTools "Capture full-size screenshot" for long-scrolling Mission Control views; for live endpoints use a real browser/terminal at 100% zoom. Live demo landing animations captured as PNG stills (or short GIF if Devpost gallery accepts it).
>
> **Authoritative source**: `gcp-research/decisions/DECISIONS.md` (cited inline per D-ID).
>
> **Status as of 2026-05-20**: 18 captures defined for the single submission. Live endpoints reachable now (stub mode); operator captures during the demo recording window.

---

## 0. The 10 strongest (Devpost gallery, in upload order) ★

Devpost caps at 10 images. Upload these, in this order — the hero is the live A2A cross-call:

1. ★ `live-a2a-crosscall-318ms.png` — the load-bearing proof (S-01)
2. ★ `live-agent-json-200.png` — A2A v0.3 card served live (S-02)
3. ★ `req-gate-table.png` — 6-requirement gate, all green (S-03)
4. ★ `build-example-2-match.png` — PDF Build Example #2 1:1 callout (S-04)
5. ★ `mission-control-fleet.png` — 22-agent fleet overview (S-05)
6. ★ `ap2-mandate-detail.png` — AP2 Intent Mandate human gate (S-06)
7. ★ `real-imagen-generation.png` — real Imagen multimodal output (S-07)
8. ★ `wow-business-roi-tam.png` — $0.01/view ROI + TAM/SAM/SOM scene (S-08)
9. ★ `a2a-animation-diagram.png` — animated A2A cross-call diagram still (S-09)
10. ★ `pytest-2713-passing.png` — 2,713 passed / 0 failed (S-10)

The remaining captures (S-11..S-18) are committed to the repo and linked from the README so judges can find them; they do not ride the 10-slot gallery.

---

## 1. Live-endpoint evidence (the cross-call story — D45)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| S-01 ★ | `live-a2a-crosscall-318ms.png` | Terminal: `bash scripts/smoke-test/run-integration-a2a.sh` showing exit 0 | 1280 × 800 | **Hero.** Show `coordinator → a2a_invoke → ss-mcp` round-trip: A2A `task` `state=completed`, **318 ms**, **5 ranked creators**. Monospace dark theme. Per D45. |
| S-02 ★ | `live-agent-json-200.png` | Terminal: `curl -s https://ss-mcp-server-1049119860518.us-central1.run.app/.well-known/agent.json \| jq` | 1280 × 800 | Show A2A v0.3 card: `protocolVersion 0.3.0`, `skills[0].id=plan_creator_search`, four `mcp_tools`, live Cloud Run URL in `additionalInterfaces`. Requirement ④. |
| S-11 | `live-message-send-200.png` | Terminal: `curl -s -X POST .../v1/message:send` with a brand brief body | 1280 × 800 | Show the A2A `task` envelope response, `status.state=completed`, 5 creators, `source_attribution` present. |
| S-12 | `live-mission-control-healthz.png` | `https://ss-v2-web-722660901814.us-central1.run.app/api/healthz` 200 in browser | 1280 × 720 | Requirement ②. Show the live Mission Control health response. |
| S-13 | `live-landing-demo.png` | `https://ss-landing-80064221403.us-central1.run.app` landing + report page | 1920 × 1080 | The public demo/report surface (D46 essential asset). |

## 2. Track 3 requirement evidence (designed_guide.pdf p.6-7)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| S-03 ★ | `req-gate-table.png` | The 6-requirement gate table (devpost-track3.md / STATUS-REPORT-UNIFIED §2), rendered | 1920 × 1080 | All six ✅ + Agent Identity ✅, each with live URL/commit/doc. Maps to Technical 30%. |
| S-04 ★ | `build-example-2-match.png` | The Build Example #2 1:1 match table (A2A-INTENTS.md §5) rendered, with on-screen callout | 1920 × 1080 | `content_verify` ↔ DAM agent; Gemini multimodal; on-brand/compliant verdict. Per D48/D49. |
| S-14 | `model-garden-routing.png` | `deploy/model-garden/README.md` + agent model config showing `publishers/google/models/<id>` routing | 1280 × 800 | Requirement ③ / D47. "Strict data security" framing visible. |
| S-15 | `agent-identity-spiffe.png` | `AGENT-IDENTITY.md` showing `spiffe://ss-mcp-prod.svc.id.goog/ns/agents/sa/tiktok-mcp-runner` | 1280 × 800 | Agent Identity crypto ID (p.7) / D48. |

## 3. Platform (former Track 2) — fleet + AP2 + multimodal

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| S-05 ★ | `mission-control-fleet.png` | Mission Control `/agents` — all 22 agents with tier/model/tool-count/USD-day | 1920 × 1080 | Requirement ⑤ (multi-agent). Look for the `coordinator` row's "A2A → ss-mcp / plan_creator_search" tool chip. Per D23. |
| S-06 ★ | `ap2-mandate-detail.png` | Mission Control `/approvals/{mandate_id}` — Intent Mandate detail | 1920 × 1080 | Show mandate JSON, creator + brand identity, USD ceiling, gate name (`external_send`), Approve/Reject. Per D27. |
| S-16 | `ap2-approvals-bulk.png` | Mission Control `/approvals` — multi-select list | 1920 × 1080 | Pending mandates with checkboxes, total-USD chip. Per D27. |
| S-07 ★ | `real-imagen-generation.png` | The `creative` agent's real Imagen output with `CAPABILITY_LAYER_MODE=live` | 1920 × 1080 | **Real generation, not stub** (D49). Show the moodboard image + the agent panel that produced it. ~$0.04 take. |

## 4. Wow + business reinforcement (D49 — Demo 20% + Business 30%)

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| S-08 ★ | `wow-business-roi-tam.png` | Live landing / demo ROI scene: $0.01/view (D28) + TAM/SAM/SOM visualization | 1920 × 1080 | Business is co-#1 rubric weight (30%). Show $24B TAM → $1.7B SAM → $540k SOM with source labels. Per D28/D49. |
| S-09 ★ | `a2a-animation-diagram.png` | Animated A2A cross-call diagram (still frame, or short GIF) | 1920 × 1080 | coordinator → a2a_invoke → ss-mcp → task/completed, animated. Per D49. |

## 5. Build + test + govern evidence

| # | Filename | Where to capture | Dimensions | Notes |
|---|----------|------------------|------------|-------|
| S-10 ★ | `pytest-2713-passing.png` | Terminal: `pnpm exec pytest packages/agents-adk` summary | 1280 × 800 | **2,713 passed / 0 failed.** Show the last ~30 lines. |
| S-17 | `cloud-run-scale-to-zero.png` | Cloud Console → Cloud Run → `ss-mcp-server` detail | 1920 × 1080 | Show `minScale=0` (scale-to-zero, ~$0/mo idle), revision `00003-22m`, region us-central1. Per D46. |
| S-18 | `model-armor-policy.png` | Model Armor policy details (design-target config) | 1920 × 1080 | PI/JB + PII block + RAI + custom regex + Anomaly Detection. Per D21. **Caption must note: design target; live enforcement gated on O-A..O-E (stub-mode honest gap).** |

---

## 6. Pre-capture checklist (operator)

Before opening Devpost:

1. **Verify the three live endpoints return 200**:
   - `curl -sI https://ss-mcp-server-1049119860518.us-central1.run.app/` → 200
   - `curl -s https://ss-mcp-server-1049119860518.us-central1.run.app/.well-known/agent.json | jq .protocolVersion` → `"0.3.0"`
   - `curl -sI https://ss-v2-web-722660901814.us-central1.run.app/api/healthz` → 200
   - `curl -sI https://ss-landing-80064221403.us-central1.run.app/` → 200
2. **Verify cross-call green within 24 h**: `bash scripts/smoke-test/run-integration-a2a.sh` exits 0 (318 ms / 5 creators).
3. **Verify pytest green**: `pnpm exec pytest packages/agents-adk` → 2,713 passed / 0 failed.
4. **Set browser zoom to 100%**, viewport 1920 × 1080 for desktop, 1280 × 720/800 for terminal/mobile.
5. **Disable browser extensions** (ad blockers, dark-mode forcers) — captures should match the deployed UI.
6. **Verify no PII in captures**: redact tenant IDs, operator email (`app.2weeks@gmail.com`), real influencer handles per D10.
7. **For the real Imagen take (S-07)**: run with `CAPABILITY_LAYER_MODE=live` for one take only, then revert to stub (D41/D49).

---

## 7. File-layout target

```
scripts/demo/submission/
├── SCREENSHOTS-MANIFEST.md         (this file)
├── screenshots/
│   ├── .gitkeep
│   ├── live-a2a-crosscall-318ms.png        (S-01 ★ hero)
│   ├── live-agent-json-200.png             (S-02 ★)
│   ├── req-gate-table.png                  (S-03 ★)
│   ├── build-example-2-match.png           (S-04 ★)
│   ├── mission-control-fleet.png           (S-05 ★)
│   ├── ap2-mandate-detail.png              (S-06 ★)
│   ├── real-imagen-generation.png          (S-07 ★)
│   ├── wow-business-roi-tam.png            (S-08 ★)
│   ├── a2a-animation-diagram.png           (S-09 ★)
│   ├── pytest-2713-passing.png             (S-10 ★)
│   ├── live-message-send-200.png           (S-11)
│   ├── live-mission-control-healthz.png    (S-12)
│   ├── live-landing-demo.png               (S-13)
│   ├── model-garden-routing.png            (S-14)
│   ├── agent-identity-spiffe.png           (S-15)
│   ├── ap2-approvals-bulk.png              (S-16)
│   ├── cloud-run-scale-to-zero.png         (S-17)
│   └── model-armor-policy.png              (S-18)
└── CHECKLIST.md
```

The 10 ★ images ride the Devpost gallery (in the order listed in §0). S-11..S-18 are committed and linked from the README.

---

**End of `SCREENSHOTS-MANIFEST.md`.** When the 10 ★ files exist in `screenshots/`, proceed to [`CHECKLIST.md`](CHECKLIST.md).
