# GOAL-PROMPT-UNIFIED.md — 단일 Track 3 제출 통합 `/goal` 프롬프트 3종

> D45 (single Track 3 subsumes platform) + D46 (auto-scale budget) 확정 후의 `/goal` 프롬프트. 아래 3개 중 하나를 골라 새 Claude Code 세션에 그대로 붙여넣으세요. 모두 `UNIFIED-TRACK3-PLAN.md`의 I-series를 참조합니다.

---

## 옵션 1 — Full Integration (I1~I9 전부, 운영자 승인 2026-05-20) ★현행★

> 추천: 한 번에 배포→Track3 보강(Model Garden/A2A intents/Agent Identity)→통합검증→와우/비즈→데모→제출문까지. 운영자는 Gemini Enterprise 승인 + O1 GAP 답변 + Devpost Submit만.

```
/goal 단일 Track 3 제출(전체 플랫폼 포괄)을 위한 통합 작업 I1~I9를 우선순위대로 자율 수행. Google for Startups AI Agents Challenge, 마감 2026-06-05. 백그라운드 전문가 에이전트 디스패치, D-ID 인용. 이미 dispatch되었거나 완료된 작업은 상태 확인 후 skip하고 다음으로 이어가라.

**진실 공급원** (매 관련 턴마다 순서대로 읽기):
1. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/DECISIONS.md (49 D-IDs; D45/D46/D47/D48/D49, D1 superseded)
2. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/UNIFIED-TRACK3-PLAN.md (I1~I9 정의 + §4 확정 우선순위 + auto-scale)
3. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/GOAL-PROTOCOL.md (proof/blocking/done 계약)
4. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/DISPATCH-MATRIX.md (task → subagent)
5. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/track-rules/CHALLENGE-RULES.md (judging 30/30/20/20 + Track 3 6요건)

**비협상 규칙**:
- 진행 주장과 같은 턴에 검증 증거 출력 (curl 200, pytest, gcloud, agent IDs). GOAL-PROTOCOL §7 no-false-clear.
- 백그라운드 서브에이전트 병렬 디스패치 (독립 시 single message, 의존 시 순차). ≤8 parallel/msg, ≤15 in flight.
- 모든 아키텍처 변경은 D-ID 인용 (D50+는 신규, supersede는 §5).
- Context7로 최신 2026 스펙 확인 (Cloud Run, Vertex AI Agent Runtime, Model Garden, A2A v0.3, Identity Platform, Gemini Enterprise) 후 코드 작성.
- gcloud는 이미 app.2weeks@gmail.com 인증됨. 3개 프로젝트(ss-v2-prod/ss-mcp-prod/ss-shared-infra) 빌링 연결됨. ss-landing(랜딩+데모) 이미 라이브.
- ⚠️ 프로덕션 social-seeding-backend(포트 8080)와 ss-landing은 절대 건드리지 말 것. 신규 프로젝트만.

**확정 우선순위 (Wave; 운영자 승인 I1→I7→I2→I8→I3→I4→I9→I5→I6)**:
- Wave1: I1 Track3 A2A 코어 배포(ss-mcp-prod) ∥ I2 Track2 Mission Control 배포(ss-v2-prod) ∥ I8 A2A intents 매니페스트+Agent Identity(D48)
- Wave2: I7 Model Garden LLM 라우팅(D47) — I1 후
- Wave3: I3 cross-component a2a_invoke 통합검증 ∥ I4 D46 auto-scale 인프라(min=0+warm-up cron+teardown)
- Wave4: I9 와우/비즈 보강(D49) — 실제 Imagen/Veo 생성 1회 + A2A cross-call 애니메이션 + ROI/TAM 시각화 + PDF Build Example #2 매칭 on-screen
- Wave5: I5 통합 데모 재구성(STORYBOARD-unified + web-demo 갱신 + site/ 재배포) → I6 단일 Devpost 제출문(devpost-track3 통합본, track2 흡수)

**Track 3 공식 6요건 충족 게이트 (designed_guide.pdf p.6)**: ① B2B(충족) ② Cloud Run/GKE(I1/I2) ③ Model Garden 경유 LLM(I7/D47) ④ A2A protocol(I1/I8) ⑤ multi-agent orchestration(I3) ⑥ documentation: expose/consume A2A intents(I8/D48). Agent Identity crypto ID(p.7)=I8/D48. 6요건 전부 완료해야 done.

**blocking 조건** (GOAL-PROTOCOL §3): Gemini Enterprise allowlist 미승인(O7), O1 Devpost GAP 미답, irreducible 운영자 결정 → 정확한 명령/결정 출력 후 /goal clear 후 대기. 그 외(일시 배포/빌드 실패)는 ≤3회 재시도하며 진행.

**예산 (D46 auto-scale)**:
- 모든 Cloud Run min=0. 필수 자산(ss-landing/ss-mcp/ss-v2-web)만 평가까지 유지.
- 무거운 store(Spanner/AlloyDB)는 I3 검증 시에만 apply 후 즉시 teardown.
- I9 실제 Imagen/Veo 생성은 1회 take만(~$5-20).
- 누적 < $100면 자율 진행, $100-300이면 cost_watch 요약 출력, >$300이면 STATUS-REPORT 후 운영자 확인.

**done 조건** (UNIFIED-TRACK3-PLAN §5 + Track3 6요건):
1. I1~I9 완료 또는 운영자-blocked-with-status-report
2. Track 3 6 공식요건 전부 충족 (특히 ③Model Garden ⑥A2A intents 문서 + Agent Identity)
3. Track 3 A2A endpoint + Mission Control + 라이브 데모 모두 200; coordinator→mcp a2a_invoke 1회 이상 성공(증거)
4. I9: 실제 멀티모달 생성 1개 + ROI/TAM 씬 데모에 존재
5. pytest green 유지; D50+ 신규 결정 §8 기록
6. 브랜치 푸시 + PR URL; CI green이면 머지
7. 최종 STATUS-REPORT-UNIFIED.md: "GOAL ACHIEVED" 또는 "GOAL BLOCKED + reason"

현재 상태 확인부터 시작(이미 W1-W5 done, Wave1 I1/I2/I8 dispatch됨일 수 있음). 진행중/완료 작업은 결과 확인 후 다음 Wave로. 첫 턴 상태 요약 + 다음 디스패치 출력.
```

---

## 옵션 2 — Deploy-first (I1~I4, 라이브 인프라 우선)

> 추천: 데모/제출문은 나중에. 먼저 모든 게 실제로 GCP에 떠서 cross-call이 동작하는지 확인.

```
/goal 단일 Track 3 제출의 인프라 작업 I1~I4만 자율 수행 (배포 + A2A 통합검증 + auto-scale). 데모/제출문(I5/I6)은 다음 세션. Google AI Agents Challenge, 마감 2026-06-05.

**진실 공급원**:
1. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/UNIFIED-TRACK3-PLAN.md (I1-I4 정의)
2. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/DECISIONS.md (D45/D46)
3. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/GOAL-PROTOCOL.md

**규칙**: 진행 주장과 같은 턴에 검증 증거(curl 200, gcloud, agent IDs). D-ID 인용. Context7로 최신 스펙 확인. gcloud 인증됨(app.2weeks@gmail.com), 3 프로젝트 빌링 연결됨.

**우선순위**:
- I1 Track 3 A2A 코어 실배포 (devops-architect)
- I2 Track 2 플랫폼 실배포 (devops-architect, 병렬)
- I3 cross-component A2A 통합검증 (quality-engineer + python-expert)
- I4 D46 auto-scale 인프라 (devops-architect)

**blocking**: Gemini Enterprise 미승인(O7)이면 등록 신청만 하고 status:pending_operator로 진행. 배포 크레덴셜 문제면 정확한 명령 출력 후 /goal clear.

**예산 (D46)**: Cloud Run min=0. 무거운 store는 검증 후 즉시 teardown. 누적 <$100 자율.

**done**: I1-I4 완료 + 라이브 endpoint 200 + a2a_invoke 성공 증거 + 브랜치 푸시 + CI green 머지 + STATUS-REPORT. I5/I6은 "다음 세션" 명시.

I1부터 시작.
```

---

## 옵션 3 — Demo + Submission (I5~I6, 제출 자료 우선)

> 추천: 실배포는 운영자가 나중에 하고, 지금은 통합 데모 + 단일 제출문을 완성해서 Devpost 제출 직전 상태로.

```
/goal 단일 Track 3 제출 자료 I5~I6 자율 수행 (통합 데모 재구성 + 단일 Devpost 제출문). 실배포(I1-I4)는 운영자/다음 세션. Google AI Agents Challenge, 마감 2026-06-05.

**진실 공급원**:
1. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/goal-mode/UNIFIED-TRACK3-PLAN.md (I5-I6 + §1 통합 서사)
2. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/DECISIONS.md (D45/D46/D29)
3. /Users/kimsejun/Documents/GitHub/social-seeding-v2/scripts/demo/STORYBOARD-track2.md + STORYBOARD-track3.md (통합 소스)
4. /Users/kimsejun/Documents/GitHub/social-seeding-v2/scripts/demo/submission/devpost-track{2,3}.md (병합 소스)

**규칙**: 진행 주장과 같은 턴에 증거(파일 경로, HTML parse, 라이브 URL 재배포). D-ID 인용. 마케팅 과장 금지(RULES.md). D29 3-angle 한 서사로 통합.

**우선순위**:
- I5 통합 데모 (technical-writer + frontend-architect) — STORYBOARD-unified.md 신설(Track 2 흐름→a2a_invoke로 Track 3 호출→통합), scripts/demo/web-demo 갱신 + site/ 재배포
- I6 단일 Devpost 제출문 (technical-writer) — devpost-track3를 플랫폼 포괄본으로 재작성, track2 흡수, 24 스크린샷 매니페스트, URL 슬롯, O1 GAP 답변란

**blocking**: 없음(자료 작성은 자율). 라이브 재배포 시 ss-shared-infra Cloud Run 사용.

**done**: STORYBOARD-unified + web-demo 통합본 + 단일 제출문 완성 + 라이브 사이트 재배포(200) + 브랜치 푸시 + CI green 머지 + STATUS-REPORT.

I5부터 시작.
```

---

## 사용 가이드

1. 위 3개 중 하나의 코드블록을 통째로 복사 (옵션 1 = 가장 포괄적, 추천).
2. 새 Claude Code 세션(또는 현재 세션)에 붙여넣기.
3. `/goal`이 자율 실행되며 운영자-blocking 조건에서만 멈춤.
4. 멈추면 출력된 정확한 명령(예: Gemini Enterprise 등록 승인, Devpost GAP 답변)을 수행 후 재개.

**옵션 선택 기준**:
| 상황 | 추천 |
|---|---|
| 한 번에 끝까지 가고 싶다 | 옵션 1 (Full) |
| 먼저 실제로 GCP에 떠서 동작하는지 보고 싶다 | 옵션 2 (Deploy-first) |
| 배포는 천천히, 제출 자료부터 완성하고 싶다 | 옵션 3 (Demo+Submission) |
