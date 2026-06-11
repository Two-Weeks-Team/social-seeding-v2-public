# 운영자 제출 가이드 — 1장 요약 (Devpost Track 3)

> 이 문서는 `CHECKLIST.md`(전체 런북)의 **1페이지 압축본**입니다. 충돌 시 `CHECKLIST.md` → `DECISIONS.md` 순으로 우선.
> **마감: 2026-06-11 17:00 PT (= 2026-06-12 09:00 KST)** — 6/5에서 연장됨(Devpost 공식 메일 2026-06-02). **마감 6시간 전까지 제출**.

---

## 0. 지금 상태 (2026-06-04 실측)

| 구분 | 상태 |
|---|---|
| Devpost 계정·팀 등록 | ✅ 완료 (D6) |
| 폼 본문 `devpost-track3.md` | ✅ 완성 (태그라인 193자, D-ID 전부 유효, 미정은 `<YOUTUBE_URL>` 1곳뿐) |
| 라이브 URL 4종 | ✅ 전부 200 / A2A `0.3.0` |
| 루트 LICENSE + NOTICE | ✅ 생성됨 (BUSL-1.1 코어 + Apache-2.0 ancillary, D9) — **commit+push 필요** |
| pytest | ✅ 2933 passed |
| 10★ 스크린샷 | ⏳ `screenshots/` 조립 — capture-guide 참조 |
| YouTube 데모 영상 | ⏳ 운영자 업로드 |
| repo 가시성 | ⚠️ **PRIVATE** — 아래 §1 결정 필요 |

---

## 1. 운영자만 할 수 있는 것 (웹/불가역) — 제출 전 처리

1. **repo 가시성 결정 (G-8 / O1)**: repo가 현재 **PRIVATE**. 심사자가 코드를 보려면
   - (A) **Public 전환** — 가장 단순, 권장. 또는
   - (B) Devpost 콘솔의 repo-visibility 정책이 "judge-granted private"면 심사자 계정에 접근 부여.
   - → Devpost 콘솔에서 정책 확인 후 택1. **PRIVATE인 채 제출하면 "Try it out" repo 링크가 심사자에게 404.**
2. **LICENSE commit+push**: 이번에 추가한 루트 `LICENSE`/`NOTICE`를 push해야 GitHub이 BUSL-1.1로 인식.
3. **YouTube 영상 업로드** (G-7): "Unlisted, Processing complete" 확인 후 URL 확보 → 폼 `<YOUTUBE_URL>` 교체.

## 1b. Devpost 콘솔 10개 GAP (O1) — 확인/응답

공식 Rules PDF로 이미 해소된 것 (그대로 답):
- 복수 제출 가능하나 각 "unique & substantially different" · **프로젝트당 상금 1개** · **한국 적격(북한만 제외), KR=APAC** · 상금 Grand $15K+$10K 외.

콘솔에서 직접 확인할 잔여 항목:
- 최대 팀 규모(병렬 대회 통상 4명) · 영상 길이 cap(통상 ≤3분) · 라이선스 요구(우리=BUSL-1.1+Apache, D9) · repo 가시성 정책(§1-1) · multi-track 규칙 · IP 양도 조항(영상 홍보용 라이선스 통상 부여).

---

## 2. 폼 작성 — 단일 Track 3 (Refactor) 폼

`devpost-track3.md`의 각 섹션을 **복사-붙여넣기**(재입력 금지, D-ID 인용 보존):

| Devpost 필드 | `devpost-track3.md` 섹션 |
|---|---|
| Project name | "Project name" 줄 |
| Tagline (≤200자) | "One-line tagline" (현재 193자) |
| Inspiration | "Inspiration" |
| What it does | "What it does" + "What we hardened" |
| How we built it | "How we built it" (+ 6-요건 게이트 표, Build Example #2 매칭) |
| Challenges | "Challenges we ran into" |
| Accomplishments | "Accomplishments we're proud of" |
| What we learned | "What we learned" |
| What's next | "What's next" |
| Built With | `built-with-tags.txt` (verbatim) |
| Business case | "Business case" |
| Honest scope | "Honest scope" (절대 누락 금지 — 정직성 = Innovation 기여) |

## 3. 이미지 업로드 — 10★ (업로드 순서 = 갤러리 순서)

`SCREENSHOTS-CAPTURE-GUIDE.md` 참조. hero = hardening before/after 바(train 100% / holdout 71.4%).
순서: ①hardening-before-after ②observability-stall-repair ③live-a2a-crosscall-in-workflow ④live-agent-json-200 ⑤req-gate-table ⑥build-example-2-match ⑦mission-control-fleet ⑧real-imagen-generation ⑨wow-business-roi-tam ⑩pytest-2933-passing

## 4. Try it out 링크 (순서대로)

1. `https://ss-mcp-server-1049119860518.us-central1.run.app` (A2A — `/.well-known/agent.json`)
2. `https://ss-v2-web-722660901814.us-central1.run.app` (Mission Control) — 또는 `https://agents.socialseed.ing`
3. `https://ss-landing-80064221403.us-central1.run.app/demo/` (데모/리포트)
4. `https://github.com/Two-Weeks-Team/social-seeding-v2-public` (repo — §1-1 가시성 처리 후)

## 5. Submit 전 최종 점검

- [ ] `<YOUTUBE_URL>` 플레이스홀더 없음
- [ ] Tagline ≤200자
- [ ] Build→Optimize→Refactor arc가 하나의 스토리로 읽힘 (Grand Prize 조준, D50)
- [ ] 40.5%→100% train / **71.4% holdout(28.6pp gap)** + honest-scope 캡션 존재, holdout 4 miss 노출(숨기지 않음)
- [ ] A2A 수치 = **~3.7s, 5 creators**, "in the Cloud Workflow"로 기술
- [ ] 라이브 URL 3종 정확·200 · 6-요건 게이트 표 렌더 정상
- [ ] Imagen 명확화(독립 `gen_sample_image.py` 산출, in-fleet creative agent는 W7-staged) 존재
- [ ] "Prompt Optimizer (data-driven)" 표기(≠ "Agent Optimizer")
- [ ] D-ID 3개 무작위 스팟체크 → `DECISIONS.md`에 실존

## 6. Submit & 직후

- [ ] **Submit** 클릭 (confetti 확인)
- [ ] confirmation URL을 `CONFIRMATION.txt`에 저장 + 확인 페이지 스크린샷
- [ ] repo 태그: `git tag -a v1.0.0-devpost-submission -m "Frozen at Devpost submission 2026-06-XX"`
- [ ] 제출 재오픈 → 마크다운 렌더·링크·영상 플레이어·repo README 정상 확인
- [ ] 판정 기간 Cloud Run 3종 warm 유지(min=0)

---
*전체 절차/롤백/사후 추적은 `CHECKLIST.md` §10–§12 참조.*
