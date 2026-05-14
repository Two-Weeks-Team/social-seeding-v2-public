import { notFound } from "next/navigation";
import { timingSafeEqual } from "node:crypto";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { reportRepo } from "@ss/db";
import type { Report } from "@ss/contracts";

/**
 * /share/[id] — Phase 4 P4-C5b. Public, no-auth preview of a delivered
 * Report's markdown. URL = /share/<reportId>?t=<shareToken>.
 *
 * Authn: report row stores a 24-byte random base64url shareToken (P4-C3).
 * The query string passes it; we constant-time-compare against the row's
 * value. On any mismatch / missing param / missing row, render notFound()
 * — never leak whether the report id exists.
 *
 * What this page renders: the summary + the markdown narrative + a tiny
 * "Verified posts" / "Reach" stat strip. No edit affordances; no operator
 * tools; no links back into MC. The page is intentionally minimal — it's
 * the "send this to your CEO" view.
 *
 * What it does NOT show: cost (internal), raw track list (internal), flag
 * tags ("budget_exceeded" is operator framing). Anything sensitive lives
 * on /campaigns/[id]/report behind auth.
 */

export const dynamic = "force-dynamic";

function constantTimeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; pad the shorter one to
  // avoid leaking length via the early-return.
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still do a constant-time op against a same-length sink so timing is
    // dominated by ab.length, not by which-was-shorter.
    const sink = Buffer.alloc(ab.length);
    try { timingSafeEqual(ab, sink); } catch { /* size mismatch — fall through */ }
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function renderMarkdown(md: string): React.ReactElement {
  const lines = md.split("\n");
  const out: React.ReactElement[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("# ")) {
      out.push(<h1 key={key++} className="text-[28px] font-semibold mt-8 mb-3">{line.slice(2)}</h1>);
      i++;
    } else if (line.startsWith("## ")) {
      out.push(<h2 key={key++} className="text-[18px] font-semibold mt-6 mb-2 text-slate-700">{line.slice(3)}</h2>);
      i++;
    } else if (line.startsWith("### ")) {
      out.push(<h3 key={key++} className="text-[14px] font-semibold mt-4 mb-1.5 text-slate-700">{line.slice(4)}</h3>);
      i++;
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i]!.startsWith("- ") || lines[i]!.startsWith("* "))) {
        items.push(lines[i]!.replace(/^[*-] /, ""));
        i++;
      }
      out.push(
        <ul key={key++} className="list-disc pl-6 my-2 text-[15px] text-slate-700 space-y-1">
          {items.map((it, j) => <li key={j}>{it}</li>)}
        </ul>,
      );
    } else if (line.startsWith("| ")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        tableLines.push(lines[i]!);
        i++;
      }
      const rows = tableLines.filter((l) => !/^\|\s*-+/.test(l)).map((l) =>
        l.split("|").map((c) => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1),
      );
      const [header, ...body] = rows;
      if (header) {
        out.push(
          <table key={key++} className="mt-3 mb-4 w-full text-[14px] border-collapse">
            <thead className="bg-slate-50 text-[12px] uppercase tracking-wider text-slate-600">
              <tr>
                {header.map((h, idx) => <th key={idx} className="text-left px-3 py-2 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri} className="border-t border-slate-100">
                  {r.map((c, ci) => <td key={ci} className="px-3 py-2 mono text-slate-700">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>,
        );
      }
    } else if (line.trim() === "") {
      i++;
    } else {
      out.push(<p key={key++} className="text-[15px] text-slate-700 leading-relaxed my-2">{line}</p>);
      i++;
    }
  }
  return <div>{out}</div>;
}

interface SharePageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string | string[] }>;
}

export default async function SharePage({ params, searchParams }: SharePageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const tokenParam = Array.isArray(sp.t) ? sp.t[0] : sp.t;
  if (!tokenParam) notFound();

  let report: Report | null = null;
  try {
    report = await reportRepo.get(id);
  } catch {
    // malformed id (not an ObjectId) — treat as not found, never leak.
    notFound();
  }
  if (!report) notFound();
  if (!report.shareToken || !constantTimeEqual(report.shareToken, tokenParam)) notFound();

  const a = report.analytics;
  const verifiedFraction = `${a.goals.verifiedCount} / ${a.goals.targetLivePosts}`;
  const reach = a.reach.verifiedViews.toLocaleString();
  const er = a.reach.weightedEngagementRate !== null
    ? `${(a.reach.weightedEngagementRate * 100).toFixed(1)}%`
    : "—";

  return (
    <main className="min-h-screen bg-white">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* minimal header — branded but operator-free */}
        <div className="mb-8 pb-6 border-b border-slate-200">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Campaign Report</div>
          <h1 className="mt-1 text-[28px] font-semibold text-slate-900">
            {a.brief.name}
          </h1>
          <div className="mt-1 text-[13px] text-slate-500 mono">
            {a.brief.category} · 생성됨 {report.generatedAt.toISOString().slice(0, 10)}
          </div>
        </div>

        {/* compact stat strip */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <Card><CardBody>
            <SectionLabel>VERIFIED</SectionLabel>
            <div className="mt-1 text-[22px] font-semibold mono">{verifiedFraction}</div>
            {a.goals.goalMet && (
              <Badge variant="emerald" className="mt-1.5">goal met</Badge>
            )}
          </CardBody></Card>
          <Card><CardBody>
            <SectionLabel>REACH</SectionLabel>
            <div className="mt-1 text-[22px] font-semibold mono">{reach}</div>
            <div className="mt-0.5 text-[11px] text-slate-500">verified views · ER {er}</div>
          </CardBody></Card>
          <Card><CardBody>
            <SectionLabel>DEADLINE</SectionLabel>
            <div className={`mt-1 text-[22px] font-semibold mono ${a.goals.daysToDeadline < 0 ? "text-rose-700" : ""}`}>
              {a.brief.deadline.toISOString().slice(0, 10)}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              {a.goals.daysToDeadline >= 0 ? `${a.goals.daysToDeadline}d remaining` : `${-a.goals.daysToDeadline}d past`}
            </div>
          </CardBody></Card>
        </div>

        {/* summary callout */}
        <Card className="mb-6"><CardBody>
          <SectionLabel className="mb-2">SUMMARY</SectionLabel>
          <p className="text-[16px] text-slate-800 leading-relaxed">{report.narrative.summary}</p>
        </CardBody></Card>

        {/* the markdown narrative */}
        <article className="prose max-w-none">
          {renderMarkdown(report.narrative.markdown)}
        </article>

        {/* footer: branding only — no auth-only navigation */}
        <footer className="mt-12 pt-6 border-t border-slate-200 text-[11px] text-slate-400">
          Generated by Social Seeding · 공개 미리보기 · 토큰 폐기는 캠페인 운영자에게 문의하세요.
        </footer>
      </div>
    </main>
  );
}
