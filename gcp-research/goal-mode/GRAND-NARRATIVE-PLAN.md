# GRAND-NARRATIVE-PLAN.md — 단일 대서사 Track 3 제출 (Grand Prize 정조준)

> **확정**: user 2026-05-20 (공식 Rules PDF 검증 후). **나누지 않는다.** 하나의 대서사로 Build→Optimize→Refactor를 한 줄기로 묶어 **단일 Track 3 제출**을 만든다. 목표는 테마 상이 아니라 **Overall Grand Prize**. D45 재확정, 이중 제출(이번 세션에 검토되었던 안)은 폐기. 신규 결정 **D50**.
>
> **마감**: 2026-06-05 17:00 PT (제출). 심사 6/11–18, 발표 ~6/22. 오늘 2026-05-20 기준 D-16.
>
> 이 문서는 `UNIFIED-TRACK3-PLAN.md`(I-series 배포 계획)를 대체하지 않고 **그 위에 서사·와우·기술킥·갭클로징을 얹는 상위 전략 문서**다. 실행은 §9의 `/goal` 프롬프트로 시작한다.

---

## 1. 결정과 상금 논리 (공식 Rules로 검증됨)

공식 Rules PDF (`https://s3.amazonaws.com/devpost-public/Google/DfT/Google for Startups AI Agents Challenge Rules.pdf`) 확인 결과:

- **복수 제출은 허용되나 "unique and substantially different"** 해야 함 (Sponsor/Devpost 재량 판정).
- **1 프로젝트 = 최대 1 상** ("Each Project is eligible for up to one (1) Prize" / "A Submission can win a maximum of one prize").
- 상금: **Grand Prize $15K + $10K credits (1, 전체 최고점)** · Best of Each Theme $10K + $7.5K (3, Build/Optimize/Refactor 각 1) · Regional $5K + $2.5K (2, APAC & EMEA).
- 참가 자격: 제외국에 **North Korea만** 있고 **South Korea는 자격 있음**. 한국 = **APAC** → Regional 상도 사정권.

**왜 단일 대서사인가 (전략 근거)**:
1. 1 프로젝트 = 1 상이므로, 나눠도 각 제출은 1상이 한계이며 둘 다 노력이 분산되어 약해진다.
2. **Grand Prize는 테마 무관 전체 최고점** — 단일 압도적 제출만 노릴 수 있는 최대치이며 어떤 테마 상보다 크다.
3. 200% 한 곳에 쏟은 제출 → Grand 정조준 + 못 잡아도 Refactor 테마 + APAC Regional 사정권.
4. 제출 1개라 "substantially different" 판정 리스크가 없다.

→ **집중이 곧 최적.** Track 2(Optimize)의 시그니처 작업은 별도 제출이 아니라 **이 단일 Track 3 제출의 Technical-30% 증거("우리는 단련했다" 챕터)로 흡수**한다.

---

## 2. 하나의 대서사 아크 (Build → Optimize → Refactor, 한 줄기)

공식 가이드(`designed_guide.pdf`)의 Smart Facility Energy Agent 예시 자체가 한 에이전트의 3단계 성숙기다. 우리도 동일하게 **한 함대의 성숙기**로 서술한다:

> **[Build]** 22-agent 함대가 인플루언서 캠페인 전 루프(source → vet → outreach → reply → ship → verify → report)를 자율 실행한다.
>
> **[Optimize · 기술킥]** 우리는 이걸 단련했다. 크리에이터 답신이 모호할 때(예: "관심 있는데 단가 협상") responder가 결정 정지하던 stalled logic을 — **Agent Simulation**으로 합성 엣지케이스를 만들고, **Agent Observability**로 멈춘 추론을 추적하고, **Agent Optimizer**로 시스템 지침을 개선해 신뢰성을 **X% → Y%**로 끌어올렸다.
>
> **[Refactor · 본진]** 그리고 엔터프라이즈로 리팩터했다 — Cloud Run + **Model Garden** 경유 추론 + 에이전트마다 암호학적 **Agent Identity** + 함대 전체 **A2A-native**. `content_verify`가 고객사 **DAM Agent**를 호출해 브랜드 자산을 받고(공식 가이드 **Build Example #2** 정확 매칭), `coordinator`가 우리가 OSS로 기여한 `tiktok-mcp-server`를 **A2A 노드로 발견·호출**한다.
>
> **[Innovation]** 한국은 Marketplace 결제 region에서 제외된다(D2). 그래서 우리는 **A2A-only 분배 경로**를 개척했다 — 그 한계가 곧 비-Marketplace-region 스타트업 일반해(D3)다.

**한 문장 핵심**: "sandbox에서 작동하던 함대를, 단련해서 신뢰성을 입증하고, 엔터프라이즈 A2A 생태계로 리팩터해, region 제약 없이 분배한다."

---

## 3. 4축 rubric 매핑 (Tech 30 / Business 30 / Innovation 20 / Demo 20)

| 축 | 무엇으로 충족 | 근거/D-ID |
|---|---|---|
| **Technical 30** | Optimize 단련(Simulation·Observability·Optimizer + 측정된 before/after) + A2A 실배선 + Model Garden 라우팅 + Agent Identity | D47·D48·D50, 4-expert 갭클로징 |
| **Business 30** | B2B 메시징 + ROI/TAM($0.01/view) + A2A-only 분배(비-Marketplace-region 일반해) | D3·D28·D49 |
| **Innovation 20** | KR-region-gap → A2A-only 분배 + OSS `tiktok-mcp-server` 기여 | D2·D3·D29-B |
| **Demo 20** | 멀티모달 라이브 생성 + A2A cross-call 애니메이션 + Observability "정지→수리" trace + 실 Gmail 발송 + Build Example #2 on-screen | D30·D49 |

핵심: **Optimize "단련" 챕터는 Technical 30 증거이자 Demo 20의 최고 와우 장면(정지→수리 trace)** — 1석2조.

---

## 4. 시각적 와우 극대화 (Demo 20%)

데모는 8× 실조작 녹화(D30). 와우 장면 우선순위:

1. **Observability "정지 → 수리" trace** — 추론 그래프가 stalled되는 장면 → Optimizer 적용 후 흐르는 장면. 기술 증거이자 가장 강력한 시각 와우(1석2조).
2. **A2A cross-call 애니메이션** — `coordinator` → OSS `tiktok-mcp` 노드 왕복, `content_verify` ↔ DAM Agent. 노드 생태계가 서로 호출되는 모습.
3. **실제 Imagen/Veo 생성 라이브** (stub 아님, `CAPABILITY_LAYER_MODE=live` 1 take) — 멀티모달 킥.
4. **Mission Control 실시간 함대 뷰** + 실제 Gmail 발송 + 8-intent 분류.
5. **ROI/TAM 씬** — $0.01/view 모델 정량 시각화.
6. **Build Example #2 on-screen 콜아웃** — "공식 가이드의 marketing+DAM 예시 = 우리 content_verify".

---

## 5. 기술적 킥 극대화 (Technical 30%) — 4-expert 갭 클로징 포함

데모에서 *실제로 작동*해야 킥이 된다. 4-전문가 read-only 리뷰(2026-05-20, [[project_v2_track3_review]])가 찾은 갭 = 그대로 to-do:

| ID | 작업 | 닫는 갭 | Owner |
|---|---|---|---|
| **G1** | A2A 호출을 실제 Cloud Workflow 1개에 배선 (coordinator step + transport switch → `a2a_invoke` → tiktok-mcp) | A2A가 오케스트레이션에 미배선 (workflow YAML이 coordinator/a2a 미호출) | backend-architect |
| **G2** | Model Garden 라우팅 ≥1 에이전트 실연결 (D47, 현재 stub) | Model Garden stub | devops-architect + python-expert |
| **G3** | runtime `_run_with_adk` 실 Gemini 경로 ≥1 통합테스트 (conftest `SS_OFFLINE` 우회) | 실 추론 커버리지 0% | quality-engineer |
| **G4** | 정직성 정정 3종(`AGENT-IDENTITY.md` a2a 행 / `agent.json` mTLS 디스클로저 / `REQUIRE_AUTH` 단일화) + CI 게이트 복원(pytest+golden eval) | 문서 과대/과소표기, CI가 verify-build만 | security-engineer |
| **G5** | `a2a_invoke` live host allowlist (SSRF) + prompt_guard 어휘 커버리지 확장 | SSRF, prompt_guard 우회 | security-engineer |

### 5-1. "단련(Hardening)" 챕터 = 흡수된 Optimize 툴체인 (Technical 핵심)

| ID | 작업 | DoD |
|---|---|---|
| **H1** | stalled-logic 시나리오 1개 확정 (권장: `conversation_responder`의 "interested-but-negotiating" 모호 답신 → auto-respond ↔ escalate 정지) | 시나리오 + 베이스라인 실패 케이스 명시 |
| **H2** | Agent Simulation — 합성 엣지케이스 N개(협상/거절위장/다국어/감정혼재) + 베이스라인 통과율 측정 | 합성셋 + baseline 숫자 |
| **H3** | Agent Observability — 실패 케이스 추론 trace 캡처(정지 지점 시각화) | trace 아티팩트(데모 장면 #1) |
| **H4** | Agent Optimizer — 시스템 지침 프로그램적 개선 + 재측정 | **before/after 메트릭 표** (예: 60%→92%) |
| **H5** | golden evalset 러너 배선(현재 미배선) + 홀드아웃 분리(현재 expected=정답 오버핏 구조) | `adk eval` 실행 가능 + 홀드아웃 |

---

## 6. 갭 클로징 실행 순서 (Wave)

기존 `UNIFIED-TRACK3-PLAN.md`의 I-series(I1 배포 done, I2 done, I8 done 등) 위에 G/H-series를 얹는다.

```
이미 done: W1-W5, Wave1 (I1 Track3 배포 · I2 Track2 배포 · I8 A2A intents 문서)

Wave A (기술 토대 — 데모의 전제):  G1 A2A 실배선 ∥ G2 Model Garden 실연결 ∥ G4 정직성+CI
Wave B (단련 챕터 — Technical 핵심): H1→H2→H3→H4→H5  (+ G3 실 추론 테스트, G5 보안)
Wave C (통합 검증):                 I3 cross-component a2a_invoke 통합 smoke + G1 결과 검증
Wave D (와우/비즈):                 I9/D49 — 실 Imagen/Veo 1 take + A2A 애니메이션 + ROI/TAM + Build Example #2 콜아웃
Wave E (대서사 데모 + 단일 제출문):  I5 STORYBOARD를 Build→Optimize→Refactor 한 아크로 재구성 → I6 단일 Devpost 제출문(Grand Prize 겨냥)
```

원칙: **G1·G2(실배선)가 모든 데모의 병목** → 최우선. H-series(단련)는 Technical 30 + Demo 최고 장면이라 그 다음. 와우(I9)는 검증된 흐름 위에.

---

## 7. 정직한 범위·리스크 (RULES.md: 과장 금지)

- 51개 ADK 도구 중 48개가 live에서 `NotImplementedError`(W7 deferred). **데모 critical path에 닿는 도구만 live 승격**(G2 Model Garden, I9 Imagen/Veo, G1 A2A). 나머지는 "capability-layer 인터페이스는 실재, GCP 백엔드 연결은 단계적"이라고 **정직하게 프레이밍**.
- 전부 live화는 D-16 안에 비현실적이며 불필요. 심사는 "데모된 경로의 진짜 동작 + 정직한 범위 표기"를 본다.
- Model Armor / DLP / mTLS enforcement는 stub/Private-Preview 의존(O7) — disclosure로 처리.
- prompt_guard는 real이지만 우회 가능(G5) — Model Armor가 long tail을 담당한다고 서술하지 말 것(현재 stub). 다층 방어 과대표기 금지.

---

## 8. 완료 정의 (Definition of Done)

1. G1~G5 + H1~H5 완료 또는 운영자-blocked-with-status.
2. Track 3 공식 6요건 전부 충족 (B2B · Cloud Run · Model Garden · A2A · multi-agent orchestration · A2A intents 문서) + Agent Identity.
3. 라이브 endpoint 3종(ss-landing/ss-mcp/ss-v2-web) 200; **coordinator→mcp a2a_invoke 실제 Workflow 경유 1회 이상 성공 증거**.
4. **before/after 메트릭(H4)** 데모·제출문에 존재; Observability "정지→수리" trace 장면 존재.
5. 실 멀티모달 생성 1개(I9) + ROI/TAM 씬 존재.
6. pytest green 유지; D50 §8 기록; 정직성 정정(G4) 완료.
7. 대서사 데모(한 아크) + 단일 Devpost 제출문(Grand Prize 겨냥) 완성 + URL 슬롯.
8. 브랜치 푸시 + CI green; STATUS-REPORT "GOAL ACHIEVED" 또는 "BLOCKED + reason".

운영자-전용 잔여(자율 불가): Gemini Enterprise 등록 승인(O7, Google 1-2주), OBS 실녹화(HTML 웹데모로 대체 가능), Devpost Submit 클릭, O1 Devpost GAP 답변.

---

## 9. `/goal` 시작 프롬프트 (복붙용)

> 새 Claude Code 세션(또는 현재 세션)에 아래 코드블록을 통째로 붙여넣으면 자율 실행된다.

```
/goal 단일 대서사 Track 3 제출(Grand Prize 정조준)을 위해 GRAND-NARRATIVE-PLAN.md의 G/H-series + I-series 잔여를 우선순위대로 자율 수행. Google for Startups AI Agents Challenge, 마감 2026-06-05 17:00 PT. 백그라운드 전문가 에이전트 디스패치, D-ID 인용. 이미 done이거나 dispatch된 작업은 상태 확인 후 skip하고 다음으로.

**진실 공급원** (매 관련 턴 순서대로 읽기):
1. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/GRAND-NARRATIVE-PLAN.md (대서사 아크 + G/H-series + Wave + DoD) ★최상위★
2. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/DECISIONS.md (D50 단일 대서사 재확정 포함; D45/D46/D47/D48/D49)
3. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/UNIFIED-TRACK3-PLAN.md (I-series 정의)
4. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/GOAL-PROTOCOL.md (proof/blocking/done 계약)
5. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/DISPATCH-MATRIX.md (task → subagent)
6. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/track-rules/CHALLENGE-RULES.md (judging 30/30/20/20 + Track 3 6요건)

**비협상 규칙**:
- 진행 주장과 같은 턴에 검증 증거 출력 (curl 200, pytest, gcloud, agent IDs, before/after 숫자). GOAL-PROTOCOL §7 no-false-clear.
- 마케팅 과장 금지(RULES.md). stub은 stub이라고 정직하게. 다층 방어 과대표기 금지(§7).
- 백그라운드 서브에이전트 병렬 디스패치(독립 시 single message, 의존 시 순차). ≤8 parallel/msg.
- 모든 아키텍처 변경은 D-ID 인용. 신규는 D51+.
- Context7로 최신 2026 스펙 확인(Cloud Run, Vertex AI Agent Runtime, Model Garden, A2A v0.3, Identity Platform, Gemini Enterprise) 후 코드 작성.
- gcloud는 app.2weeks@gmail.com 인증됨, 3 프로젝트(ss-v2-prod/ss-mcp-prod/ss-shared-infra) 빌링 연결됨, ss-landing 라이브.
- ⚠️ 프로덕션 social-seeding-backend(포트 8080)·ss-landing 절대 미접촉. 신규 프로젝트만.

**Wave 우선순위 (GRAND-NARRATIVE-PLAN §6)**:
- Wave A(기술 토대): G1 A2A 실배선(Cloud Workflow에 coordinator→a2a_invoke→tiktok-mcp) ∥ G2 Model Garden ≥1 에이전트 실연결 ∥ G4 정직성 정정 3종 + CI 게이트 복원
- Wave B(단련 챕터=Technical 핵심): H1 stalled-logic 시나리오(conversation_responder 모호답신) → H2 Agent Simulation 합성셋+baseline → H3 Observability 정지 trace 캡처 → H4 Agent Optimizer 지침 개선+재측정(before/after) → H5 golden eval 러너 배선+홀드아웃 (+ G3 실 추론 테스트, G5 SSRF/prompt_guard)
- Wave C(통합검증): I3 cross-component a2a_invoke 통합 smoke + G1 결과 검증
- Wave D(와우/비즈): I9/D49 실 Imagen/Veo 1 take + A2A cross-call 애니메이션 + ROI/TAM 씬 + Build Example #2 on-screen 콜아웃
- Wave E(대서사): I5 STORYBOARD를 Build→Optimize→Refactor 한 아크로 재구성 → I6 단일 Devpost 제출문(Grand Prize 겨냥, before/after·A2A·멀티모달 전면)

**blocking 조건**(GOAL-PROTOCOL §3): Gemini Enterprise allowlist 미승인(O7), O1 Devpost GAP 미답, irreducible 운영자 결정 → 정확한 명령/결정 출력 후 /goal clear 후 대기. 일시 배포/빌드 실패는 ≤3회 재시도하며 진행.

**예산(D46 auto-scale)**: 모든 Cloud Run min=0. 무거운 store(Spanner/AlloyDB)는 검증 시에만 apply 후 즉시 teardown. I9 실 생성은 1 take(~$5-20). 누적 <$100 자율, $100-300 cost_watch 요약, >$300 STATUS-REPORT 후 운영자 확인.

**done**(GRAND-NARRATIVE-PLAN §8): G/H-series + I 잔여 완료 또는 운영자-blocked; Track3 6요건 충족; 라이브 200 + a2a_invoke 실 Workflow 경유 성공 증거; H4 before/after + Observability trace 존재; 실 멀티모달 1개; pytest green; 대서사 데모 + 단일 제출문 완성; 브랜치 푸시 + CI green; STATUS-REPORT 갱신.

현재 상태 확인부터 시작. 첫 턴: 상태 요약(이미 done/dispatch 식별) + Wave A 디스패치 출력.
```

---

## 10. 참고 문서

- `UNIFIED-TRACK3-PLAN.md` — I-series 배포 계획 (이 문서가 그 위에 서사·갭클로징을 얹음)
- `gcp-research/decisions/DECISIONS.md` — D50(단일 대서사 재확정), D45-D49
- `gcp-research/track-rules/CHALLENGE-RULES.md` — 공식 룰 + 6요건 (이번 세션에 공식 Rules PDF로 §8/§9 GAP 해소)
- `gcp-research/refactor-mcp/A2A-INTENTS.md`, `AGENT-IDENTITY.md` — Track 3 요건 #6 + Agent Identity
- `scripts/demo/STORYBOARD-track{2,3}.md` — I5 대서사 재구성 소스
- 공식 가이드: `https://services.google.com/fh/files/misc/ai_agents_challenge_designed_guide.pdf`
- 공식 룰: `https://s3.amazonaws.com/devpost-public/Google/DfT/Google%20for%20Startups%20AI%20Agents%20Challenge%20Rules.pdf`
