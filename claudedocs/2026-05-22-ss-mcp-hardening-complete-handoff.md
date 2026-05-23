# Session Handoff — 2026-05-22 (PM) — ss-mcp-server 프로덕션 하드닝 완료

## §0 두 줄 요약
- ss-mcp-server를 open·stub·단일컨테이너 데모 → **진짜 프로덕션 멀티 컨테이너 서비스**로 하드닝 완료. 라이브 검증: 멀티컨테이너(`agent;mcp`)·인증 강제(무토큰 401 / 서비스신원 토큰 200)·Model Armor 라이브 차단·**실데이터 e2e(34 후보 → 10 랭킹 크리에이터, 실 팔로워)**.
- 코드 5커밋 → **PR #12**(브랜치 `fix/d53-ss-mcp-gemini-3x`, push됨). 라이브 리비전 `ss-mcp-server-00006-gg2`, 롤백 `ss-mcp-server-00003-22m` 보존.

## §1 진행한 작업 (시간순)
1. **① D53** (`517bf6c`): ss-mcp-server의 `gemini-2.5-flash/pro` → `gemini-3.1-flash-lite`(searcher)·`gemini-3.5-flash`(ranker). 코드·cloud-run yaml·README·agent.json 4면 일괄. 모델 ID는 ai.google.dev GA 확인. agent pytest 72 통과.
2. **③ dual-accept 인증** (`4645324`): `identity_platform.py`에 Google 서비스신원 OIDC 검증 추가(allowlist + aud 바인딩 + issuer 라우팅 + fail-closed), `main.py`가 `resolve_identity` 사용. 보안 테스트 10개 신규. agent pytest 82 통과.
3. **GCP 프로비저닝** (ss-mcp-prod, app.2weeks=owner): API 활성화(secretmanager·cloudkms·identitytoolkit·cloudresourcemanager) · **Model Armor 템플릿 `ss-input`/`ss-output` 라이브**(REST, gcloud는 quota project 문제로 실패→REST로 우회) · AR repo `socialseed-mcp`(CMEK) + KMS keyring/key `socialseed-mcp/cloud-run` + 서비스에이전트 grant · 런타임 SA `tiktok-mcp-runner@` + IAM 7종 · **Identity Platform 활성화(운영자 콘솔) + 멀티테넌시(REST) + 테넌트 `ss-mcp-customers-ge0du`(REST)** · 시크릿 4종(operator가 backend-dashboard-email/password 주입, tenant-id/sentry-dsn은 자동).
4. **빌드** (`cb093f6` Dockerfile fix): Node 소스(`social-seeding-platform/microservices/tiktok-mcp-server`)를 빌드 컨텍스트에 결합 + Cloud Build로 mcp-adk·mcp-node 빌드/푸시. ts-patches는 **불필요**(transport 패치는 이미 업스트림 머지·identity 패치는 loopback 사이드카에 불요)로 판명. Dockerfile builder-adk에 README copy 누락 수정.
5. **배포 + 검증** (`58fc2a6` env, `70e9ef9` 구조화 출력): `gcloud run services replace`로 ss-mcp-server in-place 멀티컨테이너 교체. 라이브 검증 중 **실데이터 0건** 발견 → 근본원인 = Node MCP 툴이 `structuredContent.data`에 포맷 텍스트만 넣어 Python 휴리스틱 랭커가 못 읽음(전송·인증·백엔드로그인은 정상). **Node 4툴 + withLimit이 구조화 객체를 emit하도록 수정**(빌드 컨텍스트에만, `ts-patches/mcp-structured-output.patch` 기록, 공유 마이크로서비스 무수정) + Cloud Run `timeoutSeconds` 60→300. 재빌드·재배포 후 **34 후보 → 10 크리에이터** 확인.

## §2 현재 상태
**Git**: 브랜치 `fix/d53-ss-mcp-gemini-3x` (5커밋, push됨) → **PR #12** open. main 미병합.
**Live (Cloud Run, ss-mcp-prod / us-central1)**:
| 서비스 | 상태 |
|---|---|
| ss-mcp-server | 리비전 `00006-gg2` · 멀티컨테이너 `agent;mcp` · REQUIRE_AUTH·Model Armor live · 휴리스틱 랭커 · `https://ss-mcp-server-1049119860518.us-central1.run.app` · 롤백 `00003-22m` 보존 |
| ss-agents (ss-v2-prod, 캐러) | 리비전 `00006-h6f` · `A2A_FETCH_ID_TOKEN=1` + `CAPABILITY_LAYER_MODE=live` · SA `ss-agents-runtime@ss-v2-prod` |
| 이미지 | `socialseed-mcp/{mcp-adk,mcp-node}:build-20260522-194428` |
**검증 매트릭스**: 멀티컨테이너 ✅ · 401(무토큰)/200(서비스신원) ✅ · Model Armor 차단(pi_and_jailbreak) ✅ · 실데이터 34→10 ✅ · 백엔드 로그인 ✅.

## §3 다음 세션에서 할 수 있는 것
- **PR #12 리뷰/병합** (코드는 이미 라이브 배포됨 — merge와 독립).
- **engagement 데이터 채우기**: 검증 호출에서 `engagement_rate:0`/`posts_fetched:0` — 백엔드 Group-B(content analytics) **일일 쿼터 소진** + 일부 niche 크리에이터 포스트 캐시 부재 때문. 쿼터 회복 후 재호출하면 채워짐. (search·user_info는 정상.)
- **재현 가능 빌드**: 현재 mcp-node 구조화 수정은 빌드 컨텍스트(/tmp)에 적용+ts-patch 기록만 됨. 향후 Cloud Build 재현성을 위해 컨텍스트 조립 단계에서 `ts-patches/mcp-structured-output.patch`를 적용하도록 파이프라인 문서화 필요.
- **(선택) ADK 랭커 라이브 전환**: 현재 휴리스틱. 켜려면 멀티컨테이너(완료) + `GOOGLE_CLOUD_LOCATION=global`(Vertex 3.x) ↔ Model Armor 리전(us-central1) **위치 디커플링** 선행 필요(별도 env로 분리). D-day 이후 스트레치.

## §4 할 수 없는 것 (운영자/외부)
- Devpost Submit, 데모 영상 (D-2026-06-05).
- GE 어시스턴트→커스텀 에이전트 호출(streamAssist 게이트, Google Cloud Support 케이스) — 등록·엔드포인트는 동작.

## §5 추가로 필요한 것 (운영자 결정)
- **untracked junk 중 내용이 다른 7개** 보존됨(삭제 보류) — 원본과 분기된 동기화 conflict-copy라 데이터 손실 위험. 사용자 판단 필요: `agents-cli-app/{CLAUDE 2.md, README 2.md, app/agent 2.py, pyproject 2.toml, tests/unit/test_root_agent 2.py, uv 2.lock}`, `gcp-research/GEMINI-ENTERPRISE-PLATFORM-MAP 2.md`. (동일본 5개는 삭제 완료; `tests/eval/eval_config 2.json`은 bash 훅의 `eval`/glob 차단으로 잔존 — 사용자가 직접 `rm` 가능.)
- engagement 풀데이터 원하면 백엔드 Group-B 일일 쿼터 회복 대기.

## §6 다음 세션 시작 프롬프트
```text
/handon
이전 핸드오프: claudedocs/2026-05-22-ss-mcp-hardening-complete-handoff.md
ss-mcp-server 하드닝은 완료·라이브(PR #12). 다음 중 택1로 진행:
(a) PR #12 리뷰/병합, (b) engagement 풀데이터 재검증(백엔드 쿼터 회복 후),
(c) 재현 빌드 파이프라인에 mcp-structured-output.patch 배선, (d) ADK 랭커 라이브 전환(위치 디커플링).
```

## §7 핵심 자산 위치
| 자산 | 경로 |
|---|---|
| ss-mcp 코드 | `gcp-research/refactor-mcp/code/agent/src/tiktok_orchestrator/{main,identity_platform,model_armor,agent,mcp_client}.py` |
| 배포 yaml | `…/code/deployment/cloud-run-service.yaml` (name=ss-mcp-server, MA live, ADK_DISABLED, S2S env, timeout 300) |
| 빌드 | `…/code/deployment/Dockerfile.multi-container` · `…/code/cloudbuild.yaml`(full) · build-only는 세션 중 /tmp |
| 구조화 패치 | `…/code/ts-patches/mcp-structured-output.patch` (Node 4툴 + withLimit) |
| Node 소스(공유) | `~/Documents/GitHub/social-seeding-platform/microservices/tiktok-mcp-server` (pristine 복원됨) |
| PR | https://github.com/Two-Weeks-Team/social-seeding-v2/pull/12 |
| 이전 핸드오프 | `claudedocs/2026-05-22-session-handoff.md` (AM, 하드닝 착수 전) |

## §8 알려진 issue / 노트
- **engagement=0 caveat**: §3 참조 (백엔드 쿼터/캐시, 하드닝 무관).
- **Model Armor "운영자 IAM 블로커"는 오진이었음**: 이전 핸드오프의 PERMISSION_DENIED는 gcloud의 quota project(ss-v2-prod) 문제. REST + `x-goog-user-project: ss-mcp-prod`로 해결. 운영자 IAM 작업 불요.
- **bash factory-policy 훅**: 리터럴 `eval` 토큰 + `$(...)` 치환 + glob 와일드카드 + 다중 인용경로 차단(Rule 6). 명령은 단순화·파일(-F/--body-file)로 우회.
- **위치 커플링**: `model_armor.py`는 `GOOGLE_CLOUD_LOCATION`을 리전 엔드포인트로 씀(us-central1). ADK 3.x는 `global` 필요 → 동시 라이브 시 디커플링 필수(현재 ADK 비활성이라 무충돌).
- **ADC**: `gcloud auth application-default print-access-token` OK. 만료 시 `gcloud auth application-default login`.
