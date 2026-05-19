# Executive Summary — Google for Startups AI Agents Challenge

**Date**: 2026-05-19 · **Deadline**: 2026-06-05 (T-17 days) · **Status**: Research complete, ready to build

---

## The decision in one sentence

**Submit twice**: `social-seeding-v2` to Track 2 (Optimize) and `tiktok-mcp-server` to Track 3 (Refactor), with the Korean-legal-entity Marketplace-region gap reframed as an innovation contribution.

---

## Why dual submission (not one)

`social-seeding-platform` (the v1 production) is not an agent system by the challenge's definition — it has one hand-rolled ReAct loop on OpenAI with zero GCP services. Porting it whole to Track 3 is 6-8 weeks of work. Meanwhile:

- `social-seeding-v2` is **already** an agent-first system (11 Claude agents, Inngest durable workflows, 354 tests, a verified live demo from 2026-05-14 with real Gmail). Track 2 = "optimize existing prototype" describes it precisely.
- `microservices/tiktok-mcp-server` is **already** a production-running public MCP server at `mcp.socialseed.ing` with a clear refactor path to Marketplace-listable.

Two complete submissions for ~3.5 weeks of focused work, vs. one expensive submission with poor track-fit.

---

## The Korea region problem (turning a bug into a feature)

Google Cloud Marketplace Partner payment regions exclude Korea. A direct listing is impossible without a foreign sub-entity (4-12 weeks to set up). **Decision (D3)**: reframe the gap as the contribution — *"A2A-only distribution path for non-Marketplace-region startups"*. This is a real category of pain (Korean, Vietnamese, Brazilian, etc. AI startups all face it), and presenting a working alternative is judge-respectable in the Innovation 20% bucket.

---

## The numbers

| Metric | Value | Source |
|---|---|---|
| GCP credits committed | $150 of $500 (3.3× safety buffer) | [COST-PLAN](cost-planning/COST-PLAN.md) |
| Cost per demo run (v2 Track 2) | $0.62 | [COST-PLAN](cost-planning/COST-PLAN.md) §4 |
| Cost per demo run (MCP Track 3) | $0.005 | [COST-PLAN](cost-planning/COST-PLAN.md) §4 |
| Cost reduction vs current Claude stack | 8× | [PORTING-V2](porting-v2/PORTING-V2.md) §8 |
| Engineer-days to ship Track 2 | 11 + 2 slack | [PORTING-V2](porting-v2/PORTING-V2.md) §9 |
| Engineer-days to ship Track 3 | 9 + 2 Marketplace buffer | [REFACTOR-MCP](refactor-mcp/REFACTOR-MCP.md) §8 |
| Research deliverable | 17 docs, ~104,000 words | This index |

---

## Top 5 risks (with mitigation owners)

1. 🔴 **KR-region Marketplace gap** — mitigated by D3 (disclosure + reframe). Owner: write-up author. No code change.
2. 🔴 **Watchtower `:latest` auto-revert** on Hetzner once Cloud Run cutover starts — mitigated by Day-1 pause. Owner: Engineer.
3. 🟡 **Agent Gateway is Private Preview** — mitigated by Devpost disclosure. Acceptable for Track 3.
4. 🟡 **MCP session affinity on Cloud Run** is the hardest unsolved infra problem — mitigated by `sessionAffinity: "true"` + Memorystore Redis. Owner: Engineer.
5. 🟡 **better-sqlite3 OAuth auto-approves unknown clients** (`auth/oauth.ts:111`) — Marketplace flag. Mitigated by Identity Platform migration on Day 8.

---

## What's done (this research pass)

17 documents at `~/Documents/GitHub/social-seeding-v2/gcp-research/`:

```
INDEX.md                           ← reading order + decisions of record
EXECUTION-CALENDAR.md              ← Day 1 → Day 17 with hour budgets
EXECUTIVE-SUMMARY.md (this file)
platform-audit/AUDIT.md            ← why v2+MCP, not platform
track-rules/CHALLENGE-RULES.md     ← rules + 10 GAPs to confirm in Devpost
compute/COMPUTE.md                 ← Cloud Run / GKE / Agent Engine deep dive
ai-agents/AI-AGENTS.md             ← Agent Platform 4-pillar reference
data/DATA.md                       ← Firestore / BQ / AlloyDB / Pub/Sub
network-security/NETSEC.md         ← IAM / Identity Platform / Model Armor / VPC-SC
devops/DEVOPS.md                   ← Cloud Build / Artifact Registry / Firebase App Hosting
submission-playbook/TRACK3-PLAYBOOK.md  ← 7 phases × 17 days
protocols/PROTOCOLS.md             ← A2A v0.3 + AP2 v0.2 + agent.json
refactor-mcp/REFACTOR-MCP.md       ← file-level MCP refactor plan
model-armor/ARMOR-GATEWAY.md       ← Track 3 mandatory hardening
porting-v2/PORTING-V2.md           ← Claude SDK → ADK + Gemini mapping
adk-deep/ADK-GUIDE.md              ← ADK 2.0 Beta language reference
genkit-deep/GENKIT.md              ← TS-side RAG (Mission Control only)
gemini-models/GEMINI-MODELS.md     ← model selection per agent role
demo-deliverables/SUBMISSION-PACKAGE.md ← demo video script + Devpost writeup
cost-planning/COST-PLAN.md         ← $150 of $500 + budget tripwires
```

---

## What's next (operator decisions for Day 1)

1. **Confirm GCP project IDs** for both streams (suggest `ss-v2-prod` and `ss-mcp-prod`)
2. **Activate $500 credits** on both projects
3. **Open Devpost gated invite** and confirm the 10 remaining GAPs:
   - Per-track prize split
   - Country eligibility (any KR restrictions?)
   - Max team size
   - "Existing prototype" cut-off date for Track 2
   - Demo video length cap (assume 3 min until confirmed)
   - Architecture-diagram requirement
   - License requirement (assume OSI)
   - Repo visibility policy
   - Multi-track submission rules
   - IP / license grant clauses
4. **Confirm `.env.test`** is wired at a non-prod Atlas database (workspace landmine)
5. **Pause Watchtower** on Hetzner for `mcp.socialseed.ing` (prevent Cloud Run cutover regression)

Once those 5 are confirmed, Day 2 (agent porting) starts.

---

**Open [`INDEX.md`](INDEX.md)** for the full reading order and document catalog, or **[`EXECUTION-CALENDAR.md`](EXECUTION-CALENDAR.md)** for the day-by-day plan.
