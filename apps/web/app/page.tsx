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
  { ko: "Source", en: "source" },
  { ko: "Vet", en: "vet" },
  { ko: "Outreach", en: "outreach" },
  { ko: "Reply", en: "reply" },
  { ko: "Ship", en: "ship" },
  { ko: "Verify", en: "verify" },
  { ko: "Report", en: "report" },
] as const;

const CREDS = [
  {
    title: "Cloud deployment",
    body: "The coordinator and 22-agent fleet run on Google Cloud.",
  },
  {
    title: "Live-data integrations",
    body: "Validated with real TikTok creator sourcing and real email outreach.",
  },
  {
    title: "Multi-agent coordination",
    body: "The workflow coordinates agent-to-agent messages through the full campaign loop.",
  },
  {
    title: "Gemini-backed judgment",
    body: "High-value judgment runs on stronger models; high-volume work runs on lighter models.",
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
          <span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden /> Running on Google Cloud
        </span>

        <h1 className="mt-6 text-[32px] sm:text-[46px] leading-[1.14] font-bold tracking-[-0.02em] text-ink">
          Agents run the campaign loop.
          <br />
          <span className="text-brand-ink">You only provide the brief.</span>
        </h1>

        <p className="mt-5 max-w-2xl text-[15px] sm:text-[16px] leading-relaxed text-ink-2">
          Sourcing, vetting, outreach, replies, shipping, verification, and reporting are handled by a
          22-agent fleet for TikTok influencer campaigns. People step in only at policy gates they enable.
        </p>

        <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-3">
          <GoogleButton href={googleLoginHref()} size="lg" />
          <span className="text-[12px] text-ink-3">Sign in with Google · Workspace-scoped access</span>
        </div>
      </section>

      {/* The loop */}
      <section className="border-y border-line bg-surface">
        <div className="max-w-5xl mx-auto px-6 py-10">
          <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold">Operating loop</div>
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
                  <span aria-hidden className="ml-1 text-brand-ink/50 text-[13px] select-none" title="Back to sourcing">
                    ↺
                  </span>
                )}
              </li>
            ))}
          </ol>
          <p className="mt-4 text-[12px] text-ink-2">
            Human checkpoints: policy gates. The default is{" "}
            <span className="font-semibold text-ink">always review</span>.
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
