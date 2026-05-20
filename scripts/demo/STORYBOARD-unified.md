# Storyboard — the single grand arc (Build → Optimize → Refactor)

> **Authority**: implements **D50** (one grand-narrative Track 3 submission aimed at the Overall
> Grand Prize — supersedes the dual-submission idea; folds the Optimize "hardening" work into the
> single arc as Technical-30% evidence), **D45** (single Track 3 submission subsuming the whole
> platform), **D25** (the optimize/learning loop), **D29** (three differentiation angles), **D30**
> (8×-speed real-mouse recording, no slides, no narration), **D34** (4 locales: ko/en/ja/zh-CN),
> **D47** (Model Garden routing), **D48** (A2A intents + Agent Identity), and the **D49** wow/business
> reinforcement. Per `gcp-research/decisions/DECISIONS.md` and
> `gcp-research/goal-mode/GRAND-NARRATIVE-PLAN.md` (the spine, §2 arc · §4 wow · §5-1 hardening).
>
> **Why this file is now ONE arc, not a re-cut of two halves**: earlier drafts threaded two
> per-track storyboards (`STORYBOARD-track2.md` / `STORYBOARD-track3.md`) into a unified path. D50
> goes further: there is one product maturing through **three stages** — we **Built** a 22-agent
> fleet, we **Optimized** (hardened) it until a measurable reliability gap closed, and we
> **Refactored** it into an enterprise A2A ecosystem. The demo tells that single maturation story.
> The two per-track files remain the per-surface mouse-click manuals; this file is the **guided
> single take** across them plus the **two new scenes** that did not exist before: the Optimize
> stall→repair climax, and the A2A cross-call wired into the live brand-campaign Cloud Workflow.
>
> **The one sentence**: *We built a 22-agent fleet that runs the influencer-campaign loop, hardened
> it until an ambiguous-reply routing gap closed (triage routing accuracy 40.5% → 100.0% on train, 71.4% on an unseen holdout), and
> refactored it into an enterprise A2A ecosystem — Cloud Run + Model Garden reasoning + cryptographic
> Agent Identity — where a coordinator agent A2A-invokes our OSS `tiktok-mcp-server` as part of the
> orchestration, and a Korean-region Marketplace exclusion becomes an A2A-only distribution path.*
>
> **Companion files**: `STORYBOARD-track2.md`, `STORYBOARD-track3.md` (per-surface mouse manuals this
> arc threads together), `HARDENING-CHAPTER.md` (the Optimize chapter source — H1-H4 + honest scope),
> `web-demo/index.html` (the no-FFmpeg interactive replacement — 24 scenes, the render engine),
> `web-demo/wow-business.html` (the D49 surface: real Imagen 4 + animated A2A cross-call + ROI/TAM +
> Build Example #2), `gcp-research/refactor-mcp/A2A-INTENTS.md` (the cross-call source-of-truth §4 +
> Build Example #2 §5).

---

## 0. The single arc in one diagram

```
   ┌──────────────────────── ACT I — BUILD ─────────────────────────┐
   │  A 22-agent ADK fleet runs the influencer-campaign loop          │
   │  brief → intake → AP2 Intent Mandate → bulk sourcing → outreach  │
   │  …it works in the sandbox.                                       │
   └────────────────────────────┬─────────────────────────────────────┘
                                 │  "but is it reliable?"
                                 ▼
   ┌──────────────── ACT II — OPTIMIZE (CLIMAX) ─────────────────────┐
   │  An ambiguous creator reply ("Love it! my rate is ~$800, ok?")   │
   │  STALLS the responder at the auto-respond ↔ escalate boundary.   │
   │  Observability trace shows the stall → we add one triage rule →  │
   │  the trace FLOWS. Re-measured on 56 synthetic cases:             │
   │     triage routing accuracy  40.5% → 100.0% (train, +59.5pp)     │
   │  Anti-overfit holdout (unseen 14 cases): 71.4% — 28.6pp gap kept │
   └────────────────────────────┬─────────────────────────────────────┘
                                 │  "now make it enterprise-distributable"
                                 ▼
   ┌──────────────────── ACT III — REFACTOR ─────────────────────────┐
   │  Cloud Run + Model Garden reasoning + cryptographic Agent ID +   │
   │  A2A-native. Inside the brand-campaign Cloud Workflow, the        │
   │  coordinator's routing step switches transport and A2A-invokes    │
   │  our OSS tiktok-mcp-server: task/completed, ~3.7s, 5 creators.    │
   │  content_verify ↔ DAM = official Guide Build Example #2 (1:1).    │
   │  KR Marketplace-region exclusion → A2A-only distribution path.    │
   └─────────────────────────────────────────────────────────────────┘
```

The climax is **ACT II's stall→repair** — it is simultaneously the Technical-30% reliability proof
and the single strongest Demo-20% visual (a reasoning graph that halts, then flows). ACT III's
**A2A-into-orchestration** edge is the second peak: it is no longer just *documented*, it is a step
inside the live brand-campaign Cloud Workflow.

Per `A2A-INTENTS.md §4`, the ACT III edge is concrete code today:
`packages/agents-adk/src/ss_agents/agents/coordinator.py` carries `tools=[agent_registry_list,
a2a_invoke]`; it scores a candidate pool including `tiktok-mcp-search` (`transport="a2a_grpc"`,
`capabilities=["source_creators","tiktok","remote","a2a"]`); the brand-campaign Cloud Workflow's
coordinator routing step performs the **transport switch** and calls
`packages/agents-adk/src/ss_agents/tools/a2a_invoke.py`, which does the outbound A2A v0.3 hop
(enforces `https`, `USD_COST=$0.0005/hop`, acquires a SPIFFE token in live mode).

---

## 1. Operator at-a-glance — the single take

| | Real time | 8× final time |
|---|---|---|
| Total | **~24:00** | **~3:00** |
| Acts | **3** (Build · Optimize · Refactor) | (same 3) |
| Scenes | **12** (2 NEW: the Optimize climax + the A2A-in-workflow hop) | proportional shrink |

The arc keeps the existing per-track scene library but **re-orders and de-duplicates** it around two
new beats. The interactive web-demo (`web-demo/index.html`) still ships the full 24-scene library
behind a **Track 2 / Track 3** toggle so a judge can drill into either surface; this storyboard
defines the **single guided path** through them, plus the **two new scenes** that did not exist in
either track file:

- **U4 (NEW · Optimize climax)** — the Observability stall→repair trace + the 40.5% → 100.0% (train) / 71.4% (holdout) bar.
- **U6 (NEW · Refactor hop)** — `coordinator → a2a_invoke → tiktok-mcp` *as a step inside the live
  brand-campaign Cloud Workflow* (previously only the diagram existed; now it is wired into
  orchestration).

**The recommended single-take path** (scene-jump order across the 24-scene library):

| Act | Web-demo scenes used | Surface |
|---|---|---|
| I — BUILD | Track 2 · Scene 1, 2, 3 | Mission Control intake + AP2 + sourcing |
| **II — OPTIMIZE (CLIMAX)** | **NEW U4** (`HARDENING-CHAPTER` assets) | Observability stall→repair + before/after bar |
| **III — REFACTOR** | **NEW U6** + Track 3 · Scene 5 + `wow-business.html#a2a-crosscall` + Track 2 · S4/S7 + Track 3 · S9 + `#roi`/`#tam`/`#build-example-2`/`#multimodal` | A2A-in-workflow hop → loop payoff → Model Garden/Identity → Build Ex.#2 + Imagen |

D29 angle legend (used in every scene table):

- **`D29-A`** = Agent-as-function (typed function, USD cap, Pydantic/Zod I/O, escalation — not a ReAct loop)
- **`D29-B`** = KR-region-gap (Marketplace payment-region exclusion → A2A-only distribution, D2/D3)
- **`D29-C`** = Multimodal + AP2 + Multi-agent (image+text+structured payloads, Intent Mandate, RemoteA2AAgent)

---

## ACT I — BUILD (the fleet runs the loop; ~3:15 real / ~24 s @8×)

> **On-screen act card**: **"BUILD — a 22-agent fleet runs the campaign loop."**

### U1 — Brand brief intake `[= Track 2 · Scene 1]`

| Field | Value |
|---|---|
| **Real / 8×** | 90 s / ~11 s |
| **D29 angle** | **D29-A** — intake collapses a free-text brief into a typed Pydantic/Zod `BrandBriefSchema` call |
| **Surface** | `web-demo` Track 2 · Scene 1 (Mission Control `/campaigns/new`) |
| **On-screen callout** | "Agent function: `intake-v3` · Cost cap $400" (populated by the contract, not free text) |

A brand marketer pastes a one-paragraph brief ("40 TikTok creators, beauty/lifestyle, Gen-Z, Korea,
$0.01/view budget"). One Submit. The `intake` agent runs as a typed function — the `Cost cap: $400`
and `Agent function: intake-v3` chips come from the contract, not free text. This sets up the
marketing-agent narrative of `designed_guide.pdf` Build Example #2: a Gemini-powered agent ingesting
a brief.

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 1 (unchanged).

### U2 — AP2 Intent Mandate signing `[= Track 2 · Scene 2]`

| Field | Value |
|---|---|
| **Real / 8×** | 60 s / ~7.5 s |
| **D29 angle** | **D29-C** — explicit AP2 **Intent** Mandate per **D27** (Intent only; Cart/Payment deferred) |
| **Surface** | `web-demo` Track 2 · Scene 2 (`/campaigns/<id>/mandate`) |
| **On-screen callout** | "AP2 **Intent** Mandate · scope `outreach+payment` · cap $400 · Ed25519 sig — agent plans, human approves (D27)" |

The marketer signs an AP2 **Intent** Mandate (`scope=outreach+payment`, `cap=$400`, `expiry=72h`)
with the workspace key (Ed25519 sig visible). D27 on screen: this is Intent only — the agent plans,
the human approves payment. The visible JSON + signature line is the audit evidence, not a black-box
"approved" button.

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 2 (unchanged).

### U3 — Bulk-approve sourcing batch `[= Track 2 · Scene 3]`

| Field | Value |
|---|---|
| **Real / 8×** | 45 s / ~5.6 s |
| **D29 angle** | **D29-A** — the `sourcing` agent returns typed `CreatorMatch` rows |
| **Surface** | `web-demo` Track 2 · Scene 3 (`/approvals`) |
| **On-screen callout** | "`sourcing-v2` · $0.012/row · `CreatorMatch@1.4.0` — one click, not 40" |

The marketer bulk-approves the sourcing batch. Every row carries the agent name (`sourcing-v2`), USD
spent ($0.012/row), and the contract version (`CreatorMatch@1.4.0`). One click, not 40 — the agent
did the per-row work. **The "it works" beat ends here** — and the demo deliberately pivots to the
hard question: *is it reliable when a creator reply is ambiguous?*

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 3 (unchanged).

---

## ACT II — OPTIMIZE / the hardening climax (the stall → repair; ~3:30 real / ~26 s @8×)

> **On-screen act card**: **"OPTIMIZE — we hardened it. Train 40.5% → 100%; on an unseen holdout, 71.4% (gap shown, not hidden)."**

This act is the demo's **climax** and its single strongest technical proof. It did not exist in
either old track file — it is the Optimize/Track-2 hardening work, folded into the one arc per D50
(GRAND-NARRATIVE-PLAN §2, §5-1). Source assets: `HARDENING-CHAPTER.md`.

### U4 — NEW · the stall, the trace, the repair, the before/after `[Optimize climax]`

| Field | Value |
|---|---|
| **Real / 8×** | ~120 s / ~15 s |
| **D29 angle** | **D29-A + D29-C** — `triage_inbound` is a typed deterministic function (D29-A); the failing input is a multilingual, mixed-emotion creator reply (D29-C) |
| **Surface** | `web-demo` (Observability panel) → renders `scripts/demo/assets/observability-trace-{stalled,repaired}.json` + the `hardening-before-after.json` bar |
| **Source of truth** | `HARDENING-CHAPTER.md` §1-§4; `scripts/smoke-test/run-hardening-measure.sh` |
| **Build Example #2 link** | none (this is the reliability beat the Guide's "production-ready" framing asks for) |

**Narrative beats (what the viewer sees, in order):**

1. **The stall.** A creator replies *"Love it! my rate is ~$800, ok?"* — interested, but quietly
   negotiating. The 8-intent classifier rounds it down to `interested`, so the rate signal never
   fires; the `conversation_responder` (Tier-1 #5, Gemini 2.5 Pro) is sent down the auto-draft path
   while its own prompt says escalate negotiations. The Observability trace
   (`observability-trace-stalled.json`) renders the reasoning graph **halting** at step 3, flagged
   `"stall": true`: `triage.action = respond`, the proposed rate (USD 800) present but unread.
2. **The fix.** We add one deterministic pre-LLM triage rule (H1):
   > **`interested`/`needs_info` + `proposed_rate_usd` present → escalate
   > (reason `rate_signal_on_positive`)**

   A proposed rate means terms are on the table — so it is a negotiation; escalate to a human (D27,
   we never negotiate rates from this agent).
3. **The trace flows.** The repaired trace (`observability-trace-repaired.json`) renders the same
   case now **flowing** through a new step 4 flagged `"repaired": true`: `triage.action = escalate`,
   `triage.reason_tag = rate_signal_on_positive`, `agent.outcome = escalate`.
4. **The before/after bar.** A two-bar chart animates from baseline to optimized:

   | triage routing accuracy | Before (`_baseline_triage`, train) | After (`_optimized_triage`, train) | **Holdout** (`_optimized_triage`, unseen) |
   |---|---|---|---|
   | Synthetic cases | 42 | 42 | 14 |
   | Passed | 17 | 42 | 10 |
   | **Pass rate** | **40.5 %** | **100.0 %** | **71.4 %** |
   | Delta vs before | — | **+59.5 pp** | — |
   | Train↔holdout gap | — | — | **28.6 pp** |

**On-screen callouts (must appear):**

- **Headline bar caption**: **"triage routing accuracy 40.5% → 100.0% on train; 71.4% on an unseen adversarial holdout (28.6pp gap kept visible), 56-case multilingual synthetic set"**
- **Anti-overfit caption**: "Golden-set runner with a **holdout split** (train 100% / holdout **71.4%** — a **28.6pp** train↔holdout gap left visible). The holdout's 4 misses are negotiation intents with no structured rate (obfuscated 'comp', unextracted rate, mid-thread, sarcasm) — kept as misses, NOT tuned away. We measure generalization, not overfit."
- **★ Honest-scope caption (load-bearing, must be on screen)**: *"The 100% is the **train** number
  (the cases the rules were authored against); the honest headline is the **holdout 71.4%**. This
  before/after is a **local deterministic optimization pass** over the synthetic set. The live
  **Vertex AI Prompt Optimizer (data-driven)** is the production path and is **wired
  (operator-gated)**, not run in CI. The Observability trace artifacts are deterministic offline
  renderings of the triage decision path — the OTel span shape is real; live Cloud Trace export is
  the production path."*

**Why this is the climax**: it is the Technical-30% reliability evidence *and* the highest-attention
Demo-20% visual (a graph that stalls, then flows) in a single frame — and the honest-scope caption
keeps it credible (RULES.md, GRAND-NARRATIVE-PLAN §7).

> **Recommended operator action in the recording**: open the Observability panel, let the **stalled**
> graph render and hold 2 s on the `"stall": true` step, click **Apply optimized triage**, let the
> **repaired** graph flow, then hold 3 s on the `40.5% → 100.0% (train) / 71.4% (holdout)` bar with
> the honest-scope caption visible. Reproduce live with
> `bash scripts/smoke-test/run-hardening-measure.sh` (offline, $0).

---

## ACT III — REFACTOR (enterprise A2A ecosystem; the loop closes; ~7:30 real / ~55 s @8×)

> **On-screen act card**: **"REFACTOR — Cloud Run + Model Garden + Agent Identity + A2A-native."**

The hardened fleet is refactored for enterprise distribution. The second peak of the arc lives here:
the A2A cross-call is now **a step inside the live brand-campaign Cloud Workflow**, not just a
diagram.

### U5 — Model Garden reasoning + cryptographic Agent Identity `[= Track 3 · Scene 4 + req cards]`

| Field | Value |
|---|---|
| **Real / 8×** | 60 s / ~7.5 s |
| **D29 angle** | **D29-A** — the agent's model config routes through the Model Garden publisher path |
| **Surface** | `web-demo` Track 3 · Scene 4 (deploy/config view) + the requirement-gate cards |
| **On-screen callout** | "LLM reasoning routes through Model Garden `publishers/google/models/<id>` (req ③, D47) · Agent Identity SPIFFE `spiffe://ss-mcp-prod.svc.id.goog/ns/agents/sa/tiktok-mcp-runner` (D48)" |

The deploy/config surface shows two enterprise-readiness facts: LLM reasoning routes through the
**Vertex AI Model Garden** publisher path (`publishers/google/models/...`) — proven by an offline
test asserting the publisher path reaches the model layer (live smoke operator-gated, req ③, D47) —
and each agent carries a cryptographic **Agent Identity**: SPIFFE
`spiffe://ss-mcp-prod.svc.id.goog/ns/agents/sa/tiktok-mcp-runner` (D48).

**Honest-scope caption (on screen)**: *"mTLS is **declared** but not yet enforced on this demo
(enforcement pending O7); the SPIFFE workload identity and the Model Garden publisher path are real,
the live smokes are operator-gated."*

> Detailed mouse sequence: `STORYBOARD-track3.md` Scene 4 (unchanged).

### U6 — NEW · coordinator A2A-invokes tiktok-mcp **inside the Cloud Workflow** `[Refactor hop]`

| Field | Value |
|---|---|
| **Real / 8×** | ~90 s / ~11 s |
| **D29 angle** | **ALL THREE** — D29-A (`a2a_invoke` is a typed function, `USD_COST=$0.0005`), D29-B (the agent ships over A2A *because* there is no KR Marketplace path), D29-C (RemoteA2AAgent fan-out, multi-agent) |
| **Surface** | `web-demo` brand-campaign workflow view → `wow-business.html#a2a-crosscall` (animated SVG) |
| **Source of truth** | `A2A-INTENTS.md §4` — `coordinator (M1) → a2a_invoke → tiktok-mcp-server.plan_creator_search` |
| **Build Example #2 link** | this is the *transport* the Guide's Build Example #2 describes — "A2A protocol… communicate with company's internal agent" — realized between two of our agents |

**Narrative bullet (what the viewer sees):**

This time the sourcing step is shown as a step **inside the live brand-campaign Cloud Workflow**.
The workflow reaches the `coordinator` (M1) routing step; the coordinator scores its candidate pool,
picks `tiktok-mcp-search` (`transport=a2a_grpc`); the workflow performs the **transport switch** and
calls `a2a_invoke`. The animated A2A diagram shows a `brief` packet travel **coordinator →
a2a_invoke → ss-mcp-server** over HTTPS (TLS enforced, SPIFFE identity per D48), the server runs
`plan_creator_search`, and a `5 creators` packet returns on the lower lane. The badge reads
**`task/completed · ~3.7s`** — the measured round-trip against the live Cloud Run endpoint
(`https://ss-mcp-server-1049119860518.us-central1.run.app`, A2A v0.3 `message/send`, OIDC bearer per
D19). The result table shows the ranked set of **5 creators**.

**On-screen callout (must appear)**: **"`coordinator → a2a_invoke → tiktok-mcp.plan_creator_search`
— A2A v0.3 message/send, task completed, ~3.7s round-trip, 5 creators ranked. Now a step inside the
brand-campaign Cloud Workflow — A2A is part of orchestration, not just documented."**

**Why this is the second peak (all three angles in one frame):**

- **D29-A**: `a2a_invoke` is a typed capability (`A2AInvokeInput` → task envelope), USD-metered
  ($0.0005/hop), not a free ReAct loop.
- **D29-B**: the *reason* the value crosses an A2A wire instead of a Marketplace SKU is the Korean
  payment-region exclusion (D2/D3). The cross-call **is** the KR-region-gap workaround.
- **D29-C**: a fleet agent invoking a RemoteA2AAgent over the workflow is literal multi-agent
  composition; the `RankedCreators` artifact is structured-data multimodality.

**Honest-scope caption (on screen)**: *"~3.7s / 5-creators is a real measurement against the live
Cloud Run endpoint this session. The A2A hop is now wired into the brand-campaign Cloud Workflow.
`a2a_invoke` has a deterministic stub for CI; live SPIFFE-token + Agent Gateway enforcement is the
W7/O7 path. This is creator-research routing, not autonomous payment."*

> **Recommended operator action in the recording**: from the workflow view, open the header **"★ Wow
> + Business panel (D49)"** link to `wow-business.html`, let the `#a2a-crosscall` SVG animate one
> full request/response cycle, hold on the `task/completed · ~3.7s` badge for 2 s, then return.

### U7 — A2A client confirms the same skill end-to-end `[= Track 3 · Scene 5]`

| Field | Value |
|---|---|
| **Real / 8×** | 90 s / ~11 s |
| **D29 angle** | **D29-C** — A2A is the inter-agent transport, not just human-to-agent |
| **Surface** | `web-demo` Track 3 · Scene 5 (a2a-client terminal + Cloud Run logs) |

Immediately after the diagram, the demo proves the same edge at the protocol level: an `a2a-client`
call to the deployed Cloud Run agent (`message/send → task.created → task.completed`, `latency_ms`
shown), with the Cloud Run logs showing the matching `a2a_task_id`. Two surfaces (the in-workflow
`a2a_invoke` and the raw A2A client), one server, one trace correlation. This is the empirical
backing for U6's diagram.

> Detailed mouse sequence: `STORYBOARD-track3.md` Scene 5 (unchanged).

### U8 — Outreach drafts + human edit `[= Track 2 · Scene 4]`

| Field | Value |
|---|---|
| **Real / 8×** | 120 s / ~15 s |
| **D29 angle** | **D29-A + D29-C** — typed `OutreachDraft` schema + multimodal (auto-attached inspiration image) |
| **Surface** | `web-demo` Track 2 · Scene 4 (`/campaigns/<id>/outreach`, Gmail side-panel) |
| **Build Example #2 link** | the multimodal marketing-agent output (image + copy) the Guide describes |

The `outreach_writer` agent drafts 12 emails (one per top creator from the A2A result). The operator
edits one sentence (proving the human gate is real) and sends to `app.2weeks@gmail.com` (D10
test-account-only). Each draft carries an attached image — the multimodal channel.

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 4 (unchanged).

### U9 — Verify + $0.01/view + ROI/TAM `[= Track 2 · Scene 7 + wow-business#roi/#tam]`

| Field | Value |
|---|---|
| **Real / 8×** | 90 s / ~11.2 s (+ ~10 s on the ROI panel) |
| **D29 angle** | **D29-B** (verify-agent IS the distribution measurement — no Marketplace analytics) + **Business** (D28 pricing) |
| **Surface** | `web-demo` Track 2 · Scene 7 (`/campaigns/<id>/verify`) → `wow-business.html#roi` + `#tam` |
| **Build Example #2 link** | `content_verify` is the agent the Guide's "on-brand and compliant" verdict maps to (see Coda U11) |

The `content_verify` agent confirms delivery and live view counts; the per-view cost ticker
($0.01 × views, D28) updates live. The demo then jumps to `wow-business.html#roi`: the worked example
($380 budget → 38,000 verified views → $380 billed @ $0.01/view, $10 eCPM), the "no view, no charge"
framing, and the **TAM/SAM/SOM** napkin (every figure sourced or explicitly labelled an internal
assumption). **This is the Business-30% surface** the demo previously lacked (D49(c)).

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 7 (unchanged); ROI/TAM panel: `wow-business.html`.

### U10 — The KR-region-gap, made explicit `[= Track 3 · Scene 9]`

| Field | Value |
|---|---|
| **Real / 8×** | 60 s / ~7.5 s |
| **D29 angle** | **D29-B** — the negative (no eligible KR payment-region billing entity) turned into the innovation thesis (D3) |
| **Surface** | `web-demo` Track 3 · Scene 9 (Producer Portal `status=pending_legal_entity`) |

The Producer Portal listing sits at `pending_legal_entity` — "no eligible payment-region billing
entity for the seller account" (D2). The operator note links to the Devpost write-up: *we turned this
gap into the Innovation thesis (A2A-only distribution path, D3)*. Korea = APAC, so the APAC Regional
prize is also in range. **This scene answers "why A2A at all?"** — it closes the loop the cross-call
opened.

> Detailed mouse sequence: `STORYBOARD-track3.md` Scene 9 (unchanged).

---

## CODA — Proof + official-guide match (~0:30 real / ~4 s @8×)

### U11 — System health check + Build Example #2 match + real Imagen `[= Track 2 · Scene 12 + wow-business#build-example-2/#multimodal]`

| Field | Value |
|---|---|
| **Real / 8×** | 30 s / ~3.8 s (+ ~8 s on the Build Example #2 + Imagen panels) |
| **D29 angle** | **ALL THREE** (the smoke runs every agent function, through a multi-agent loop, with no Marketplace dependency) |
| **Surface** | `web-demo` Track 2 · Scene 12 (smoke) → `wow-business.html#build-example-2` + `#multimodal` |
| **Build Example #2 link** | **the explicit 1:1 callout** (D48/D49(d)) |

The canary streams `PASS — 22/22 agents · 0 failures`; the broader suite is **2832 pytest cases
passing**, `verify-build` green. Then the demo lands on `wow-business.html#build-example-2`: the
verbatim quote from `designed_guide.pdf` p.7 (the marketing agent that uses A2A to reach a DAM agent
for approved brand logos) mapped element-for-element onto our **`content_verify`** agent + its
**`vision.brand_logo_detect`** capability.

**On-screen callout (must appear)**: **"Official Guide Build Example #2 = our `content_verify` ↔ DAM
(brand-logo / on-brand verification) — 1:1 match."**

**Honest-scope caption (on screen)**: *"Today `content_verify` reaches the brand-asset check via an
in-process ADK FunctionTool, not yet an A2A hop to a separately-deployed DAM agent. The roles map
1:1; promoting it to a standalone A2A-addressable DAM agent is the same lift as the U6
live-wiring."*

Adjacent, `#multimodal` shows the **one real Imagen 4 generation** (`imagen-4.0-generate-001`, 1:1
**1024×1024, 950 KB**, NOT a stub) — the multimodal channel the Build Example #2 marketing agent
needs (D49(a)). GCP cost envelope on screen: **~$1-5/mo** (all Cloud Run `min=0`).

> Detailed mouse sequence: `STORYBOARD-track2.md` Scene 12 (unchanged); panels in `wow-business.html`.

---

## 2. Scene-by-scene mapping (the whole arc on one page)

| Act | Unified scene | Web-demo source | D29-A | D29-B | D29-C | Build Ex. #2 |
|---|---|---|:---:|:---:|:---:|:---:|
| BUILD | U1 intake | T2·S1 | ● | | | (sets up marketing agent) |
| BUILD | U2 AP2 Intent | T2·S2 | | | ● | |
| BUILD | U3 bulk sourcing | T2·S3 | ● | | | |
| **OPTIMIZE** | **U4 stall→repair + 40.5%→100% train / 71.4% holdout (NEW)** | Observability + `hardening-before-after.json` | ● | | ● | (production-reliability beat) |
| REFACTOR | U5 Model Garden + Agent Identity | T3·S4 + req cards | ● | | | |
| **REFACTOR** | **U6 A2A hop in Cloud Workflow (NEW)** | workflow view → `#a2a-crosscall` | ● | ● | ● | A2A transport |
| REFACTOR | U7 A2A client | T3·S5 | | | ● | |
| REFACTOR | U8 outreach | T2·S4 | ● | | ● | multimodal output |
| REFACTOR | U9 verify + ROI/TAM | T2·S7 + `#roi`/`#tam` | | ● | | `content_verify` |
| REFACTOR | U10 KR-gap | T3·S9 | | ● | | |
| CODA | **U11 smoke + Build Ex.#2 + Imagen** | T2·S12 + `#build-example-2`/`#multimodal` | ● | ● | ● | **1:1 match** |

Every D29 angle is exercised; **U6 and U11 each carry all three**, and **U4 is the reliability
climax**. `designed_guide.pdf` Build Example #2 is matched in two places — the **transport** (U6,
agents calling each other over A2A) and the **agent role** (U11, `content_verify` ↔ DAM,
`vision.brand_logo_detect` ↔ approved-logo check). Source: `A2A-INTENTS.md §4–§5`.

---

## 3. Climax-asset placement (hardening + A2A + wow assets)

| Asset | Origin | Where it lands in the arc |
|---|---|---|
| **Observability stall→repair trace** | `HARDENING-CHAPTER` H3 (`observability-trace-{stalled,repaired}.json`) | **U4 — the climax visual** |
| **40.5% → 100.0% (train, +59.5pp) before/after bar** | `HARDENING-CHAPTER` H4 (`hardening-before-after.json`) | **U4 — the climax headline** |
| **Holdout split (train 100% / holdout 71.4%, 28.6pp gap)** | `HARDENING-CHAPTER` H5 anti-overfit | U4 anti-overfit caption |
| **~3.7s round-trip · 5 ranked creators** | live A2A measurement this session | U6 badge `task/completed · ~3.7s` + result table |
| **A2A hop wired into brand-campaign Cloud Workflow** | `A2A-INTENTS.md §4` + workflow YAML | U6 — the second peak |
| **Live endpoint** `ss-mcp-server-…run.app` | deploy | U6 + U7 |
| **Animated A2A cross-call SVG** | D49(b) | U6 — the visual |
| **Model Garden publisher path** (`publishers/google/models/…`) | req ③ / D47 | U5 |
| **Agent Identity SPIFFE** + mTLS-declared disclosure | D48 / O7 | U5 honest-scope caption |
| **Real Imagen 4 image** (`imagen-4.0-generate-001`, 1024×1024, 950 KB) | D49(a) | U11 `#multimodal` |
| **ROI worked example + TAM/SAM/SOM** | D49(c) | U9 `#roi` + `#tam` |
| **Build Example #2 1:1 callout** | D48/D49(d) | U11 `#build-example-2` |

Wow assets are concentrated in the **OPTIMIZE climax (U4)** and the **REFACTOR peak (U6)** plus the
**CODA payoff (U11)** — the three moments a judge's attention is highest.

---

## 4. What this storyboard does NOT change

- **The 24-scene web-demo engine** — `web-demo/index.html` ships the full Track-2 + Track-3 scene
  library behind a toggle, auto-plays, and is the canonical no-FFmpeg demo per D30. This file defines
  the *guided path* through it plus the two new beats; it does not require the engine to be re-cut.
- **The two per-surface track storyboards** — `STORYBOARD-track2.md` / `STORYBOARD-track3.md` remain
  the authoritative mouse-click manuals. This file references them by scene number.
- **D30 format** — still 8× real-mouse, no narration; subtitles only
  (`subtitles/{track2,track3}-{ko,en,ja,zh-CN}.srt`). The arc reuses those cues.
- **Audio narration** — none, per D30.

---

## 5. Cross-references

- D50 (single grand-narrative, Build→Optimize→Refactor, Grand Prize aim) → `GRAND-NARRATIVE-PLAN.md` §2
- D45 (single Track 3 subsumes platform) → `gcp-research/decisions/DECISIONS.md`
- D25 (optimize/learning loop) · D29 (three angles) · D30 (8× real-mouse) → `DECISIONS.md`
- D27 (AP2 Intent only) · D28 ($0.01/view) → `DECISIONS.md`
- D47 (Model Garden) · D48 (A2A intents + Agent Identity) · D49 (wow + business) → `DECISIONS.md`
- Hardening chapter (U4 source) → `scripts/demo/HARDENING-CHAPTER.md`
- Cross-call source of truth → `gcp-research/refactor-mcp/A2A-INTENTS.md` §4 (the edge) + §5 (Build Example #2)
- The 24-scene engine → `scripts/demo/web-demo/index.html`
- The wow/business surface → `scripts/demo/web-demo/wow-business.html`
- Per-surface mouse manuals → `STORYBOARD-track2.md`, `STORYBOARD-track3.md`

**End of STORYBOARD-unified.md** — the single Build → Optimize → Refactor arc (D50).
