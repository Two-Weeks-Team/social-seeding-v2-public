# Handoff — 우리리우-driven 자율 완주 + 최소 HITL + 와우 리포트 (2026-06-01)

> 골 브리프 `claudedocs/2026-06-01-wooriliu-autonomy-goal-brief.md` 의 P1→P4 를 자율 완주. 브랜치 `feat/wooriliu-autonomy` (from `feat/p1-hardening-d8`). 4 커밋. 전 게이트 green. PR 미생성(아래 "다음 작업").

## 무엇을 했나 (P1→P4)

### P1 — HITL 재배치 (B1 과잉 HITL 해소)  · `4ef05a9`
`defaultPolicy` (실제 위치 = **`packages/db/src/repositories/workspace.repo.ts`**, 브리프가 가리킨 capabilities/policy.ts 는 wrapper) 포스처를 `autonomous` 로 전환:
- `approveShortlist` → `auto_unless { fitScoreLt: 0.4 }`
- `approveOutreachSend` → `auto_unless { spamScoreGte: 5 }`
- `approveReplyResponse` → `auto_unless { replyClassIn: [negotiating, negative, unsubscribe, sensitive] }`
- `approveStageAdvance` → `auto`
- `approveShipment` → `always_ask` (유지)

### P2 — 게이트 신설  · `4ef05a9`
`approveContent`(content_review) + `approveBudget`(예산/계약) 를 `WorkspacePolicySchema.gates` · `ApprovalSchema.kind`(`content_review`/`budget`) · `gate.ts GateKind` 에 추가, 둘 다 `always_ask`. policies 에디터 + approvals 인박스 배선.
→ **사람 개입 = 배송·콘텐츠·예산 3곳만.**

### 추가 — HITL 비차단 타임아웃 (운영자 지시 2026-06-01)  · `4ef05a9`
"오로지 사용자를 기다려야만 하는 건 아니도록": `GateConfig.timeout { businessHours, onTimeout }`.
- 평일 24h 미승인 시 결정론적 폴백 — `abandon`(rejected, 외부행위 0: shipment/budget) 또는 `auto_proceed`(approved, 에이전트 추천=평가: content).
- `businessHoursTimeoutString()` 주말 스킵 + 14일 상한. timeout 미설정 시 기존 7d throw 유지(하위호환).

### P3 — 조립 (오케스트레이터)  · `15c03a9`
신규 `campaign-autopilot` (`packages/workflows/src/workflows/campaign-autopilot.ts`): outreach→shipping→content_review→performance 를 `approveStageAdvance` 전이 3회로 연결, 2개 필수 HITL 게이트(shipment/content)에서 park. Inngest 함수 등록(`campaign/autopilot.start`). 필수 게이트 rejected/abandon → 해당 단계에서 안전 정지.
- wooriliu 어댑터 `packages/workflows/src/fixtures/wooriliu.ts`: prod 추출(34/16/154)을 v2 Campaign/CreatorTrack 로 매핑(검증 콘텐츠 1개=verified 트랙 1개로 집계 정확). 핸들/이메일 비노출.
- 통합 테스트 `campaign-autopilot.test.ts`: dev-mongo 에서 6단계 완주 + 실집계 재현 검증.

### P4 — 추적 + 와우 리포트  · `9544319`, `515a0ee`(PII fix)
- **추적 스크립트** `scripts/demo/wooriliu-autopilot.ts`: 임시 mongo 자체기동 → autopilot 실행 → BEFORE(pending/0) vs AFTER(completed, 16 posts·59,498 views) 출력 + 집계 전용 아티팩트(`claudedocs/wooriliu-report.aggregate.json`).
- **(a) MC 성과 페이지** `/campaigns/[id]/performance`: analytics.compile 온디맨드, "자동 완료" 배너 + KPI + 퍼널 + 리더보드. 캠페인 상세 nav 링크. (스크린샷: `claudedocs/2026-06-01-wooriliu-mc-performance-page.png`)
- **(b) standalone 인터랙티브 HTML** `scripts/demo/wooriliu-report-html.ts` → `claudedocs/2026-06-01-wooriliu-performance-report.html` (애니 카운트업·SVG 퍼널·도넛·정렬 리더보드, 집계+마스킹). (스크린샷: `claudedocs/2026-06-01-wooriliu-standalone-report.png`)
- **공개 게시**: `ComBba/ss-reports` 에 `wooriliu-performance.html` + index 카드 ③ 푸시(집계만). https://combba.github.io/ss-reports/wooriliu-performance.html

## 실측 게이트 (2026-06-01)
- `pnpm run verify-build` → **exit 0** (next build ✓, lint+type-check 7/7).
- `pnpm test` → **439 passed** (capabilities 77 · agents 64 · web 183 · ? 4 · workflows 111).
- `pytest packages/agents-adk` → **2924 passed** (Python 3.12.4: `uv pip install --python $(pyenv which python3.12) -e ".[dev]"` 선행).
- `python -m evals --agent coordinator --holdout-floor 0.7` → **PASS** (holdout 75% ≥ 70%).

## 실측 데이터 (성과분석 자동완료)
검증 게시물 **16** (목표 10, goalMet) · 조회 **59,498** · 좋아요 **4,554** · 댓글 114 · 공유 50 · 가중 ER **7.93%** · avg score 42.4 · flags: goal_met. 원본은 `performanceAnalysis=pending` / reach 전부 0 이었음.

## 하드 제약 준수
prod instarsearch/:8080 **무접속·무쓰기**(픽스처만) · Gemini 3.5/3.1 Vertex global 무변경(Python 미터치) · squash 금지(merge 4커밋) · ss-reports **집계만**(topPerformerCreatorId 핸들 누출은 `515a0ee` 에서 제거, 재grep 0건).

## 다음 작업 (미완 / 운영자·외부 의존)
1. **PR 미생성** — `feat/wooriliu-autonomy` → `gh pr create` 후 `--merge`(squash 금지). codex review 권장.
2. **라이브화(GAP-C)** — 실발송/실배송/실 prod 추적은 운영자·Google-gated. 본 작업은 전부 픽스처 기반(경계 명시).
3. **ss-reports Pages 반영** — 푸시 완료(`7dc90eb`), GitHub Pages 빌드 1–2분 지연. URL 확인 필요.
4. **autopilot 프로덕션 트리거** — 현재 `campaign/autopilot.start` 이벤트 수동. brand-campaign 의 creator-track fan-out 종료 후 자동 emit 하도록 잇는 건 후속.

## 재현
```bash
pnpm run dev-mongo &                       # :27027
export MONGODB_URI=mongodb://127.0.0.1:27027/social_seeding
pnpm exec tsx scripts/demo/wooriliu-autopilot.ts     # 추적 증거
pnpm exec tsx scripts/demo/wooriliu-report-html.ts   # standalone HTML
# MC 페이지: wooriliu-seed.ts 로 시드 → next dev(AUTH_SECRET+AUTH_TEST_LOGIN_ENABLED) → /campaigns/<id>/performance
```
