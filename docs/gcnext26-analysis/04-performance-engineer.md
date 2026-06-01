# Grounding & 추론 성능 — Next '26 Recap 대비 갭 분석
작성: performance-engineer, 2026-05-28

---

## 핵심 메시지 (3문장)

Google Search Grounding은 라이브 증명(`run-web-search-grounding.sh`, HONEST-SCOPE.md row 17)이 완료됐으나 연구 에이전트의 `grounding_enabled` 기본값이 **False**로 고정돼 있어 실제 캠페인 플로에서 그라운딩이 항상 우회된다. Maps Grounding Lite·Imagery Grounding·Earth AI는 우리 사용 사례(TikTok 크리에이터 지역 검색, 브랜드 이미지 검증)와 명확한 접점이 있으나 현재 전혀 사용하지 않으며, D-8 이내 도입은 작업량 대비 리스크가 크다. Coordinator golden-eval의 holdout 정확도가 75%(3/4 통과, HONEST-SCOPE.md D52 표기와 일치하지 않는 부분 포함)이고 22개 에이전트 중 eval이 존재하는 것은 coordinator 1개뿐이라는 eval 커버리지 공백이 제출 내러티브의 신뢰도 리스크가 된다.

---

## 1. 놓친 기능 갭

| # | 발견 | 출처 | 영향 | 작업량 | 권고 |
|---|---|---|---|---|---|
| G-1 | **Google Search Grounding이 라이브이지만 기본 OFF** — `research.py:93` `grounding_enabled: bool = Field(default=False)`, `GEMINI-MODELS §6.5` 코스트 경고로 기본값 False 고정. `web_search.py` `_live_search`는 완성된 구현이지만 에이전트가 이를 호출하는 경로가 없음 | `packages/agents-adk/src/ss_agents/agents/research.py:93`, `tools/web_search.py:46` | sourcing·vetting 전 brand research가 항상 모델 파라메트릭 지식에 의존 — 최신 K-beauty 트렌드·경쟁사 동향이 누락될 수 있음 | 소 (flag 토글 + smoke 테스트) | D-8 이내 처리 가능: 데모 시나리오에서 `groundingEnabled=true`로 1회 라이브 실행 캡처하면 제출 내러티브 강화 |
| G-2 | **Maps Grounding Lite 미사용** — Slide 13·16 기준 Place Search + Weather + Route Tool이 MCP 경로로 제공됨. 우리 물류 에이전트(`logistics.py`)가 자유 텍스트 한국 주소 파싱에 Gemini를 사용하는데 Address Validation API (Slide 28) 또는 Maps Grounding으로 정확도를 크게 올릴 수 있음 | Slide 13, 16, 28; `packages/agents-adk/src/ss_agents/agents/logistics.py` | 주소 파싱 오류율 — 현재 gemini-3.1-flash-lite 단독 사용, 구조화 필드 누락 시 `products_missing` 환각 발생 (CLAUDE.md "logistics agent 10 hard-won lessons") | 중 (새 capability tool 작성 필요) | 안전한 디퍼. 제출 후 물류 정확도 개선 항목으로 등록 |
| G-3 | **Imagery Grounding (Slide 19-21) — TikTok 콘텐츠 검증 미활용** — `content_verify.py`의 `vision_brand_logo_detect` 도구가 live mode에서 `NotImplementedError`(HONEST-SCOPE.md §2b, W7-staged). Slide 20 "광고·브랜드 마케팅" 사례가 정확히 우리 `content_verify` 사용 사례와 일치 | `packages/agents-adk/src/ss_agents/agents/content_verify.py:56-80`, `tools/vision_describe.py:255-261` (live raises NotImplementedError) | TikTok 게시물의 브랜드 로고·워터마크 검증이 stub 데이터에 의존 — 실제 이미지 그라운딩 없음 | 대 (Vertex AI Vision + Imagery Grounding 통합, W7 마일스톤) | 안전한 디퍼. W7이 이미 예약된 단계 |
| G-4 | **Earth AI / Population Dynamic (Slide 22-23, 34) — sales-lead 워크플로에 잠재 적용 가능** — 우리 B2B lead-outreach 에이전트가 타겟 회사의 지역·인구 밀집도 기반 세그먼테이션 없이 운영됨. Slide 34의 "Google Search Trends + 장소 인기 시간대" 임베딩이 KR 인플루언서 마켓의 트렌드 세그먼테이션에 활용 가능 | Slide 22-23, 34; `packages/agents-adk/src/ss_agents/agents/lead_outreach_writer.py` | lead campaign의 타겟팅 정밀도 — 현재 지역 신호 없음 | 대 (BigQuery + Earth AI API 신규 도입) | 안전한 디퍼. 제출 후 v3/v4 로드맵 항목 |
| G-5 | **Vertex AI Agent Builder Grounding 미사용** — Slide 16 "Grounding with Google Maps in Vertex AI Agent Builder & Gemini API" 경로가 우리 `ss-agents` Cloud Run의 `gemini-3.5-flash` 호출에 적용 가능하나 현재 순수 `GoogleSearch` tool 방식만 사용 | Slide 16; `tools/web_search.py:327` (GoogleSearch tool만 사용) | Agent Builder 연동 시 Vertex Search + Maps 복합 그라운딩 가능 | 중 | 안전한 디퍼 |
| G-6 | **22-agent 중 eval이 coordinator 1개뿐** — `packages/agents-adk/evals/datasets/` 아래 `coordinator.evalset.json` 1개만 존재. 20개 에이전트(sourcing·vetting·outreach_writer·conversation·content_verify 등 핵심 Tier-1 포함)는 기능 테스트만 있고 golden-set eval 없음 | `packages/agents-adk/evals/` (파일 6개), `tests/agents/` (20개 파일) | 제출 내러티브 "22-agent fleet" 중 평가된 에이전트 비율: 4.5% (1/22). "hardening" 챕터가 coordinator routing에만 집중됨 | 중 (triage conversation eval 추가가 현실적) | D-8 이내 후보: reply-triage conversation 에이전트 mini-eval 추가 (이미 56-case 데이터셋 존재) |

---

## 2. 디퍼하지 말아야 할 것 (D-8 처리 후보)

### P-1: `grounding_enabled=True` 데모 캡처 (G-1 대응)

**무엇**: `ResearchInput(groundingEnabled=True)` 경로를 라이브로 1회 실행해 `grounding_used: true` + 실제 URL 인용이 포함된 `ResearchOutput`을 제출 에셋으로 캡처.

**왜 지금**: `web_search.py`의 `_live_search`는 이미 완전히 구현됨 (`tools/web_search.py:278-380`). 그라운딩 경로가 라이브로 동작한다는 증명이 Google Search Grounding 항목(HONEST-SCOPE.md row 17)을 강화하고, 현재 smoke 스크립트가 `web.search` capability를 직접 호출하는 것과 달리 **에이전트 루프 안에서** 그라운딩을 사용한다는 증거가 된다.

**작업량**: 기존 `scripts/smoke-test/run-web-search-grounding.sh`에 research agent 호출 1개 추가. 약 30분.

**리스크**: $35/1k 비용 — 1회 실행 시 약 $0.035~$0.07 (2-3 쿼리 기준). D-8 내 작업 가능.

### P-2: conversation eval 최소 추가 (G-6 대응)

**무엇**: `reply-triage` conversation 에이전트의 mini golden-eval 추가. 이미 56-case synthetic 데이터셋이 `triage_sim.py`로 운영되고 있으므로 그 중 8-10개 케이스를 ADK `evalset.json` 형식으로 전환.

**왜 지금**: 현재 제출의 "Optimize" 챕터가 "triage hardening 40.5% → 100% train, 71.4% holdout"을 핵심 근거로 사용하는데, 이 숫자를 뒷받침하는 공식 eval이 `evals/` 디렉토리에 없다. `triage_sim.py`(hardening 폴더)와 `evals/` 폴더가 분리돼 있어 judge가 "이 hardening이 공식 eval로 검증됐는가"를 확인할 때 링크가 없다.

**작업량**: `triage_sim.py`의 케이스를 `conversation.evalset.json`으로 변환 + `coordinator.holdout.json`과 같은 형식의 holdout manifest 추가. 약 1-2시간.

**리스크**: 없음. 기존 데이터 재포장 수준.

---

## 3. 안전한 디퍼

| 항목 | 이유 |
|---|---|
| Maps Grounding Lite (G-2) | 물류 주소 정확도는 현재 데모 범위 외; 물류 carrier 자체가 deferred (YUNTRACK). 도입 효과가 D-8 내 증명되기 어려움 |
| Imagery Grounding / vision_describe live (G-3) | W7 단계로 이미 예약됨 (HONEST-SCOPE.md §2b). D-8 내 구현 시 오히려 안정성 리스크 |
| Earth AI / Population Dynamic (G-4) | BigQuery + Earth AI 신규 API 계약 필요. 제출 후 v3/v4 항목 |
| Vertex AI Agent Builder Grounding (G-5) | 현재 GoogleSearch tool 방식이 이미 라이브 증명됨. 전환 시 리그레션 위험 |
| Place Insight / Road Management Insight (Slide 36-42) | 우리 도메인(인플루언서 캠페인)과 간접적 연관만 있음 |
| Maps Agentic UI Toolkit (Slide 33) | 프론트엔드 Maps UI — Mission Control에 직접 연결되지 않음 |

---

## 4. 새로 발견된 위험/모순

### W-1: grounding 주장 vs 실제 호출 경로 불일치

README.md (line 154)와 아키텍처 다이어그램 모두 `web.search → Google Search grounding`을 라이브 기능으로 표기한다. 그러나 실제 에이전트 플로에서:

- `research_agent_def` (`research.py:308`)의 `tools=[web_search, vector_search_competitor]`이고
- 입력 기본값 `groundingEnabled=False`이므로
- Inngest 브랜드 캠페인 워크플로가 research agent를 호출할 때 **그라운딩이 항상 비활성화된다**

`run-web-search-grounding.sh`는 capability tool을 직접 호출하므로 "라이브 증명"이지만, 에이전트 루프 내 그라운딩 사용은 아직 없다. 이는 오해를 일으킬 수 있는 표현 갭이다.

**권고**: README.md line 154의 `web.search → Google Search grounding · D53`에 "research 에이전트에서 `groundingEnabled=true`가 필요 — 기본 OFF" 주석 추가. 또는 P-1 작업으로 실제 에이전트 루프 내 그라운딩 실행 캡처.

### W-2: eval 커버리지와 "22-agent fleet" 주장의 간극

제출 내러티브는 "22-agent ADK fleet"을 반복적으로 강조하지만, eval이 존재하는 에이전트는 coordinator 1개(4.5%)다. HONEST-SCOPE.md가 전체적으로 솔직하게 작성됐음에도 이 부분은 명시적 언급이 없다. judge가 "22-agent fleet의 quality validation"을 물어볼 때 응답이 triage hardening에만 집중되는 구조적 약점이 있다.

**권고**: P-2로 conversation eval 추가하거나, HONEST-SCOPE.md에 "eval coverage: coordinator (1/22), triage offline measurement via triage_sim.py (remaining 21)"을 명시 추가.

### W-3: coordinator holdout 75% (3/4)와 D52의 "71.4% holdout" 불일치 가능성

DECISIONS.md D52는 "holdout 71.4% (10/14, 28.6pp gap)"이라고 표기한다. 이것은 **conversation_responder triage**의 56-case holdout 결과다. 반면 coordinator golden-eval(`coordinator.holdout.json`)은 4개 holdout 케이스를 가지며 D51에 따르면 coordinator eval은 별도로 운영된다. README.md와 HONEST-SCOPE.md에서 "71.4% holdout"을 언급할 때 conversation triage holdout인지 coordinator eval holdout인지 명시하지 않아 reader에게 혼동을 줄 수 있다.

**권고**: 문서에서 "triage routing accuracy 71.4% holdout (conversation_responder 56-case set)"과 "coordinator routing eval (14-case, holdout 4개)" 구분 표기.

### W-4: ADK 랭커 heuristic fallback 감지 부재

`ss-mcp-server`의 ADK SequentialAgent ranker가 live로 동작하나(`HONEST-SCOPE.md row 8`), `_heuristic_rank`가 in-code fallback으로 존재한다. `agents-cli-app/CLAUDE.md`는 ss-mcp RapidAPI fallback만 언급하며, `runtime.py` 내부에 heuristic 자동 발동을 **로그로 표면화하는 코드가 없다**. 이전 `await create_session` 버그(BUILD-NOTES.md:145 create_session API 변경 이슈) 사례처럼 silent degradation이 발생할 수 있다.

**권고**: `_heuristic_rank` 진입 시 `logger.warning("heuristic_rank_triggered", ...)` 추가 + Cloud Monitoring alert (anomaly_watch 활용) 연결. 이는 D-8 내 30분 작업.

### W-5: Cloud Run cold start 측정치 부재

README는 live execution이 "15.8s"(exec `7c08ce50`)이고 `HONEST-SCOPE.md`는 "cold ~3.7s / warm sub-second"를 기재하나, 이 숫자는 A2A hop 1개에 대한 것이다. `ss-agents` Cloud Run이 `min=0` (cold start 있음)이고 전체 22-agent 캠페인 루프의 p95/p99가 측정된 적 없다. D31의 "p99 < 1s on hot path" SLO 주장과 `min=0` cold start가 충돌한다.

**권고**: `min=0`에 대해 "cold start는 SLO 대상 외 — 첫 요청 latency는 warm-up 후 측정" 또는 "demo traffic 시 warm-up 스케줄 적용" 명시. 숫자를 부풀리지 않는 것이 HONEST-SCOPE.md의 원칙과 일치.

---

## 5. 권고 우선순위 Top 3

### 순위 1: grounding 주장 정직성 교정 (W-1 + P-1)

**행동**: README.md의 grounding 표기에 "에이전트 루프 내 grounding_enabled=true 필요" 주석 추가 (5분). 가능하면 research agent를 `groundingEnabled=true`로 1회 실행해 에셋 캡처 (30분). HONEST-SCOPE.md row 17에 "research agent 루프 내 통합: grounding_enabled=true 입력 필요" 추가.

**이유**: judge가 "Google Search grounding은 실제 에이전트 루프에서 사용되는가?"를 물을 때 현재 정직하게 "아니오, capability tool 단독 증명만 있다"고 답해야 하는 상황이다. P-1 작업으로 이를 "예스"로 바꿀 수 있다.

### 순위 2: eval 커버리지 보강 또는 명시 (W-2 + P-2)

**행동**: conversation eval mini-set 추가 (1-2시간) 또는 HONEST-SCOPE.md에 eval coverage 현황 명시 (15분).

**이유**: "22-agent fleet"과 "hardening" 챕터가 제출 내러티브의 핵심인데 eval coverage 4.5%는 Technical 30% 루브릭에서 감점 요인이 된다. 최소한 문서화로 defensive disclosure.

### 순위 3: heuristic fallback 로깅 추가 (W-4)

**행동**: `ss-mcp-server`의 ranker 코드에 `_heuristic_rank` 진입 시 warning log 추가 (30분).

**이유**: live ADK ranking이 제출의 핵심 증거(HONEST-SCOPE.md row 8)인데 silent heuristic fallback이 judge 재현 시 발생하면 "LLM ranking이 아니라 heuristic이 동작했다"는 의혹이 생긴다. 로그 한 줄로 예방 가능.

---

## 부록: eval 커버리지 현황 요약

| 에이전트 | eval 존재 | eval 유형 | 통과 기준 |
|---|---|---|---|
| coordinator | coordinator.evalset.json (14 cases, 4 holdout) | golden-set (deterministic predictor) | routing_accuracy ≥ 0.85 |
| conversation_responder (triage) | triage_sim.py (56 cases, 14 holdout) | offline simulation (D52) | train 100% / holdout 71.4% |
| 나머지 20개 에이전트 | 없음 (기능 테스트만) | pytest unit/integration | schema validation + mock |

**22개 에이전트 중 공식 golden-eval 보유: 1개 (coordinator). 오프라인 시뮬레이션 포함 시 2개 (conversation_responder triage 포함).**

---

*파일 인용:*
- `packages/agents-adk/src/ss_agents/agents/research.py:93` — grounding_enabled default=False
- `packages/agents-adk/src/ss_agents/tools/web_search.py:278-380` — _live_search 완성 구현
- `packages/agents-adk/evals/datasets/coordinator.evalset.json` — 유일한 공식 golden-eval
- `packages/agents-adk/evals/holdout/coordinator.holdout.json` — 4-case holdout
- `packages/agents-adk/src/ss_agents/hardening/triage_sim.py` — 56-case triage simulation
- `scripts/demo/submission/HONEST-SCOPE.md` row 17 — Google Search grounding 라이브 증명
- `docs/GOOGLE-CLOUD-NEXT-26-RECAP.md` Slide 11-23 — grounding 라인업
- `gcp-research/decisions/DECISIONS.md` D52, D53 — 모델 + eval 결정
