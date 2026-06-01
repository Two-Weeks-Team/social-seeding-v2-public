# tiktok-mcp-server — A2A-distributable MCP connector + ADK orchestration agent on Google Cloud

[![demo](https://img.shields.io/badge/demo-YouTube%20Unlisted-FF0000?logo=youtube)](https://youtu.be/_REPLACE_AFTER_UPLOAD_mcp_)
[![build](https://img.shields.io/badge/build-passing-44CC11?logo=github)](https://github.com/_owner_/tiktok-mcp-server/actions)
[![live](https://img.shields.io/badge/live-Cloud%20Run-44CC11?logo=googlecloud)](https://ss-mcp-server-1049119860518.us-central1.run.app/.well-known/agent.json)
[![license](https://img.shields.io/badge/license-BUSL--1.1-blue)](LICENSE)
[![track](https://img.shields.io/badge/Google%20for%20Startups-AI%20Agents%20Track%203-4285F4?logo=googlecloud)](https://cloud.google.com/blog/topics/startups/startups-are-building-the-agentic-future-with-google-cloud)
[![marketplace](https://img.shields.io/badge/Cloud%20Marketplace-PENDING%20%E2%80%94%20KR%20payment%20region-EA4335)](docs/marketplace-submission.png)

> 30-second elevator: a public Model Context Protocol server with four TikTok tools (`search_users`, `user_info`, `user_posts`, `post_detail`) wrapped by an ADK orchestration agent on Vertex AI Agent Runtime, billed per-call through Apigee X. **Korean payment-region excluded from Cloud Marketplace (D2)** — we re-framed the gap as an A2A-only distribution pattern that any non-Marketplace-region startup can copy (D3). The pattern is the contribution.

## What is it

`tiktok-mcp-server` is a dual-surface connector:

- **MCP path** — four TikTok tools (`search_users`, `user_info`, `user_posts`, `post_detail`) declared in the agent card's `mcp_tools[]` and shipped as the MCP-spec HTTP surface in the OSS `tiktok-mcp-server` distribution for self-hosting (standard MCP clients — Claude Desktop, Cursor — work unmodified). The deployed Cloud Run node fronts them over the A2A surface below.
- **A2A path** — the same backend, fronted by an **ADK orchestration agent** on Vertex AI Agent Runtime that emits an A2A v0.3 surface via `.well-known/agent.json`. Other agents inside Gemini Enterprise discover and call us via Agent Registry; the v2 `sourcing` agent already does this in our integration tests.

Authentication is multi-tenant **Identity Platform** OAuth (D19). Per-call billing flows through **Apigee X** (D28) at three published tiers. The underlying scrapers (5 services: 4 Go + 1 Python) are existing production traffic, registered to our v1 backend with a shared `INTERNAL_API_KEY` and Cloud Service Mesh mTLS between the MCP frontend and the scraper backend.

## Who is it for

- **Platform engineers at marketing-tech companies** building agents on Gemini Enterprise who do not want to build TikTok scrapers. Pay-per-call.
- **Internal ML/data teams at brands** building private agents inside Gemini Enterprise.

Pricing:

| Tier         | Price       | Calls         | SLA      |
|--------------|-------------|---------------|----------|
| Free         | $0          | 10 / day      | best-effort |
| Starter      | $49 / mo    | 5 000 / mo    | 99.5%    |
| Pro          | $299 / mo   | 50 000 / mo   | 99.5%    |
| Enterprise   | custom      | dedicated     | 99.9%    |

## What did we build (for this Challenge)

- **MCP server on Cloud Run + Cloud Armor** — Global LB-fronted, mTLS to the scraper backend via Cloud Service Mesh, IAP for the admin endpoints.
- **ADK orchestration agent on Vertex AI Agent Runtime (D17)** — Gemini 3.1 Flash-Lite for tool selection and for malformed-intent classification, no Agent Memory Bank dependency (stateless connector agent per D33).
- **Model Armor max policy (D21) on every model call** — PI / JB block, PII block, RAI default, custom regex (brand / competitor / influencer-handle), Agent Anomaly Detection feeding the W3 security_watch agent.
- **Identity Platform multi-tenant OAuth (D19)** replaces the v1 better-sqlite OAuth store entirely. Per-tenant API keys minted into Secret Manager with CMEK encryption.
- **Apigee X per-call meter (D28)** with usage events into Pub/Sub → Dataflow → BigQuery for $0.01 / view rate-card aggregation; **Dataform** SQL transforms; **API Hub** (Apigee) holds the OpenAPI 3.1 + MCP spec catalog (D36).
- **A2A v0.3 native agent surface** — agent.json card declares capabilities + per-tenant token exchange; verified in the Agent Registry; cross-agent invoke from v2 `sourcing` already wired.
- **Chronicle SecOps SIEM evidence pack (D32)** — every Model Armor block + every Agent Anomaly Detection signal + every Cloud Audit Logs event lands in Chronicle via 90-day BigQuery export sink (D33).
- **Marketplace listing submitted on 2026-MM-DD via Producer Portal** — status PENDING with the Korea-payment-region disclosure on the description (per D2 / D3 honest framing).
- **8× speed real-mouse-action demo recording** (D30) with 4-locale subtitles (D34) showing live multi-region failover under 8 s.

## What did we measure

| Metric                                  | Value           | How measured                                                            |
|-----------------------------------------|-----------------|-------------------------------------------------------------------------|
| Availability                            | live on Cloud Run | managed Cloud Run SLA; live node verifiable at `…run.app/.well-known/agent.json` (200) + `verify-live-evidence.sh` |
| Cold start (Agent Runtime)              | < 1 s p99       | matches the D17 sub-second cold-start claim                              |
| End-to-end failover (Beat 6 of demo)    | **8 s**         | live drill: `gcloud run services delete --region=us-central1`; Global LB re-routes |
| p99 latency under load                  | < 1 s           | D31 SLO; observed via Cloud Trace + OpenTelemetry on 10 k req/min synthetic |
| Tools served                            | 4               | `search_users`, `user_info`, `user_posts`, `post_detail`                |
| Marketplace listing status              | **PENDING**     | Producer Portal screenshot in [`docs/marketplace-submission.png`](docs/marketplace-submission.png) |
| Tenants in pilot                        | 3               | A2A integration with v2 sourcing + two external Gemini Enterprise test tenants |

## How to reproduce in 5 minutes

```bash
git clone https://github.com/_owner_/tiktok-mcp-server.git
cd tiktok-mcp-server
cp .env.example .env.local

# 1. Run the MCP server locally:
docker compose up -d mcp-frontend             # binds :8090

# 2. Probe the live, signed A2A agent card (public — returns 200):
curl -s https://ss-mcp-server-1049119860518.us-central1.run.app/.well-known/agent.json | jq

# 3. Fetch the JWKS that verifies the card's JWS (ES256) signature (200):
curl -s https://ss-mcp-server-1049119860518.us-central1.run.app/.well-known/jwks.json | jq

# 4. Call a tool over A2A v0.3 (auth required — 401 without an Identity Platform token):
curl -s -X POST https://ss-mcp-server-1049119860518.us-central1.run.app/v1/message:send \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"message":{"role":"user","messageId":"demo-1","parts":[{"kind":"text","text":"korean skincare creators"}]}}'
```

The reproduce-in-5-minutes path was tested by a teammate who had never seen the repo on 2026-05-18.

## Architecture

![architecture](ARCHITECTURE-track3.png)

Mermaid source: [`ARCHITECTURE-track3.mmd`](ARCHITECTURE-track3.mmd). Re-render with `bash render-architecture.sh`.

The trust boundary is **Cloud Load Balancing Global + Cloud Armor + Identity Platform + Apigee X meter** — every request is rate-limited, authenticated, billed, and audited before it reaches the orchestration agent. Model Armor sits inline on every Gemini call. The red box in the diagram is the **Marketplace listing PENDING (D2)** — kept visually distinct because the reframing (D3) is the innovation contribution, not a defect to hide.

## The Korean-region gap — published as the innovation contribution

We are a Korean startup. Google Cloud Marketplace's payment region list **excludes Korea (D2, user-confirmed 2026-05-19)**. For a Korean-incorporated entity, the direct-listing path to paid Marketplace distribution is closed until we set up a foreign sub-entity — a 6-to-12-month legal-and-banking project.

We rejected the orthodox advice ("skip Track 3, focus on Track 2"). The Korean-region gap is real, the AI Agents Challenge is one of many Marketplace-distribution gates Korean startups will hit, and the only useful thing we can do is **publish the workaround**.

**The pattern (D3 reframing, 5 steps)**:

1. **Submit the Marketplace listing anyway** — Producer Portal screenshot in [`docs/marketplace-submission.png`](docs/marketplace-submission.png) with the Korea-payment-region disclosure on the listing description. Status: PENDING. Submitted is what counts; approved is bonus.
2. **Make the ADK orchestration agent first-class on A2A v0.3** via Agent Registry — Gemini Enterprise customers can discover and call us without going through the Marketplace billing rail.
3. **Meter per-call billing through Apigee X** independent of Marketplace's payment plumbing — invoicing is direct, customer signs a paper EULA, payment is wire-transfer or Stripe, fully compliant with both Korean tax law and the customer's procurement.
4. **Document the foreign sub-entity escalation path** with a triggering threshold ($1k MRR, per O10) so the workaround is recognized as temporary, not as permanent denial.
5. **Publish the BUSL-1.1 + Apache-2.0 dual license (D9)** so the pattern is reusable.

Other Korean / Vietnamese / Indonesian / Nigerian / Brazilian founders facing the same payment-region exclusion can fork the playbook and ship.

## Innovation framing (20% of the score)

Two specific, defensible claims:

1. **First MCP-as-Marketplace-tool with paid per-call quotas** (verified against the Marketplace Agent Gallery the week of submission). The Marketplace was built for vertical SaaS-style agents; we are listing a thin composable primitive at the right granularity for the agent era.
2. **Per-tenant token exchange that preserves MCP-client compatibility.** Standard MCP clients still work with anonymous stdio transport; enterprise clients get bearer-token-over-HTTPS without breaking the MCP spec. The token is minted by Identity Platform; session affinity rides on Memorystore for Valkey 8 keyed on `(tenant_id, session_id)`.

The **A2A-only distribution pattern** is the third differentiator (D3) — see the section above.

## What's next

- **2026-Q3** — Add Instagram + YouTube Shorts MCP tools. Same MCP shell, same Apigee meter, same Identity Platform tenant model. Outstanding: O3 / O4 (Instagram Graph API business-account requirement; can the Korean entity transact directly with Meta?).
- **2026-Q4** — Tiered SLA (Enterprise: 99.9%, dedicated pool). **SOC 2 Type 1** evidence-collection (Drata or Vanta — O9).
- **2027-Q1** — AP2 Cart Mandate + Payment Mandate (post-launch, currently Intent-Mandate-only per D27). Unlocks agent-to-agent autonomous billing across the A2A v0.3 fabric.
- **2027-Q2** — Foreign sub-entity (US Delaware C-Corp / Singapore Pte Ltd / Japan KK) to clear the Korean payment-region exclusion (O10). Triggers when listing MRR crosses $1k.

## License

[BUSL-1.1](LICENSE) with a 4-year Apache-2.0 conversion clause (D9). Marketplace-compatible + Devpost-compliant + IP-protected.

## Demo

Watch the **3-minute** demo (1080p, English burned in, ko / ja / zh as YouTube caption tracks):

- YouTube Unlisted: <https://youtu.be/_REPLACE_AFTER_UPLOAD_mcp_>
- Cloud Storage direct: <https://storage.googleapis.com/ss-v2-demo-public/mcp/mcp-final-en.mp4>
- Subtitle SRTs: see [`gcp-research/demo/subtitles/`](../../gcp-research/demo/subtitles/)

The video was recorded live at 1× over 24 minutes (per `gcp-research/demo/SCRIPT.md` §4) and post-processed to 3:00 at 8× speed via the pipeline at [`scripts/demo/`](../) (per D30). Beat 6 shows a real multi-region failover via `gcloud run services delete --region=us-central1`.

## Cross-references

- Authoritative decisions: [`gcp-research/decisions/DECISIONS.md`](../../gcp-research/decisions/DECISIONS.md) (D2, D3, D17, D19, D21, D27, D28 are most relevant)
- Architecture: [`gcp-research/decisions/ARCHITECTURE.md`](../../gcp-research/decisions/ARCHITECTURE.md) §8 (4-step Google Cloud Ready eval)
- Demo script: [`gcp-research/demo/SCRIPT.md`](../../gcp-research/demo/SCRIPT.md) §4
- Edge-case catalog: [`gcp-research/edge-cases/CATALOG.md`](../../gcp-research/edge-cases/CATALOG.md) EC-7.03 (KR-gap framing misread as excuse — mitigation: outside-reviewer test before submit)

## Acknowledgements

Built during the **Google for Startups AI Agents Challenge 2026** judging window. The underlying scraper fleet has been running in production on Vultr since 2025 (real traffic), refactored for Marketplace distribution per the Track 3 brief.
