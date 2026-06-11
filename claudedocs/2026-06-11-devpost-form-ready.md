# Devpost 제출폼 — 붙여넣기용 작성본 (project 15395, 마감 6/11 17:00 PT)

> 실제 Devpost 폼(`devpost.team/.../projects/15395/edit`) 구조에 1:1 맞춤. 평이한 1인칭 + 우리 실제 구현 디테일로 작성(AI 일반론 아님). ⚠ = 운영자 확정.

## 1. Title (≤60자)
```
SocialSeed.ing — agent-operated TikTok campaigns
```

## 2. Project Assets (LINK)
- **Code\*** → `https://github.com/Two-Weeks-Team/social-seeding-v2`  ⚠ repo **private** → 공개 전환 or 심사자 접근
- **Video\*** → `https://youtu.be/4SDvNK4cwZs`  (라이브 ✅ — README #83에서 추가, 운영자 최종 확인)
- **Architecture diagram\*** → `https://storage.googleapis.com/ss-social-seeding-v2-docs/architecture-current.html` (200 ✅)
- **Testing access\*** → `https://agents.socialseed.ing/api/auth/judge-demo?token=***REDACTED-JUDGE-DEMO-TOKEN***` (1-click read-only ✅)

## 3. Description (≤5000자)

**Problem to solve**
We run influencer campaigns on TikTok for brands, and the job is mostly grind. Find creators, check they're real and on-brand, email them, deal with the replies, ship product, confirm the creator actually posted, pull the view numbers, pay out. Agencies do this with spreadsheets and headcount. The B2B problem is that almost none of it needs a person — except the handful of moments that touch money or brand safety. Everything else is the same loop, over and over, and it doesn't scale.

**Our solution**
We hand the whole loop to a fleet of agents and only keep the human at the gates we choose. A brief comes in, a campaign comes out. A `gemini-3.5-flash` coordinator reads the brief and decides who runs next — sourcing, vetting, outreach, reply-triage, logistics, content-verify, reporting — and the agents share campaign state so nobody re-asks the brand anything. The fleet is 22 ADK agents in Python: 16 Tier-1 domain agents, 3 Tier-2 meta (coordinator, critic, optimizer), 3 Tier-3 watchdogs (anomaly, cost, security). They run on Cloud Run plus a Vertex AI Agent Runtime reasoningEngine (`2498...`), all on the Vertex `global` endpoint routed through Model Garden. Mission Control (the dashboard) is a feed of what the agents did and an inbox of approvals, not a tool you operate. Each agent is a typed function, not a free ReAct loop: curated tools, a Pydantic output contract, a hard USD cap, and an escalation path. The TikTok capability is its own open-source server (`tiktok-mcp-server`) the coordinator reaches over A2A v0.3 `message:send`; we proved that hop live inside a deployed Cloud Workflow (execution `7c08ce50`, SUCCEEDED in 15.8s, 5 ranked creators). The weakest agent was reply-triage — deciding if a creator's reply means yes, no, or hand it to a human. We hardened it with a re-runnable measurement pass (`scripts/smoke-test/run-hardening-measure.sh`): 40.5% → 100% on the 42 training cases, and 71.4% on a 14-case adversarial holdout the rules never saw. We left that 28.6-point gap in the numbers instead of tuning it away.

**Technologies used**
Gemini 3.5 Flash (judgment + coordinator) and 3.1 Flash-Lite (bulk), Vertex AI on the `global` endpoint, routed through the Model Garden publisher plane. ADK for the fleet. Vertex AI Agent Runtime (reasoningEngine) + Cloud Run for the runtime; Cloud Workflows for durable orchestration. A2A v0.3 (`message:send`) between coordinator and the MCP node. MCP for `tiktok-mcp-server`. Identity Platform OIDC. For the product loop we self-host Inngest on a Compute Engine VM (`ss-inngest`, the single `docker inngest start` binary — no external Postgres/Redis), reached privately from Cloud Run over Direct VPC egress, so there's no orchestration SaaS account. MongoDB for state. Imagen 4 for one real 1024×1024 generation. No model other than Gemini (our D53 rule — no 2.5, no `*-pro`, no Claude).

**Data sources**
Public TikTok creator data through `tiktok-mcp-server` (public profiles and search only). Campaign and creator state in MongoDB. For grounding, the research and vetting agents use a `web_search` tool that runs real Google Search grounding (Gemini `grounding_metadata` on the Vertex `global` endpoint), plus a vector-search competitor tool and a Vertex AI RAG Engine corpus, so the agents reason over retrieved context, not just the prompt. The reply-triage hardening runs against a 56-case synthetic conversation set we wrote by hand (42 train / 14 held-out adversarial: obfuscated comp, buried rate, sarcasm, code-switching) — no real creator PII.

**Findings and learnings**
Most of what we learned came from things breaking in ways an LLM doesn't warn you about. Our sourcing agent returned zero creators for a while — the creator schema rejected `language: null` and silently dropped every candidate. We had to disable Gemini 3.x "thinking" on the product agents because they were spending the entire output budget on thoughts and never emitting their JSON. Our signed A2A card's `jku` pointed at a vanity domain (`mcp.socialseed.ing`) that 404'd, so a spec-pure verifier couldn't fetch the key until we repointed it at the Cloud Run JWKS. Outbound email shipped as a lone `text/plain` part, so HTML `<br>` showed up literally until we made it `multipart/alternative`. The bigger lesson underneath all of it: reliability is something you measure, not something you feel. Reply-triage looked fine until we built the holdout — the 100%-vs-71.4% gap is the honest signal, and hiding it would defeat the point. And deterministic typed-function agents beat free agent loops the moment money or an external send is involved, which is exactly what the challenge guide says about explainability needing determinism.

**Third-party integrations (if applicable)**
TikTok public data over a RapidAPI-backed path (public data only; we have access rights). Gmail API for outreach. Some LangChain tooling. Everything is public-data or our own accounts — nothing scraped from behind a login.

## 4. Project Details
- **Theme**: Refactor for Google Cloud Marketplace & Gemini Enterprise (이미 설정 ✅)
- **Region**: ⚠ → **South Korea (대한민국)**

## 5. Submission Questions (6)

1. **Google Cloud familiarity 1-5** → ⚠ 운영자 (권장 **4**)
2. **Google AI Studio familiarity 1-5** → ⚠ 운영자 (정직히 **2~3** — 우리는 AI Studio가 아니라 Vertex/ADK로 빌드)
3. **Readiness for launch.**
   It's running in production, not a prototype. Mission Control, the `tiktok-mcp-server` A2A node, and the demo/report site are all on Cloud Run and answer 200 right now; there's a 1-click read-only link for judges. The 22-agent fleet runs the loop end to end, and any outbound email is held behind a human approval gate (the demo account isn't even Gmail-connected, so a send is structurally impossible there). What's not live: the managed Agent Gateway is still Google Private Preview, and a few capability tools run as a stub→live seam. We list all of that explicitly in `scripts/demo/submission/HONEST-SCOPE.md` rather than imply it's done.
4. **Most critical Agent Platform feature, and one thing it's missing?**
   Most critical: the Vertex AI Agent Runtime plus A2A. The Agent Runtime gave us a managed home for the fleet (we deploy a reasoningEngine, not just containers), and A2A let us pull the TikTok capability out into its own node the coordinator discovers and calls — that's the difference between a multi-agent system and one big prompt. Missing/unreliable: managed Agent Simulation. The DataFoundry scenario generator returned HTTP 500 twice for us, so we wrote our own simulation loop over the 56-case set. A managed simulation that actually ran would have saved us the most.
5. **One API capability that would've saved 2+ hours?**
   A reliable managed Agent Simulation that generates synthetic multi-turn creator conversations against our agent — we hand-built the harness because the managed generator 500'd. Close second: a `streamQuery` SSE that doesn't double-encode already-formatted events, so streaming live agent execution into our UI would have worked without us relaying it ourselves.
6. **Additional information**
   Honest scope is in the repo (`scripts/demo/submission/HONEST-SCOPE.md`) — what's GA-live vs operator-gated vs Google Private Preview, line by line. The repo is dual-licensed: BUSL-1.1 for the core product, Apache-2.0 for the standalone OSS pieces (`tiktok-mcp-server`, the refactor-mcp reference). The Testing-access link is the 1-click read-only judge session.

---
## 제출 전 운영자 확정 (⚠ 5건 — Video는 youtu.be/4SDvNK4cwZs로 해소)
1. repo **public/심사자 접근** 2. **Region = South Korea** 3. Q1 점수(권장 4) 4. Q2 점수(정직히 2~3) 5. 전부 입력 후 **Submit** (19h)
