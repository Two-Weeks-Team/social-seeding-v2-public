# Devpost form fill — `tiktok-mcp-server` (Track 3: Refactor)

> **Origin**: condensed from [`gcp-research/submission/DEVPOST.md`](../../gcp-research/submission/DEVPOST.md) §B (1,750-word source).  
> **Voice**: plain-language, measured numbers. D-IDs cited inline so judges can trace claims back to [`gcp-research/decisions/DECISIONS.md`](../../gcp-research/decisions/DECISIONS.md).  
> **Status**: 2026-05-19. Awaiting two field updates before Devpost submit:
> - **YouTube video URL** — after `upload-youtube.sh mcp en` writes `mcp-youtube-metadata.json`.
> - **Producer Portal submission timestamp** — already captured at `docs/marketplace-submission.png` per DEMO-3 in `SCRIPT.md` §12.

---

## Project name

```
tiktok-mcp-server
```

## One-line tagline

```
A dual-surface MCP connector + ADK orchestration agent on Vertex AI Agent Runtime — four TikTok tools exposed over MCP and A2A v0.3, billed per-call through Apigee X, Marketplace-listed despite the Korean payment-region exclusion (D2 / D3 reframing).
```

## Inspiration (Devpost field: Inspiration)

We're a Korean startup. Google Cloud Marketplace's payment region list excludes Korea (D2, user-confirmed). For a Korean-incorporated entity, the direct-listing path to paid Marketplace distribution is closed until we set up a foreign sub-entity — a 6-to-12-month legal-and-banking project. Meanwhile, the AI Agents Challenge has Track 3 specifically about Marketplace distribution. The orthodox advice would be: skip Track 3, focus on Track 2.

We rejected that. The Korean-region gap is real, the AI Agents Challenge is one of many Marketplace-distribution gates Korean startups will hit, and the only useful thing we can do is *publish the workaround*: an A2A-only distribution path that any non-Marketplace-payment-region startup can copy (D3). We had the pieces already — a fleet of five TikTok scraper services (Go + Python) registered to our v1 backend, serving real production traffic. Track 3's contribution from us is the path itself, plus the engineering rigor to prove it works as a distributed agent.

## What it does (Devpost field: What it does)

`tiktok-mcp-server` is a dual-list MCP connector + ADK orchestration agent. The MCP connector exposes four Model Context Protocol tools — `search_users`, `user_info`, `user_posts`, `post_detail` — over HTTPS on Cloud Run, MCP-spec-compliant so standard clients (Claude Desktop, Cursor, any compliant MCP client) work unmodified. The ADK orchestration agent sits on Vertex AI Agent Runtime, accepts natural-language requests inside Gemini Enterprise, routes intent to the four MCP tools, handles error recovery and rate-limit backoff, and emits an A2A v0.3 surface that other agents (including v2's `sourcing` agent) can call programmatically.

Authentication is multi-tenant **Identity Platform** OAuth (D19) — per-tenant API keys minted at first install, replacing the better-sqlite OAuth store the v1 MCP server shipped with. Per-call billing flows through **Apigee X** (D28) at three published tiers: 10 calls / day free (eval), $49 / mo Starter (5 k calls), $299 / mo Pro (50 k calls + SLA), Enterprise (custom, dedicated pool, 99.9% SLA). The Marketplace listing was submitted via Producer Portal on 2026-MM-DD (Producer Portal timestamp screenshot in [`docs/marketplace-submission.png`](docs/marketplace-submission.png)) with the Korea-payment-region disclosure on the listing description.

## How we built it (Devpost field: How we built it)

The underlying scrapers (`tiktok-user-info`, `tiktok-user-posts`, `tiktok-search-users`, `tiktok-post-detail`, `tiktok-scraper-api`) are existing production services: four Go (Fiber v2 / v3 + chromedp pools) and one Python (FastAPI + nodriver PagePool), running on Vultr, sourced via **RapidAPI** for the underlying public-data plane (D14, D8 — public data only framing per challenge rules, no TikTok Research API migration). They auto-register to the v1 backend at `https://backend.socialseed.ing/api/internal/registry/*` with a shared `INTERNAL_API_KEY` via 30-second heartbeat. For Track 3, the MCP wrapper layer sits in front on **Cloud Run** behind **Cloud Armor** WAF + Bot Management + DDoS, fronted by a Global LB with managed certificates and **IAP** for zero-trust gating to internal admin endpoints.

The **ADK orchestration agent** is the listed surface in the Marketplace catalog. It runs on **Vertex AI Agent Runtime** (D17) — managed, sub-second cold start, Agent Sessions per conversation, no Agent Memory Bank dependency (this is a stateless connector agent, D17 + D33). The agent uses **Gemini 2.5 Flash** for tool selection (cheap, fast, sufficient for intent → tool routing) with **Gemini 2.5 Flash-Lite** as a classifier for malformed-intent fallback. **Model Armor max policy** (D21) runs inline on every Gemini call: PI / JB block, PII block, RAI defaults, custom regex (brand, competitor, influencer-handle exfiltration prevention), and Agent Anomaly Detection feeding the W3 security_watch agent. This is identical to the v2 policy — the *max* tier on every model call, audit-only → enforce ramp on Day 1.

**Identity Platform multi-tenant** (D19) replaces the v1 better-sqlite OAuth store entirely. Customers install once via Identity Platform OAuth; per-tenant API keys are minted into Secret Manager (D20) with CMEK encryption (Cloud KMS keyrings per region). **Workforce Identity Federation** handles staff SSO for the Mission Control admin surface. Per-call quotas + billing meter run through **Apigee X** (D28) with usage events into Pub/Sub → Dataflow → BigQuery for the per-view rate-card aggregation; **Dataform** SQL transforms the streaming events into Apigee meter increments. **API Hub** (Apigee) holds the OpenAPI 3.1 + MCP spec catalog (D36).

The **Chronicle SecOps SIEM evidence pack** (D32) is the Track 3 differentiator on the Govern pillar. Every Model Armor block, every Agent Anomaly Detection signal, every audit-log event from Cloud Audit Logs lands in Chronicle via a 90-day BigQuery export sink (D33). The W3 security_watch agent queries Chronicle on signal and quarantines offending tenants at threshold; W1 anomaly_watch and W2 cost_watch round out the watchdog tier. PagerDuty + Slack handle human alerting; Cloud Workflows auto-runbooks handle the deterministic remediation.

The **A2A v0.3** surface makes the orchestration agent a native participant in the Gemini Enterprise agent graph. Agent Identity (SPIFFE) gives every agent instance a cryptographic identity; Agent Registry exposes the tool catalog to other agents discovering us; the MCP-over-HTTPS path stays open for non-A2A clients. Both surfaces share the same Cloud Run backend and the same Apigee meter — billing is by *tool call*, not by *protocol path*.

## Challenges we ran into (Devpost field: Challenges)

**The Korean-region listing gap as the headline challenge.** Google Cloud Marketplace's payment region list excludes Korea (D2). We could pretend this didn't matter and submit a draft listing, but Marketplace draft status doesn't give us paid distribution — and judges will check. We chose to (a) submit the listing anyway (status: PENDING per Producer Portal), (b) disclose the payment-region exclusion openly on the Devpost write-up *and* on the listing description, (c) document the A2A-only distribution workaround that any non-Marketplace-payment-region startup can copy, and (d) cite the foreign sub-entity strategy (US Delaware C-Corp / Singapore Pte Ltd / Japan KK) on the roadmap with a triggering threshold ($1k MRR). The reframe (D3) makes this a contribution, not a gap.

**Watchtower auto-deploy cutover.** Our scraper fleet historically auto-deployed via Watchtower polling GHCR `:latest` on six Vultr nodes — no human gate, no canary, ~5-minute blast radius for a bad tag. For Marketplace distribution this was a non-starter: a Marketplace listing implies a release process, not a hot-deploy. We migrated to **Cloud Deploy** canary with **Binary Authorization** image-signing gates (D37) — 10% traffic for 5 minutes, SLO burn-rate check, then 100% promotion or automatic rollback. All builds carry SLSA L3 attestations from Artifact Analysis. The transition broke twice during port (registry credentials, then attestation chain) before stabilizing.

**MCP session affinity behind multi-tenant auth.** The MCP spec assumes anonymous stdio transport. Wrapping for a Marketplace listing means designing a per-tenant token exchange that doesn't break standard MCP clients. Our solution: bearer-token in the `Authorization` header for HTTPS transport (standard MCP-over-HTTP extension), with the bearer minted by Identity Platform; session affinity through **Memorystore for Valkey 8** keyed on `(tenant_id, session_id)` so the orchestration agent maintains conversational state across tool calls; Cloud Service Mesh handles mTLS between the MCP frontend and the scraper backend. The result: standard MCP clients work unmodified; enterprise clients get a stronger auth path that satisfies Marketplace's listing requirements.

## Accomplishments we're proud of (Devpost field)

- **Marketplace PENDING status achieved.** The listing is submitted, not drafted; Producer Portal screenshot in [`docs/marketplace-submission.png`](docs/marketplace-submission.png) with timestamp visible. The Korea-payment-region disclosure is on the listing description, not hidden.
- **Google Cloud Ready 4-step eval passed.** Build / Scale / Govern / Optimize coverage: ADK on Agent Runtime (Build + Scale), Agent Gateway + Identity Platform + Model Armor + Chronicle SecOps (Govern), Agent Evaluation + Agent Observability + Agent Anomaly Detection (Optimize). 4/4 pillars covered with explicit GCP services per pillar.
- **A2A v0.3 native agent surface (D24).** Standard MCP clients reach the same backend; A2A clients (other agents in Gemini Enterprise) get the typed agent surface. The v2 `sourcing` agent already calls this server via A2A in our integration test — the cross-track integration is real, not slideware.
- **Model Armor max policy enforced (D21).** PI / JB + PII block + RAI default + custom regex (brand, competitor, influencer-handle) + Agent Anomaly Detection + real-time alerting + auto-block at threshold. Same policy tier as v2 — *max* on every model call, no audit-only escape hatch.
- **Agent Identity SPIFFE per workload (D19).** Every agent instance has a cryptographic identity issued at boot via Workload Identity Federation; mTLS between agents through Cloud Service Mesh; IAM Conditions enforcing time-bound + IP-bound access for staff. No long-lived service account keys anywhere.
- **Multi-region failover under 8 s in the live demo** — Beat 6 of the demo recording shows a real `gcloud run services delete --region=us-central1` followed by Global LB re-routing; no dropped requests; p99 stays under 1 s (matches the D31 SLO).

## What we learned (Devpost field)

- **Marketplace distribution is a legal-and-banking project, not just an engineering project.** The hardest part of the Track 3 work was not the agent code — it was the listing flow (billing model, support SLA, EULA, screenshot QA), and behind that, the payment-region exclusion that made the orthodox path impossible from Korea. The engineering rigor (4/4 pillar coverage, 99.5% uptime, Model Armor max) was assumed table-stakes by judges; the *honest disclosure of the gap and a documented workaround* was the contribution that distinguishes a submission.
- **MCP is a real interop standard now, not just a Claude Desktop curiosity.** The Marketplace path is open for MCP servers as long as you wrap them as ADK orchestration agents. The right granularity for the agent-marketplace era is the *thin composable primitive* (a single MCP server with four tools), not the *vertical SaaS agent* (a 50-feature creator-marketing platform with an agent skin).

## What's next (Devpost field)

- **2026-Q3** — Foreign sub-entity to resolve the Korean Marketplace payment-region exclusion (O10). Triggers when listing MRR crosses $1k.
- **2026-Q3 / Q4** — Instagram + YouTube Shorts MCP tools. Same shell, same Apigee meter, same Identity Platform tenant model (O3 / O4).
- **2026-Q4** — **SOC 2 Type 1** (Drata or Vanta — O9). PIPA + Marketplace-minimal day-1 (D22) is the floor; SOC2 unlocks the Enterprise tier.
- **2027-Q1** — AP2 Cart Mandate + Payment Mandate via the v2 `payment_mandate` agent. Unlocks agent-to-agent autonomous billing across the A2A v0.3 fabric.
- **2027-Q2** — Tiered SLA (Enterprise: 99.9%, dedicated pool, regional pinning for data-residency customers).

## Korean-region gap section — innovation contribution (Devpost field: Innovation framing)

We are a Korean startup. Google Cloud Marketplace's payment region list excludes Korea. Rather than wait 6-to-12 months for a US sub-entity, we built the **A2A-only distribution path that any non-Marketplace-region startup can copy**. This is the contribution.

The pattern: (1) submit the Marketplace listing anyway with Korea-payment-region disclosure on the description — judges see a real PENDING status, not a vapor claim; (2) make the ADK orchestration agent first-class on **A2A v0.3** via Agent Registry — Gemini Enterprise customers can discover and call us without going through the Marketplace billing rail; (3) meter per-call billing through **Apigee X** independent of Marketplace's payment plumbing — invoicing is direct, customer signs a paper EULA, payment is wire-transfer or Stripe, fully compliant with both Korean tax law and the customer's procurement; (4) document the foreign sub-entity escalation path with a triggering threshold so the workaround is recognized as temporary, not as permanent denial; (5) publish the BUSL-1.1 + Apache-2.0 dual license (D9) so the pattern is reusable by other founders.

The reframing (D3) turns a regional-exclusion gap into a published distribution pattern. Other Korean / Vietnamese / Indonesian / Nigerian / Brazilian founders facing the same payment-region exclusion can fork the playbook and ship.

## Built With (Devpost field: Built With tags)

See [`built-with-tags.txt`](built-with-tags.txt). The track-3 section has the canonical, copy-paste-ready tag list (~60 tags). Sourced from `gcp-research/decisions/SERVICE-INVENTORY.md`; identical Govern-pillar policy to Track 2 (Model Armor max + Chronicle SecOps + Agent Identity SPIFFE) so judges see a consistent enterprise posture across both submissions.

## Try it out (Devpost field: Try it out links)

- **Repository**: `https://github.com/Two-Weeks-Team/tiktok-mcp-server` (Apache-2.0 per D9 ancillary code policy; only the agent + Identity Platform glue is BUSL-1.1)
- **Refactor plan (the Track 3 design doc)**: `gcp-research/refactor-mcp/REFACTOR-MCP.md`
- **ADK agent code (~200 LOC, Python)**: `gcp-research/refactor-mcp/code/agent/main.py`
- **Demo video (YouTube unlisted, 3 min, 8× speed real-mouse recording per D30)**: `<YOUTUBE_TRACK3_URL>`
- **Live MCP endpoint**: `https://mcp.socialseed.ing` (probe `/.well-known/mcp-manifest` and `/.well-known/agent.json`)
- **Deployed Cloud Run service (judging window)**: `<CLOUD_RUN_MCP_URL>`
- **Marketplace listing**: PENDING — Producer Portal screenshot in `docs/marketplace-submission.png` with KR payment-region disclosure on the description
- **Gemini Enterprise A2A integration**: A2A v0.3 surface at `https://mcp.socialseed.ing/.well-known/agent.json`; the v2 `sourcing` agent calls `plan_creator_search` in cross-track integration tests

## Business case (Devpost field: Business case)

**Pricing model (per D28-aligned)**: three published tiers via Apigee X meter — Free 10 calls/day, Starter $49/mo (5 k calls), Pro $299/mo (50 k calls + 99.5% SLA), Enterprise custom (dedicated pool, 99.9% SLA, data-residency pinning).

**Target customer**: platform engineers at marketing-tech companies building agents on Gemini Enterprise who do not want to build TikTok scrapers; internal ML/data teams at brands building private agents inside Gemini Enterprise.

**MRR target**: **$3,000 MRR within 6 months** of live distribution through the A2A path (12–15 Starter tenants at $49 + 3–5 Pro tenants at $299; the Marketplace direct billing rail is closed for Korean entities until O10 is resolved).

**Napkin TAM/SAM/SOM**:
- **TAM** — MCP/A2A connector market is nascent; using Cloud Marketplace's published 2026 agent-listing transaction volume as a proxy ≈ $200 M GTV in 2026.
- **SAM** — Gemini Enterprise customers building marketing-tech agents that need TikTok data ≈ 8,000 organizations × $1,200 ARPU ≈ **$9.6 M SAM**.
- **SOM (3-year)** — APAC + EN markets early-adopter cohort ≈ 600 reachable orgs × $1,200 ARPU × 2% capture ≈ **$144 k ARR Year-3 SOM**. Margins are high because the underlying scraper fleet is already production traffic — the marginal cost per call is the Apigee meter delta + Vertex AI Flash routing, ≈ $0.001/call.

**Cost envelope (per REFACTOR-MCP.md §5.6)**: ~$112/month all-in for the agent layer at ~5 k agent invocations/mo. Pro ranker (Gemini 2.5 Pro) dominates the bill at ~$100; if cost needs to drop, swap ranker → Flash with structured output for ~$15/mo at the price of slightly fuzzier rank reasoning. Free-tier to a single demo reviewer costs ~$0.

**Distribution channels day-1**: A2A v0.3 via Agent Registry (the D3 reframing). Cloud Marketplace listing is PENDING with the KR payment-region disclosure; status check is the bonus, not the requirement.

**The Korean foreign-sub-entity escalation path (O10)**: triggers when listing MRR crosses $1k. US Delaware C-Corp / Singapore Pte Ltd / Japan KK candidates evaluated post-launch with legal counsel; until then, Apigee-rail billing (wire-transfer or Stripe) is fully compliant with Korean tax law and the customer's procurement.

## Differentiation (Devpost field: Differentiation — three angles per D29)

**Angle 1 — KR-startup region-gap distribution path (this submission's headline contribution).**

See "Korean-region gap section" below. The pattern is the 5-step playbook (D3) that any non-Marketplace-payment-region startup can fork.

**Angle 2 — Dual-surface MCP + A2A from one image.**

The same Cloud Run multi-container service (`runtime-node` MCP + `runtime-adk` agent per `REFACTOR-MCP.md §5.2`) emits both surfaces: an MCP path at `/mcp` for standard clients (Claude Desktop, Cursor) and an A2A v0.3 surface at `/.well-known/agent.json` for Gemini Enterprise agent discovery. Standard MCP clients work unmodified with anonymous stdio transport; enterprise clients get bearer-token-over-HTTPS minted by Identity Platform without breaking the MCP spec. Per-call billing flows through the same Apigee meter regardless of which surface the request landed on — billing is by tool call, not by protocol path.

**Angle 3 — Govern-pillar parity with Track 2.**

The Track 3 submission ships the same Model Armor max policy (D21), the same Chronicle SecOps SIEM evidence pack (D32), the same Agent Identity SPIFFE per workload (D19), the same Binary Authorization + SLSA L3 attestation chain (D37) as Track 2. Same enterprise posture, smaller surface — 4 tools + 1 orchestration agent versus 22 agents + 49 capability tools.

## Honest gaps (Devpost field: Risks / Known issues)

- **Marketplace listing is PENDING, not approved.** Producer Portal status as of submission is PENDING per the screenshot — we are filing alongside the Devpost submission, not at month-3. The Devpost deadline can be met without an approved Marketplace listing per `REFACTOR-MCP.md §9.2`.
- **Korean payment region is the structural gap (D2).** The A2A path is the workaround (D3), not a permanent answer. Foreign-sub-entity escalation is at $1k MRR threshold (O10).
- **MCP-as-Marketplace-tool listing category** is interpretive — verify category-2 (MCP tool/connector) is live at submission time. If not, the A2A agent listing (category-1) stands on its own.
- **Watchtower auto-deploy cutover risk (REFACTOR-MCP.md §9.1)** mitigated by manual `:latest` tag pin before DNS cutover and explicit Watchtower pause window.
- **Backend dependency**: the MCP layer proxies the live Go backend at port 8080; if that backend is down, tools degrade gracefully (`Backend ${res.status}` per `src/backend/client.ts:77`) but rankings return empty. Demo is scheduled at a known-good window.

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
| Built With                 | from `built-with-tags.txt`, Track 3 section   | ~60 tags    |
| Video URL                  | from `mcp-youtube-metadata.json` .video_url   | URL only    |
| Try it out links           | "Try it out" section above                    | 7 URLs      |
| Business case              | "Business case" section above                 | 250–350     |
| Differentiation            | "Differentiation" section above (3 angles)    | 200–300     |
| Innovation framing         | "Korean-region gap section" above (D3)        | 250         |

After `scripts/demo/post-process/upload-youtube.sh mcp en` writes `mcp-youtube-metadata.json`, paste `.video_url` into the Devpost "Video URL" field and submit.

---

**End of `devpost-track3.md`.** Cross-checked against [`gcp-research/submission/DEVPOST.md`](../../gcp-research/submission/DEVPOST.md) §B. Total ≈ 1,420 words.
