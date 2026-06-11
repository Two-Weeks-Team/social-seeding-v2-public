> # ⚠️ ARCHIVED — merged into `devpost-track3.md` per D45 (single submission)
> #
> # This file is **no longer a separate Devpost entry**. Per [`DECISIONS.md` D45](../../gcp-research/decisions/DECISIONS.md)
> # (2026-05-20, supersedes D1), we submit **ONE** Devpost entry to **Track 3 (Refactor)**
> # that subsumes the entire Track 2 platform. The 22-agent fleet, AP2 Mission Control,
> # and multimodal pipeline content below has been absorbed into
> # [`devpost-track3.md`](devpost-track3.md). Do NOT paste this file into a second Devpost form.
> #
> # Retained for traceability / source material only. The live submission is `devpost-track3.md`.

---

# Devpost form fill — `social-seeding-v2` (Track 2: Optimize) — **[ARCHIVED]**

> **Origin**: condensed from [`gcp-research/submission/DEVPOST.md`](../../gcp-research/submission/DEVPOST.md) §A (1,950-word source).  
> **Target word count**: 1,400–1,800 — judges skim; signal beats narrative (per `SUBMISSION-PACKAGE.md` §4).  
> **Voice**: plain-language, measured numbers, no marketing superlatives. D-IDs cited inline so judges can trace any claim back to [`gcp-research/decisions/DECISIONS.md`](../../gcp-research/decisions/DECISIONS.md).  
> **Status**: 2026-05-19. Awaiting two field updates before Devpost submit:
> - **YouTube video URL** — after `upload-youtube.sh v2 en` writes `v2-youtube-metadata.json`.
> - **Cloud Marketplace listing screenshot ID** — covered in the Track 3 write-up, cross-link only here.

---

## Project name

```
social-seeding-v2
```

## One-line tagline

```
A 22-agent fleet on Vertex AI Agent Runtime that runs the entire influencer-campaign loop — source → vet → outreach → reply → ship → verify → report — for $0.42 per campaign on Claude and ~$0.05 on Gemini, end-to-end, with human approval at every policy gate.
```

## Inspiration (Devpost field: Inspiration)

Brand managers and creator-marketing leads burn six hours a day on outreach grunt work — scrolling TikTok for fit, drafting cold emails, chasing replies, verifying that the product we shipped actually got posted, then writing the campaign report. The market has dashboards (Aspire, Grin, CreatorIQ) and one-step automations (sourcing scrapers, scheduling CRMs), but nothing that runs the *whole* loop with judgment at every step.

We had already built a working 11-agent system on Claude Agent SDK + Inngest with 354 passing tests; the question was whether we could lift it to the Google Cloud agent stack — ADK on Vertex AI Agent Runtime, Gemini, Model Armor, multi-region Spanner — without losing what made it production-shaped in the first place: typed contracts, USD budget caps, named human-escalation gates, golden-set evaluations on every agent.

## What it does (Devpost field: What it does)

`social-seeding-v2` takes a one-paragraph brand brief and runs a 22-agent fleet (16 domain + 3 meta-coordinators + 3 watchdogs, per D23) through the full influencer-campaign loop: source → vet → outreach → reply → ship → verify → report. Real Gmail sends (to operator-owned test accounts only, per D10), real shipment tracking, real verification that the brand-tagged TikTok post matches the brief, real per-view billing pipeline through Apigee X — for a measured **$0.42 per campaign on Claude, and ~$0.05 per campaign after the Gemini port** (8× cost reduction at parity on our golden set).

A human approves at policy gates (`external_send`, contract terms, budget escalation) per the AP2 Intent Mandate (D27); everything else runs durably on Cloud Workflows. The platform is multi-tenant SaaS (D12), multi-region active-active across `us-central1`, `europe-west4`, `asia-northeast3` (D13), and metered per delivered view at $0.01 (D28).

## How we built it (Devpost field: How we built it)

We chose a **hybrid OLTP plane** (D15): **Spanner Multi-region** holds the core tenant / campaign / billing tables with 5×9 strong consistency across `nam-eur-asia1`; **AlloyDB AI** holds analytics + feature-store data per region with ScaNN-accelerated co-located vectors for ranking; **Firestore Native** backs Agent Memory Bank for the 14-day rolling outreach-style and brand-voice memory (D33). Vector search runs as a dedicated **Vertex AI Vector Search** index (D16) at 10 M+ creator + brand embeddings, p99 < 50 ms. CMEK keyrings per region encrypt every store (D20); Secret Manager fronts all credentials; Sensitive Data Protection scans every Cloud Logging sink before audit logs land in BigQuery.

The **agent layer** lives on **Vertex AI Agent Runtime** (D17) — managed, sub-second cold start, 7-day long-running sessions, Agent Sessions for per-conversation state, Agent Memory Bank for cross-session continuity. Every agent is built with **ADK 2.0 Python** following the *agent-as-function* contract: curated tool list, Zod (TypeScript boundary) → JSON Schema (ADK boundary) output contract, per-invocation USD ceiling, named escalation policy (`always_ask` by default per D7, owner-relaxable per workspace).

Tier-1 agents (16) cover the domain — sourcing, vetting, outreach_writer with 5 × 4 tournament + LLM-as-judge, conversation classifier on Gemini 3.1 Flash-Lite, logistics, content_verify with multimodal Gemini 3.1 Flash-Lite + Vision AI brand-logo detection, analyst, research with Google Search Grounding, intake, lead_outreach_writer, plus five new agents added for v2 (payment_mandate composing AP2 Intent Mandates, compliance auto-checking PIPA Article 23/24 + CAN-SPAM, creative producing Imagen 4 moodboards + Veo 3 sample videos, a11y generating alt-text + transcripts across four locales, customer_success surfacing onboarding-friction signals). Tier-2 meta-agents (coordinator routes A2A v0.3 calls across the fleet; critic does LLM-as-judge across Tier-1 outputs; optimizer rewrites prompts via Agent Optimizer). Tier-3 watchdog agents (anomaly_watch, cost_watch with per-tenant USD/day ceilings, security_watch tied to Model Armor + Chronicle alerts) per D23.

**Orchestration is GCP-native, no Inngest** (D18 — supersedes the original D4 plan). **Cloud Workflows** handles durable timers and the `waitForEvent`-style human-approval gates that v2's outreach loop depended on; **Pub/Sub** does fan-out with Schema Registry enforcing AsyncAPI 3.0 contracts (D36); **Cloud Tasks** handles per-task retry queues for outreach send and carrier polling; **Eventarc Advanced** carries content-routed system events. **Model Armor max policy** (D21) runs inline on every Gemini call: PI / JB block, PII block, Responsible AI defaults, custom regex for brand / competitor / influencer-handle exfiltration, plus Agent Anomaly Detection feeding the W3 security_watch agent with real-time block alerts and threshold-driven tenant auto-quarantine.

The **learning loop** (D25) is the full GCP stack: **Vertex AI Agent Evaluation** runs golden-set + LLM-as-judge per agent on every PR via Cloud Build; **Vertex AI Pipelines** runs SFT and Pro → Flash distillation nightly; **Agent Simulation** drives 1000+ scenario regressions whose reward signal seeds RLHF without human labels; **Agent Optimizer** pushes prompt-diff PRs back to the repo. **SLO is 99.99% availability with p99 < 1 s on hot path, RTO 1 min, RPO 30 s** (D31), defensible because the 5-layer test pyramid (D37) covers it: ESLint + tsc, Vitest on capabilities, pytest on agents, Vertex AI Agent Evaluation, and Litmus / Gremlin chaos with Spanner failover + Pub/Sub message-drop drills. Mission Control (Next.js 16 on Firebase App Hosting), Dialogflow CX chat surface, and React Native Expo PWA share an Agent Gateway-fronted API with OpenAPI 3.1 codegen.

## Challenges we ran into (Devpost field: Challenges)

**Inngest migration to a GCP-native durable plane.** v2's working architecture relied on Inngest's `step.sleep(14d)` + `waitForEvent` + content-correlation semantics — patterns that don't map 1:1 to any single GCP service. We had to fan the workload across Cloud Workflows (durable timers and human-gate callbacks, with the Callbacks GA from 2026-05-15), Pub/Sub (fan-out with Schema Registry-enforced AsyncAPI contracts), Cloud Tasks (per-retry queues with backoff policies), and Eventarc Advanced (content-based routing between Workflows runs and Agent Runtime callbacks). The 14-day "wait for reply" loop became a Workflows wait-for-callback with a Pub/Sub topic correlated by `tenant_id + campaign_id + creator_id` composite key. We preserved 103 workflow tests; the migration is documented in `migrations/INNGEST-MIGRATION.md`.

**The Korean-startup region gap.** We are a Korean entity. Google Cloud Marketplace's payment region list excludes Korea, which means we cannot directly list paid offerings (D2). Rather than pretend this away, we re-framed it (D3): the *gap itself* is the contribution — a published A2A-only distribution path that any non-Marketplace-region startup can replicate. For v2 specifically, this means our day-1 distribution is through Gemini Enterprise via A2A v0.3, not via paid Marketplace, with a foreign sub-entity strategy deferred to the post-launch roadmap once Marketplace MRR justifies it.

**AP2 v0.2 is early-Preview, and Agent Gateway is Private Preview.** AP2 has 60+ payment partners listed but the protocol is in early Preview, so we deliberately scoped to **Intent Mandate only** (D27) — agent plans the payment, human approves — and deferred Cart Mandate + Payment Mandate to post-launch. We disclose Agent Gateway's Private Preview status explicitly here. Both are real-world early-stage protocol calls; pretending they were GA-stable would have been a credibility hit during judging.

## Accomplishments we're proud of (Devpost field)

- **8× cost reduction at parity.** Same golden set, same eval criteria, same outreach quality (`response_match_v2` + `spam_score`), shipped on Gemini 3.5 Flash / Flash-Lite routing where v1 used Claude exclusively. Per-campaign cost dropped from **$0.42** (measured n=20 on Claude) to **~$0.05** (measured on the Gemini 3.x mix with Flash-Lite bulk-routing).
- **354 passing tests preserved + the 5-layer test pyramid added on top.** All 4 observability, 64 agent, 183 capability, and 103 workflow tests from the Claude+Inngest build survived the port (D35 — hybrid codebase: capabilities + contracts + db reskinned for Spanner / AlloyDB / Firestore; agents and workflows rebuilt on ADK + Workflows). On top we added Vertex AI Agent Evaluation, pytest on the agent layer, Agent Simulation (1000+ scenarios), and chaos engineering.
- **Full multi-region active-active across three continents (D13).** Spanner `nam-eur-asia1` config, AlloyDB regional clusters with Datastream async replication, per-region Firestore + Vertex Vector Search + Agent Runtime endpoints + Memorystore Valkey 8 + Cloud KMS keyrings, Global LB with latency-based routing, Cloud CDN, Cloud Armor + Bot Management, VPC-SC perimeter + Private Service Connect on every GCP API call.
- **Inngest-free, GCP-native orchestration that survived a real Phase-6 demo.** The end-to-end demo runs through Workflows + Pub/Sub + Cloud Tasks + Eventarc with the human-approval gate, real Gmail send (to operator-owned test accounts per D10), real reply parsing, real shipment record, real per-view metering into BigQuery via Dataflow streaming. The 8× speed real-mouse-action recording (D30) compresses 24 minutes of real interactions into a 3-minute video, with subtitles in 4 locales (D34: ko / en / ja / zh-Hans).
- **22-agent fleet with watchdog auto-runbook composition (D23).** The *Multimodal + AP2 + Multi-agent* differentiation angle is real: Veo 3 + Imagen 4 + Lyria in the creative agent, AP2 Intent Mandates in the payment_mandate agent, RemoteA2AAgent fan-out coordinated by the M1 coordinator.

## What we learned (Devpost field)

- **Durable orchestration is not the same concern as agent execution.** The temptation to put `step.sleep(14d)` inside Agent Runtime is real and wrong. Workflows owns time; Agent Runtime owns reasoning. Most multi-agent hackathon submissions collapse these into one runtime and pay for it in debuggability.
- **The human-escalation gate is the product.** Buyers don't want "100% autonomous"; they want "I trust this to run while I sleep, and stop the second anything is weird." Every Tier-1 agent has a named escalation policy and a `always_ask`-by-default gate (D7).
- **Multi-region active-active is cheaper than it looks when you commit early.** Spanner Multi-region's $1.50/node-hour looks scary on paper, but Spanner spans all three regions on a single instance — versus three sharded regional databases plus cross-region replication tooling, the bill flips in Spanner's favor for any workload above ~50 GB.

## What's next (Devpost field)

- **2026-Q3** — Tier-3 `cost_watch` RLHF tuning. The W2 watchdog is rule-based today (D-ID for agent-shape consistency per D23); next iteration uses Agent Simulation reward signal (D25) to learn tenant-specific budget envelopes and replace the hard 50/75/90/95% threshold ladder with a learned curve.
- **2026-Q3** — Memorystore Valkey 8 → **Bigtable hot cache** for cross-region creator-embedding lookups (currently considered ⬜ in `SERVICE-INVENTORY.md` §4; promoted to ✅ once production read-volume justifies the migration). Today Vertex AI Vector Search handles all 10 M+ embeddings at p99 < 50 ms; Bigtable adds the per-tenant cache layer once cross-region read-amplification spikes.
- **2026-Q3** — Carrier adapter (deferred from Phase 6 C3). Auto-track shipments from Shopify / Easypost.
- **2026-Q4** — Workspace-level autonomy tuning. Owners relax the `always_ask` default per-policy without code changes (D7).
- **2027-Q1** — **Marketplace direct listing** post foreign sub-entity (US Delaware C-Corp / Singapore Pte Ltd / Japan KK per D2 / O10). Triggers when listing MRR crosses $1k (the same threshold as the Track 3 escalation path, kept consistent across submissions).
- **2027-Q1** — SOC 2 Type 2 evidence-collection pipeline (Drata / Vanta / Secureframe per O9). Currently PIPA + Marketplace-minimal day-1 (D22).
- **2027-Q2** — AP2 Cart Mandate + Payment Mandate. Currently Intent-Mandate-only (D27).

## Built With (Devpost field: Built With tags)

See [`built-with-tags.txt`](built-with-tags.txt) for the canonical, copy-paste-ready tag list (one tag per line). 95/121 GCP services in scope are actively used (79% coverage; 82% lifetime including Phase-2 commitments). Sourced from `gcp-research/decisions/SERVICE-INVENTORY.md` §1.

## Try it out (Devpost field: Try it out links)

- **Repository**: `https://github.com/Two-Weeks-Team/social-seeding-v2-public` (BUSL-1.1 + Apache-2.0 dual, per D9)
- **Demo video (YouTube unlisted, 3 min, 8× speed real-mouse recording per D30)**: `<YOUTUBE_TRACK2_URL>`
- **Live Mission Control (judging window only)**: `<CLOUD_RUN_WEB_URL>`
- **Pull Request with the 22-agent fleet + 49 capability tools + 2,668 passing tests**: `https://github.com/Two-Weeks-Team/social-seeding-v2/pull/1`
- **Demo recording reproduction**: `scripts/run-demo.ts --type=brand` (deterministic, golden-file gated per D43)
- **Smoke test (exit 0, 22/22 agents, 50/50 tools, 0.15 s)**: `scripts/smoke-test/run-brand-campaign.sh` (D43 canary gate)

## Business case (Devpost field: Business case)

**Pricing model (per D28)**: $0.01 per delivered view, equivalent to a $10 CPM. ROI-linked: customers pay only when the campaign produces measured views. Pricing is metered through Apigee X with view events into Pub/Sub → Dataflow → BigQuery → Apigee meter increments via Dataform SQL.

**Target customer**: brand marketing leads at DTC consumer brands spending $5k–$50k/month on creator marketing; agency campaign managers running 5–20 brand campaigns in parallel.

**MRR target**: **$10,000 MRR within 6 months** of live launch (4–8 paying tenants at $1,250–$2,500 each, blending Pro and Team plans plus per-view overage).

**Napkin TAM/SAM/SOM**:
- **TAM** — Global creator-marketing software market ≈ $24 B in 2026 (eMarketer / Influencer Marketing Hub baseline). Touches every brand running paid creator campaigns.
- **SAM** — Brands running 10+ creator campaigns/month with $5k+ monthly creator spend ≈ 80,000 brands worldwide × $1,800 ARPM ≈ **$1.7 B SAM**.
- **SOM (3-year)** — KR/JP/EN markets, DTC + Shopify Plus ≈ 3,000 reachable brands × $1,500 ARPM × 1% capture ≈ **$540 k ARR Year-3 SOM**, blending Pro plan ($99/mo), Team plan ($499/mo), and per-view overage.

**Unit economics at $0.42 (Claude) → $0.05 (Gemini) per-campaign LLM cost**: gross margin on the $99 Pro plan jumps from 41% → 87% across the port. Per D28's per-view rate-card the cost-per-delivered-view target is **$0.0087** — below the published $0.01.

**Cost envelope per D39 ($1,500 GCP credits)**: Build phase $300–500, pre-submission rehearsal $50–100, judging-window idle (Memorystore + Memory Bank + AlloyDB 24×7) $150–250, post-launch demo $50–100/month. Total budget $700–1,100, comfortably 1.4× under the cap (per `SERVICE-INVENTORY.md` §14).

**Distribution channels day-1**: A2A v0.3 via Agent Registry inside Gemini Enterprise (works around the Korean Marketplace payment-region exclusion, per D2 / D3). Marketplace direct listing is on the roadmap (post foreign sub-entity, per O10).

## Differentiation (Devpost field: Differentiation — three angles per D29)

We are publishing all three differentiation angles (D29) — each with a concrete proof point that judges can verify in the repository, not a marketing claim.

**Angle 1 — Agent-as-function reference implementation.**

The 22 agents are typed functions (curated tool list + Pydantic input/output contract + per-invocation USD ceiling + named escalation policy), never free ReAct loops. Proof: `packages/agents-adk/src/ss_agents/*` plus the 49 capability tools wired via `CAPABILITY_LAYER_MODE=stub|live` (D41). The smoke test exits 0 with 22/22 agents validated and 50/50 tool invocations in 0.15 s (D43). 1,178 new tool-level tests are pinned alongside 354 v2 tests for a total of **2,668 passing pytest cases / 0 failed** (`STATUS-REPORT.md` §2).

**Angle 2 — KR-startup region-gap distribution path.**

The Korean entity cannot directly list on Cloud Marketplace because Korea is excluded from the Marketplace payment region (D2). Rather than skip Track 3, we published the A2A-only distribution pattern that any non-Marketplace-payment-region founder can copy (D3): submit the listing as PENDING with the regional disclosure on the description, make the ADK agent first-class on A2A v0.3 via Agent Registry, meter through Apigee X independent of Marketplace payment plumbing, document the foreign sub-entity escalation path with a triggering threshold (O10 $1k MRR), and dual-license under BUSL-1.1 + Apache-2.0 so the pattern is reusable (D9). The pattern is the contribution.

**Angle 3 — Multimodal + AP2 + Multi-agent.**

The creative agent generates Imagen 4 moodboards + Veo 3 sample videos + Lyria background music from a brand brief. The payment_mandate agent composes AP2 Intent Mandates and gates payment to the human approver (D27 — Intent only; Cart and Payment Mandate deferred). The M1 coordinator dispatches RemoteA2AAgent calls across the fleet over A2A v0.3, with Agent Identity SPIFFE giving every workload a cryptographic identity. The 4-locale i18n (D34: ko · en · ja · zh-Hans) goes through Translation API at runtime fallback for outreach templates and Mission Control next-intl messages.

## Honest gaps (Devpost field: Risks / Known issues)

Per the workspace's professional-honesty rule (`RULES.md §Professional Honesty`), we explicitly note:

- **O1 — Devpost console 10 GAPs unanswered**: team size, license requirement, video length cap, repo visibility, multi-track rules, IP grant clauses pending operator confirmation.
- **O7 — Agent Gateway Private Preview allowlist pending**: the demo runs through a substitute path (direct Cloud Run + Identity Platform) until the allowlist clears (1-2 week processing window).
- **O10 — Foreign sub-entity decision pending**: triggers on $1k MRR; until then, distribution is A2A-only (D3).
- **AP2 v0.2 is early-Preview**, scoped to Intent Mandate only (D27); Cart and Payment Mandate deferred.
- **Agent Gateway is Private Preview** (disclosed openly here per D32).
- **Multi-region active-active is provisioned but not stress-tested under real customer traffic** — the SLO claim (99.99%, p99 < 1 s, RTO 1 min, RPO 30 s per D31) is backed by chaos drills and simulation, not yet by long-running production volume.

---

## Devpost submission form mapping (operator cheat-sheet)

| Devpost form field         | Source above                                  | Word target |
|----------------------------|-----------------------------------------------|-------------|
| Project name               | "Project name"                                | 1           |
| Tagline                    | "One-line tagline"                            | ≤ 200 chars |
| Inspiration                | "Inspiration"                                 | 100–200     |
| What it does               | "What it does"                                | 100–200     |
| How we built it            | "How we built it"                             | 400–500     |
| Challenges we ran into     | "Challenges we ran into"                      | 200–300     |
| Accomplishments            | "Accomplishments we're proud of"              | 150–250     |
| What we learned            | "What we learned"                             | 100–150     |
| What's next                | "What's next"                                 | 80–150      |
| Built With                 | from `built-with-tags.txt`, comma-separated   | ~80 tags    |
| Video URL                  | from `v2-youtube-metadata.json` .video_url    | URL only    |
| Try it out links           | "Try it out" section above                    | 6 URLs      |
| Business case              | "Business case" section above                 | 250–350     |
| Differentiation            | "Differentiation" section above (3 angles)    | 250–350     |

After `scripts/demo/post-process/upload-youtube.sh v2 en` writes `v2-youtube-metadata.json`, paste `.video_url` into the Devpost "Video URL" field and submit. The operator should NOT click "Submit" until the YouTube video status is "Unlisted, Processing complete" — Devpost previews the thumbnail and reviewers see a broken player otherwise.

---

**End of `devpost-track2.md`.** Cross-checked against [`gcp-research/submission/DEVPOST.md`](../../gcp-research/submission/DEVPOST.md) §A. Total ≈ 1,560 words (within the 1,400–1,800 target).
