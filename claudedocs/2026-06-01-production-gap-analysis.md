# 운영 프로덕션 갭 분석 (Production Readiness Gap Analysis)

> 작성 2026-06-01 · 범위: "실제로 굴러가는 멀티테넌트 운영 프로덕션 서비스" 명제 기준
> 근거: 이번 세션 라이브 검증 + 코드베이스 4영역 전수 탐색(file:line) + `HONEST-SCOPE.md`
> 짝 문서: `2026-06-01-onboarding-master.html`(전체 구조) · `2026-06-01-gcp-operations-manual.html`(라이브 증거) · 최신 `*-handoff.md`

---

## 0. 두 개의 명제를 분리한다

| 명제 | 상태 | 판정 |
|---|---|---|
| **(A) 제출/데모 명제** — "각 라이브 다리가 실 인프라에서 온디맨드로 동작함" | 핵심 다리 전부 ≥1회 라이브 증명 + stub/live 경계 정직 기재 | ✅ **대체로 충족** |
| **(B) 운영 프로덕션 명제** — "실고객 캠페인을 자율로 24/7 운영하는 멀티테넌트 서비스" | 운영자 콘솔 데이터 불능 · 상시 루프 미가동 · 도구 대부분 stub · 운영 스택 미배포 | ❌ **본질적 미완** |

**한 줄 요약**: 갭은 *"demonstrable(보여줄 수 있다)"* 와 *"operating(굴러가고 있다)"* 사이에 있다. 챌린지 심사(A)로는 정당하나, 운영 제품(B)으로는 아래 P0 항목이 막고 있다.

---

## 1. 무엇이 진짜 라이브인가 (baseline — 과소·과대 평가 금지)

| 항목 | 증거 | 위치 |
|---|---|---|
| 실 Google 로그인 + ss_session | UI 좌하단 실 sub `116850196617820569972`/sejun@2weeks.co, /campaigns 진입 | rev `ss-v2-web-00004-jw7` (이번 세션) |
| 실 Gmail 연결 + 발송(W7) | `?gmail_connected=` 콜백 → `연결됨`; msg `19e8248d22073209` 메일함 도착 | `gmail_send_reply._live`, D10 allowlist |
| 실 TikTok 소싱 | aviranisha 4.3M 팔로워 실수치 | `rapidapi_get_user_info._live` (backend 프록시) |
| ADK 6단계 루프 7/7 OutcomeOk | source→…→report, Vertex global | `scripts/demo/full_loop_live.py` (일회 스크립트) |
| Cloud Workflow A2A v0.3 | coordinator→A2A→ss-mcp 랭커→5 RankedCreators | exec `a36befd0` SUCCEEDED (수동 트리거) |
| 서명 카드 + 인증 | JWS ES256(KMS `ss-agent-card-prod-v1`), JWKS, 미인증 message:send→401 | ss-mcp `00014-xw8` |

→ **(A) 명제의 "live-capable"은 사실.** 이하 갭은 모두 **(B) 명제** 기준.

---

## 2. 갭 인벤토리

| # | 갭 | 심각도 | 블로커 유형 | 해소 노력 |
|---|---|---|---|---|
| G1 | ~~운영자 콘솔 데이터 불능 (`MONGODB_URI` 미배선)~~ ✅ **해소** (MONGODB_URI 재사용 + `MONGODB_DB=instarsearch`, rev 00008) | ✅ 완료 | — | 완료 |
| G2 | ~~오케스트레이션 루프 상시 미가동~~ ✅ **해소** (자가호스팅 Inngest VM 라이브, 캠페인이 게이트까지 자율 진행 실증) | ✅ 완료 | — | 완료 |
| G3 | ~~운영 스택(TS Inngest 루프) 프로덕션 미배포~~ ✅ **해소** (ss-v2-web + 자가호스팅 엔진 + Vertex 에이전트가 실 instarsearch 데이터로 가동) | ✅ 완료 | — | 완료 |
| G4 | capability 도구 대부분 stub | 🟡 P1 | 자체 + 일부 외부 | 도구별 |
| G5 | 멀티테넌트/인증 미성숙 | 🟡 P1 | 자체 + Google-gated | 중 |
| G6 | 실 캠페인/실데이터 0건 | 🟡 P1 | 자체(운영) | — |
| G7 | 선언 vs 배포 인프라 격차 | 🟢 P2 | 자체 + Google-gated | 대(대부분 불요) |

---

## 3. 갭 상세 (증거 → 영향 → 해소 → 완료 기준)

### G1 — 운영자 콘솔 데이터 불능 ✅ **해소됨 (2026-06-01, rev `ss-v2-web-00008-c65`)**
- **증거(해소 전)**: `/campaigns` 500, digest `2347156499` = `Error: MONGODB_URI is not set`. ss-v2-web env에 `MONGODB_URI` 없음. v2 Mission Control ~20페이지가 `@ss/db`로 직접 read(`packages/db/src/client.ts`).
- **근본 원인 (2단계)**:
  1. `MONGODB_URI` 미배선 → "not set" 500.
  2. 배선 후에도 `MongoServerError: not authorized on social_seeding ... codeName: Unauthorized` (digest `3601104561`). **연결·인증은 성공**(Cloud Run이 자체호스팅 replica set `rs0`에 도달, clusterTime 수신) — 실패는 **DB명**. v1 백엔드의 실제 prod DB는 **`instarsearch`**(`authSource=instarsearch`, `replicaSet=rs0`)이고 Mongo 유저도 거기 스코프. v2 코드 기본값이 당시 `MONGODB_DB=social_seeding`라 **이 클러스터에서 틀렸음**(문서 `.env.example`·CLAUDE.md도 불일치) — **✅ 2026-06-02 PR #57로 코드/문서 기본값 전부 `instarsearch`로 통일해 해소**(§7 참조).
- **해소**: v1 백엔드 `MONGO_URI`(자체호스팅 공유 클러스터)를 secret `mongodb-uri`로 재사용 + 런타임 SA accessor + **`MONGODB_DB=instarsearch`** 배선.
  ```bash
  # MONGO_URI는 v1 백엔드 .env.production에서 읽기전용 추출 → secret(값 미노출)
  gcloud run services update ss-v2-web --project ss-v2-prod --region us-central1 \
    --update-secrets=MONGODB_URI=mongodb-uri:latest \
    --update-env-vars=MONGODB_DB=instarsearch
  ```
- **완료 기준 (충족)**: 인증 후 `/campaigns·/usage·/approvals·/policies·/leads·/settings` **전부 200**, `/api/campaigns`→`{"campaigns":[]}`(임시 test-login으로 실증 후 즉시 비활성). 랜딩 200·로그인 302 유지.
- **참고**: 검증 위해 test-login을 일시 활성화→비활성(rev 00006→00008, POST→404 확인). MONGODB_URI/DB는 영구 배선.
- **✅ 후속 문서수정 완료 (2026-06-02, PR #57)**: 코드/문서 기본값을 전부 `instarsearch`로 통일(`packages/db/src/client.ts`·`.env.example`·CLAUDE.md·dev/init/import/wooriliu 스크립트). 추가로 `run-demo.ts` 안전가드가 `social_seeding`만 막아 실 prod(`instarsearch`) 라이브 실행을 안 막던 잠재 구멍을 수정(두 이름 fail-closed).

### G2 — 오케스트레이션 루프 상시 미가동 🔴 P0
- **증거**: 7/7은 `full_loop_live.py` 일회 스크립트. Cloud Workflow는 수동 `gcloud workflows run`. Inngest는 로컬 전용(`INNGEST_DEV=1`)·미배포. 배포된 건 trimmed `brand-campaign-demo` 워크플로 1개(수동 트리거). Gmail Pub/Sub 웹훅(`/api/webhooks/gmail`) 상시 경로 미가동.
- **영향**: **자율로 캠페인을 운영하는 상시 서비스가 없음.** "온디맨드 시연 가능"이지 "운영 중"이 아님. 답장 대기(`waitForEvent`)·크론 폴러(배송/게시물 탐지)·watch 갱신이 프로덕션에서 돌지 않음.
- **해소**: (a) Inngest 프로덕션 키 배선 + web `/api/inngest` 상시 수신, **또는** (b) D18대로 전체 Cloud Workflows 세트 + Pub/Sub + Cloud Tasks + Eventarc 배포. (a)가 TS 스택과 정합. + Gmail Pub/Sub topic·푸시 구독 배선.
- **완료 기준**: 캠페인 1건을 트리거 없이(이벤트로) source→report까지 자율 진행, 크론 폴러가 배송/게시물 이벤트 실제 emit, 답장 웹훅이 `gmail/reply.received` 실 emit.

### G3 — 운영 스택(TS Inngest 루프) 프로덕션 미배포 🔴 P0
- **증거**: "운영"을 수행할 실제 제품 = TS Inngest 루프가 11 TS 에이전트를 실데이터로 구동(`packages/workflows` + `packages/agents`). 현재 web만 배포(데이터 없음, G1). 배포된 ADK fleet는 챌린지 *시연 surface*(`serve.py`가 22 중 **3만 라우트** — coordinator/sourcing/vetting, 나머지 19는 in-process+CI 테스트).
- **영향**: 배포된 두 스택 중 **어느 쪽도 "실데이터로 캠페인을 운영하는 완전체"가 아님.** TS 루프는 미배포, ADK는 시연용.
- **해소**: TS 스택 운영 배포(web + Inngest + capabilities가 실 Atlas/백엔드/Gmail에 연결) — G1·G2의 상위 작업. 또는 ADK fleet를 22개 전부 라우팅 + Cloud Workflows 전체 세트로 운영화(더 큼).
- **완료 기준**: 운영 스택 1개가 실데이터로 6단계 전부를 상시 수행.

### G4 — capability 도구 대부분 stub 🟡 P1
- **증거**: ADK 도구 ~43개 중 **실 live 3개뿐**: `rapidapi_get_user_info`·`gmail_send_reply`·`a2a_invoke`. 나머지(`imagen/veo/lyria`·`bigquery`·`dlp`·`carrier_create`·`ranking_score._live`·`crm_enrich._live` 등)는 `_live`가 `NotImplementedError("… W7 deploy phase")`. TS 측 carrier(yuntrack)도 미포팅(`YUNTRACK_API_KEY` 설정 시 throw, #29).
- **영향**: 배송(실 캐리어 추적)·크리에이티브 생성·실 분석(BigQuery)·DLP/compliance 실검사가 라이브 아님. 루프는 돌지만 일부 단계가 결정론 fake.
- **해소**: 운영에 실제 필요한 도구만 우선 `CAPABILITY_LAYER_MODE=live` + `_live` 구현(carrier 실연동, ranking/crm 실경로). 나머지는 stub 유지 정당(정직 기재).
- **완료 기준**: 운영 경로상 도구(최소 배송 추적 + ranking) 라이브, HONEST-SCOPE 갱신.

### G5 — 멀티테넌트/인증 미성숙 🟡 P1
- **증거**: 로그인 시 `defaultWorkspaceId()` = env 또는 `ws_demo` 단일(`apps/web/lib/auth.ts`). OAuth 동의화면 "Testing"(test user만, refresh token 7일 만료). gmail.send 민감 스코프 공개 미검증.
- **영향**: 임의 실사용자에게 개방 불가. 한 워크스페이스로 모든 로그인 수렴(테넌트 격리 없음).
- **해소**: (a) 실 user→workspace 매핑(`v2_users`/`workspace_members` 조회). (b) OAuth → "Production" 전환 + **gmail.send 검증 신청**(Google-gated, 수 주). (c) login은 `openid/email`이라 검증 불요 — 이미 가능.
- **완료 기준**: 신규 사용자가 자기 워크스페이스로 로그인, gmail.send 공개 검증 통과(또는 운영자 한정 명시).

### G6 — 실 캠페인/실데이터 0건 🟡 P1
- **증거**: 검증 수치(우리리우 16 posts·59,498 views)는 read-only fixture(`scripts/demo/wooriliu-*`). 라이브 발송은 운영자 소유 테스트 계정(D10 allowlist).
- **영향**: 제3자 크리에이터 대상 실운영 실적 없음.
- **해소**: G1–G5 충족 후 운영자가 실 캠페인 1건 가동(파일럿).
- **완료 기준**: 실 제3자 크리에이터 대상 1건 end-to-end(동의·법률 게이트 통과 하에).

### G7 — 선언 vs 배포 인프라 격차 🟢 P2
- **증거**: `SERVICE-INVENTORY.md` = 95개 GCP 서비스(Spanner/AlloyDB/멀티리전/Agent Runtime) 설계, 실제 라이브 4개. Agent Gateway mTLS 선언만(`agent.json` `mtlsEnforced=false`, O7 Private Preview). Cloud Armor `ss-mcp-ratelimit` 커밋만·미부착.
- **영향**: 아키텍처 문서가 "배포된 것"으로 오독될 위험. mTLS·LB·멀티리전 등 엔터프라이즈 항목 미가동.
- **해소**: 대부분 운영 규모 도달 전 불요. SERVICE-INVENTORY를 "설계 of-record"로 명시(이미 HONEST-SCOPE에 분리). mTLS는 Google O7 Preview 대기.
- **완료 기준**: 문서상 "설계 vs 배포" 라벨 명확(현 상태 충분), 규모 도달 시 점진 배포.

---

## 4. 우선순위 로드맵

| P | 항목 | 차단 해제 | 노력 | 누가 |
|---|---|---|---|---|
| ~~P0-1~~ | ✅ **완료** G1 `MONGODB_URI`+`MONGODB_DB=instarsearch` 배선 (rev 00008-c65, MC 페이지 전수 200) | — | 완료 | Claude |
| **P0-2** | G2 상시 루프 가동 (Inngest prod 또는 Cloud Workflows 세트 + Gmail Pub/Sub) | — | 중 | 자체 |
| **P0-3** | G3 운영 스택 프로덕션 배포 | P0-1·P0-2 | 중~대 | 자체 |
| **P1-1** | G4 운영 도구 라이브(carrier·ranking 등) | — | 도구별 | 자체 |
| **P1-2** | G5 멀티테넌트 매핑 + OAuth Production/gmail.send 검증 | gmail은 Google-gated(수 주) | 중 | 자체+Google |
| **P1-3** | G6 실 캠페인 파일럿 1건 | P0·P1 충족 | — | 운영자 |
| **P2** | G7 엔터프라이즈 인프라 점진 배포 / 문서 라벨 | mTLS Google-gated | 대(대부분 불요) | 자체+Google |

**즉시 1순위 = P0-1.** 가장 작고(1줄) 즉효이며 데모 신뢰성에 직결. 운영자가 v1 Atlas URI 제공 시 Claude가 배선·`/campaigns` 라이브 실증까지 마무리.

---

## 5. "운영 프로덕션"의 정의 (완료 바)

아래 5개가 모두 참일 때 (B) 명제 충족으로 본다:
1. 운영자 콘솔(Mission Control)이 실데이터로 캠페인을 **보고·조작**할 수 있다 (G1).
2. 오케스트레이션이 **이벤트 기반 상시**로 돌며 사람은 정책 게이트에서만 개입한다 (G2·G3).
3. 운영 경로상 도구가 **실 I/O**다(최소 TikTok·Gmail·배송 추적·ranking) (G4).
4. **신규 사용자가 자기 워크스페이스로** 로그인·연결·운영한다 (G5).
5. **실 제3자 캠페인 ≥1건**이 동의·법률 게이트 하에 end-to-end 완료된다 (G6).

현재: **1 부분 충족**(운영자 콘솔이 실 클러스터로 캠페인을 *조회* 가능 — G1 해소, rev 00008; *조작/자율운영*은 G2·G3 대기) · 2·3·4·5 미충족. (A) 제출 명제는 별개로 충족.

---

## 6. 부록 — 증거/파일 포인터

| 항목 | 위치 |
|---|---|
| 세션 DB 클라이언트(`MONGODB_URI` 요구) | `packages/db/src/client.ts` |
| 워크스페이스 매핑 | `apps/web/lib/auth.ts` (`defaultWorkspaceId`) |
| ADK 도구 stub/live seam | `packages/agents-adk/src/ss_agents/tools/*` (`CAPABILITY_LAYER_MODE`) |
| 라이브 루프 스크립트 | `scripts/demo/full_loop_live.py` |
| 정직성 진실원 | `scripts/demo/submission/HONEST-SCOPE.md` |
| 배포 토폴로지 | `gcp-research/decisions/SERVICE-INVENTORY.md` (설계) vs 실 라이브 4개 |
| 배포 절차 | `deploy/{web,agents}/`, `2026-06-01-onboarding-zero-to-reproduce.html` |
| 현재 배포 rev | ss-v2-web `00016-m5l` · ss-agents `00013-smn` · ss-mcp `00015-6v9` (2026-06-02 갱신) |

---

## 7. 2026-06-02 추가 하드닝 (감사 후속, 전부 라이브 실증)

이 갭분석 작성 이후 발견·수정한 항목 (각 PR no-squash merge):

| # | 항목 | 근본원인 → 수정 | 실증 |
|---|---|---|---|
| PR #57 | DB명 정합 + run-demo 가드 | 코드/문서 기본값 `social_seeding`→`instarsearch` 통일. `run-demo.ts` 가드가 `social_seeding`만 막아 실 prod 라이브 실행을 안 막던 잠재 구멍 → 두 이름 fail-closed | verify-build 7/7 · test 113 green |
| PR #58 | A2A 카드 `jku` 죽은 도메인 | 서명 카드 `jku`가 `mcp.socialseed.ing/.well-known/jwks.json`(404, DNS 미컷오버) → 스펙대로 jku 따라가는 검증자가 서명검증 실패. `AGENT_CARD_JWKS_URL`을 실 도달 run.app JWKS로 배선(env+yaml 영속화) | jku 404→200 · `verify_card_with_jwks(card, jwks_from_jku)=True` (rev 00015-6v9) |
| PR #59 | 아웃바운드 메일 HTML 깨짐 | ADK `gmail_send_reply._live()`가 `set_content()`로 HTML을 **text/plain** 단일 파트 발송 → `<br>` 리터럴. `multipart/alternative`(text/plain 폴백+text/html)로 수정 | 회귀 테스트(디코드한 Gmail raw) · ADK 2933 green · 실발송 후 메일 MIME 되읽기 검증 (rev 00013-smn) |
| env | 수신거부 링크 origin | `PUBLIC_APP_URL` 미설정 → 수신거부 링크가 `app.example.com` 폴백으로 깨짐 → `https://agents.socialseed.ing` 배선 | ss-v2-web env 확인 (rev 00016-m5l) |
