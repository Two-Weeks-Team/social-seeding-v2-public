# Improvement Master Plan — social-seeding-v2

> 작성: 2026-05-28 · 입력: `docs/GOOGLE-CLOUD-NEXT-26-ANALYSIS.md` (6개 전문가 보고서 + 팀장 종합) · `docs/GOOGLE-CLOUD-NEXT-26-RECAP.md`
> 시간/범위 제약 없는 전체 개선 계획. **각 페이즈는 Audit → Plan → 구현 → 검증 → 재평가의 5단계 내부 루프**를 따른다. 페이즈 자체도 동일 루프의 한 단위이며, 페이즈 종료 시 다음 페이즈의 Audit으로 피드백된다.

---

## 0. 방법론 — Audit→Plan→Implement→Verify→Re-evaluate Loop

이 마스터 플랜은 두 수준에서 같은 루프를 동시에 운영한다.

```
[ Master Loop ]                    [ Phase Loop (× 10 phases) ]
                                   ┌────────────────────────────┐
   Audit  ───┐                     │  Audit                     │
            │                      │    ↓                       │
   Plan ────┤                      │  Plan                      │
            │                      │    ↓                       │
   Phase 1 ─┼──── Phase Loop ────▶ │  Implement (sub-tasks)     │
            │                      │    ↓                       │
   Phase 2 ─┤                      │  Verify (exit criteria)    │
            │                      │    ↓                       │
   ...      │                      │  Re-evaluate (feed → next) │
            │                      └────────────────────────────┘
   Re-eval ─┘
```

### 루프 단계 정의

| 단계 | 페이즈 차원 | 서브태스크 차원 |
|---|---|---|
| **Audit** | 입력 데이터(전 페이즈 산출물 + 외부 신호) 검증, entry criteria 확인 | 변경 대상 파일/시스템의 현 상태 측정·캡처 |
| **Plan** | 서브태스크 목록 확정, 의존성·작업량·소유자 명세 | 코드/문서의 정확한 diff 사양 작성 |
| **Implement** | 서브태스크 순서대로 실행 (병렬·직렬 명시) | Read → Edit/Write/Bash → 즉시 단위 검증 |
| **Verify** | exit criteria 충족 확인 (테스트·메트릭·문서 동기화) | verify-build, test, lint, screenshot 등 게이트 통과 |
| **Re-evaluate** | 산출물이 다음 페이즈의 Audit 입력에 적합한지 확인. 미충족 시 재계획 | 의도 충족 여부, 부작용 발생 여부 점검 |

### 재평가 트리거 (페이즈 도중 재계획 발동 조건)

- **블로커**: 외부 의존(Google Support case, OAuth scope 승인 등) 지연 ≥ 14일
- **사고**: 라이브 사고 발생 시 현 페이즈 일시 중단 → 사고 대응 페이즈 삽입
- **데이터 변화**: HONEST-SCOPE/DECISIONS의 transitive change (예: D54 결정)
- **비용 폭증**: 월 청구 baseline 대비 ≥ 200% 증가 시 비용 제어 페이즈 우선
- **새 외부 정보**: Google 신제품 출시, 컴플라이언스 변경 등

### 추적 산출물

- 페이즈별 audit 보고서: `claudedocs/phaseN-audit-YYYY-MM-DD.md`
- 페이즈별 verify 증거: `claudedocs/phaseN-verify-YYYY-MM-DD.md`
- 결정 원장: `gcp-research/decisions/DECISIONS.md` (D54+ 신설)
- 진행 보드: `docs/IMPROVEMENT-MASTER-PLAN-STATUS.md` (페이즈별 ✓/IP/⬜ 표시)

---

## 1. Phase Map (개요)

| Phase | 이름 | 트리거 | 대략 기간 | 핵심 산출물 | 병렬 가능 | 외부 의존 |
|---|---|---|---|---|---|---|
| **P0** | Audit Baseline & Setup | 즉시 | 0.5일 | 베이스라인 측정, 추적 보드 | — | — |
| **P1** | Pre-Submission Hardening | P0 종료 후 | D-8 (6-7일) | 즉시 11건 + 공시 11건 완료, 라이브 데모 안전화 | 내부 sub-task 병렬 | — |
| **P2** | Submission & Post-Sub Stabilization | P1 종료 후 | D+0 ~ D+14 | Devpost 제출, 모니터링, 사고 대응 | — | Devpost 승인, 심판 피드백 |
| **P3** | Observability & Eval Coverage Expansion | P2 안정 후 | D+14 ~ D+45 | eval 1/22 → 12/22, Memory Bank fleet 주입, Cloud Trace 대시보드 | P4·P7과 병렬 | — |
| **P4** | Defense Stack Maturity | P2 안정 후 | D+14 ~ D+60 | Chronicle live, Fraud Defense, Wiz 결정 | P3·P5와 병렬 | Chronicle ADC, 외부 라이선스 |
| **P5** | Agent Platform Maturity | Google allowlist 통보 후 | D+30 ~ D+90 | Vertex AI Agent Runtime, Agent Gateway mTLS, Agent Sessions | P3·P4와 부분 병렬 | Google Private Preview 승인 |
| **P6** | Grounding & Data Cloud Integration | P3 완료 후 | D+60 ~ D+120 | Maps Grounding, Knowledge Catalog, Imagery, Earth AI, BigQuery | P7과 병렬 | Maps API quota 확장 |
| **P7** | Frontend & UX Aligned with Deck | P2 안정 후 | D+14 ~ D+90 | 3-패널 레이아웃, Maps UI Toolkit, Workspace Agent | P3·P4·P6와 병렬 | OAuth scope 추가 |
| **P8** | Infra Optimization & Scale | 비용/규모 임계 도달 시 | D+120+ | GKE 마이그레이션 또는 Cloud Run 튜닝 결정 | — | 워크로드 규모 |
| **P9** | Product Backlog Closeout | 운영자 결정 | D+45+ | Carrier, v1 retire, i18n, landing port | P3-P8과 병렬 | 운영자 승인 |
| **P10** | Continuous Improvement & Decision Loop | 상시 | ongoing | D-항목 cadence, LESSONS, 분기 audit | — | — |

**총 추정 작업량**: 즉시 처리 ~12hr · 공시 ~5hr · P3-P9 합계 ~60-90 인일

---

## 2. Phase 0 — Audit Baseline & Setup

### Audit (entry)
- 입력: 6개 전문가 보고서 + 팀장 종합본 + RECAP 데크 정리본 — **이미 디스크에 존재**
- 외부 신호 점검: D-day까지 D-8, 운영자 휴가/제약 없음

### Plan
| 서브태스크 | 산출물 | 작업량 |
|---|---|---|
| P0.1 — 현 상태 측정 캡처 (verify-build, pnpm test, pytest, golden-eval) | `claudedocs/phase0-audit-2026-05-28.md` | 30min |
| P0.2 — 라이브 서비스 status 캡처 (`curl /healthz`, Cloud Run revisions, 최근 7일 빌링) | 같은 파일에 합본 | 30min |
| P0.3 — 추적 보드 초기화 (`docs/IMPROVEMENT-MASTER-PLAN-STATUS.md` 생성, A1-A11/B1-B11/C1-C11/X1-X6 행렬) | 추적 보드 파일 | 30min |
| P0.4 — `git` 상태 정리: 현재 미커밋 4개(CLAUDE.md, RECAP, ANALYSIS, gcnext26-analysis/) 커밋 정책 결정 | DECISION 1줄 | 15min |

### Implement
- 순차 실행. P0.4는 운영자 의사결정 필요 (커밋/PR 또는 보류).

### Verify (exit)
- ✓ 모든 게이트(verify-build, pnpm test, pytest, golden-eval) green으로 캡처됨
- ✓ 추적 보드 파일 생성 + 모든 finding ID가 행으로 존재
- ✓ 라이브 서비스 응답 시간/상태 1회 캡처
- ✓ P0.4 의사결정 기록

### Re-evaluate
- 캡처된 베이스라인이 P1 audit의 입력에 충분한가? 부족하면 캡처 항목 추가.

---

## 3. Phase 1 — Pre-Submission Hardening (D-8 Sprint)

> 목표: 제출 시점(2026-06-05) 에 (a) **정직성 신뢰가 흔들리지 않음** (b) **라이브 데모 사고 가능성 최소화** (c) **데크 정렬을 disclosure 수준에서 일치**.

### Audit (entry)
- P0의 베이스라인 + 추적 보드에서 A* + B* + X* 항목 = 28개 finding이 미해결로 표시되어 있음
- 외부 의존 없음 (전부 자체 처리 가능)

### Plan — 5개 서브-스프린트로 분할

| Sub | 이름 | 항목 | 합계 시간 | 책임 영역 |
|---|---|---|---|---|
| **1.1** | 정직성·문서 일관성 | A1, B1, B2, B3, B5, B7, B9, B10, B11, X1, X2, X6 | ~6hr | docs |
| **1.2** | 보안 즉시 강화 | A2, A3, X4 | ~3hr | security/backend |
| **1.3** | 22-agent fleet 실증 | A4, A6, A7, A8, A9, B6, B8 | ~6hr | backend/docs |
| **1.4** | UX a11y 패치 | A10, A11 | ~1hr | frontend |
| **1.5** | Observability quick-win | A5, B4, X3, X5 | ~2hr | backend/docs |

총 ~18hr. 운영자 1인이 6-7일에 걸쳐 처리 가능 (일 3hr).

#### 의존성 / 순서 제약

- **Sub-1.2 (보안)을 먼저** — 라이브 데모 동안 사고가 곧 다른 작업을 망친다.
- Sub-1.3의 A4는 이미 4/4 pass된 결과 캡처 → 디퍼해도 위험 없지만 A4가 B6의 입력 (built-with 태그 근거).
- Sub-1.1의 A1은 X2의 모순을 푸는 마스터 키 — 다른 문서 작업의 source-of-truth.
- Sub-1.4는 마지막에 — 가시적 변경이라 데모 영상 재촬영 가능성.
- Sub-1.5의 A5(latency span)는 A11(Lighthouse)과 연관 (관측 가능성 종합 스토리).

권장 일자 분배 (D-8 = 5/28 → D-1 = 6/4):

| 일자 | 작업 |
|---|---|
| 5/28 (오늘) | P0 (1.5hr) + Sub-1.2 (A2, A3, X4) — 보안 먼저 |
| 5/29 | Sub-1.1 절반 (A1, B1-B3) |
| 5/30 | Sub-1.1 나머지 (B5-B11, X2, X6) + Sub-1.3 시작 (A4 캡처) |
| 5/31 | Sub-1.3 (A6, A7, A8) |
| 6/1 | Sub-1.3 마감 (A9, B6, B8) + Sub-1.5 시작 (A5) |
| 6/2 | Sub-1.5 마감 (B4, X3, X5) + Sub-1.4 (A10, A11) |
| 6/3 | 전체 verify (verify-build, pnpm test, pytest, golden-eval 재실행) + 데모 영상 재확인 |
| 6/4 | 운영자 final review + 제출 직전 백업 |

### Implement (서브태스크 명세)

#### Sub-1.2 보안 (먼저 처리)

**1.2.a — A2 ss-mcp Cloud Armor rate-limit** (1-2hr)
```bash
# Audit
gcloud compute security-policies list --project=ss-mcp-prod
# Plan
# Cloud Armor 정책 생성 + ss-mcp-server backend service 연결, IP당 100 req/min
# Implement
gcloud compute security-policies create ss-mcp-ratelimit --project=ss-mcp-prod
gcloud compute security-policies rules create 1000 \
  --security-policy=ss-mcp-ratelimit \
  --action=rate-based-ban \
  --rate-limit-threshold-count=100 \
  --rate-limit-threshold-interval-sec=60 \
  --ban-duration-sec=600 \
  --conform-action=allow \
  --exceed-action=deny-429 \
  --enforce-on-key=IP
# Cloud Run service 연결은 Serverless NEG + LB 필요
# Verify: 100 req/min 초과 시 429 응답 확인 (curl 루프)
# Re-eval: 정상 트래픽 false positive 없는지 4hr 관찰
```

**1.2.b — A3 promptGuard editedPayload** (30min)
- `apps/web/app/api/approvals/[id]/resolve/route.ts:19` Zod 스키마 강화
- `packages/workflows/src/gate.ts:173` 다음 단계 전달 직전 promptGuard 호출
- vitest 추가: 인젝션 패턴 거부

**1.2.c — X4 REQUIRE_AUTH 4중 표기 정합** (1hr)
- `live-evidence-2026-05-24.txt` 재확인 → 실제 배포 값 확정
- 4개 파일 동기화: Dockerfile, cloud-run.yaml, agent.json, HONEST-SCOPE.md

#### Sub-1.1 정직성·문서 일관성

**1.1.a — A1 마스터 동기화** (1.5hr)
- 진실 source: `CHECKLIST.md §4` 10-item 리스트 + 실제 HONEST-SCOPE.md 17행
- 동기화 대상:
  - `devpost-track3.md:425` 16→17행, 카테고리 갱신
  - `devpost-track3.md:291` 2925→2924
  - `CHECKLIST.md` G-1 2925→2924, G-10 카테고리
  - `SCREENSHOTS-MANIFEST.md §0` Hero 명세 교체
- diff 미리보기를 추적 보드에 첨부 후 적용

**1.1.b-i — B1-B3, B5-B11 disclose 추가** (4hr 합)
- 각 항목: HONEST-SCOPE.md에 행 추가/수정
- 진실 검증: 코드/배포 yaml에서 실제 동작 확인 후 기재

**1.1.b-ii — X2 단일 source-of-truth 정책 수립** (30min)
- `docs/SUBMISSION-NUMBERS.md` 파일 신설 (검증된 수치만 모음)
- 다른 문서는 이 파일을 참조

#### Sub-1.3 22-agent fleet 실증

**1.3.a — A4 agents-cli eval 결과 캡처** (2hr)
```bash
cd agents-cli-app
uv run agents-cli eval run --all > /tmp/agents-cli-eval-2026-05-28.txt
# 결과를 claudedocs/agents-cli-eval-2026-05-28.txt로 복사
# HONEST-SCOPE.md row 18 신설
# Devpost Optimize 섹션에 1줄 추가
```

**1.3.b — A6 serve.py healthz 명시** (30min)
- `serve.py:107-111` _ROUTES와 별개로 `_ALL_AGENTS_DEFINED = [...22...]`
- `healthz()` 반환에 `agents_defined: 22, agents_routed: [coordinator, sourcing, vetting]`

**1.3.c — A7 research grounding=true 캡처** (30min)
- 1회 ResearchInput(groundingEnabled=True) 실행
- 결과 `claudedocs/research-grounded-capture-2026-05-28.json`
- README:154 주석 추가

**1.3.d — A8 conversation_responder mini-eval** (1-2hr)
- `triage_sim.py`에서 56-case 추출
- `conversation.evalset.json` (8-10 case + holdout)
- `python -m evals --agent conversation --holdout-floor 0.7` 통과 확인

**1.3.e — A9 _heuristic_rank 로깅** (30min)
- ranker code 진입점에 logger.warning 1줄 추가
- ss-mcp-server 배포 (rev 신설 또는 patch)

**1.3.f — B6, B8 태그·deploy disclose** (1hr)
- built-with-tags.txt 정리
- agents-cli deploy 시도 (또는 disclose)

#### Sub-1.5 Observability

**1.5.a — A5 agent.latency_ms span** (1hr)
- `runtime.py:444` elapsed_ms 추출
- `observability.py:141` record_outcome 시그니처 확장
- pytest observability 케이스 업데이트

**1.5.b — B4, X3 Model Armor 범위 명시** (30min)
- README:156 + HONEST-SCOPE row 3 명세

**1.5.c — X5 측정 sprint 통합** (30min)
- A5 + A11(다음) + B3(비용) + B11(SLO) 결과를 단일 measurement.md로 통합

#### Sub-1.4 UX

**1.4.a — A10 일괄 a11y 패치** (30min)
- StageBar 한국어 라벨
- Button focus-visible
- ActivityTimeline aria-live

**1.4.b — A11 MC 본체 Lighthouse 측정** (30min)
- `pnpm --filter @ss/web dev` → Lighthouse 실행
- baseline 캡처 → A10 적용 후 재측정

### Verify (exit)

게이트 (모두 통과해야 P1 종료):

| 게이트 | 명령/방법 | 목표 |
|---|---|---|
| 1 | `pnpm run verify-build` | green |
| 2 | `pnpm test` | 421+ 통과 (A8로 conversation eval 추가 시 +N) |
| 3 | `pytest -q` (agents-adk) | 2924+ 통과 |
| 4 | golden-eval gate | PASS (holdout ≥ 70%) |
| 5 | A4 caputure file 존재 | `claudedocs/agents-cli-eval-2026-05-28.txt` |
| 6 | A7 caputure file 존재 | `claudedocs/research-grounded-capture-2026-05-28.json` |
| 7 | `curl /healthz`로 22 defined / 3 routed 확인 | 응답 JSON 검증 |
| 8 | Cloud Armor 활성화 확인 | `gcloud compute security-policies describe` |
| 9 | promptGuard 인젝션 거부 테스트 | 신규 vitest 통과 |
| 10 | HONEST-SCOPE 17행 일관성 | grep 카운트 |
| 11 | Lighthouse a11y baseline 캡처 | 점수 ≥ 90 권장 |
| 12 | 데모 영상의 가시 정보가 갱신된 수치와 일치 | 운영자 시각 확인 |

### Re-evaluate
- 12개 게이트 중 1개라도 실패 시: 어느 sub-task로 회귀?
- 신규 결정(D54+) 발생 시: DECISIONS.md 등재
- 운영자 final review에서 추가 disclose 요구 시: 보드에 신규 finding 추가, 처리 우선순위 재계산

---

## 4. Phase 2 — Submission & Post-Sub Stabilization

### Audit (entry)
- P1의 12개 게이트 모두 통과
- 라이브 데모 영상 + Devpost 카피 + 스크린샷 manifest 일관

### Plan
| Sub | 이름 | 산출물 |
|---|---|---|
| 2.1 | Devpost 제출 클릭 (운영자 전용) | 제출 confirmation |
| 2.2 | 라이브 서비스 모니터링 강화 — Cloud Monitoring 알람 (5xx, 비용, Model Armor block 빈도) | 알람 3개 신설 |
| 2.3 | 사고 대응 런북 작성 (`claudedocs/incident-runbook.md`) | 런북 |
| 2.4 | 제출 시점 HONEST-SCOPE freeze (`docs/HONEST-SCOPE-SUBMITTED-2026-06-05.md`로 스냅샷) | 스냅샷 |
| 2.5 | 심판 피드백 수신 채널 (이메일/이슈 트래커) 모니터링 | 응답 SLA 24hr |

### Implement
- 2.1은 운영자 전용
- 2.2-2.4는 자동화 가능

### Verify (exit)
- 제출 확인 (Devpost 응답 캡처)
- 14일간 라이브 사고 0건 또는 사고 대응 후 RCA 작성
- HONEST-SCOPE freeze 완료

### Re-evaluate
- 심판 피드백 / 커뮤니티 reaction → P3-P10 우선순위 조정
- 비용 실측치 → P8 트리거 여부 결정

---

## 5. Phase 3 — Observability & Eval Coverage Expansion

> 목표: "22-agent fleet" 주장을 **eval 기준으로 12/22 이상 커버**하고, Cloud Trace 대시보드로 라이브 추적 가능하게 만든다.

### Audit (entry)
- P1.3에서 eval coverage 2/22 + healthz 22 defined / 3 routed가 명시되어 있음
- Memory Bank 백엔드는 존재하나 fleet 미주입 (#1 G6)
- A5에서 agent.latency_ms span만 추가됨

### Plan
| Sub | 항목 | 작업량 | 우선 |
|---|---|---|---|
| **3.1** | eval 확장 — coordinator·conversation 외 10개 에이전트 | 10인일 | 높음 |
| **3.2** | Memory Bank fleet-level injection (C8) | 6-8hr | 높음 |
| **3.3** | Cloud Trace 대시보드 + cost attribution per agent | 2-3일 | 중간 |
| **3.4** | Holdout regression CI gate (P1.3에서 part 만 됨) | 1-2일 | 중간 |
| **3.5** | Vertex Agent Evaluation 라이브 1회 실행 (Google-side가 허용하는 한) | 1일 | 낮음 |

#### Sub-3.1 eval 확장 — 우선순위 10 에이전트

데모 워크플로에서 직접 보이는 순서:
1. `sourcing` — 핵심, 라이브 호출 빈도 1위
2. `vetting` — 핵심, sourcing 다음
3. `outreach_writer` — gmail.send 직전, 정확도 영향
4. `logistics` — 운송 결정
5. `content_verify` — 컨텐츠 검증
6. `analyst` — 리포트 정확도
7. `research` (lead) — 그라운딩 직결
8. `lead_outreach` — sales-lead 분기
9. `intake` — 캠페인 시작
10. `compliance` — 정책 게이트

각 에이전트마다:
- 12-20 case (train 8 / dev 2 / holdout 2-4)
- holdout 70% floor
- CI `python -m evals --agent <name>` 추가

#### Sub-3.2 Memory Bank fleet 주입

- `runtime.py`의 `run_agent` 도입부에 `memory.recall(agent_id, ctx.userId)` 호출
- 결과를 prompt 시스템 메시지에 주입
- 종료 시 `memory.remember(agent_id, ctx, outcome)` 호출
- 22-agent 일괄 적용 (per-agent opt-out 플래그)

### Implement
- Sub-3.1은 병렬 가능 (에이전트별 독립)
- Sub-3.2는 단일 변경점이지만 모든 에이전트의 회귀 테스트 필요

### Verify (exit)
- eval coverage 12/22 (≥ 54.5%)
- Memory Bank recall hit rate 측정치 캡처
- Cloud Trace 대시보드 URL + 스크린샷
- HONEST-SCOPE row 갱신 (1/22 → 12/22)

### Re-evaluate
- 신규 결정 후보: **D54 — eval coverage 진실성 정책** (모든 신규 에이전트는 eval 동반 머지)
- 신규 결정 후보: **D55 — Memory Bank 사용 정책** (어느 에이전트가 user-scoped memory 가짐)

---

## 6. Phase 4 — Defense Stack Maturity

> 목표: 데크 Slide 05의 6개 카드(Threat Hunting / Detection Engineering / Dark Web / Wiz / Model Armor / Fraud Defense) 중 라이브 1개 → **3개 이상으로 확장**.

### Audit (entry)
- P1.2에서 Cloud Armor rate-limit + promptGuard editedPayload 완료
- Model Armor는 ss-mcp-server에만 적용 (X3 disclosure 완료)
- Chronicle SecOps 도구 3개(query, tenant_quarantine, query_blocks)는 stub 상태

### Plan
| Sub | 항목 | 외부 의존 | 작업량 |
|---|---|---|---|
| **4.1** | Chronicle SecOps live wiring (C4 부분) | Chronicle 인스턴스 프로비저닝 + ADC | 3-5일 |
| **4.2** | Model Armor를 ADK 플리트 `runtime.py`에 래핑 (#3 P3 옵션 B) | 없음 | 1-2일 |
| **4.3** | Fraud Defense + reCAPTCHA Enterprise — sales-lead 봇 방어 | OAuth scope 추가, Firebase | 2-4일 |
| **4.4** | Wiz Red/Blue/Green 도입 결정 + (선택) PoC **(C6)** | 라이선스 평가 | 1주 |
| **4.5** | Threat Hunting Agent / Detection Engineering Agent — 자체 구현 (단, Mandiant 의존 X) | — | 1-2주 |
| **4.6** | Dark Web Intelligence — 외부 API 계약 시 — 또는 DLP redaction 강화 **(C5)** | 외부 계약 | 평가만 |

### Implement
- 4.2를 먼저 (외부 의존 없고 X3 모순 해소)
- 4.1, 4.3 병렬 가능 (다른 외부 의존)
- 4.5는 4.1 완료 후 (Chronicle 데이터를 입력으로 받는 에이전트라 동기 필요)

### Verify (exit)
- 4.2: Model Armor 적용된 ADK 플리트 1회 jailbreak 테스트 → 차단 확인
- 4.1: Chronicle live 쿼리 1회 실행 결과 캡처
- 4.3: reCAPTCHA Enterprise 토큰 검증 1회 실측
- 보안 sprint 통합 RCA → HONEST-SCOPE Defense 섹션 재작성

### Re-evaluate
- 사고 발생 시 P4 우선순위 상향
- Wiz 라이선스 비용이 ROI 미달이면 4.4 디퍼
- 4.5의 자체 구현 ROI가 Google managed product 대비 작으면 보류

---

## 7. Phase 5 — Agent Platform Maturity

> 목표: 데크 Slide 02-03의 Agent Platform 컴포넌트 (Runtime / Gateway / Sessions / Memory Bank / Studio) 중 **Google-gated 제품의 production 전환**.

### Audit (entry)
- P3.2에서 Memory Bank fleet 주입 완료
- Vertex AI Agent Runtime + Agent Gateway mTLS + Agent Sessions는 Google Private Preview
- agents-cli deploy 미실행 (B8 disclose)

### Plan
| Sub | 항목 | 외부 의존 |
|---|---|---|
| **5.1** | Vertex AI Agent Runtime (C1) 마이그레이션 — managed runtime으로 전환 | Google allowlist 통보 |
| **5.2** | Agent Gateway mTLS enforcement (C2) — Identity Platform tenant 활용 | Google Private Preview 승인 |
| **5.3** | Agent Sessions managed (C3) — InMemoryRunner 제거 | Google Sessions API GA |
| **5.4** | Anomaly Detection managed (C9) — 자체 watchdog 대체 평가 | Google Anomaly Detection 가용성 |
| **5.5** | Agent Studio 채택 결정 (B6 후속) | UI 평가, ROI 판단 |
| **5.6** | agents-cli deploy live (B8) — ss-agents Cloud Run과 공존/전환 결정 | — |

### Implement
- 5.6을 먼저 (가장 작은 게이트, 외부 의존 없음)
- 5.1-5.4는 Google 측 통보 도달 시 시작
- 5.5는 evaluation 단계 → 채택 시 별도 sprint

### Verify (exit)
- 5.1 완료 시: Cloud Run ss-agents traffic 100% → Agent Runtime
- 5.2 완료 시: mTLS handshake 실증 (Wireshark 또는 audit log)
- 5.3 완료 시: 세션 cross-invocation 데모
- 5.4 완료 시: 자체 watchdog 제거 또는 보완 결정
- 5.5 채택 결정 캡처 (DECISIONS.md D-항목 신설)

### Re-evaluate
- 외부 의존 ≥ 60일 지연 시: managed 제품 대신 자체 구현 유지 결정
- 비용 폭증 시: managed 비용 vs Cloud Run 비용 분석

---

## 8. Phase 6 — Grounding & Data Cloud Integration

> 목표: 데크 Slide 11-23 (Grounding) + Slide 04 (Data Cloud) 신제품 중 **우리 도메인(인플루언서 캠페인)에 ROI 있는 것**을 통합.

### Audit (entry)
- P1.3.c에서 research grounding=true 캡처 1회
- BigQuery 미사용, Knowledge Catalog 미사용
- Maps Grounding / Imagery / Earth AI 미사용

### Plan
| Sub | 항목 | 우리 도메인 적용처 | 우선 |
|---|---|---|---|
| **6.1** | Maps Grounding Lite (via MCP) | TikTok creator 거주지 검증 (가짜 계정 탐지) | 높음 |
| **6.2** | Imagery Grounding | content_verify의 brand asset/장소 검증 | 중간 |
| **6.3** | Knowledge Catalog | 22-agent 플리트의 메타데이터·툴 카탈로그 | 중간 |
| **6.4** | BigQuery analytics integration | 캠페인 데이터 분석, 비용 attribution | 중간 |
| **6.5** | Earth AI | sales-lead 지역 분석 (회사 위치 + 시장 지수) | 낮음 |
| **6.6** | Deep Research Agent | research 에이전트와 통합 또는 대체 결정 | 낮음 |
| **6.7** | Cross-Cloud Lakehouse | Mongo Atlas (AWS) + Vertex (GCP) 패턴을 정식 도입 | 낮음 — narrative 가치 |

### Implement
- 6.1을 먼저 (가장 큰 ROI: creator 검증 정확도 향상이 캠페인 성공률 직결)
- 6.2 다음 (content_verify는 라이브 사고 위험 영역)
- 6.3, 6.4 병렬 가능
- 6.5, 6.6, 6.7은 evaluation 단계 후 결정

### Verify (exit)
- 6.1: creator 거주지 검증 정확도 측정 (before/after)
- 6.2: content_verify의 brand asset 정확도 측정
- 6.3: Knowledge Catalog에 22-agent 메타데이터 등록 완료
- 6.4: BigQuery 데이터셋 1개 라이브 (campaign_costs, agent_traces)
- 디퍼 항목은 HONEST-SCOPE에 명시

### Re-evaluate
- Maps API quota 한계 도달 시 6.1 throttle 정책 필요
- 6.4 BigQuery 비용 vs 가치 — 임계치 도달 시 디퍼

---

## 9. Phase 7 — Frontend & UX Aligned with Deck

> 목표: 데크 Slide 06 (Workspace) + Slide 33 (Maps Agentic UI Toolkit) + Slide 39-41 (Real-Time Monitoring 패턴) **시각적 정렬**.

### Audit (entry)
- P1.4에서 a11y 패치 완료, MC 본체 Lighthouse baseline 캡처
- Maps Agentic UI 미적용
- Workspace 통합 (Gmail Chat agent) 미적용

### Plan
| Sub | 항목 | 데크 출처 | 작업량 |
|---|---|---|---|
| **7.1** | 3-패널 모니터링 레이아웃 — 좌(타임라인) / 가운데(canvas) / 우(approval inbox) | Slide 39-41 | 2-3일 |
| **7.2** | Maps Agentic UI Toolkit — sourcing 결과를 지도 카드로 | Slide 33 | 3-5일 |
| **7.3** | Workspace Agent — Gmail Chat에서 에이전트 호출 | Slide 06 | 1-2주 (OAuth scope) |
| **7.4** | a11y 전체 sweep (MC body, RouteCanvas, 모달, 폼) | Slide 17-18 (사용자 Pain Points) | 2-3일 |
| **7.5** | Real-time 대시보드 — 진행 중 캠페인 다중 뷰 | Slide 39-41 | 1주 |
| **7.6** | 디자인 토큰 시스템 — Google Material 3 정렬 (선택) | 데크 비주얼 | 2주 |

### Implement
- 7.1을 먼저 (가시적 임팩트 + 데모 영상 새로 찍을 가치)
- 7.4를 7.1과 함께 (UI 변경 시 a11y 동시)
- 7.2는 6.1과 동기화 (creator 거주지 + Maps UI)
- 7.3은 OAuth scope 변경 필요 → 운영자 결정

### Verify (exit)
- 7.1, 7.4: Lighthouse a11y ≥ 96 유지
- 7.2: sourcing 페이지에서 Maps 카드 렌더링 확인
- 7.3: Gmail Chat에서 에이전트 응답 확인 (라이브)

### Re-evaluate
- 7.3 OAuth scope 추가가 컴플라이언스 리뷰 트리거 시 보류
- 7.6 디자인 토큰은 ROI 평가 후 결정

---

## 10. Phase 8 — Infra Optimization & Scale

> 목표: 워크로드 규모 변화에 맞춘 인프라 최적화. **현재 규모에서는 P8 대부분이 디퍼**.

### Audit (entry — 트리거 조건)
다음 중 하나 만족 시 P8 시작:
- 월 GCP 청구 ≥ $500
- 일 라이브 요청 ≥ 10,000
- Cloud Run cold start로 인한 사용자 불만 보고

### Plan
| Sub | 항목 | 트리거 |
|---|---|---|
| **8.1** | 비용 분석 (X5 연속) — 서비스별 cost attribution | 청구 ≥ $500/월 |
| **8.2** | GKE Inference Gateway 평가 → 채택 결정 (C10 일부) | 요청 ≥ 10K/일 |
| **8.3** | Managed Lustre / Cloud Storage Rapid 평가 | 대용량 파일 워크로드 |
| **8.4** | GKE Autopilot gVisor 마이그레이션 (B1 closure) | 보안 컴플라이언스 요구 |
| **8.5** | Cross-Cloud Lakehouse 정식 도입 | 분석 워크로드 증가 |
| **8.6** | TPU Ironwood / Axion N4A — Vertex가 내부 활용 시 자동 수혜, 별도 작업 없음 | — |

### Implement
- 모든 sub는 트리거 조건 확인 후 시작
- 일괄 마이그레이션 금지 — 1개씩 carve-out하여 ROI 검증

### Verify (exit)
- 비용 ≥ baseline+50% 이내 유지
- 가용성 ≥ 99.5% 유지

### Re-evaluate
- 마이그레이션 부작용 발생 시 즉시 롤백
- 6개월 주기 인프라 audit

---

## 11. Phase 9 — Product Backlog Closeout

> 목표: STATUS.md에 명시된 backlog 정리.

### Audit (entry)
- 운영자 결정 필요 항목 들 (Phase 6 C3, C4, carrier, i18n, landing)

### Plan
| Sub | 항목 | 운영자 결정 |
|---|---|---|
| **9.1** | Carrier 어댑터 (YunTrack) | YUNTRACK_API_KEY 제공 |
| **9.2** | Phase 6 C3 admin views sweep | 페이지별 port vs drop |
| **9.3** | Phase 6 C4 v1 backend 은퇴 | side-by-side 기간 종료 결정 |
| **9.4** | i18n (KO/EN) | 어느 페이지/에이전트가 KO/EN 양쪽 |
| **9.5** | Landing 페이지 v2 포트 | v1 landing 콘텐츠 분류 |
| **9.6** | pause/resume 30d 가시성 (STATUS.md backlog) | UI 명세 |

### Implement
- 각 sub는 운영자 결정 후 별도 sprint
- 9.1은 외부 API 키 필요
- 9.4는 모든 사용자 텍스트 외화 — 큰 작업

### Verify (exit)
- 각 sub의 완료 정의는 별도 spec 문서

### Re-evaluate
- 운영자가 디퍼 결정 시 sub 단위로 보류

---

## 12. Phase 10 — Continuous Improvement & Decision Loop

> 목표: 상시 운영되는 메타 페이즈. 분기 audit + 신규 결정 cadence + LESSONS catalog.

### Audit (entry)
- 분기 시작 시 자동 트리거
- 또는 외부 이벤트 (Google 신제품 발표, 컴플라이언스 변경) 발생 시

### Plan
| Sub | 빈도 |
|---|---|
| **10.1** | HONEST-SCOPE 분기 audit (모든 행의 라이브 검증) | 분기별 |
| **10.2** | DECISIONS.md D-항목 cadence (월 1회 새 D-항목 검토) | 월별 |
| **10.3** | 신규 외부 정보 통합 (다음 Google Cloud Next, GA 발표) | 이벤트별 |
| **10.4** | LESSONS catalog (실패/성공 사례 등재) | 사고/마일스톤별 |
| **10.5** | 마스터 플랜 자체 audit (이 문서) | 분기별 |

### Implement
- 자동화 가능: 분기 시작 시 audit checklist 생성
- 운영자 1인이 분기 1일로 처리 가능

### Verify (exit)
- 각 분기 audit 보고서 존재
- D-항목이 분기당 0개 이상 신설

### Re-evaluate
- 마스터 플랜 자체가 outdated되면 전체 재작성 트리거

---

# 13. 심층 분석

## 13.A Critical Path

가장 긴 의존성 사슬:

```
P0 (audit)
  → P1.2 (보안: 라이브 데모 안전성)
    → P1.3 (22-agent 실증 — A4/A6/A7/A8/A9)
      → P1.1 (문서 일관성 — 마지막에 동기화)
        → P1.5 (관측성 마무리)
          → P1.4 (UX 마무리)
            → P1 verify gate
              → P2 (제출)
                → 14일 안정화
                  → P3 (eval 확장) ─┐
                  → P4 (defense)   ├─ 병렬
                  → P7 (UX deck정렬)┘
                    → 1-3개월 후
                      → P5 (Google-gated 제품) ─┐
                      → P6 (grounding/data)    ├─ 병렬
                      → P8 (인프라 — 트리거시)  ┘
                        → P9 (backlog — 운영자)
                          → P10 (continuous)
```

**Critical path 길이**: 약 18-24개월 (P0-P10 전체). 단, P5-P10은 외부 의존이 많아 실제 길이는 가변.

## 13.B Dependency Graph (핵심)

```
A1 ────────► B*(여러 행 disclose)
A2 ─────┬──► live demo 안전
A3 ─────┘
A4 ──► B6 ──► built-with 태그
A6 ──► X1 (22-agent 실증)
A7 ──► W-1 해소
A8 ──► eval coverage 2/22
A9 ──► W-4 해소
A10 ─► A11 (재측정)
A11 ─► X5 (측정 sprint)

C1 (Agent Runtime) ──► Google allowlist (외부)
C2 (Gateway mTLS)  ──► Google preview (외부)
C4 (Chronicle)     ──► Chronicle 인스턴스 (외부 + 비용)
C7 (Fraud Defense) ──► reCAPTCHA Enterprise + OAuth (외부)
C8 (Memory Bank)   ──► P3.2 (내부)
C10 (인프라)       ──► 워크로드 규모 (외부 트리거)
C11 (Grounding/UI) ──► Maps quota + OAuth + 운영자 결정
```

**병목 식별**: 외부 의존 노드 5개 (C1, C2, C4, C7, C10). 이들은 P5/P4/P8로 격리되어 critical path 최소화.

## 13.C 위험 등록부 (Risk Register)

| ID | 위험 | 확률 | 영향 | 대응 |
|---|---|---|---|---|
| R-A | Cloud Armor 정책이 정상 트래픽도 차단 | 중간 | 중간 | P1.2 후 4hr 관찰, false-positive 시 정책 완화 |
| R-B | A8 eval에서 새 holdout 70% 미달 | 중간 | 낮음 | conversation_responder가 71.4% 보유했으므로 신규 case 신중히 선정 |
| R-C | 외부 의존 (Chronicle/Google allowlist) 60일+ 지연 | 높음 | 중간 | HONEST-SCOPE에 disclose 유지, P5 자체 구현 fallback |
| R-D | Maps Grounding Lite quota 초과 | 중간 | 중간 | P6.1 시작 시 quota 신청 + throttle 정책 |
| R-E | OAuth scope 추가 (P7.3, P4.3)가 컴플라이언스 리뷰 트리거 | 중간 | 높음 | 사전 법무 review, 운영자 결정 |
| R-F | 비용 폭증 (라이브 데모 인기 또는 공격) | 낮음 | 높음 | P1.2의 Cloud Armor + 청구 알람 (P2.2) |
| R-G | P3.1 eval 확장이 새 회귀 노출 | 높음 | 낮음 | 이미 알려진 회귀를 disclose하는 게 정직성에 더 좋음 |
| R-H | Vertex `global` 엔드포인트의 SLA 변경 | 낮음 | 높음 | D53 재평가 + multi-region fallback 검토 |
| R-I | Google 신제품 출시로 P5/P6 항목 변경 | 중간 | 중간 | P10.3에서 흡수 |
| R-J | 운영자 시간 제약 (마스터 플랜 실행자 부재) | 높음 | 높음 | P1만 fully autonomous + 나머지는 운영자 페이스로 조정 |

## 13.D ROI 분석 (페이즈별)

| Phase | 시간 투입 | 직접 가치 | 정직성 가치 | 신뢰성 가치 | ROI 평가 |
|---|---|---|---|---|---|
| P0 | 1.5hr | 추적성 ⭐⭐ | — | ⭐⭐ | 필수 (overhead 최소) |
| P1 | ~18hr | 제출 안전 ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **최고 ROI** (단 1주 투입으로 제출 신뢰도 결정) |
| P2 | 1-2주 | 사고 방어 ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ | 필수 운영 |
| P3 | ~3주 | 22-agent 실증 ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 높음 — 제출 후 첫 ROI 페이즈 |
| P4 | ~4주 (외부 의존) | 보안 ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | 중간 — 외부 의존이 ROI 감쇠 |
| P5 | ~6주 (외부 의존) | managed 운영 ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | 중간 — Google 페이스에 종속 |
| P6 | ~6주 | 그라운딩 품질 ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | 높음 — 제품 본질 개선 |
| P7 | ~6주 | UX/데모 가시성 ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | 중간 — 데모 영상이 매개체 |
| P8 | ~3주 (트리거시) | 비용/스케일 ⭐⭐ (현재) ~ ⭐⭐⭐⭐⭐ (트리거시) | ⭐ | ⭐⭐⭐ | 트리거 의존 |
| P9 | 다양 | backlog 정리 ⭐⭐ | ⭐ | ⭐⭐ | 운영자 결정 |
| P10 | 분기당 1일 | 지속성 ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 메타 — 다른 페이즈가 outdated되는 것 방지 |

**ROI 순위**: P1 > P3 > P6 > P2 ≈ P4 ≈ P7 > P5 > P10 > P8 > P9.

## 13.E Resource Constraints

**Autonomous (Claude가 처리 가능)**:
- 모든 코드/문서 변경 (P1 전체, P3.1 eval 추가, P3.2 Memory Bank 주입, P6.x 코드 통합)
- 측정·캡처 (P0.1, P0.2, P1.5)
- 테스트·verify (모든 페이즈의 verify 게이트)

**Operator-only (사람 필요)**:
- P2.1 Devpost 제출 클릭
- P5의 Google Support case open / 라이선스 결정
- P8.4 GKE 마이그레이션 의사결정
- P9 전체 (backlog 우선순위 + scope 결정)
- 청구 활성화, OAuth scope 변경, IAM 정책 변경

**Hybrid**:
- P4.3 reCAPTCHA Enterprise — 운영자가 키 발급 + Claude가 통합
- P7.3 Workspace Agent — 운영자가 OAuth scope + Claude가 통합

## 13.F 비용 추정

| Phase | 추정 GCP 비용 증분 (월) | 일회성 비용 |
|---|---|---|
| P0 | $0 | $0 |
| P1 | $0 (Cloud Armor 무료 layer) | $0 |
| P2 | +$5-10 (모니터링 알람) | $0 |
| P3 | +$10-30 (Cloud Trace, Memory Bank Firestore) | $0 |
| P4 | +$100-500 (Chronicle SecOps 라이브 — 가장 비쌈) | 외부 라이선스 별도 |
| P5 | -$10~+$100 (managed Agent Runtime 비용 vs Cloud Run 절감) | $0 |
| P6 | +$20-200 (Maps Grounding quota, BigQuery slot) | $0 |
| P7 | +$0-50 (OAuth 토큰 관리) | 디자인 작업 인건비 |
| P8 | -$50~+$500 (최적화 vs 마이그레이션) | 마이그레이션 1회성 |
| P9 | +$5-50 (carrier API, i18n 서비스) | 외부 API 가입비 |
| P10 | $0 | $0 |

**제출 후 첫 30일 추정**: 기존 baseline + $50-100/월 (P3 가벼움).
**제출 후 90일 추정**: baseline + $200-700/월 (P4가 트리거 시 가장 영향 큼).

## 13.G 취소·디퍼 기준

각 sub-task가 다음 중 하나 충족 시 취소 (디퍼 → HONEST-SCOPE 신규 행):

1. **외부 의존 ≥ 60일 지연** (예: Google Support case 응답 없음)
2. **비용 ROI 부족** (분석 결과 정량적 가치 < 작업 비용)
3. **D53 위반 우회 불가** (Google이 결과적으로 *-pro 또는 2.5 강제 시 — 가능성 낮음)
4. **컴플라이언스 차단** (법무 review에서 reject)
5. **상위 페이즈 결과로 obsolete됨** (예: P3 결과로 P5 자체 구현 결정)

## 13.H 신규 D-항목 후보 (DECISIONS.md D54+)

마스터 플랜 실행 과정에서 신설 후보:

| 후보 | 트리거 | 결정 내용 |
|---|---|---|
| **D54** | P3 종료 시 | eval coverage 진실성 정책 — 모든 신규 에이전트는 eval 동반 머지 |
| **D55** | P3.2 종료 시 | Memory Bank 사용 정책 — 어느 에이전트가 user-scoped memory 가짐 |
| **D56** | P4 종료 시 | Defense 라이브 정책 — Chronicle live는 ss-mcp-prod에만, ADK 플리트는 promptGuard로 충분한지 결정 |
| **D57** | P5 통보 시 | managed Agent Runtime 채택 정책 |
| **D58** | P6.1 종료 시 | Maps Grounding 적용 범위 |
| **D59** | P7.3 결정 시 | Workspace Agent OAuth scope 정책 |
| **D60** | P8 트리거 시 | Cloud Run vs GKE 정책 |

---

# 14. 다음 액션 (사용자 결정 대기)

이 마스터 플랜의 **Audit 단계는 이 문서 자체로 완료**되었다. **Plan 단계도 완료**. 이제 다음 결정이 필요:

1. **P0를 즉시 시작** — 베이스라인 캡처 + 추적 보드 생성. (1.5hr autonomous 가능)
2. **P1을 즉시 시작** — 보안 sub-1.2부터 (Cloud Armor + promptGuard). (~3hr autonomous)
3. **마스터 플랜 검토** — 사용자가 페이즈/우선순위/디퍼 정책을 수정.

**권장 진입점**: P0 → P1.2 → P1.1 + P1.3 (병렬) → P1.5 → P1.4 → P1 verify gate.

각 sub-task 완료 시마다 (a) 변경 파일 diff (b) verify 결과 (c) 추적 보드 업데이트가 자동 산출되며, 페이즈 종료 시 verify 12 게이트를 모두 통과한 뒤에만 다음 페이즈로 이동한다.

---

작성: Claude Code · 2026-05-28 · 입력 종합본 `docs/GOOGLE-CLOUD-NEXT-26-ANALYSIS.md`
