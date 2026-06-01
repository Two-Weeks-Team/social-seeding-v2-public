# Goal Brief — 우리리우-driven 자율 완주 + 최소 HITL + 와우 리포트

> **작성 2026-06-01.** 이 문서는 `/goal` 자율 런이 읽는 **단일 소스**다. 갭 분석(`claudedocs/2026-06-01-system-gap-analysis.html`)을 실행으로 옮기고, 실제 `우리리우 2차` 데이터로 추적·검증하며, 원본 socialseed.ing보다 시각적·사용적 와우를 주는 리포트까지 만든다.

---

## 0. 미션 (한 문장)

v2 에이전트 시스템이 **브리프 1개 → 성과 리포트까지 6단계를 자율 완주**하되, 사람은 **3개 게이트(배송·콘텐츠 최종 승인·예산/계약)에서만** 개입하도록 만들고, 그 파이프라인을 **실제 `우리리우 2차` 데이터(34 인플루언서·16 콘텐츠·154 발송)** 로 추적·테스트하고, **Mission Control 성과 페이지 + standalone HTML** 두 표면으로 socialseed.ing를 능가하는 리포트를 낸다.

## 1. 범위 — 한 개 큰 골 (사용자 승인: 전부, P1→P4 순)

| Phase | 갭 | 작업 | 핵심 파일 |
|---|---|---|---|
| **P1** | B1 (과잉 HITL) | 기본 정책값 재배치: `approveShortlist/OutreachSend/ReplyResponse` → `auto_unless`(위험 술어), `approveStageAdvance` → `auto`. `approveShipment`는 `always_ask` 유지 | `packages/capabilities/src/workspace/policy.ts` (defaultPolicy), `packages/contracts/src/policy.ts` |
| **P2** | B2 (게이트 누락) | `approveContent`(content_review 최종 승인) + `approveBudget`(예산/계약 집행) 신설 → `GateKind`·`GateConfig`·`AutonomyPolicy`에 추가 + 배선. 둘 다 `always_ask` | `packages/workflows/src/gate.ts`, `packages/contracts/src/policy.ts` |
| **P3** | A (조립) | `brand-campaign` 또는 신규 오케스트레이터가 stage 3~6(outreach→shipping→content_review→performance)를 `approveStageAdvance` 전이로 잇는 **단일 자율 흐름**으로 조립 | `packages/workflows/src/workflows/brand-campaign.ts`, `campaign-progression.ts` |
| **P4** | C + 리포트 | 우리리우 픽스처를 파이프라인에 흘려 추적 → 성과 리포트 생성. **(a) Mission Control 성과 페이지**(`apps/web/app/(mission-control)/campaigns`) + **(b) standalone 인터랙티브 HTML** 두 표면 | `apps/web/**`, `packages/capabilities/src/analytics/compile.ts`, `packages/agents/src/analyst.agent.ts` |

## 2. 데이터 — 우리리우 2차 픽스처 (이미 추출 완료, prod 무접속)

- **위치**: `fixtures/wooriliu-2nd/raw.json` (565KB, EJSON) + `fixtures/wooriliu-2nd/summary.json` (집계)
- **출처**: prod `instarsearch` DB read-only 추출 (자격증명 = `~/Documents/GitHub_SocialSeed.ing/social-seeding-backend/.env` 의 `MONGO_URI`). 재추출 필요 시 동일 경로 read-only.
- **내용**: campaign(`68a2caf0044d2ccb1c135a14`, `우리리우 2차 발송 성과측정`) + campaign_influencers 34 + campaign_contents 16 + email_queue 154.
- **실측 집계** (summary.json):
  - workflowSteps: 5 completed + `performanceAnalysis` **pending** (← v2가 자동 완료해야 하는 바로 그 단계)
  - influencer_status: identified 18 · content_approved 10 · product_received 4 · product_shipped 2
  - email_status: completed **154** (전량 발송) · 발송기간 2025-09-03 → 2025-11-20
  - performance: reach/engagement/clicks/conversions/revenue **전부 0** (미집계)
- **규칙**: 골 런/테스트는 **이 픽스처만 사용** — prod DB에 **쓰기 금지·재접속 불요**. 픽스처는 PII(수신 이메일) 포함이므로 **공개 리포(`ComBba/ss-reports`)에 절대 푸시 금지**; 비공개 프로젝트 리포에만 둔다. 공개 와우 리포트는 **집계값만** 사용(개별 이메일·이름 비노출).

## 3. HITL 정책 — 목표 상태 (사용자 승인)

| 게이트 | 단계 | 현재 기본 | **목표** |
|---|---|---|---|
| `approveShortlist` | sourcing | always_ask | → `auto_unless` (블랙리스트/저품질 후보 시만) |
| `approveOutreachSend` | outreach | always_ask | → `auto_unless` (스팸점수↑/대량 시만) |
| `approveReplyResponse` | outreach | always_ask | → `auto_unless` (부정·이탈·민감어 시만) |
| `approveStageAdvance` | 전이 | always_ask | → `auto` |
| `approveShipment` | shipping | always_ask | **유지 (필수 HITL)** |
| `approveContent` 🆕 | content_review | (없음) | **신설 → always_ask (필수 HITL)** |
| `approveBudget` 🆕 | 예산/계약 | (캡만) | **신설 → always_ask (필수 HITL)** |

→ 결과: 사람 개입 = **3곳(배송·콘텐츠·예산/계약)** 뿐. 나머지는 자율(위험 술어 매칭 시에만 예외 호출).

## 4. 와우 리포트 — socialseed.ing 능가 기준

원본 비교 대상: `~/Documents/GitHub_SocialSeed.ing/social-seeding-platform/core/frontend` (campaigns/dashboard/analytics 페이지 — 진행률 바 + 테이블 수준).

**능가 목표(둘 다 구현):**
- **(a) Mission Control 성과 페이지** (`apps/web`): 우리리우 추적 데이터 기반 — 6단계 퍼널, 인플루언서 상태 흐름, 발송→응답→콘텐츠 타임라인, KPI 카드, "성과분석 자동완료" 강조. 제품 안에 살아있는 와우.
- **(b) standalone 인터랙티브 HTML**: 차트·애니메이션·필터, 공유용. 집계값만.
- **킥 포인트**: 우리리우가 사람 손으로 멈춘 성과분석을 v2가 자동 완료하는 before/after 대비를 시각적으로.

## 5. 제약 (하드)

- **모델**: Gemini 3.5/3.1 only, Vertex `global` (D53). Claude/2.5/`*-pro` 금지.
- **배포 격리**: prod `instarsearch`/social-seeding-backend `.env`·:8080 **무접속·무쓰기** (read-only 추출은 이미 완료, 픽스처로 대체).
- **게이트 green**: `pnpm run verify-build` + `pnpm test` + `pytest packages/agents-adk` 전부 통과 — red 푸시 금지.
- **커밋**: task당 1커밋·작은 diff, squash 금지(`--merge`), `co-authored-by`.
- **무관 변경 금지**, `codex review --base main` 권장.
- 공개 리포에 PII 금지.

## 6. 완료 조건 (골 종료 시 단일 메시지에 증거 인쇄)

1. **P1**: `packages/capabilities/src/workspace/policy.ts` defaultPolicy diff — 4게이트 auto/auto_unless, `approveShipment`=always_ask. + 관련 vitest pass 출력.
2. **P2**: `grep` 로 `approveContent`·`approveBudget` 가 `GateKind`/`GateConfig`/policy에 존재 + 배선 + 테스트 pass.
3. **P3**: brand-campaign(또는 오케스트레이터)이 stage 3~6를 잇는 코드 + **우리리우 픽스처로 6단계 완주하는 통합 테스트** pass 출력.
4. **P4-C**: 우리리우 픽스처를 추적해 performance 리포트 산출하는 테스트/스크립트 출력 (성과분석 자동완료 입증).
5. **P4-리포트**: (a) `pnpm --filter @ss/web build` 성공 + 성과 페이지 렌더 스크린샷, (b) standalone HTML 생성 + 렌더 스크린샷.
6. **게이트**: `pnpm run verify-build`(exit 0) + `pnpm test`(passed 수) + `pytest`(passed 수) 실측 출력.
7. **문서**: 새 핸드오프 + 공개 `ComBba/ss-reports` github.io 리포트 갱신(집계만).

## 7. 막히면 (외부 변수)

- prod 재접속/실발송/실배송이 필요한 라이브화(GAP-C 라이브)는 **운영자 의존** → 픽스처 기반 추적·테스트로 대체하고 그 경계를 명시한 뒤 `/goal clear`.
- env/ADC/Google-gated 단계는 정확히 무엇이 필요한지 적고 중단.

---

### 준비 검증 체크 (2026-06-01, 이 문서 작성 시점)

- [x] 우리리우 픽스처 추출 + 카운트 검증 (34/16/154) — `fixtures/wooriliu-2nd/{raw,summary}.json`
- [x] 갭 분석 문서 — `claudedocs/2026-06-01-system-gap-analysis.html`
- [x] 타깃 파일 8/8 존재 검증
- [x] 리포트 표면 식별 — `apps/web/app/(mission-control)/campaigns`
- [x] 비교 기준 식별 — socialseed.ing frontend
- [x] HITL 목표 정책 확정 (사용자 승인)
- [x] 공개 리포트 라이브 — `https://combba.github.io/ss-reports/`
