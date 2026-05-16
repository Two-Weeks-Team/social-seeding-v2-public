# V4 Implementation Plan — Greenfield, Autonomous

작성: 2026-05-15
대상 위치: `~/social-seeding-v4` (이 문서 작성 시점엔 아직 생성 전)
이 문서는 *v2 안에서* 작성되어 v4 리포 생성 전후의 참조 자료로 보존됩니다.

> v4가 부트스트랩되면 본 문서는 `~/social-seeding-v4/docs/V4-PLAN.md`로 복사되어 그곳이 1차 정본이 됩니다.

---

## 결정 사항 (2026-05-15 사용자 확인)

| 축 | 선택 |
|---|---|
| 워크플로우 모델 | **v3 스타일 풀 데이터화** — `WorkflowDefinition` + executor + 노드 카탈로그 |
| 메인 UI | **v3 single-page canvas** — `/` 한 페이지가 캔버스 + 챗 + 인스펙터 + 타임라인 |
| 레포 | **v2식 모노레포** — Turborepo + `packages/*` + `apps/web` |
| 자율 진행 | **풀 무중단** — v2 autonomous build 방식 (phase 자동 advance) |
| 로케일 | **영문 chrome + 한국어 content** (메뉴/버튼 EN, 챗/이메일 KO) |
| 테스트 | **v2 354+ tests 풀 이식 + workflow executor 새 tests** |
| 외부 연동 | **Toggle** — `MOCK_MODE=true` 기본, 데모 단계에서만 real |
| 데이터 | **Fresh start** — `v4_*` 컬렉션, 새 Mongo (또는 새 db 이름) |

---

## Phase 구조 (총 18–27 작업일 ≈ 4–6주)

```
Phase 0 — Bootstrap                     1–2d
Phase 1 — Capabilities + Agents 이식    2–3d
Phase 2 — Workflow Engine               5–7d  ← 가장 큼
Phase 3 — Canvas UI                     5–7d
Phase 4 — Operator overlays + Auth      3–5d
Phase 5 — Polish + Demo                 2–3d
                                       ─────
                                      18–27d
```

각 phase는 *기계 검증 가능한* DoD를 가집니다. /goal 자율 루프가 멈추지 않으려면 이게 핵심.

### Phase 0 — Bootstrap

**산출물**
- `~/social-seeding-v4` git 초기화, pnpm workspaces + turbo
- `tsconfig.base.json`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `turbo.json` (v2 그대로)
- `packages/contracts` 이식 (v2의 1,126 lines) + `WorkflowDefinition` / `NodeCatalogEntry` / `RunEvent` 새 스키마
- `packages/observability` 이식 (243 lines)
- `packages/db` 이식 — 컬렉션 이름 `v2_*` → `v4_*` 치환
- `apps/web` 비어있는 Next 16 + globals.css + 사이드바 셸
- `docs/{ARCHITECTURE,STATUS,PHASE-0..5-PLAN}.md`, `CLAUDE.md`, `AGENTS.md`, `README.md`
- `.env.example` (`MOCK_MODE=true` 기본)

**/goal condition**
```
verify-build green; git log shows ≥4 commits (phase-0:bootstrap, phase-0:contracts,
phase-0:observability, phase-0:db); pnpm --filter @ss/contracts test passes ≥10
tests; pnpm --filter @ss/db test passes; apps/web returns 200 on /sign-in
```

### Phase 1 — Capabilities + Agents (2–3d)

**산출물**
- `packages/capabilities` 이식 (4,069 lines, 25 files) + `MOCK_MODE` 시 fake factory 자동 주입
- `packages/agents` 이식 (1,686 lines, 14 files)
- `apps/web` 사이드바 + `/sign-in` (test-login + dev 로그인 버튼) 동작
- v2 tests 250+ passing

**/goal condition**
```
verify-build green; pnpm run test passes ≥250 tests; MOCK_MODE=true 일 때
scripts/smoke-agents.ts 가 gmail.send mock으로 fake messageId 반환; sign-in
페이지 dev 버튼 클릭 → /campaigns 도착 (plain 페이지 OK, Phase 4에서 채움)
```

### Phase 2 — Workflow Engine (5–7d) ← 가장 큰 phase

**산출물**
- `packages/workflow-engine` 신설 — executor (topological walk + gate handling + RunEvent emit)
- `packages/workflow-catalog` 신설 — 15+ 노드 정의 (v3 카탈로그를 v2 capabilities 매핑으로 재작성)
- Default brand workflow / lead workflow — v2 동작과 parity
- Inngest 통합: 각 `WorkflowDefinition`이 *하나*의 Inngest 함수로 컴파일
- Approval gate → 캔버스의 Approve 버튼 + `/api/runs/:id/approve`
- MongoDB: `v4_workflows`, `v4_workflow_runs`, `v4_run_events`

**/goal condition**
```
verify-build green; pnpm run test passes ≥320 tests including:
  · executor unit (15+ node dispatch)
  · 3 golden workflow scenarios (brand happy / brand rejected gate / lead happy)
scripts/smoke-engine.ts MOCK_MODE=true 로 default brand workflow 실행 후
RunEvent 시퀀스가 expected 12+ 이벤트와 일치
```

### Phase 3 — Canvas UI (5–7d)

**산출물**
- `/` 한 페이지 — React Flow 캔버스 + 노드 팔레트 + 인스펙터 + 타임라인 + 챗박스
- 노드 클릭 → 인스펙터에서 config 편집 + 저장
- Save / Run / Approve 버튼 → API
- `/api/chat/workflow-draft` (Haiku로 그래프 패치)
- 타임라인 inline artifact preview (이메일 / 후보 리스트 / 리포트)
- Playwright 3 시나리오 × 2 viewport

**/goal condition**
```
verify-build green; pnpm exec playwright test passes 3 scenarios × 2 viewports;
chat draft에 "틱톡 크리에이터 캠페인 만들어줘" 입력 시 graph에 Discover Creators
노드 추가됨; Run → 타임라인에 run.started + node.started + artifact.created 표시;
Approve 버튼이 cost_quota_guard 노드에서 surface
```

### Phase 4 — Operator overlays + Auth (3–5d)

**산출물**
- 우측 상단 nav: ☰ → 모달/사이드 패널
- `/approvals` (cross-workflow inbox)
- `/usage` (cost ledger — per-agent + per-workflow)
- `/policies` (5 gate × 3 mode 정책 편집)
- `/campaigns` (워크플로우 인스턴스 리스트)
- Auth: v2 JWT 쿠키 + test-login + dev 버튼

**/goal condition**
```
verify-build green; tests ≥350; 4개 overlay route 모두 200 + seeded data 표시;
cookie 없으면 /sign-in 리다이렉트
```

### Phase 5 — Polish + Demo (2–3d)

**산출물**
- `scripts/run-demo.ts` — MOCK_MODE 풀 데모
- `scripts/seed.ts` — demo workspace + sample workflow + mock creators
- README, ARCHITECTURE, STATUS, HANDOFF 갱신
- Playwright 스크린샷 6+

**/goal condition**
```
verify-build green; pnpm run test 전체 + Playwright E2E 전체 통과;
scripts/run-demo.ts --mock 가 30초 안에 "Demo complete: 1 workflow run,
N RunEvents, 0 errors" 출력; docs/STATUS.md "Phases 0-5 done" 명시
```

---

## 자율 진행 메커니즘 (v2가 검증한 방식)

### 메모리 시드 (`~/.claude/projects/-Users-sgwannabe-social-seeding-v4/memory/`)

| 메모 | 내용 |
|---|---|
| `v4-phase-roadmap` | Phase 0–5 이름, DoD, /goal condition 템플릿 |
| `v4-autonomous-mode` | "풀 무중단. blocker(필수 env / 사용자 결정 필요) 외엔 자동 advance" |
| `v4-locale-rule` | "English chrome (메뉴/버튼/라벨), Korean content (사용자 챗/이메일)" |
| `v4-mock-toggle` | "MOCK_MODE=true 기본. 모든 capability에 fake factory 자동 주입" |
| `v4-test-strategy` | "v2 354+ unit + workflow-engine 새 tests + Playwright 3시나리오 × 2뷰포트" |
| `v4-goal-char-budget` | "/goal condition은 ~3500자. 초과 시 phase 더 쪼개기" |
| `v4-handoff-protocol` | "phase 끝 = HANDOFF.md 산출물/결정/다음 phase 포인터 + STATUS.md heartbeat" |
| `v4-lessons-from-v2` | "Opus pseudo-tool-call, Inngest async.data.X, Korean address 파싱, tokenManager invalid_grant 등 v2가 비싸게 배운 교훈" |

### /goal 사용 패턴 (phase당 1개)

```
/goal Phase N: <짧은 phase 이름>.
Done condition:
  · pnpm run verify-build green
  · pnpm run test passes ≥N tests
  · <phase-specific 검증>
  · git log --oneline | grep "^phase-N:" 가 ≥M개 commit
  · docs/HANDOFF.md 마지막 entry "Phase N done" 시작
  · docs/STATUS.md "Phase N complete, Phase N+1 ready" 표기
Auto-advance: 위 조건 모두 green이면 즉시 다음 phase /goal 발사
  (메모 v4-autonomous-mode 참조)
Stop conditions:
  · 사용자 결정 필요(스코프), env var 부재 (구체적 변수명 명시),
  · 3회 연속 같은 에러 반복
```

### Ralph loop는 phase 내부에서

```
while not phase_done:
  1. 다음 작은 단위 구현 (커밋 1개 분량)
  2. pnpm run verify-build
  3. fail이면 1로
  4. pass면 commit + STATUS heartbeat
phase done → 다음 phase /goal 발사
```

### Phase 핸드오프

`docs/HANDOFF.md`는 누적 로그. 매 phase 끝에 자동 append:
```
## Phase 0 done — 2026-05-XX
Bootstrap. 4 commits. 50 tests pass.
Next: Phase 1 (capabilities + agents 이식)
```

---

## 위험 + 완화

| 위험 | 완화 |
|---|---|
| Phase 2에서 v2 워크플로우의 *behavioral parity* 깨짐 | golden 시나리오 3개를 v2 fixture로부터 추출. RunEvent 시퀀스 차이가 곧 알람 |
| v2가 비싸게 배운 교훈 재학습 | `docs/V2-LESSONS-LEARNED.md` 작성 — 9 commit + 메모리 노트 인용 |
| /goal 4000자 한계 | `v4-goal-char-budget` 메모 + phase 내부 sub-goal로 쪼갬 |
| Mock-only에서 동작하다 real wiring에서 깨짐 | Phase 5 시작 시 MOCK_MODE=false로 Phase 2 golden 재실행 |
| v2 데모가 망가짐 | v4는 완전 별도 리포. 같은 dev-mongo 쓰지만 컬렉션 prefix 다름 (`v2_*` vs `v4_*`) |

---

## v2 → v4 이식 분량 (코드 라인 기준, 사실)

| 패키지 | v2 lines | 이식 방식 | Phase |
|---|---|---|---|
| contracts | 1,126 | 그대로 + 새 스키마 추가 | 0 |
| observability | 243 | 그대로 | 0 |
| db | 1,001 | 컬렉션 prefix만 치환 | 0 |
| capabilities | 4,069 | 그대로 + MOCK_MODE 시 factory 스왑 | 1 |
| agents | 1,686 | 그대로 | 1 |
| workflows (Inngest 함수) | 3,099 | **버려짐** — workflow-engine + catalog로 재구성 | 2 |
| apps/web | 5,996 | **버려짐** — v3 스타일 단일 페이지로 재작성 | 3–4 |
| (신규) workflow-engine + catalog | — | 새로 작성 | 2 |
| (신규) Canvas UI | — | 새로 작성 (v3의 907 lines 참고) | 3 |
| **합계 보존** | 8,125 | (전체 17,220의 47%) | |
| **합계 재작성** | 9,095 | (전체의 53%) | |

→ **거의 반은 그대로 옮기고, 반은 다시 씁니다.** 재작성 분이 워크플로우 엔진과 UI에 집중되어 있어 v2의 검증된 비즈니스 로직(capabilities + agents)은 안전하게 옮겨갑니다.

---

## 이 문서 이후

이 문서가 저장된 직후 Phase 0 부트스트랩이 *이번 세션에서* 시작됩니다:
1. `~/social-seeding-v4` git init
2. 루트 + 패키지 설정 파일들
3. contracts / observability / db 이식
4. apps/web 빈 셸
5. docs/{CLAUDE,AGENTS,README,ARCHITECTURE,STATUS,PHASE-0..5-PLAN}.md
6. 메모리 시드
7. verify-build green
8. 4–6 commits

Phase 0가 끝나면 /goal로 Phase 1 자동 진행.
