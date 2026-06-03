import { redirect } from "next/navigation";

import { Card, CardBody } from "@/components/ui/card";
import { GoogleButton } from "@/components/ui/google-button";
import { googleLoginHref } from "@/lib/auth-links";
import { getServerSession } from "@/lib/auth";

/**
 * Landing — the unauthenticated first impression for agents.socialseed.ing.
 * Authenticated visitors bounce straight to /campaigns; everyone else sees the
 * product story (the agent-operated campaign loop) with a real Google sign-in
 * CTA. Server component, no client JS — the loop visual is CSS/SVG, the CTA is
 * an <a> to the OAuth start route. C2 "Champagne & Espresso" surface.
 */

const LOOP = [
  { ko: "소싱", en: "source" },
  { ko: "심사", en: "vet" },
  { ko: "발송", en: "outreach" },
  { ko: "답장", en: "reply" },
  { ko: "배송", en: "ship" },
  { ko: "검증", en: "verify" },
  { ko: "리포트", en: "report" },
] as const;

const CREDS = [
  {
    title: "클라우드 배포",
    body: "코디네이터와 22개 에이전트 fleet가 Google Cloud에서 실제로 실행됩니다.",
  },
  {
    title: "실데이터 연동",
    body: "실제 TikTok 크리에이터 소싱과 실제 이메일 아웃리치 발송으로 검증됩니다.",
  },
  {
    title: "멀티에이전트 협업",
    body: "워크플로가 에이전트 간 메시지를 조율해 캠페인 루프를 함께 굴립니다.",
  },
  {
    title: "Gemini 기반 판단",
    body: "판단과 조율은 고성능 모델, 대량 처리는 경량 모델로 분리해 운영합니다.",
  },
] as const;

export default async function RootPage(): Promise<React.ReactNode> {
  const session = await getServerSession();
  if (session) redirect("/campaigns");

  return (
    <main className="min-h-screen bg-canvas text-ink">
      <header className="sticky top-0 z-10 bg-canvas/85 backdrop-blur-sm hairline">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-xl bg-brand text-white grid place-items-center text-[11px] font-bold shadow-brand">
              SS
            </div>
            <span className="text-[13px] font-semibold tracking-[-0.01em]">Social Seeding</span>
          </div>
          <GoogleButton href={googleLoginHref()} size="sm" />
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-16 pb-14 sm:pt-24 sm:pb-20">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-bg px-2.5 py-1 text-[11px] font-semibold text-ok">
          <span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden /> Google Cloud에서 운영 중
        </span>

        <h1 className="mt-6 text-[32px] sm:text-[46px] leading-[1.14] font-bold tracking-[-0.02em] text-ink">
          에이전트가 캠페인을 직접 운영합니다.
          <br />
          <span className="text-brand-ink">브리프만 주면 됩니다.</span>
        </h1>

        <p className="mt-5 max-w-2xl text-[15px] sm:text-[16px] leading-relaxed text-ink-2">
          소싱 · 심사 · 발송 · 답장 · 배송 · 검증 · 리포트 — 22개 에이전트 fleet가 TikTok 인플루언서
          캠페인 루프를 자율로 실행합니다. 사람은 직접 켜둔 정책 게이트에서만 개입합니다.
        </p>

        <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-3">
          <GoogleButton href={googleLoginHref()} size="lg" />
          <span className="text-[12px] text-ink-3">Google 계정으로 로그인 · 워크스페이스 단위 권한</span>
        </div>
      </section>

      {/* The loop */}
      <section className="border-y border-line bg-surface">
        <div className="max-w-5xl mx-auto px-6 py-10">
          <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold">운영 루프</div>
          <ol className="mt-4 flex items-center gap-2 overflow-x-auto pb-2 -mx-6 px-6 sm:mx-0 sm:px-0 sm:flex-wrap">
            {LOOP.map((s, i) => (
              <li key={s.en} className="flex items-center gap-2 shrink-0">
                <div className="rounded-2xl border border-line bg-canvas px-3 py-2 text-center min-w-[72px]">
                  <div className="text-[13px] font-semibold text-ink">{s.ko}</div>
                  <div className="text-[10px] text-ink-3 mono">{s.en}</div>
                </div>
                {i < LOOP.length - 1 ? (
                  <span aria-hidden className="text-brand-ink/50 text-[13px] select-none">
                    →
                  </span>
                ) : (
                  <span aria-hidden className="ml-1 text-brand-ink/50 text-[13px] select-none" title="다시 소싱으로">
                    ↺
                  </span>
                )}
              </li>
            ))}
          </ol>
          <p className="mt-4 text-[12px] text-ink-2">
            사람이 멈추는 지점: 정책 게이트 — 기본값은{" "}
            <span className="font-semibold text-ink">항상 확인</span>입니다.
          </p>
        </div>
      </section>

      {/* Credibility */}
      <section className="max-w-5xl mx-auto px-6 py-14">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {CREDS.map((c) => (
            <Card key={c.title}>
              <CardBody className="space-y-1.5">
                <div className="text-[13px] font-bold text-ink">{c.title}</div>
                <div className="text-[12px] leading-relaxed text-ink-2">{c.body}</div>
              </CardBody>
            </Card>
          ))}
        </div>
      </section>

      <footer className="hairline border-t border-line">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between text-[11px] text-ink-3">
          <span>Google for Startups AI Agents Challenge · Track 3</span>
          <span className="mono">agents.socialseed.ing</span>
        </div>
      </footer>
    </main>
  );
}
