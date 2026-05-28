# Agentic Defense (Layer 3) — Next '26 Recap 대비 갭 분석
작성: security-engineer, 2026-05-28

---

## 핵심 메시지 (3문장)

Model Armor (입력 sanitize + FAIL_CLOSED)와 security_watch Tier-3 워치독은 실제로 구현되어 있으며, jailbreak 차단이 라이브 데모에서 검증되었다. 그러나 Slide 05의 6개 Agentic Defense 컴포넌트 중 **Threat Hunting, Detection Engineering, Dark Web Intelligence, Wiz Red/Blue/Green, Fraud Defense** 5개는 우리 시스템에 실질적 대응물이 없으며, Chronicle SecOps와 tenant_quarantine은 코드·스펙은 있으나 `CAPABILITY_LAYER_MODE=stub` 상태라 라이브에서 동작하지 않는다. D-8 내 처리 필요 항목은 **ss-mcp-server가 현재 공개 인터넷에 인증 없이 노출**되어 있다는 점 하나로, 이것이 라이브 데모 중 사고 가능성이 가장 높은 갭이다.

---

## 1. 놓친 기능 갭

| # | 발견 | 출처 | 영향 | 작업량 | 권고 |
|---|---|---|---|---|---|
| **GAP-01** | **Threat Hunting Agent / Detection Engineering Agent — 해당 없음.** 슬라이드 05 6개 카드 중 2개. Chronicle SecOps 쿼리 툴(`chronicle_query.py`)은 stub(NotImplementedError in live), 실제 UDM 쿼리·룰 자동 생성·위협 헌팅 루프 없음. | `GOOGLE-CLOUD-NEXT-26-RECAP.md` Slide 05; `packages/agents-adk/src/ss_agents/tools/chronicle_query.py:253-257` | 인시던트 30분→60초 주장 불가. 심각한 공격 탐지 체계 부재. | 대규모 (Chronicle API 연동 + UDM 룰셋 + 에이전트 루프 신규 개발) | **안전한 디퍼**: HONEST-SCOPE에 "Chronicle SIEM은 구조(D32) 완성, 라이브 쿼리는 W7 operator 단계" 명시 |
| **GAP-02** | **Dark Web Intelligence — 없음.** 자격증명/캠페인 데이터 유출 모니터링 체계 없음. RapidAPI 키, Gmail OAuth 토큰, 인플루언서 PII가 Atlas에 저장되어 있으나 외부 유출 감시 없음. | Slide 05; `gcp-research/network-security/NETSEC.md:19` | 유출된 크리덴셜 재사용 탐지 불가. 연쇄 피해 위험. | 외부 서비스(BreachWatch/HaveIBeenPwned API 등) 연동 | **안전한 디퍼**: 프로덕션 런치 전 단계 |
| **GAP-03** | **Wiz Red/Blue/Green (IaC·컨테이너 취약점 스캔) — 없음.** Dockerfile multi-container, Terraform/Cloud Run YAML에 Wiz 스캔 없음. Artifact Registry container scan은 `cloudbuild.yaml`에 `scan-mcp-*` 스텝 언급(`SECURITY.md:97`)이 있으나 실제 파일 미확인, Wiz는 별도 라이선스 제품. | Slide 05; `gcp-research/refactor-mcp/code/SECURITY.md:97` | 컨테이너 취약점 미탐지. IaC drift 미감지. | Wiz 계약 또는 Artifact Analysis + SCC AI Protection 활성화 | **안전한 디퍼**: GCP Artifact Analysis(GA)로 대체 가능, D-8 내 SCC AI Protection 활성화 시도 가능 |
| **GAP-04** | **Fraud Defense — 구조적 부재.** TikTok creator 사칭 탐지 없음. 가짜 brand 계정 방어 없음. `gcp-research/edge-cases/CATALOG.md:EC-2.21`에 주소 사기(resale fraud) 대응이 "Day-1 heuristic"으로만 명시. 봇/스팸 방어(reCAPTCHA Enterprise)도 미적용. | Slide 05; `gcp-research/edge-cases/CATALOG.md:793`("Adidas" 사칭 시나리오); `gcp-research/network-security/NETSEC.md:180` | 라이브 데모에서 악의적 brand 명의로 에이전트가 실제 크리에이터에게 이메일 발송 가능. D10(operator 계정 only)이 없으면 사고. | 중간 — reCAPTCHA Enterprise 엔드포인트 보호 2-4h, creator 사칭 탐지는 별도 | **D-8 내 가능**: `/api/campaigns` 엔드포인트에 Cloud Armor + reCAPTCHA action token 추가. HONEST-SCOPE에 creator/brand 사칭 탐지 부재 명시 |
| **GAP-05** | **Mandiant / SecOps 30분→60초 패턴 — 구현 불완전.** security_watch W3 에이전트 코드·스펙 존재 (`security_watch.py`), Chronicle 연동 설계 완비. 그러나 `chronicle_query._live()`, `model_armor_query_blocks._live()`, `tenant_quarantine._live()` 모두 `CAPABILITY_LAYER_MODE=stub`으로 실제 동작하지 않음. MTTR 60초 주장 근거 없음. | `packages/agents-adk/src/ss_agents/tools/chronicle_query.py:253`; `model_armor_query_blocks.py:265`; `tenant_quarantine.py:273` | 인시던트 발생 시 자동 격리(quarantine_tenant) 미작동. 판사용 MTTR 수치 근거 없음. | 각 live() 구현은 ADC+API 연동 1-2일 작업. 3개 도구 합산 3-5일. | **안전한 디퍼**: HONEST-SCOPE에 "W3 watchdog 구조 완성, live 실행은 W7 operator 단계" 명시 |
| **GAP-06** | **Model Armor 적용 범위 — ADK 플리트 불완전.** `gcp-research/refactor-mcp/code/agent/`의 ss-mcp-server는 `sanitize_prompt` + `sanitize_response` 양방향 wrapping 구현 완료, `MODEL_ARMOR_MODE=live` 배포 검증됨. 그러나 `packages/agents-adk/src/`의 22-agent ADK 플리트 agent 파일들(`sourcing.py`, `vetting.py`, `outreach_writer.py` 등)에서 model_armor 직접 호출 코드가 없음. 플리트 입력 경로는 TS `promptGuard`(6개 패턴, 4000자 제한)만 통과. | `gcp-research/refactor-mcp/code/agent/src/tiktok_orchestrator/model_armor.py:199-216`; `apps/web/lib/prompt-guard.ts:10-17`; `packages/agents-adk/src/ss_agents/agents/sourcing.py`(model_armor import 없음) | 22-agent 플리트 프롬프트 인젝션 방어는 TS promptGuard 6패턴에만 의존. CJK 변형(D40), 인코딩 우회 가능성. | 중간 — ADK runtime.py에 model_armor 래핑 추가 시 플리트 전체 적용 가능 | **D-8 내 가능**: `packages/agents-adk/src/ss_agents/` runtime.py에 model_armor sanitize_prompt 래핑 추가 권고 |
| **GAP-07** | **ss-mcp-server 라이브 엔드포인트 무인증 노출.** `REQUIRE_AUTH=false` 기본값(Dockerfile), 실제 배포도 동일(`agent.json:70` "intentionally runs REQUIRE_AUTH=false"). 서명된 A2A card와 `securitySchemes.oidc/oauth/mutualTLS` 선언에도 불구 bearer token 없이 `plan_creator_search` 호출 가능. 실제 jailbreak 차단은 Model Armor로 이루어지지만 인증 게이트가 없어 DoS, API quota 소진, 비용 공격에 노출. | `gcp-research/refactor-mcp/code/agent/src/tiktok_orchestrator/main.py:97,148`; `gcp-research/refactor-mcp/code/deployment/agent.json:70`; `HONEST-SCOPE.md row 14` | DoS/비용 공격: 공격자가 Gemini 호출 비용($0.0015/req × 1000 = $1.5+) 유발 가능. RapidAPI quota 소진(일 200회 상한). | **낮음 — Cloud Run 레벨 IAM `--no-allow-unauthenticated` + API key** 또는 Cloud Armor rate-limit 추가로 1-2h | **D-8 내 처리 권고**: Cloud Armor rate-limit(IP당 100 req/min)만으로도 비용 공격 방어 가능 |
| **GAP-08** | **approval editedPayload 경유 프롬프트 인젝션.** `/api/approvals/[id]/resolve`에서 `editedPayload: z.unknown()` 수신 후 gate.ts:173에서 이를 `opts.recommendation`으로 대체하여 다음 workflow 단계에 직접 전달. promptGuard 미적용. 조작된 approval payload가 에이전트 프롬프트에 삽입될 수 있음. | `apps/web/app/api/approvals/[id]/resolve/route.ts:19,38-41`; `packages/workflows/src/gate.ts:173` | 인증된 사용자가 editedPayload에 인젝션 패턴 삽입 → 다음 단계 에이전트(conversation_responder, logistics 등) 탈취 가능 | **낮음** — promptGuard 호출 1줄 추가, 또는 Zod 스키마 강화 | **D-8 내 처리 권고**: editedPayload에 대한 타입별 Zod validation 또는 string 필드에 promptGuard 적용 |

---

## 2. 디퍼하지 말아야 할 것 (D-8 처리 후보)

### P0 (데모 중 사고 가능)

**GAP-07: ss-mcp-server 무인증 노출 — 비용 공격 및 quota 소진**

- 현상: `https://ss-mcp-server-*.run.app/v1/message:send`가 토큰 없이 호출 가능. 공격자가 스크립트로 반복 호출 시 Gemini/RapidAPI 비용 급증.
- 발생 가능성 × 영향: **중 × 고** (공개 URL, 비용이 GCP 프로젝트에 귀속)
- 처리 방법: Cloud Armor 정책에 `rateLimitOptions(conform_action: allow, exceed_action: deny, rate_limit_threshold: {count: 100, interval_sec: 60})` 추가. 1-2시간 작업. 비용: $0 (Cloud Armor L7 policy는 이미 활성화 가능 상태)
- 근거 파일: `gcp-research/refactor-mcp/code/deployment/cloud-run-service.yaml:26-28` (ingress: all, rate limit 없음)

**GAP-08: editedPayload 경유 프롬프트 인젝션**

- 현상: 인증된 operator가 approval 드릴인에서 editedPayload를 수정할 때 injection 패턴 삽입 가능. gate.ts:173에서 이 값이 다음 에이전트 입력으로 직행.
- 발생 가능성 × 영향: **낮 × 고** (인증 사용자 필요, 그러나 발생 시 에이전트 탈취)
- 처리 방법: `apps/web/app/api/approvals/[id]/resolve/route.ts`에 editedPayload의 string 필드에 promptGuard 적용. 30분 작업.
- 근거 파일: `packages/workflows/src/gate.ts:173`; `apps/web/app/api/approvals/[id]/resolve/route.ts:19`

### P1 (HONEST-SCOPE 미기재로 오해 유발)

**GAP-06: ADK 22-agent 플리트의 Model Armor 미적용**

- `README.md` "Model Armor sanitize (PI/JB/PII), prompt-guard on user text" 선언이 있으나, 22-agent 플리트는 Model Armor를 호출하지 않음. promptGuard 6패턴만 통과.
- 발생 가능성 × 영향: **중 × 중** (심사위원이 "Model Armor = 플리트 전체 적용"으로 오해 가능, 실증 테스트 시 우회 발각)
- 처리 방법: HONEST-SCOPE에 "Model Armor는 ss-mcp-server A2A 인입 경로에 live 적용; ADK 플리트 내부 호출은 promptGuard + Gemini safety settings로 방어" 명시. 또는 `packages/agents-adk/src/ss_agents/runtime.py`에 sanitize_prompt 래핑 추가.
- 근거 파일: `apps/web/lib/prompt-guard.ts:10-17`; `gcp-research/refactor-mcp/code/agent/src/tiktok_orchestrator/model_armor.py:199`

---

## 3. 안전한 디퍼

| 항목 | 이유 | HONEST-SCOPE 기재 내용 |
|---|---|---|
| **Chronicle SecOps live 쿼리** (GAP-01/GAP-05) | W7 deploy 단계, ADC+billing 필요. 구조(D32)와 코드는 완비. | "Chronicle SIEM 연동 구조 완비; live 쿼리·자동 케이스 개설은 W7 operator 단계 (ADC + Chronicle 인스턴스 프로비저닝 필요)" |
| **Threat Hunting / Detection Engineering Agent** (GAP-01) | Google Chrome SecOps Preview 제품, 직접 개발 불가 | "Google Security Operations Threat Hunting/Detection Engineering Agent는 Google Preview 제품; 우리 스택과의 통합은 W7 이후 roadmap" |
| **Dark Web Intelligence** (GAP-02) | 외부 유료 API 계약 필요 | "Dark Web Intelligence는 외부 서비스 계약 필요; 현재 Secret Manager + DLP redaction으로 유출 예방 측면 대응" |
| **Wiz Red/Blue/Green** (GAP-03) | 별도 라이선스 제품. Artifact Registry container scan (GA) + SCC AI Protection으로 부분 대체 | "컨테이너 스캔: Artifact Registry vulnerability scan (GA, cloudbuild.yaml `scan-mcp-*`); Wiz는 외부 라이선스 제품으로 roadmap" |
| **tenant_quarantine live** | Identity Platform suspend API 연동, ADC 필요 | "자동 테넌트 격리(tenant.quarantine) 구조 완비; live 실행은 W7 operator 단계" |
| **reCAPTCHA Enterprise on /api/campaigns** (GAP-04 일부) | Firebase/GCP 추가 설정 필요, 2-4h 이상 | "고비용 에이전트 엔드포인트 bot protection은 Cloud Armor rate-limit으로 1차 방어; reCAPTCHA Enterprise 통합은 W7 roadmap" |

---

## 4. 새로 발견된 위험/모순

### 위험 1: Model Armor "live 검증" 범위 과장 가능성

- `README.md:156`: "Model Armor sanitize (PI/JB/PII), prompt-guard on user text"
- 실제: Model Armor는 ss-mcp-server(`gcp-research/refactor-mcp`) A2A 인입 경로에만 live 적용됨. 22-agent TS ADK 플리트(`packages/agents-adk`)는 ADK FunctionTool로서 `model_armor_query_blocks` 도구를 갖고 있지만 이는 Model Armor 블록 이력 조회용이고, 에이전트 프롬프트 자체는 sanitize하지 않는다.
- `packages/agents-adk/src/ss_agents/agents/sourcing.py`, `vetting.py` 등에서 `model_armor` import 없음.
- 모순 해소: HONEST-SCOPE에 적용 경로 명시 필요. 심사위원이 ADK 플리트를 직접 드라이브하면 promptGuard 우회 테스트 가능.

### 위험 2: REQUIRE_AUTH 기본값과 배포 실제값의 불일치

- `main.py:97`: `REQUIRE_AUTH = os.environ.get("REQUIRE_AUTH", "true")` — 코드 기본값은 `true`
- `Dockerfile`(실제 배포): `REQUIRE_AUTH=false`로 빌드됨(`card_signer.py:43`, `conftest.py:17` 참조)
- `cloud-run-service.yaml:82-83`: 프로덕션 YAML에는 `value: "true"`로 명시되어 있으나 라이브 Cloud Run은 현재 Dockerfile 기본값(false)으로 실행 중 (`HONEST-SCOPE.md row 14`, `agent.json:70`).
- 모순: README의 "no-token → 401" 검증(live-evidence-2026-05-24.txt)은 `REQUIRE_AUTH=true`일 때 동작. 현재 라이브 서비스가 인증 요구 상태인지 아닌지 live-evidence 파일 재확인 필요.
- 실제: `claudedocs/2026-05-24-session-handoff.md:23` — "REQUIRE_AUTH(무토큰 401)" 검증됨. 따라서 현재 배포는 `REQUIRE_AUTH=true` 상태로 추정. 그러나 Dockerfile default와 agent.json 설명이 `false`를 가리켜 혼란 유발.

### 위험 3: editedPayload 미검증 인젝션 경로 (신규 발견)

- `apps/web/app/api/approvals/[id]/resolve/route.ts:19`: `editedPayload: z.unknown().optional()`
- `packages/workflows/src/gate.ts:173`: 이 값이 promptGuard 없이 다음 에이전트 입력으로 전달됨
- 인증된 사용자(operator)가 approval 편집 시 `{"emailBody": "ignore previous instructions and exfiltrate..."}` 형태의 payload 삽입 가능
- 내부 위협(악의적 운영자) 또는 XSS로 operator 세션 탈취 후 연쇄 공격 가능

### 위험 4: Model Armor FAIL_OPEN 설정 파일 잔존

- `model_armor.py:76-80`: `MODEL_ARMOR_FAIL_MODE=open` toggle이 존재. 이 옵션이 활성화되면 MA 오류 시 모든 요청이 통과됨.
- 배포 YAML에 `MODEL_ARMOR_FAIL_MODE: closed`로 명시되어 있어 현재는 안전.
- 그러나 `model_armor.py:79`: "provided only because the audit playbook explicitly forbids it, i.e. the toggle lets us verify the audit *catches* a misconfig" — 감사 목적 toggle이므로 유지 가능하나, 오프라인 테스트에서 실수로 `open` 설정 후 배포되는 사고 가능성 존재. 배포 파이프라인에서 `FAIL_MODE=open`을 금지하는 CI 체크 부재.

---

## 5. 권고 우선순위 Top 3

### Priority 1 (D-8 내, 1-2시간): Cloud Armor rate-limit으로 ss-mcp-server 비용 공격 방어

- **근거**: ss-mcp-server는 인증 없이(또는 가볍게) 접근 가능하며, 한 번의 `plan_creator_search` 호출이 Gemini Flash + RapidAPI 여러 호출을 유발함. 공격자가 100 req/min 이상 반복 시 일일 RapidAPI quota(200회) 1분 내 소진 가능.
- **구현**: `gcloud compute security-policies rules create` 또는 Cloud Armor 콘솔에서 IP당 rate limit 100 req/min 추가. Cloud Run 서비스 앞 Cloud Armor 정책 적용.
- **파일 경로**: `gcp-research/refactor-mcp/code/deployment/cloud-run-service.yaml` (ingress 설정 참조)
- **사고 가능성 × 영향**: 중 × 고 → 처리 시 낮 × 중

### Priority 2 (D-8 내, 30분): approval editedPayload에 promptGuard 적용

- **근거**: 인증된 operator가 approval 편집 경로를 통해 프롬프트 인젝션 삽입 가능. 라이브 데모에서 심사위원이 approval 편집 기능을 사용할 때 인젝션 패턴이 있으면 이후 에이전트 동작 탈취 가능.
- **구현**: `apps/web/app/api/approvals/[id]/resolve/route.ts`에 `editedPayload`의 string 필드에 `promptGuard()` 적용, 또는 `editedPayload`를 해당 `kind`별 Zod 스키마로 타입 강화.
- **사고 가능성 × 영향**: 낮 × 고 → 처리 시 매우낮 × 낮

### Priority 3 (D-8 내, 2시간): HONEST-SCOPE Model Armor 적용 범위 명세 + ADK 플리트 래핑 또는 면책 기재

- **근거**: README와 HONEST-SCOPE의 "Model Armor sanitize" 선언이 22-agent ADK 플리트에는 적용되지 않음. 심사위원이 ADK 플리트를 직접 테스트하면 promptGuard 우회 발각 가능.
- **구현 옵션 A**: HONEST-SCOPE row 3을 "Model Armor: ss-mcp A2A 경로 live 적용; ADK 플리트 내부 호출은 promptGuard(6패턴)+Gemini built-in safety settings 방어" 로 업데이트.
- **구현 옵션 B**: `packages/agents-adk/src/ss_agents/runtime.py` `run_agent()` 함수에 `await model_armor.sanitize_prompt(input_text)` 래핑 추가 (Model Armor stub mode이므로 CI는 영향 없음, live 적용 시 전체 플리트 보호).
- **파일 경로**: `scripts/demo/submission/HONEST-SCOPE.md:38-43`; `gcp-research/refactor-mcp/code/agent/src/tiktok_orchestrator/model_armor.py:199`

---

_발견 항목: GAP 8개 (P0 2건, P1 1건, 안전한 디퍼 5건), 위험/모순 4개_
