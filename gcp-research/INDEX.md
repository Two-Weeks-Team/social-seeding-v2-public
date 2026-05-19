# Google for Startups AI Agents Challenge — Research Index

**Workspace**: `/Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/`
**Research date**: 2026-05-19
**Deadline**: 2026-06-05 (T-17 days)
**Total deliverable**: 17 documents, ~104,000 words, all cited to `cloud.google.com` / `docs.cloud.google.com` / official protocol sites

---

## 0. Decisions of record (committed)

| # | Decision | Rationale | Source |
|---|---|---|---|
| D1 | **Dual submission**: v2 → Track 2 (Optimize), tiktok-mcp-server → Track 3 (Refactor) | v2 is genuinely agent-first (11 agents, 354 tests, live demo); platform is a tool dashboard. Splitting plays to each repo's actual nature. | [AUDIT.md](platform-audit/AUDIT.md) §6 |
| D2 | **Korean legal entity** — Marketplace direct listing not supported by region | Producer Portal payment regions exclude KR. EU-15 + US + CA + JP + HK + IN + IL + SA only. | [TRACK3-PLAYBOOK.md](submission-playbook/TRACK3-PLAYBOOK.md) Phase 1.1 |
| D3 | **Reframe listing-gap as innovation** in Devpost write-up | Honest disclosure of KR-region constraint + "A2A-only distribution path for non-Marketplace-region startups" as a contribution. | User decision 2026-05-19 |
| D4 | **Keep Inngest** durable orchestration for v2 (do NOT port to Workflows / Agent Runtime) | 14-day timeouts (`creator-track.ts:142-143`) + correlation-by-`if` pattern; Inngest is the right primitive. Re-framed as "kept the right tools where they were right". | [PORTING-V2.md](porting-v2/PORTING-V2.md) §6 |
| D5 | **Model strategy**: Gemini 2.5 Pro for judgment, 2.5 Flash for bulk, 2.5 Flash-Lite for classification | 3.x is Preview-only, can't be SFT'd, rate card lock 2026-07-01. 2.5 family GA + 14× cheaper than current Claude Opus + Haiku mix. | [GEMINI-MODELS.md](gemini-models/GEMINI-MODELS.md) §4 + [COST-PLAN.md](cost-planning/COST-PLAN.md) §3 |
| D6 | **Devpost gated invite registration already complete** (user) | Remaining 10 GAPs (per-track prize split, video length cap, team size, etc.) confirmable inside Devpost console pre-submission. | User decision 2026-05-19 |

---

## 1. Reading order (by audience)

### For the decision-maker (skim, 15 min)
1. This `INDEX.md`
2. [`CHALLENGE-RULES.md`](track-rules/CHALLENGE-RULES.md) — deadline, weights, eligibility, the 10 GAPs
3. [`AUDIT.md`](platform-audit/AUDIT.md) — why dual submission, not platform-only
4. [`EXECUTION-CALENDAR.md`](EXECUTION-CALENDAR.md) — Day 1 → Day 17
5. [`COST-PLAN.md`](cost-planning/COST-PLAN.md) §1 (the $150 / $500 headline)

### For the v2 Track 2 engineer
1. [`PORTING-V2.md`](porting-v2/PORTING-V2.md) — Claude SDK → ADK + Gemini mapping
2. [`ADK-GUIDE.md`](adk-deep/ADK-GUIDE.md) — language/runtime reference
3. [`GEMINI-MODELS.md`](gemini-models/GEMINI-MODELS.md) — per-agent model picks
4. [`ARMOR-GATEWAY.md`](model-armor/ARMOR-GATEWAY.md) — Track-2 nice-to-have, Track-3 mandatory
5. [`AI-AGENTS.md`](ai-agents/AI-AGENTS.md) — Agent Runtime / Memory Bank / Observability deep dive
6. [`COMPUTE.md`](compute/COMPUTE.md) — Cloud Run vs Agent Engine vs GKE
7. [`DATA.md`](data/DATA.md) — Mongo Atlas keep vs migrate decision
8. [`SUBMISSION-PACKAGE.md`](demo-deliverables/SUBMISSION-PACKAGE.md) — Devpost writeup + demo video

### For the tiktok-mcp-server Track 3 engineer
1. [`REFACTOR-MCP.md`](refactor-mcp/REFACTOR-MCP.md) — file-level refactor plan with 120-line ADK wrapper + Dockerfile + cloudbuild.yaml
2. [`TRACK3-PLAYBOOK.md`](submission-playbook/TRACK3-PLAYBOOK.md) — 7-phase submission flow
3. [`PROTOCOLS.md`](protocols/PROTOCOLS.md) — A2A v0.3 + AP2 v0.2 + agent.json schemas
4. [`ARMOR-GATEWAY.md`](model-armor/ARMOR-GATEWAY.md) — MANDATORY for Track 3 enterprise designation
5. [`NETSEC.md`](network-security/NETSEC.md) §1.1 — Identity Platform migration for OAuth
6. [`DEVOPS.md`](devops/DEVOPS.md) — Cloud Build + Artifact Registry + Cloud Deploy pipeline

### For the cross-cutting concerns
- Genkit consideration (TS-side Mission Control RAG): [`GENKIT.md`](genkit-deep/GENKIT.md)
- Budget enforcement: [`COST-PLAN.md`](cost-planning/COST-PLAN.md) §6 (gcloud billing budgets + 95% Pub/Sub killswitch)

---

## 2. Document catalog (17 files, ~104k words)

### Foundational (4 docs, ~25k words)
| Doc | Words | Status | Key finding |
|---|---|---|---|
| [`platform-audit/AUDIT.md`](platform-audit/AUDIT.md) | ~3,500 | ✅ | platform = tool dashboard, not agent system. v2 + MCP dual submission |
| [`track-rules/CHALLENGE-RULES.md`](track-rules/CHALLENGE-RULES.md) | ~3,800 | ✅ | Deadline 6/5, $90K pool, $500 credits, Tech30/Biz30/Innov20/Demo20 |
| [`compute/COMPUTE.md`](compute/COMPUTE.md) | 6,075 | ✅ | Cloud Run worker pools GA 2026-04-14, decision tree at end |
| [`ai-agents/AI-AGENTS.md`](ai-agents/AI-AGENTS.md) | 6,859 | ✅ | Build/Scale/Govern/Optimize 4-pillar, Track 3 listing curl included |

### Data / Network / DevOps (3 docs, ~27.5k words)
| Doc | Words | Status | Key finding |
|---|---|---|---|
| [`data/DATA.md`](data/DATA.md) | 8,800 | ✅ | Memory Bank backend = Firestore Native confirmed. Pub/Sub Lite turndown 6/30. Dataplex → Knowledge Catalog rename |
| [`network-security/NETSEC.md`](network-security/NETSEC.md) | 10,200 | ✅ | Model Armor ≠ Cloud Armor. SCC AI Protection GA, Agent Engine Threat Detection Preview |
| [`devops/DEVOPS.md`](devops/DEVOPS.md) | 8,540 | ✅ | Genkit vs ADK matrix. Cloud Source Repos End-of-Sale. Firebase Studio sunset |

### Track 3 specifics (4 docs, ~24k words)
| Doc | Words | Status | Key finding |
|---|---|---|---|
| [`submission-playbook/TRACK3-PLAYBOOK.md`](submission-playbook/TRACK3-PLAYBOOK.md) | ~6,500 | ✅ | 7 phases × 17 days. **KR region not in payment list** flagged Day 1 |
| [`protocols/PROTOCOLS.md`](protocols/PROTOCOLS.md) | 6,001 | ✅ | A2A v0.3 + AP2 v0.2 (Intent/Cart/Payment) + 2 sample `agent.json`. `gcloud agents validate` doesn't exist |
| [`refactor-mcp/REFACTOR-MCP.md`](refactor-mcp/REFACTOR-MCP.md) | 5,920 | ✅ | 120-line ADK wrapper + Identity Platform migration (~60 lines). MCP session affinity is hardest infra problem |
| [`model-armor/ARMOR-GATEWAY.md`](model-armor/ARMOR-GATEWAY.md) | 5,893 | ✅ | Model Armor 2M tokens free / $0.10M. **Agent Gateway Private Preview** — Track 3 disclosure needed |

### Track 2 specifics + tooling (5 docs, ~28.5k words)
| Doc | Words | Status | Key finding |
|---|---|---|---|
| [`porting-v2/PORTING-V2.md`](porting-v2/PORTING-V2.md) | 7,200 | ✅ | 14-row mapping + 130-line runnable `outreach_writer/agent.py`. 11+2 days. 8× cost reduction |
| [`adk-deep/ADK-GUIDE.md`](adk-deep/ADK-GUIDE.md) | 5,900 | ✅ | ADK 2.0 Beta Python-only graph runtime; TS 1.0 GA stays on 1.x model. 200-line working sample |
| [`genkit-deep/GENKIT.md`](genkit-deep/GENKIT.md) | 4,532 | ✅ | `@genkit-ai/vertexai` → `@genkit-ai/google-genai`. No A2A native export. ADK preferred for Gemini Enterprise listing |
| [`gemini-models/GEMINI-MODELS.md`](gemini-models/GEMINI-MODELS.md) | 5,400 | ✅ | Gemini 3 Ultra GA SKU doesn't exist (3.1 Ultra Preview). Stay on 2.5 family for demo |
| [`demo-deliverables/SUBMISSION-PACKAGE.md`](demo-deliverables/SUBMISSION-PACKAGE.md) | 5,241 | ✅ | Demo+Biz = 50% of score. Inngest-stays-put as innovation point. 6-beat × 30s video script |

### Cost (1 doc, ~5k words)
| Doc | Words | Status | Key finding |
|---|---|---|---|
| [`cost-planning/COST-PLAN.md`](cost-planning/COST-PLAN.md) | 4,841 | ✅ | $150 / $500 (3.3× safety). v2 demo $0.62, MCP demo $0.005. 95% Pub/Sub killswitch pattern |

---

## 3. Critical risks to monitor

| Risk | Severity | Where addressed | Mitigation deadline |
|---|---|---|---|
| **KR legal entity** can't list on Marketplace | 🔴 Blocking | TRACK3-PLAYBOOK §1.1 | Day 1 — decision made: reframe as innovation |
| **Watchtower `:latest` auto-deploy** on Hetzner reverts public MCP endpoint | 🔴 Blocking | REFACTOR-MCP §9.1 | Day 7 — must pause Watchtower BEFORE Cloud Run cutover |
| **Agent Gateway is Private Preview** as of May 2026 | 🟡 Disclosable | ARMOR-GATEWAY §2 | Day 13 — disclose in Devpost write-up |
| **MCP session affinity** on Cloud Run (in-memory per session) | 🟡 Tech | REFACTOR-MCP §9.5 | Day 10 — `sessionAffinity: "true"` + Memorystore Redis fallback |
| **Mongo Atlas .env.test points at prod DB** (workspace landmine) | 🟡 Process | AUDIT §5 | Day 1 — confirm separate `social_seeding_test` DB |
| **Memorystore can't scale to zero** ($36/mo) | 🟢 Cost | COST-PLAN §3 | Judging week — turn down between demo recordings |
| **`grpc v1.80.0` CVE GO-2026-4762** in social-seeding-backend | 🟡 Security | AUDIT §5 | Pre-demo — patch to v1.81.0 |
| **better-sqlite3 OAuth auto-approves unknown clients** (auth/oauth.ts:111) | 🔴 Marketplace flag | REFACTOR-MCP §4 | Day 8 — Identity Platform migration |

---

## 4. Two parallel work streams

### Stream A: v2 → Track 2 (Optimize Existing Agents)
**Repo**: `social-seeding-v2`
**Effort**: ~11 days + 2 days slack
**Lead deliverable**: 11 Claude agents ported to ADK + Gemini 2.5, deployed to Cloud Run + Agent Engine, with Agent Observability + Eval + Model Armor + Memory Bank, live demo on real Gmail.
**Cost**: ~$70 dev + ~$60 judging = ~$130
**Devpost angle**: "8× cost reduction, kept Inngest where it was right, added enterprise-grade observability + evals"

### Stream B: tiktok-mcp-server → Track 3 (Refactor)
**Repo**: `social-seeding-platform/microservices/tiktok-mcp-server` (independent submodule)
**Effort**: ~9 days + 2 days Marketplace buffer
**Lead deliverable**: ADK orchestration agent wrapping 4 MCP tools, Identity Platform OAuth, Cloud Run multi-container deploy, agent.json + Producer Portal submission (PENDING_REVIEW status as evidence), Model Armor + Agent Gateway (Private Preview disclosure).
**Cost**: ~$20 dev + ~$0 judging = ~$20
**Devpost angle**: "A2A-only distribution path for non-Marketplace-region startups — the listing-gap is the contribution"

Both streams can run in parallel from Day 2 if there are two engineers. See [`EXECUTION-CALENDAR.md`](EXECUTION-CALENDAR.md) for the day-by-day breakdown that assumes a single engineer interleaving.

---

## 5. What's NOT in this research pass

Deliberately deferred to the build phase, not the research phase:
- Real Identity Platform tenant setup (needs GCP project + billing live)
- Real Marketplace Producer Portal application (needs corporate entity decision per D2/D3)
- Real Gemini API smoke test (needs $500 credit activation)
- Real demo video recording (Day 14-15 of calendar)
- The 10 Devpost GAPs from `CHALLENGE-RULES.md` §12 (need user to read post-invitation-accept)

---

## 6. Where to commit these docs

These 17 docs sit in `social-seeding-v2/gcp-research/` for now. Suggested final placement:

- **Track 2 submission repo (= social-seeding-v2)**: keep `gcp-research/porting-v2/`, `adk-deep/`, `gemini-models/`, `cost-planning/`, `demo-deliverables/`, `model-armor/`, `compute/`, `ai-agents/`, `data/`, `network-security/`, `devops/`, `genkit-deep/`, `track-rules/`. These are the engineering bible for v2's Gemini migration.
- **Track 3 submission repo (= microservices/tiktok-mcp-server)**: copy `refactor-mcp/REFACTOR-MCP.md`, `submission-playbook/TRACK3-PLAYBOOK.md`, `protocols/PROTOCOLS.md`, `model-armor/ARMOR-GATEWAY.md` (also relevant), `cost-planning/COST-PLAN.md` (also relevant).
- **Internal-only (not in submission repos)**: `platform-audit/AUDIT.md` (it contains code citations from across the umbrella that judges don't need to see).

---

**Next step**: open [`EXECUTION-CALENDAR.md`](EXECUTION-CALENDAR.md) for the 17-day plan.
