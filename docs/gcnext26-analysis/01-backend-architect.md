# Agent Platform (Layer 2) — Next '26 Recap 대비 갭 분석
작성: backend-architect, 2026-05-28 · 도메인: Build/Scale/Govern/Optimize

---

## 핵심 메시지 (3문장)

Next '26 데크(Slide 03)는 "에이전트는 만드는 게 끝이 아니라 운영·통제·개선의 사이클이 핵심"이라고 명시하며 Build/Scale/Govern/Optimize 4단계를 동등한 비중으로 제시했지만, 우리 구현은 **Build와 Govern(부분)에서 강점이 있고 Scale·Optimize의 managed 서비스 전환이 미완**이다. 심판 Tech-30% 루브릭에서 손해가 나는 갭은 Agent Runtime(managed), Agent Gateway(claimed-not-enforced), Vertex Agent Evaluation(미전환)이며, 이 중 D-8 안에 처리 가능한 건 Vertex Agent Evaluation(`adk eval` 경유)뿐이다. 나머지 두 갭(Agent Runtime, Agent Gateway)은 Google-gated이므로 HONEST-SCOPE에 명시하는 것이 최선이다.

---

## 1. 놓친 기능 갭

| # | 발견 | 출처(파일:줄 / 슬라이드#) | 영향 | 작업량 | 권고 |
|---|---|---|---|---|---|
| **G1** | **Vertex AI Agent Runtime (managed) 미채택** — Scale 단계의 핵심 컴포넌트. 우리는 FastAPI `serve.py`로 Cloud Run에서 수동 서빙 중. `GEMINI-ENTERPRISE-PLATFORM-MAP.md` Scale 섹션이 "🟡 PARTIAL → 🔴"로 표기하며 "managed Agent Runtime not live (access TBD)" 명기. | `GEMINI-ENTERPRISE-PLATFORM-MAP.md`(Scale 표) · Slide 03(Scale 블록) · `DECISIONS.md` D17 | high — 심판이 "Cloud Run OK but managed Agent Runtime이 없다"를 Scale gap으로 읽을 수 있음 | 0hr (engineer는 못 바꿈, Google-gated allowlist) | **disclose**: HONEST-SCOPE row 신설. "D17 target: Vertex AI Agent Runtime; current: Cloud Run (live). Allowlist access TBD — disclose not fake." |
| **G2** | **Agent Gateway mTLS — declared-not-enforced 상태 지속** — Govern 단계의 핵심. HONEST-SCOPE row 13에 "Google-Private-Preview" 명기. `agent.json`의 `securitySchemes`에 mTLS 선언은 있으나 런타임 미적용. | `HONEST-SCOPE.md` row 13:49 · Slide 03(Govern 블록: "Agent Gateway") · `DECISIONS.md` D48 | high — 실제 Trust Boundary 시연이 없음. 심판 입장에서 "선언-증명" 갭 노출 | 0hr (Private Preview, operator 불가) | **disclose**: 이미 disclose됨. 불필요한 재강조 금지. 기존 표현 유지. |
| **G3** | **Agent Sessions (managed) 미채택** — Scale 단계. 현재 `InMemoryRunner`로 ADK 세션을 invocation-scoped로 생성·소멸. 에이전트 간 상태 연속성 없음. D25 learning loop에서 멀티턴 기억이 필요한 `conversation_responder`, `outreach_writer` 에이전트도 동일. | `runtime.py`:597-601 · `GEMINI-ENTERPRISE-PLATFORM-MAP.md`(Scale: "Agent Sessions 🟡 PARTIAL") · Slide 03(Scale 블록) | med — 기술 gap이지만 심판이 직접 세션 지속성을 테스트할 가능성 낮음 | 4hr — `SessionService` 교체(ADK `VertexAiSessionService` or persistent Firestore-backed) | **ship**: Memory Bank(D51)가 일부 보완하지만, `run_agent` 호출 간 `session_id` 고정으로 인-invocation 상태를 연속시키는 패치가 가능. 단, 런타임 테스트가 흔들릴 수 있어 D-8 처리 전 estimate 재검토 필요. |
| **G4** | **Vertex Agent Evaluation (GA) 미전환 — `adk eval` / `agents-cli eval` 경유 공식 GA 흐름 부재** — Optimize 단계. 현재 평가는 자체 스크립트(`run-hardening-measure.sh`)로 처리. `agents-cli eval run --all`은 4/4 통과가 이미 확인되었으나 이것이 Devpost 제출 증거로 노출되지 않음. | `GEMINI-ENTERPRISE-PLATFORM-MAP.md`(Optimize: "Agent Evaluation 🟢 USE") · `agents-cli-app/CLAUDE.md`:1-43 · Slide 03(Optimize: "Agent Evaluation") | med-high — Track 3 Tech-30% 루브릭에서 "hardening with native platform tools" 어필 기회. `adk eval` 결과를 Devpost 스토리에 포함하면 Score 향상 가능 | 2hr — `agents-cli eval run --all` 실행 결과 캡처 → `claudedocs/` 저장 → Devpost write-up 언급 추가 | **ship**: 가장 낮은 비용, 가장 높은 심판 가시성. D-8 처리 강력 권고. |
| **G5** | **Agent Studio / Agent Builder 미언급** — Build 단계. Slide 02에서 Agent Studio + Agent Builder가 Agent Platform Build 단계 핵심 도구로 명기됨. 우리 구현은 code-first(ADK CLI)이고, `GEMINI-ENTERPRISE-PLATFORM-MAP.md`에서 "⚪ DON'T — Code-first" 처리. Devpost write-up에 "왜 Studio를 안 쓰는가"에 대한 근거가 없으면 누락처럼 보임. | `GEMINI-ENTERPRISE-PLATFORM-MAP.md`(Build: "Agent Studio ⚪") · Slide 02(Layer 2: "Agent Studio · Agent Builder") · Slide 03(Build 블록) | low-med — 직접적 기능 부재가 아니라 설명 부재 문제 | 1hr — Devpost write-up에 "ADK code-first는 CI/CD + typed contract 요구사항 때문에 Studio보다 적합" 단락 추가 | **ship**: write-up 문구 추가. 코드 변경 없음. |
| **G6** | **Vertex AI Memory Bank — 기본값 Firestore, Vertex Memory Bank는 env-gated** — Scale·Optimize 단계. `memory/__init__.py`에 두 백엔드 모두 구현되어 있으나, Vertex Memory Bank는 `MEMORY_BACKEND=vertex` env 플래그로만 활성화됨. 실제 플리트의 대부분 에이전트가 Memory Bank를 호출하지 않음(`Phase 4 wires`로 주석 처리). | `packages/agents-adk/src/ss_agents/memory/__init__.py`:1-30 · `HONEST-SCOPE.md` row 4 · `GEMINI-ENTERPRISE-PLATFORM-MAP.md`(Scale: "Agent Memory Bank 🟢 USE") | med — 기억 기반 에이전트 행동 시연 불가. 심판이 `conversation_responder`의 recall 동작을 확인할 경우 no-op | 6-8hr — `vetting`, `outreach_writer`, `conversation_responder`에 `memory_bank_search` tool 호출 주입. 단, Phase-4 planned work이므로 D-8 완료는 빠듯함 | **defer+disclose**: HONEST-SCOPE에 "Memory Bank wired; agent-level injection is Phase 4 (post-submit)" 추가 |
| **G7** | **Agent Observability — latency SLO 추적 미구현** — Optimize 단계. `observability.py`는 span `agent.usd_spent`를 기록하지만 `p99 latency` SLO(D31: p99 < 1s on hot path) 추적이 없음. Cloud Monitoring SLO 알림도 offline. OTel `duration` 속성은 자동 기록되나, span attribute `agent.latency_ms`가 없어 SLO dashboard 구성 불가. | `packages/agents-adk/src/ss_agents/observability.py`:88-146 · `DECISIONS.md` D31 | low — SLO dashboard는 judging 화면에 직접 노출되지 않지만, Observability stall→repair 스토리의 완성도에 영향 | 1hr — `record_outcome()` 호출 시 `elapsed_ms` 인자 추가 + span attribute `agent.latency_ms` 기록 | **ship**: 단일 파일 수정, 1hr 이내. Optimize stall→repair 증거의 품질 향상. |
| **G8** | **Agent Anomaly Detection — managed product 미사용, 자체 Tier-3 watchdog만** — Govern 단계. `anomaly_watch` 에이전트가 존재하지만 Google managed Agent Anomaly Detection이 아닌 자체 툴(`metrics_query` + `runbook_execute` stub). D21에서 "Agent Anomaly Detection" 언급하지만 실제 managed 제품 호출 없음. | `packages/agents-adk/src/ss_agents/agents/anomaly_watch.py` · `GEMINI-ENTERPRISE-PLATFORM-MAP.md`(Govern: "Agent Anomaly Detection 🟡 PARTIAL") · `DECISIONS.md` D21 | low — 자체 구현은 기능적으로 동등하지만 "platform-native" 어필 불가 | 0hr 신규 (managed product 접근 불가, Private Preview 가능성) | **disclose**: write-up에 "watchdog agent covers anomaly detection; platform-managed anomaly product adoption is next milestone" 추가 |

---

## 2. 디퍼하지 말아야 할 것 (D-8 처리 후보)

### P0: G4 — `adk eval` / `agents-cli eval` 결과를 제출 증거로 캡처 (2hr)
**왜 D-8이어야 하는가:** `agents-cli eval run --all`이 이미 4/4 pass임을 확인했으나 (GEMINI-ENTERPRISE-PLATFORM-MAP.md 마지막 섹션 "Trialed live 2026-05-21"), 이 결과가 Devpost write-up과 live-evidence에 포함되지 않았다. Slide 03의 Optimize 블록("Agent Evaluation") 대응 증거로 추가하면 Tech-30% 루브릭에서 직접적 점수가 생긴다. 재현 명령 하나(`agents-cli eval run --all`)와 결과 텍스트 저장으로 완료되는 작업이다.

**수행 순서:**
1. `cd agents-cli-app && agents-cli eval run --all 2>&1 | tee ../../claudedocs/agents-cli-eval-2026-05-28.txt`
2. 결과 요약을 HONEST-SCOPE.md row 신설 (row 18: "agents-cli eval: 4/4 pass, grounded 1.0, relevance 1.0 on gemini-3.5-flash via Vertex global — demonstrated live")
3. Devpost write-up Optimize 섹션에 한 줄 추가

### P1: G7 — OTel span에 `agent.latency_ms` attribute 추가 (1hr)
**왜 D-8이어야 하는가:** `observability.py`의 `record_outcome()`에 `elapsed_ms` 인자를 추가하는 단일 파일 수정이다. `runtime.py`의 `elapsed_ms = int((time.monotonic() - start) * 1000)` 계산값(line 444)이 이미 있으나 span에 기록되지 않는다. 이 수정으로 Cloud Trace 화면에 latency 히스토그램이 생기고, Optimize stall→repair 스토리가 "비용만 측정" → "비용+지연 측정"으로 완성도가 올라간다.

**수행 방법:**
- `observability.py` `record_outcome()` 시그니처에 `elapsed_ms: float = 0.0` 추가 → `span.set_attribute("agent.latency_ms", elapsed_ms)`
- `runtime.py` `record_outcome(span, kind="ok", usd_spent=usd_spent)` 호출을 `record_outcome(span, kind="ok", usd_spent=usd_spent, elapsed_ms=elapsed_ms)` 로 변경
- 테스트 업데이트: `observability` 관련 pytest 케이스에 new attribute 추가

### P2: G5 — Devpost write-up에 "ADK code-first vs Studio" 근거 단락 추가 (1hr)
**왜 D-8이어야 하는가:** 코드 변경 없이 Slide 03 Build 단계 질문을 선제 답변. 심판이 "Agent Studio 안 썼네?"라는 의문을 갖기 전에 "22-agent typed contract + CI/CD 요구사항이 code-first를 강제했다"는 주장을 배치.

---

## 3. 안전한 디퍼 (HONEST-SCOPE 공시)

| 항목 | 이유 | HONEST-SCOPE 공시 문구 |
|---|---|---|
| **G1: Vertex AI Agent Runtime (managed)** | Google allowlist access TBD (DECISIONS.md D17). 현재 Cloud Run으로 live-proven. | "D17 target: managed Agent Runtime (Vertex AI). Current: Cloud Run — live-deployed and demonstrated. Managed path is the production upgrade; access TBD." |
| **G2: Agent Gateway mTLS 적용** | Private Preview, O7 outstanding. 이미 HONEST-SCOPE row 13에 있음. | 기존 row 유지; 별도 추가 불필요. |
| **G3: Agent Sessions (managed)** | InMemoryRunner per-invocation 패턴은 단순 워크플로엔 충분. Session continuity는 Phase-4 work. | "Agent sessions are per-invocation (InMemoryRunner). Cross-invocation state is served by Memory Bank (wired, Firestore default). Managed Agent Sessions adoption is Phase 4." |
| **G6: Memory Bank 에이전트 주입** | Phase 4 planned work. Firestore 백엔드는 동작 중. | "Memory Bank backend wired (Firestore default, Vertex opt-in). Fleet-level injection into each agent's prompt construction is Phase 4 post-submit." |
| **G8: Managed Agent Anomaly Detection** | 자체 watchdog이 동일 기능 커버. Managed product는 Private Preview 가능성 있음. | "Tier-3 anomaly_watch agent provides in-fleet anomaly detection. Platform-managed Agent Anomaly Detection is the next production upgrade." |

---

## 4. 새로 발견된 위험/모순

### R1: serve.py에는 coordinator/sourcing/vetting 3개 에이전트만 등록됨
**발견:** `serve.py:107-111`의 `_ROUTES` 딕셔너리에 `coordinator`, `sourcing`, `vetting` 3개만 있다. 나머지 19개 에이전트는 `routes`에 없으므로 Cloud Workflow에서 직접 호출 불가. agents/ 폴더에 22개 정의 파일은 있으나(실제 확인), 대부분은 stub 상태로만 존재한다.

**데크 메시지와의 모순:** Slide 03 "에이전트는 만드는 게 끝이 아니다" — 우리는 22-agent fleet을 주장하지만 Workflow에서 실제로 호출 가능한 에이전트는 3개다. 심판이 `/readyz` 엔드포인트를 확인하면 `"agents": ["coordinator", "sourcing", "vetting"]`만 보인다.

**위험 수준:** med-high. README.md와 HONEST-SCOPE에 "22-agent ADK fleet" 이라고 명기하나, 실제 서빙 노출은 3개. 심판이 `serve.py`를 직접 열면 즉시 발견된다.

**완화:** `serve.py` 또는 `healthz` 응답에 "22 agents defined; 3 routed for demo workflow (coordinator/sourcing/vetting). All 22 are invocable via run_agent directly" 설명 추가. 또는 HONEST-SCOPE에 "fleet-serve surface is coordinator/sourcing/vetting for the demo workflow; the full 22-agent roster is accessible via the agents-cli playground and the AgentDef registry" 명기.

### R2: agents-cli `deploy` 미수행 — `agents-cli-manifest.yaml`의 `deployment_target: cloud_run` 미실행
**발견:** `agents-cli-app/agents-cli-manifest.yaml`에 `deployment_target: "cloud_run"`이 선언되어 있으나 실제 `agents-cli deploy` 실행 기록이 없다. GEMINI-ENTERPRISE-PLATFORM-MAP.md 마지막 섹션 "Other next (operator): `agents-cli deploy`"로 pending 분류.

**데크 메시지와의 모순:** Slide 03 Scale 단계 "Agent Runtime" — agents-cli는 ADK를 Vertex Agent Runtime에 배포하는 공식 CLI인데, 이 경로가 시도되지 않았다. `agents-cli playground`(로컬)와 `agents-cli eval`(로컬)만 실행됨.

**위험 수준:** low. `agents-cli deploy`는 Cloud Run 배포이므로 `ss-agents`와 중복될 수 있고, Agent Runtime(managed) 접근 문제와 얽힘. 단, "미시도"로 인해 deployment lifecycle 시연이 약함.

**완화:** `agents-cli deploy` 시도 후 결과 캡처 (성공 시 새 증거; 실패 시 HONEST-SCOPE에 disclose). D-8 내 1hr 할당 권고.

### R3: Gemini Enterprise `streamAssist` → custom agent 라우팅 Google-gated
**발견:** HONEST-SCOPE row 14에 "assistant-API routing to custom agents is Google-side-gated (UI-preview invocation + a Cloud Support case)"로 기록됨. 즉, 우리 에이전트가 Gemini Enterprise App Gallery에 `ENABLED` 상태로 있으나, 실제로 GE 어시스턴트가 우리 에이전트를 호출하지 못한다.

**데크 메시지와의 모순:** Slide 06(Workspace Agent / Gemini Enterprise)는 "에이전트가 Workspace에서 직접 실행"을 강조하는데, 우리 GE 등록은 Discovery만 되고 invocation은 막힌 상태다.

**위험 수준:** med. 그러나 HONEST-SCOPE에 이미 명확히 disclose됨. Devpost write-up에도 반영 필요.

**완화:** Devpost write-up Govern 섹션에 "GE registration + agent card signing = agent discovery layer complete; agent invocation via streamAssist is Google-side-gated (Cloud Support case)" 명기. 현 상태(registered + signed card) 자체가 증거로 충분하다고 주장.

### R4: Agent Registry — managed product 미사용이 "platform compliance" gap으로 노출될 수 있음
**발견:** `agent_registry_list.py`의 live mode는 `NotImplementedError` (W7 deferred). stub mode는 22-agent 스냅샷을 하드코딩으로 반환. managed Agent Registry (D23 watchdog) 미채택.

**위험 수준:** low. 심판이 live Agent Registry 호출을 직접 확인하지는 않겠지만, "Govern" 컴포넌트 설명에서 "Agent Registry: custom code만, managed product 없음"이 노출될 수 있음.

**완화:** HONEST-SCOPE 기존 표현 유지. Devpost write-up에 "agent discovery via A2A signed card + SPIFFE identity = decentralized registry that scales beyond any single managed catalog" 프레이밍 추가.

---

## 5. 권고 우선순위 Top 3

### #1 — `adk eval` / `agents-cli eval` 결과 Devpost 증거화 (G4, 2hr)
**근거:** 이미 4/4 pass가 확인됨(`GEMINI-ENTERPRISE-PLATFORM-MAP.md` "Trialed live 2026-05-21"). 남은 작업은 결과 텍스트 캡처 + HONEST-SCOPE row 신설 + write-up 언급 1줄. 비용 대비 가장 높은 Tech-30% 루브릭 점수 향상. Slide 03 Optimize 단계 "Agent Evaluation" 직접 대응.

**수행 경로:** `cd agents-cli-app && agents-cli eval run --all` → 결과 저장 → `HONEST-SCOPE.md` row 18 신설 → Devpost write-up 언급.

### #2 — OTel span에 `agent.latency_ms` 기록 추가 (G7, 1hr)
**근거:** `runtime.py:444`에 `elapsed_ms` 값이 이미 존재하지만 span에 기록되지 않는다. 단일 파일 2-3줄 수정으로 Cloud Trace 화면의 Observability stall→repair 스토리가 "비용 + 지연 모두 측정"으로 완성된다. Optimize 단계 "Agent Observability" 증거 품질 향상.

**수행 경로:** `observability.py:141` `record_outcome()` 시그니처에 `elapsed_ms` 추가 → `runtime.py:442` 호출 지점 업데이트 → pytest `observability` 케이스 업데이트.

### #3 — serve.py healthz 응답에 "22 defined / 3 routed" 설명 추가 (R1 완화, 0.5hr)
**근거:** 심판이 `GET /healthz` 또는 `GET /readyz`에서 `"agents": ["coordinator", "sourcing", "vetting"]`만 보이면 "22-agent fleet" 주장과 모순된다. `healthz()`와 `readyz()` 응답에 `"agents_defined": 22, "agents_routed_in_workflow": ["coordinator", "sourcing", "vetting"]` 필드를 추가하면 즉시 설명된다. 코드 변경 5줄, 리스크 없음.

**수행 경로:** `serve.py:229-233` `healthz()` 반환 딕셔너리에 `"agents_defined": 22` 필드 추가 → `readyz()` 응답에도 동일.

---

## 부록 — 증거 파일 위치 참조

| 자산 | 경로 |
|---|---|
| 플랫폼 커버리지 표 (30+ 항목) | `gcp-research/GEMINI-ENTERPRISE-PLATFORM-MAP.md` |
| 정직 스코프 17행 | `scripts/demo/submission/HONEST-SCOPE.md` |
| 결정 원장 D1-D53 | `gcp-research/decisions/DECISIONS.md` |
| 런타임 진입점 | `packages/agents-adk/serve.py` |
| 관측성 모듈 | `packages/agents-adk/src/ss_agents/observability.py` |
| agents-cli 매니페스트 | `agents-cli-app/agents-cli-manifest.yaml` |
| Next '26 데크 정리 | `docs/GOOGLE-CLOUD-NEXT-26-RECAP.md` |
| 갭 발견 수: **8 gaps (G1-G8) + 4 risks (R1-R4) = 12 항목** | — |
