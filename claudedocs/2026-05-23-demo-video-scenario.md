# Demo Video Scenario — social-seeding-v2 (Track 3 submission)

> 운영자(=사용자) 직접 녹화용. **검증된 사실에만 근거**(과장 금지) — 각 장면의 근거는 `scripts/demo/submission/HONEST-SCOPE.md`(17행)와 라이브 증거다.
> 목표 길이 **2:30–3:00**. 권장 도구: 화면 녹화 + (선택) 보이스오버. 라이브 서비스는 `min=0`이라 **녹화 5분 전 워밍업 curl 1회**로 콜드스타트 회피.
> 마감 2026-06-05.

## 0. 사전 준비 (녹화 전 1회)
- 워밍업: 브라우저로 `https://ss-landing-80064221403.us-central1.run.app/demo/` 1회 로드(콜드스타트 제거).
- 탭 정리: (1) 라이브 데모, (2) GitHub README, (3) `scripts/demo/assets/live-orchestration-evidence.md`(exec 9cc843c1 증거), (4) HONEST-SCOPE.md.

## 1. 훅 (0:00–0:20) — 문제 + 한 줄 가치
- **화면**: 라이브 데모 상단(타이틀 + Build→harden→Optimize→a2a_invoke→Refactor 리본).
- **나레이션**: "브랜드 매니저는 하루 6시간을 인플루언서 소싱·콜드메일·답장·검증·리포트에 씁니다. social-seeding-v2는 그 루프 전체를 **에이전트가 운영**하고, 사람은 고른 게이트에서만 승인합니다."
- **온스크린 자막**: "source → vet → outreach → reply → ship → verify → report".

## 2. 아키텍처 한 컷 (0:20–0:50) — 기술 킥
- **화면**: README의 첫 mermaid 다이어그램(22-agent fleet → A2A → OSS ss-mcp).
- **나레이션**: "Vertex AI 위 22-에이전트 ADK 플릿. 코디네이터는 **gemini-3.5-flash**(Vertex `global`, Model Garden 라우팅)로 누가 실행할지 정하고, 소싱 레그는 **A2A v0.3 `message:send`**로 OSS `tiktok-mcp-server` 노드를 호출합니다."
- **온스크린**: "Gemini 3.5-flash + 3.1-flash-lite only (D53) · Cloud Run · A2A v0.3 · Model Armor live".

## 3. 라이브 워크플로 증거 (0:50–1:25) — "데모가 아니라 실제로 돌았다"
- **화면**: `live-orchestration-evidence.md` — `brand-campaign-demo` Cloud Workflow **exec 9cc843c1, SUCCEEDED ~12s, 5 RankedCreators**.
- **나레이션**: "이 A2A 크로스콜은 배포된 Cloud Workflow 안에서 **실제로 실행**됐습니다. 코디네이터→a2a_invoke→ss-mcp `plan_creator_search`, 실제 크리에이터 5명을 랭킹해 돌려줬습니다."
- **온스크린(정직 캡션)**: "recorded execution 9cc843c1 · ranker는 현재 휴리스틱(전송·엔벨로프는 실제) — HONEST-SCOPE row 8".

## 4. 미션 컨트롤 워크스루 (1:25–2:05) — 비주얼 와우
- **화면**: 라이브 데모의 React Flow 워크플로 그래프(sourcing `gemini-3.5-flash` → vetting×38 `gemini-3.1-flash-lite` → approveShortlist 게이트 → outreach-writer → logistics → content-verify). 재생 속도/로케일(ko/en/ja/zh) 토글 한 번씩.
- **나레이션**: "Mission Control은 에이전트가 한 일의 타임라인 + 승인 인박스입니다. AP2 v0.2 Intent Mandate 게이트에서 사람이 결제를 승인합니다."
- **온스크린**: "Lighthouse a11y 96 · SEO 100 · Best-Practices 100".

## 5. Build → Optimize → Refactor 한 컷 (2:05–2:35) — 내러티브 클로즈
- **화면**: README의 Build→Optimize→Refactor mermaid.
- **나레이션**: "**Built** 22-에이전트 플릿. **Optimized** 가장 약한 답장-분류 에이전트를 데이터 기반 하드닝으로 train 40.5%→100%, **홀드아웃 71.4%**(28.6pp 갭은 정직하게 유지). **Refactored** TikTok 역량을 OSS `tiktok-mcp-server`로 분리해 A2A로 연결."
- **온스크린**: "train 40.5%→100% · holdout 71.4% (gap kept honest)".

## 6. 정직 + 마무리 (2:35–3:00)
- **화면**: HONEST-SCOPE.md(17행 표) 스크롤 + GitHub README.
- **나레이션**: "모든 정직 캡션은 한 파일에 있습니다 — 17개 기능, 5개는 라이브 입증, 나머지는 GA-real 또는 운영자 배포 단계. 과장은 없습니다."
- **온스크린/엔드카드**: 라이브 데모 URL + GitHub repo + "421 TS tests + 2924 pytest, CI-gated".

## 절대 하지 말 것 (정직성)
- "프로덕션", "100% 보안", "blazingly fast" 류 금지.
- ranker를 "실제 ML 랭킹"으로 말하지 말 것(현재 휴리스틱 — row 8).
- GE 어시스턴트→에이전트 호출을 "동작한다"고 말하지 말 것(등록·발견·엔드포인트는 동작; **호출은 Google-gated** — row 14).
- 인-플릿 Imagen/외부-IO 툴을 "라이브"라 말하지 말 것(stub/live seam, W7 — HONEST-SCOPE §3 2b).

## Devpost 등록 체크리스트 (사용자 직접)
- [ ] 영상 링크(공개) + 라이브 데모 URL + GitHub repo URL
- [ ] Track 3 명시 + 6 요구사항 매핑(README "Track 3 — the 6 official requirements" 표 그대로)
- [ ] HONEST-SCOPE 링크(정직성은 심사 기준 — 자발적 공개가 발견보다 점수↑)
- [ ] 비즈니스 케이스(≈99.7% vs 에이전시 수수료, TAM $1.15B — BUSINESS-CASE.md)
