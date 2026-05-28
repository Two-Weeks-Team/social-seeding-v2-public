# Agentic Taskforce + Maps UI Toolkit + Mission Control UX — Next '26 Recap 대비 갭 분석
작성: frontend-architect, 2026-05-28

---

## 핵심 메시지 (3문장)

Mission Control은 에이전트 시대의 "타임라인 + 게이트" 패턴을 올바르게 구현했으나, Google Cloud Next '26 데크가 보여준 세 가지 시각적 차별점 — 3-패널 Real-Time 모니터링 레이아웃(Slide 39–41), Maps Agentic UI Toolkit의 위치 카드(Slide 33), AI Kit 카드 UX(Slide 18) — 은 아직 반영되지 않았다. 이 중 D-8 이내에 데모 영상에서 가시적 임팩트를 내는 항목은 하나뿐이다: 기존 `/campaigns/[id]` 페이지에 3-패널 레이아웃 힌트를 추가하는 CSS-only 작업으로, 심사위원이 Slide 39의 대시보드와 비교할 때 "우리도 같은 패턴을 알고 쓴다"는 인상을 줄 수 있다. Maps UI Toolkit과 Workspace Agent 통합은 데모 가시성 대비 구현 비용이 매우 크므로 안전하게 디퍼한다.

---

## 1. 놓친 기능 갭

| # | 발견 | 출처 | 영향 | 작업량 | 권고 |
|---|---|---|---|---|---|
| G1 | **3-패널 레이아웃 미적용** — Slide 39–41의 Real-Time Monitoring은 좌측 알림 리스트 / 가운데 지도(or 캔버스) / 우측 상세 사이드바 구조인데, `campaigns/[id]/page.tsx:241`의 `grid-cols-3` 레이아웃은 "2-col 메인 + 1-col 사이드바" 패턴으로 중앙-지도 컬럼이 없다. 심사위원이 두 화면을 나란히 볼 때 구조적 유사성이 부각되지 않는다. | GCNEXT26-RECAP.md Slides 39–41; `campaigns/[id]/page.tsx:241` | 데모 비교 임팩트 중간 | 소 (CSS class 수정, 레이아웃 재배치) | D-8 처리 후보 (G2 참조) |
| G2 | **StageBar 레이블이 영문 monospace** — `stage-bar.tsx:12–18`에서 `LABEL_KO`를 정의했으나 실제 값이 `"overview"`, `"sourcing"` 등 영문이다. 데크 Slide 06(Gemini Workspace Intelligence)과 Slide 39(도로 알림 대시보드) 모두 한국어/자국어 레이블을 사용한다. 심사에서 로컬라이제이션 완성도에 감점 가능성이 있다. | `stage-bar.tsx:12`; D34 (4-locale i18n) | 시각적 완성도 낮음 | 소 (문자열 교체) | D-8 처리 후보 |
| G3 | **Activity Timeline에 accessibility 속성 미비** — `activity-timeline.tsx:112–141` 전체에 `role`, `aria-label`, `aria-live` 속성이 없다. 다른 AP2 컴포넌트(`mandate-card.tsx:89`, `mandate-state-pill.tsx:38`)는 aria 속성을 갖추고 있어 불일치. 데모 영상 Lighthouse 자동 감사에서 MC 본체(apps/web)가 ss-landing과 달리 점검되지 않은 영역이다. | `activity-timeline.tsx:80–110`; `mandate-card.tsx:89` | a11y 점수 불명확 | 소–중 (aria 속성 추가) | D-8 처리 후보 |
| G4 | **CampaignCanvas의 React Flow 노드에 keyboard 접근 없음** — `campaign-canvas.tsx:460–468`의 `ReactFlow` 설정에서 `nodesDraggable={false}`, `nodesConnectable={false}`이지만 키보드 포커스 이동 속성(`ariaLabel`, `tabIndex` on SsNode)이 없다. 심사 측이 키보드 탐색으로 데모를 볼 경우 캔버스가 완전히 불투명하다. | `campaign-canvas.tsx:100–136` (SsNode 컴포넌트) | a11y WCAG 2.1 AA 미충족 | 소 | D-8 처리 후보 |
| G5 | **Maps Agentic UI Toolkit 미적용** — Slide 33: 에이전트 텍스트 요청 → 인터랙티브 Maps 카드 즉시 생성. 우리 제품에서 creator 배송지(`shipments` 페이지), creator 위치, 캠페인 지역 데이터가 존재하나 `campaigns/[id]/shipments/page.tsx`는 순수 텍스트 테이블이다. Maps 카드로 배송지를 시각화하면 Slide 33 패턴을 직접 재현할 수 있다. | GCNEXT26-RECAP.md Slide 33; `campaigns/[id]/shipments/page.tsx` 전체 | 데모 wow 임팩트 높음 | 대 (Google Maps JavaScript API 도입, @googlemaps/js-api-loader, 카드 컴포넌트 신규 제작) | 안전한 디퍼 (G6 참조) |
| G6 | **Button 컴포넌트에 focus-visible 스타일 없음** — `button.tsx:50–63`의 className에 `focus-visible:ring` 계열 클래스가 없다. 키보드 사용자가 버튼 포커스를 시각적으로 확인할 수 없어 WCAG 2.1 Success Criterion 2.4.11 위반. | `button.tsx:50–63` | WCAG 2.4.11 미충족 | 극소 (class 한 줄 추가) | D-8 처리 후보 |
| G7 | **Sidebar disabled 항목이 `aria-disabled`만 사용, `disabled` 속성 없음** — `sidebar.tsx:96`에서 `aria-disabled`는 있지만 해당 요소가 `<div>`이므로 화면 독자기가 실제 비활성임을 보장하지 않는다. 포커스 트랩 위험. | `sidebar.tsx:89–100` | a11y 중간 | 극소 | D-8 처리 후보 |
| G8 | **Workspace Agent 패턴 미구현** — Slide 06: Gmail / Docs / Chat에서 에이전트를 직접 호출하는 "Workspace Agent" 패턴. 우리는 `gmail.send` capability는 있으나 Gmail Chat 채널에서 캠페인을 시작하거나 에이전트 상태를 조회하는 UI가 없다. 운영자 워크플로 측면에서 Slack/Gmail이 더 자연스러운 entry point일 수 있다. | GCNEXT26-RECAP.md Slide 06; `packages/capabilities/src/gmail/` | 운영자 UX 갭 (중요하나 D-8 범위 초과) | 매우 대 | 안전한 디퍼 |

---

## 2. 디퍼하지 말아야 할 것 (D-8 처리 후보)

아래 5개는 파일 단위 수정이며 verify-build를 깨지 않는다. 합산 작업량: ~2–3시간. 데모 영상에서 카메라가 MC 본체를 잡을 때마다 보인다.

### 2-1. StageBar 한국어 레이블 (G2)
- 파일: `/Users/kimsejun/Documents/GitHub/social-seeding-v2/apps/web/components/mission-control/stage-bar.tsx`
- `LABEL_KO` 상수 값을 실제 한국어로 교체: `overview → "개요"`, `sourcing → "소싱"`, `outreach → "아웃리치"`, `shipping → "배송"`, `content_review → "콘텐츠 검수"`, `performance → "성과"`
- 이유: D34(4-locale i18n)의 취지와 일치하고, 데크의 한국어 UI 스크린샷(Slide 06, 18)과 같은 로컬라이제이션 인상을 준다.

### 2-2. Button focus-visible 스타일 (G6)
- 파일: `/Users/kimsejun/Documents/GitHub/social-seeding-v2/apps/web/components/ui/button.tsx`
- `cn()` 클래스 목록에 `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1` 추가
- 이유: WCAG 2.4.11, 기존 ss-landing a11y 96점 달성 경험에서 검증된 패턴. 1줄 수정.

### 2-3. ActivityTimeline aria-live 및 section role 추가 (G3)
- 파일: `/Users/kimsejun/Documents/GitHub/social-seeding-v2/apps/web/components/mission-control/activity-timeline.tsx`
- `<div className="space-y-4">` → `<div role="feed" aria-label="에이전트 활동 타임라인" aria-live="polite" className="space-y-4">`
- 각 `<section>` 에 `aria-labelledby` 또는 `aria-label={run_id}` 추가
- 이유: "live" 배지(`animate-pulse`)가 있는 실시간 피드임에도 보조기술이 업데이트를 감지하지 못한다.

### 2-4. CampaignCanvas SsNode keyboard 접근 (G4)
- 파일: `/Users/kimsejun/Documents/GitHub/social-seeding-v2/apps/web/components/mission-control/campaign-canvas.tsx`
- `SsNode` 컴포넌트 최상위 `<div>`에 `tabIndex={0}` 및 `aria-label={${data.kind}: ${data.label}, 상태 ${data.status}}` 추가
- `onKeyDown` 에서 Enter/Space 시 `setSelected` 호출 (canvas의 `onNodeClick`과 동일 동작)
- 이유: React Flow의 기본 SVG 레이어가 키보드 접근을 보장하지 않으므로 custom node 레벨에서 처리 필요.

### 2-5. 3-패널 레이아웃 시각적 강화 (G1) — canvas 모드
- 파일: `/Users/kimsejun/Documents/GitHub/social-seeding-v2/apps/web/app/(mission-control)/campaigns/[id]/page.tsx`
- canvas 모드에서 현재 `space-y-5` 수직 스택 대신 "좌측 알림 패널(w-64) + 가운데 canvas(flex-1) + 우측 brief/tracks(w-72)" 3-컬럼 레이아웃으로 변경
- `page.tsx:241`의 canvas 분기에서 `className="flex gap-5"` 래퍼로 교체하고 기존 `<aside>`를 앞으로 이동
- 이유: Slide 39의 "알림 리스트 | 지도 | 사이드바" 구조와 1:1 시각적 대응. 데모 영상에서 나란히 비교했을 때 즉시 인식 가능.

---

## 3. 안전한 디퍼

| 항목 | 이유 |
|---|---|
| **Maps Agentic UI Toolkit (G5)** | Google Maps JavaScript API 도입, `@googlemaps/js-api-loader` 패키지 추가, 지도 컴포넌트 신규 설계까지 최소 1–2일. D-8 남은 상황에서 verify-build 깰 위험이 있다. 배송지 텍스트 표현은 현재도 충분히 정보를 전달한다. |
| **Workspace Agent / Gmail Chat 통합 (G8)** | Dialogflow CX 채널 + Gmail Chat API 설정 필요. D53 위반 없이 구현 가능하나 OAuth scope 변경, 배포 변경이 수반된다. 제출 후 v4에서 설계. |
| **Rapid Enterprise Migration (Slide 06 M365→Workspace)** | 우리 제품과 무관. 타깃 고객이 다르다. |
| **Population Dynamics / Place Insight / Road Management (Slide 34–42)** | 인플루언서 캠페인 도메인과 직접 접점 없음. |
| **AI Kit 완성형 카드 UX (Slide 18)** | Maps Places API + LLM 결합 카드. Maps Agentic UI Toolkit(G5)과 동일한 이유로 디퍼. |

---

## 4. 새로 발견된 위험/모순

### R1. Mission Control a11y 점수 불명확 — ss-landing과 분리된 기준
- ss-landing (site/)은 Lighthouse a11y **96** / SEO **100** (PR #15, 2026-05-24 handoff §1-3)
- apps/web Mission Control 본체에 대한 Lighthouse 측정치는 어디에도 없다
- 발견 경로: `claudedocs/2026-05-24-session-handoff.md §2`, `README.md:182`
- 위험: 심사위원이 `/campaigns` URL을 직접 방문하면 ss-landing이 아닌 MC 본체 기준으로 a11y가 평가된다. `activity-timeline.tsx`, `campaign-canvas.tsx`, `button.tsx`에서 발견된 세 가지 갭(G3/G4/G6)이 복합 작용하면 점수가 80 이하로 떨어질 수 있다.
- 권고: D-8 안에 `apps/web` 로컬 Lighthouse 측정 한 번 실행, 점수 확인 후 G3/G4/G6 패치 결정.

### R2. StageBar 레이블이 영문-only라 D34(4-locale i18n) 결정과 모순
- `DECISIONS.md D34`: "4 locales — 한국어/English/日本語/中文(简)"
- `stage-bar.tsx:12–18`: `LABEL_KO` 변수명이 KO를 암시하지만 값은 영문 enum 문자열
- 심사 시 KO 로케일로 접근했을 때 스테이지 진행 바가 영문으로 표시되는 시각적 불일치.

### R3. CampaignCanvas의 "에이전트 시대" 정합성 — 에이전트 결정 과정이 불가시
- Slide 06("파일럿의 시대는 끝났고, 에이전트의 시대가 왔다")과 우리 제품의 핵심 주장은 "에이전트가 운영자"
- `campaign-canvas.tsx`의 노드 종류에 `agent` / `tool` / `gate` 등은 있지만 **에이전트가 왜 특정 노드로 라우팅했는지**의 reasoning trace가 없다. `hint` 필드(line 132)는 짧은 문자열만 허용.
- ActivityTimeline은 span 단위 trace를 보여주나, canvas는 공간 구조만 보여준다.
- 위험: 데모 영상에서 canvas 모드를 보여줄 때 심사위원이 "에이전트가 실제로 무언가를 결정한다"는 증거를 canvas에서 읽어낼 수 없다. rationale 텍스트를 approval drill-in에서만 볼 수 있어 캔버스 자체의 설명력이 낮다.
- 권고(D-8 범위 내): Gate 노드에 `data.detail` 필드로 approval rationale 2–3줄을 주입. `SsNode` 컴포넌트의 `data.detail` 렌더링(line 132 이후) 활성화.

### R4. 3-컬럼 레이아웃이 canvas 모드에서 `max-w-[1600px]`와 충돌 가능
- `page.tsx:152`: canvas 모드는 `max-w-[1600px]`로 확장
- 현재 canvas 모드는 `space-y-5` 수직 스택(line 241); 3-컬럼 변환(G1) 적용 시 1600px 내에서 `w-64 + flex-1 + w-72`가 겹칠 수 있다
- 검증 없이 배포 시 react flow fitView scale이 0.3x로 떨어지는 기존 버그(commit comment `live-demo 2026-05-15`)가 재현될 수 있음.
- 권고: 3-컬럼 변환 전 `min-w-0` 및 `overflow-hidden` 클래스로 flex children의 축소 허용을 명시.

---

## 5. 권고 우선순위 Top 3

### 우선순위 1. Button focus-visible + ActivityTimeline aria-live + StageBar 한국어 (G6 + G3 + G2)
- 합산 작업: 10–20분
- 파일: `button.tsx`, `activity-timeline.tsx`, `stage-bar.tsx`
- verify-build 위험: 없음 (CSS class + aria + 문자열 교체만)
- 데모 임팩트: Lighthouse MC 본체 a11y 점수 방어, 로컬라이제이션 일관성, PR #15 기준(96점)과의 연속성

### 우선순위 2. Gate 노드 rationale 표시 (R3 해결, CampaignCanvas data.detail 활성화)
- 합산 작업: 30–45분
- 파일: `campaign-canvas.tsx` (SsNode detail 렌더링, buildGraph의 gate-shortlist 노드 hint 확장)
- verify-build 위험: 낮음 (client-only 컴포넌트, 타입 확장 없음)
- 데모 임팩트: 심사위원이 canvas에서 "에이전트가 결정한 이유"를 읽을 수 있으면 "에이전트의 시대" 주장을 시각적으로 증명. Slide 06의 "Workspace Agent"가 결정을 내리고 설명하는 패턴과 정합.

### 우선순위 3. Canvas 3-패널 레이아웃 (G1 + R4 동시 처리)
- 합산 작업: 1–2시간
- 파일: `campaigns/[id]/page.tsx` (canvas 분기 레이아웃 변경)
- verify-build 위험: 중간 (React Flow viewport width 변화로 fitView 재검증 필요)
- 데모 임팩트: Slide 39–41의 모니터링 대시보드와 시각적 1:1 대응 가능. 데모 영상에서 가장 강력한 "우리도 Next '26 패턴을 구현했다" 증거.
- 조건: R4 리스크를 먼저 검증(로컬에서 canvas 화면 확인)한 뒤 진행.

---

*검증에 사용한 파일 목록:*
- `/docs/GOOGLE-CLOUD-NEXT-26-RECAP.md` (Slides 06, 18, 33, 39–41)
- `/apps/web/components/mission-control/activity-timeline.tsx`
- `/apps/web/components/mission-control/campaign-canvas.tsx`
- `/apps/web/components/mission-control/stage-bar.tsx`
- `/apps/web/components/mission-control/sidebar.tsx`
- `/apps/web/components/mission-control/ap2/mandate-card.tsx`
- `/apps/web/components/ui/button.tsx`
- `/apps/web/app/(mission-control)/campaigns/[id]/page.tsx`
- `/apps/web/app/(mission-control)/approvals/[id]/page.tsx`
- `/apps/web/app/(mission-control)/layout.tsx`
- `/scripts/demo/submission/HONEST-SCOPE.md`
- `/gcp-research/decisions/DECISIONS.md`
- `/claudedocs/2026-05-24-session-handoff.md`
