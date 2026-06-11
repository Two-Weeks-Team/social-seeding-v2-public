import { redirect } from "next/navigation";

import { GoogleButton } from "@/components/ui/google-button";
import { googleLoginHref } from "@/lib/auth-links";
import { getServerSession } from "@/lib/auth";

/**
 * Landing — the unauthenticated first impression for agents.socialseed.ing.
 * Authenticated visitors bounce straight to /campaigns; everyone else gets the
 * product story (see it run → the loop → the Gemini Enterprise platform we run
 * live → real results) with a Google sign-in CTA and a no-account judge entry.
 * Server component, no client JS. C2 "Champagne & Espresso" surface.
 */

const LOOP = [
  { step: "Source", does: "find creators" },
  { step: "Vet", does: "score fit" },
  { step: "Outreach", does: "draft + gate" },
  { step: "Reply", does: "triage" },
  { step: "Ship", does: "send assets" },
  { step: "Verify", does: "confirm posts" },
  { step: "Report", does: "ROI roll-up" },
] as const;

// What we actually run, mapped to the Gemini Enterprise Agent Platform.
const RUNTIME = [
  {
    title: "ss-agents — 22-agent ADK fleet",
    body: "Cloud Run + managed Agent Runtime (reasoningEngine). 16 domain · 3 meta · 3 watchdog.",
    tag: "LIVE",
  },
  {
    title: "ss-mcp-server — A2A v0.3 node",
    body: "OSS tiktok-mcp-server. Signed agent card (ES256), Cloud KMS, JWKS — discoverable & callable.",
    tag: "LIVE",
  },
  {
    title: "brand-campaign — Cloud Workflow",
    body: "Durable orchestration. Proven live: execution 7c08ce50, coordinator → fleet → A2A hop.",
    tag: "deployed",
  },
  {
    title: "Gemini 3.5 / 3.1 — Vertex global",
    body: "Judgment on 3.5-flash, bulk on 3.1-flash-lite. Routed through Model Garden. Gemini only.",
    tag: null,
  },
  {
    title: "Model Armor · Cloud Trace",
    body: "Inbound A2A sanitized through Model Armor; agent spans wired into Cloud Trace.",
    tag: null,
  },
  {
    title: "Agent Identity · KMS",
    body: "SPIFFE identity per agent; the production card-signing key held in Cloud KMS.",
    tag: null,
  },
] as const;

const STATS = [
  { n: "16", l: "verified posts" },
  { n: "59,498", l: "views" },
  { n: "7.9%", l: "engagement" },
] as const;

const VIDEO_URL = "https://youtu.be/4SDvNK4cwZs";
const PLATFORM_MAP_URL = "https://storage.googleapis.com/ss-social-seeding-v2-docs/agent-platform-map.html";
const REPO_URL = "https://github.com/Two-Weeks-Team/social-seeding-v2";
const AGENT_CARD_URL = "https://ss-mcp-server-1049119860518.us-central1.run.app/.well-known/agent.json";

/** Inline key glyph for the judge CTA (avoids cross-OS emoji rendering). */
function KeyIcon(): React.ReactNode {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className="shrink-0"
    >
      <circle cx="8" cy="15" r="4" />
      <path d="M10.85 12.15 21 2" />
      <path d="m18 5 3 3" />
      <path d="m15.5 7.5 2.5 2.5" />
    </svg>
  );
}

/** Inline play triangle (replaces the ▶ emoji on demo / map affordances). */
function PlayIcon(): React.ReactNode {
  return (
    <svg
      width="10"
      height="11"
      viewBox="0 0 10 11"
      fill="currentColor"
      aria-hidden
      focusable="false"
      className="shrink-0"
    >
      <path d="M0 .5 10 5.5 0 10.5Z" />
    </svg>
  );
}

export default async function RootPage(): Promise<React.ReactNode> {
  const session = await getServerSession();
  if (session) redirect("/campaigns");

  return (
    <main className="min-h-screen bg-canvas text-ink">
      <header className="sticky top-0 z-10 bg-canvas/95 backdrop-blur-sm hairline">
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
      <section className="max-w-5xl mx-auto px-6 pt-16 pb-12 sm:pt-20 sm:pb-16">
        <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
          {/* Left — the pitch */}
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-bg px-2.5 py-1 text-[11px] font-semibold text-ok">
              <span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden /> Running live on Google Cloud · Track 3
            </span>

            <h1 className="mt-6 text-[32px] sm:text-[46px] leading-[1.14] font-bold tracking-[-0.02em] text-ink">
              Agents run the campaign loop.
              <br />
              <span className="text-brand-ink">You only provide the brief.</span>
            </h1>

            <p className="mt-5 max-w-xl text-[15px] sm:text-[16px] leading-relaxed text-ink-2">
              Sourcing, vetting, outreach, replies, shipping, verification, and reporting are handled by a
              22-agent fleet for TikTok influencer campaigns. People step in only at the policy gates they enable.
            </p>

            <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-3">
              <a
                href="/sign-in"
                className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-brand px-5 text-[14px] font-semibold text-white shadow-brand hover:bg-brand-2 transition-colors"
              >
                <KeyIcon /> Enter as judge — read-only demo
              </a>
              <GoogleButton href={googleLoginHref()} size="lg" className="whitespace-nowrap" />
            </div>
            <p className="mt-2.5 text-[12px] text-ink-2">
              Judge entry needs no account. Google sign-in is workspace-scoped.
            </p>
          </div>

          {/* Right — the live agent card is real and verifiable */}
          <div className="rounded-2xl bg-ink p-5 shadow-brand ring-1 ring-black/5 sm:p-6">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">
                A2A · live agent card
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
                <span className="relative flex h-1.5 w-1.5" aria-hidden>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </span>
                live
              </span>
            </div>

            <div className="mt-4 space-y-1.5 mono text-[12px] leading-relaxed">
              <div className="text-stone-500">$ curl …/.well-known/agent.json</div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-stone-400">HTTP</span>
                <span className="text-emerald-400">200 OK</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-stone-400">protocolVersion</span>
                <span className="text-stone-100">0.3.0</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-stone-400">signature</span>
                <span className="text-stone-100">ES256 · P-256</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-stone-400">key custody</span>
                <span className="text-amber-300">Cloud KMS</span>
              </div>
            </div>

            <div className="my-4 border-t border-white/10" />

            <div className="space-y-1.5 mono text-[12px] leading-relaxed">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-stone-400">POST /v1/message:send</span>
                <span className="text-amber-300">401</span>
              </div>
              <div className="text-stone-500">no token · the gate holds</div>
            </div>

            <a
              href={AGENT_CARD_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-5 inline-flex items-center gap-1.5 text-[12px] font-medium text-stone-300 hover:text-white transition-colors"
            >
              Verify it yourself
              <span aria-hidden>↗</span>
            </a>
          </div>
        </div>
      </section>

      {/* See it run */}
      <section className="border-y border-line bg-surface">
        <div className="max-w-5xl mx-auto px-6 py-12">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.06em] text-ink-2 font-semibold">See it run</div>
              <h2 className="mt-1.5 text-[20px] sm:text-[24px] font-bold tracking-[-0.01em] text-ink">
                Mission Control — the fleet runs, you keep the gates
              </h2>
            </div>
            <a
              href={VIDEO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-[13px] font-semibold text-white shadow-brand hover:opacity-90 transition-opacity"
            >
              <PlayIcon /> Watch the 2-minute demo
            </a>
          </div>
          <div className="mt-6 rounded-2xl border border-line bg-canvas p-2 shadow-sm">
            <img
              src="/landing/mission-control.gif"
              alt="Mission Control walkthrough — campaigns, the activity timeline, and the approval gate"
              className="w-full rounded-xl"
              loading="lazy"
            />
          </div>
        </div>
      </section>

      {/* The loop */}
      <section className="max-w-5xl mx-auto px-6 py-12">
        <div className="text-[10px] uppercase tracking-[0.06em] text-ink-2 font-semibold">Operating loop</div>
        <ol className="mt-4 flex items-stretch gap-1.5 overflow-x-auto pb-1 -mx-6 px-6 sm:mx-0 sm:gap-2 sm:overflow-visible sm:px-0">
          {LOOP.map((s, i) => (
            <li key={s.step} className="flex shrink-0 items-stretch gap-1.5 sm:flex-1 sm:gap-2">
              <div className="flex-1 rounded-xl border border-line bg-surface px-3 py-2.5 text-center min-w-[112px] sm:min-w-0">
                <div className="text-[13px] font-semibold leading-tight text-ink">{s.step}</div>
                <div className="mt-0.5 text-[10px] leading-tight text-ink-2 mono">{s.does}</div>
              </div>
              <span
                aria-hidden
                className="shrink-0 self-center select-none text-[12px] text-brand-ink/45"
                title={i === LOOP.length - 1 ? "Back to sourcing" : undefined}
              >
                {i < LOOP.length - 1 ? "→" : "↺"}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-[12px] text-ink-2">
          Human checkpoints: policy gates. The default is{" "}
          <span className="font-semibold text-ink">always review</span>.
        </p>
      </section>

      {/* Gemini Enterprise Agent Platform — what we run live (Track 3 centrepiece) */}
      <section className="border-y border-line bg-surface">
        <div className="max-w-5xl mx-auto px-6 py-14">
          <div className="text-[10px] uppercase tracking-[0.06em] text-ink-2 font-semibold">Track 3 · refactored onto the platform</div>
          <h2 className="mt-1.5 text-[20px] sm:text-[26px] font-bold tracking-[-0.01em] text-ink">
            Gemini Enterprise Agent Platform — what we run live
          </h2>
          <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-ink-2">
            Built on Google&rsquo;s agent platform across its official axes — Build · Scale · Govern · Optimize · Ship.
            The orange ring marks what we run live today.
          </p>

          <a href={PLATFORM_MAP_URL} target="_blank" rel="noreferrer" className="group mt-6 block rounded-2xl border border-line bg-canvas p-2 shadow-sm hover:shadow-md transition-shadow">
            <img
              src="/landing/agent-platform-map.png"
              alt="Gemini Enterprise Agent Platform coverage map — orange marks what Social Seeding runs live"
              className="w-full rounded-xl"
              loading="lazy"
            />
            <span className="mt-2 mb-1 flex items-center justify-center gap-1.5 text-[11px] font-medium text-ink-2 group-hover:text-ink transition-colors">
              <PlayIcon /> Open the interactive map to read every cell
            </span>
          </a>

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {RUNTIME.map((c) => (
              <div key={c.title} className="rounded-2xl border border-line bg-canvas p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-[13px] font-bold text-ink leading-snug">{c.title}</div>
                  {c.tag ? (
                    <span className="shrink-0 rounded-full bg-ok-bg px-2 py-0.5 text-[10px] font-semibold text-ok">{c.tag}</span>
                  ) : null}
                </div>
                <div className="mt-1.5 text-[12px] leading-relaxed text-ink-2">{c.body}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Real results */}
      <section className="max-w-5xl mx-auto px-6 py-14">
        <div className="text-[10px] uppercase tracking-[0.06em] text-ink-2 font-semibold">Real results · a measured campaign</div>
        <h2 className="mt-1.5 text-[20px] sm:text-[26px] font-bold tracking-[-0.01em] text-ink">
          Wooliliwoo · K-beauty for Mexico
        </h2>
        <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-ink-2">
          A real past campaign — its verification tail, the part teams usually skip, completed by the fleet:
          actual post covers, per-creator leaderboard, reach roll-up.
        </p>

        <div className="mt-6 grid grid-cols-3 gap-4">
          {STATS.map((s) => (
            <div key={s.l} className="rounded-2xl border border-line bg-surface px-4 py-6 text-center">
              <div className="text-[28px] sm:text-[40px] font-bold tracking-[-0.02em] text-brand-ink mono leading-none">{s.n}</div>
              <div className="mt-2 text-[11px] uppercase tracking-[0.04em] text-ink-2 font-semibold">{s.l}</div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px] text-ink-2">
          <span><span className="font-semibold text-ink mono">71.4%</span> reply-triage on an unseen holdout</span>
          <span className="text-ink-3">·</span>
          <span><span className="font-semibold text-ink mono">2,933</span> tests green</span>
          <span className="text-ink-3">·</span>
          <span><span className="font-semibold text-ink mono">~$1–5</span>/mo idle (scale-to-zero)</span>
        </div>
      </section>

      {/* Closing CTA — repeat the primary actions for anyone who read to the end */}
      <section className="border-t border-line bg-surface">
        <div className="max-w-5xl mx-auto px-6 py-16 text-center">
          <h2 className="text-[22px] sm:text-[30px] font-bold tracking-[-0.01em] text-ink">
            The brief is all you need.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-[14px] leading-relaxed text-ink-2">
            Step in only at the gates you keep — the fleet runs the rest of the loop.
          </p>
          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="/sign-in"
              className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-brand px-5 text-[14px] font-semibold text-white shadow-brand hover:bg-brand-2 transition-colors"
            >
              <KeyIcon /> Enter as judge — read-only demo
            </a>
            <a
              href={VIDEO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-line bg-canvas px-5 text-[14px] font-semibold text-ink hover:bg-surface transition-colors"
            >
              <PlayIcon /> Watch the 2-minute demo
            </a>
          </div>
        </div>
      </section>

      <footer className="hairline border-t border-line">
        <div className="max-w-5xl mx-auto px-6 py-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-[11px] text-ink-2">
          <span>Google for Startups AI Agents Challenge · Track 3</span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <a href={VIDEO_URL} target="_blank" rel="noreferrer" className="hover:text-ink transition-colors">Demo video</a>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="hover:text-ink transition-colors">Code</a>
            <a href={AGENT_CARD_URL} target="_blank" rel="noreferrer" className="hover:text-ink transition-colors mono">A2A agent card</a>
            <span className="mono text-ink-2">agents.socialseed.ing</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
