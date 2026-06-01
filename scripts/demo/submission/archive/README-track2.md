# social-seeding-v2 — multi-agent influencer campaign operator on the Google Cloud agent stack

[![demo](https://img.shields.io/badge/demo-YouTube%20Unlisted-FF0000?logo=youtube)](https://youtu.be/_REPLACE_AFTER_UPLOAD_v2_)
[![build](https://img.shields.io/badge/build-passing-44CC11?logo=github)](https://github.com/_owner_/social-seeding-v2/actions)
[![tests](https://img.shields.io/badge/tests-354%20passing-44CC11?logo=vitest)](#what-did-we-measure)
[![license](https://img.shields.io/badge/license-Apache--2.0%20%2B%20BUSL--1.1-blue)](LICENSE)
[![track](https://img.shields.io/badge/Google%20for%20Startups-AI%20Agents%20Track%202-4285F4?logo=googlecloud)](https://cloud.google.com/blog/topics/startups/startups-are-building-the-agentic-future-with-google-cloud)

> 30-second elevator: a 22-agent fleet on Vertex AI Agent Runtime that runs the entire influencer-campaign loop — source → vet → outreach → reply → ship → verify → report — for **$0.42 per campaign on Claude, ~$0.05 on Gemini** (8× cost reduction at parity on the same golden set). 354 passing tests preserved across the port. Multi-region active-active across US + EU + APAC.

## What is it

`social-seeding-v2` is a multi-tenant SaaS that takes a one-paragraph brand brief and runs a real creator-marketing campaign end-to-end: it finds matching TikTok creators, scores brand-fit, drafts outreach emails through a 5-angle × 4-judge tournament, sends them through Gmail to operator-owned test accounts (per D10), parses real replies, drafts follow-ups, parses shipping addresses, waits 5 days on a durable Cloud Workflows timer, verifies the brand-tagged TikTok post with Vision AI logo detection, and writes the final analyst report. Every step is a typed agent function with a USD cap, a Zod output contract, and a named human-escalation policy — never a free ReAct loop. The whole loop is governed by Model Armor (max policy), Chronicle SecOps SIEM, and a 3-agent watchdog tier (anomaly + cost + security) that quarantines tenants on threshold.

## Who is it for

**Brand marketing leads at DTC consumer brands** spending $5k–$50k/month on creator marketing, one person doing all of it, burning ~6 hours a day on outreach grunt work. **Agency campaign managers** running 5–20 brand campaigns in parallel and unable to scale output without hiring. Pricing: Free / Pro $99 mo / Team $499 mo / Enterprise (per-view $0.01 metered through Apigee X, per D28).

## What did we build (for this Challenge)

- **22-agent fleet ported from Claude Agent SDK to ADK 2.0 Python on Vertex AI Agent Runtime** — 16 domain agents inherited from v2 + 5 new (payment_mandate composing AP2 Intent Mandates, compliance auto-checking PIPA Article 23/24 + CAN-SPAM, creative with Imagen 4 + Veo 3, a11y producing alt-text + captions across 4 locales, customer_success surfacing onboarding-friction signals). 3 meta-agents (coordinator / critic / optimizer). 3 watchdog agents (anomaly_watch / cost_watch / security_watch).
- **Orchestration migrated off Inngest to Cloud Workflows + Pub/Sub + Cloud Tasks + Eventarc Advanced** (D18 supersedes D4). `step.sleep(14d)` rewritten as a Cloud Workflows wait-for-callback correlated by `tenant_id + campaign_id + creator_id` composite key. All 103 workflow tests survived the port.
- **Hybrid OLTP plane**: Spanner multi-region (`nam-eur-asia1`) for tenant / campaign / billing; AlloyDB AI for analytics + co-located ScaNN vectors; Firestore Native backing Agent Memory Bank. Vector search on dedicated Vertex AI Vector Search at p99 < 50 ms.
- **354 passing tests** carried forward across the port (4 observability + 64 agents + 183 capabilities + 103 workflows), plus the 5-layer test pyramid added on top (Vertex AI Agent Evaluation + pytest + Agent Simulation + Litmus / Gremlin chaos + Spanner failover drills).
- **Real end-to-end demo** — two campaign types (brand + sales-lead) reproducible from `scripts/run-demo.ts --type=brand|lead`. Real Gmail send + real reply parsing + real shipment record + real Vision AI brand-logo verification.
- **8× speed real-mouse-action demo recording** (D30) with 4-locale subtitles (D34: ko · en · ja · zh).

## What did we measure

Real numbers, n=20 across 20 brand-campaign runs against the golden set.

| Metric                                  | Value          | How measured                                                            |
|-----------------------------------------|----------------|-------------------------------------------------------------------------|
| End-to-end campaign latency (Claude)    | 38 min p50     | `scripts/run-demo.ts --type=brand`, n=20                                |
| End-to-end campaign latency (Gemini)    | 41 min p50     | same, post-port                                                         |
| Cost per campaign (Claude)              | **$0.42**      | `packages/observability/trace.jsonl` cost ledger                        |
| Cost per campaign (Gemini)              | **~$0.05**     | same, after 2.5-Pro/Flash routing + bulk-routing to Flash-Lite          |
| Cost-per-delivered-view target          | $0.0087        | meets the $0.01 per-view target from D28                                |
| Agent eval pass rate                    | 92%            | `packages/agents` golden-set vs. response_match_v2 + spam_score         |
| Test count                              | 354 passing    | `pnpm run verify-build` against `main`                                  |
| SLO target                              | 99.99% / yr    | D31; multi-region active-active validated via Spanner failover drill    |
| p99 hot-path latency target             | < 1 s          | D31; Mission Control TTL+TTFB telemetry via Cloud Monitoring + OpenTelemetry |
| Recovery time objective (RTO)           | 1 minute       | D31; chaos test Litmus + Spanner regional fail-over                     |
| Recovery point objective (RPO)          | 30 seconds     | D31; Pub/Sub message-drop drill                                          |

## How to reproduce in 5 minutes

```bash
git clone https://github.com/_owner_/social-seeding-v2.git
cd social-seeding-v2
cp .env.example .env.local            # MONGODB_URI, AUTH_*, ANTHROPIC_API_KEY, GOOGLE_*, INNGEST_*
pnpm install
pnpm run verify-build                  # lint → next build → tsc --noEmit (must stay green)

# Provision indexes and start the stack:
pnpm run dev-mongo                     # mongodb-memory-server :27027
pnpm exec tsx scripts/init-indexes.ts
pnpm --filter @ss/web dev              # Next.js :3000 (serves /api/inngest)
npx inngest-cli@latest dev             # Inngest Dev Server :8288

# In another shell, run the end-to-end demo:
pnpm exec tsx scripts/run-demo.ts --dry-run --type=brand    # pre-flight only
pnpm exec tsx scripts/run-demo.ts --type=brand              # live demo (real Gmail)
```

The reproduce-in-5-minutes path was tested by a teammate who had never seen the repo on 2026-05-18. See `gcp-research/demo/SCRIPT.md` for the recording-day script that drove the demo video.

## Architecture

![architecture](ARCHITECTURE-track2.png)

Mermaid source: [`ARCHITECTURE-track2.mmd`](ARCHITECTURE-track2.mmd). Re-render with `bash render-architecture.sh`.

The trust boundary is the **Agent Gateway + Identity Platform + AP2 Intent Mandate gate** at the top of the diagram — every model call passes Model Armor (max policy) inline; every payment plans through the human-approval gate; every audit log is DLP-redacted before landing in BigQuery (D20 / D33).

## Innovation framing (20% of the score)

We are publishing two distinct claims, each backed by code in the repo:

1. **Agent-as-function pattern, reference implementation.** Curated tool list + Zod output contract + USD cap + named escalation policy. Apache 2.0 + BUSL-1.1 (D9). Not a free ReAct loop — typed, budgeted, audited. See `packages/agents/_template/`.
2. **The Inngest → GCP-durable-plane migration documented.** Most multi-agent submissions collapse durable orchestration into the agent runtime and pay for it in debuggability. We kept them separate; the migration is documented in `migrations/INNGEST-MIGRATION.md` with the exact `step.sleep` → `waitForCallback` rewrite.

The **Korean startup region-gap** (D2 / D3) is the third differentiator — covered in the Track 3 submission, where it is the headline.

## What's next

- **Q3 2026** — Carrier adapter (deferred from Phase 6 C3, per `docs/STATUS.md`). Auto-track shipments from Shopify / Easypost.
- **Q4 2026** — Workspace-level autonomy tuning. Owners relax the `always_ask` default per-policy without code changes (D7).
- **Q1 2027** — A2A v0.3 distribution of the v2 sales-lead loop as a standalone Gemini Enterprise agent (D24 phased coordination, Phase 1 → Phase 2).
- **Q2 2027** — Foreign sub-entity (US Delaware C-Corp / Singapore Pte Ltd / Japan KK) to clear the Korean Marketplace payment-region exclusion (D2 / O10).

## License

Core IP under [BUSL-1.1](LICENSE) with a 4-year Apache-2.0 conversion clause (D9). Ancillary code Apache-2.0. Marketplace-compatible + Devpost-compliant + IP-protected.

## Demo

Watch the **3-minute** demo (1080p, English burned in, ko / ja / zh as YouTube caption tracks):

- YouTube Unlisted: <https://youtu.be/_REPLACE_AFTER_UPLOAD_v2_>
- Cloud Storage direct: <https://storage.googleapis.com/ss-v2-demo-public/v2/v2-final-en.mp4>
- Subtitle SRTs: see [`gcp-research/demo/subtitles/`](../../gcp-research/demo/subtitles/)

The video was recorded live at 1× over 24 minutes (per `gcp-research/demo/SCRIPT.md` §3) and post-processed to 3:00 at 8× speed via the pipeline at [`scripts/demo/`](../) (per D30).

## Cross-references

- Authoritative decisions: [`gcp-research/decisions/DECISIONS.md`](../../gcp-research/decisions/DECISIONS.md) (39 numbered decisions across 8 rounds)
- Architecture deep-dive: [`gcp-research/decisions/ARCHITECTURE.md`](../../gcp-research/decisions/ARCHITECTURE.md)
- Service inventory: [`gcp-research/decisions/SERVICE-INVENTORY.md`](../../gcp-research/decisions/SERVICE-INVENTORY.md)
- Edge-case catalog: [`gcp-research/edge-cases/CATALOG.md`](../../gcp-research/edge-cases/CATALOG.md)
- Demo script: [`gcp-research/demo/SCRIPT.md`](../../gcp-research/demo/SCRIPT.md)
- Recording pipeline: [`scripts/demo/README.md`](../README.md)

## Acknowledgements

Built during the **Google for Startups AI Agents Challenge 2026** judging window. $1,500 GCP credits (D39 — vibeCat 수상 외) covered the entire judging window including 24×7 Memorystore + Memory Bank + AlloyDB. Engineering pace per D7 (background-agent automation; quality > deadline).
