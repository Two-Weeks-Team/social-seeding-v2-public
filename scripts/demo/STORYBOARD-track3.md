# Storyboard — Track 3 (`tiktok-mcp-server`, Gemini Enterprise + A2A v0.3 + KR-region-gap reframe)

> **Authority**: same as Track 2 — implements **D30** + **D34** + **D29** (with the angle
> emphasis flipped — Track 3 leads with **D29-B KR-region-gap** because that's the Track 3
> innovation thesis per D1+D3+D29).
> Per **D1** (dual submission): this is a separate Devpost entry, separate 3-minute video,
> recorded on a separate day (target 2026-05-31 per existing README §5.15).
>
> **Companion files**: `STORYBOARD-track2.md`, `RECORDING-CHECKLIST.md`, `ffmpeg-8x.sh`,
> `subtitles/track3-*.srt`, `SUMMARY.md`.
>
> **Compression math**: same 24 min → 3:00 at 8×.
>
> **Key Track-3-specific assets** (existing): `obs/scene-track3.json`, `assets/overlays/`
> (Gemini Enterprise + A2A v0.3 diagrams), `submission/devpost-track3.md`,
> `submission/README-track3.md`, `submission/ARCHITECTURE-track3.mmd`.

---

## 0. Operator at-a-glance

| | Real time | 8× final time |
|---|---|---|
| Total | **24:00** | **3:00** |
| Scenes | **12** | (same 12 with proportional shrink) |

Tabs / panes to open before pressing Record:

1. **Tab 1**: `https://geminienterprise.google.com/agent-builder/...` — Gemini Enterprise console
   (the importer view + the deployed agent test pane). For demo, use the staging tenant.
2. **Tab 2**: `https://console.cloud.google.com/run/detail/...` — Cloud Run service detail for
   `tiktok-mcp-server` (logs + revisions).
3. **Tab 3**: Local browser tab at `http://localhost:8080/.well-known/agent.json` (A2A v0.3
   AgentCard manifest) — proves the spec compliance.
4. **Tab 4**: a TikTok creator's public profile page (`https://www.tiktok.com/@<persona>`) used
   as the live data target — pre-staged so the persona's profile is already cached.

Terminal layout (OBS Scene C — terminal × 3):

- Pane A (top-left): `uv run mcp dev gcp-research/refactor-mcp/code/agent/src/tiktok_orchestrator/main.py`
- Pane B (top-right): `gcloud run services logs tail tiktok-mcp-server --region=us-central1`
- Pane C (bottom-full): A2A client harness — used in Scenes 5, 8, 11 to call the deployed agent
  via `a2a-client --target https://...run.app --skill tiktok.lookup`

D-ID references same as Track 2 (D29-A, D29-B, D29-C). **Track 3's headline angle is D29-B** —
the entire reason this exists as a separate submission is the Marketplace exclusion (D2 + D3).

---

## Scene 1 — The problem framing (live, on Cloud Console)

| Field | Value |
|---|---|
| **Real-time duration** | 60 s (00:00:00 → 00:01:00) |
| **8×-compressed duration** | ~7.5 s (final 00:00:00 → 00:00:07.5) |
| **D29 angle** | **D29-B** KR-region-gap — visible in Cloud Console region selector |
| **Tools visible** | Tab 2 (Cloud Run console), Cloud Marketplace listing page |

**Narrative bullet**:

The operator navigates to Google Cloud Marketplace's "list a SaaS product" wizard.
The region/billing-locality selector excludes Korea (the country drop-down has no KR-region
billing entity option). They flip to the Cloud Run console where `tiktok-mcp-server` is
deployed in `asia-northeast3` (Seoul). The juxtaposition is the visual thesis: *"we cannot list
on Marketplace, so we ship the value via A2A."*

**Mouse-click sequence**:

1. `__OPERATOR_CAPTURE__` Open the Marketplace seller wizard at the country/billing step.
2. Open the country drop-down. Scroll through — **do not select anything** — for 4 s, showing
   that KR is missing as a billing locality.
3. Close the drop-down.
4. Hover the "Help: supported billing regions" link for 2 s so the tooltip shows.
5. Click Tab 2 (Cloud Run console).
6. The `tiktok-mcp-server` service detail in `asia-northeast3` is visible: green health, 99.97%
   uptime, $0.32 spent today.
7. Hover the region chip "asia-northeast3 · Seoul" for 3 s.
8. Click into the "URL" field and copy the deployed URL to clipboard (Cmd+C). **Do not paste
   yet** — Scene 2 uses it.

**Why D29-B is provable on screen**: the absence of KR in the Marketplace drop-down is on
screen as **negative evidence**; the green Cloud Run service in Seoul is positive evidence.
The pair makes the argument without narration.

---

## Scene 2 — A2A v0.3 AgentCard manifest (the open-standard alternative)

| Field | Value |
|---|---|
| **Real-time duration** | 60 s (00:01:00 → 00:02:00) |
| **8×-compressed duration** | ~7.5 s (final 00:00:07.5 → 00:00:15) |
| **D29 angle** | **D29-B** + **D29-C** — A2A is the multimodal multi-agent distribution layer |
| **Tools visible** | Tab 3 (`/.well-known/agent.json`), JSON pretty-printer |

**Narrative bullet**:

The operator switches to Tab 3. The `agent.json` is rendered with syntax-highlighting. They
scroll through the manifest: `protocol_version=0.3`, `skills=[tiktok.lookup, tiktok.search,
tiktok.profile]`, `authentication=OIDC`, `endpoints={a2a, mcp, http}`. This is the **open
standard** version of the Marketplace listing — anyone can discover this server without going
through a regional gatekeeper.

**Mouse-click sequence**:

1. Click Tab 3.
2. The browser shows the JSON. Scroll once to bring the `skills:` array fully visible.
3. Hover (do not click) the `protocol_version: "0.3"` line for 2 s.
4. Hover the `endpoints:` block for 2 s — the inline help shows `{a2a: https://..run.app/a2a,
   mcp: https://..run.app/mcp, http: https://..run.app}`.
5. Scroll once more to bring the `signed_by:` field into view (the AgentCard is JWS-signed).
6. Hover the `signed_by: gcp-mcp-deployer@...iam.gserviceaccount.com` line for 3 s.

**Why D29-B + D29-C is provable**: the manifest is publicly inspectable; the JWS signature is
visible; three transport endpoints (A2A + MCP + plain HTTP) make this multi-channel.

---

## Scene 3 — Importing the agent into Gemini Enterprise (the integration moment)

| Field | Value |
|---|---|
| **Real-time duration** | 105 s (00:02:00 → 00:03:45) |
| **8×-compressed duration** | ~13 s (final 00:00:15 → 00:00:28.1) |
| **D29 angle** | **D29-B** reframe — *because* we can't ship via Marketplace, we ship via Gemini Enterprise's A2A importer |
| **Tools visible** | Tab 1 (Gemini Enterprise agent-builder), Tab 3 (URL pasted in) |

**Narrative bullet**:

The operator switches to Gemini Enterprise. They click "Add agent → from A2A endpoint", paste
the Cloud Run URL from Scene 1's clipboard, and click "Discover". Gemini Enterprise reads
`/.well-known/agent.json`, lists the three skills, and offers to register them. The operator
accepts. The agent is now callable from any Gemini Enterprise workspace — no Marketplace listing,
no regional gating.

**Mouse-click sequence**:

1. Click Tab 1.
2. Click "Add agent" → "From A2A endpoint" in the dropdown.
3. `__OPERATOR_CAPTURE__` Click into the URL field, Cmd+V to paste the deployed URL.
4. Click "Discover".
5. Wait 6 s — Gemini Enterprise fetches the AgentCard, parses skills.
6. The skill list renders: `tiktok.lookup`, `tiktok.search`, `tiktok.profile`. Each row has a
   green "schema valid" badge.
7. Hover the `tiktok.lookup · schema valid` row for 3 s — the JSON-schema preview pops.
8. Click "Register all 3 skills".
9. Wait 5 s for the OIDC token-exchange handshake to complete (real Identity Platform latency
   per D19).
10. Toast appears: "3 skills registered — agent live in workspace ws_42".
11. Hover the toast for 2 s.

**Why D29-B works on screen**: the import takes *one URL paste* — Gemini Enterprise is the
post-Marketplace distribution channel for non-listable agents.

---

## Scene 4 — MCP protocol view in the local MCP dev tool

| Field | Value |
|---|---|
| **Real-time duration** | 90 s (00:03:45 → 00:05:15) |
| **8×-compressed duration** | ~11 s (final 00:00:28.1 → 00:00:39.4) |
| **D29 angle** | **D29-A** Agent-as-function (MCP tools are literally typed functions) |
| **Tools visible** | Terminal Pane A (`mcp dev` REPL), inline JSON viewer |

**Narrative bullet**:

The operator switches to Terminal Pane A. The MCP dev REPL is already running (started in
pre-record). They list available tools (`tools/list`), then call `tools/call` for
`tiktok.lookup` with a real handle `{username: "khaby.lame"}`. The MCP server hits TikTok's
public scraper layer, returns `{follower_count: 162_400_000, recent_posts: [...]}`. Each call
shows the exact JSON-RPC envelope.

**Mouse-click sequence**:

1. Cmd+Tab to Terminal.
2. Click Pane A to focus.
3. **Type** (real keystrokes; 8× blurs them — that's fine): `tools/list` + Enter (10 chars; 2 s).
4. The tool list streams out (3 tools, each with input/output schema). Wait 2 s for it to settle.
5. **Type**: `tools/call tiktok.lookup '{"username":"khaby.lame"}'` (50 chars; ~7 s real typing).
6. Press Enter.
7. Wait 6 s — the server calls TikTok via the existing scraper-pool path, returns JSON.
8. **Do not scroll** — the response is short enough to see at 8×.
9. Hover (with mouse, not in terminal) the JSON output for 3 s.
10. **Type**: `tools/call tiktok.search '{"query":"berlin haul","limit":5}'` (54 chars; ~8 s).
11. Press Enter.
12. Wait 5 s for the response (5 creators returned with handle + follower-count).

**Why D29-A is provable**: MCP `tools/call` is *the* canonical agent-as-function pattern —
typed input, typed output, version-stamped, USD-attributed at the server's tail-log layer.

---

## Scene 5 — A2A v0.3 client invokes the deployed Cloud Run agent

| Field | Value |
|---|---|
| **Real-time duration** | 105 s (00:05:15 → 00:07:00) |
| **8×-compressed duration** | ~13 s (final 00:00:39.4 → 00:00:52.5) |
| **D29 angle** | **D29-C** Multi-agent — A2A is the inter-agent transport, not just human-to-agent |
| **Tools visible** | Terminal Pane C (a2a-client), Tab 2 (Cloud Run logs streaming) |

**Narrative bullet**:

The operator focuses Terminal Pane C and runs the A2A client harness. Command:
`a2a-client --target https://<deployed-url>/a2a --skill tiktok.lookup --input
'{"username":"khaby.lame"}'`. The client opens a stream, sends the request, receives a
`message.event` containing the result. The Cloud Run logs (Pane B / Tab 2) show the matching
request ID. Two surfaces, one trace.

**Mouse-click sequence**:

1. Click Pane C to focus.
2. **Type** the command (operator can use ↑ to recall):
   `a2a-client --target https://tiktok-mcp-server-abc-uc.a.run.app/a2a --skill tiktok.lookup
   --input '{"username":"khaby.lame"}'` (~140 chars; ~18 s real typing — this is the longest
   typing block in the demo, intentional — at 8× becomes 2.25 s).
3. Press Enter.
4. Wait 5 s — the A2A handshake (`message.send` → `task.created` → `task.completed`) streams.
5. **Do not move the mouse** — the JSON output is dense; let the viewer absorb it.
6. The final `message.event` lands with the same result as Scene 4's MCP call.
7. Cmd+Tab to Tab 2 (Cloud Run logs).
8. Click the auto-refresh "live tail" toggle if not already on.
9. Wait 4 s — the matching request appears: `"a2a_task_id":"task_19f3..."` plus 
   `"latency_ms":342`.
10. Hover the latency value for 2 s.
11. Hover the request-ID for 2 s so the trace-link "Open in Cloud Trace" tooltip shows.

**Why D29-C is provable**: the same skill is reachable over MCP (Scene 4) and A2A (Scene 5) —
two protocols, one server, one trace correlation across them.

---

## Scene 6 — Model Armor + Identity Platform on the request path (D21 + D19)

| Field | Value |
|---|---|
| **Real-time duration** | 75 s (00:07:00 → 00:08:15) |
| **8×-compressed duration** | ~9.4 s (final 00:00:52.5 → 00:01:01.9) |
| **D29 angle** | **D29-B** narrative + **D29-C** safety surface |
| **Tools visible** | Tab 2 (Cloud Run logs), Terminal Pane C |

**Narrative bullet**:

The operator runs a deliberately-malicious A2A call:
`--input '{"username":"; DROP TABLE users; --"}'`. The server's Model Armor middleware (D21
custom regex) catches it; the response is a `task.failed` with `reason=model_armor_block`,
`category=injection_attempt`. The Cloud Run logs show the structured audit record. The
Identity Platform OIDC chip in the response header confirms the caller was authenticated.

**Mouse-click sequence**:

1. Click Pane C.
2. **Type**: `a2a-client --target ... --skill tiktok.lookup --input '{"username":"; DROP TABLE
   users; --"}'` (operator can use ↑ + edit; ~10 s real time).
3. Press Enter.
4. Wait 3 s — the `task.failed` response lands fast (Model Armor short-circuits).
5. The response JSON is visible: `{"error":"model_armor_block","category":"injection","layer":"
   pre-tool-call"}`.
6. Hover the `layer: pre-tool-call` chip for 2 s.
7. Cmd+Tab to Tab 2.
8. Wait 3 s for the log entry to scroll into view: `[model-armor] BLOCK
   category=injection_attempt actor=<oidc_sub>`.
9. Hover the OIDC sub for 2 s.

**Why D29-B + D29-C are *safety* provable**: a real attack on a real Cloud Run service was
neutralized in real time. This is more credible than a screenshot of "Model Armor is enabled".

---

## Scene 7 — Gemini Enterprise workspace calls the agent via natural language

| Field | Value |
|---|---|
| **Real-time duration** | 120 s (00:08:15 → 00:10:15) |
| **8×-compressed duration** | ~15 s (final 00:01:01.9 → 00:01:16.9) |
| **D29 angle** | **D29-B** — distribution achieved without Marketplace |
| **Tools visible** | Tab 1 (Gemini Enterprise workspace chat), Tab 2 (Cloud Run logs ticking) |

**Narrative bullet**:

Back in Gemini Enterprise (Tab 1). The operator opens a workspace chat with the registered
agent. They type: *"Look up the TikTok profile of @khaby.lame and tell me their top 3 recent
posts."* Gemini Enterprise's planner selects the `tiktok.lookup` skill, executes it via A2A,
synthesizes the answer. The Cloud Run logs (Tab 2) confirm the back-end was hit.

**Mouse-click sequence**:

1. Click Tab 1.
2. Click "Chat" in the workspace nav.
3. Click into the chat input.
4. **Type** the query (real typing): *Look up the TikTok profile of @khaby.lame and tell me
   their top 3 recent posts.* (90 chars; ~12 s real time; 8× = 1.5 s).
5. Press Enter.
6. Wait 4 s — the planner emits a "calling tool: tiktok.lookup" stream marker visible inline.
7. Wait 6 s — the answer streams: 3 post URLs + brief description per post.
8. Hover the inline "view trace" link for 3 s — popover shows the A2A `task_id` + latency.
9. Click Tab 2.
10. Wait 3 s — the log entry shows `[a2a] task_completed actor=gemini-enterprise-planner
    skill=tiktok.lookup`.
11. Hover the actor field for 2 s.

**Why D29-B is *distribution* provable**: the agent was just used in production by a Gemini
Enterprise user without anyone going to Marketplace.

---

## Scene 8 — Cost ledger + per-call USD accounting

| Field | Value |
|---|---|
| **Real-time duration** | 60 s (00:10:15 → 00:11:15) |
| **8×-compressed duration** | ~7.5 s (final 00:01:16.9 → 00:01:24.4) |
| **D29 angle** | **D29-A** — per-call USD on every agent function |
| **Tools visible** | Tab 2 (Cloud Run console → Metrics → Custom dashboard) |

**Narrative bullet**:

The operator opens the custom dashboard in Tab 2 showing per-skill USD. The bar chart shows:
`tiktok.lookup: 47 calls · $0.094`, `tiktok.search: 12 calls · $0.036`, `tiktok.profile: 3 calls
· $0.009`. Total $0.139 across the demo so far — the D39 credit envelope barely moves.

**Mouse-click sequence**:

1. Click Tab 2.
2. Click "Metrics" in the left rail.
3. Click the saved view "tiktok-mcp-server USD by skill".
4. Wait 4 s for the chart to render (real BigQuery query latency).
5. Hover the `tiktok.lookup` bar for 3 s — tooltip shows breakdown.
6. Click the time-range selector, change to "last 1 hour".
7. Wait 3 s for re-render.
8. Hover the chart legend for 2 s.

**Why D29-A is provable**: even at the MCP layer, each skill call is metered in USD — same
pattern as Track 2's agent functions.

---

## Scene 9 — Producer Portal pending listing (D3 reframe artifact)

| Field | Value |
|---|---|
| **Real-time duration** | 60 s (00:11:15 → 00:12:15) |
| **8×-compressed duration** | ~7.5 s (final 00:01:24.4 → 00:01:31.9) |
| **D29 angle** | **D29-B** — explicit acknowledgement of the gap; turns the negative into evidence |
| **Tools visible** | Producer Portal (Cloud Console section), screenshot fallback if portal is region-restricted at recording time |

**Narrative bullet**:

The operator opens Producer Portal. The submitted listing is in `status=pending_legal_entity`.
The status detail explicitly cites "no eligible payment-region billing entity for the seller
account". The operator hovers it, then clicks the linked Devpost write-up link in a sticky
note: "We turned this gap into the Innovation thesis — see Devpost §3 (A2A-only distribution
path)."

**Mouse-click sequence**:

1. Click Producer Portal tab (or `__OPERATOR_CAPTURE__` if portal is unavailable that day, paste
   the pre-saved screenshot at `assets/track3-portal-pending.png`).
2. Scroll to the listing row.
3. Hover the `pending_legal_entity` chip for 3 s — full reason renders in tooltip.
4. Click the chip to expand the inline detail.
5. Scroll to bring the "Operator note" sticky into view.
6. Hover the Devpost-link sticky note for 3 s.

**Why D29-B is provable**: this scene shows the actual block; the next scene shows the
workaround working. Together they are the innovation thesis on screen.

---

## Scene 10 — Multi-tenant + multi-region active-active (D13 evidence)

| Field | Value |
|---|---|
| **Real-time duration** | 90 s (00:12:15 → 00:13:45) |
| **8×-compressed duration** | ~11 s (final 00:01:31.9 → 00:01:43.2) |
| **D29 angle** | **D29-C** — enterprise-grade ops makes the post-Marketplace distribution credible |
| **Tools visible** | Tab 2 (Cloud Run revisions across regions), Cloud Monitoring dashboard |

**Narrative bullet**:

The operator opens the multi-region view: three Cloud Run revisions deployed simultaneously in
`asia-northeast3`, `us-central1`, `europe-west1`. Cloud Monitoring shows the global LB routing
~30% / 50% / 20% by latency-based geo-routing. Identity Platform's tenant selector in the
Gemini Enterprise sidebar shows 3 demo tenants.

**Mouse-click sequence**:

1. Click Tab 2.
2. Click "Revisions" in the service detail.
3. Filter by "region:any-active".
4. Three rows visible. Hover the asia-northeast3 row for 2 s.
5. Hover the us-central1 row for 2 s.
6. Click "Monitoring" tab.
7. The geo-routing graph renders. Wait 4 s.
8. Hover the bar showing 30/50/20 split for 3 s.
9. Click Tab 1 (Gemini Enterprise).
10. Click the tenant selector dropdown in the top bar.
11. Three tenants visible: `demo-kr`, `demo-us`, `demo-eu`.
12. Hover the dropdown for 2 s, then close it.

**Why D29-C is provable**: enterprise-standards (D13 + D19 + D31) make this a credible
production candidate, not a hackathon toy.

---

## Scene 11 — A2A streaming response (the multimodal payload)

| Field | Value |
|---|---|
| **Real-time duration** | 90 s (00:13:45 → 00:15:15) |
| **8×-compressed duration** | ~11 s (final 00:01:43.2 → 00:01:54.5) |
| **D29 angle** | **D29-C** Multimodal — A2A v0.3 supports image+text response chunks |
| **Tools visible** | Terminal Pane C, inline image-render shim |

**Narrative bullet**:

The operator runs a final A2A client call to a profile-with-thumbnails skill:
`--skill tiktok.profile --input '{"username":"khaby.lame","include_thumbnails":true}'`. The
response streams in chunks — first the JSON metadata, then a series of `binary/image-base64`
chunks for the top-3 video thumbnails, then a `text/markdown` summary chunk. The terminal
harness renders the images inline (using iTerm2's image protocol).

**Mouse-click sequence**:

1. Click Pane C.
2. **Type** the command (or ↑-recall): the profile-with-thumbnails command (~12 s real time).
3. Press Enter.
4. Wait 3 s — JSON envelope arrives first.
5. Wait 5 s — three image chunks stream in, rendered inline as small thumbnails.
6. Wait 4 s — final markdown summary chunk renders below.
7. **Do not move the mouse** — let the viewer see all three modalities in the same response.
8. Scroll once to bring the markdown summary fully visible.

**Why D29-C is provable**: text + image + structured JSON in one A2A response is the literal
proof of the multimodal claim.

---

## Scene 12 — System health check (MCP server smoke + Cloud Run readiness)

| Field | Value |
|---|---|
| **Real-time duration** | 30 s (00:15:15 → 00:15:45) |
| **8×-compressed duration** | ~3.75 s (final 00:01:54.5 → 00:01:58.3) |
| **D29 angle** | All three (same pattern as Track 2 Scene 12) |
| **Tools visible** | Terminal Pane A (MCP dev), Pane B (Cloud Run logs), inline `curl /healthz` |

**Narrative bullet**:

The operator runs the smoke command:
`curl -sS https://<deployed-url>/healthz | jq`. Response: `{"status":"ok","skills":3,"deps":
{"identity_platform":"ok","model_armor":"ok","scraper_pool":"ok"},"version":"0.4.1"}`. They
then run `python -m pytest gcp-research/refactor-mcp/code/agent/tests/ -q` — fast unit test
sweep returns 47 passed in 4.2 s.

**Mouse-click sequence**:

1. Click Pane B (or open a clean terminal pane).
2. **Type** (or ↑-recall): `curl -sS https://tiktok-mcp-server-abc-uc.a.run.app/healthz | jq`
   (~6 s real time).
3. Press Enter.
4. Wait 2 s — JSON arrives.
5. **Type**: `pytest gcp-research/refactor-mcp/code/agent/tests/ -q` (~5 s real time).
6. Press Enter.
7. Wait 6 s — pytest streams `....` then `47 passed in 4.2s`.
8. Hold for 2 s on the green PASS line.

**Why this scene closes the demo**: the live Cloud Run service replies to a `curl`, and the
local test suite stays green. The two together prove deploy-ready.

---

## 13. Hard-cap timing audit

Sum of real-time durations: 60 + 60 + 105 + 90 + 105 + 75 + 120 + 60 + 60 + 90 + 90 + 30 =
**945 s = 15:45**. Remaining 8:15 = inter-scene pauses + tab switches + scroll-resets. Same
24:00 ± 30 s target as Track 2.

Sum of 8×-compressed: 7.5 + 7.5 + 13 + 11 + 13 + 9.4 + 15 + 7.5 + 7.5 + 11 + 11 + 3.75 = **117.15 s
= 1:57**. Remaining ~63 s = intro + outro + cross-fades. **Final target: 3:00 ± 2 s.**

---

## 14. Track 3 specific assets

- **Intro card** — `assets/intro/track3-intro-card.png` already authored. Titles: "TikTok MCP
  Server · Track 3 · Gemini Enterprise + A2A v0.3".
- **Outro card** — `assets/outro/track3-outro-cta.png`. CTA: GitHub repo + the `.well-known/
  agent.json` URL.
- **Mermaid diagram** — `submission/ARCHITECTURE-track3.mmd` already authored; rendered to PNG
  via `submission/render-architecture.sh`. Diagram embedded in overlay at Scenes 2, 5, 7.
- **Producer Portal screenshot** — pending; per `gcp-research/demo/SCRIPT.md` follow-up DEMO-3,
  the human operator captures it when the listing is filed. If unavailable at record time, the
  Scene 9 fallback note above kicks in.

---

## 15. Differences from Track 2's storyboard

| Aspect | Track 2 | Track 3 |
|---|---|---|
| Primary D29 angle | A + C (Agent-as-function + AP2) | **B** (KR-region-gap) |
| Surfaces shown | Mission Control + Dialogflow + Gmail | Gemini Enterprise + MCP + A2A + Cloud Console |
| Workflow surface | Inngest → Workflows (current state) | A2A protocol envelope |
| Closing proof | `brand_campaign_smoke.py` (22 agents) | `curl /healthz` + pytest |
| Multimodal evidence | Image attachment in outreach email | Inline image chunks in A2A streaming response |

**End of STORYBOARD-track3.md.**
