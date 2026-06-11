# Antler × Google for Startups — "Immersion" 세션 흡수 노트 (running log)

> **목적**: 발표 슬라이드를 우리 프로젝트(social-seeding-v2, Track-3 제출) 현재 상태와 대조해 **흡수할 것·정합시킬 것·갭**을 기록. 사용자가 스샷을 줄 때마다 아래에 슬라이드별로 append.
> **출처**: Google for Startups × Antler "Immersion" 세션 (발표자 화면녹화 스샷).
> **시작**: 2026-06-04. **마감 컨텍스트**: Devpost Track-3, 2026-06-11 17:00 PT.

---

## 📌 Executive Summary (팀 공유용 TL;DR)

**세션2(Architecting Intelligence — Agents with Gemini & ADK) 한 줄 결론**: 우리 social-seeding-v2는 구글이 발표한 **Agent Platform 라이프사이클(Build/Scale/Govern/Optimize)과 공식 아키텍처를 이미 거의 전부 라이브로 채우고 있다.** 따라서 이번 세션의 가치는 "새로 만들 것"보다 **"우리가 한 걸 구글 공식 언어·프레임으로 다시 말하기"(제출 카피 정합)** 에 있다.

**우리가 배울 점 / 적용할 것 (우선순위 Top 5)**
1. **A11 ⭐ (가장 강력)** — 구글: *"explainability/규제 → determinism; 창의성 → agent-first; ADK는 둘 다 지원."* 우리의 **agents=함수 + Inngest durable 결정론 워크플로 + policy gate**가 바로 그 "결정론 끝"이고, 우리 도메인(돈·계약·외부발송)이 그 규제 환경. → "ReAct 자유루프 안 씀"을 **약점이 아니라 규제-인지 정답**으로 재프레임. (Technical-30% 핵심)
2. **A5 ⭐** — 공식 **Agent Platform services 6개**(Sessions&memory·Observability·Code-exec&tools·Identity·Evaluation·Registries)를 **전부 라이브 커버** + 런타임 3개 중 2개(Agent Runtime+Cloud Run). → 제출/HONEST-SCOPE를 이 **공식 6개 이름에 1:1 매핑**.
3. **A7 ⭐** — "Gemini Enterprise Agent Platform" **마스터 아키텍처**에 우리 박스를 정렬. **유일한 진짜 갭 = managed Agent Gateway(Google Private-Preview, 미부여)** → 우리는 동등 정책을 앱계층(prompt-guard/policy-gate/DLP)에서 집행(정직 표기 유지).
4. **A2** — 구글 슬라이드 *"3.5 Flash(GA)가 3.1 Pro를 1/3 비용에 능가, 3.5 Pro는 Coming Soon"* → 우리 **D53(3.5/3.1만, *-pro 금지)** 의 외부검증 + 비용논거. ("vs 3.1 Pro, 1/3 cost" 문구 그대로만 인용)
5. **A12** — ADK **Sequential/Loop/Parallel** 워크플로 패턴을 우리 brand-campaign이 이미 인스턴스화(순차+배송 병렬+하드닝 루프) → 공식 어휘로 기술.

**검증 후보**: A14(외부도구 일시실패·429 graceful fallback — capabilities 레이어 점검 후 production-readiness 근거화).
**참조만**: A9(배지)·A13(모델군 VO/Chirp/Lyria·Antigravity 2.0·Skills 크레딧).

**자료 출처**: Antler×Google "Immersion" 세션2 키노트 슬라이드(S1–S8) + 라이브캡션 verbatim + 팀원 전체 요약(S9) + GENAI106 핸즈온 ADK 랩(S10, `~/livecaps/.../2026-06-04-adk-multiagent-lab-learning.md`).

---

## 🔝 ABSORB BACKLOG (우선순위 — 누적)

| # | 흡수 항목 | 근거 슬라이드 | 우리 상태 | 액션 | 우선도 |
|---|---|---|---|---|---|
| A1 | **공식 라이프사이클 = Build · Scale · Govern · Optimize** 4단계에 서사 정합 | S1 | PR#72에서 Scale/Govern/Optimize 적용 완료. 단 제출 서사는 "Build→Optimize→**Refactor**"(우리 고유) | 제출 카피에 **공식 4단계 매핑** 1줄 추가 — 심사자 멘탈모델과 공명 | 🟡 높음 |
| A2 | **Gemini 3.5 Flash GA가 3.1 Pro를 "higher speed · 1/3 cost"로 능가**, 3.5 Pro는 **Coming Soon(미GA)** | S2 | D53: 3.5-flash(판단)+3.1-flash-lite(벌크), *-pro 금지(404) | (a) D53를 **구글 공식 슬라이드로 외부검증** 인용 (b) Business-30% 비용논거로 활용 (c) "*-pro 미사용"이 정직성이 아니라 **최적선택**임을 강화 | 🟡 높음 |
| A3 | **Build 3기둥 = Skills · MCP · A2A** (공식 ADK 프레이밍) | S1 | 셋 다 보유: agent.json `skills`(plan_creator_search/get_brand_assets) · tiktok-mcp · A2A v0.3 | 제출에 **세 기둥을 공식 문구**("Perform/For your services/Collaborate")로 명시 | 🟢 중 |
| A4 | **공식 "Agent Runtime" 레퍼런스 아키텍처와 박스 1:1 매핑** (Agent[goals/instr/skills + reasoning/planning] + Sessions&memory + Model + Tools[MCP+APIs]) | S3 | reasoningEngine 2498(라이브)·Agent Sessions 1945·Memory Bank·thinking budget·tiktok-mcp — **모든 박스가 우리 라이브 컴포넌트** | 제출 아키텍처 섹션을 **공식 다이어그램 형태**로 재구성 → "우리 배포 = 구글 공식 Scale 아키텍처의 인스턴스" 주장 (Technical-30% + 네이티브 채택 강력 증거) | 🟡 높음 |
| A5 ⭐ | **공식 "Agent Platform services" 6개 서비스 레이어 전부 커버** (Sessions&memory · Observability · Code exec&tools · Identity · Evaluation · Registries) + **3개 런타임 중 2개**(Agent Runtime + Cloud Run) | S4 | 6개 다 라이브: Memory Bank/Sessions · GT1 Cloud Trace · capabilities/MCP · SPIFFE+Identity Platform · GT3 GenAI Eval+golden-eval · GT Registry(`agent_engines.list()`) | **제출/HONEST-SCOPE/platform-fit을 구글 공식 6개 서비스명에 1:1 매핑**해 재구성 — "공식 서비스 레이어 전체 채택" = 최강 네이티브-채택 프레임 | 🔴 최상 |
| A6 | **공식 context-관리 워크플로우** = Sessions(ListEvents/AppendEvent) → Generate memories(extract+merge) → Memory Bank(Retrieve / merge-only) → **memory-as-a-tool** | S5 | Agent Sessions 1945(멀티턴) + Memory Bank fleet recall(GT2 auto-recall) 라이브. **단 "memory-as-a-tool" 명시 패턴은 미적용**(우리는 auto-recall) | 우리 GT2 recall 데모를 이 공식 워크플로우에 매핑. **memory-as-a-tool**(메모리 retrieve를 에이전트 tool로 노출)은 작은 구체적 채택 후보(제출 후·승인 시) | 🟢 중 |
| A7 ⭐ | **마스터 아키텍처 = Gemini Enterprise Agent Platform** (Governance[Agent Registry + Policies&AI protection] → Agent Gateway → Agent Runtime[Agent+**Agent Identity**, Sessions&memory, Model] → Agent Gateway → Other agents/Tools, 하단 Agent Observability) | S6 | Identity(SPIFFE D48)·Registry(라이브)·Policies(prompt-guard/Model Armor/DLP/policy-gate)·Observability(GT1) 보유. **갭: managed Agent Gateway = Google Private-Preview(미부여)** → 정책을 **앱계층에서 집행** | 제출 아키텍처를 **이 공식 마스터 다이어그램**으로 정렬(우리 master-board). Gateway 갭은 HONEST-SCOPE §C(Google-gated) 그대로 정직 표기 | 🔴 최상 |
| A8 | **Govern 가치 프레이밍(발표자 verbatim)**: "agent identity로 모든 에이전트에 정책을 **런타임에 agent gateway가 집행** → 에이전트가 **하면 안 될 일/통신하면 안 될 서비스를 못 하게**" | S6(자막) | 우리 `external_send` scope(gmail.send는 policy gate 통과 전 미발사) + prompt-guard = **정확히 이 가치** | 제출 Govern 섹션 카피를 이 공식 언어로 미러("don't do/talk to what they're not supposed to") | 🟡 높음 |
| A11 ⭐ | **결정론 ↔ agent-first 스펙트럼**: "explainability/규제 → **determinism**; 창의성 중요 → **agent-first(모델이 다음 에이전트 결정)**; ADK는 둘 다 지원" | S8(자막) | 우리 = **agents=함수(curated tool·Zod·USD cap·escalation) + Inngest durable 결정론 workflow + policy gate** = 스펙트럼의 **결정론 끝** | 우리 "ReAct 자유루프 아님" 결정을 **약점이 아니라 규제-인지 정답**으로 재프레임(돈·계약·external_send 다루는 B2B). 창의성 필요한 곳(creative/outreach copy)은 모델 재량 = "agent-first로 pivot 가능"도 시연. **Technical-30% 핵심 서사** | 🔴 최상 |
| A12 | **ADK Workflow 3패턴 = Sequential · Loop · Parallel** (Sequential=순서의존, Loop=critic 반복개선+종료조건, Parallel=fan-out/fan-in) | S9(팀요약) | 우리 brand-campaign이 셋 다 인스턴스화: **Sequential**(source→vet→shortlist→outreach→ship→verify→report) · **Parallel**(배송 fan-out=3, vetting×38) · **Loop**(하드닝/optimize critic 재측정) | 제출 카피를 ADK 공식 어휘(Sequential/Loop/Parallel)로 표기 — "우리 durable workflow가 ADK가 정형화한 3패턴을 그대로 구현". 오케스트레이터는 Inngest(durable timer/signal)지만 **패턴은 동일**(정직 표기) | 🟡 높음 |
| A13 (참조) | 모델군(Gemini 3.x·Imagen·**VO**(video)·**Chirp**(audio)·**Lyria**(music)·Gemini **Omni**·3rd-party) · **Antigravity 2.0**(agent-first 코딩툴) · Skills/GDP **35 credits/월** | S9 | 우리는 Gemini 3.5/3.1 + Imagen 4 사용 | 참조만. 멀티모달 확장 여지(VO/Chirp/Lyria)는 로드맵 후보일 뿐 현 제출 무관 | ⚪ 참조 |
| A14 | **견고성: 외부도구 일시실패 흔함 → 재시도·예외처리·호출수 제한 + 429 graceful fallback** (ADK `Graceful429Plugin`/`apply_429_interceptor`) | S10(GENAI106 랩) | capabilities 레이어가 I/O 경계 — 재시도/에러처리 보유 추정. Vertex 429 fallback은 확인 필요 | (검증) capabilities 외부호출(RapidAPI/Gmail/Vertex)의 재시도·429 처리 점검 → 있으면 **Technical-30% production-readiness 근거**로 명시 | 🟡 높음 |
| A10 | **Sessions = 에이전트 간 state 핸드오프 메커니즘** (agent A→sub-agent B에 session으로 memory 전달, 사용자 재입력 불필요; 서브에이전트가 state를 읽어옴) + **리전 간 공유 세션/메모리** | S5-bis(자막) | coordinator→sub-agent 핸드오프 시 **typed 캠페인 컨텍스트** 전달(Inngest step + ADK Sessions 1945) — 다운스트림 에이전트가 재질문 안 함 = 정확히 이 패턴 | 멀티에이전트(req⑤) 카피를 "pass memory through the session" 프레임으로 강화. **리전-간 공유는 미주장**(우리 엔진 단일 리전; MCP Cloud Run만 멀티리전 데모) | 🟡 높음 |
| ~~A9~~ (참조만) | GFS Immersion Badge `goo.gle/GFS-Immersion-Badge` | S7 | — | **액션 아님** — 사용자가 "중요하지 않음, 참조만"으로 판단(2026-06-04). 추적 제외 | ⚪ 참조 |

> 위 A1–A3는 **코드 변경이 아니라 제출-카피/서사 정합** 기회. 마감 전 devpost-track3.md·README에 반영 검토.

---

## S1 — ADK: Build(Skills · MCP · A2A) + 라이프사이클(Build/Scale/Govern/Optimize)

**슬라이드 내용**
- 좌측 레일 = 에이전트 라이프사이클 **Build → Scale → Govern → Optimize** ("Build" 활성).
- **Agent Development Kit (ADK)** 의 Build 단계 3기둥:
  - **Skills** — "Perform efficiently"
  - **MCP** — "For your Google services / For the APIs you depend on"
  - **A2A** — "Collaborate efficiently"

**우리 현재 상태 (대조)**
- ✅ **A2A**: ss-mcp-server A2A v0.3 (`protocolVersion 0.3.0`) 라이브 — 정확히 "Collaborate efficiently".
- ✅ **MCP**: tiktok-mcp-server(MCP) — "for the APIs you depend on"(TikTok) 그 자체.
- ✅ **Skills**: agent.json `skills: [plan_creator_search, get_brand_assets]` — 이미 ADK Skills로 노출 중.
- ✅ **라이프사이클**: PR#70–#72에서 Build(GT1-6)→Scale(Sessions/Memory)→Govern(Registry/DLP)→Optimize(Simulation/thinking budget) **적극 적용** (적합-가중 채택 82%).

**흡수/갭**
- 우리는 스택을 이미 공식 3기둥+4단계로 **다 갖췄지만**, 제출 **서사가 그 공식 용어와 1:1로 안 붙어 있음**(우리는 "Build→Optimize→Refactor" arc 사용).
- → **A1**: 제출에 "이 제품은 ADK의 Build(Skills+MCP+A2A) → Scale → Govern → Optimize 라이프사이클을 따른다"는 **공식-용어 매핑 1줄**을 추가하면, 심사자가 쓰는 바로 그 프레임으로 우리 커버리지가 읽힘. Refactor arc는 유지하되 공식 4단계를 괄호 병기.
- → **A3**: Skills/MCP/A2A를 **각각 한 문장씩** 우리 구현으로 명시(이미 셋 다 라이브라 무료 점수).

---

## S2 — Gemini 3.5 (Flash GA · Pro Coming Soon) + function-calling 루프

**슬라이드 내용**
- "Gemini 3.5 — advanced coding+reasoning를 tool·workflow 실행과 결합해 복잡한 에이전트 구축."
- **Gemini 3.5 Flash `GA`** — "coding/reasoning/real-world 우수. **Gemini 3.1 Pro를 더 빠른 속도 + 1/3 비용으로 능가.**"
- **Gemini 3.5 Pro `Coming Soon`** — "가장 지능적·멀티모달, agentic coding 최적, 다단계 워크플로우 우수." (= **아직 GA 아님**)
- 다이어그램: Application ↔ Gemini **function-calling 루프** (Prompt+Function definition → Decide → Final answer / Function name·argument → Parse·execute → Result of function call → Decide → "Use another function").

**우리 현재 상태 (대조)**
- ✅ **D53 모델법**: `gemini-3.5-flash`(판단+coordinator) + `gemini-3.1-flash-lite`(벌크). **No 2.5 / No *-pro / No Claude.** Vertex `global`.
- ✅ **agent-as-function**: 우리 에이전트는 자유 ReAct가 아니라 **curated tool + Zod/Pydantic I/O + USD cap + escalation** 함수 — 슬라이드의 function-calling 루프와 동일 구조.

**흡수/갭 (가장 중요)**
- 🎯 **D53 외부검증**: 구글이 공식 슬라이드로 "3.5 Flash GA가 3.1 Pro를 **1/3 비용**에 능가"라고 명시 → 우리의 *"3.5-flash 사용, *-pro 미사용"*은 **타협/정직성 문제가 아니라 구글 권고에 부합한 최적 선택**. 제출에서 이 톤으로 격상 가능.
- 🎯 **"3.5 Pro = Coming Soon(미GA)"** → 우리 프로젝트에서 *-pro가 404 나는 이유가 **Google측 미출시/allowlist 미부여** 때문임을 공식 근거로 설명 가능. HONEST-SCOPE의 "*-pro 404" 항목에 이 슬라이드를 근거로 달면 더 단단.
- 🎯 **Business-30% 논거**: "GA 프런티어에서 비용 최적(3.1 Pro 대비 1/3) 모델을 선택" → $0.01/view 단위경제학과 결의 같음. ROI 섹션에 모델-비용 한 줄 보강 검토.
- ⚠️ **주의(정직성)**: 슬라이드는 "3.5 Flash가 3.1 **Pro**를 능가"라고 함. 우리 카피가 "3.5-flash가 모든 3.x를 능가"처럼 과대화되지 않게 — **구글 문구 그대로** "3.1 Pro 대비 1/3 비용·고속" 인용만.

**액션 후보**
- devpost-track3.md "How we built it"/"Honest scope"에 D53 근거로 이 슬라이드(공식 발표) 1줄 인용.
- HONEST-SCOPE의 *-pro 404 행에 "3.5 Pro는 발표 시점 Coming Soon(미GA)" 근거 보강.

---

## S3 — Agent Runtime 레퍼런스 아키텍처 (Scale 단계)

**슬라이드 내용** (좌측 레일 "Scale" 활성)
- **Agent Runtime** (파란 박스, 관리형 런타임) 안에:
  - **Agent** = "Goals, instructions, & skills" (박스가 **스택** = 멀티 에이전트) + "Model-based reasoning/planning"
  - 하단: **Sessions & memory** + **Model**
- 오른쪽 연결: **Tools** = **MCP servers** + **APIs**

**우리 현재 상태 (박스별 1:1)**
| 공식 박스 | 우리 라이브 컴포넌트 |
|---|---|
| Agent Runtime (관리형) | reasoningEngine `2498…` (GT1-6 라이브) |
| Agent: goals/instructions/skills | 22-agent fleet, agent.json `skills` (스택=멀티에이전트와 동일) |
| Model-based reasoning/planning | Gemini 3.x **thinking budget** (`BuiltInPlanner(thinking_level=high)`, PR#72) |
| Sessions & memory | Agent Sessions `1945…` (멀티턴) + Memory Bank (fleet recall) |
| Model | gemini-3.5-flash / 3.1-flash-lite (D53) |
| Tools = MCP + APIs | tiktok-mcp (MCP) + capabilities (APIs) |

**흡수/갭**
- 🎯 **모든 박스가 이미 우리 라이브 컴포넌트** — 공식 Scale 아키텍처의 완전한 인스턴스.
- → **A4**: 제출 아키텍처 다이어그램을 이 공식 박스 구조로 재배치하면, 심사자가 "어, 우리 레퍼런스 아키텍처 그대로네"로 즉시 인식. (naming도 우리 PR#73 "Agent Runtime" 정합과 일치 — 공식 슬라이드가 "Agent Runtime"으로 표기.)
- "Model-based reasoning/planning"이 **독립 박스**인 점 = 우리 thinking-budget 작업이 공식 구성요소임을 검증.

---

## S4 — "Your choice of Runtime": Runtime 레이어 × Agent Platform services ⭐ (최강 슬라이드)

**슬라이드 내용**
- **Runtime 레이어** ("Where your agent's code executes") = 택1: **Agent Runtime · Cloud Run · GKE** — 셋 다 동일한 서비스 레이어로 연결.
- **Service 레이어** ("How you empower and manage your Agents") = **Agent Platform services** 6개:
  1. **Sessions and memory**
  2. **Observability**
  3. **Code execution and tools**
  4. **Identity**
  5. **Evaluation**
  6. **Registries**

**우리 현재 상태 (서비스 6개 + 런타임 매핑)**
| 공식 Agent Platform service | 우리 라이브 증거 |
|---|---|
| Sessions and memory | Agent Sessions `1945…` (8 events 멀티턴) + Memory Bank (per-user fleet recall) |
| Observability | **GT1** Cloud Trace 7-span (traceId `dc063…`) |
| Code execution and tools | capabilities(typed fns) + MCP tools(tiktok-mcp) + ADK FunctionTool |
| Identity | SPIFFE `spiffe://ss-mcp-prod…` + OIDC + Identity Platform 멀티테넌트 |
| Evaluation | **GT3** GenAI Evaluation(client-side 3.5 judge) + golden-eval holdout floor |
| Registries | **GT/Govern** Agent Registry 라이브 read (`agent_engines.list()` 3 엔진) |
| Runtime 레이어 | **Agent Runtime**(reasoningEngine 2498) **+ Cloud Run**(ss-mcp/ss-v2-web) = 3개 중 **2개** 동시 시연 |

**흡수/갭 (제출 최강 레버)**
- 🎯 우리는 **공식 서비스 레이어 6개를 전부**, **런타임 3개 중 2개**를 라이브로 커버 — 이건 "native platform adoption"의 **공식 정의 그 자체에 대한 완전 커버리지**.
- → **A5(최상)**: HONEST-SCOPE·platform-fit 리포트·devpost "How we built it"을 **이 공식 6개 서비스명에 1:1 매핑한 표**로 재구성. 우리 82% 채택률을 "공식 6개 서비스 × 라이브 증거"로 환산하면 심사자가 보는 바로 그 체크리스트가 됨.
- ⚠️ **정직성**: 6개 중 일부는 GT(라이브 1회 실증)·stub→live seam이 있으니, 표에 라이브/operator-gated 구분을 HONEST-SCOPE 톤 그대로 유지(과대화 금지).
- naming: "Agent Platform services" / "Agent Runtime" = 우리 명칭정책(Gemini Enterprise Agent Platform · Agent Runtime, PR#73) 정합 재확인.
- 우측 하단 "Sprint" 워터마크 = 발표 맥락(이 세션이 sprint 가이드)일 뿐, 액션 없음.

---

## S4-bis — (재촬영본) "Your choice of Runtime"
S4와 동일 슬라이드의 선명한 재촬영 — 새 내용 없음. **S4 분석/매핑 확정**(Runtime 3 중 2 + Agent Platform services 6/6). A5 유효.

---

## S5 — "Manage context": Sessions ↔ Memory Bank 개발자 워크플로우

**슬라이드 내용** ("personalized, cross-session, secure agent development")
- **Sessions** (Agent Engine): `ListEvents` / `AppendEvent`
- → **Generate memories (Extract, merge)**
- → **Memory Bank** (Agent Engine): `Retrieve memories` / `Generate memories (Merge only)`
- **Agent** (Client, user): AppendEvent로 Sessions에 기록; Retrieve memories를 수신; **`memory-as-a-tool`** 로 Memory Bank 호출
- 흐름: Sessions(이벤트 누적) → 메모리 추출·병합 → Memory Bank(저장/검색) → Agent로 회수, **memory-as-a-tool** 패턴

**우리 현재 상태 (대조)**
| 공식 요소 | 우리 |
|---|---|
| Sessions / ListEvents / AppendEvent | Agent Sessions `1945…` (8 events 멀티턴 영속) |
| Generate memories (extract, merge) | Memory Bank 메모리 생성 (auto) |
| Memory Bank / Retrieve memories | GT2 auto-recall (env-pinned scope; ER 미지정 쿼리→`min_engagement_rate=13`→@_alejandrauve) · fleet per-user(wooriliu 13%, glowco 8%→4) |
| `memory-as-a-tool` | **미적용** — 우리는 명시 tool 호출이 아니라 auto-recall |
| personalized · cross-session · secure | fleet-wide per-user 교차세션 recall = 정확히 이 가치 |

**흡수/갭**
- 🎯 우리 GT2 cross-session per-user recall = 슬라이드의 "personalized, cross-session" 그 자체 → 제출에서 이 공식 워크플로우 다이어그램에 우리 recall을 매핑.
- 💡 **새 패턴 = `memory-as-a-tool`**: 메모리 retrieve를 에이전트가 **명시 tool**로 부르는 구조. 우리는 auto-recall이라 한 단계 다름. → **A6**: 작은 구체적 채택 후보(제출 후 또는 승인 시). 지금은 **지식만 축적**(사용자 지시: 커밋/PR 금지).
- "Generate memories" 의 **extract+merge vs merge-only** 두 모드 구분도 우리 Memory Bank 운용에 참고(중복 누적 방지).
- naming: 슬라이드는 "Agent Engine"이라 표기(다이어그램 내부 라벨). 공식 표시명은 "Agent Runtime"으로 이동했으나 SDK/내부는 Agent Engine 잔존 — 우리 명칭정책(PR#73: 표시명 Agent Runtime, 코드식별자 잔존 허용)과 정확히 일치.

---

## S6 — "Gemini Enterprise Agent Platform" 마스터 아키텍처 (Govern 단계) ⭐ + verbatim 나레이션
> 출처: `cloudonair.withgoogle.com/events/gfs_immersion2026/watch?talk=talk-2-od` (Image #7/#8/#9)

**슬라이드 내용 (전체 플랫폼도)**
- 플랫폼명: **Gemini Enterprise Agent Platform** (= 우리 명칭정책의 공식 플랫폼명, PR#73 정합).
- **Governance** (상단): **Agent Registry** + **Policies & AI protection**
- **소비자** (좌, 주황): **Gemini Enterprise · Workspace · Custom apps**
- → **Agent Gateway** (좌) → **Agent Runtime** (Agent + **Agent Identity**[강조] · Sessions&memory · Model) → **Agent Gateway** (우) → **Other agents · Tools**
- 하단 전폭: **Agent Observability**
- 점선: Governance가 양쪽 **Agent Gateway를 통해 런타임에 정책 집행**.

**발표자 verbatim (자막, Image #8/#9 — 우리 카피에 미러 가능)**
- *"agent identity lets you enforce policies on every single agent and these policies are enforced **at runtime by the agent gateway**."*
- *"This ensures that your agents **don't do things they're not supposed to be doing or don't talk to services they're not supposed to be talking to**."*
- *"agent observability lets you look at **how your agents are performing, how they're scaling, how your agents are talking to one another**."*

**우리 현재 상태 (박스별 대조)**
| 공식 박스 | 우리 라이브 | 비고 |
|---|---|---|
| Governance · Agent Registry | GT/Govern `agent_engines.list()` 라이브 read | ✅ |
| Governance · Policies & AI protection | prompt-guard + Model Armor(sanitize) + Cloud DLP(PII) + policy gate(`external_send`) | ✅ (앱계층) |
| 소비자 Gemini Enterprise/Workspace/Custom apps | A2A discovery(Gemini Enterprise) + 우리 Mission Control(custom app) | ✅ |
| **Agent Gateway** (정책 런타임 집행점) | **managed Gateway 미부여(Google Private-Preview)** → 정책을 **앱계층에서 집행** | ⚠️ **갭(정직표기)** |
| Agent Runtime · Agent Identity | SPIFFE `spiffe://ss-mcp-prod…` (D48) | ✅ 강조박스 = 우리 보유 |
| Sessions & memory / Model | Sessions 1945 + Memory Bank / 3.5-flash·3.1-lite | ✅ |
| Other agents / Tools | A2A → tiktok-mcp + 22-agent fleet | ✅ |
| Agent Observability | GT1 Cloud Trace 7-span + per-run trace + cost ledger | ✅ |

**흡수/갭**
- 🎯 **A7(최상)**: 이 슬라이드가 **마스터 아키텍처**. 우리 제출 아키텍처/마스터보드를 이 도형으로 정렬하면, 우리가 거의 모든 박스를 라이브로 채운 게 한눈에. **유일한 진짜 갭 = managed Agent Gateway(Private-Preview, 미부여)** — 우리는 동등 정책을 **앱계층(prompt-guard·policy gate·DLP)** 에서 집행. HONEST-SCOPE §C에 이미 Google-gated로 있음 → 그대로 유지.
- 🎯 **A8**: 발표자 verbatim "don't do things / don't talk to services they're not supposed to" = 우리 **`external_send` scope**(gmail.send는 policy gate 미통과 시 미발사)와 **정확히 동일 가치**. Govern 섹션 카피를 이 공식 언어로 미러.
- 🎯 **Observability verbatim** "performing / scaling / talking to one another" = 우리 **A2A cross-call trace**가 "agents talking to one another"를 그대로 보여줌(GT1). Observability 증거를 이 3축(성능·확장·상호통신)으로 캡션.

**청중 채팅 신호 (시장/포지셔닝 인텔)**
- Anshul: *"메모리 늘면 토큰/컴퓨트 비용도 증가 → 어떻게 해결?"* → 우리 **Memory Bank merge-only + cost ledger + $0.01/view 단위경제학**이 이 실제 우려에 답. Business-30% 카피에 "메모리-비용 통제" 한 줄 후보.
- Karan: *"Google Search Console MCP 있나?"* / Abhijit: *"핸즈온 빌드 언제?"* → 청중은 MCP·실전 빌드에 관심. 우리의 **실제 라이브 MCP+A2A**가 차별점(대부분 아직 빌드 전).
- (라이브캡션 도구 `livecaps` = 발표자 나레이션 STT — 우리 흡수의 1차 출처로 신뢰)

---

## S5-bis — Sessions/Memory 운용 verbatim 나레이션 (Image #11/#12, 슬라이드 없음)

**발표자 verbatim (Sessions/memory 심화)**
- *"That is where you have a **shared session or shared memory between all your regions**."* (리전 간 공유 세션/메모리)
- *"given session, if there is some information that you want to **pass on to your sub agent you can do that using the session**."*
- *"agent A looks for a place to travel; when you want to do the booking it **hands it over to agent B / sub agent B** — you don't want the user to tell again where they want to go... so it makes sense to **pass the memory through the session**."*
- *"The sub [agent] could actually **go and read the systems and pick it up from there**."* / *"depends on your use case how you want to **build your systems to pull out this state**."*

**핵심 개념 → 우리 대조**
- **Sessions = 에이전트 간 state 핸드오프 채널**: agent A→sub-agent B로 컨텍스트를 넘겨 사용자 재입력을 없앰. → 우리 coordinator→sub-agent 핸드오프가 **typed 캠페인 컨텍스트**(브리프·shortlist·creator)를 넘겨 다운스트림이 재질문 안 하는 것과 동일. **A10** = 멀티에이전트(req⑤) 카피를 이 프레임으로 강화.
- **리전 간 공유 세션/메모리** = Scale 단계 멀티리전 스토리. ⚠️ 우리 reasoningEngine은 단일 리전(엔진 us-central1·RAG us-west1)이라 **"리전 간 공유 메모리"는 미주장**(MCP Cloud Run 멀티리전 데모만 사실). 과대화 금지.

**청중 채팅 신호**
- *"Is session like threads in LangGraph?"* → session=대화 스레드 멘탈모델. 우리 Sessions 1945(멀티턴 8 events)로 설명 가능.
- *"How will AI help in Governance? what tools will google build for AI governance?"* → Govern 관심 지속(A7/A8 가치 재확인).

---

## S8 — Q&A: 결정론적 워크플로우 vs 유연성/설명가능성 ⭐ (우리 핵심 아키텍처 검증)
> Image #13/#14/#15, 자막 14:50:xx (슬라이드 없음, Q&A 나레이션)

**질문(청중)**: *"금융·헬스케어처럼 규제 엄격한 환경에서 deterministic workflows를 선호하나? 스타트업은 agent-workflows에서 **유연성 vs 설명가능성** 균형을 어떻게?"*

**답변(발표자 verbatim)**
- *"This is the key — the **highly regulated environment**. Each environment/vertical: what regulations must be followed — for example **explainability is pretty important, and when you want explainability it means you want some sort of determinism**."*
- *(deterministic) "...that calls agent A first, then agent B, and so on."*
- *"**Whereas in other environments where determinism is not so important, maybe creativity is key.** ...but you still need to know what is happening, in which case you can still **pivot to using agent-first workflows where the model determines what agents to call next based on what you're doing**."*
- *"**ADK ... lets you build any kind of graph or any kind of workflow depending on your use case.**"*

**왜 이게 우리에게 최상위 레버인가 (A11)**
- 우리의 **중심 설계 결정** = "agents are **FUNCTIONS** the workflow invokes (curated tools, Zod output, USD cap, escalation) — **NOT free ReAct loops**" + **Inngest durable 결정론 오케스트레이션** + **policy gate**. → 이건 정확히 스펙트럼의 **결정론(deterministic) 끝**.
- 발표자: 그 결정론을 **규제·설명가능성 환경이 요구**한다 → 우리 도메인(돈·계약·`external_send` 외부발송)이 바로 그 환경. 따라서 우리 선택은 **"덜 화려한 타협"이 아니라 규제-인지한 정답**.
- 동시에 우리는 **agent-first로 pivot 가능**(창의성이 중요한 creative/outreach copy 에이전트는 모델 재량 큼) → "둘 다 지원"의 ADK 철학과 정합.
- → **A11**: 제출 Technical-30%/How-we-built에서 **"우리는 의도적으로 결정론적 typed-function workflow를 택했다 — 규제·설명가능성·비용통제가 중요한 B2B이기에. 창의 영역은 agent-first로 연다"** 서사를 명시. (모든 호출 typed·traced·cost-metered·policy-gated = explainability 증거.)

**청중 채팅 신호**
- *"What metrics/frameworks to evaluate latency & accuracy of Gemini-based agents?"* (Vivek) → 우리 **golden-eval + holdout floor + cost ledger + per-run trace**가 답. 제출에 "평가 프레임" 한 줄 강화 후보.
- *"How does ADK handle inter-agent state propagation, recommended...?"* → A10(session 핸드오프)와 동일 관심.
- (참고) 한 참가자 채팅: *"...NEES Core Engine, a governance runtime layer for production AI apps... focus is identity continuity, memory boundaries..."* = 거버넌스-런타임 영역 **peer/경쟁 스타트업** 존재. 경쟁 인텔로 가볍게 메모(우리는 실제 라이브 제품으로 차별).

---

## S9 — 팀원 정리 전체 세션 요약 (코드랩, 2026-06-04 14:40–16:08) — 출처: 팀원(상근) 노트

> 슬라이드가 아니라 **세션 전체 요약**(다른 팀원 제공). S1–S8을 확증 + 코드랩 실습으로 새 구체 항목 추가.

**S1–S8 확증 (중복 — 이미 흡수)**: Agent Platform 통합(모델/도구/런타임/세션·메모리/거버넌스/옵저버빌리티) · Agent Runtime serverless(+Cloud Run/GKE) · Sessions+Memory Bank · Identity+Gateway 런타임 정책집행 · Observability(호출흐름/상호작용/스케일) · 결정론 vs agent-first 스펙트럼. → A1·A4·A5·A7·A8·A10·A11 재확인.

**새 구체 항목 (코드랩에서)**
1. **ADK Workflow Agent 3패턴** (→ **A12**):
   - **Sequential** — researcher→screenwriter→file writer (순서 의존)
   - **Loop** — critic 추가한 "writer's room" 반복개선 + 종료조건
   - **Parallel** — pre-production team(box office researcher + casting agent) fan-out/fan-in
   - 우리 매핑: brand-campaign = Sequential(전체 루프) + Parallel(배송 ship/customs/tracking ×3, vetting×38) + Loop(하드닝 재측정). **공식 어휘로 표기 가능.**
2. **root → sub-agent 위임 패턴**: root agent = 진입점/steering, sub-agent로 위임. 예제: root가 "국가 미상→travel brainstormer, 국가 확정→attractions planner"로 **라우팅**. → 우리 **coordinator = root agent**, 조건부 라우팅과 동일. 교훈: *"root agent는 steering만 잘해도 UX 크게 향상"*, *"sub-agent는 description/instructions로 능력 추론되나 복잡 시스템은 root에 힌트 추가가 유용"*.
3. **State 전달 메커니즘** (→ A10 구체화): 기본은 **빈 컨텍스트**에서 시작; `save_attractions_to_state` 같은 **tool로 state 저장** → prompt 템플릿에서 `{attractions}` 참조 → 다음 에이전트가 이어받음(재입력 제거). "shared memory 자동 아님 — session/memory/tool 설계에 따라 달라짐". → 우리 typed-contract 핸드오프와 동일 사상.
4. **ADK web UI** = trace/transfer/tool-call/state 변화 시각화 (개발·검증). → 우리 per-run trace/observability와 같은 목적.
5. **외부 프레임워크 도구 재사용**: LangChain Wikipedia tool 등을 ADK에 그대로 import. → 확장성 근거.

**참조만 (→ A13, 제출 무관)**
- **모델군**: Gemini 3.x · Imagen(이미지) · **VO**(video) · **Chirp**(audio) · **Lyria**(music) · Gemini **Omni** · 3rd-party. (우리=Gemini 3.5/3.1 + Imagen 4.)
- **Google Antigravity 2.0** = agent-first 코딩/빌드 툴 모음(신제품 언급).
- **Google Skills / GDP** 가입 + **35 credits/월** = 실습 크레딧 메커니즘(운영자/참조).
- 코드랩 절차(임시 1.5h 환경 프로비저닝, Cloud Shell ADK 설치 등) = 실습 가이드, 제출 무관.

**설계 교훈 (우리 서사 보강용)**
- *멀티에이전트 > 단일 거대 에이전트* (역할분리·디버깅·유지보수) → 우리 22-agent fleet 정당화.
- *Sequential=단계의존 / Loop=품질개선·불확실성해소 / Parallel=독립작업 동시* → 워크플로우 선택 근거를 이 기준으로 설명 가능.
- *observability + governance(identity/policy)는 실서비스에서 특히 중요* → 우리 GT1 trace + policy gate + DLP의 "production-ready" 논거.

**(참고) 상근님 "배지 안 나오나요"** = 채팅의 `goo.gle/GFS-Immersion-Badge` 리다이렉트 이슈(공식 이메일이면 google.com으로 리다이렉트될 수 있음). **이미 "중요치 않음, 참조만"으로 결정 → 액션 없음.**

---

## S10 — GENAI106 핸즈온 ADK 멀티에이전트 랩 (코드 레벨) — 출처: `~/livecaps/claudedocs/2026-06-04-adk-multiagent-lab-learning.md`

> S1–S9 개념을 **구체 ADK API/코드**로 내려준 실습 완주 기록(팀원 작성, 다른 리포). 환경: `google-adk==1.30.0`, `gemini-2.5-flash`(랩 기본), `GOOGLE_CLOUD_LOCATION=global`.

**A12 구체화 — ADK Workflow Agent 실제 API**
- **SequentialAgent**(`sub_agents=[...]` 순서대로 1회씩) — 한 출력이 다음 입력.
- **LoopAgent**(`sub_agents`, `max_iterations`) — 사용자 개입 없이 반복; 종료 = `max_iterations` 도달 **또는** 하위가 **`exit_loop` 도구 호출**. critic이 좋으면 `exit_loop`, 아니면 `append_to_state`로 `CRITICAL_FEEDBACK` 누적. 종료 시 상위로 escalate.
- **ParallelAgent**(동시 실행, 기본 **state/이력 비공유**) — 각자 **`output_key`로 결과를 state 저장** → 후속 단계가 `{ key? }`로 읽어 **gather(수집·병합)**.
- **CustomAgent** — 조건분기/커스텀 오케스트레이션(존재만 인지).
- **우리 매핑(또렷해짐)**: brand-campaign = **Sequential**(source→…→report) + **Parallel**(배송 ship/customs/tracking, `output_key`→merge) + **Loop**(하드닝 optimize critic 재측정 ≈ LoopAgent(critic→exit_loop, max_iterations 안전캡)). → 제출을 이 **공식 API 어휘**로 기술.

**A10 구체화 — Session State 공유 메커니즘**
- 계층 트리는 부모에 **`sub_agents=[...]` 지정만으로** 정의(자식에 parent 안 넣음). root_agent가 진입점, sub의 **`description`만으로 자동 전이**(instruction에 `name`으로 더 명확화; peer 전이 기본 허용, `disallow_transfer_to_peers=True`로 차단).
- 도구로 state 쓰기: `def tool(tool_context: ToolContext, ...)` → `tool_context.state[...]`(상태 dict), `tool_context.events`(이력). 도구는 `{"status":"success"}` dict 반환이 best practice.
- instruction에서 읽기: **`{ key? }` 템플릿**(`?`=키 없어도 에러 X). 응답 전체 저장은 **`output_key`**. 누적은 **`append_to_state`**.
- → 우리 typed-contract(Zod/Pydantic) 핸드오프 = 동일 사상의 **타입드 강화판**. "빈 컨텍스트에서 시작, session/state로 공유"가 ADK 기본.

**A14 신규 — 견고성/production-readiness**
- 외부도구(Wikipedia 등) **일시 빈응답 → JSONDecodeError로 런 전체 중단**이 실습에서 자주 발생. `handle_tool_error=True`도 못 잡음. LoopAgent가 짧은 시간 다회 호출 시 throttle 확률↑. 완화 = 재시도·호출수 제한(max_iterations↓)·구체적 입력.
- **`Graceful429Plugin` + `apply_429_interceptor(root_agent)`** = 할당량(429) 시 fallback 텍스트. `App(name, root_agent, plugins=[...])`.
- → **우리 액션(A14)**: capabilities 레이어의 외부호출(RapidAPI/Gmail/Vertex) **재시도·429 graceful fallback** 점검. 있으면 "외부 일시실패에 견고" = Technical-30% production-readiness 근거.

**⚠️ 모델 주의 (D53 정합)**
- 랩 `.env` 기본 = `MODEL=gemini-2.5-flash` (랩 안정성용 구버전). **우리 D53은 2.5 금지(3.5/3.1만)**. 키노트 S2가 "3.5 Flash GA가 3.1 Pro를 1/3 비용에 능가"라고 했으므로 **우리 3.x가 랩 기본보다 현행/우월** — 랩 따라 2.5로 내리지 말 것. (단 `GOOGLE_GENAI_USE_VERTEXAI=TRUE` + `LOCATION=global`은 우리와 동일 = 정합.)

**참조(제출 무관)**: `adk run`(CLI) / `adk web`(Dev UI: Trace/State/Artifacts/Sessions/Eval 탭) · `before/after_model_callback` · 실습 함정(에이전트 정의 순서 NameError, `--reload_agents` stale runner 500, heredoc EOF 들여쓰기) — 코드랩 운영 팁.

**takeaway(우리 서사 보강)**: "큰 프롬프트 1개 → 작은 전문 에이전트 워크플로"가 신뢰성·유지보수↑(= 우리 22-agent fleet 정당화). 패턴 선택 기준: 순서의존=Sequential / 반복개선=Loop / 독립=Parallel.

---

## S7 — "Developer Profile and Badge" (참조만, 중요도 낮음)
- **`goo.gle/GFS-Immersion-Badge`** (QR). 발표자가 등록 권유했으나 **사용자 판단: 중요하지 않음 → 참조만, 액션/추적 제외**.

---

<!-- 다음 슬라이드는 여기 아래에 S8, S9 ... 로 append -->
