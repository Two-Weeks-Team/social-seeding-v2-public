# UNIFIED-TRACK3-PLAN.md — 단일 Track 3 제출 (전체 플랫폼 포괄) 통합 계획

> **확정**: 회의 결과 + user 2026-05-20. **Track 3 단일 Devpost 제출**, Track 2(22-agent 플랫폼 전체)를 그 안에 포괄 통합. D29 3-angle 모두 강조. 데모도 통합본. 예산은 D46 상태기반 auto-scale.
>
> **근거 결정**: D45 (single Track 3 subsumes platform, supersedes D1) · D46 (essential-asset retention + auto-scale) · D29 (3-angle) · D2/D3 (KR-gap → A2A 혁신) · D27 (AP2 Intent only) · D39 ($1,500 cap).
>
> **마감**: 2026-06-05 23:59 PT. 오늘 2026-05-20 기준 D-16.

---

## 1. 통합 서사 (Devpost 단일 제출의 한 문장)

> **"Social Seeding은 한국 스타트업이 Cloud Marketplace 결제-region에서 제외되는 한계를, 22-agent ADK 함대 + AP2 Intent Mandate + 멀티모달 파이프라인이 A2A v0.3로 서로를 호출하는 생태계로 전환한 사례다. 그 생태계의 첫 외부 노드가 OSS `tiktok-mcp-server`를 리팩터한 A2A 에이전트이며, Gemini Enterprise에 등록되어 region 제약 없이 분배된다."**

- **씨앗(Track 3 정의 충족)**: OSS MCP 서버 → A2A v0.3 ADK 에이전트 리팩터 (Refactor 트랙)
- **포괄(Track 2 흡수)**: coordinator agent의 `a2a_invoke`가 그 노드를 호출 → 22-agent 플랫폼 전체가 A2A 생태계로 동작
- **혁신(KR-gap)**: Marketplace 직접 등록 불가 → A2A-only 분배 패턴 (비-Marketplace-region 스타트업 일반 패턴)

3-angle 매핑:
- **D29-A (Agent-as-function)**: 22-agent, 49 typed tools, USD 캡, Zod/Pydantic 계약
- **D29-B (KR-region-gap)**: A2A-only 분배, Gemini Enterprise 등록, OSS 컨트리뷰션
- **D29-C (Multimodal+AP2+Multi-agent)**: Imagen/Veo/Lyria + AP2 Intent Mandate + RemoteA2AAgent fan-out

---

## 2. 통합 작업 정의 (I-series) — W1~W5 done 위에 쌓음

기존 상태: W1-W4 (P0) ✅ · W5 (3 GCP 프로젝트 생성+빌링) ✅ · 라이브 데모 사이트 ✅ (PR #1, #2 merged).

| ID | 작업 | Owner subagent | DoD (Definition of Done) | 의존 | 비용 |
|---|---|---|---|---|---|
| **I1** | **Track 3 A2A 코어 실배포** — `gcp-research/refactor-mcp/code/`를 `ss-mcp-prod` Cloud Run에 배포; agent.json A2A v0.3 published; Identity Platform OIDC 테넌트 설정; Gemini Enterprise 등록 신청(O7 allowlist 포함) | `devops-architect` | `curl https://<mcp>.run.app/.well-known/agent.json` 200 + A2A v0.3 schema valid; `/healthz` 200; Identity Platform 테넌트 1개 생성 | W5 | min=0 ~$1/mo |
| **I2** | **Track 2 플랫폼 실배포** — `apps/web` Mission Control → Cloud Run (`ss-v2-prod`); `packages/agents-adk` 22-agent → Vertex AI Agent Runtime(또는 Cloud Run 폴백, BN-11 D17 shim); `CAPABILITY_LAYER_MODE=live` 일부 도구만 점진 활성 | `devops-architect` | Mission Control `/healthz` 200; 최소 3개 에이전트 Agent Runtime/Cloud Run에 live; 나머지는 stub 유지 OK | W5, I1 | min=0 ~$2/mo |
| **I3** | **Cross-component A2A 통합 검증** — coordinator agent의 `a2a_invoke`가 배포된 tiktok-mcp-server를 실제 호출; end-to-end 통합 smoke (brand brief → sourcing이 a2a_invoke로 mcp 호출 → 결과 회수) | `quality-engineer` + `python-expert` | `scripts/smoke-test/run-integration-a2a.sh` exit 0; coordinator→mcp 1회 이상 성공 호출 로그 | I1, I2 | 트래픽당 |
| **I4** | **D46 auto-scale 인프라** — 모든 Cloud Run min=0; `terraform/environments/judging/` 신설(심사 기간 warm-up: Cloud Scheduler가 6/5-6/20 min=1, 그 외 min=0); `scripts/ops/scale-down.sh` + `scripts/ops/teardown-heavy.sh`(Spanner/AlloyDB destroy); cost_watch가 billing_query 임계→pubsub_alert→scale-down runbook | `devops-architect` | scale-down/teardown 스크립트 dry-run 통과; Cloud Scheduler cron 2개 배포; cost_watch runbook 와이어 | I1, I2 | 스크립트=무료 |
| **I5** | **통합 데모 재구성** — `STORYBOARD-unified.md` 신설(Track 2 흐름 → a2a_invoke로 Track 3 노드 호출 → 결과 통합, 한 서사 24씬→압축); HTML 웹데모(`site/demo/`) 업데이트해 통합 흐름 반영 + scene-jump hash 딥링크; (선택) OBS 3분 녹화 | `technical-writer` + `frontend-architect` | `STORYBOARD-unified.md` 작성; web-demo가 통합 흐름 시연; 라이브 사이트 재배포 | I3 | 재배포 ~$0 |
| **I6** | **단일 Devpost 제출문 통합** — `devpost-track3.md`를 "플랫폼 포괄" 메시지로 재작성(Track 2 콘텐츠 흡수); `devpost-track2.md`는 archived; SCREENSHOTS-MANIFEST 통합본; CHECKLIST 단일 제출용으로 갱신 | `technical-writer` | 단일 제출문 ≤ Devpost 글자 제한; 24장 스크린샷 매니페스트; YouTube/라이브 URL 슬롯; O1 GAP 답변란 | I5 | 무료 |

### Track 3 official-requirement 보강 (I7-I9, designed_guide.pdf gap-analysis + 운영자 승인 2026-05-20)

| ID | 작업 | Owner subagent | DoD | 의존 | 비용 | 해소 GAP |
|---|---|---|---|---|---|---|
| **I7** | **Model Garden LLM 라우팅** (D47, PDF 요건 #3) — Gemini 호출을 Model Garden 배포 endpoint 경유로 전환; `packages/agents-adk` model config + `deploy/` IAM 갱신; "strict data security" 문서화 | `devops-architect` + `python-expert` | 최소 1개 에이전트가 Model Garden endpoint로 reasoning; `deploy/model-garden/README.md` 문서; pytest green 유지 | I1 | ~$0 (호출당) | Technical 30% |
| **I8** | **A2A intents 매니페스트 + Agent Identity** (D48, PDF 요건 #6 + p.7) — `gcp-research/refactor-mcp/A2A-INTENTS.md`(expose/consume 모든 intent 매핑); `agent.json` 보강; agent별 crypto ID(SPIFFE/SPIRE 또는 Agent Identity workload cert); PDF Build Example #2 ↔ `content_verify` 1:1 매칭 명시 | `technical-writer` + `security-engineer` | A2A-INTENTS.md 작성; agent.json A2A v0.3 valid + identity 필드; Build Example #2 매칭 섹션 | I1 | ~$0 | Technical 30% + Agent Identity |
| **I9** | **와우 + 비즈니스 보강** (D49, Demo 20% + Business 30%) — (a) 실제 Imagen/Veo 생성 1회(`CAPABILITY_LAYER_MODE=live`) 데모에 (b) A2A cross-call 애니메이션 다이어그램 (c) ROI/TAM 시각화 씬($0.01/view, D28) (d) PDF Build Example #2 매칭 on-screen | `frontend-architect` + `technical-writer` | web-demo에 실제 생성 결과 1개; A2A 애니메이션; ROI/TAM 씬; Build Example #2 콜아웃 | I3 | ~$5-20 (실제 생성) | Demo 20% + Business 30% + Innovation 20% |

운영자-전용 잔여 (자율 불가):
- Gemini Enterprise 등록 승인 (O7 allowlist, Google 처리 1-2주) — I1에서 신청만, 승인은 대기
- OBS 녹화 (I5에서 storyboard만, 실제 녹화는 운영자) — 단, HTML 웹데모로 대체 가능
- Devpost 폼 Submit 클릭 (I6에서 텍스트 준비, 클릭은 운영자)
- O1 Devpost 10 GAP 답변

---

## 3. D46 auto-scale 예산 설계 (상태기반)

**원칙**: 정적 tier(옵션 A/B/C) 폐기 → 트래픽이 비용을 결정. 필수 자산만 평가까지 유지.

| 자산 | 분류 | 스케일 정책 | idle 비용 |
|---|---|---|---|
| `ss-landing` (랜딩+데모+보고서) | 필수 (평가까지) | Cloud Run min=0 / max=10 | ~$0 (idle) |
| `ss-mcp` A2A endpoint (Track 3 코어) | 필수 (평가까지) | Cloud Run min=0 / max=10 | ~$0 (idle) |
| `ss-v2-web` Mission Control | 필수 (평가까지) | Cloud Run min=0 / max=10 | ~$0 (idle) |
| Gemini Enterprise 등록 | 필수 | 등록 유지 (무료) | $0 |
| 22-agent Agent Runtime | 상태기반 | 데모/검증 시 활성, 평소 min=0 | ~$0 (idle) |
| Firestore (데모 데이터 5-20) | 필수 | 항상 (거의 무료) | ~$0 |
| Spanner / AlloyDB | 일회성 | 데모 녹화/검증 때만 `terraform apply` → 직후 `teardown-heavy.sh` | $0 (미존재) |
| KMS keys (54개) | 선택 | 보안 데모 필요 시만 `day-1-setup.sh kms` | ~$80/mo if on |

**warm-up cron** (심사 기간 latency 보장): Cloud Scheduler가 `2026-06-05 ~ 2026-06-20` 동안 매시 ss-landing/ss-mcp/ss-v2-web에 keep-alive ping (min=1 효과). 그 외 기간 min=0.

**cost_watch 자동 가드**: Tier-3 `cost_watch` 에이전트가 `billing_query`로 일일 USD 추적 → 50/75/90/95% 임계마다 `pubsub_alert` → 90% 도달 시 `runbook_execute("scale_down")` 자동 트리거.

**예상 누적**: 평가까지 유지 자산 idle 합계 ≈ $1-5/mo. 데모 녹화/검증 시 일시 scale-up ≈ $20-50 일회성. **D39 $1,500 캡의 ~3% 이하 예상.**

---

## 4. 확정 실행 순서 (운영자 승인 2026-05-20 — I7-I9 포함)

승인된 우선순위: **I1 → I7 → I2 → I8 → I3 → I4 → I9 → I5 → I6** (Wave로 병렬화)

```
W1-W5 (done)
  Wave 1: I1 (Track 3 배포) ∥ I2 (Track 2 배포) ∥ I8 (A2A intents 문서, 배포 독립)
  Wave 2: I7 (Model Garden 라우팅) — I1 후
  Wave 3: I3 (A2A 통합검증) ∥ I4 (auto-scale) — I1+I2 후
  Wave 4: I9 (와우/비즈 보강) — I3 후
  Wave 5: I5 (통합 데모) → I6 (단일 제출문)
```

- **Wave 1 병렬**: I1(Track3 배포) + I2(Track2 배포) + I8(A2A intents 문서 — 배포와 독립이라 즉시 가능)
- **I7**(Model Garden)은 I1 후 (배포된 에이전트 LLM 라우팅 변경)
- **I3**(통합검증)은 I1+I2+I7 후 (실제 cross-call + Model Garden 경유 검증)
- **I4**(auto-scale)는 I1+I2 후 병렬
- **I9**(와우/비즈)는 I3 후 (검증된 흐름 위에 실제 생성 + 시각화)
- **I5→I6**은 I9 후 (보강된 데모가 제출문에 반영)

---

## 5. 완료 정의 (단일 Track 3 제출 준비 완료)

1. ✅ Track 3 A2A endpoint 라이브 + agent.json 200 (I1)
2. ✅ Track 2 Mission Control + 핵심 에이전트 라이브 (I2)
3. ✅ coordinator→mcp a2a_invoke 1회 이상 성공 (I3)
4. ✅ 모든 Cloud Run min=0 + warm-up cron + teardown 스크립트 (I4)
5. ✅ 통합 데모 (HTML 웹데모 갱신 + STORYBOARD-unified) (I5)
6. ✅ 단일 Devpost 제출문 + 24 스크린샷 매니페스트 + URL 슬롯 (I6)
7. ✅ pytest green 유지 + 라이브 URL 200 + STATUS-REPORT 갱신
8. ⚠️ 운영자: Gemini Enterprise 승인 대기 · O1 GAP 답변 · Devpost Submit 클릭

---

## 6. 동반 문서

- [`GOAL-PROMPT-UNIFIED.md`](GOAL-PROMPT-UNIFIED.md) — 복붙용 `/goal` 프롬프트 3종 (Full / Deploy-first / Demo+Submission)
- [`GOAL-PROTOCOL.md`](GOAL-PROTOCOL.md) — proof artifact + blocking + done 계약 (그대로 유효)
- [`DISPATCH-MATRIX.md`](DISPATCH-MATRIX.md) — task → subagent 라우팅 (그대로 유효)
- `gcp-research/decisions/DECISIONS.md` — D45/D46 신규, D1 superseded
