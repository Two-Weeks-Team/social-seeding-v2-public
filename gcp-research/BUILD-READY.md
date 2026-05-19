# BUILD-READY.md — 빌드 시작 가이드

> **상태**: 사전 리서치 100% 완료. 모든 39 decisions 동결. 코드 작성 가능.
> **위치**: `/Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/`
> **마지막 업데이트**: 2026-05-19

---

## 1. 완료된 산출물 (전체 67 files, ~225,000 단어)

### 🧭 의사결정 문서 (Single source of truth)
- [`decisions/DECISIONS.md`](decisions/DECISIONS.md) — 39 decisions D1-D39
- [`decisions/ARCHITECTURE.md`](decisions/ARCHITECTURE.md) — 7 Mermaid 다이어그램 + per-region matrix
- [`decisions/SERVICE-INVENTORY.md`](decisions/SERVICE-INVENTORY.md) — 121 GCP services, 95 Used

### 🏛️ 기초 리서치 (7 docs)
- [`platform-audit/AUDIT.md`](platform-audit/AUDIT.md) · [`track-rules/CHALLENGE-RULES.md`](track-rules/CHALLENGE-RULES.md)
- [`compute/COMPUTE.md`](compute/COMPUTE.md) · [`ai-agents/AI-AGENTS.md`](ai-agents/AI-AGENTS.md) · [`data/DATA.md`](data/DATA.md) · [`network-security/NETSEC.md`](network-security/NETSEC.md) · [`devops/DEVOPS.md`](devops/DEVOPS.md)

### 📋 Track 3 특화 (4 docs)
- [`submission-playbook/TRACK3-PLAYBOOK.md`](submission-playbook/TRACK3-PLAYBOOK.md) · [`protocols/PROTOCOLS.md`](protocols/PROTOCOLS.md) · [`refactor-mcp/REFACTOR-MCP.md`](refactor-mcp/REFACTOR-MCP.md) · [`model-armor/ARMOR-GATEWAY.md`](model-armor/ARMOR-GATEWAY.md)

### 🛠️ Track 2 + 빌드 도구 (5 docs)
- [`porting-v2/PORTING-V2.md`](porting-v2/PORTING-V2.md) · [`adk-deep/ADK-GUIDE.md`](adk-deep/ADK-GUIDE.md) · [`genkit-deep/GENKIT.md`](genkit-deep/GENKIT.md) · [`gemini-models/GEMINI-MODELS.md`](gemini-models/GEMINI-MODELS.md) · [`demo-deliverables/SUBMISSION-PACKAGE.md`](demo-deliverables/SUBMISSION-PACKAGE.md)

### 💰 비용 + 진입점 (4 docs)
- [`cost-planning/COST-PLAN.md`](cost-planning/COST-PLAN.md)
- [`INDEX.md`](INDEX.md) · [`EXECUTION-CALENDAR.md`](EXECUTION-CALENDAR.md) · [`EXECUTIVE-SUMMARY.md`](EXECUTIVE-SUMMARY.md)

### 🔧 13개 백그라운드 에이전트 산출물 (이번 라운드 신규)

| # | 영역 | 위치 | 분량 |
|---|---|---|---|
| A1 | Inngest → Workflows 마이그레이션 | `migrations/INNGEST-MIGRATION.md` | 7,200단어 / 40 step.run 인벤토리 |
| A2 | Instagram email feasibility | `sources/INSTAGRAM.md` | 4,200단어 / Apify 추천 |
| A3 | SDD specs × 22 agents (4 formats) | `specs/{_common,tier1,tier2,tier3}/` | **26 files / 5,914 lines** |
| A4 | TDD test matrix 5-layer | `tests/MATRIX.md` | 5,803단어 / 267 골든 케이스 |
| A5 | Simulation scenarios | `simulation/SCENARIOS.md` + `scenarios.yaml` | 529 + 5,285 lines / **104 scenarios** |
| A6 | AP2 Mandate UX (3 surfaces) | `ux/AP2-UX.md` | 7,099단어 / 14 risks + 9 anti-patterns |
| A7 | Demo 8× recording + 4-locale 자막 | `demo/SCRIPT.md` + `subtitles/*.srt` | 5,534단어 + 4×42cues |
| A8 | Chaos engineering | `chaos/SCENARIOS.md` | 6,279단어 / **25 failure scenarios** |
| A9 | Edge-case catalog | `edge-cases/CATALOG.md` | 12,886단어 / **78 cases** |
| A10 | Pricing $0.01/view | `pricing/MODEL.md` | 7,273단어 / 4-expert panel |
| A11 | Devpost write-up (T2 + T3) | `submission/DEVPOST.md` | 4,200단어 |
| A12 | KR-gap strategy | `strategy/KR-GAP.md` | 7,804단어 / 5-expert panel |
| A13 | gcloud CLI full mastery | `gcloud-mastery/GCLOUD-MASTERY.md` | 8,225단어 / 46 sub-sections |

### ⚙️ 실행 도구
- [`scripts/day-1-setup.sh`](scripts/day-1-setup.sh) — GCP 부트스트랩 (14.9KB, 실행권한 부여)

---

## 2. 빌드 시작 전 사전 점검 (3분)

### ✅ 환경 점검
```bash
# 위치
cd /Users/kimsejun/Documents/GitHub/social-seeding-v2

# 빌드 그린 확인 (v2의 354 tests 통과 유지)
pnpm run verify-build

# git 상태 (사전 리서치 산출물 staging 안 함, 별도 commit)
git status
git log --oneline -5
```

### ✅ GCP 계정 점검
```bash
# 로그인 (app.2weeks@gmail.com)
gcloud auth login --account=app.2weeks@gmail.com
gcloud auth application-default login --account=app.2weeks@gmail.com

# 결제 계정 확인 (vibeCat 수상 크레딧 $1500)
gcloud beta billing accounts list
# → ACCOUNT_ID 복사 (예: 01XXXX-XXXXXX-XXXXXX)

# 활성 계정 확인
gcloud config get-value account
# → app.2weeks@gmail.com 이어야 함
```

---

## 3. Day-1 부트스트랩 (gcloud로 30분)

### 명령 1: 환경변수 설정
```bash
export BILLING_ACCOUNT="01XXXX-XXXXXX-XXXXXX"   # 위에서 복사한 값
export OPERATOR_EMAIL="app.2weeks@gmail.com"
export PROJECT_V2="ss-v2-prod"
export PROJECT_MCP="ss-mcp-prod"
export PROJECT_SHARED="ss-shared-infra"
export BUDGET_TOTAL_USD="1500"
cd /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/scripts
```

### 명령 2: 3개 프로젝트 생성 + billing 연결
```bash
./day-1-setup.sh init
```
**결과**: `ss-v2-prod` + `ss-mcp-prod` + `ss-shared-infra` 생성, billing $1500 연결

### 명령 3: Track 2 프로젝트 풀세팅
```bash
./day-1-setup.sh all "${PROJECT_V2}"
```
**결과**: 60+ API 활성화, 9개 Artifact Registry repo, 18개 CMEK key, 8 secrets, $1500 예산 + 9 알림, 15 Pub/Sub 토픽

### 명령 4: Track 3 프로젝트 풀세팅
```bash
./day-1-setup.sh all "${PROJECT_MCP}"
```

### 명령 5: 검증
```bash
./day-1-setup.sh verify "${PROJECT_V2}"
./day-1-setup.sh verify "${PROJECT_MCP}"
```

---

## 4. Day-2 빌드 시작 — 8가지 즉시 실행 명령어

빌드 단계를 다시 background 에이전트로 분담. 사용자는 다음 명령어 중 원하는 것을 선택해 저에게 보내시면 즉시 실행됩니다.

### 명령 1 — Track 2 v2 포팅 시작
```
Track 2 빌드 시작.
PORTING-V2.md §5의 outreach_writer 포팅을 첫 작업으로.
Vertex AI Agent Runtime + Gemini 2.5 Pro tournament.
SDD spec: specs/tier1/outreach_writer.spec.md
```
→ 저는 outreach_writer를 Python ADK로 실제 포팅 + 테스트 작성 + Cloud Run 배포까지 진행.

### 명령 2 — Track 3 MCP 리팩토링 시작
```
Track 3 빌드 시작.
REFACTOR-MCP.md의 9-day 플랜대로 진행.
microservices/tiktok-mcp-server에 ADK orchestration layer 추가.
```
→ tiktok-mcp-server에 `agent/` 디렉토리 생성, ADK Python wrapper 120줄, Dockerfile 멀티 컨테이너, agent.json.

### 명령 3 — Terraform 모듈 8개 동시 생성
```
Terraform 8개 모듈 생성.
SERVICE-INVENTORY §13의 modules/{compute,data,networking,security,observability,devops,ai,integration}/
~140 resources 정의.
```
→ 백그라운드 에이전트 8개로 모듈 동시 생성.

### 명령 4 — 5개 신규 agent 실제 구현
```
신규 agent 5개 구현: payment_mandate, compliance, creative, a11y, customer_success.
specs/tier1/*.spec.md 4-format 스펙대로 ADK 코드 + pytest + golden eval.
```
→ 백그라운드 에이전트 5개 병렬 실행.

### 명령 5 — Mission Control UI 신규 surface 3개 추가
```
Mission Control에 AP2 approval 화면 추가.
ux/AP2-UX.md §3 명세 그대로.
모바일 PWA + Dialogflow CX 통합 포함.
```
→ Next.js 16 App Router + React 19 + shadcn/ui + Tailwind v4.

### 명령 6 — 데모 영상 녹화 환경 준비
```
데모 영상 녹화 환경 셋업.
demo/SCRIPT.md + demo/subtitles/*.srt 대로.
OBS 프로파일 + ffmpeg pipeline 스크립트.
```
→ `scripts/demo/` 디렉토리에 OBS profile + recording.sh + post-process.sh 자동 생성.

### 명령 7 — DECISIONS.md 변경 적용 (D40+)
```
edge-cases/CATALOG.md의 EC-2.29 / EC-3.02 / EC-4.02 / EC-6.04를 
DECISIONS.md에 새 결정 D40-D43으로 정식 기록.
```
→ DECISIONS.md change log 업데이트 + 영향 받는 spec 파일 자동 갱신.

### 명령 8 — Devpost 콘솔 10개 GAP 확인 (사용자 작업)
```
Devpost 콘솔 열고 10개 GAP 답변.
goo.gle/486nbl4 또는 devpost.team/hackathon_guest_invites/4fb181b4-...
```
→ 사용자 직접 작업, 답변 받으면 EXECUTION-CALENDAR.md 확정.

---

## 5. 핵심 결정 빠른 참조 (자주 확인)

| 결정 | 값 | 위치 |
|---|---|---|
| 듀얼 제출 | v2→T2, MCP→T3 | D1 |
| KR 법인 | Marketplace 직접 불가, A2A-only 경로 | D2/D3 |
| 마감 | 2026-06-05 PT (시간 무시 per D7) | D6 |
| 크레딧 | $1,500 (vibeCat 수상 외) | D39 |
| Region | Global active-active (US+EU+APAC) | D13 |
| OLTP | Spanner + AlloyDB AI + Firestore | D15 |
| Vector | Vertex AI Vector Search | D16 |
| Runtime | Vertex AI Agent Runtime managed | D17 |
| Orchestration | Workflows + Pub/Sub + Cloud Tasks + Eventarc (Inngest 폐기) | D18 |
| Auth | Identity Platform multi-tenant + Workforce IF | D19 |
| Model Armor | 극대 (Anomaly Detection + auto-block) | D21 |
| 22 agents | 16 Tier-1 + 3 Tier-2 + 3 Tier-3 watchdog | D23 |
| Learning | Prompt + Eval + SFT + Distill + RLHF | D25 |
| UI | Mission Control + Dialogflow CX + 모바일 PWA | D26 |
| AP2 | Intent Mandate만 (human approval) | D27 |
| Pricing | $0.01/view ($10 CPM) | D28 |
| Demo | 8× 마우스 액션 + 투명 프리뷰 | D30 |
| SLO | 99.99%/yr, RTO 1m, RPO 30s | D31 |
| 데이터 수명 | PII 30d / Audit 90d / Memory 14d | D33 |
| i18n | 한+영+일+중 | D34 |
| 코드베이스 | Hybrid (capabilities/contracts keep, agents/workflows rebuild) | D35 |
| SDD | AsyncAPI + OpenAPI + JSON Schema + Mermaid | D36 |
| TDD | Agent Eval + Vitest + pytest + Simulation + Chaos | D37 |
| Agent org | M3 PM + tier-2 lead + tier-3 worker | D38 |

---

## 6. Outstanding 의사결정 (백그라운드 에이전트가 식별)

빌드 중 한 번씩 처리. 코드 시작은 막지 않음.

### 새 결정 후보 (edge-cases/CATALOG.md에서 발견 — D40 후보)
- **D40 후보**: AP2 mandate replay 방지 → UUIDv7 + nonce + Spanner unique constraint
- **D41 후보**: Cross-tenant prompt leak → capability 계층 `tenant_id` assertion + DLP scan
- **D42 후보**: Spanner stale read 31s 위험 → mandate/blacklist/budget read는 `read_only_staleness=0`
- **D43 후보**: Multi-step indirect injection → orchestrator는 raw text 금지, typed contract만

### Pricing 보강 (pricing/MODEL.md에서 O13-O18)
- O13: 캠페인당 view cap 디폴트 (viral 폭발 대비)
- O14: 크리에이터 페이아웃 tier
- O15: FX vendor (KRW ↔ USD)
- O16: Free tier 어뷰즈 방지
- O17: Dispute SLA
- O18: GAAP revenue recognition 시점

### AP2 UX 보강 (ux/AP2-UX.md에서 O5.1-O5.5)
- O5.1: WebAuthn 강제 threshold 금액
- O5.2: Mandate 보존 기간 (D33 PII 30d와 일관?)
- O5.3: 음성 readback 정확도 측정
- O5.4: 모바일 푸시 deep-link 보안
- O5.5: 캐리어 어댑터 의존성 unblock 시기

---

## 7. 운영 검증 (선택적)

빌드 중 일관성 검증을 위한 명령어:

```bash
# DECISIONS.md 결정 ID가 모든 산출물에서 일관되게 인용되는지
grep -rn "D[0-9]\+" gcp-research/ | wc -l

# SDD specs가 22개 다 있는지
ls gcp-research/specs/tier{1,2,3}/*.spec.md | wc -l   # 22여야 함

# Simulation scenarios 100+ 인지
yq '. | length' gcp-research/simulation/scenarios.yaml

# Day-1 스크립트 실행 가능한지
gcp-research/scripts/day-1-setup.sh --help

# 13 background agents 작업 완료 확인
ls -la gcp-research/{migrations,sources,specs,tests,simulation,ux,demo,chaos,edge-cases,pricing,submission,strategy,gcloud-mastery}/
```

---

## 8. 다음 메시지 템플릿

사용자가 빌드 시작 시 가장 간단한 명령:

```
명령 1로 진행. outreach_writer Python ADK 포팅 시작.
```

또는 더 ambitious:

```
명령 3 + 4 동시 진행. Terraform 8 모듈 + 신규 agent 5개 병렬.
```

또는 전체:

```
명령 1-7 모두 동시 진행. 백그라운드 에이전트 30+ 스폰. 
완료되는 대로 자동 알림.
```

코드 작성 단계로 진입할 준비가 끝났습니다.
