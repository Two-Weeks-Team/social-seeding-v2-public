# SERVICE-INVENTORY.md — GCP Service Usage Matrix

> **Source of truth**: [`DECISIONS.md`](DECISIONS.md). Every "Used" cell cites a D-ID. The 4-pillar coverage from [`ARCHITECTURE.md`](ARCHITECTURE.md) §8 is the high-level mapping; this file is the per-service spreadsheet.
>
> **Inclusion principle** (per D23 — "all GCP services that aren't unnecessary"): a service is **Used** only if it solves a decision; a service is **Not Used** only if there's an explicit reason. No service is left in limbo.
>
> **Status legend**: ✅ Used · ⬜ Considered, not adopted · 🔁 Superseded by another GCP service · ❌ Deprecated/EOL/sunset · 🟡 Used in v2-rebuild-Phase-2 (post-launch)

---

## 1. Headline counts

| Category | GCP services in scope | ✅ Used | ⬜ Considered | 🟡 Phase-2 | ❌ Not viable |
|---|---|---|---|---|---|
| Compute & Containers | 11 | 6 | 1 | 1 | 3 |
| AI / Agents / Vertex | 28 | 25 | 1 | 0 | 2 |
| Data / Storage | 17 | 11 | 3 | 1 | 2 |
| Networking | 10 | 9 | 1 | 0 | 0 |
| Security / IAM | 11 | 10 | 1 | 0 | 0 |
| Observability | 9 | 9 | 0 | 0 | 0 |
| DevOps / Integration | 14 | 11 | 1 | 1 | 1 |
| Specialized AI | 10 | 9 | 1 | 0 | 0 |
| Firebase | 8 | 5 | 1 | 1 | 1 |
| Edge / Hybrid | 3 | 0 | 1 | 0 | 2 |
| **TOTAL** | **121** | **95** | **10** | **4** | **11** |

**Coverage: 95/121 = 79% active GCP services in scope.** Plus 4 phased for after launch = 99/121 = **82% lifetime coverage**.

---

## 2. Compute & Containers

| Service | Status | D-ID | Role | Latest 2026 |
|---|---|---|---|---|
| Cloud Run services | ✅ | D17, D26 | Mission Control SSR adapter, webhook receivers, non-agent helpers | gen2 runtime, scale-to-zero |
| Cloud Run Jobs | ✅ | D37 | Batch evals, nightly Agent Simulation, license scans | GPU jobs GA |
| Cloud Run worker pools | ✅ | D18 | Queue-driven workers behind Pub/Sub fan-out | GA 2026-04-14 |
| Cloud Run functions (= Functions Gen 2) | ✅ | D14, D26 | Pub/Sub-triggered light handlers, FCM webhook | Renamed from Functions Gen 2 (2024-08-22) |
| GKE Autopilot | ✅ | D23, D26 | Agent Sandbox (gVisor) + GPU pods for Veo/Imagen | Burstable workloads GA |
| GKE Standard | ⬜ | — | Considered for fine-tuning workloads; Autopilot wins | — |
| GKE + GPU/TPU | ✅ | D25 | TPU v6e for distillation jobs; H100 for Veo 3 batch generation | TPU v6e GA, v7x limited |
| Compute Engine (raw VMs) | ⬜ | — | Considered for self-hosted vLLM; managed Vertex AI wins | A4X Max available |
| App Engine Standard/Flex | ❌ | — | Google explicitly recommends against new builds (2026) | — |
| Cloud Functions Gen 1 | ❌ | — | Superseded by Cloud Run functions (Gen 2) | — |
| Cloud Workflows | ✅ | D18 | Durable orchestration (replaces Inngest); auto-runbooks | Callbacks GA 2026-05-15 |

---

## 3. AI / Agents / Vertex (the heart)

### Build pillar

| Service | Status | D-ID | Role |
|---|---|---|---|
| Agent Development Kit (ADK) Python 2.0 Beta | ✅ | D17, D24, D35 | Primary agent framework |
| Agent Development Kit (ADK) TypeScript 1.0 GA | ⬜ | — | Considered for Mission Control RAG; Genkit chosen instead (lower risk) |
| Agent Studio | ✅ | D25 | Visual prototyping of new agents before code lock |
| Agent Garden | ✅ | D24 | Atomic seeds for the 5 new Tier-1 agents |
| Agents CLI | ✅ | D38 | `agents-cli create/eval/deploy/publish` in CI |
| Gemini 3.1 Pro Preview | ✅ | D5, D39 | Final demo recording (judgment-heavy outreach_writer judge) |
| Gemini 2.5 Pro | ✅ | D5 | Production default for judgment roles |
| Gemini 2.5 Flash | ✅ | D5 | Bulk roles (vetting fan-out, logistics) |
| Gemini 2.5 Flash-Lite | ✅ | D5 | Classifier (conversation) |
| Gemini Nano | ⬜ | — | On-device; mobile PWA later |
| Gemma 3 (open weights) | ⬜ | — | Self-hosted backup; not for demo |
| MCP APIs and Connectors | ✅ | D14 | Internal MCP fabric (TikTok, Instagram, Atlas, Gmail) |
| A2A protocol v0.3 | ✅ | D24 | Inter-agent calls within fleet + external 70+ partners |
| AP2 protocol v0.2 | ✅ | D12, D27 | Intent Mandate only; payment_mandate agent owns |
| Grounding (Google Search) | ✅ | D29 | research agent only; cost-aware (per-query) |
| Vertex AI Search (Agent Search) | ✅ | D29 | RAG over brand brief library |
| Cloud Marketplace listing | ✅ | D2, D3 | Track 3 submission target (KR-gap disclosed) |

### Scale pillar

| Service | Status | D-ID | Role |
|---|---|---|---|
| Agent Runtime | ✅ | D17 | All 22 agents hosted here |
| Agent Sandbox | ✅ | D23 | Untrusted code (e.g. user-supplied analytics queries) |
| Agent Memory Bank | ✅ | D33 | Long-term memory for outreach style, brand voice, customer history |
| Agent Sessions | ✅ | D17 | Per-conversation state |

### Govern pillar

| Service | Status | D-ID | Role |
|---|---|---|---|
| Agent Gateway | ✅ | D32 | Private Preview disclosed in Devpost; central audit + rate-limit |
| Agent Identity (SPIFFE) | ✅ | D19 | Every agent has cryptographic identity |
| Agent Registry | ✅ | D29 | Internal catalog + external partner agent discovery |
| Model Armor | ✅ | D21 | Max policy: PI/JB/PII/RAI/custom regex/anomaly |
| Agent Policy | ✅ | D22 | PIPA + Marketplace-minimal policy bundle |
| Agent Compliance | ✅ | D22, D33 | Automated compliance evidence collection |
| Agent Security | ✅ | D21 | Subset of Model Armor + SCC AI Protection |

### Optimize pillar

| Service | Status | D-ID | Role |
|---|---|---|---|
| Agent Evaluation | ✅ | D25, D37 | Golden-set + LLM-as-judge; per-PR + nightly |
| Agent Observability | ✅ | D31 | Trace + token + cost dashboard |
| Agent Optimizer | ✅ | D25 | Auto-tune prompts based on eval lift |
| Agent Simulation | ✅ | D25, D37 | 1000+ scenario regression for RLHF reward |
| Agent Anomaly Detection | ✅ | D23 | Watchdog feed (W1) |

### Vertex core

| Service | Status | D-ID | Role |
|---|---|---|---|
| Vertex AI Pipelines (Kubeflow) | ✅ | D25 | SFT + Distillation training pipelines |
| Vertex AI Vector Search | ✅ | D16 | Dedicated vector index for creators + brands |
| Vertex AI Workbench | ✅ | D25 | Data scientist notebook for tuning experiments |
| Vertex AI Conversation | ⬜ | — | Considered for Dialogflow CX integration; CX direct wins |
| Vertex AI Reasoning Engine | 🔁 | — | Superseded by Agent Runtime |

---

## 4. Data / Storage

| Service | Status | D-ID | Role |
|---|---|---|---|
| Cloud Storage | ✅ | D30, D34 | Demo replay buckets, assets, audit archive, translation cache |
| BigQuery | ✅ | D28, D33 | Per-view billing pipeline, audit log sink, eval result table |
| BigQuery ML | ✅ | D28 | CPM forecasting, churn prediction |
| BigQuery Studio | ✅ | D38 | Operator dashboards (cost-watch W2 surface) |
| Firestore Native | ✅ | D15 | Agent Memory Bank backing + Mission Control real-time sync |
| Firestore Datastore mode | ❌ | — | Trap for new projects; Native chosen |
| Cloud SQL | ⬜ | — | Considered for legacy compatibility; AlloyDB wins |
| AlloyDB for PostgreSQL | ✅ | D15 | Tenant-region analytical store + feature store |
| AlloyDB AI (ScaNN + auto-embedding) | ✅ | D15, D16 | Co-located vector co-table for ranking features |
| AlloyDB Omni | ⬜ | — | Considered for hybrid/edge; not needed |
| Spanner | ✅ | D13, D15 | Multi-region core (customers, campaigns, billing, audit-keys) |
| Spanner Graph | 🟡 | — | Phase-2: creator → brand relationship graph for "looks-like" recommendations |
| Spanner Vector Search | ⬜ | — | Considered; Vertex Vector Search wins for size + latency |
| Memorystore for Valkey | ✅ | D17, D18 | Session affinity store, MCP per-request state, hot vector cache |
| Memorystore for Redis | ⬜ | — | Valkey is the 2026-preferred sibling |
| Memorystore for Memcached | ❌ | — | Deprecated (shutdown 2029-01-31) |
| Bigtable | ⬜ | — | Considered for high-volume metrics; Cloud Monitoring + BigQuery wins |
| Dataform | ✅ | D28 | Per-view billing aggregation SQL transformations |
| Knowledge Catalog (=Dataplex) | ✅ | D22 | Data governance + lineage for PIPA evidence |
| Dataflow | ✅ | D28, D37 | Stream: view events → BigQuery; Batch: nightly evals |
| Managed Service for Apache Spark (=Dataproc Serverless) | ⬜ | — | Considered for fine-tuning data prep; Dataflow + Vertex Pipelines win |
| Pub/Sub | ✅ | D18 | Event bus (fan-out, schema-evolution) |
| Pub/Sub Schema Registry | ✅ | D36 | AsyncAPI 3.0 → Pub/Sub schema enforcement |
| Pub/Sub Lite | ❌ | — | Turndown 2026-06-30 |

---

## 5. Networking

| Service | Status | D-ID | Role |
|---|---|---|---|
| Cloud Load Balancing (Global) | ✅ | D13, D31 | Global LB with model-aware routing |
| Cloud Load Balancing (Regional/Internal) | ✅ | D13 | Internal LB for Agent Runtime → Memorystore |
| Cloud CDN | ✅ | D13, D26 | Asset + Mission Control SSR cache |
| Media CDN | ⬜ | — | Considered for Veo video delivery; Cloud CDN sufficient for now |
| Cloud Armor | ✅ | D21 | WAF + bot mgmt + DDoS |
| VPC (incl. VPC Service Controls + PSC) | ✅ | D20 | Perimeter; PSC for all GCP API calls from Agent Runtime |
| Cloud NAT | ✅ | D14 | RapidAPI egress with deterministic IPs |
| Cloud DNS | ✅ | D26 | `mcp.socialseed.ing` + Mission Control + region-specific names |
| Identity-Aware Proxy (IAP) | ✅ | D19 | Zero-trust gateway to internal services |
| Cloud Service Mesh | ✅ | D31 | mTLS + traffic policy across Agent Runtime + Cloud Run + GKE |
| Network Connectivity Center | ⬜ | — | Considered for hybrid; not needed (cloud-only) |

---

## 6. Security / IAM

| Service | Status | D-ID | Role |
|---|---|---|---|
| IAM | ✅ | D19 | Per-service + per-tenant binding |
| IAM Conditions | ✅ | D19 | Time-bound + IP-bound staff access |
| Workload Identity Federation | ✅ | D38 | GitHub Actions → GCP without service-account keys |
| Workforce Identity Federation | ✅ | D19 | Staff SSO via Google Workspace/Okta |
| Identity Platform | ✅ | D19 | Multi-tenant customer auth (OIDC/SAML/Google) |
| Secret Manager | ✅ | D20 | All credentials (RapidAPI, Gmail OAuth, external API keys) |
| Cloud KMS + Cloud HSM | ✅ | D20 | CMEK across all data stores; HSM optional for billing keys |
| Cloud EKM (External KMS) | ⬜ | — | Considered for compliance escalation; Customer-controlled HSM is plenty |
| Certificate Manager | ✅ | D13 | Managed TLS certs across regions |
| Confidential Computing (VM + GKE) | ✅ | D20 | PII workload isolation (compliance agent) |
| Binary Authorization | ✅ | D37 | Image-signing gate on Cloud Deploy |
| Security Command Center (Premium + AI Protection) | ✅ | D21, D32 | Threat detection (Agent Engine threat preview) |
| Sensitive Data Protection (DLP) | ✅ | D20, D33 | Inline log redaction + outbound output scan |
| Chronicle SecOps | ✅ | D32 | SIEM, Track 3 "Enterprise Standards" boost |
| Web Risk + reCAPTCHA Enterprise | 🟡 | — | Phase-2: bot detection on Mission Control login |

---

## 7. Observability

All ✅ per D31/D32:

| Service | D-ID | Role |
|---|---|---|
| Cloud Logging | D31 | Central log sink → DLP scan → BigQuery 90-day |
| Log Analytics | D31 | SQL queries over recent logs |
| Cloud Monitoring | D31, D32 | SLI/SLO + alerting + PagerDuty/Slack |
| Managed Service for Prometheus | D31 | Per-agent OTLP metrics |
| Managed Service for Grafana | D31 | Operator dashboards |
| Cloud Trace | D31 | Distributed trace from MC → Agent Gateway → Runtime → tools |
| Cloud Profiler | D31 | Cloud Run + Agent Runtime profiling |
| Error Reporting | D32 | Centralized exception aggregation |
| Cloud Audit Logs | D33 | 90-day → Chronicle |

---

## 8. DevOps / Integration

| Service | Status | D-ID | Role |
|---|---|---|---|
| Cloud Build | ✅ | D37 | Per-PR CI |
| Cloud Deploy | ✅ | D37 | Canary across Agent Runtime + Cloud Run + GKE |
| Artifact Registry | ✅ | D37 | Docker + npm + Python + Go + Maven |
| Artifact Analysis (SLSA + CVE scan) | ✅ | D37 | SLSA L3 attestation |
| Cloud Source Repositories | ❌ | — | End-of-sale 2024-06-17 |
| Cloud Workstations | ✅ | D38 | Per-engineer dev env (also: each Tier-3 worker agent uses one) |
| Gemini Code Assist Standard | ⬜ | — | Enterprise tier chosen |
| Gemini Code Assist Enterprise | ✅ | D39 | $45/seat/mo; "Built With" tag |
| Cloud Scheduler | ✅ | D18 | Nightly evals, simulation, license scan |
| Cloud Tasks | ✅ | D18 | Per-task retry queue for outreach send + carrier polling |
| Eventarc Advanced | ✅ | D18 | Bus + content-based routing + transformation |
| Application Integration | 🟡 | — | Phase-2: CRM-source integration (HubSpot, Salesforce) |
| Apigee X | ✅ | D28 | API monetization gateway for $0.01/view billing |
| Apigee API Hub | ✅ | D38 | OpenAPI + MCP spec catalog |
| API Gateway | ⬜ | — | Considered for cheap path; Apigee chosen since pricing + monetization needed |

---

## 9. Specialized AI

| Service | Status | D-ID | Role |
|---|---|---|---|
| Dialogflow CX | ✅ | D26 | In-app chat surface |
| Document AI | ✅ | D14 | Media-kit / contract parsing |
| Vision AI | ✅ | D23 | Brand logo / IP detection in content_verify |
| Imagen 4 | ✅ | D29 | Moodboard generation in creative agent |
| Veo 3 | ✅ | D29 | Sample video / shot list in creative agent |
| Lyria | ✅ | D29 | Background music suggestion in creative agent |
| Speech-to-Text | ✅ | D34 | TikTok video transcript for content_verify |
| Text-to-Speech | ✅ | D34 | Mobile PWA voice replies (a11y) |
| Translation API | ✅ | D34 | 4-locale runtime translation |
| Natural Language API | ⬜ | — | Considered for sentiment; Gemini 2.5 Flash classifier wins |
| Recommendations AI | 🟡 | — | Phase-2: brand → creator matchmaking recommendation engine |
| Healthcare NLP | — | — | Out of scope (no healthcare domain per D11) |

---

## 10. Firebase

| Service | Status | D-ID | Role |
|---|---|---|---|
| Firebase Hosting | ✅ | D26 | Static asset hosting (icons, public docs) |
| Firebase App Hosting | ✅ | D26 | Mission Control Next.js 16 SSR + GitHub-triggered deploys |
| Firebase Auth | 🔁 | D19 | Replaced by Identity Platform (upgrade path, no app-code change) |
| Cloud Functions 2nd gen (= Cloud Run functions) | ✅ | D26 | Firebase-triggered handlers (FCM webhook, image upload) |
| Firebase Genkit | ✅ | D35 | Mission Control TS-side RAG only (Genkit cannot reach Gemini Enterprise listing per GENKIT.md) |
| Firebase Studio | ❌ | — | Sunset 2026-06-22 registrations off |
| Firebase Data Connect / SQL Connect | 🟡 | — | Phase-2: realtime + offline sync layer for Mission Control |
| Firebase Cloud Messaging | ✅ | D26 | Mobile PWA push notifications |

---

## 11. Edge / Hybrid

| Service | Status | D-ID | Role |
|---|---|---|---|
| GDC Hosted | ⬜ | — | Considered for enterprise customers requesting private cloud; not day-1 |
| GDC Air-gapped | — | — | Out of scope (no air-gapped customer day-1) |
| Anthos (legacy brand) | ❌ | — | Consumed by GKE Enterprise + GDC; don't start new "Anthos" projects |

---

## 12. Justification for "Used" status

Per D23 ("all GCP services that aren't unnecessary"), every ✅ row above has a concrete D-ID. **Zero ✅ rows are unjustified.**

Per D23 inverse ("services that ARE unnecessary"), the ⬜/❌/🟡 rows have explicit reasons:
- ❌ = Google has marked deprecated/EOL/sunset
- 🔁 = Superseded by another GCP service we use
- ⬜ = Considered but a better-fit GCP service won
- 🟡 = Real value but blocks-day-1 dependency; phase-2 commitment

---

## 13. Resource provisioning checklist (Day-1 output)

When code starts, the following must exist (Terraform-managed; one module per category):

```
modules/
├── compute/        (Cloud Run × N, Agent Runtime endpoints × 3 regions)
├── data/           (Spanner instance, AlloyDB clusters × 3, Firestore DBs × 3, Vector Search indexes × 3)
├── networking/     (Global LB, Cloud Armor, VPC + PSC, Cloud DNS, Certificate Manager)
├── security/       (Identity Platform tenant template, KMS keyrings × 3, Secret Manager seeds, Model Armor templates, SCC enablement)
├── observability/  (Cloud Monitoring SLOs, Grafana dashboards, alerting policy, Chronicle export sink)
├── devops/         (Cloud Build triggers, Cloud Deploy pipelines, Artifact Registry repos, Binary Authorization policies)
├── ai/             (Agent Gateway config, Agent Registry seed, Agent Memory Bank, Agent Sessions, Vertex Vector Search indexes)
└── integration/    (Pub/Sub topics + subs + schemas, Cloud Tasks queues, Workflows definitions, Eventarc Advanced bus, Apigee proxies, API Hub catalog)
```

Total Terraform modules: **8**. Total estimated resource count at Day-1: **~140 resources**.

---

## 14. Cost envelope per D39 ($1,500 credits)

Headline (full detail in COST-PLAN.md, to be revised per D39):

| Phase | Span | Est. spend | Notes |
|---|---|---|---|
| Build phase (background agents + iterations) | Until Day-N (date-flexible per D7) | $300-500 | Heavy Gemini Pro use during agent porting + simulation runs |
| Pre-submission rehearsal | 1 week | $50-100 | 20+ full demo runs at $0.62/run + multiple 8× recordings |
| Judging window idle | 30 days | $150-250 | Memorystore + Memory Bank + AlloyDB always-on (24/7 idle = ~$5/day × 30) |
| Public Marketplace listing live demo | unbounded | $50-100/month | Per-view metering kicks revenue cycle in; should net positive |
| **Total budget** | 2-3 months | **~$700-1100** | Comfortably under $1,500; 1.4× headroom |

Per D39, the cost-saving levers in COST-PLAN.md §7 (Flash-routing-only, max_output caps, Pro-only-for-recording) are **softened**: Pro can be used for production roles during build, and full quality is the priority over savings.

---

## 15. Open service questions (deferred to background agents)

| # | Question | Owner |
|---|---|---|
| O-S1 | Does **Apigee X** in `asia-northeast3` support per-view billing meter usage? Or must we use US/EU Apigee with cross-region traffic? | Task #28 follow-up |
| O-S2 | Is **Spanner Graph** worth phase-1 inclusion for creator-brand match scoring (D24 says 0-to-1 hybrid)? | Background research |
| O-S3 | Can **Agent Gateway Private Preview** allowlist be applied for from Korea (legal entity)? | User to file request |
| O-S4 | What is the **Cloud Marketplace MCP-connector** listing category vs. Agent category — can `tiktok-mcp-server` dual-list? | Task #11 follow-up |
| O-S5 | **AP2 v0.2** has a 60+ payment-partner list (PROTOCOLS.md). Which ones support W3C VC + KRW + Korean entity? | Background research |

---

**End of inventory.** When this file is updated, append a row to [`DECISIONS.md`](DECISIONS.md) §8 change log.
