# V3 UI/UX vs. v2 Mission Control — 비교 조사

조사 일자: 2026-05-15 · 본 세션의 라이브 데모 종료 직후
대상: `/Users/sgwannabe/social-seeding-v3` (별도 MVP prototype) ↔ 본 프로젝트 `apps/web` (Mission Control)
의도: v3의 UI/UX 방향성을 v2의 현재 구현과 나란히 두고 정리. **결정 항목은 없음** — 데모 안정화 이후 검토를 위한 참고 문서.

> 이 문서는 *비교*만 담습니다. 실행 액션 (코드/설정 변경) 없음.
> 사용자 의향(이 세션 확인): "비교 문서만 작성", "캔버스 진화에 관심 있음 — 데모 안정화 이후."

---

## Snapshot — 두 프로젝트 한 줄 요약

| | **v2 (apps/web)** | **v3 (root)** |
|---|---|---|
| 형태 | 모노레포 안의 `apps/web` (Next 16, Turborepo) | 단독 Next 16 앱 |
| 메인 UX | **Multi-route Mission Control** (8+ 페이지) | **Single-page Agent Canvas** (1개 경로) |
| 상태 | Phases 0–6 라이브 (실제 워크플로우 가동) | MVP prototype (in-memory mock 실행) |
| 마지막 변경 | 2026-05-15 (이번 세션) | 2026-05-13 (frozen at commit `f1dc922`) |
| UI 코드량 | mission-control 위젯 6개 + 10+ page.tsx + ui primitive 3개 | `AgentCanvasApp.tsx` 단일 파일 907줄 |
| 로케일 | 전면 한국어 (lang="ko") | 영문 chrome + 한국어 챗 콘텐츠 (lang="en") |

---

## 핵심 비교 (축별)

### 1. 정보 아키텍처

| 축 | v2 | v3 |
|---|---|---|
| 라우팅 | `/campaigns`, `/campaigns/[id]`, `/approvals`, `/approvals/[id]`, `/leads`, `/leads/[id]`, `/policies`, `/usage`, `/sign-in`, `/share/[id]`, `/unsubscribe` | `/` 한 개. API 라우트는 7개 (workflows, runs, chat/workflow-draft, nodes/catalog, context/profile, connections) |
| 탐색 패턴 | 좌측 sidebar (캠페인/리드/승인/정책/사용량) + 캠페인 상세 안 `?view=` 토글 | 탐색 없음. 한 캔버스에서 워크플로우 한 개 편집 |
| 멀티 캠페인/워크스페이스 트리아지 | `/campaigns` 테이블, `/approvals` 인박스, `/usage`로 한눈에 | 없음. 워크스페이스 ID는 하드코딩(`workspace-demo`) |
| 페이즈 hint | sidebar 아래 dim 항목 ("크리에이터 라이브러리 — Phase 2", "관리자 — P5+") | 없음 |

### 2. 도메인 모델 매핑

| 개념 | v2 표현 | v3 표현 |
|---|---|---|
| 캠페인 brief | `CampaignBriefSchema` (brand / targeting / logistics / goals) | `ContextProfile` (brand / products / audience / tone / exclusions / goals / budget / learnings / approval policy) |
| 워크플로우 | Inngest 함수 (`brand-campaign`, `creator-track`, `lead-track`, …) — *코드*에 내장 | `WorkflowDefinition` (nodes + edges + guardrails) — *데이터*로 직렬화, 사용자가 편집 |
| 단계 | 6-stage spine (overview → sourcing → outreach → shipping → content_review → performance) | 15개 노드 카탈로그 (trigger, context, discover_creators, qualify, outreach_draft, send_schedule_email, wait_branch, follow_up, shipment, content_verify, metric_refresh, report, approval_gate, cost_quota_guard, agent_reviewer) |
| 승인 | gate kind 5종 (`shortlist` / `outreach_send` / `reply_response` / `shipment` / `stage_advance`) | 노드 단위 `defaultApprovalPolicy` (`auto` / `human_on_first_run` / `always` / `blocked_until_configured`) |
| 비용 | `v2_cost_ledger` per-agent + 워크스페이스 월 한도 + 캠페인 budget | `WorkflowRun.costEstimate { usd, tokens }` + cost_quota_guard 노드 |
| 관측 | `v2_agent_traces` (per-run spans) → ActivityTimeline | `RunEvent[]` append-only → ExecutionTimeline 패널 |

### 3. 디자인 토큰

| | v2 | v3 |
|---|---|---|
| 배경 | slate-50 (`rgb(248 250 252)`) — 약간 차가운 무채색 | `#ffffff` 순백 |
| 표면 | white card + slate-200 1px 보더 | white panel + `#d8dde6` 보더 |
| Primary | blue-600 (Tailwind 표준) | `#0f62fe` (IBM Blue) |
| Accent (위험/액션) | amber (warn) + rose (reject) + emerald (approve) — 4톤 의미 체계 | `#ff7a59` 코랄 단일 액센트 + 노드 risk별 색상 |
| Font sans | Inter + Pretendard Variable (한글 폴백) | Inter (시스템 폴백 위주) |
| Font mono | JetBrains Mono (tnum, zero variants 활성) | SFMono-Regular / Consolas |
| 모션 | 120–200ms ease, animate-pulse(상태 닷)만 | 모션 없음 |
| 그림자 | `0 1px 2px rgba(0,0,0,0.05)` 최대 | 그림자 거의 없음 (`shadow-sm` 한정) |
| 밀도 | 매우 dense — body 13px / header 11px / button h-8 | 비슷하게 dense — body 14px (text-sm) / chip 12px |
| Focus ring | `2px solid slate-400`, never bright blue | `focus:border-[#0f62fe]` (IBM Blue) |
| 라벨 컨벤션 | `text-[10px] uppercase tracking-wider` SectionLabel | `text-xs uppercase` 일반 라벨 |

### 4. UX 인터랙션 패턴

| 패턴 | v2 | v3 |
|---|---|---|
| 새 캠페인 생성 | `/campaigns/new` 폼 (브랜드/타겟팅/물류/목표 4개 Card) → server action → Inngest emit | 챗박스에 자연어 입력 → `/api/chat/workflow-draft`가 그래프를 패치 |
| 워크플로우 시각화 | `/campaigns/[id]?view=canvas` (React Flow, 노드는 고정 좌표) | 메인 화면 자체가 React Flow (사용자가 노드 드래그/연결) |
| 워크플로우 편집 | 코드 (workflow.ts) 또는 brief 수정 | 노드 팔레트 클릭 + 챗 명령 |
| 승인 처리 | `/approvals` 인박스 → kind별 drill-in (shortlist 테이블, outreach 이메일 preview + judge bars, shipment 주소 + product 매니페스트) | 캔버스 상태가 `waiting_for_approval` → 상단 Run 옆 Approve 버튼 |
| 정책 편집 | `/policies` 페이지 (5 gate, preset 3종, brand voice) | 노드별 `defaultApprovalPolicy` + ContextProfile에 일부 |
| 비용 가시화 | `/usage` 대시보드 (per-agent / per-campaign 효율) + sidebar 풋터 progress 미터 | `WorkflowRun.costEstimate` 표시 (Run 직전) |
| 활동 로그 | `/campaigns/[id]` 좌측 ActivityTimeline (depth 들여쓰기, 색상 닷) | 우측 사이드바 ExecutionTimeline (선형 event 리스트 + artifact preview) |
| 멀티 캠페인 비교 | `/campaigns` 테이블 / `/usage` per-campaign 표 | 없음 |
| 공유 (외부) | `/share/[id]` 비인증 마크다운 리포트 | 없음 |

### 5. 데이터 / 인터랙티비티

| | v2 | v3 |
|---|---|---|
| 페이지 컴포넌트 | 모두 server component, server action으로 mutation | `"use client"` 단일 컴포넌트 — useState 위주, fetch로 API 호출 |
| 영속화 | MongoDB (`v2_*` 컬렉션 + 공유 v1 컬렉션) | in-memory `WorkflowStore` 싱글톤 (MongoDB 클라이언트만 준비, 미연결) |
| LLM/agent 실제 호출 | Claude Agent SDK (Opus 4.7 / Haiku 4.5) 실제 호출 + Inngest 워크플로우 | mock executor (deterministic) |
| 실제 외부 API | Gmail send, RapidAPI TikTok, YUNTRACK (deferred) 등 wiring | 없음 — 전부 mock |
| 인증 | JWT 쿠키 + Auth.js 자리 잡기 (Phase 2 예정) | 없음 |

### 6. 컴포넌트 아키텍처

| | v2 | v3 |
|---|---|---|
| UI primitive | `components/ui/{button,card,badge}.tsx` (variant + tone 체계) | 없음 — Tailwind 클래스 인라인 |
| Mission Control 위젯 | `stage-bar.tsx`, `activity-timeline.tsx`, `campaign-canvas.tsx`, `campaign-track-buckets.ts`, `sidebar.tsx` 등 6개 분리 | 단일 파일 `AgentCanvasApp.tsx` 안에 `WorkflowCardNode`, `NodePalette`, `NodeInspector`, `ConfigField`, `ExecutionTimeline`, `ArtifactPreview` co-located |
| 라이브러리 의존 | shadcn/radix 없음. 자체 primitive | shadcn/radix 없음. lucide-react 아이콘만 사용 |
| Tailwind | v4 + @tailwindcss/postcss + globals.css의 design token (한글 폴백 포함) | v4 + @tailwindcss/postcss + globals.css의 IBM Blue/코랄 token |

### 7. 테스트 / 검증

| | v2 | v3 |
|---|---|---|
| Unit | Vitest 354+ tests (agents, workflows, capabilities, observability) | Vitest 3개 파일 (draft, graph, runtime) |
| E2E | (이 세션엔 manual smoke 위주) | Playwright 3 시나리오 (chat draft / manual add+run / 풀 campaign + approval) — desktop + mobile 매트릭스 |
| 시각 회귀 | 없음 | test-results/에 `*.png` 6장 (실제 v3 화면 캡처) |

---

## v3가 잘 하고 있는 것 (v2엔 없거나 약한 것)

1. **워크플로우를 *데이터*로 다룸** — 사용자가 노드 카탈로그에서 골라 그래프를 만들 수 있음.
   v2는 워크플로우가 코드(Inngest 함수)에 박혀있어 비개발자가 만질 수 없음.
2. **챗-투-그래프 편집** — "최소 팔로워 3만, 최대 20명으로 바꿔줘"가 그래프 mutation으로 변환됨.
   v2는 brief 폼만 가능.
3. **한 화면에서 보이는 전체 맥락** — 팔레트 + 캔버스 + 인스펙터 + 타임라인 + 챗이 한 viewport.
4. **risk + approval policy를 노드 정의 단계에서 명시** — 사용자가 위험을 노드 자체에서 인지.
   v2는 별도 `/policies` 페이지에서 워크스페이스 단위 게이트 설정.
5. **mock-first runtime** — API 키/외부 의존성 없이 디자이너/PM이 UX를 돌려볼 수 있음.
6. **E2E 시나리오로 핵심 사용자 흐름이 박제됨** — Playwright 3 케이스 + 모바일 매트릭스 + 스크린샷.
7. **반응형까지 고려** — 데스크탑 3-패널, 모바일 stacked.

## v2가 잘 하고 있는 것 (v3엔 없거나 약한 것)

1. **실제로 동작하는 풀 파이프라인** — sourcing → vetting → outreach → reply → respond → ship까지
   Opus/Haiku 실제 호출 + Gmail 실제 전송 + MongoDB 영속화.
2. **승인 drill-in이 풍부** — kind별 전용 레이아웃 (후보 리스트 테이블 with fitScore 메터,
   이메일 미리보기 + 4-judge 점수, shipment 주소 + 상품 매니페스트).
3. **다중 캠페인/리드 트리아지** — `/campaigns`, `/approvals`, `/usage`, `/leads`가
   하루 N개 캠페인을 동시 운영하는 운영자에게 필요한 뷰.
4. **per-agent / per-campaign 비용 가시화** — `/usage` 대시보드 + sidebar 예산 미터.
5. **자율성 정책 편집기** — `/policies`에서 5개 gate × 3 모드 × 술어
   (`fitScoreLt`, `followerCountGte`, `spamScoreGte`, `proposedRateUsdGte`, `replyClassIn`) 운영자가 직접 조정.
6. **전면 한국어 UI** + 한글 폴백 폰트 체인 (Pretendard Variable / Apple SD Gothic Neo).
7. **server-component-first** — 페이지가 직접 DB read하고 server action으로 mutation,
   클라이언트 hydration 최소. SEO + 첫 페인트에 유리.
8. **외부 공유 surface** — `/share/[id]` 비인증 마크다운 리포트.
9. **lifecycle 컨트롤** — pause/resume/cancel UI + 백엔드 Inngest cancelOn 연동.
10. **테스트 354+** + 페이즈 0–6 전체 실증.

---

## "두 시스템이 푸는 문제가 다르다"

| 시점 | v2가 답하는 질문 | v3가 답하는 질문 |
|---|---|---|
| 도입 직전 | "이 캠페인을 지금 돌릴 수 있는가? 어떤 정책으로?" | "내 캠페인 워크플로우 형태를 어떻게 그릴까?" |
| 운영 중 | "오늘 무엇이 인간 결정을 기다리고 있는가?" | "지금 이 노드가 무엇을 만들었는가?" |
| 사후 | "이번 달 어디에 얼마 썼고 어느 캠페인이 효율적인가?" | "이 워크플로우 다음 버전을 어떻게 고칠까?" |

→ v2는 **operator console**, v3는 **workflow designer**. 같은 도메인을 다루지만 시선이 다름.

---

## 미래 방향성 (참고용, 본 문서는 액션 안 함)

사용자 의향: "관심 있음 — 다만 데모 안정화 이후."

### 보존 가치 (어떤 경우에도 유지)
- v2의 multi-route 운영자 페이지 (`/approvals`, `/usage`, `/policies`, `/leads`, `/share/[id]`)
- 한국어 UI 일관성
- server-component-first 아키텍처
- 5-gate 술어 기반 정책 시스템
- per-agent 비용 ledger

### v3에서 흡수할 후보 (우선순위 추정)
1. **노드 카탈로그 + 인스펙터 패턴**을 `/campaigns/[id]?view=canvas`에 도입
   (현재는 read-only 그래프). 노드 클릭 → 우측 패널 *편집 가능*하게.
2. **챗-투-편집** — 한 캠페인의 brief를 "팔로워 5만 이상으로 바꿔줘" 같은 자연어로 패치하는 API.
   v3의 `/api/chat/workflow-draft` 방식을 v2 brief mutation에 응용.
3. **워크플로우를 데이터로** — v2 Inngest 함수는 코드라서 비개발자가 못 만짐.
   workflow-as-data 표현을 추가하면 "다른 모양의 캠페인"을 운영자가 직접 정의 가능.
4. **artifact preview를 타임라인에 inline 표시** — v2 ActivityTimeline은 span 메타만 보여줌.
   v3처럼 생성된 이메일/리포트를 inline으로 보여주면 디버깅 + UX 양쪽으로 가치 있음.
5. **mock-first toggle** — 데모/온보딩 모드를 토글하면 외부 API 안 타고 deterministic artifact만 만드는 경로.
   v3의 `mock executor` 패턴을 옵션으로.

### v3 그대로는 가져오면 안 될 것
- 영문 chrome / `lang="en"` (v2 한국어 일관성 깨짐)
- 907줄 단일 컴포넌트 (테스트/유지보수 어려움 — v2의 UI primitive 분리 원칙 유지)
- in-memory `WorkflowStore` (v2는 이미 MongoDB로 영속화)
- 인증 부재 (v2는 JWT 쿠키 + workspace scoping)

---

## 비교 자료 (1차 원본)

### 두 시스템을 눈으로 비교
- v2 라이브: `http://localhost:3000` (이번 세션에서 띄운 dev server)
  - `/campaigns/6a05b4a4c000baa916a0b404` ← 실제 풀-루프 캠페인
  - `/approvals`, `/usage`, `/policies` ← v2 고유 페이지들
- v3 라이브: `cd ~/social-seeding-v3 && npm run dev` 후 `/` 한 곳
- v3 시각 상태 (서버 없이 즉시 확인 가능 — playwright 산출물):
  - `~/social-seeding-v3/test-results/agent-canvas-agent-canvas--a2fb5-d-drafts-workflow-from-chat-desktop/agent-canvas.png`
  - `~/social-seeding-v3/test-results/agent-canvas-campaign-run--3c024--email-and-report-artifacts-desktop/agent-canvas-artifacts.png`

### 원본 파일 (이 비교의 1차 자료)

| 분야 | v2 파일 | v3 파일 |
|---|---|---|
| 메인 진입 | `apps/web/app/(mission-control)/layout.tsx`, `apps/web/components/mission-control/sidebar.tsx` | `~/social-seeding-v3/src/app/page.tsx`, `~/social-seeding-v3/src/components/agent-canvas/AgentCanvasApp.tsx` |
| 디자인 토큰 | `apps/web/app/globals.css` | `~/social-seeding-v3/src/app/globals.css` |
| UI primitive | `apps/web/components/ui/{button,card,badge}.tsx` | (없음 — 인라인 Tailwind) |
| 캔버스 | `apps/web/components/mission-control/campaign-canvas.tsx` | `~/social-seeding-v3/src/components/agent-canvas/AgentCanvasApp.tsx` (전부 한 파일) |
| 워크플로우 모델 | `packages/workflows/src/workflows/*.ts` (Inngest 함수) | `~/social-seeding-v3/src/lib/workflow/{types,node-catalog,runtime,draft}.ts` |
| 노드 카탈로그 | 없음 (워크플로우가 코드에 박힘) | `~/social-seeding-v3/src/lib/workflow/node-catalog.ts` (15개 노드 정의) |
| 디자인 의도 doc | `docs/PHASE-1-PLAN.md`, `docs/ARCHITECTURE.md`, `docs/SCOPE-DECISIONS.md` | `~/social-seeding-v3/docs/architecture/agent-canvas.md`, `~/social-seeding-v3/docs/freeze/v2-feature-api-inventory.md` |
| E2E | (없음, 이번 세션 manual smoke) | `~/social-seeding-v3/e2e/agent-canvas.spec.ts` (3 시나리오 × desktop+mobile) |

### 다음 의사결정을 위해 모아둘 것
- 운영자가 *지금* 어느 페이지에 가장 자주 가는지 (v2 데모를 며칠 써본 뒤 측정)
- "한 화면에 다 보이면 좋겠다" / "여러 캠페인을 동시에 보고 싶다"는 사용자 feedback
- 노드 카탈로그가 비개발자에게 실제로 의미가 있는지 (PM/디자이너 검토)

---

## 결론 (요약 문장)

> v2는 **이미 돌아가는 운영자 콘솔**, v3는 **그래프 편집 중심의 워크플로우 디자이너**.
> 두 시스템은 같은 도메인을 푸는 *다른 시각*이고, 둘 중 어느 한쪽이 다른 쪽을 대체한다기보다
> v2의 multi-route 운영자 surface 위에 v3의 *워크플로우-데이터 + 노드 카탈로그 + 챗 편집* 패턴을
> 부분적으로 흡수하는 진화가 자연스러움. 시점은 데모 안정화 이후.
