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
 * an <a> to the OAuth start route.
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
    title: "Vertex AI 배포",
    body: "coordinator + 22-에이전트 fleet가 Vertex global 엔드포인트에서 실행됩니다.",
  },
  {
    title: "실데이터 연동",
    body: "실제 TikTok 크리에이터 소싱(4.3M 팔로워 검증)과 실제 Gmail 아웃리치 발송.",
  },
  {
    title: "A2A 멀티에이전트",
    body: "Cloud Workflow가 A2A v0.3 message:send로 에이전트 간 협업을 조율합니다.",
  },
  {
    title: "Gemini 3.x",
    body: "판단은 gemini-3.5-flash, 대량 처리는 gemini-3.1-flash-lite.",
  },
] as const;

export default async function RootPage(): Promise<React.ReactNode> {
  const session = await getServerSession();
  if (session) redirect("/campaigns");

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 bg-slate-50/85 backdrop-blur-sm hairline">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded bg-slate-900 text-white grid place-items-center text-[11px] font-bold">
              SS
            </div>
            <span className="text-[13px] font-semibold">Social Seeding</span>
          </div>
          <GoogleButton href={googleLoginHref()} size="sm" />
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-16 pb-14 sm:pt-24 sm:pb-20">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden /> Live on Google Vertex AI
        </span>

        <h1 className="mt-6 text-[32px] sm:text-[44px] leading-[1.15] font-semibold tracking-tight text-slate-900">
          에이전트가 캠페인을 직접 운영합니다.
          <br />
          브리프만 주면 됩니다.
        </h1>

        <p className="mt-5 max-w-2xl text-[15px] sm:text-[16px] leading-relaxed text-slate-600">
          소싱 · 심사 · 발송 · 답장 · 배송 · 검증 · 리포트 — 22개 ADK 에이전트 fleet가 TikTok 인플루언서
          캠페인 루프를 자율로 실행합니다. 사람은 직접 켜둔 정책 게이트에서만 개입합니다.
        </p>

        <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-3">
          <GoogleButton href={googleLoginHref()} size="lg" />
          <span className="text-[12px] text-slate-500">Google 계정으로 로그인 · 워크스페이스 단위 권한</span>
        </div>
      </section>

      {/* The loop */}
      <section className="border-y border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-10">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">The Loop</div>
          <ol className="mt-4 flex items-center gap-2 overflow-x-auto pb-2 -mx-6 px-6 sm:mx-0 sm:px-0 sm:flex-wrap">
            {LOOP.map((s, i) => (
              <li key={s.en} className="flex items-center gap-2 shrink-0">
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-center min-w-[72px]">
                  <div className="text-[13px] font-medium text-slate-900">{s.ko}</div>
                  <div className="text-[10px] text-slate-400 mono">{s.en}</div>
                </div>
                {i < LOOP.length - 1 ? (
                  <span aria-hidden className="text-slate-300 text-[13px] select-none">
                    →
                  </span>
                ) : (
                  <span aria-hidden className="ml-1 text-slate-300 text-[13px] select-none" title="다시 소싱으로">
                    ↺
                  </span>
                )}
              </li>
            ))}
          </ol>
          <p className="mt-4 text-[12px] text-slate-500">
            사람이 멈추는 지점: 정책 게이트 — 기본값은 <span className="mono">always-ask</span>(항상 확인).
          </p>
        </div>
      </section>

      {/* Credibility */}
      <section className="max-w-5xl mx-auto px-6 py-14">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {CREDS.map((c) => (
            <Card key={c.title}>
              <CardBody className="space-y-1.5">
                <div className="text-[13px] font-semibold text-slate-900">{c.title}</div>
                <div className="text-[12px] leading-relaxed text-slate-600">{c.body}</div>
              </CardBody>
            </Card>
          ))}
        </div>
      </section>

      <footer className="hairline border-t">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between text-[11px] text-slate-500">
          <span>Google for Startups AI Agents Challenge · Track 3</span>
          <span className="mono">agents.socialseed.ing</span>
        </div>
      </footer>
    </main>
  );
}
