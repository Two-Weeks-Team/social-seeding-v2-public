# 17-Day Execution Calendar — Google for Startups AI Agents Challenge

**Today**: 2026-05-19 (Mon)
**Deadline**: 2026-06-05 11:59 PM Pacific Time
**Strategy**: Dual submission — v2 → Track 2 + tiktok-mcp-server → Track 3 (D1, INDEX §0)

> **Assumption**: 1 senior engineer interleaving both streams. With 2 engineers, Stream A and Stream B run in parallel and overall delivery slides from Day 17 to ~Day 11.

> **Pacific Time deadline = 6/6 15:59 KST**. Plan submits at **Day 17 morning KST (6/4)** to leave ~12 h buffer.

---

## Macro view

```
Week 1 (5/19 – 5/25): Stream A — port v2 agents to ADK + Gemini
Week 2 (5/26 – 6/1):  Stream B — refactor tiktok-mcp-server + Track 3 phase work
Week 3 (6/2 – 6/4):   Demo recording, Devpost write-up, final submit
Buffer (6/5):         Standby for last-minute fixes
```

---

## Day 1 — Mon 2026-05-19 (TODAY)

**Goal**: GCP project alive, budget tripwire armed, all GAPs from Devpost confirmed.

| Task | Owner | Deliverable |
|---|---|---|
| Confirm GCP project IDs (one per stream — e.g. `ss-v2-prod`, `ss-mcp-prod`) | User | Project IDs |
| Enable required APIs: `aiplatform`, `discoveryengine`, `agentplatform`, `modelarmor`, `run`, `cloudbuild`, `artifactregistry`, `cloudkms`, `identitytoolkit`, `secretmanager`, `monitoring`, `logging`, `cloudtrace` | Engineer | `gcloud services enable …` output |
| Activate $500 credits on both projects | User | Billing confirmation |
| Create budget + 9-threshold alerts + 95% killswitch (COST-PLAN §6) | Engineer | `gcloud billing budgets create …` |
| **Open Devpost gated invite, screenshot the 10 GAP fields** (CHALLENGE-RULES §12) — team-size limit, video length, license, repo policy | User | `track-rules/DEVPOST-RULES-CONFIRMED.md` |
| Confirm `.env.test` points at non-prod DB (workspace landmine) | Engineer | Smoke test against test Atlas cluster |
| Create dedicated branches: `ss-v2-track2`, `ss-mcp-track3` on respective repos | Engineer | Branch heads |
| Stop Watchtower on Hetzner for `mcp.socialseed.ing` (prevent `:latest` auto-rollback once Cloud Run cutover starts) | Engineer | Watchtower paused |

**Exit criteria**: Both projects live, budget alerts armed, Devpost confirmed, both branches checked out.

---

## Day 2 — Tue 2026-05-20

**Stream A start.**

| Task | Hours | Deliverable |
|---|---|---|
| Install ADK 2.0 Beta + Vertex AI SDK in a new `packages/agents-adk/` subdir of v2 | 1 | `pip install google-adk --pre` clean |
| `agents-cli create` scaffold + smoke "hello agent" against Gemini 2.5 Pro on Vertex | 1 | `agents-cli playground` reachable |
| Port **outreach-writer.agent.ts → outreach_writer/agent.py** using PORTING-V2 §5 (the 130-line template) | 4 | `agent.py` + `tournament.py` + Pydantic outputs |
| `adk eval` against 3-5 golden outreach examples extracted from v2's existing eval set | 2 | `outreach_writer.evalset.json` passing |

**Exit**: 1 of 11 agents ported + evaluated.

---

## Day 3 — Wed 2026-05-21

**Stream A continues.**

| Task | Hours | Deliverable |
|---|---|---|
| Port **sourcing.agent.ts → sourcing/agent.py** (use ADK-GUIDE §10 TikTok sourcing template) | 4 | `sourcing/agent.py` |
| Port **vetting.agent.ts → vetting/agent.py** (fan-out pattern) | 3 | `vetting/agent.py` with `ParallelAgent` |
| `adk eval` for both | 1 | 2 more `.evalset.json` |

**Exit**: 3 of 11 agents ported.

---

## Day 4 — Thu 2026-05-22

**Stream A continues.**

| Task | Hours | Deliverable |
|---|---|---|
| Port **conversation.agent.ts → conversation/agent.py** (classifier, Gemini 2.5 Flash-Lite) | 2 | `conversation/agent.py` |
| Port **conversation-responder.agent.ts** (responder) | 2 | `responder/agent.py` |
| Port **logistics.agent.ts** (address parsing, Flash) | 2 | `logistics/agent.py` |
| `adk eval` for all 3 | 1 | 3 more `.evalset.json` |

**Exit**: 6 of 11 agents ported.

---

## Day 5 — Fri 2026-05-23

**Stream A continues + observability wiring.**

| Task | Hours | Deliverable |
|---|---|---|
| Port **content-verify.agent.ts** (Flash multimodal) | 2 | `content_verify/agent.py` |
| Port **analyst.agent.ts** (Pro, final report) | 2 | `analyst/agent.py` |
| Port **research.agent.ts + intake.agent.ts + lead-outreach-writer.agent.ts** (remaining 3) | 3 | All 11 done |
| Wire **Agent Observability** to all agents (PORTING-V2 §3 architecture) | 1 | Traces visible in Cloud Trace |

**Exit**: 11 of 11 agents ported. Observability live.

---

## Day 6 — Sat 2026-05-24

**BUFFER DAY.** Catch-up on agent eval misses, prep Stream B environment.

| Task | Hours | Deliverable |
|---|---|---|
| Catch up on any failed evals from Days 2-5 | 4 | All 11 evalsets passing |
| Initialize Stream B GCP project (Identity Platform tenant, Artifact Registry repo, Cloud Build trigger) | 2 | Stream B infra live |

---

## Day 7 — Sun 2026-05-25

**Stream B start.**

| Task | Hours | Deliverable |
|---|---|---|
| Read REFACTOR-MCP §3 + extract the 120-line ADK orchestration wrapper into `microservices/tiktok-mcp-server/agent/` | 3 | `agent/main.py` |
| Build multi-target Dockerfile (Node MCP + Python ADK in one Cloud Run multi-container) — copy from REFACTOR-MCP §3 | 2 | `Dockerfile` |
| Local smoke: ADK wrapper calls MCP tools end-to-end | 2 | `curl localhost:8080/agent` returns ranked creators |

**Exit**: ADK wrapper working locally.

---

## Day 8 — Mon 2026-05-26

**Stream B: auth migration + Model Armor.**

| Task | Hours | Deliverable |
|---|---|---|
| Implement `src/auth/identity-platform.ts` (~60 lines per REFACTOR-MCP §4) replacing better-sqlite3 OAuth | 3 | `identity-platform.ts` |
| 1-line swap at `src/transport/streamable-http.ts:59` | 0.5 | Identity Platform live in dev |
| Wire **Model Armor** with `ss-input` (block PII + PI+JB MEDIUM) and `ss-output` (sanitize PII, RAI HIGH) templates per ARMOR-GATEWAY §1.7 | 2 | Model Armor policies live |
| Apply Terraform module from ARMOR-GATEWAY §5 (`modules/agent-armor/`) | 2 | Terraform apply clean |

**Exit**: Identity Platform + Model Armor wired.

---

## Day 9 — Tue 2026-05-27

**Stream B: Agent Gateway (Private Preview) + audit.**

| Task | Hours | Deliverable |
|---|---|---|
| Set up Agent Gateway with `CLIENT_TO_AGENT` (ingress) + `AGENT_TO_ANYWHERE` (egress) per ARMOR-GATEWAY §2 | 3 | Gateway routes traffic |
| Wire IAP + MA `CONTENT_AUTHZ` extension + CEL-based rate limit | 2 | Authz extensions live |
| Cloud Audit Logs → BigQuery sink with 365-day retention | 1 | Audit trail visible |
| Smoke: Agent Gateway routes a vetting agent call through Atlas MCP + TikTok scraper + Gmail send | 2 | End-to-end trace clean |

**Exit**: Agent Gateway live (Private Preview disclosure in Devpost ready).

---

## Day 10 — Wed 2026-05-28

**Stream B: Cloud Run deploy + DNS cutover.**

| Task | Hours | Deliverable |
|---|---|---|
| `gcloud builds submit` build via Cloud Build | 1 | Image in Artifact Registry |
| `gcloud run deploy` with `sessionAffinity: "true"` (REFACTOR-MCP §9.5) | 1 | Cloud Run service live |
| **DNS cutover**: `mcp.socialseed.ing` CNAME → Cloud Run domain mapping | 1 | DNS propagated |
| Verify Watchtower stays paused (Day 1 task) | 0.5 | Hetzner container not auto-replaced |
| Memorystore Redis fallback for cross-instance session state | 2 | Multi-instance smoke clean |
| End-to-end test on production DNS | 2 | `mcp.socialseed.ing/agent` returns ranked creators |

**Exit**: Track 3 agent live at production DNS.

---

## Day 11 — Thu 2026-05-29

**Stream B: Marketplace + Stream A: Memory Bank for v2.**

| Task | Hours | Deliverable |
|---|---|---|
| **Stream B**: Producer Portal application submitted with KR-region disclosure (TRACK3-PLAYBOOK §1.1) | 2 | Producer Portal account: `PENDING` |
| **Stream B**: Generate signed `agent.json` agent card (PROTOCOLS §3 sample 1) + publish to `/.well-known/agent.json` | 2 | `agent.json` reachable |
| **Stream B**: Register A2A agent via Discovery Engine REST (TRACK3-PLAYBOOK Phase 4.3) | 1 | Agent in Agent Registry |
| **Stream A**: Wire Agent Memory Bank to v2's conversation/responder agents (AI-AGENTS §13) | 2 | Memory Bank events flowing |
| **Stream A**: Wire Agent Evaluation suite — port v2's 30 highest-signal vitest cases to `.evalset.json` (PORTING-V2 §7) | 2 | `adk eval` passes |

**Exit**: Track 3 listing in PENDING_REVIEW. Track 2 has Memory Bank + Eval live.

---

## Day 12 — Fri 2026-05-30

**Stream A: deploy v2 to Cloud Run + Agent Engine.**

| Task | Hours | Deliverable |
|---|---|---|
| Deploy Mission Control (Next.js) to Firebase App Hosting (DEVOPS §C) | 2 | Mission Control live on `*.web.app` |
| Deploy 11 ADK agents to Vertex AI Agent Engine (`adk deploy agent_engine`) | 3 | All 11 agents reachable |
| Keep Inngest as-is (D4) — point at Cloud Run service URLs for agent invocation | 1 | Inngest workflow hits new agents |
| End-to-end smoke: brand brief → real Gmail send (the 2026-05-14 demo equivalent) | 2 | Full loop passes |

**Exit**: Track 2 system fully on GCP. Ready for demo recording.

---

## Day 13 — Sat 2026-05-31

**Eval gauntlet: 4-step Google Cloud Ready evaluation pass 1.**

| Task | Hours | Deliverable |
|---|---|---|
| **Track 3** Basic Functionality test (TRACK3-PLAYBOOK Phase 5.1): 5 representative queries through agent | 2 | All 5 pass |
| **Track 3** Output Accuracy test (Phase 5.2): regression suite, ≥90% accuracy | 2 | Score recorded |
| **Track 3** Autonomous Execution test (Phase 5.3): multi-step task without human input | 2 | Pass evidence |
| **Track 3** Enterprise Standards checklist (Phase 5.4): Model Armor on, Audit logs, IAM, encryption, Identity Platform — screenshot evidence for each | 2 | Checklist 9/9 |

**Exit**: 4-step eval baseline captured.

---

## Day 14 — Sun 2026-06-01

**Eval gauntlet pass 2 + demo recording prep.**

| Task | Hours | Deliverable |
|---|---|---|
| Fix any 4-step eval failures from Day 13 | 3 | All 4 steps pass |
| Record **Track 2 demo video** (Stream A) — 6-beat × 30s per SUBMISSION-PACKAGE §1: hook → architecture → live agent run (real Gmail) → cost reduction → innovation → CTA | 3 | `v2-demo.mp4` |
| Architecture diagram (Mermaid + PNG) for Track 2 | 2 | `v2-architecture.png` |

**Exit**: Track 2 demo recorded.

---

## Day 15 — Mon 2026-06-02

**Track 3 demo recording + KR-region innovation framing.**

| Task | Hours | Deliverable |
|---|---|---|
| Record **Track 3 demo video** — 6-beat × 30s per SUBMISSION-PACKAGE §1: hook (KR startup distribution gap) → architecture → live MCP-via-A2A demo → Marketplace pending screenshot → "A2A-only path" innovation framing → CTA | 3 | `mcp-demo.mp4` |
| Architecture diagram for Track 3 | 1 | `mcp-architecture.png` |
| Draft Devpost write-ups (both submissions) using SUBMISSION-PACKAGE §3-4 templates | 4 | `devpost-v2.md`, `devpost-mcp.md` |

**Exit**: Both demos recorded + Devpost drafts ready.

---

## Day 16 — Tue 2026-06-03

**Polish + iterate based on internal review.**

| Task | Hours | Deliverable |
|---|---|---|
| Internal review of both demo videos — re-record if any beat is weak | 3 | Final `.mp4` |
| Polish Devpost write-ups: Inspiration, What It Does, How We Built It, Challenges, Accomplishments, What We Learned, What's Next, Built With tags | 3 | Final write-ups |
| Public-ify both repos with LICENSE (assumed OSI per Rapid Agent precedent) | 1 | LICENSE files committed |
| README.md polish on both repos (judge-facing) | 2 | Reproduce-in-5-min instructions |

**Exit**: Submission package complete.

---

## Day 17 — Wed 2026-06-04

**Final submit (KST morning) + buffer for Pacific deadline.**

| Task | Hours | Deliverable |
|---|---|---|
| Final smoke test on both production deployments | 1 | Both endpoints green |
| Capture Producer Portal `PENDING_REVIEW` screenshot (Track 3 evidence) | 0.5 | Screenshot saved |
| **Submit Track 2** on Devpost with v2 repo + demo URL + write-up | 1 | Submission ID |
| **Submit Track 3** on Devpost with MCP repo + demo URL + write-up | 1 | Submission ID |
| Confirm both submissions received | 0.5 | Devpost confirmation emails |

**Exit**: BOTH submissions live. ~36 hours of buffer until Pacific deadline.

---

## Day 18 — Thu 2026-06-05

**STANDBY**. Pacific deadline at 11:59 PM PT = 6/6 15:59 KST.

| Task | Hours | Deliverable |
|---|---|---|
| Monitor for any Devpost issues with submission | varies | — |
| Final budget check (should be < $200 of $500) | 0.5 | Spend confirmed |
| If anything fails: re-submit (Devpost typically allows edits until deadline) | varies | — |

---

## Critical path

Day 1 (project setup) → Day 2-5 (agent porting Stream A) → Day 7-10 (refactor Stream B) → Day 11 (Marketplace submit + Track 2 polish) → Day 12 (deploy) → Day 13-14 (eval + demo) → Day 15-16 (polish) → Day 17 (submit).

**Day 6 is the only slack day**. Lose more than 1 day on Days 2-5 (agent porting) and Day 6 becomes work, not slack.

## Daily standup template

Every day at end-of-day, capture in a `progress/dayXX.md` file:
1. Tasks completed today (with file:line references)
2. Tasks blocked + why
3. Tomorrow's #1 task
4. Spend YTD vs budget
5. Critical-path risk update

## Escalation rules

| Trigger | Action |
|---|---|
| Day 5 EOD with <8 agents ported | Cut research/intake/lead-outreach agents (lowest-signal 3) — keep only the 8 core. Update Devpost description accordingly. |
| Day 10 EOD with Cloud Run cutover not done | Park Stream B at "ADK wrapper local" + submit Track 3 as "code complete, deployment pending" — judges accept this if write-up is honest |
| Spend exceeds $300 of $500 by Day 12 | Trigger killswitch, switch all dev calls to Gemini 2.5 Flash, postpone Pro for final recording only |
| Producer Portal application rejected for KR region | Already mitigated by D3 (reframe-as-innovation). Update write-up, no work change. |
| Demo video re-record needed after Day 16 | Cut to a 90-second variant on Day 17 morning rather than skipping submission |

---

## What's submitted

### Track 2 Submission (Devpost)
- Repo: `social-seeding-v2` (public, OSI license)
- Demo video: 3-min YouTube unlisted
- Hosted endpoint: Mission Control on Firebase App Hosting
- Architecture diagram: PNG + Mermaid source
- Devpost long-form write-up: Inspiration / What it does / How we built it / Challenges / Accomplishments / What we learned / What's next / Built With
- Built With tags: ADK 2.0 Beta, Vertex AI, Gemini 2.5 Pro/Flash, Cloud Run, Agent Engine, Agent Observability, Agent Evaluation, Memory Bank, Model Armor, Firebase App Hosting, Mongo Atlas, Inngest

### Track 3 Submission (Devpost)
- Repo: `social-seeding-platform/microservices/tiktok-mcp-server` (public, OSI license)
- Demo video: 3-min YouTube unlisted
- Hosted endpoint: `mcp.socialseed.ing` (production DNS via Cloud Run)
- Marketplace evidence: Producer Portal `PENDING_REVIEW` screenshot + KR-region disclosure
- agent.json card published at `/.well-known/agent.json`
- Architecture diagram: PNG + Mermaid source
- Devpost long-form write-up with KR-startup distribution-path innovation framing
- Built With tags: ADK 2.0 Beta, Vertex AI, Gemini 2.5 Pro/Flash, Cloud Run multi-container, Identity Platform, Model Armor, Agent Gateway (Private Preview), A2A v0.3, Memorystore Redis, Artifact Registry, Cloud Build
