# Session Handoff — 2026-05-23 — Pre-submission polish

## §0 두 줄 요약
- 제출 전 최종 정리 goal (Track 3, D-2026-06-05): 4-lens 심사 스코어카드 작성 + 갭을 페이즈 PR로 해소. **PR #12 머지(하드닝 라이브) → #13(빨간 테스트 23개 수정 + vitest CI 게이트) → #14(D53 문서 일관성) → #15(데모 a11y 84→96)** 전부 main 병합·CI green.
- 스코어카드: `claudedocs/2026-05-22-SUBMISSION-SCORECARD.md` (4 lens 점수 + gap register + Row 1-5). 잔여는 전부 operator-decision / low-severity로 명시.

## §1 진행한 작업 (시간순, PR별)
1. **PR #12 (merged d575c8e)** — ss-mcp-server 엔터프라이즈 하드닝(D53·S2S auth·Model Armor live·structured MCP). 코드는 이미 라이브였고 merge로 main 최신화.
2. **PR #13 (merged)** — `@ss/web` AP2 컴포넌트 테스트 **23 red → 0**: ① esbuild JSX automatic(React-not-defined ×22) ② RTL `afterEach(cleanup)`(globals:false) ③ currency aria-label ICU 비포터블 수정 ④ WebAuthn 테스트에 capable-env stub + 다이얼로그 트리거 클릭 ⑤ PARTNER_COUNT≥60(실제 58) → 실제 floor+unique-id 불변식. **+ CI `unit-tests` 잡 신설**(`pnpm test` = `scripts/test-all.ts`: 자체 ephemeral mongo + 패키지별 isolated `MONGODB_DB`, async spawn). 이전엔 vitest가 CI에서 아예 안 돌아서 reds가 게이트를 빠져나갔음.
3. **PR #14 (merged)** — D53 문서 일관성: `ANTHROPIC_API_KEY`→`GEMINI_API_KEY`, Opus/Haiku→gemini-3.5-flash/3.1-flash-lite (README·CLAUDE.md·STATUS·AGENTS·ARCHITECTURE·.env.example), dead `OPENAI_API_KEY` 제거, pytest 2925→2924, sgwannabe 경로 일반화. **코드는 이미 Gemini(`@google/genai`, model.ts) — 문서만 stale였음.**
4. **PR #15 (merged)** — 데모 a11y/SEO: `<main>` 랜드마크 + select/checkbox 라벨 + label/name match + meta-description → **로컬 Lighthouse a11y 84→96, SEO 90→100, agentic 50→100, BP 100**.

## §2 현재 상태
- **Git**: main이 #12~#15 모두 포함. open PR 없음.
- **테스트 게이트**: `pnpm test` = **421 TS** (web 67 + agents 64 + capabilities 183 + observability 4 + workflows 103) + agents-adk pytest **2924**. `pnpm run verify-build` green. CI(verify·pytest-agents·unit-tests·CodeRabbit) green.
- **라이브**: ss-mcp-server 인증 강제(무토큰 401), ss-landing 데모 200. ss-landing 재배포로 a11y-96 버전 라이브화 (롤백 `ss-landing-00005-65q`).
- **E2E**: `run-demo.ts --dry-run` 프리플라이트는 GEMINI_API_KEY+MONGODB_URI 요구(=D53 정합) 확인. 풀 라이브 run은 operator `.env.local` 필요. 라이브 A2A 경로는 독립 검증됨(401/200/문서 exec 9cc843c1).

## §3 4-Lens 심사 스코어카드 (최종)
| Lens | 점수 | 핵심 |
|---|---|---|
| i 기술/아키텍처/관측 | 93 | CI vitest 게이트+DB isolation 확보. 잔여 GAP-X1(dead code) |
| ii 디자인/UX 비주얼와우 | 95 | 데모 Lighthouse a11y96/SEO100/agentic100/BP100 |
| iii 제품/스토리 | 95 | D53 문서 일관성 확보, README judge-grade |
| iv 적대적 스켑틱 | 91 | 23 red 테스트 수정+CI게이트, partner-count 정정 |

## §4 할 수 없는 것 / operator-decision (flagged)
- **ss-landing 재배포 = 완료** — rev `ss-landing-00006-rr2` 라이브, **라이브 Lighthouse 재측정 a11y 96 / SEO 100 / agentic 100 / BP 100** 확인. 롤백 `ss-landing-00005-65q`.
- **Row 2 풀 라이브 run-demo** — `.env.local`(MONGODB_URI+GEMINI_API_KEY+OAuth) 필요. operator.
- **GAP-K1** — `KIMI_API_KEY`(3P, crm.enrich 전용)가 "Gemini-only" 순수주의에 걸리는지 판단. (D53 명시 금지목록엔 없음.)
- **GAP-X1** — `creator.repo.ts:36` dead `not implemented` throw 제거(zero callers).
- **SMOKE-TEST-P3/P4/P5.md** ANTHROPIC 잔존(historical runbook); **DEVPOST.md**의 "built on Claude → lifted to Gemini" 서사는 의도적(operator 전략 카피, 미수정).
- Devpost Submit·데모 영상·GE Cloud Support 케이스 — operator only.

## §5 다음 세션 시작 프롬프트
```text
/handon
이전 핸드오프: claudedocs/2026-05-23-submission-polish-handoff.md
제출 전 최종 정리는 4 PR(#12-#15)로 일단락. 다음 후보:
(a) ss-landing 재배포 검증(라이브 a11y 재측정), (b) GAP-X1 dead-code 제거,
(c) KIMI D53 판단(GAP-K1), (d) Row 2 풀 라이브 run-demo(.env.local 필요),
(e) decision-panel 스킬로 더 깊은 멀티-전문가 심사 1회.
스코어카드: claudedocs/2026-05-22-SUBMISSION-SCORECARD.md. D-day 2026-06-05.
```

## §6 핵심 자산 위치
| 자산 | 경로 |
|---|---|
| 스코어카드 (4-lens + gap register + changelog) | `claudedocs/2026-05-22-SUBMISSION-SCORECARD.md` |
| 데모 스크린샷 | `claudedocs/2026-05-22-ss-landing-demo.jpeg` |
| 자체완결 테스트 러너 | `scripts/test-all.ts` (`pnpm test`) |
| CI | `.github/workflows/ci.yml` (verify·pytest-agents·**unit-tests**) |
| 30+ 에이전트 서비스 갭표 | `gcp-research/GEMINI-ENTERPRISE-PLATFORM-MAP.md` (32 컴포넌트) |
| 정직 스코프 | `scripts/demo/submission/HONEST-SCOPE.md` (17행) |
