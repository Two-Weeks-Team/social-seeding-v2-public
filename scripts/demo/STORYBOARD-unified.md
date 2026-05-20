# Storyboard — Unified (single Track 3 submission, one narrative)

> **Authority**: implements **D45** (single Track 3 Devpost submission that subsumes the entire
> Track 2 platform — supersedes D1), **D29** (three differentiation angles, demo emphasizes
> whichever angle the scene illustrates), **D30** (8×-speed real-mouse recording, no slides, no
> narration), **D34** (4 locales: ko/en/ja/zh-CN), and the **D49** wow/business reinforcement.
> Per `gcp-research/decisions/DECISIONS.md`.
>
> **Why this file exists**: `STORYBOARD-track2.md` (12 scenes) and `STORYBOARD-track3.md` (12
> scenes) were authored under **D1** (dual submission — two Devpost entries, two videos, recorded
> on separate days). **D45 retired D1.** There is now ONE submission and ONE story. This file is
> the single-narrative re-cut: it does **not** replace the two track files (they remain the
> per-surface mouse-click manuals), it **threads them into one arc** whose load-bearing edge —
> the climax — is the Track-2 `coordinator` agent A2A-invoking the Track-3 `tiktok-mcp-server`.
>
> **The one sentence (UNIFIED-TRACK3-PLAN §1)**: *Social Seeding turns the Korean-startup
> Marketplace-payment-region exclusion into an A2A ecosystem — a 22-agent ADK fleet + AP2 Intent
> Mandate + multimodal pipeline that call each other over A2A v0.3; the first external node of
> that ecosystem is an OSS `tiktok-mcp-server` refactored into an A2A agent, registered with
> Gemini Enterprise, distributed without a Marketplace listing.*
>
> **Companion files**: `STORYBOARD-track2.md`, `STORYBOARD-track3.md` (the per-surface mouse
> manuals this re-cut threads together), `web-demo/index.html` (the no-FFmpeg interactive
> replacement — 24 scenes, the engine that renders this narrative), `web-demo/wow-business.html`
> (the D49 climax surface: real Imagen 4 image + animated A2A cross-call + ROI/TAM + Build
> Example #2), `gcp-research/refactor-mcp/A2A-INTENTS.md` (the cross-call's source-of-truth, §4).

---

## 0. The single narrative in one diagram

```
        ┌──────────────────────── ACT I ────────────────────────┐
        │  Track-2 brand-campaign flow (operator + ADK fleet)    │
        │  brief → intake → AP2 Intent Mandate → bulk sourcing   │
        └──────────────────────────┬─────────────────────────────┘
                                    │  the sourcing step needs creators
                                    ▼
        ┌─────────────────── ACT II — CLIMAX ────────────────────┐
        │  coordinator (M1)  ──a2a_invoke──▶  tiktok-mcp-server   │
        │  (Track-2 fleet)      A2A v0.3        (Track-3 refactor)│
        │  318 ms round-trip · SPIFFE identity (D48) · 5 creators │
        │  ◀──── RankedCreators task/completed ────────────────── │
        └──────────────────────────┬─────────────────────────────┘
                                    │  creators flow back into the loop
                                    ▼
        ┌──────────────────────── ACT III ───────────────────────┐
        │  Track-2 finishes the loop on the A2A result            │
        │  outreach → reply → ship → verify → $0.01/view → report │
        │  + the KR-region-gap reframe is WHY A2A, not Marketplace │
        └─────────────────────────────────────────────────────────┘
```

The two old storyboards each told half of this. **The unification is the edge in ACT II.** Per
`A2A-INTENTS.md §4`, that edge is concrete code today:
`packages/agents-adk/src/ss_agents/agents/coordinator.py` carries `tools=[agent_registry_list,
a2a_invoke]`; it scores a candidate pool that includes `tiktok-mcp-search`
(`transport="a2a_grpc"`, `capabilities=["source_creators","tiktok","remote","a2a"]`); when it
picks that candidate, `packages/agents-adk/src/ss_agents/tools/a2a_invoke.py` does the outbound
A2A v0.3 hop (enforces `https`, `USD_COST=$0.0005/hop`, acquires a SPIFFE token in live mode).

---

## 1. Operator at-a-glance — the unified re-cut

| | Real time | 8× final time |
|---|---|---|
| Total | **~24:00** | **~3:00** |
| Acts | **3** | (same 3) |
| Scenes | **13** (1 NEW bridge scene + 12 re-threaded) | proportional shrink |

The unified arc keeps the existing per-track scene library but **re-orders and de-duplicates**
them around the cross-call. The interactive web-demo (`web-demo/index.html`) still ships the full
24-scene library behind a **Track 2 / Track 3** toggle so a judge can drill into either surface;
this storyboard defines the **single guided path** through them (the recommended scene-jump
sequence) plus the **one new bridge scene** that did not exist in either track file: the
`coordinator → a2a_invoke` hand-off.

**The recommended single-take path** (scene-jump order across the existing 24-scene library):

| Act | Web-demo scenes used | Surface |
|---|---|---|
| I — Setup | Track 2 · Scene 1, 2, 3 | Mission Control intake + AP2 + sourcing |
| **II — CLIMAX (the bridge)** | **NEW bridge → Track 3 · Scene 5** + `wow-business.html#a2a-crosscall` | coordinator a2a_invoke → ss-mcp |
| III — Payoff | Track 2 · Scene 4, 5, 7 + `wow-business.html#roi` + Track 3 · Scene 9 | outreach→verify→$0.01/view + KR-gap |
| Coda | Track 2 · Scene 12 (smoke) + `wow-business.html#build-example-2` | proof + official-guide match |

D-ID references for each scene point to:

- **`D29-A`** = Agent-as-function (typed function, USD cap, Zod/Pydantic I/O, escalation — not a ReAct loop)
- **`D29-B`** = KR-region-gap (Marketplace payment-region exclusion → A2A-only distribution path, D2/D3)
- **`D29-C`** = Multimodal + AP2 + Multi-agent (image+text+structured payloads, Intent Mandate, RemoteA2AAgent)

The cross-call scene carries **all three at once** and is therefore the demo's single most
load-bearing moment.

---

## ACT I — Setup (Track-2 flow begins; ~3:15 real / ~24 s @8×)

### U1 — Brand brief intake `[= Track 2 · Scene 1]`

| Field | Value |
|---|---|
| **Real / 8×** | 90 s / ~11 s |
| **D29 angle** | **D29-A** Agent-as-function — intake collapses a free-text brief into a typed Zod `BrandBriefSchema` call |
| **Surface** | `web-demo` Track 2 · Scene 1 (Mission Control `/campaigns/new`) |
| **Build Example #2 link** | none yet (sets up the marketing-agent context the Guide describes) |

A brand marketer pastes a one-paragraph brief ("40 TikTok creators, beauty/lifestyle, Gen-Z,
Korea, $0.01/view budget"). One Submit. The `intake` agent runs as a typed function — the
`Cost cap: $400` and `Agent function: intake-v3` chips are populated by the contract, not by free
text. **This is where the marketing-agent narrative of `designed_guide.pdf` Build Example #2
starts**: a Gemini-powered agent ingesting a brief.

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 1 (unchanged).

### U2 — AP2 Intent Mandate signing `[= Track 2 · Scene 2]`

| Field | Value |
|---|---|
| **Real / 8×** | 60 s / ~7.5 s |
| **D29 angle** | **D29-C** Multimodal + AP2 + Multi-agent — explicit Intent Mandate per **D27** (Intent only; Cart/Payment deferred) |
| **Surface** | `web-demo` Track 2 · Scene 2 (`/campaigns/<id>/mandate`) |

The marketer signs an AP2 **Intent** Mandate (`scope=outreach+payment`, `cap=$400`, `expiry=72h`)
with the workspace key (Ed25519 sig visible). **D27 on screen**: this is Intent only — the agent
plans, the human approves payment. The visible JSON + signature line is the audit evidence, not a
black-box "approved" button.

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 2 (unchanged).

### U3 — Bulk-approve sourcing batch `[= Track 2 · Scene 3]`

| Field | Value |
|---|---|
| **Real / 8×** | 45 s / ~5.6 s |
| **D29 angle** | **D29-A** Agent-as-function — the `sourcing` agent returns typed `CreatorMatch` rows |
| **Surface** | `web-demo` Track 2 · Scene 3 (`/approvals`) |

The marketer bulk-approves the sourcing batch. Every row carries the agent name (`sourcing-v2`),
USD spent ($0.012/row), and the contract version (`CreatorMatch@1.4.0`). One click, not 40 — the
agent did the per-row work. **This is the seam that hands off to ACT II**: the sourcing work the
marketer just approved is exactly what the `coordinator` routes to the Track-3 MCP server.

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 3 (unchanged).

---

## ACT II — CLIMAX: the cross-call (the unification moment; ~3:30 real / ~26 s @8×)

This act is where the two submissions become one. **It is the only part of the unified narrative
that was NOT in either track file** — the old D1 storyboards never showed the Track-2 fleet
calling the Track-3 agent, because under dual submission they were two separate videos. D45 makes
this edge the whole point.

### U4 — NEW · coordinator routes the sourcing task over A2A `[bridge scene]`

| Field | Value |
|---|---|
| **Real / 8×** | ~75 s / ~9 s |
| **D29 angle** | **ALL THREE** — D29-A (a2a_invoke is a typed function with `USD_COST=$0.0005`), D29-B (the agent ships over A2A *because* there is no KR Marketplace path), D29-C (RemoteA2AAgent fan-out, multi-agent) |
| **Surface** | `web-demo` (header cross-call callout) → `wow-business.html#a2a-crosscall` (the animated SVG) |
| **Source of truth** | `A2A-INTENTS.md §4` — `coordinator (M1) → a2a_invoke → tiktok-mcp-server.plan_creator_search` |
| **Build Example #2 link** | this is the *transport* the Guide's Build Example #2 describes — "A2A protocol… communicate with company's internal agent" — realized between two of our agents |

**Narrative bullet (what the viewer sees)**:

The sourcing step from U3 does not run a local heuristic. The Track-2 `coordinator` agent (M1)
scores its candidate pool, picks `tiktok-mcp-search` (`transport=a2a_grpc`), and calls
`a2a_invoke`. The screen shows the animated A2A diagram: a `brief` packet travels
**coordinator → a2a_invoke → ss-mcp-server** over HTTPS (TLS enforced, SPIFFE identity per D48),
the server runs `plan_creator_search`, and a `5 creators` packet returns on the lower lane.
The badge reads **`task/completed · 318 ms`** — the I3 measured round-trip against the live
Cloud Run endpoint (`https://ss-mcp-server-1049119860518.us-central1.run.app`,
`POST /v1/message:send`, OIDC bearer per D19). The result table shows the ranked set led by
`@kr_vegan_beauty` (412k followers, ER 0.0923, fit 0.222).

**Why this is the climax (all three angles in one frame)**:

- **D29-A**: `a2a_invoke` is a typed capability (`A2AInvokeInput` → task envelope), USD-metered
  ($0.0005/hop), not a free ReAct loop.
- **D29-B**: the *reason* the value crosses an A2A wire instead of a Marketplace SKU is the
  Korean payment-region exclusion (D2/D3). The cross-call **is** the KR-region-gap workaround.
- **D29-C**: a Track-2 agent invoking a Track-3 RemoteA2AAgent is literal multi-agent
  composition; the `RankedCreators` artifact is structured-data multimodality.

**Honest scope note** (per RULES.md): the 318 ms / 5-creators figures are I3's real measurement
against the live endpoint (dated 2026-05-19, recorded in `wow-business.html#a2a-crosscall`). In
shipped Phase-3 code `a2a_invoke` has a deterministic stub mode for CI; live mode (SPIFFE token +
Agent Gateway) is the W7 deploy path. Do not present the cross-call as fully autonomous payment —
it is creator-research routing.

> **Recommended operator action in the recording**: from the web-demo, click the header
> **"★ Wow + Business panel (D49)"** link to open `wow-business.html`, let the
> `#a2a-crosscall` SVG animate one full request/response cycle (3.4 s loop), hold on the
> `task/completed · 318 ms` badge for 2 s, then return to the demo (`← 24-scene interactive demo`).

### U5 — A2A client confirms the same skill end-to-end `[= Track 3 · Scene 5]`

| Field | Value |
|---|---|
| **Real / 8×** | 105 s / ~13 s |
| **D29 angle** | **D29-C** Multi-agent — A2A is the inter-agent transport, not just human-to-agent |
| **Surface** | `web-demo` Track 3 · Scene 5 (a2a-client terminal + Cloud Run logs) |

Immediately after the diagram, the demo proves the same edge at the protocol level: an `a2a-client`
call to the deployed Cloud Run agent (`message.send → task.created → task.completed`, `latency_ms`
shown), with the Cloud Run logs showing the matching `a2a_task_id`. Two surfaces (the Track-2
`a2a_invoke` and the raw A2A client), one server, one trace correlation. This is the empirical
backing for U4's diagram.

> Detailed mouse sequence: `STORYBOARD-track3.md` Scene 5 (unchanged).

---

## ACT III — Payoff: the loop closes on the A2A result (~7:00 real / ~50 s @8×)

The creators that came back over A2A flow through the rest of the Track-2 loop. Each scene now
reads as "downstream of the cross-call", not as a standalone Track-2 beat.

### U6 — Outreach drafts + human edit `[= Track 2 · Scene 4]`

| Field | Value |
|---|---|
| **Real / 8×** | 120 s / ~15 s |
| **D29 angle** | **D29-A + D29-C** — typed `OutreachDraft` schema + multimodal (auto-attached inspiration image) |
| **Surface** | `web-demo` Track 2 · Scene 4 (`/campaigns/<id>/outreach`, Gmail side-panel) |
| **Build Example #2 link** | the multimodal marketing-agent output (image + copy) the Guide describes |

The `outreach_writer` agent drafts 12 emails (one per top creator from the A2A result). The
operator edits one sentence (proving the human gate is real) and sends to `app.2weeks@gmail.com`
(D10 test-account-only). Each draft carries an attached image — the multimodal channel.

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 4 (unchanged).

### U7 — Reply classification + KR-gap subtext `[= Track 2 · Scene 5]`

| Field | Value |
|---|---|
| **Real / 8×** | 90 s / ~11.3 s |
| **D29 angle** | **D29-A** Agent-as-function; voiced subtext **D29-B** — the agent IS the channel because there is no Marketplace path in KR |
| **Surface** | `web-demo` Track 2 · Scene 5 (`/campaigns/<id>/inbox`) |

The `conversation` agent classifies the inbound reply (`interest=high`, `RequestedTerms=[NDA,
Net-30]`). The grey banner above the inbox — *"Distributing via A2A — no Marketplace listing
required"* — is the one verbal D29-B cue, reinforcing why ACT II went over A2A.

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 5 (unchanged).

### U8 — Verify + $0.01/view + ROI/TAM `[= Track 2 · Scene 7 + wow-business#roi]`

| Field | Value |
|---|---|
| **Real / 8×** | 90 s / ~11.2 s (+ ~10 s on the ROI panel) |
| **D29 angle** | **D29-B** (verify-agent IS the distribution measurement — no Marketplace analytics) + **Business** (D28 pricing) |
| **Surface** | `web-demo` Track 2 · Scene 7 (`/campaigns/<id>/verify`) → `wow-business.html#roi` + `#tam` |
| **Build Example #2 link** | `content_verify` is the agent the Guide's "on-brand and compliant" verdict maps to (see Coda U10) |

The `content_verify` agent confirms delivery and live view counts; the per-view cost ticker
($0.01 × views, D28) updates live. The demo then jumps to `wow-business.html#roi`: the worked
example ($380 budget → 38,000 verified views → $380 billed @ $0.01/view, $10 eCPM), the "no view,
no charge" framing, and the **TAM/SAM/SOM** napkin (TAM $32.6B global / SAM $489M Korea / SOM ~$5M
3-yr, every figure sourced or explicitly labelled an internal assumption). **This is the
Business-30% surface** that the demo previously lacked (D49(c)).

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 7 (unchanged); ROI/TAM panel: `wow-business.html`.

### U9 — The KR-region-gap, made explicit `[= Track 3 · Scene 9]`

| Field | Value |
|---|---|
| **Real / 8×** | 60 s / ~7.5 s |
| **D29 angle** | **D29-B** — the negative (Marketplace listing pending, no eligible KR payment-region billing entity) turned into the innovation thesis (D3) |
| **Surface** | `web-demo` Track 3 · Scene 9 (Producer Portal `status=pending_legal_entity`) |

The Producer Portal listing sits at `pending_legal_entity` — "no eligible payment-region billing
entity for the seller account" (D2). The operator note links to the Devpost write-up: *we turned
this gap into the Innovation thesis (A2A-only distribution path)*. **This scene is the answer to
"why ACT II at all?"** — it closes the loop the cross-call opened.

> Detailed mouse sequence: `STORYBOARD-track3.md` Scene 9 (unchanged).

---

## CODA — Proof + official-guide match (~0:30 real / ~4 s @8×)

### U10 — System health check + Build Example #2 match `[= Track 2 · Scene 12 + wow-business#build-example-2]`

| Field | Value |
|---|---|
| **Real / 8×** | 30 s / ~3.8 s (+ ~8 s on the Build Example #2 panel) |
| **D29 angle** | **ALL THREE** (the smoke runs every agent function, through a multi-agent loop, with no Marketplace dependency) |
| **Surface** | `web-demo` Track 2 · Scene 12 (smoke test) → `wow-business.html#build-example-2` + `#multimodal` |
| **Build Example #2 link** | **the explicit 1:1 callout** (D48/D49(d)) |

The `brand_campaign_smoke.py` canary streams `PASS — 22/22 agents · 0 failures · total $1.34`.
Then the demo lands on `wow-business.html#build-example-2`: the verbatim quote from
`designed_guide.pdf` p.7 (the marketing agent that uses A2A to reach a DAM agent for approved
brand logos) mapped element-for-element onto our **`content_verify`** agent + its
**`vision.brand_logo_detect`** capability — including the honest scope note that today the
brand-asset check is an in-process ADK FunctionTool (the A2A-DAM promotion is the same Phase-4
lift as ACT II's live-wiring). Adjacent, `#multimodal` shows the **one real Imagen 4 generation**
(`imagen-4.0-generate-001`, 1:1 1024×1024, 950,522 bytes, ≈$0.04 on `ss-v2-prod`, NOT a stub) —
the multimodal channel the Build Example #2 marketing agent needs (D49(a)).

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 12 (unchanged); panels in `wow-business.html`.

---

## 2. Scene-by-scene D29 three-angle mapping (the whole arc on one page)

| Unified scene | Web-demo source | D29-A | D29-B | D29-C | Build Ex. #2 |
|---|---|:---:|:---:|:---:|:---:|
| U1 intake | T2·S1 | ● | | | (sets up marketing agent) |
| U2 AP2 Intent | T2·S2 | | | ● | |
| U3 bulk sourcing | T2·S3 | ● | | | |
| **U4 cross-call (NEW)** | header→`#a2a-crosscall` | ● | ● | ● | A2A transport |
| U5 A2A client | T3·S5 | | | ● | |
| U6 outreach | T2·S4 | ● | | ● | multimodal output |
| U7 reply | T2·S5 | ● | ● | | |
| U8 verify + ROI/TAM | T2·S7 + `#roi`/`#tam` | | ● | | `content_verify` |
| U9 KR-gap | T3·S9 | | ● | | |
| **U10 smoke + Build Ex.#2** | T2·S12 + `#build-example-2`/`#multimodal` | ● | ● | ● | **1:1 match** |

Every D29 angle is exercised; **U4 and U10 each carry all three.** This satisfies D29's
"demo emphasizes whichever angle the scene illustrates" while keeping the single-narrative spine.

`designed_guide.pdf` Build Example #2 (marketing agent + Gemini multimodal + A2A → DAM for
on-brand logos) is matched in two places: the **transport** (U4 — agents calling each other over
A2A) and the **agent role** (U10 — `content_verify` ↔ DAM, `vision.brand_logo_detect` ↔
approved-logo check). Source: `A2A-INTENTS.md §5`.

---

## 3. Climax-asset placement (I3 data + I9 wow assets)

| Asset | Origin | Where it lands in the arc |
|---|---|---|
| **318 ms round-trip** | I3 live measurement (2026-05-19) | U4 badge `task/completed · 318 ms` (`wow-business.html#a2a-crosscall`) |
| **5 ranked creators** (`@kr_vegan_beauty` 412k / ER 0.0923 / fit 0.222) | I3 live A2A call | U4 result table |
| **Live endpoint** `ss-mcp-server-…run.app` | I1 deploy | U4 + U5 |
| **Animated A2A cross-call SVG** | I9 (D49b) | U4 — the climax visual |
| **Real Imagen 4 image** (`imagen-4.0-generate-001`, $0.04, 950 KB) | I9 (D49a) | U10 `#multimodal` |
| **ROI worked example + TAM/SAM/SOM** | I9 (D49c) | U8 `#roi` + `#tam` |
| **Build Example #2 1:1 callout** | I8/I9 (D48/D49d) | U10 `#build-example-2` |

All wow assets are concentrated in **ACT II climax (U4)** and the **CODA payoff (U8/U10)** — the
two moments a judge's attention is highest.

---

## 4. What this storyboard does NOT change

- **The 24-scene web-demo engine** — `web-demo/index.html` ships the full Track-2 + Track-3 scene
  library behind a toggle, auto-plays, and is the canonical no-FFmpeg demo per D30. This file
  defines the *guided path* through it; it does not require the engine to be re-cut to 13 scenes.
- **The two per-surface track storyboards** — `STORYBOARD-track2.md` / `STORYBOARD-track3.md`
  remain the authoritative mouse-click manuals. This file references them by scene number; it
  does not duplicate their click sequences.
- **D30 format** — still 8× real-mouse, no narration; subtitles only
  (`subtitles/{track2,track3}-{ko,en,ja,zh-CN}.srt`). The unified path reuses those cues.
- **Audio narration** — none, per D30.

---

## 5. Cross-references

- D45 (single Track 3 subsumes platform) → `gcp-research/decisions/DECISIONS.md` line 139
- D29 (three angles) → `DECISIONS.md` line 93
- D30 (8× real-mouse) → `DECISIONS.md` line 94
- D27 (AP2 Intent only) → `DECISIONS.md` line 91
- D28 ($0.01/view) → `DECISIONS.md` line 92
- D48 (A2A intents + Agent Identity) / D49 (wow + business) → `DECISIONS.md` lines 149-150
- Unified narrative one-sentence → `gcp-research/goal-mode/UNIFIED-TRACK3-PLAN.md` §1
- Cross-call source of truth → `gcp-research/refactor-mcp/A2A-INTENTS.md` §4 (the edge) + §5 (Build Example #2)
- The 24-scene engine → `scripts/demo/web-demo/index.html`
- The wow/business climax surface → `scripts/demo/web-demo/wow-business.html`
- Per-surface mouse manuals → `STORYBOARD-track2.md`, `STORYBOARD-track3.md`

**End of STORYBOARD-unified.md.**
