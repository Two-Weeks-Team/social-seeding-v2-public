# AI Hypercomputer + Data Cloud (Layer 4·6) — Next '26 Recap 대비 갭 분석
작성: system-architect, 2026-05-28

---

## 핵심 메시지 (3문장)

현재 스택(Cloud Run + Atlas + Vertex global)은 D-8 제출에 충분하다. 데크 신제품 8종 가운데 6종은 현재 규모에서 순수 비용/복잡도 증가 요인이며 제출 후 안전하게 처리 가능하다. 단, `ss-mcp-server`의 `minScale=1` 비용 구조와 Knowledge Catalog의 접근 방식(아직 미채택 상태로 DECISIONS.md에 분류되어 있지만 Dataplex와의 혼동)은 명확히 문서화할 필요가 있다.

---

## 1. 놓친 기능 갭

| # | 발견 | 출처 | 영향 | 작업량 | 권고 |
|---|---|---|---|---|---|
| G1 | **GKE Agent Sandbox** — 에이전트 코드 격리 실행 환경. 현재 Cloud Run `gen2`로 에이전트를 직접 실행하며 gVisor 격리 없음. SERVICE-INVENTORY.md는 `Agent Sandbox (GKE Autopilot gVisor)`를 `✅ Used (D23)`로 기록하나, 실제 `deploy/agents/service.yaml`은 Cloud Run gen2 단독임. | Slide 08 (Orchestration 컬럼) · SERVICE-INVENTORY.md:39 · deploy/agents/service.yaml | 보안 격리 레이어 부재. 제출 데모에는 영향 없으나 Devpost Tech 30% 심사 시 "진짜 Agent Sandbox를 쓰는가"라는 질문이 나올 수 있음 | 클레임 수정(서류상 정렬) 또는 gVisor 활성화 플래그 추가 | 클레임과 실제 배포 간 불일치를 HONEST-SCOPE에 row 추가로 명시. 마이그레이션은 제출 후. |
| G2 | **Knowledge Catalog** — SERVICE-INVENTORY.md:138은 `Knowledge Catalog (=Dataplex) ✅ D22 "Data governance + lineage for PIPA evidence"`로 기록. 그런데 Slide 04의 Knowledge Catalog는 "에이전트용 통합 메타데이터 카탈로그"(에이전트가 쓰는 데이터 디스커버리 레이어)로 전혀 다른 신제품임. 현재 ADK 22-agent 플리트에는 에이전트가 소비하는 데이터 계약/스키마 카탈로그가 없음. | Slide 04 (Agentic Data Cloud) · SERVICE-INVENTORY.md:138 · DECISIONS.md D22 | 22-agent 플리트의 `CAPABILITY_LAYER_MODE=stub/live` 세임(D41)이 카탈로그 없이 운용됨. 에이전트가 어떤 데이터 스키마를 소비하는지 기계-판독 가능한 형태가 없어 장기적으로 운영 부채 | 서비스 인벤토리 오기재 수정 + Knowledge Catalog(에이전트 메타데이터 용도) 채택 여부 결정 | D-8 내 서류 수정: "Dataplex = PIPA 거버넌스 (D22)"와 "에이전트용 Knowledge Catalog = 미채택" 분리 기재 |
| G3 | **GKE Inference Gateway** — Vertex `global` 엔드포인트를 현재 Cloud Run + `packages/agents-adk` 가 직접 호출. ADK 랭커(`gemini-3.5-flash`)와 벌크 분류(`gemini-3.1-flash-lite`)가 같은 프로젝트 쿼터를 공유함. Inference Gateway는 모델 라우팅·로드밸런싱·쿼터 분리를 Cloud Run 외부에서 제공. | Slide 08 (Orchestration 컬럼) · README.md 아키텍처 다이어그램 · HONEST-SCOPE.md row 8 (engagement_rate 0 = 백엔드 Group-B 일일 쿼터 소진 기재) | 현재 쿼터 소진 시 사용자 체감 가능(HONEST-SCOPE row 8에서 인정한 Group-B quota artifact). Inference Gateway가 있으면 모델별 쿼터 분리 + 폴오버 가능 | 제출 후 GKE 마이그레이션 선행 필요; D-8 내 불가 | 안전 디퍼. 현재 쿼터 이슈는 HONEST-SCOPE에 이미 공개되어 있으므로 제출 영향 없음. |
| G4 | **Deep Research Agent** — Slide 04의 신제품. 현재 `research` agent (Tier-1, `web.search` Google Search grounding)가 리서치 역할을 맡고 있음. Deep Research Agent는 GCP 관리형 심층 리서치 자동화 제품으로, 현재 `research` 에이전트의 능력 범위(Google Search grounding으로 5개 출처, HONEST-SCOPE row 17)를 초과하는 멀티홉 리서치를 처리함 | Slide 04 · gcp-research/decisions/ARCHITECTURE.md §3 `research` agent 행 · HONEST-SCOPE.md row 17 | 기능 중복보다 우월한 GCP 관리형 옵션이 존재함을 인지하지 못한 채 자체 구현. 판사 입장에서 "왜 Deep Research Agent를 안 썼나"라는 질문 가능 | 현재 `research` 에이전트 교체 시 ADK FunctionTool → Deep Research Agent 어댑터 필요 | 안전 디퍼. 현재 grounding 라이브 동작(HONEST-SCOPE row 17 demonstrated-live)으로 충분. Deep Research Agent 통합은 v4 계획에 추가 권고. |
| G5 | **Cloud Storage Rapid** — Slide 08 Network & Storage 컬럼. 현재 스택에 Cloud Storage 사용처는 `SERVICE-INVENTORY.md:120`(Demo replay buckets, assets, audit archive, translation cache) 이나, Rapid는 고빈도 에이전트 I/O(에이전트 상태 체크포인팅, Firestore 부담 경감)에 최적화된 새 스토리지 클래스 | Slide 08 · SERVICE-INVENTORY.md:120 | Firestore Memory Bank + 현 Cloud Storage가 에이전트 상태 저장을 커버. Cloud Storage Rapid는 레이턴시 요건이 있는 에이전트 중간 상태 저장 시 유의미하나 현재 워크로드 규모에서는 비용 이점 불명확 | 스토리지 클래스 변경으로 비교적 낮은 작업량이나 ROI 검증 먼저 필요 | 안전 디퍼. 현재 규모에서는 표준 Cloud Storage로 충분. |
| G6 | **Managed Lustre** — Slide 08 Network & Storage 컬럼. 대용량 병렬 파일시스템으로 GPU/TPU 학습 워크로드 타겟. 현재 스택에 GPU/TPU 학습은 `SERVICE-INVENTORY.md:41`(GKE + GPU/TPU ✅ D25)에 계획되어 있으나 현실 배포는 Cloud Run + Vertex 추론만 운용 중 | Slide 08 · SERVICE-INVENTORY.md:41 · terraform/BUILD-NOTES.md BN-11 | 현재 배포에는 Lustre 요구 워크로드(SFT, distillation) 미존재. 계획(D25) 수준에만 해당 | 대규모 학습 파이프라인 도입 시 검토 | 안전 디퍼. 판사 기준 무관한 인프라 레이어. |
| G7 | **Axion N4A (CPU)** — Slide 08 Compute 컬럼. Google 자체 ARM 기반 서버 CPU 인스턴스. 현재 Cloud Run gen2는 CPU 유형 비선택적; `deploy/agents/service.yaml`은 `2 CPU / 4Gi`로 일반 x86 인스턴스 사용 | Slide 08 · deploy/agents/service.yaml:112 | Python ADK 런타임의 CPU-bound 구간(JSON 파싱, Pydantic 검증)에 N4A는 15-30% 처리량 향상 가능. 그러나 Cloud Run은 인스턴스 유형 직접 선택 불가 — N4A는 GCE/GKE 워크로드 대상 | 아키텍처 변경 없이 적용 불가 (Cloud Run 제약) | 안전 디퍼. Cloud Run 아키텍처 유지 결정(D17 대안, 실제 배포)과 충돌 없음. |
| G8 | **TPU Ironwood** — Slide 08 Compute 컬럼. 추론 최적화 TPU. D53 제약(gemini-3.5-flash + 3.1-flash-lite on Vertex global)으로 우리가 직접 TPU를 관리하지 않음 — Vertex global 엔드포인트 뒤에 Google이 관리하는 인프라. 비용·레이턴시 영향은 Google의 내부 결정 | Slide 08 · DECISIONS.md D53 · README.md Tech stack 테이블 | D53 제약상 직접 선택 불가. Vertex global이 내부적으로 Ironwood를 활용할 경우 자동 수혜. 판사에게는 "우리는 Vertex global을 사용하므로 Google이 선택하는 최적 하드웨어에서 실행된다"로 서술 가능 | 작업량 0. 클레임 문구 정교화만 필요 | 추가 조치 없음. 단, Devpost 서술에 "Vertex global = Google-managed inference infra(Ironwood 포함)"로 표현하면 Slide 08 정합 가능. |

---

## 2. 디퍼하지 말아야 할 것 (D-8 처리 후보)

### P1 — Agent Sandbox 클레임 불일치 수정 (G1)

**이유**: SERVICE-INVENTORY.md가 `Agent Sandbox (GKE Autopilot gVisor) ✅ D23`으로 기록하지만 실제 `deploy/agents/service.yaml`은 Cloud Run gen2 단독임. Devpost 심사에서 기술 데모와 서류 간 불일치가 발견되면 신뢰도 손상.

**해결 방법 (D-8 내 가능)**: HONEST-SCOPE.md에 row 추가 — "Agent Sandbox: 문서에 D23으로 계획됨; 현재 배포는 Cloud Run gen2(gen2 자체는 강화된 샌드박스지만 gVisor는 아님). GKE Autopilot gVisor 마이그레이션은 제출 후." 이 수정은 코드/배포 변경 없이 문서만 수정하면 됨. 소요: 약 1시간.

**판단 근거**: HONEST-SCOPE.md §3 수정 패턴(item 1-5)과 동일한 정직성 원칙(RULES.md §Professional Honesty).

### P2 — Knowledge Catalog 서비스 인벤토리 오기재 수정 (G2)

**이유**: SERVICE-INVENTORY.md:138이 "Knowledge Catalog (=Dataplex) ✅ D22 PIPA evidence"라고 쓰고 있지만, Slide 04의 Knowledge Catalog는 에이전트 메타데이터 카탈로그 신제품으로 Dataplex와 다른 제품이다. 심사관이 Slide 04를 보고 "Knowledge Catalog 쓰나요?"라고 물으면 잘못 기재된 인벤토리가 혼선을 야기한다.

**해결 방법 (D-8 내 가능)**: SERVICE-INVENTORY.md의 Knowledge Catalog 행을 두 개로 분리:
- `Dataplex (=기존 Data Catalog) ✅ D22 — PIPA 거버넌스 + 데이터 계보`
- `Knowledge Catalog (Next '26 Agentic Data Cloud 신제품) ⬜ — 에이전트 메타데이터 카탈로그; 평가 대상`

소요: 약 30분.

---

## 3. 안전한 디퍼

| 항목 | 이유 | 마이그레이션 비용 | 리스크 |
|---|---|---|---|
| GKE Inference Gateway (G3) | Vertex global 엔드포인트가 제출 데모에서 동작 중. 쿼터 이슈는 HONEST-SCOPE에 이미 공개. | GKE 클러스터 프로비저닝(~$50-100/월 기본 비용) + Agent Runtime → GKE 마이그레이션. 소요 2-4주 | 제출 후 안정적으로 처리 가능 |
| Deep Research Agent (G4) | `research` 에이전트의 grounding이 demonstrated-live(HONEST-SCOPE row 17). 현 기능으로 심사 충분. | ADK FunctionTool 어댑터 재작성 + 테스트 전면 교체(agents-adk pytest 2924 기존 커버리지 유지 필요). 소요 1-2주 | 낮음. v4 재작성 계획(README.md) 시 함께 처리 권고 |
| Cloud Storage Rapid (G5) | 현재 워크로드 규모에서 ROI 불명확. 에이전트 상태는 Firestore가 커버. | 스토리지 클래스 변경만이면 낮은 공수. 그러나 성능 검증 필요. | 낮음 |
| Managed Lustre (G6) | 현 배포에 GPU/TPU 학습 워크로드 없음. D25(SFT/Distillation)가 실제 구현될 때 검토. | GKE + Lustre FSx 프로비저닝 + 파이프라인 통합. 비용 높음(~$500+/월 최소). | 낮음(현재 비관련) |
| Axion N4A (G7) | Cloud Run 아키텍처 유지 결정(실제 배포)과 충돌. 적용하려면 GKE 마이그레이션 선행. | Cloud Run → GKE 마이그레이션 선행 비용 포함. 소요 2-3주. | 낮음 |
| TPU Ironwood (G8) | D53 제약으로 직접 제어 불가. Vertex global 뒤에서 Google이 관리. | 작업 없음. Devpost 서술 정교화만. | 없음 |

---

## 4. 새로 발견된 위험/모순

### R1 — `ss-mcp-server` minScale=1 비용 구조와 증거 파일 불일치

**출처**: README.md "Cloud Run ≈ $1–5/mo" + `gcp-research/refactor-mcp/code/deployment/cloud-run-service.yaml:24 (autoscaling.knative.dev/minScale: "1")` + HANDOFF.md 2026-05-24 §7 "ss-mcp-server minScale=1, 비용 약간 ↑(여전히 ~$1–5/mo대)"

**위험 내용**: README.md와 HONEST-SCOPE.md 양쪽에서 "Cloud Run ≈ $1–5/mo"라고 기재되어 있으나, `ss-mcp-server`는 minScale=1 + `containerConcurrency: 30` + 2-container(ADK + Node MCP sidecar)로 24시간 웜 상태 유지. Cloud Run gen2의 실제 idle 비용은 인스턴스 1개 × (0.000024$/vCPU-s + 0.0000025$/GB-s) 기준으로 약 $3-8/월(single container 기준). Multi-container + minScale=1은 이 수치보다 높을 수 있음.

**영향**: $1–5/mo 주장이 과소평가된 경우 심사관이 비용 섹션을 직접 검증할 때 불일치 발견 가능. HONEST-SCOPE에 정확한 비용 추정 또는 "측정 예정" 명시 권고.

**완화**: 실 청구 내역 확인 후 README.md + HONEST-SCOPE 비용 수치 정확화. D-8 내 처리 가능(수치 수정 30분).

### R2 — Cloud Run Cold Start vs 사용자 체감 (ss-agents min=0)

**출처**: README.md "ss-agents min=0" + deploy/agents/service.yaml:50 `autoscaling.knative.dev/minScale: "0"` (어? 실제 파일은 `"1"`로 기재) — 이 둘이 불일치. README.md는 "나머지 min=0"이라 적고 있으나 service.yaml 실제 값은 `minScale: "1"`임.

**위험 내용**: 
- README.md 19줄: `ss-mcp-server kept warm at minScale=1, the rest min=0`
- `deploy/agents/service.yaml:50`: `autoscaling.knative.dev/minScale: "1"` — `ss-agents`도 minScale=1

이는 비용 이중 계상 가능성. 또는 service.yaml이 의도적으로 `ss-agents`도 1로 설정한 것이라면 README 문구가 부정확함.

**완화**: `deploy/agents/service.yaml` 실제 값을 기준으로 README.md 아키텍처 설명 업데이트. 만약 의도적으로 `ss-agents`도 minScale=1이라면 비용 추정 재검토.

### R3 — Agent Sandbox와 실제 배포 간 클레임 불일치 (G1의 위험 버전)

**출처**: gcp-research/decisions/ARCHITECTURE.md §1 Mermaid 다이어그램 `AS[Agent Sandbox GKE Autopilot · gVisor]` + SERVICE-INVENTORY.md:39 `Agent Sandbox ✅ D23` + 실제 `deploy/agents/service.yaml` Cloud Run gen2

**위험 내용**: Devpost 서류에 "Agent Sandbox (GKE Autopilot gVisor)"가 ✅로 기재될 경우, 심사관이 실제 배포 코드를 확인하면 Cloud Run 단독임을 발견함. Track 3 Tech 30% 채점에서 신뢰도 문제로 이어질 수 있음.

**완화**: P1(§2)에서 권고한 HONEST-SCOPE 행 추가로 해결 가능.

### R4 — Data Agent Kit 미평가

**출처**: Slide 04 (Agentic Data Cloud, Data Agent Kit 카드)

**위험 내용**: Data Agent Kit은 데이터 에이전트 구축을 위한 새 SDK/프레임워크 성격이나, SERVICE-INVENTORY.md + DECISIONS.md 어디에도 평가/검토 기록이 없음. ADK(D17)와 중복 또는 보완 관계인지 불명확.

**영향**: 판사가 "GCP의 Agentic Data Cloud 레이어를 쓰는가"라고 물을 때 대답할 준비가 안 된 상태.

**완화**: SERVICE-INVENTORY.md에 `Data Agent Kit ⬜ — ADK(D17)와 기능 중복 평가 필요; D-8 내 평가 불가` 행 추가. 소요 15분.

### R5 — Cross-Cloud Lakehouse 미언급

**출처**: Slide 04 (Cross-Cloud Lakehouse 카드)

**위험 내용**: 현재 스택은 MongoDB Atlas(공유 v1 + v2_* 컬렉션, DECISIONS.md D15 Spanner/AlloyDB로 아키텍처 결정됨)로 운용 중. Cross-Cloud Lakehouse는 멀티클라우드 데이터 호수로, MongoDB Atlas + GCP Vertex 혼용 구조가 실질적 "cross-cloud" 패턴에 해당하지만 이를 Cross-Cloud Lakehouse 컨텍스트로 서술한 적 없음.

**영향**: 실제로 MongoDB(AWS Atlas) + GCP 혼용이라는 사실을 "Cross-Cloud Lakehouse 패턴의 실용 사례"로 Devpost 서술에 활용할 수 있는 기회를 놓치고 있음.

**완화**: 기회 수준. DECISIONS.md 또는 Devpost write-up에 "v2 현재 배포는 MongoDB Atlas(external cloud) + Vertex AI(GCP) 혼용 = Cross-Cloud Lakehouse 패턴의 현실적 구현"으로 서술 가능. 소요 30분.

---

## 5. 권고 우선순위 Top 3

### #1 — HONEST-SCOPE Agent Sandbox 불일치 명시 (P1, G1, R3) [D-8 처리]

**무엇을**: HONEST-SCOPE.md에 row 18 추가: "Agent Sandbox: SERVICE-INVENTORY.md D23에 GKE Autopilot gVisor로 계획됨. 현재 실제 배포(deploy/agents/service.yaml)는 Cloud Run gen2 — gen2는 강화된 샌드박스이나 gVisor는 아님. GKE gVisor 마이그레이션은 제출 후(안전 디퍼 #1)."

**왜 지금**: 서류와 코드 간 불일치는 정직성 원칙(RULES.md) 위반이며 심사 신뢰도 손상 리스크 > 작업 비용.

**작업량**: 문서 수정 1시간.

### #2 — Knowledge Catalog / Dataplex 서비스 인벤토리 분리 기재 (P2, G2) [D-8 처리]

**무엇을**: SERVICE-INVENTORY.md의 단일 `Knowledge Catalog (=Dataplex) ✅`를 두 행으로 분리. 심사관이 Slide 04를 보고 "Knowledge Catalog를 어떻게 쓰나요?"라고 물을 때 명확한 답변 가능.

**왜 지금**: Slide 04는 데크에서 Agentic Data Cloud 챕터의 첫 번째 카드 — 심사관이 반드시 확인하는 내용.

**작업량**: 문서 수정 30분.

### #3 — ss-mcp-server 실 비용 검증 + README 비용 수치 정확화 (R1) [D-8 처리]

**무엇을**: GCP 콘솔에서 `ss-mcp-server` 실 청구 내역(최근 7일 기준) 확인 후 README.md "Cloud Run ≈ $1–5/mo" 수치 검증. 초과 시 HONEST-SCOPE에 실제 수치 명시.

**왜 지금**: 비용 주장은 판사가 직접 검증 가능한 영역이며, Track 3 Business 30% 평가에서 비용 효율성이 핵심 항목.

**작업량**: 콘솔 확인 30분 + 문서 수정 30분.

---

## 부록 — 슬라이드-제품-코드 3방향 매핑

| Slide 08 / 04 제품 | DECISIONS.md 항목 | 실제 코드/배포 | 갭 분류 |
|---|---|---|---|
| TPU Ironwood | D53 Vertex global 엔드포인트(간접 수혜) | 직접 없음 — Vertex 뒤에서 Google 관리 | 안전 디퍼(G8) |
| Axion N4A | SERVICE-INVENTORY.md:35 Cloud Run gen2 | deploy/agents/service.yaml CPU 2 (x86) | 아키텍처 제약으로 N/A(G7) |
| Virga Network | SERVICE-INVENTORY.md Cloud Service Mesh ✅ D31 | terraform/modules/networking/ | 대체재 이미 존재 |
| Managed Lustre | SERVICE-INVENTORY.md GKE+GPU/TPU ✅ D25(계획) | 현재 배포 없음 | 안전 디퍼(G6) |
| Cloud Storage Rapid | SERVICE-INVENTORY.md:120 Cloud Storage ✅ | terraform/modules/data/ 표준 클래스 | 안전 디퍼(G5) |
| GKE Agent Sandbox | SERVICE-INVENTORY.md:39 Agent Sandbox ✅ D23 | deploy/agents/service.yaml Cloud Run gen2 | **D-8 문서 수정 필요(G1/R3)** |
| GKE Inference Gateway | SERVICE-INVENTORY.md 미기재 | 없음 — Vertex global 직접 | 안전 디퍼(G3) |
| GKE Hyperdisk | SERVICE-INVENTORY.md 미기재 | 없음 (현 Cloud Run 아키텍처와 무관) | 안전 디퍼 |
| Knowledge Catalog | SERVICE-INVENTORY.md:138 잘못 분류(Dataplex와 혼동) | 없음 | **D-8 분리 기재 필요(G2)** |
| Deep Research Agent | 미기재 | research agent (Google grounding) | 안전 디퍼(G4) |
| Cross-Cloud Lakehouse | 미기재 | MongoDB Atlas + Vertex AI 혼용 = 사실상 패턴 | Devpost 서술 기회(R5) |
| Data Agent Kit | 미기재 | ADK(D17)로 커버 추정 | R4 — 인벤토리에 ⬜ 추가 |
