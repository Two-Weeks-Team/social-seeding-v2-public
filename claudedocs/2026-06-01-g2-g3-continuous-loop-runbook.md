# G2/G3 — 상시 오케스트레이션 루프 (자가호스팅 Inngest) 운영 Runbook

> 2026-06-01 · 목표 "G2(상시 루프) + G3(운영 스택)을 자율 최대로 완성" 결과 + 운영 절차
> 짝 문서: `2026-06-01-production-gap-analysis.md`(갭 분석) · `2026-06-01-onboarding-master.html`(전체 구조)

---

## 0. 결론 — 무엇이 라이브인가

**상시 오케스트레이션 루프가 GCP에서 라이브로 가동되고, 실 캠페인이 첫 정책 게이트까지 자율 진행됨이 실증됨.** 외부 SaaS(Inngest Cloud) 계정 없이 **자가호스팅 Inngest 엔진**으로 구현(키 자가생성).

라이브 실증 (2026-06-01):
- 캠페인 submit → 엔진이 `campaign/submitted` 픽업 → `brand-campaign` 실행 → **sourcing(Vertex Gemini, 실 instarsearch 데이터에서 실 크리에이터 발견) → vetting(3명 평가) → approveShortlist 게이트 자율 통과 → 3 트랙 영속화 → stage `outreach`로 진행** → creator-track fan-out.
- 트랙 크리에이터 실제: `17866210`(@hanafehri), `MS4wLjABAAA…`, `56155856098041856`.

---

## 1. 아키텍처 (자가호스팅 Inngest)

```
campaign submit (apps/web /api/campaigns, Cloud Run ss-v2-web)
   → inngest.send(campaign/submitted) ──(Direct VPC egress, private)──▶
   Inngest 엔진 VM (ss-inngest, GCP Compute Engine, 10.128.0.2:8288)
        · docker: inngest/inngest `inngest start` (단일 바이너리, 내장 Redis + SQLite)
        · 자가생성 키 (INNGEST_EVENT_KEY/SIGNING_KEY, Secret Manager)
   → 엔진이 함수 실행 위해 ss-v2-web /api/inngest 콜백 (engine→app, public)
        · brand-campaign / creator-track / lead / autopilot / 5 crons
   → 에이전트는 Vertex AI(Gemini 3.5/3.1, global, ADC, 키 불요)로 추론
   → MongoDB(instarsearch, 공유 v1 클러스터)에 v2_* read/write
```

**왜 자가호스팅?** 운영자(소유자)가 "GCP에서 직접(작은 VM/Docker)" 지시. Inngest Cloud는 무료지만 운영자 계정·키 필요 → 자가호스팅으로 **완전 자율**(키도 Claude가 생성). `inngest start`는 외부 Postgres/Redis 불요(내장).

**보안**: 8288은 `default-allow-internal` + `allow-inngest-internal`(10.128.0.0/20)만 허용 — 공개 차단(대시보드가 함수 호출 가능하므로). app→engine은 Cloud Run **Direct VPC egress**(`--vpc-egress=private-ranges-only`)로 사설. 공개 트래픽(Mongo 49.247.x·backend·Vertex)은 직통 유지.

---

## 2. 배포된 자원 (ss-v2-prod)

| 자원 | 값 |
|---|---|
| Inngest 엔진 VM | `ss-inngest` (us-central1-a, e2-small, COS, 내부 10.128.0.2 / 외부 34.133.218.221) |
| firewall | `allow-inngest-internal` (tcp:8288,8289 from 10.128.0.0/20, tag `inngest-engine`) |
| 시크릿 | `inngest-event-key`, `inngest-signing-key`, `gmail-pubsub-token` (+ 기존 web-auth-secret·mongodb-uri·google-oauth-*·backend-dashboard-*) |
| ss-v2-web env | `INNGEST_BASE_URL=http://10.128.0.2:8288`, `INNGEST_DEV=0`, `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=ss-v2-prod`, `GOOGLE_CLOUD_LOCATION=global`, `MONGODB_DB=instarsearch`, `GMAIL_PUBSUB_TOPIC=…/gmail-push` + 위 시크릿들 |
| ss-v2-web VPC | `--network=default --subnet=default --vpc-egress=private-ranges-only` |
| Pub/Sub | topic `gmail-push` (gmail-api-push@system publisher) + push 구독 `gmail-push-sub` → `/api/webhooks/gmail?token=` |
| 런타임 SA 권한 | `roles/aiplatform.user`(Vertex) + secretAccessor(각 시크릿) |
| 최종 web rev | `ss-v2-web-00016-m5l` (PUBLIC_APP_URL 배선, 2026-06-02) |

---

## 3. 이번 목표에서 고친 근본 버그 (PR #46–#50, 전부 no-squash merge)

| PR | 근본 원인 (실측) | 수정 |
|---|---|---|
| #46 | TS model이 GEMINI_API_KEY만 지원 (Cloud Run엔 키 없음, D53은 Vertex global) | model.ts Vertex 모드(ADC) |
| #47 | 배포 스크립트가 `GOOGLE_GENAI_USE_VERTEXAI=TRUE`(대문자)인데 strict `==="true"`면 Vertex 안 켜짐 | case-fold |
| #48 | 에이전트가 tool만 반복 호출 → 최종 출력 턴 못 받고 8-turn limit escalate | 마지막 턴 tool 제거(force-final) |
| #49 | 공유 v1 `accounts_tiktok` 전 174k 행이 `language:null` → `z.optional()`이 null 거부 → 전 크리에이터 safeParse 드롭 → **tiktok.search가 `total:73, creators:[]`** | `language` null 수용 |
| #50 | Gemini 3.x **thinking 토큰이 출력 예산 소진** → `finishReason=MAX_TOKENS, parts=0`(빈 출력) → "not parseable JSON" | `thinkingConfig:{thinkingBudget:0}` |

진단 방법(추정 아님): 로컬에서 sourcing 에이전트를 prod 동일(Vertex+instarsearch)로 실행하며 tool 인자·결과·`finishReason`을 캡처 → 각 근본 원인 확정 후 수정 → 동일 환경 재실행으로 검증.

---

## 4. 운영 절차

### 엔진 상태 확인 / 재시작
```bash
# 컨테이너 상태 (시리얼 콘솔)
gcloud compute instances get-serial-port-output ss-inngest --project ss-v2-prod --zone us-central1-a | grep -i inngest | tail
# 재시작 (COS는 컨테이너 restart-policy=always; VM 재부팅)
gcloud compute instances reset ss-inngest --project ss-v2-prod --zone us-central1-a
```

### 앱↔엔진 재sync (web 새 배포 후 필수)
```bash
curl -X PUT https://agents.socialseed.ing/api/inngest   # → {"message":"Successfully registered"}
```

### 캠페인 라이브 실증
```bash
# (운영자 로그인 세션 or 임시 test-login) → POST /api/campaigns (brief) → 폴링
curl -b <cookie> https://agents.socialseed.ing/api/campaigns   # status/stage/tracks 변화 관찰
```

### web 코드 변경 재배포
```bash
gcloud builds submit --config=deploy/web/cloudbuild.build-only.yaml \
  --substitutions=_PROJECT_ID=ss-v2-prod,_REGION=us-central1,_TAG=web-<sha> --project ss-v2-prod
gcloud run services update ss-v2-web --project ss-v2-prod --region us-central1 \
  --image .../web:web-<sha>   # 기존 env/시크릿/VPC 보존
curl -X PUT https://agents.socialseed.ing/api/inngest   # 재sync
```

---

## 5. 잔여 항목 (다음 단계)

| # | 항목 | 차단 유형 | 비고 |
|---|---|---|---|
| R1 | **Gmail reply 웹훅 처리 코드** | 코드 | `apps/web/.../webhooks/gmail`의 `getGmailClientFactory()`가 throw("googleapis not wired", P2-C2). Pub/Sub 인프라·인증은 준비됨(§2), 실 reply 처리는 googleapis(listHistory/getMessage) 배선 필요. + `users.watch` 등록(gmail-watch-renew 크론, 연결된 사용자 토큰 사용). |
| R2 | **creator-track 아웃리치 실발송** | 데이터+Google-gated | TikTok 크리에이터는 이메일이 없어 트랙이 `no_email`. 실발송은 D10 allow-list(운영자 메일) + gmail.send 검증 필요. 리드(B2B) 루프는 crm_accounts 이메일 보유 → 실발송 경로. |
| R3 | **엔진 HA/영속** | 인프라 | 단일 e2-micro/small VM(SQLite). 데모 OK. 프로덕션 규모 시 외부 Postgres/Redis + 멀티노드 or Inngest Cloud 전환. |
| R4 | **8288 대시보드 접근** | 운영 | 현재 내부 전용(공개 차단). 대시보드 보려면 VM에 IAP 터널 또는 SSH 포트포워드. |
| R5 | **vetting 언어매칭 정확도** | 코드(소) | CodeRabbit PR #49 지적: `accounts_tiktok.textLanguage`를 `creator.language`로 매핑하면 vetting `wrong_language` 판정 정확↑ (현재 language=undefined). |

---

## 6. 목표 END STATE 대비 결과

| END STATE | 상태 |
|---|---|
| 1. /api/inngest 서빙 + 함수 | ✅ 11 함수 등록, `Successfully registered` |
| 2. Gmail Pub/Sub 자율 프로비저닝 | ✅ topic+IAM+구독+token+env (처리 코드는 R1) |
| 3. 상시 루프 경로 확정+배선 | ✅ **자가호스팅 Inngest VM**(Cloud 대신) + sync + 크론 |
| 4. 테스트 캠페인 sourcing→vetting→첫 게이트 | ✅ **실증**: submit→3 트랙→outreach |
| 5. 운영자 runbook | ✅ 본 문서 |

하드법칙 준수: Gemini 3.5/3.1 Vertex global · v1 :8080 무접속(.env는 소유자 승인 하 읽기전용 재사용) · deploy ss-v2-prod만 · 모든 코드변경 PR-merge(no-squash, #46–#50).

---

## 7. 2026-06-02 추가 하드닝 (감사 후속, PR #57–#59, 전부 라이브 실증)

| # | 항목 | 수정 | 실증 |
|---|---|---|---|
| #57 | DB명 정합 + run-demo 가드 구멍 | 기본값 `social_seeding`→`instarsearch` 통일; 가드 두 이름 fail-closed | verify-build 7/7·test 113 |
| #58 | A2A 카드 `jku` 죽은 도메인(404) | `AGENT_CARD_JWKS_URL`을 실 도달 run.app JWKS로 배선(env+yaml) | jku 404→200·`verify_card_with_jwks=True`, ss-mcp rev 00015-6v9 |
| #59 | 아웃바운드 메일 `<br>` 리터럴 | ADK `gmail_send_reply`를 `multipart/alternative`로 (R2 실발송 경로 품질) | 회귀 테스트+실발송 MIME 되읽기, ss-agents rev 00013-smn |
| env | 수신거부 링크 origin | `PUBLIC_APP_URL=https://agents.socialseed.ing` (ss-v2-web rev 00016-m5l) | env 확인 |

> R2(아웃리치 실발송) 관련: 발송 **경로 품질**(HTML 렌더)은 #59로 해소. 발송 **대상**(creator no_email vs B2B 리드)·gmail.send 검증은 R2 원래 범위대로 유지.
