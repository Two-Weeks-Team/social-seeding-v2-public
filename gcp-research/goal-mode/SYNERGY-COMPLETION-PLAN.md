# SYNERGY-COMPLETION-PLAN.md — 200% 시너지 완성 계획 (단일 Track 3, Grand Prize)

> **확정 근거**: 5-각도 병렬 전문가 분석 (2026-05-20) — GCP agent-feature 완전성 · 라이브 오케스트레이션 · 시각적 와우(실 flowchart) · 반-허구 감사 · Track2+3 시너지/루브릭. 5개 독립 분석이 동일 결론으로 수렴 → 검증됨.
> **마감**: 2026-06-05 17:00 PT (오늘 2026-05-20 = D-15).
> **상위 문서**: `GRAND-NARRATIVE-PLAN.md`(Build→Optimize→Refactor 아크) 위에, "갭 없는 실구현 + 200% 데모"를 얹는다. 신규 결정 후보 **D52**(GA 기능 실연결 + Google-gated 정직 공개).

---

## 0. 핵심 긴장의 정직한 해소 (반드시 먼저 합의)

운영자 요구: "절대 허구/회피/우회 금지 · 실질 구현 100% · 모든 GCP agent 기능 사용."

**현실 (반-허구 감사 + GCP 조사가 일치):** 일부 GCP agent 기능은 **Google이 Private-Preview/allowlist로 외부 차단**한다(Agent Gateway mTLS, Gemini Enterprise/Agentspace 등록). 이걸 "구현했다"고 하면 그게 바로 금지된 **허구/우회**다.

→ **무결성 보존 해석 (이 계획의 대원칙):**
1. **GA(정식 출시) agent 기능은 전부 진짜로 연결한다** — stub을 실제 GA API 호출로 승격.
2. **Google-gated(Private Preview/allowlist) 기능은 접근 신청 + 명시 공개**한다 — 절대 가짜로 칠하지 않는다.
3. 모든 "real/live" 주장은 **재실행 가능한 증거(같은 턴 출력)**로 뒷받침한다. 증거 없으면 주장 철회.
4. 데모는 **실제로 작동하는 경로만** 보여준다(목업은 "illustrative" 워터마크 명시).

이 원칙이 곧 "100% 실구현"의 정직한 정의다: **허락된 모든 것은 진짜 · Google이 안 연 것은 정직하게 공개.**

---

## 1. 5-각도 수렴 결론 (검증)

| 각도 | 핵심 결론 |
|---|---|
| GCP 기능 | ADK·A2A·Model Garden·Imagen=이미 real. **Observability→Cloud Trace, Model Armor, Memory Bank(관리형), Agent Eval(Preview), A2A signed card, Prompt Optimizer(GA)** = 15일 내 진짜로 가능. mTLS·Gemini Enterprise = Google-gated. ⚠️ "Agent Optimizer"는 GA 제품 아님 → **Prompt Optimizer(GA)로 재명명/재배선**. |
| 라이브 오케스트레이션 | 22 에이전트에 HTTP 서버 없음 + workflow가 `stub.local` 가리킴 + Workflow 미배포. **최소 실경로**: FastAPI 1 이미지(coordinator+sourcing+vetting)→Cloud Run + 축소 workflow 1개 + SA/IAM → 라이브 실행 캡처(~3-5일). 정직 폴백: 실 Cloud Run coordinator + 로컬 드라이버. |
| 시각 와우 | 데모가 **실 campaign-canvas(React Flow)를 안 씀**. (A) 정적 HTML로 1:1 충실 재현 + scene 엔진으로 status 구동 추천. stall→repair를 **실 outreach 노드 위에서** 연출. |
| 반-허구 감사 | 코드는 정직(전부 공개됨). 위험 3개: ① web-demo에 "MOCKUP" 워터마크 없음 ② imagen 툴은 stub인데 devpost는 "real Imagen"(별도 스크립트가 real — 1문장 명확화 필요) ③ 숫자(2832/홀드아웃 75%) 핀 고정 필요. |
| 시너지/루브릭 | 4 seam: A)Optimize=규칙 1개(라이브 Optimizer 아님) B)26케이스 100%=오버핏 연출(비-라운드 숫자+홀드아웃 확장) C)`content_verify→DAM`이 in-process(A2A 아님) D)데모가 실 canvas 미사용. 최우선=실 canvas 데모. Tech 최고 ROI=**DAM을 진짜 A2A hop으로**. |

---

## 2. 실연결 매트릭스 — "모든 GCP agent 기능" (정직)

| 기능 | 2026 성숙도 | 현재 | 조치 | 분류 |
|---|---|---|---|---|
| ADK 1.x / A2A v0.3 / Model Garden seam / Imagen 4 | GA | **real** | 유지 | ✅ REAL |
| Agent Observability → Cloud Trace | GA | OTel no-op | env-flag + OTLP, 실 trace 캡처 | 🟢 REAL(자율코드+ADC캡처) |
| Model Armor sanitize | GA | stub | GA REST API 실호출(prompt-guard/ss-mcp) | 🟢 REAL |
| Vertex Prompt Optimizer | GA | "Agent Optimizer" stub(오명) | GA Prompt Optimizer 재배선 또는 정직 재명명 | 🟢 REAL |
| Memory Bank(관리형) | GA | Firestore 모사 | 관리형 Vertex Memory API 연결 | 🟢 REAL |
| Agent Evaluation | Preview | 오프라인 러너 | Preview Gen-AI eval API 호출(라벨 Preview) | 🟡 REAL-Preview |
| A2A signed card(JWS) | GA spec | 미서명 | agent.json 서명 | 🟢 REAL |
| Agent Engine 관리형 런타임 | GA | Cloud Run 사용 | 1개 에이전트만 호스팅(선택) | 🟡 PARTIAL |
| Agent Gateway mTLS / Gemini Enterprise 등록 | **Private Preview/allowlist** | 대기(O7) | **접근 신청 + 공개** | 🔴 Google-gated(공개) |

---

## 3. 4 seam 봉합 (Technical 30 신뢰도)

- **Seam C 최우선**: `content_verify → DAM`을 **진짜 A2A v0.3 hop**으로(기존 a2a_invoke 재사용). → Build Example #2가 "역할 일치"에서 "전송까지 일치"로. 
- **Seam A**: 하드닝 옵티마이저를 **GA Prompt Optimizer** 실호출로 또는 정직 재명명.
- **Seam B**: 합성셋 확장(+적대적 홀드아웃) → **비-라운드 일반화 숫자**(예 91.4%) 보고.
- **Seam D**: 데모가 실 campaign-canvas 구동(Wave 1).

---

## 4. 웨이브 (순서 = 심사 임팩트 ÷ 노력)

**Wave 1 — 실 flowchart 데모 (Demo 20, 외부의존 0) ★최우선★**
- campaign-canvas 정적 충실 재현(buildGraph 1:1, 6 stage lane, status dot). BUILD=단계별 채움. OPTIMIZE=실 outreach/wait-reply 노드에서 stall→repair(.opt-node를 노드 위 inset으로 재앵커). REFACTOR=A2A 패킷이 canvas 밖 tiktok-mcp 노드로, 실 Imagen 아티팩트. + index.html "Illustrative mock · live proof via smoke" 워터마크.

**Wave 2 — GA agent 기능 실연결 (REAL)**
- Observability→Cloud Trace(최고 ROI) · Model Armor sanitize · Prompt Optimizer 재배선/재명명 · Memory Bank 관리형 · Agent Eval(Preview) · A2A signed card. 각각 재실행 증거.

**Wave 3 — seam 봉합 (Technical 30, REAL)**
- `content_verify→DAM` 진짜 A2A hop · 하드닝셋 확장+비라운드 홀드아웃 · (운영자 ADC 시) Model Garden 라이브 캡처 + 최소-실경로 Cloud Workflow 라이브 실행 캡처(또는 정직 폴백).

**Wave 4 — Business 30 + Innovation 20**
- buyer-pull 아티팩트 1개(LOI/대기자/대행사-대비 ROI 표) · A2A-only 분배 OSS 템플릿 1개(fork 가능).

**Wave 5 — 정직 통합 + 제출 (REAL)**
- "Production path(Google-gated) vs shipped-for-judging" 단일 표 · 숫자 핀 고정(pytest/golden 재실행) · imagen 툴-vs-스크립트 1문장 명확화 · 데모 스토리보드+devpost 갱신 + 영상 URL 슬롯.

**운영자-전용 / Google-gated (공개, 절대 fake 금지)**: ① ss-v2-prod API/billing/IAM + ADC(라이브 배포·캡처) ② Gemini Enterprise/Agentspace allowlist(O7) ③ Agent Gateway mTLS(Private Preview).

---

## 5. 완료 정의 (DoD)
1. Wave 1-2 + Wave 3 코드 + Wave 4-5 완료, 또는 운영자/Google-gated **blocked-with-report**.
2. 모든 "real/live" 주장 = 같은 턴 재실행 증거(curl 200·pytest·gcloud·trace ID·캡처). 증거 없으면 stub으로 정직 표기.
3. 데모가 실 campaign-canvas 구동 + stall→repair가 실 노드 위 + 워터마크.
4. seam A-D 봉합(또는 정직 재명명) — 특히 DAM 진짜 A2A hop.
5. pytest green · verify-build green 유지.
6. D52+ 신규 결정 기록 · 정직 표(Production vs shipped) 존재.
7. 브랜치 푸시 + CI green · STATUS 갱신.

운영자 잔여(자율 불가): 라이브 GCP 배포/캡처 ADC, Gemini Enterprise allowlist, mTLS Private Preview, 영상 업로드, Devpost Submit.
