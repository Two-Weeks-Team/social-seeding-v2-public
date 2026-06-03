# Native-Adoption Checklist — Gemini Enterprise Agent Platform

> 로드맵(`combba.github.io/ss-reports/native-roadmap.html`) + 감사(`platform-audit.html`)의 잔여 갭을 **`/goal`로 완주 가능한 체크리스트**로 정리. 각 항목은 **대화에서 증명 가능한 검증(proof)**을 가진다(`/goal` 평가자는 대화만 봄).
>
> 환경: project `ss-v2-prod` (deploy 격리, **v1 `:8080` 미접촉**) · ADC=sejun(만료 시 owner gcloud CLI 토큰 또는 SA 키 `/tmp/ae-key.json` 사용) · 모델 **Gemini 3.5/3.1만(D53)**, global 엔드포인트. 배포 SA `ss-agent-runtime@ss-v2-prod`(Identity), deployer `ae-deployer@ss-v2-prod`.

## 0. 이미 LIVE (완료 — 컨텍스트)
- [x] **A1** AP2 Intent→Cart→Payment 체인 + verifier + 11 테스트 (PR #69 merged)
- [x] **A2** per-agent 평가 surface `python -m evals --all` (22 계약 + 2 정확도) (merged)
- [x] **B1** Agent Engine LIVE — `reasoningEngines/8794890706243026944` (라이브 쿼리 검증)
- [x] **B2** Memory Bank LIVE — CreateMemory→RetrieveMemories 검증 (engine `1587442452589969408`)
- [x] **B6** Agent Identity SA(`ss-agent-runtime`) + Agent Registry(Agent Engine 등록·discoverable)

---

## A. GOAL-TRACKED — `/goal`로 완주 (자율, 차단 없음)
> 목표: 아래 모든 항목 `[x]` + 각 proof를 그 턴에 출력.

- [x] **GT1 — Cloud Trace 활성** (Step 4 Observability) ✅ 2026-06-03
  - 작업: `AdkApp(enable_tracing=True)`로 엔진 `2498295477225652224`(ss-agent-engine-trace-mem) 배포 + 런타임 SA `ss-agent-runtime`에 `roles/cloudtrace.agent` 부여(없으면 span export 403).
  - 문서: cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview
  - **Proof**: 라이브 쿼리 후 Cloud Trace v1 `traces/{id}` — 7-span 트리: `invocation → invoke_agent root_agent → call_llm → generate_content gemini-3.5-flash → execute_tool source_creators → call_llm → generate_content`. traceId `dc063a2af962770ff776b0c43ff8ac28` (00:53:49Z).

- [x] **GT2 — Memory auto-recall** (Step 2 잔여) ✅ 2026-06-03
  - 작업: `before_agent_callback`(`_recall_brand_pref`)가 env-pinned 스코프(`MEMORY_BANK_ENGINE_ID`/`MEMORY_APP_NAME`/`MEMORY_BANK_LOCATION=us-central1`)로 Memory Bank retrieve → state → `before_model_callback`(`append_instructions`) 주입. 핵심 수정: 런타임 env가 `global`이라 memory 서비스에 `location=us-central1` 명시 안하면 404("ReasoningEngine does not exist").
  - 문서: google.github.io/adk-docs/sessions/memory/
  - **Proof**: REST CreateMemory로 "min ER 13%"(scope app_name=ss-recall,user_id=wooriliu-op) 저장 → ER **미지정** 쿼리 → 로그 `RECALL got 1 memories` + `INJECT recalled_memory present=True` → agent가 `source_creators(min_engagement_rate=13)` 호출 → **@_alejandrauve 1명**, "applied a minimum engagement rate requirement of at least 13%" 명시.

- [ ] **GT3 — GenAI Evaluation (관리형)** (Step 4)
  - 작업: 배포된 엔진에 Vertex Gen AI Evaluation(GenAI Client) 실행 — 루브릭(`FINAL_RESPONSE_QUALITY`/`TOOL_USE_QUALITY`/`SAFETY`) 또는 궤적 메트릭.
  - 문서: docs.cloud.google.com/agent-builder/agent-engine/evaluate
  - **Proof**: eval run의 summary metrics(점수) 출력.

- [ ] **GT4 — Vertex AI RAG Engine** (Step 5, 현재 부재)
  - 작업: `RagCorpus` 생성 + 브랜드-브리프 문서 ingest + ADK `VertexAiRagRetrieval` 도구를 에이전트에 부착.
  - 문서: google.github.io/adk-docs/integrations/vertex-ai-rag-engine/
  - **Proof**: 코퍼스 리소스명 + 그라운딩 쿼리 응답(코퍼스 출처 인용) 출력.

- [ ] **GT5 — VAPO (Prompt Optimizer, 데이터드리븐)** (Step 4)
  - 작업: `client.prompt_optimizer.optimize(method="vapo", …)`를 triage 데이터셋(GA 모델 대상)으로 실행. preview 모델 금지.
  - 문서: docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/prompts/data-driven-optimizer
  - **Proof**: 최적화된 system instruction 또는 before/after 점수 출력.

- [x] **GT6 — AP2 체인 라우트 배선** (Step 6 진척) ✅ 2026-06-03
  - 작업: `verifyRecommendationChain`(`apps/web/lib/ap2/chain-guard.ts`)를 `sign-mandate` route에 배선 — approval `recommendation.ap2Chain`이 실리면 resolve 전 `verifyMandateChain` 실행, 깨지면 HTTP 422 `mandate_chain_invalid`. Intent-only(D27)는 skip. + `chain-guard.test.ts`(5).
  - 문서: github.com/google-agentic-commerce/AP2 (Intent/Cart/Payment)
  - **Proof**: `vitest run __tests__/ap2/` → **83 passed (6 files, +5 guard)**; `pnpm run verify-build` → **7/7 successful**.

**완주 정의**: §A 6개 전부 `[x]` + 각 Proof를 대화에 출력. 게이트(`pnpm run verify-build`·`pytest`)는 항상 green 유지.

---

## B. OUT-OF-SCOPE (goal 제외 — 차단 사유 명시)
- **Agent Gateway mTLS** — 🔴 Google **Private-Preview 승인** 대기.
- **Cloud Marketplace 등재** — 🔴 한국 결제권역 제외(D2) → **해외 sub-entity(법무)**.
- **22/22 정확도 eval 게이트** — 🟡 에이전트별 **도메인 predictor 22개**(다일, golden replay는 과적합).
- **22-fleet 번들링 기동** — 🟡 ss_agents **lazy-init 리팩터**(현재 build OK·startup health 타임아웃).
- **Model Armor 인라인 전 플릿** — 🟡 신규 sanitize 프리미티브(live=Model Armor API).
- **Gemini Enterprise Registry(ss-v2-prod)** — 🟡 discoveryengine API + GE 앱 생성.

> §B는 `/goal` 완주 기준에 **포함하지 않음**(Google/법무/대규모). 각 unblock 조건은 위에 명시.
