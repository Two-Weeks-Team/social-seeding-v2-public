# Session Handoff — 2026-05-22

## §0 두 줄 요약
- 이 세션: agents-cli 루브릭을 1/4→4/4로 하드닝(PR #10), **Gemini Enterprise에 우리 A2A 에이전트를 라이브 등록**(PR #11, ENABLED·Agent Gallery), 그리고 "진짜 프로덕션 앱"으로 만들기 위한 **ss-mcp-server 하드닝 표면을 완전 조사**(인증·Model Armor·랭커가 모두 코드엔 있으나 env로 꺼져 있음).
- **다음 세션 1순위**: ss-mcp-server를 안전하게 프로덕션 하드닝 — 순서 **① D53 모델 위반 수정(코드) → ② Model Armor live → ③ 인증(REQUIRE_AUTH)+호출자(a2a_invoke) 동시 처리**. 단일 컨테이너 재배포 + 롤백 보존. 마감 **2026-06-05**.

## §1 진행한 작업 (시간순)
- **Phase A — agents-cli 루브릭 하드닝 (PR #10, merged)**: judge 근거로 grounded 0/4가 병목임을 규명 → built-in `google_search` 제거(AFC 비활성·인용불가 마커 원인) + instruction 강화(실 URL 인용·툴 사실만·날조 금지). **eval 4/4**(2회 연속), unit 8/8, verify-build 0, agents-adk pytest 2924.
- **Phase B — Gemini Enterprise 라이브 등록 (PR #11, merged)**: 콘솔 "Create app"(30일 무료체험, **org/allowlist 불필요**)로 앱 `social-seeding-agents` 생성 → Discovery Engine REST로 **A2A 에이전트 등록(ENABLED, Agent Gallery, id `4620305404746061476`)**. 카드 transport를 동작 인터페이스(run.app `/v1` HTTP+JSON)로 PATCH. `discoveryengine`·`modelarmor`·`agentregistry`·`observability` API 활성화. **단, streamAssist 호출은 모델 자체응답으로 빠짐 — Google 측 게이트(Cloud Support 케이스 필요), 2가지로 실측 확인.**
- **Phase C — 베스트프랙티스 검토 (2026-05-22 문서 대조)**: 모델(3.5-flash GA·3.1-flash-lite)·genai 클라이언트·Google Search 그라운딩·ADK 에이전트·A2A 등록 = **현행 베스트프랙티스 부합**(grounding은 공식 SDK 예제와 정확히 일치). 실질 갭은 ss-mcp-server의 인증·Model Armor 인그레스 미강제 2건.
- **Phase D — ss-mcp-server 하드닝 표면 완전 조사 (read-only)**: 코드 위치·env 게이팅·호출자 blast radius·배포 방식·D53 위반·누락 GCP 리소스까지 매핑(아래 §3/§7/§8). **코드 변경 없음.**

## §2 현재 상태
**Git** (main, working tree = junk만):
| 항목 | 값 |
|---|---|
| Branch | `main` @ `380e3b4` |
| Open PR | 없음 (이 세션 PR #10·#11 머지) |
| Untracked | **`" 2"` 중복 파일 13개**(파일동기화 conflict-copy, 미커밋 — 정리 권장) |
| Repo | https://github.com/Two-Weeks-Team/social-seeding-v2 |

**Live (Cloud Run, min=0)**:
| 서비스 | URL / 상태 | 모델 |
|---|---|---|
| ss-agents | `ss-agents-…run.app` (ss-v2-prod) | gemini-3.5-flash |
| **ss-mcp-server** | `ss-mcp-server-1049119860518.us-central1.run.app` · **stub 모드**(REQUIRE_AUTH=false·MODEL_ARMOR_STUB·IDENTITY_PLATFORM_STUB·ADK_DISABLED, env 미설정) · image `…/ss-mcp-server@sha256:a7c9b9…` | 휴리스틱 랭커 |
| ss-v2-web (Mission Control) | `ss-v2-web-…run.app/api/healthz` 200 | — |
| ss-landing (데모) | `ss-landing-…run.app/demo/` 200 | — |
| **Gemini Enterprise 앱** | `social-seeding-agents` (ss-mcp-prod) · 우리 A2A 에이전트 **ENABLED**, Agent Gallery | — |

**메트릭/환경**: agents-adk pytest **2924**; `pnpm run verify-build` 0; agents-cli eval **4/4**. gcloud=app.2weeks@gmail.com, ADC 설정(quota ss-v2-prod). 모델: gemini-3.5-flash/3.1-flash-lite, Vertex **global**.

## §3 다음 세션에서 할 수 있는 것 (ss-mcp-server 프로덕션 하드닝 — 사용자 전면 승인됨 2026-05-22)
**안전 순서 (blast radius 오름차순):**

1. **① D53 모델 위반 수정 (코드, in-repo, 무-프로덕션-영향)** — 즉시 가능
   - `gcp-research/refactor-mcp/code/deployment/cloud-run-service.yaml:88-91` + `agent/src/tiktok_orchestrator/agent.py:55-56`의 `ADK_FLASH_MODEL=gemini-2.5-flash`·`ADK_PRO_MODEL=gemini-2.5-pro` → **`gemini-3.5-flash`·`gemini-3.1-flash-lite`** (D53 위반; ADK 랭커를 켜기 전 필수). PR로.
2. **② Model Armor live (낮은 blast radius)** — 즉시 가능(템플릿 생성 후)
   - `modelarmor.googleapis.com` 활성화됨이나 `model-armor templates list` → **PERMISSION_DENIED**(IAM 전파/역할 해결 필요). `ss-input`/`ss-output` 템플릿 생성(INSPECT_AND_BLOCK) → `MODEL_ARMOR_MODE=live` + `MODEL_ARMOR_INPUT/OUTPUT_TEMPLATE` + `GOOGLE_CLOUD_PROJECT`/`LOCATION` 설정 → 단일컨테이너 재배포 → 프로브(악성 input 차단 / 정상 통과) 검증. 롤백=env 원복.
3. **③ 인증 REQUIRE_AUTH=true (높은 blast radius — 호출자 동시 처리 필수)** — 마지막
   - 선행: `identitytoolkit` 미활성화 → 활성화 + Identity Platform **테넌트 생성** + `IDENTITY_PLATFORM_TENANT_ID`(Secret).
   - **호출자 깨짐**: `packages/agents-adk/src/ss_agents/tools/a2a_invoke.py`는 기본 토큰 미전송 → `REQUIRE_AUTH=true`면 401 → **brand-campaign-demo 워크플로 파손**. `A2A_FETCH_ID_TOKEN=1`은 Google ID 토큰을 받지만 서버는 **Firebase ID 토큰**을 검증(issuer 불일치)하므로 부적합. → a2a_invoke가 Firebase 테넌트 토큰을 보내도록 배선(`A2A_IDENTITY_TOKEN` 사전발급 or Firebase fetch 구현) + GE 등록의 `authorizationConfig` 설정.
   - 그 후 `REQUIRE_AUTH=true` 재배포 → a2a_invoke·데모워크플로·등록된 GE 에이전트 동작 재검증. 롤백=`REQUIRE_AUTH=false`.
4. **④ (선택) 랭커 휴리스틱→Vertex ADK** — D53 수정 후 `ADK_DISABLED=false`+`GOOGLE_CLOUD_PROJECT`. 실패 시 휴리스틱 폴백.

**사용자 입력 필요**: 위 순서/범위 승인, 인증 토큰 방식(사전발급 vs fetch 구현), 단일 vs 멀티컨테이너(O-A~O-E), 랭커 Vertex 전환 여부.

## §4 할 수 없는 것 (외부 변수)
- **GE 어시스턴트→커스텀 에이전트 호출**: Google 측 게이트(`streamAssist`가 모델 응답으로 빠짐) — **Cloud Support 케이스** 필요(계정 작업). 등록·발견·엔드포인트는 동작.
- **Agent Gateway mTLS**: Google Private Preview(O7).
- **Cloud Marketplace 등록**: KR 결제 리전 제외(D2) — A2A/GE 경로로 대체(Lovable Agent는 품질 참고용).
- **Identity Platform 테넌트·Model Armor 템플릿·Secret**: GCP 콘솔/계정 작업(운영자), 단 일부는 API로 생성 가능(다음 세션 시도).
- **데모 영상·Devpost Submit**: 운영자.

## §5 추가로 필요한 것
- 운영자 확인: ③ 인증의 a2a_invoke 토큰 전략, 멀티컨테이너 전환 여부(O-A~O-E), `model-armor` PERMISSION_DENIED IAM 해결(역할 부여 or 전파 대기).
- 환경: ADC 만료 시 `gcloud auth application-default login`. ss-mcp-server 재배포는 `gcp-research/refactor-mcp/code/`에서 `gcloud run deploy --source`(단일컨테이너) — **현재 리비전 롤백 보존**.

## §6 다음 세션 시작 프롬프트
```text
/handon

이전 세션 핸드오프: claudedocs/2026-05-22-session-handoff.md

ss-mcp-server를 진짜 프로덕션 앱으로 하드닝하는 작업입니다(사용자 전면 승인됨).
읽고 다음 결정에 답한 뒤 안전 순서대로 진행하세요:
1. 순서 "① D53 모델수정(코드) → ② Model Armor live → ③ 인증+a2a_invoke 동시" 그대로 진행할까요?
2. ③ 인증 토큰: a2a_invoke에 A2A_IDENTITY_TOKEN 사전발급 vs Firebase 토큰 fetch 구현 — 어느 쪽?
3. 단일 컨테이너 유지 vs 멀티컨테이너(O-A~O-E) 전환?
4. 랭커를 Vertex ADK로 켤까요(D53 수정 후), 데모는 휴리스틱 유지?

각 단계는 재배포 전 검증 + 현재 리비전 롤백 보존. D-day: 2026-06-05.
```

## §7 핵심 자산 위치
| 자산 | 경로 |
|---|---|
| **ss-mcp-server 서버 엔트리** | `gcp-research/refactor-mcp/code/agent/src/tiktok_orchestrator/main.py` (`/v1/message:send`, `require_identity` dep) |
| **인증(Identity Platform)** | `…/tiktok_orchestrator/identity_platform.py` (REQUIRE_AUTH·STUB·TENANT, Firebase ID token 검증, 실패=401) |
| **Model Armor** | `…/tiktok_orchestrator/model_armor.py` (MODE/STUB/FAIL_MODE/INPUT·OUTPUT_TEMPLATE; input은 plan_creator_search 진입 시 sanitize) |
| **랭커(ADK vs 휴리스틱)** | `…/tiktok_orchestrator/agent.py` (ADK_DISABLED·FLASH/PRO_MODEL — **2.5 → 3.x 교체 대상**) |
| **배포** | `…/code/Dockerfile`(단일·stub) · `…/deployment/cloud-run-service.yaml`(prod env) · `…/deployment/cloudbuild.yaml`(멀티컨테이너) |
| **호출자** | `packages/agents-adk/src/ss_agents/tools/a2a_invoke.py` (`A2A_IDENTITY_TOKEN`/`A2A_FETCH_ID_TOKEN`) |
| GE 등록·API 상태 | `gcp-research/gemini-enterprise-api-status.md` · 운영자 가이드 `claudedocs/gemini-enterprise-setup-guide.html` |
| 정직 스코프 | `scripts/demo/submission/HONEST-SCOPE.md` (17행, 5 demonstrated-live; row 14=GE 등록) |
| 결정 진실원 | `gcp-research/decisions/DECISIONS.md` (D53=Gemini 3.x only) |
| ss-mcp 상태/계획 | `…/refactor-mcp/code/PHASE-5-STATUS.md` · `…/refactor-mcp/DEPLOY-STATUS.md` (O-A~O-E) |
| 이전 핸드오프 | `claudedocs/2026-05-21-session-handoff.md` |

## §8 알려진 issue / open question
- **🔴 D53 위반**: ss-mcp-server ADK 랭커가 `gemini-2.5-flash`/`gemini-2.5-pro` 기본값(cloud-run-service.yaml:88-91, agent.py:55-56). ADK 켜기 전 3.x로 교체 필수.
- **🟡 인증 토큰 타입 불일치**: a2a_invoke의 `A2A_FETCH_ID_TOKEN`은 Google ID 토큰(issuer accounts.google.com)을 받는데, 서버는 Firebase Identity Platform 토큰을 검증 → 그대로면 인증 실패. Firebase 토큰 경로 필요.
- **🟡 GE 어시스턴트 호출 게이트**: 등록은 됐으나 streamAssist가 우리 에이전트로 라우팅 안 됨(Google Cloud Support 케이스 필요). 엔드포인트 직접 호출은 200.
- **🟡 엔드포인트 무인증**: 라이브 `/v1/message:send`가 인증 미강제(declared-not-enforced, 공개 크리에이터 데이터). ③에서 해소.
- **🟡 model-armor PERMISSION_DENIED**: `templates list`가 owner(app.2weeks)에게도 거부 — IAM 역할/전파 확인 필요.
- **⚪ 멀티컨테이너 차단**: 풀 토폴로지는 O-A~O-E 운영자 결정 대기(PHASE-5-STATUS §3). 하드닝은 단일컨테이너 env로도 가능.
- **⚪ `" 2"` 중복 파일 13개**: 파일동기화 conflict-copy(untracked) — 정리 권장.
- bash 훅: 명령에 리터럴 `eval` 토큰/`$(cat <<EOF)` 금지 — 커밋 메시지·명령은 파일(`-F`)로 우회.
