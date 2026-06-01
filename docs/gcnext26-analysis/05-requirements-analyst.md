# 제출 narrative & HONEST-SCOPE — Next '26 Recap 대비 갭 분석
작성: requirements-analyst, 2026-05-28

## 핵심 메시지 (3문장)

Google Cloud Next '26 데크의 핵심 메시지("파일럿의 시대는 끝났고, 에이전트의 시대가 왔다")와 5-Layer Agentic Enterprise 스택은 우리 제출 narrative에 직접 매핑되는 항목들이 있으나, 데크에서 강조된 **Agent Platform의 Govern/Optimize 레이어 제품명**(Agent Studio, Agent Gateway, Agent Identity 등)이 우리 README/Devpost 카피에서 정확한 공식 명칭으로 언급되지 않고 있다. HONEST-SCOPE.md의 stub/live 분리 체계는 데크의 신제품 라인업 중 우리가 실제 사용 중이라고 주장하는 것들과 무결하게 정합되며, Maps/Earth AI/Place Insight 등 데크 신제품은 우리가 사용하지 않으므로 over-claim 위험이 없다. D-8 시점에서 가장 급한 것은 CHECKLIST.md의 숫자 불일치(G-10의 "16-row" vs 실제 17-row, G-1의 "2925" vs 실제 2924)와 SCREENSHOTS-MANIFEST.md의 구식 스크린샷 명세(~3.7s 아닌 "318ms", "2713" 테스트)를 제출 전 수정하는 것이다.

---

## 1. 데크 제품 라인업 vs 우리 narrative 매칭표

> 데크 섹션 A(슬라이드 1-23)의 Agent Platform 레이어 중심으로 분석. 섹션 B/C(Maps Platform, Analytics)는 우리 도메인과 무관하므로 "미사용" 처리.

| 데크 제품/개념 | 슬라이드# | 우리 README/Devpost 언급? | 실제 사용 여부 | 평가 |
|---|---|---|---|---|
| **ADK (Agent Development Kit)** | 02, 03 | README "Agent Development Kit (ADK)" ✅ | 실제 사용 (22-agent fleet) | 정합 — 명칭 일치 |
| **Agent Studio** | 02, 03 | built-with-tags.txt `agent-studio` ✅ | built-with에만 등록; 실제 사용 증거 없음 | **과대 주장 위험** — built-with에 등록했으나 코드/HONEST-SCOPE에 사용 증거 없음 |
| **Agent Gateway** | 02, 03 | README "Agent Gateway-fronted API" (D26 맥락) / devpost-track3.md "Agent Gateway" | HONEST-SCOPE row 13: mTLS는 Google Private Preview로 **declared-not-enforced** | 부분 정합 — 기능 선언됨, 실 enforcement 없음. 이미 disclosure 있음 |
| **Agent Identity (SPIFFE)** | 02, 03 | README "SPIFFE Agent Identity" ✅ / HONEST-SCOPE row 12 | 실제 사용 (SPIFFE workload ID, Secret Manager signing key) | 정합 — "agent-identity-spiffe" built-with 등록, 실사용 |
| **Agent Registry** | 02, 03 | devpost-track3.md "Agent Registry" / README 직접 언급 없음 | Gemini Enterprise app 등록(HONEST-SCOPE row 14, demonstrated-live) | 부분 정합 — Gemini Enterprise 통한 등록은 live, 명시적 "Agent Registry" 표현은 Devpost에만 |
| **Agent Observability** | 02, 03 | README "Agent Observability → Cloud Trace" ✅ / HONEST-SCOPE row 2 | GA-real (OTel spans 실코드, 오프라인 테스트; 라이브 export는 operator-gated) | 정합 — 상태 정확히 공개됨 |
| **Vertex AI Prompt Optimizer (VAPO)** | 02, 03 | devpost-track3.md "Vertex AI Prompt Optimizer (data-driven)" ✅ | GA-real, operator-gated (HONEST-SCOPE row 1) | 정합 — "Agent Optimizer" 미스노머 수정도 HONEST-SCOPE에 명시됨 |
| **Agent Evaluation** | 02, 03 | built-with-tags.txt `agent-evaluation` | HONEST-SCOPE에 별도 언급 없음; built-with만 등록 | **경미한 과대 주장 위험** — built-with 등록됐지만 어떤 평가를 실제 실행했는지 HONEST-SCOPE에 없음 |
| **Vertex AI Memory Bank** | 02 (implied) | README "Vertex AI Memory Bank (Firestore as zero-config default)" ✅ | HONEST-SCOPE row 4: GA-real (Firestore 기본, Memory Bank env-gated) | 정합 — Firestore 기본 명시됨 |
| **Model Armor** | 02, 05 | README "Model Armor sanitize" ✅ / HONEST-SCOPE row 3 | demonstrated-live (A2A 경로 실 sanitize, jailbreak 차단 검증) | 정합 — 데크 Agentic Defense 메시지와 정확히 일치 |
| **Gemini Enterprise / Agentspace** | 02 (Agentic Taskforce) | devpost-track3.md row 14 "Gemini Enterprise" ✅ | demonstrated-live (registration + ENABLED, row 14); **assistant-API routing은 Google-side-gated** | 부분 정합 — registration은 live, assistant→agent 호출은 Google 제한으로 미완. HONEST-SCOPE에 명시됨 |
| **Model Garden (publisher path)** | 01 (implied) | README "Model Garden routing · D47" ✅ | demonstrated-live (run-model-garden-live.sh, exec `9cc843c1`) | 정합 — D47에서 명확히 정의됨 |
| **Google Search grounding** | 11–16 (Maps grounding, 유사 개념) | README "Google Search grounding on web.search capability" ✅ | demonstrated-live (HONEST-SCOPE row 17: 5 cited K-beauty sources) | 정합 — 데크의 "grounding이 에이전트의 1순위 입력" 메시지와 일치 |
| **Grounding with Google Maps / Earth AI** | 12–16, 22–23 | 언급 없음 | 미사용 (GOOGLE-CLOUD-NEXT-26-RECAP.md "신규 검토 후보" 표기) | 안전 — 미사용이므로 과대 주장 없음 |
| **Place Insight / Road Management Insight** | 36–41 | 언급 없음 | 미사용 | 안전 |
| **Maps Agentic UI Toolkit** | 33 | 언급 없음 | 미사용 | 안전 |
| **Agentic Defense (Wiz, Mandiant, Chronicle)** | 05 | README "Chronicle SecOps" ✅ built-with-tags.txt `chronicle-secops` | Chronicle: GA-real (BigQuery export sink, HONEST-SCOPE row 2 일부). Wiz/Mandiant: 미사용 | 정합(Chronicle만), 나머지 미언급으로 안전 |
| **Imagen 4** | 언급 없음(데크 섹션A B C 모두) | README "Imagen 4 (real 1024×1024 sample via standalone script; in-fleet tool W7-staged)" | HONEST-SCOPE row 10: standalone script는 GA-real; in-fleet tool은 W7-staged(NotImplementedError) | 정합 — 데크 신제품이 아니라 기존 제품, 상태 정확히 공개됨 |
| **Cloud Run** | 02–03 (Agent Platform) | README "Cloud Run" ✅ | 3개 서비스 live | 정합 |
| **Cloud Workflows** | 02 (implied orchestration) | README "brand-campaign-demo Cloud Workflow · LIVE" ✅ | demonstrated-live (exec `7c08ce50` / `9cc843c1`) | 정합 |

---

## 2. 놓친 narrative 갭

| # | 발견 | 출처 | 영향 | 작업량 | 권고 |
|---|---|---|---|---|---|
| **G-1** | 데크 키노트 인용 "파일럿의 시대는 끝났고, 에이전트의 시대가 왔다"(Thomas Kurian)를 우리 README 또는 Devpost 리드에 삽입하면 심판이 제출물을 볼 때 데크 맥락을 즉시 연결할 수 있음. 현재 어디에도 없음. | GOOGLE-CLOUD-NEXT-26-RECAP.md 슬라이드10 | Demo 20% / Story 인상 강화 | 1-2문장 추가 | **D-8 전 권고** — README 서두 또는 Devpost "Inspiration" 첫 줄에 삽입. 슬라이드10 인용 출처 명기 |
| **G-2** | "Agentic Enterprise 5-Layer 스택" 중 우리가 커버하는 층을 명시적으로 매핑하는 문장이 없음. 심판이 데크를 알 경우 "어느 레이어를 다루는가"를 직접 찾아야 함. | GOOGLE-CLOUD-NEXT-26-RECAP.md 슬라이드02 | Technical 30% 판단 용이성 | 2-3줄 표 또는 서술 | **D-8 후 안전 디퍼** — 제출 후 README에 추가 가능 |
| **G-3** | **Agent Studio** built-with 태그로 등록됐으나(`built-with-tags.txt` Track 2/3 모두), HONEST-SCOPE와 코드에서 실제 사용 증거가 없음. "내부 툴로 ADK 에이전트 빌드 시 사용" 같은 맥락 설명이 없으면 허위 등록으로 읽힐 수 있음. | built-with-tags.txt 라인21/182 | Adversarial 심판 skeptic 점수 하락 | 1줄 설명 또는 태그 제거 | **D-8 전 권고 — 낮음** — 사용 근거가 있으면 Devpost 설명에 1문장 추가; 없으면 태그 제거 |
| **G-4** | **Agent Evaluation** built-with 등록됐으나 HONEST-SCOPE/코드에 "어떤 평가를 실행했는가"가 명시되지 않음. 데크는 Optimize 레이어에서 "Agent Evaluation"을 강조(슬라이드03). | built-with-tags.txt 라인52/201 | Adversarial 심판 skeptic 점수 하락 | 1줄 설명 추가 또는 태그 제거 | **D-8 전 권고 — 낮음** — triage 측정(run-hardening-measure.sh)이 "에이전트 평가"에 해당한다고 명시하거나 태그 제거 |
| **G-5** | Devpost Honest scope 섹션이 "16 rows: 9 GA-real / 4 operator-deploy / 2 Google-Private-Preview/allowlist"로 기술됨(devpost-track3.md 425행). 실제 HONEST-SCOPE는 **17행** (7 demonstrated-live / 6 GA-real / 1 operator-deploy / 1 Google-gated / 2 split). 이 숫자 불일치는 Adversarial 심판이 HONEST-SCOPE를 직접 열었을 때 credibility 타격. | devpost-track3.md:425, HONEST-SCOPE.md §2 | Adversarial skeptic 공격 벡터 | 1-2문장 숫자 수정 | **D-8 전 최우선 수정 — 제출 전 반드시** |
| **G-6** | CHECKLIST.md G-1("2925 passed")과 CHECKLIST.md G-10("16-row table")이 실제 값(2924, 17행)과 다름. 심판이 제출물을 검토하면서 CHECKLIST와 실제 HONEST-SCOPE 숫자를 교차 확인할 경우 불일치 발견. | CHECKLIST.md 라인17, 라인27 | 신뢰성 타격 | 2곳 숫자 수정 | **D-8 전 수정** |
| **G-7** | SCREENSHOTS-MANIFEST.md §0의 Hero 스크린샷 명세가 구식. 현재: `live-a2a-crosscall-318ms.png` (318ms, 2713 passed). CHECKLIST.md §4에서 이미 갱신된 명세(~3.7s, 2924/2925, holdout 71.4% 히어로) 제시됨. SCREENSHOTS-MANIFEST.md §0 자체는 업데이트 안됨. 두 문서가 충돌하면 운영자가 혼란을 겪음. | SCREENSHOTS-MANIFEST.md §0 라인21–30, CHECKLIST.md §4 라인93–109 | 운영자 혼선, 잘못된 스크린샷 업로드 위험 | §0 표 교체 | **D-8 전 수정 (운영자 보호)** |

---

## 3. 디퍼하지 말아야 할 disclosure (D-8)

아래 항목들은 제출 후 수정 불가이거나, 심판이 문서를 교차 확인할 때 정직성 기반을 흔들 수 있으므로 D-8 내 처리해야 한다.

### D-0: HONEST-SCOPE 행 카운트 불일치 (가장 중요)
- **위치**: `devpost-track3.md` 425행 — `"16 rows: 9 GA-real / 4 operator-deploy / 2 Google-Private-Preview/allowlist"`
- **실제값**: HONEST-SCOPE.md §2: **17행** (7 demonstrated-live / 6 GA-real / 1 operator-deploy / 1 Google-gated / 2 split)
- **왜 중요**: Honest scope는 우리 submission의 신뢰도 핵심 자산이다. 이 숫자가 틀리면 심판이 HONEST-SCOPE를 직접 열 동기를 제공하며, 그 순간 "문서를 관리하지 않는다"는 인상을 준다.
- **수정**: `devpost-track3.md` 425행 숫자를 "17 rows (7 demonstrated-live / 6 GA-real / 1 operator-deploy / 1 Google-gated / 2 split)"로 교체.

### D-1: CHECKLIST.md 숫자 불일치
- **위치**: `CHECKLIST.md` G-1(라인17) — `"0 failed, 2925 passed"` → 실제 `agents-adk` pytest: **2924** (SCORECARD.md 확인)
- **위치**: `CHECKLIST.md` G-10(라인27) — `"16-row production-vs-shipped table (9 GA-real / 4 operator-deploy / 2 Google-Private-Preview)"` → 실제 17행
- **왜 중요**: CHECKLIST는 운영자가 제출 직전 실행하는 문서. 틀린 pass criteria를 갖고 있으면 false-positive로 통과하거나 불필요한 혼란이 생긴다.

### D-2: SCREENSHOTS-MANIFEST.md §0 Hero 명세 vs CHECKLIST §4 불일치
- **위치**: `SCREENSHOTS-MANIFEST.md` §0 라인21 — Hero를 `live-a2a-crosscall-318ms.png` (318ms, 2713 tests)로 지정
- **CHECKLIST §4 라인93-109** — Hero를 `hardening-before-after-train-100-holdout-71.png` (~3.7s, 2924 tests, holdout 71.4%)로 변경
- **왜 중요**: 운영자가 SCREENSHOTS-MANIFEST를 우선 보면 구식 파일명으로 스크린샷을 캡처하고 업로드할 수 있다. 틀린 Hero 이미지는 데모 20% 점수에 직접 영향.
- **수정**: SCREENSHOTS-MANIFEST.md §0 전체를 CHECKLIST §4의 10-item 리스트로 교체.

### D-3: Devpost "Accomplishments" 테스트 카운트
- **위치**: `devpost-track3.md` 291행 — `"2925 pytest cases pass"` → 실제: **2924** (2026-05-24 핸드오프 §2 기준)
- **왜 중요**: 심판이 smoke-test를 돌려보면 2924가 나오는데 제출물은 2925를 주장하면 overcount로 읽힌다.

### D-4: Agent Studio / Agent Evaluation built-with 태그 설명 부재
- **위치**: `built-with-tags.txt` (Track 3) `agent-studio`(라인182) + `agent-evaluation`(라인201)
- **문제**: HONEST-SCOPE, README, devpost-track3에 이 두 제품의 실제 사용 증거 없음.
- **권고**: (a) 사용 근거가 있으면 HONEST-SCOPE에 1행 추가 또는 Devpost에 1문장 추가, (b) 사용 근거가 없으면 Track 3 태그에서 제거. "빌드 도구로 사용"이라는 설명도 없이 등록만 되면 심판이 flag할 수 있음.

---

## 4. 안전한 디퍼

제출 후에도 보완 가능한 narrative 강화 항목들.

| # | 항목 | 이유 |
|---|---|---|
| S-1 | Thomas Kurian 인용 추가 (G-1) | Devpost는 제출 후 편집 가능. 인용 추가는 과학적 사실이지 submission claim이 아님 |
| S-2 | Agentic Enterprise 5-Layer 스택 매핑 표 (G-2) | README에 추가해도 judge는 제출 시점의 Devpost를 1차 봄. README 갱신은 후속 작업 |
| S-3 | 섹션 B(Maps Platform) / 섹션 C(Analytics) 관련 제품 추가 채택 여부 | 데크에서 신규로 강조된 Place Insight / Earth AI / Maps Agentic UI Toolkit. D-항목 신설 후 도입 가능하나 D-8 내 구현은 불가 |
| S-4 | Gemini Enterprise "assistant-API routing" 완성 (HONEST-SCOPE row 14, Google-side-gated) | Cloud Support case 등 Google 측 작업 필요. 우리가 D-8 내 처리 불가 |
| S-5 | Agent Gateway mTLS 실 enforcement (HONEST-SCOPE row 13, Google Private Preview) | Private Preview 접근 필요. 우리 제어 밖 |

---

## 5. 새로 발견된 위험/모순

### R-1: devpost-track3.md Honest scope 섹션의 숫자 불일치 (D-0과 동일 근원)
**상세**: `devpost-track3.md` 425행 "16 rows: 9 GA-real / 4 operator-deploy / 2 Google-Private-Preview/allowlist"는 HONEST-SCOPE.md §2의 현재 카운트("17 rows — 7 demonstrated-live, 6 GA-real, 1 operator-deploy, 1 Google-Private-Preview, 2 split")와 다를 뿐 아니라, Devpost에 기재된 카테고리 분류 자체가 달라진 상태다. "9 GA-real" vs 실제 "6 GA-real + 7 demonstrated-live"는 단순 숫자 차이가 아니라 카테고리 체계가 바뀐 것이다. 심판이 HONEST-SCOPE를 직접 열면 "Devpost에서 주장한 breakdown과 다른 파일이 나온다"는 모순이 된다.

### R-2: README의 workflow execution ID 불일치
**상세**: README:13행 — `"live inside a deployed Cloud Workflow (execution 7c08ce50, SUCCEEDED 15.8s, 5 real ranked creators)"`. HONEST-SCOPE.md §Section 1 row 7 — `"exec 9cc843c1, SUCCEEDED 11.98s"`. README:185행 — `"Live A2A-in-workflow execution: 7c08ce50 / 9cc843c1"`. 두 execution ID가 혼재하고 있으며, 15.8s vs 11.98s로 시간도 다르다. 심판이 execution ID를 하나 선택해 GCP Console에서 확인하려 할 때 어느 것이 "the" demonstration인지 혼란스럽다.
- **출처**: `README.md` 13행, 185행 vs `HONEST-SCOPE.md` row 7
- **위험도**: 중간 — 두 execution 모두 valid하지만 명시적으로 "어느 것이 최신/주요 증거인가"를 README에 설명하는 것이 더 투명하다.

### R-3: CHECKLIST G-3의 A2A 시간 표기 불일치
**상세**: `CHECKLIST.md` G-2(라인19) — `"bash scripts/smoke-test/run-integration-a2a.sh … ~3.7s … 5 creators"`. 그런데 `SCREENSHOTS-MANIFEST.md` S-01(라인40) — `"318 ms … 5 ranked creators"`. 또한 CHECKLIST §4 Hero 명세(라인93)는 `"live-a2a-crosscall-in-workflow.png"`, §4 라인94 스크린샷 설명은 `"~3.7s"`. 심판이 스크린샷을 보고 "318ms"라는 텍스트가 있는 터미널 캡처를 기대했는데 "3.7s"가 나오면 혼란이 생긴다. SCREENSHOTS-MANIFEST는 여전히 구식 `live-a2a-crosscall-318ms.png`를 정의하고 있다.
- **출처**: CHECKLIST.md G-2, SCREENSHOTS-MANIFEST.md S-01
- **위험도**: 중간 — 운영자 혼란 및 잘못된 스크린샷 업로드로 이어질 수 있음

### R-4: built-with-tags.txt Track 3 `agent-optimizer` 태그 오등록
**상세**: `built-with-tags.txt` Track 2 태그에는 `agent-optimizer`(라인52)가 있다. Track 3 태그에는 없으므로 Track 3 제출에는 직접 영향 없음. 그러나 HONEST-SCOPE.md §3 correction #1에서 명시적으로 "Agent Optimizer"라는 GA 제품은 존재하지 않고 정확한 제품명은 "Vertex AI Prompt Optimizer (data-driven / VAPO)"라고 정정했다. Track 2 built-with에 `agent-optimizer` 태그가 남아 있으면, Track 3 단독 제출이라도 저장소 전체가 공개될 경우 잘못된 태그가 노출된다. (Track 3 제출 태그에는 없으므로 직접 타격은 없으나, HONEST-SCOPE의 정정 정신에 반한다.)
- **출처**: `built-with-tags.txt` 라인52 vs `HONEST-SCOPE.md` §3 correction #1
- **위험도**: 낮음 (Track 3 태그에 없으므로 제출 직접 영향 없음; repo 투명성 문제)

### R-5: D53 규칙 하 `gemini-*-pro` 404 사실과 Agentic Taskforce 데크 메시지의 관계
**상세**: 데크 슬라이드02는 Agent Platform의 Build→Scale→Govern→Optimize 라이프사이클을 소개하고 슬라이드07은 "Gemini Enterprise app"을 단일 앱으로 묶는다. 우리는 Gemini Enterprise app 등록(row 14, demonstrated-live)까지는 했지만 assistant-API로 우리 agent를 실제 호출하는 것은 Google-side-gated다. 데크 수준에서 "Gemini Enterprise 앱에서 에이전트가 바로 호출된다"는 메시지를 우리가 실현한 것처럼 읽히면 안 된다. HONEST-SCOPE row 14에 이미 "invocation-via-assistant is a known Google-side limitation"이 명시되어 있으므로 disclosure 자체는 존재한다.
- **위험도**: 낮음 — 이미 HONEST-SCOPE에 공개됨. 추가 수정 불필요.

---

## 6. 권고 우선순위 Top 3

| 순위 | 항목 | 파일 | 작업 | D-8 필수 여부 |
|---|---|---|---|---|
| **#1** | HONEST-SCOPE 행 카운트 불일치 수정 | `devpost-track3.md` 425행 | `"16 rows: 9 GA-real / 4 operator-deploy / 2 Google-Private-Preview/allowlist"` → `"17 rows (7 demonstrated-live / 6 GA-real / 1 operator-deploy / 1 Google-gated / 2 split)"` | 제출 전 **필수** |
| **#2** | SCREENSHOTS-MANIFEST.md §0 Hero 명세 교체 + CHECKLIST 숫자 2곳 수정 | `SCREENSHOTS-MANIFEST.md` §0, `CHECKLIST.md` G-1/G-10 | §0 전체를 CHECKLIST §4의 10-item 리스트로 교체; G-1 `2925`→`2924`, G-10 `16-row / 9 GA-real / 4 operator-deploy / 2 Google-Private-Preview` → `17 rows (7 demonstrated-live / 6 GA-real / 1 operator-deploy / 1 Google-gated / 2 split)` | 제출 전 **필수** (운영자 보호) |
| **#3** | Agent Studio / Agent Evaluation built-with 태그 처리 | `built-with-tags.txt` (Track 3 섹션) | 실사용 증거가 없으면 제거 또는 Devpost narrative에 1문장 근거 추가 | 제출 전 **권고** (adversarial skeptic 방어) |

---

**분석 요약**: 데크 메시지 정합성은 전반적으로 양호하다. 우리가 사용하지 않는 데크 신제품(Maps Grounding, Earth AI, Place Insight 등)에 대한 over-claim이 없고, 사용 중인 제품(ADK, Model Armor, Agent Observability, Memory Bank, Gemini Enterprise)은 HONEST-SCOPE에 정확히 공개되어 있다. 발견된 가장 실질적인 위험은 기술적 사실의 오류가 아닌 **문서 간 숫자 불일치**(HONEST-SCOPE 행 카운트, 테스트 카운트, 스크린샷 명세)로, 이는 D-8 내 수정 가능하고 수정해야 한다.

발견 항목 수: **12개** (갭 7, 위험/모순 5)
