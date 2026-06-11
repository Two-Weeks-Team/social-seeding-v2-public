# Screenshots — capture status + operator notes

> Companion to `SCREENSHOTS-MANIFEST.md`. The 10★ gallery set (grand-narrative order, `CHECKLIST.md §4`) is **assembled in `screenshots/`** as of 2026-06-04. Upload them to Devpost in the numbered order below.

## The 10★ gallery (upload order)

| # | File | Source | Honesty note (carried in-image where relevant) |
|---|---|---|---|
| 1 (hero) | `hardening-before-after-train-100-holdout-71.png` | live `wow-business.html#hardening` | numbers from re-runnable `run-hardening-measure.sh` (40.5%→100% train / 71.4% holdout); local deterministic pass, Prompt Optimizer is the operator-gated prod path |
| 2 | `observability-stall-repair-trace.png` | live `wow-business.html` (Optimize) | deterministic offline render of the triage path; OTel span shape (D32) real, live export is prod path |
| 3 | `live-a2a-crosscall-318ms.png` | live `wow-business.html#a2a-crosscall` | **318 ms = direct A2A hop, measured 2026-05-19** (see FLAG-1) |
| 4 | `live-agent-json-200.png` | **real live** `curl /.well-known/agent.json` rendered to terminal | data fetched live 2026-06-04; `protocolVersion 0.3.0`, 2 skills, live Cloud Run URL |
| 5 | `req-gate-table.png` | rendered 6-requirement table (from `devpost-track3.md`) | all 6 + Agent Identity; each row cites live URL/commit/doc |
| 6 | `build-example-2-match.png` | live `wow-business.html` (Build Example #2) | content_verify maps 1:1; A2A-DAM promotion is the Phase-4 step (disclosed) |
| 7 | `mission-control-fleet.png` | live demo `index.html` workflow canvas | **carries "Illustrative mock" label** (see FLAG-2) |
| 8 | `real-imagen-generation.png` | live `wow-business.html` Imagen panel (image + metadata + SHA) | **real** Imagen 4 1024×1024, 950,522 B, ~$0.04, from `gen_sample_image.py` (not the in-fleet creative agent, which is W7-staged) |
| 9 | `wow-business-roi-tam.png` | live `wow-business.html` ROI section | $0.01/view (D28); figures sourced/labelled |
| 10 | `pytest-2933-passing.png` | rendered from **real** `pytest` run | 2933 passed / 0 failed, re-runnable |

Bonus committed (not in the 10-slot gallery): `real-imagen-raw-1024.png` (the pure 1024² artifact), `real-imagen-generation-panel.png` (= same as #8), `wow-business-tam-detail.png` (TAM/SAM/SOM with sources).

## Two operator flags (decide before upload — neither is a fabrication)

**FLAG-1 — A2A latency number.** The captured image #3 shows **318 ms**, which is the *direct* `coordinator → a2a_invoke → ss-mcp` hop (measured 2026-05-19). The form/`req-gate-table`/`CHECKLIST` describe the **~3.7 s** figure, which is the *full brand-campaign Cloud Workflow execution* (coordinator + the A2A hop + ranking). Both are true, different measurements. Options: (a) keep #3 as the direct-hop proof and let the form carry the ~3.7 s workflow number (recommended — they measure different things, both honest); (b) re-capture a live Cloud Workflow execution showing ~3.7 s if you want the gallery number to match the form headline. Do **not** relabel 318 ms as 3.7 s.

**FLAG-2 — mission-control-fleet is the demo canvas.** Image #7 is the live `index.html` workflow canvas (real agent/model/tool names: sourcing `gemini-3.5-flash`, vetting `gemini-3.1-flash-lite`, outreach-writer `gmail.send`, …). It carries the on-screen **"Illustrative mock · live proof via /scripts/smoke-test"** label, so it is not overclaiming. If you want the *authenticated* 22-agent fleet roster instead, capture it yourself during the demo via the judge-demo 1-click login (`agents.socialseed.ing/api/auth/judge-demo?token=…`, full token in your records) → `/agents`, and overwrite the file.

## Pre-capture/upload checklist
- Confirm the live endpoints are 200 (`SCREENSHOTS-MANIFEST.md §6`).
- The numbers in the gallery (2933, 40.5%/100%/71.4%, 318 ms) match the form copy — except the FLAG-1 ~3.7 s workflow figure, which is intentionally a different measurement.
- Hero (slot 1) must be the before/after bar — it carries both Technical-30% and Demo-20%.
