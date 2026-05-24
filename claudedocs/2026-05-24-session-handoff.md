# Session Handoff — 2026-05-24 — Submission polish + P0 agent-card fix + ADK ranker LIVE

## §0 두 줄 요약
- 제출 전 정리(2026-05-23~24): 13개 PR(#12–#24) 머지. **ADK 랭커 라이브 전환**(휴리스틱→실 Gemini-3.5-flash on Vertex global), **KIMI(3P) 제거→Gemini-only end-to-end**, **P0 agent-card stub→실 서명 카드 라이브**, 빌드 재현성·CI green·정직 스코프 갱신.
- 코어/배포는 사실상 완료. **남은 건 운영자 몫뿐**: 데모 영상 녹화(시나리오 제공됨) + Devpost Submit. main clean, verify-build green, 라이브 증거 7/7.

## §1 진행한 작업 (PR별, 시간순)
1. **#13** `@ss/web` 빨간 테스트 23→0 + **CI vitest 게이트 신설**(`pnpm test`=`scripts/test-all.ts`, ephemeral mongo + 패키지별 isolated DB).
2. **#14** D53 문서 일관성(ANTHROPIC/Opus/Haiku→Gemini, docs 전반).
3. **#15** 데모 a11y 84→96 / SEO→100 / agentic→100 + ss-landing 재배포(rev 00006-rr2).
4. **#16/#19** claudedocs 보존(스코어카드·핸드오프·데모 시나리오·스크린샷).
5. **#17** **decision-panel 10-전문가 3자 심사**(avg ~83/100) + 그 +1(HONEST-SCOPE 47-tool stub/live seam 공개, run-demo Atlas 가드).
6. **#18** dead-code 제거 + 22(ADK)/11(TS) 에이전트 수 명확화.
7. **#20** **KIMI/Moonshot → gemini-3.5-flash**(crm.enrich) → 제품 Gemini-only end-to-end.
8. **#21/#22/#23** **ADK 랭커 LIVE**: Model Armor 위치 디커플(MODEL_ARMOR_LOCATION) → 재현 빌드(assemble-build-context.sh + cloudbuild.build-only.yaml) → `await`-less create_session 버그 fix. no-traffic 카나리로 2개 이슈를 라이브 트래픽 이동 전에 잡음.
9. **#24** **P0 agent-card**: stub→실 서명 카드(경로 resolver + Secret 서명키 AGENT_CARD_SIGNING_KEY_PEM), url 404 도메인→run.app/v1, 정직 스코프(row5 demonstrated-live, minScale=1), **verify-live-evidence.sh**(7/7) + 캡처 증거 + 스크린샷.

## §2 현재 상태
- **Git**: main @ `3d9c380` (PR #24 머지), working tree clean, open PR 0. CI: pre-merge 4-check green(verify·pytest-agents·unit-tests·CodeRabbit). (이전 main red는 actions/checkout auth transient — rerun으로 해소.)
- **게이트**: `pnpm run verify-build` green; `pnpm test` 421 TS; agents-adk pytest 2924.
- **라이브 (ss-mcp-prod, rev `ss-mcp-server-00010-j26`, minScale=1)**:
  - 서명 agent card: `signatures:1`(ES256) + `/.well-known/jwks.json`(kid `ss-agent-card-prod`) + securitySchemes[oidc/oauth/mutualTLS] + url=run.app/v1.
  - REQUIRE_AUTH(무토큰 401), Model Armor live(jailbreak 차단), **실 ADK 랭킹**(gemini-3.5-flash on Vertex global; engagement>0, 의미적 fit_score+reasoning).
  - 롤백: `ss-mcp-server-00006-gg2`(휴리스틱) / `00008-ndg`(ADK pre-card-fix).
- **라이브 데모**: ss-landing /demo/ 200, Lighthouse a11y 96/SEO 100/BP 100/agentic 100.
- **정직 스코프**: HONEST-SCOPE 17행 — **7 demonstrated-live**, 6 GA-real, 1 operator-deploy, 1 Google-gated, 2 split.
- **재현 증거**: `bash scripts/demo/submission/verify-live-evidence.sh` → 7/7.

## §3 다음 세션에서 할 수 있는 것
- (운영자) 데모 영상 녹화 — 시나리오 `claudedocs/2026-05-23-demo-video-scenario.md`.
- (운영자) **Devpost Submit** (D-2026-06-05).
- (선택, 배포) GE 데모 엔드포인트 Cloud Run IAM 게이팅(Security Auditor 권고; 현재 무인증, 공개 데이터).
- (선택, 배포) card 서명키 dev→Cloud KMS + rotation.
- 라이브 재배포 시: `assemble-build-context.sh` → `cloudbuild.build-only.yaml` 빌드 → no-traffic 카나리 검증(verify-live-evidence.sh) → 트래픽 컷. repo yaml은 이미 ADK-on + 서명키 env 반영.

## §4 할 수 없는 것 (외부/운영자)
- GE 어시스턴트→커스텀 에이전트 호출(streamAssist 게이트, Cloud Support 케이스) — 등록·엔드포인트는 동작.
- `gemini-*-pro` 404(Preview allowlist), Agent Gateway mTLS(Private Preview).
- engagement_rate가 0으로 보일 수 있음 = 백엔드 Group-B 일일 쿼터 소진(하드닝 무관, HONEST-SCOPE row5에 공개).

## §5 다음 세션 시작 프롬프트
```text
/handon
이전 핸드오프: claudedocs/2026-05-24-session-handoff.md
제출 코드/배포는 완료. 라이브 증거 재확인: bash scripts/demo/submission/verify-live-evidence.sh (7/7 기대).
남은 건 운영자 몫(데모 영상·Devpost Submit) + 선택 배포(GE IAM, KMS). D-day 2026-06-05.
```

## §6 핵심 자산 위치
| 자산 | 경로 |
|---|---|
| 라이브 증거 재현 스크립트 | `scripts/demo/submission/verify-live-evidence.sh` (+ 캡처 `scripts/demo/assets/live-evidence-2026-05-24.txt`) |
| 정직 스코프 | `scripts/demo/submission/HONEST-SCOPE.md` (17행, 7 demonstrated-live) |
| 4-lens 스코어카드 + 패널 | `claudedocs/2026-05-22-SUBMISSION-SCORECARD.md` |
| 데모 영상 시나리오 | `claudedocs/2026-05-23-demo-video-scenario.md` |
| ss-mcp 서버 코드 | `gcp-research/refactor-mcp/code/agent/src/tiktok_orchestrator/{main,agent,model_armor,card_signer}.py` |
| 배포 yaml(ADK-on, 서명키, MA 디커플) | `gcp-research/refactor-mcp/code/deployment/cloud-run-service.yaml` |
| 재현 빌드 | `…/deployment/assemble-build-context.sh` + `cloudbuild.build-only.yaml` |
| 테스트 러너 | `scripts/test-all.ts` (`pnpm test`) |
| 30+ 플랫폼 갭표 | `gcp-research/GEMINI-ENTERPRISE-PLATFORM-MAP.md` |
| 이전 핸드오프 | `claudedocs/2026-05-23-submission-polish-handoff.md` |

## §7 알려진 issue / 노트
- ss-mcp-server `minScale=1`(서명키 안정성 + A2A 콜드스타트 회피). 비용 약간↑(여전히 ~$1–5/mo대).
- agent card 서명키는 dev P-256(Secret Manager). 인스턴스 간 안정. prod는 KMS 권고.
- 빌드는 cross-repo Node 소스(`social-seeding-platform/microservices/tiktok-mcp-server`)에 의존 — `MCP_NODE_SRC`로 override, `assemble-build-context.sh`가 결정론적 조립.
- bash factory-policy 훅: `eval` 토큰·`$(...)`·glob·다중 인용공백경로 주의(파일은 무관, 명령만).
