# Google Cloud Next '26 Recap — 갭 분석 종합 보고서
작성: Tech Lead (synthesis of 6 expert reports), 2026-05-28 · D-day 2026-06-05 (D-8)

## 0. Executive Summary

6개 도메인 전문가의 독립 분석 결과, 우리 제출 스택은 데크의 "Build/Scale/Govern/Optimize" 4단계 중 **Build와 Govern(부분)에서 강점이 있고 Scale·Optimize의 managed 서비스 전환이 미완**이라는 일관된 진단을 받았다. 가장 큰 갭은 두 가지로 (a) `Vertex AI Agent Runtime` · `Agent Gateway mTLS enforcement` · `Chronicle SecOps live 쿼리` 같은 Google-gated 서비스의 미적용(#1 G1·G2, #3 GAP-05), (b) **"22-agent fleet"** 주장을 뒷받침할 eval/serve 노출의 결핍(#1 R1, #4 W-2 — `serve.py`는 3개 라우팅, eval은 1/22) 이다. 가장 위험한 모순은 **문서 간 숫자/카테고리 불일치**(#5 D-0~D-3: HONEST-SCOPE 16행 vs 17행, 테스트 2925 vs 2924, Hero 스크린샷 318ms vs 3.7s)로 심사관이 교차 확인할 때 정직성 신뢰가 즉시 무너진다. D-8 안에 처리할 **즉시 액션 15건**(코드 변경 ≤1일짜리 + 문서만 수정)과 **안전 디퍼 11건**(Google-gated 또는 D-8 초과 작업)으로 분리했으며, 디퍼 정당화의 핵심 논리는 "Google-side-gated이거나 W7 operator 단계로 이미 분류된 항목은 우리 통제 밖이며 HONEST-SCOPE에 disclose된 형태가 최선의 정직성"이다.

## 1. 즉시 처리 (D-8 안에 끝내야 할 것)
> 영향도 高 + 작업량 ≤ 1일. 안 하면 심판/데모/사용자가 즉각 알아챈다.

| # | 항목 | 출처 | 작업량 | 책임 영역 | 근거 |
|---|---|---|---|---|---|
| A1 | **HONEST-SCOPE 행 카운트 / 테스트 카운트 / Hero 스크린샷 명세 일괄 동기화** | #5 D-0, D-1, D-2, D-3, R-1, R-3 | 1.5hr | docs | `devpost-track3.md:425` "16 rows: 9 GA-real / 4 operator-deploy / 2 Google-Private-Preview"를 실제값 "17 rows (7 demonstrated-live / 6 GA-real / 1 operator-deploy / 1 Google-gated / 2 split)"로 교체. `CHECKLIST.md` G-1 `2925`→`2924`, G-10 카테고리 동기화. `SCREENSHOTS-MANIFEST.md §0` Hero를 `CHECKLIST §4`의 10-item 리스트로 교체 (`live-a2a-crosscall-318ms.png` → `hardening-before-after-train-100-holdout-71.png`, ~3.7s, 2924 tests, holdout 71.4%). `devpost-track3.md:291` `2925`→`2924` |
| A2 | **ss-mcp-server Cloud Armor rate-limit (비용 공격 방어)** | #3 GAP-07, P1 | 1-2hr | security | `ss-mcp-server`의 `https://*.run.app/v1/message:send`가 토큰 없이 호출 가능 (`gcp-research/refactor-mcp/code/deployment/cloud-run-service.yaml:26-28` ingress all). 공격자가 100 req/min 반복 시 RapidAPI 일일 quota(200회) 1분 내 소진 + Gemini 비용 폭증. `gcloud compute security-policies rules create`로 IP당 100 req/min rate limit 추가. Cloud Armor L7 정책은 이미 활성화 가능 상태. 비용 $0 |
| A3 | **approval `editedPayload` 프롬프트 인젝션 방어** | #3 GAP-08, P1 | 30min | security | `apps/web/app/api/approvals/[id]/resolve/route.ts:19`에서 `editedPayload: z.unknown()` 수신 후 `packages/workflows/src/gate.ts:173`에서 promptGuard 없이 다음 워크플로 단계의 에이전트 입력으로 직접 전달. 인증된 operator가 인젝션 패턴 삽입 시 `conversation_responder`, `logistics` 등 탈취 가능. string 필드에 `promptGuard()` 적용 or 타입별 Zod 스키마 강화 |
| A4 | **`agents-cli eval run --all` 결과 캡처 → HONEST-SCOPE row 신설** | #1 G4 (P0) | 2hr | backend/docs | 이미 4/4 pass 확인됨 (`GEMINI-ENTERPRISE-PLATFORM-MAP.md` "Trialed live 2026-05-21"). 결과 캡처 → `claudedocs/agents-cli-eval-2026-05-28.txt` 저장 → `HONEST-SCOPE.md` row 18 신설 ("agents-cli eval: 4/4 pass, grounded 1.0, relevance 1.0 on gemini-3.5-flash via Vertex global — demonstrated live") → Devpost Optimize 섹션에 1줄 추가. Slide 03 "Agent Evaluation" 직접 대응으로 Tech-30% 루브릭 점수 향상 |
| A5 | **OTel span에 `agent.latency_ms` attribute 추가** | #1 G7 (P1) | 1hr | backend | `packages/agents-adk/src/ss_agents/runtime.py:444`에 `elapsed_ms` 계산값 이미 존재하나 span에 기록 안됨. `observability.py:141` `record_outcome()` 시그니처에 `elapsed_ms: float = 0.0` 추가 → `span.set_attribute("agent.latency_ms", elapsed_ms)` → `runtime.py:442` 호출 지점 업데이트 → pytest observability 케이스 업데이트. Cloud Trace 화면에 latency 히스토그램 생성, Optimize stall→repair 스토리 완성 |
| A6 | **`serve.py` healthz/readyz에 "22 defined / 3 routed" 명시** | #1 R1, #4 W-2 | 30min | backend/docs | `serve.py:107-111` `_ROUTES`에 coordinator/sourcing/vetting 3개만 등록. 심판이 `GET /healthz`에서 `"agents": [...3개]`만 보면 "22-agent fleet"과 모순. `healthz()`/`readyz()` 반환에 `"agents_defined": 22, "agents_routed_in_workflow": ["coordinator","sourcing","vetting"]` 추가. 코드 5줄, 리스크 없음 |
| A7 | **`research` agent grounding=true 라이브 캡처 + W-1 해소** | #4 G-1, P-1, W-1 | 30min | backend/docs | `research.py:93` `grounding_enabled: bool = Field(default=False)`로 캠페인 플로에서 grounding 항상 비활성. `run-web-search-grounding.sh`는 capability 단독 증명만. `ResearchInput(groundingEnabled=True)`로 1회 라이브 실행, `grounding_used: true` + URL 인용 포함 `ResearchOutput` 캡처 → 제출 에셋. 비용 ~$0.035-0.07/회. README.md:154 grounding 표기에 "research 에이전트 루프 내 사용 시 `groundingEnabled=true` 필요" 주석 추가 |
| A8 | **`conversation_responder` triage mini-eval 추가 (eval coverage 1/22 → 2/22)** | #4 G-6, P-2, W-2 | 1-2hr | backend | 현재 공식 golden-eval은 coordinator 1개만. README/HONEST-SCOPE의 "22-agent fleet" + "hardening 71.4% holdout" 주장이 공식 eval 미연결. `triage_sim.py`의 56-case에서 8-10개를 `conversation.evalset.json` 형식으로 전환 + holdout manifest 추가. 기존 데이터 재포장 수준 |
| A9 | **`_heuristic_rank` 진입 로깅 추가** | #4 W-4 | 30min | backend | `ss-mcp-server`의 ADK SequentialAgent ranker가 live (HONEST-SCOPE row 8)지만 `_heuristic_rank` in-code fallback이 silent. ranker 코드에 `_heuristic_rank` 진입 시 `logger.warning("heuristic_rank_triggered", ...)` 추가. 심판 재현 시 "LLM ranking 대신 heuristic 동작" 의혹 예방 |
| A10 | **StageBar 한국어 레이블 + Button focus-visible + ActivityTimeline aria-live 패치 (a11y 일괄)** | #6 G2, G3, G6, R2 | 20-30min | frontend | `apps/web/components/mission-control/stage-bar.tsx:12-18` `LABEL_KO` 값을 실제 한국어로 교체 (`overview→"개요"`, `sourcing→"소싱"` …). `components/ui/button.tsx:50-63`에 `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1` 추가 (WCAG 2.4.11). `activity-timeline.tsx`의 최상위 `<div>`에 `role="feed" aria-label="에이전트 활동 타임라인" aria-live="polite"` 추가. 모두 CSS/문자열/aria 추가만, verify-build 위험 없음. ss-landing a11y 96점 연속성 방어 |
| A11 | **Mission Control 본체 Lighthouse a11y 측정** | #6 R1 | 30min | frontend | ss-landing은 96점 측정 완료(PR #15), MC 본체(`apps/web`)는 측정치 없음. 심판이 `/campaigns` 직접 방문 시 MC 본체 기준 평가. 로컬 Lighthouse 1회 실행으로 baseline 확정 후 A10 패치 효과 검증 |

## 2. HONEST-SCOPE/문서 공시 강화 (D-8 안에 문서만 수정)
> 구현은 불가/디퍼지만, narrative와 실제의 갭을 honest하게 좁힐 항목들.

| # | 항목 | 출처 | 작업량 | 책임 영역 | 근거 |
|---|---|---|---|---|---|
| B1 | **Agent Sandbox 클레임 불일치 disclose** | #2 G1, R3, P1 | 1hr | docs | `SERVICE-INVENTORY.md:39` `Agent Sandbox (GKE Autopilot gVisor) ✅ D23`이지만 실제 `deploy/agents/service.yaml`은 Cloud Run gen2 단독. HONEST-SCOPE.md 행 추가: "Agent Sandbox: D23에 GKE Autopilot gVisor 계획. 현재 배포는 Cloud Run gen2 (강화된 샌드박스이나 gVisor 아님). GKE gVisor 마이그레이션은 제출 후" |
| B2 | **Knowledge Catalog / Dataplex 분리 기재** | #2 G2, P2 | 30min | docs | `SERVICE-INVENTORY.md:138` `Knowledge Catalog (=Dataplex) ✅ D22`로 두 제품 혼동. Slide 04의 Knowledge Catalog는 에이전트 메타데이터 카탈로그 신제품으로 Dataplex와 다름. 두 행으로 분리: `Dataplex ✅ D22 PIPA 거버넌스`와 `Knowledge Catalog ⬜ 에이전트 메타데이터 카탈로그 — 평가 대상` |
| B3 | **ss-mcp-server 실 비용 검증 + README 수치 정확화** | #2 R1, R2 | 1hr | docs | README "Cloud Run ≈ $1–5/mo" + `ss-mcp-server` minScale=1 + multi-container + containerConcurrency=30. README:19 `ss-mcp-server kept warm at minScale=1, the rest min=0`이지만 `deploy/agents/service.yaml:50`은 `ss-agents`도 minScale=1로 추정 → README/service.yaml 불일치 해소. GCP 콘솔에서 최근 7일 실 청구 확인 → 초과 시 HONEST-SCOPE 실수치 명시. Track 3 Business 30% 비용 효율성 항목 |
| B4 | **Model Armor 적용 범위 명확화 (ss-mcp-server only)** | #3 GAP-06, P3, 위험 1 | 30min | docs | README:156 "Model Armor sanitize" 선언이 22-agent ADK 플리트에는 미적용. ss-mcp-server A2A 경로에만 live. HONEST-SCOPE row 3을 "Model Armor: ss-mcp-server A2A 경로 live 적용; ADK 플리트는 promptGuard(6패턴)+Gemini built-in safety로 방어"로 업데이트 |
| B5 | **Memory Bank 에이전트 주입 Phase-4 disclose** | #1 G6 | 15min | docs | `memory/__init__.py`에 두 백엔드 구현되어 있으나 22-agent 플리트가 호출하지 않음 (`Phase 4 wires` 주석). HONEST-SCOPE에 "Memory Bank backend wired (Firestore default, Vertex opt-in). Fleet-level injection into each agent's prompt construction is Phase 4 post-submit" |
| B6 | **Agent Studio / Agent Evaluation built-with 태그 정합화** | #5 G-3, G-4, D-4 | 30min | docs | `built-with-tags.txt` Track 3에 `agent-studio` + `agent-evaluation` 등록되었으나 실 사용 증거 없음. (a) A4 작업 완료 후 `agent-evaluation` 태그에 1줄 근거 (`agents-cli eval 4/4 pass`) 추가, (b) `agent-studio`는 코드 기반 ADK CLI workflow이므로 태그에 ADK code-first 근거 추가 또는 태그 제거 |
| B7 | **R1 `serve.py` 3-route 설명 HONEST-SCOPE 명기** | #1 R1 | 15min | docs | A6의 코드 변경과 함께 HONEST-SCOPE에 "fleet-serve surface is coordinator/sourcing/vetting for the demo workflow; the full 22-agent roster is invocable via run_agent registry" 명기 |
| B8 | **R2 `agents-cli deploy` 미수행 disclose** | #1 R2 | 15min | docs | `agents-cli-manifest.yaml`에 `deployment_target: cloud_run` 선언만 있고 실행 기록 없음. HONEST-SCOPE에 "agents-cli playground/eval은 로컬 실행 완료; `agents-cli deploy`는 ss-agents Cloud Run과 중복 회피 위해 시도 안 함"으로 정직하게 기재. 또는 D-8 내 1hr 할당해 시도 후 결과 캡처 |
| B9 | **A2A workflow execution ID 단일화** | #5 R-2 | 30min | docs | README:13 `execution 7c08ce50, SUCCEEDED 15.8s`와 HONEST-SCOPE row 7 `exec 9cc843c1, SUCCEEDED 11.98s`로 두 ID 혼재. README에 "primary demonstration: `9cc843c1` (11.98s, A2A in-workflow). 이전 평가에서는 `7c08ce50` 사용" 명시 또는 한쪽으로 통일 |
| B10 | **eval coverage 1/22 명시** | #4 W-2 | 15min | docs | HONEST-SCOPE.md에 "eval coverage: coordinator golden-eval (1/22), conversation_responder triage offline measurement via triage_sim.py (1/22 post-A8). Remaining 20 agents: pytest schema/integration only" 추가 |
| B11 | **Cloud Run min=0 cold-start vs SLO 표기 정직화** | #4 W-5 | 15min | docs | D31의 "p99 < 1s on hot path" SLO와 `min=0` cold start의 불일치. HONEST-SCOPE에 "cold start는 SLO 대상 외 — 첫 요청 latency는 warm-up 후 측정. Demo 시 warm-up 권장" 명시 |

## 3. 안전한 디퍼 (제출 후 처리)
> 구현 불가/D-8 초과. 단, 디퍼 사유를 정직하게 공시.

| # | 항목 | 출처 | 작업량 | 디퍼 사유 |
|---|---|---|---|---|
| C1 | Vertex AI Agent Runtime (managed) | #1 G1 | 외부 의존 | Google allowlist access TBD (D17). 현재 Cloud Run live-proven. "managed Agent Runtime is the production upgrade; access TBD" |
| C2 | Agent Gateway mTLS enforcement | #1 G2, #5 표 | 외부 의존 | Private Preview, O7 outstanding. 이미 HONEST-SCOPE row 13에 disclose. 기존 표현 유지 |
| C3 | Agent Sessions (managed) | #1 G3 | 4hr (테스트 흔들림 위험) | InMemoryRunner per-invocation 패턴은 단순 워크플로엔 충분. Cross-invocation은 Memory Bank가 커버 |
| C4 | Chronicle SecOps live 쿼리 / Threat Hunting / Detection Engineering | #3 GAP-01, GAP-05 | 3-5일 | W7 operator 단계 (ADC + Chronicle 인스턴스 프로비저닝 필요). 구조(D32)와 코드는 완비, stub 모드만 가동 |
| C5 | Dark Web Intelligence | #3 GAP-02 | 외부 계약 | 외부 유료 API 계약 필요. Secret Manager + DLP redaction으로 유출 예방 측면 대응 |
| C6 | Wiz Red/Blue/Green | #3 GAP-03 | 외부 라이선스 | 별도 라이선스 제품. Artifact Registry vulnerability scan (GA) + SCC AI Protection으로 부분 대체. roadmap |
| C7 | Fraud Defense (creator/brand 사칭 탐지, reCAPTCHA Enterprise) | #3 GAP-04 | 2-4hr+ | A2 (Cloud Armor rate-limit)로 1차 방어. reCAPTCHA Enterprise 통합은 OAuth scope/Firebase 추가 설정 필요. W7 roadmap |
| C8 | Vertex AI Memory Bank 에이전트 주입 | #1 G6 | 6-8hr | Phase 4 planned work. Firestore 백엔드는 동작 중 |
| C9 | Managed Agent Anomaly Detection | #1 G8 | 외부 의존 | 자체 watchdog(`anomaly_watch`)이 기능적으로 동등. Managed product Private Preview 가능성 |
| C10 | GKE Inference Gateway / GKE Agent Sandbox / Cloud Storage Rapid / Managed Lustre / Axion N4A / TPU Ironwood | #2 G3, G1(인프라), G5, G6, G7, G8 | 2-3주+ | 현 Cloud Run 아키텍처와 충돌 또는 워크로드 미매칭. Vertex global이 Ironwood를 내부적으로 활용 시 자동 수혜 |
| C11 | Maps Grounding Lite / Imagery Grounding / Earth AI / Maps Agentic UI Toolkit / Workspace Agent | #2 G4, #4 G-2, G-3, G-4, G-5, #6 G5, G8 | 1-2주+ | Slide 33 Maps UI / Slide 20 Imagery / Slide 06 Workspace Agent. content_verify `vision_brand_logo_detect`는 W7-staged. Workspace Agent는 v4 |

## 4. 새로 발견된 위험/모순 (cross-cutting)
> 여러 보고서가 함께 가리키는 구조적 문제. 별도 처리 흐름 필요.

| 위험 ID | 위험 | 출처 | 영향 범위 | 대응 |
|---|---|---|---|---|
| **X1** | **"22-agent fleet" 주장 vs 실제 노출의 구조적 갭** — `serve.py`는 3개만 라우팅(#1 R1), eval은 1/22(#4 G-6, W-2), Memory Bank는 fleet 미주입(#1 G6) | #1 R1, G6 + #4 G-6, W-2 | Tech-30% 루브릭 신뢰도 | A6+A8+B5+B7+B10 묶음으로 "22 defined / 3 routed / 1-2 evaluated + fleet-level features는 Phase 4"를 일관되게 disclose. 단일 행 추가가 아니라 README/HONEST-SCOPE/healthz 응답 3곳 동시 동기화 |
| **X2** | **문서 간 숫자/카테고리 불일치 (제출 정직성 직접 타격)** — HONEST-SCOPE 16 vs 17행, 테스트 2925 vs 2924, Hero 스크린샷 318ms vs 3.7s, execution ID 7c08ce50 vs 9cc843c1 | #5 D-0~D-3, R-1, R-3, R-2 | 정직성 신뢰도 (모든 루브릭) | A1+B9 묶음. 한 번에 모든 문서를 동기화하고 CHECKLIST를 single source of truth로 만들기 |
| **X3** | **Model Armor "live" 표현이 시스템 전체 적용처럼 읽힘** — ss-mcp-server A2A 경로만 live, ADK 22-agent 플리트는 promptGuard 6패턴만 | #3 GAP-06, 위험1 + #5 매칭표 | Defense 루브릭, Adversarial skeptic | B4 (HONEST-SCOPE 명세) + 선택적으로 `runtime.py`에 model_armor 래핑 추가 (#3 P3 옵션 B) |
| **X4** | **REQUIRE_AUTH 기본값/Dockerfile/cloud-run.yaml/agent.json 4곳 표기 불일치** | #3 위험2 | Security, 정직성 | live-evidence-2026-05-24.txt 재확인 후 실제 배포가 `true`인지 `false`인지 확정 → 4개 파일 동기화 + HONEST-SCOPE에 단일 답변 |
| **X5** | **Cold start / latency SLO / cost 주장의 측정 부재** — `min=0` cold start, p99 SLO, $1-5/mo 비용 모두 측정치 없거나 단편적 | #2 R1, R2 + #4 W-5 + #1 G7 | Business 30% (비용), Tech 30% (관측성) | A5(latency span) + A11(Lighthouse) + B3(비용 검증) + B11(SLO 표기 정직화)을 measurement sprint로 묶기 |
| **X6** | **built-with 태그 정합성 (Agent Studio, Agent Evaluation, agent-optimizer)** | #5 G-3, G-4, D-4, R-4 | Adversarial skeptic | A4(eval 캡처) 후 `agent-evaluation`에 근거 추가, `agent-studio`는 ADK code-first 근거 추가 또는 제거, Track 2 `agent-optimizer`는 HONEST-SCOPE §3 correction과 일관성 유지 (Track 3 제출엔 직접 영향 없음) |

## 5. 도메인 간 교차참조 매트릭스
> 어떤 갭이 다른 도메인을 건드리는지의 의존도 표. (●=직접 영향, ○=간접 영향)

| 갭 → 영향 도메인 | Agent Platform (#1) | Hypercomputer/Data (#2) | Defense (#3) | Grounding/Perf (#4) | Narrative (#5) | UX (#6) |
|---|---|---|---|---|---|---|
| X1 (22-agent fleet 실증 갭) | ● | ○ | ○ | ● | ● | ○ |
| X2 (문서 숫자/카테고리 불일치) | ○ | ● | ○ | ● | ● | ○ |
| X3 (Model Armor 범위 오해) | ● | — | ● | ○ | ● | — |
| X4 (REQUIRE_AUTH 표기 4중 불일치) | ● | — | ● | — | ● | — |
| X5 (측정치 부재 클러스터) | ● | ● | — | ● | ● | ● |
| X6 (built-with 태그) | ● | — | — | ○ | ● | — |
| #1 G4 (adk eval 캡처) | ● | — | — | ● | ● | — |
| #3 GAP-07 (ss-mcp 무인증 노출) | ○ | ● | ● | — | ○ | — |
| #4 W-1 (grounding 기본 OFF) | ● | ○ | — | ● | ● | — |
| #6 G1 (3-패널 레이아웃) | — | — | — | — | ○ | ● |

## 6. 권고 우선순위 Top 10 (실행 순서)
> 가중치: (영향도 × 1/작업량 × deadline-pressure × cross-cutting 결합도)

1. **A1 — 문서 숫자/카테고리 일괄 동기화 (X2 해소)** · 1.5hr · 정직성 직접 타격 차단, 가장 비용 대비 효과 큼
2. **A2 — ss-mcp Cloud Armor rate-limit (GAP-07)** · 1-2hr · 라이브 데모 사고 가능성 최대, 비용 공격 즉시 방어
3. **A3 — `editedPayload` promptGuard (GAP-08)** · 30min · 인증된 operator의 인젝션 경로 차단, 코드 1줄
4. **A4 — `agents-cli eval` 결과 캡처 (G4)** · 2hr · 이미 4/4 pass 확인됨, Tech-30% 루브릭 직접 점수
5. **A6+B7 — `serve.py` 22/3 정직화 (R1 + X1)** · 45min · "22-agent fleet" 주장과 모순 차단
6. **A10 — UX a11y 일괄 패치 (G2+G3+G6+R2)** · 20-30min · ss-landing 96점 연속성, Lighthouse 방어
7. **A7 — research grounding=true 라이브 캡처 (G-1 + W-1)** · 30min · grounding이 에이전트 루프 내 동작 증명
8. **A5 — OTel `agent.latency_ms` span attribute (G7)** · 1hr · Optimize stall→repair 스토리 완성
9. **A8 — conversation_responder mini-eval (G-6 + W-2)** · 1-2hr · eval coverage 1/22 → 2/22, hardening 71.4% 근거 연결
10. **B4 — Model Armor 적용 범위 명세 (X3)** · 30min · README의 "live" 표현이 ADK 플리트로 잘못 일반화되는 것 차단

## 7. 6개 도메인별 핵심 한 줄 (보존용 요약)

| # | 도메인 | 한 줄 결론 |
|---|---|---|
| #1 | Agent Platform (Build/Scale/Govern/Optimize) | Build·Govern은 강하나 Scale·Optimize의 managed 서비스(Runtime/Gateway/Sessions/Memory Bank 주입)는 Google-gated 또는 Phase 4. D-8 ROI 최대는 `adk eval` 결과 캡처(G4) |
| #2 | Hypercomputer + Data Cloud | 데크 신제품 8종 중 6종은 현 규모에서 비용/복잡도 증가 요인이므로 안전 디퍼. D-8은 Agent Sandbox·Knowledge Catalog 클레임 불일치 + ss-mcp 비용 수치 정정 |
| #3 | Agentic Defense | Model Armor + security_watch는 라이브 작동. Slide 05 6개 카드 중 5개(Threat Hunting/Detection Engineering/Dark Web/Wiz/Fraud) 대응물 없음. D-8 P0는 ss-mcp 무인증 노출 (GAP-07) |
| #4 | Grounding & 추론 성능 | Google Search Grounding live지만 research 기본 OFF (W-1). 22-agent 중 eval은 1개(W-2). D-8은 grounding=true 라이브 캡처 + conversation eval 추가 |
| #5 | 제출 narrative & HONEST-SCOPE | 데크 메시지 정합성 양호하나 **문서 간 숫자/카테고리 불일치**가 정직성 신뢰를 직접 타격. D-8은 D-0~D-3 일괄 수정 |
| #6 | Taskforce + Maps UI + Mission Control UX | Maps Agentic UI Toolkit / Workspace Agent는 디퍼. D-8 ROI 최대는 a11y 일괄 패치(20-30min) + Gate 노드 rationale 표시(30-45min) |

## 8. 디퍼 정당화의 통합 narrative
> 제출 후 처리할 항목들을 묶은 "왜 지금이 아닌가" — Devpost/HONEST-SCOPE에 곧바로 인용 가능한 문장.

> 우리 디퍼는 세 범주로 나뉜다. (1) **Google-side-gated** — Vertex AI Agent Runtime, Agent Gateway mTLS enforcement, Gemini Enterprise assistant→agent invocation, Threat Hunting Agent, Detection Engineering Agent — 는 Google의 allowlist/Preview/Support case에 의존하므로 우리가 통제 불가하며 HONEST-SCOPE에 demonstrated-live의 한계로 명시되어 있다. (2) **W7 operator 단계로 이미 분류된 항목** — Chronicle SecOps live 쿼리, `tenant_quarantine`, `vision_brand_logo_detect`, `agents-cli deploy` — 는 구조(D-항목)와 코드가 완비되어 있고 stub 모드로 CI를 통과하며, 실 실행은 ADC + 인스턴스 프로비저닝 + 빌링 활성화의 운영 게이트만 남았다. (3) **현재 워크로드 규모에서 ROI 부재** — Managed Lustre, GKE Inference Gateway, Cloud Storage Rapid, Axion N4A, Earth AI, Maps Agentic UI Toolkit, Workspace Agent — 는 우리 도메인(인플루언서 캠페인, 22-agent fleet, 22 MongoDB 컬렉션)에서 즉시 적용 시 비용/복잡도 증가가 가치를 초과하므로 v3/v4 로드맵으로 이관했다. **세 범주 모두 over-claim 없이 disclose됐고**, 이는 우리 제출의 정직성 자산(HONEST-SCOPE 17행 + 의사결정 원장 D1-D53)으로 직접 매핑된다.

---
입력 보고서 6개의 직접 링크 (수정 금지, 참조용):
- [01-backend-architect](gcnext26-analysis/01-backend-architect.md)
- [02-system-architect](gcnext26-analysis/02-system-architect.md)
- [03-security-engineer](gcnext26-analysis/03-security-engineer.md)
- [04-performance-engineer](gcnext26-analysis/04-performance-engineer.md)
- [05-requirements-analyst](gcnext26-analysis/05-requirements-analyst.md)
- [06-frontend-architect](gcnext26-analysis/06-frontend-architect.md)
