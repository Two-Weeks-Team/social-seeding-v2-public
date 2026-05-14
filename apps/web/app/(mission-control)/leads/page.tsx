import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth";
import { leadCampaignRepo, leadRepo } from "@ss/db";
import type { Lead } from "@ss/contracts";

/**
 * /leads — Phase 5 P5-C4. Operator's view of all lead-campaigns +
 * recent leads in the workspace. Mirrors /campaigns: list view with a
 * "+ New campaign" CTA. Two tables — one per lead-campaign (top) and
 * one row per lead (bottom, scoped to the most-recent campaigns).
 *
 * Reads only — workflow + cron own all writes.
 */

function leadStageVariant(stage: Lead["stage"]): BadgeVariant {
  switch (stage) {
    case "imported":
    case "enriching":
    case "researching":
      return "slate";
    case "enriched":
    case "researched":
    case "outreach_sent":
      return "blue";
    case "in_conversation":
      return "amber";
    case "agreed":
      return "emerald";
    case "declined":
    case "flaked":
      return "rose";
    case "no_response":
      return "amber";
    default:
      return "slate";
  }
}

export default async function LeadsPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const [campaigns, recentLeads] = await Promise.all([
    leadCampaignRepo.listByWorkspace(session.workspaceId),
    leadRepo.listByWorkspace(session.workspaceId, 30),
  ]);

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <SectionLabel>LEADS</SectionLabel>
          <h1 className="mt-1 text-[22px] font-semibold">리드 (B2B)</h1>
          <p className="mt-1 text-[13px] text-slate-500">
            sales-lead 캠페인 — 회사 리스트를 import 하면 crm.enrich + research 에이전트를 거쳐 자동 outreach 됩니다.
          </p>
        </div>
        <Link href="/leads/new">
          <Button variant="primary" tone="approve">+ 새 리드 캠페인</Button>
        </Link>
      </header>

      {/* ── lead-campaigns ────────────────────────────────────────────── */}
      <Card className="mb-6"><CardBody>
        <SectionLabel className="mb-3">캠페인 ({campaigns.length})</SectionLabel>
        {campaigns.length === 0 ? (
          <div className="text-[13px] text-slate-500 py-8 text-center">
            아직 리드 캠페인이 없습니다.{" "}
            <Link href="/leads/new" className="text-blue-700 hover:underline">새 캠페인 시작 →</Link>
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left px-2 py-2 font-medium">캠페인</th>
                <th className="text-left px-2 py-2 font-medium">단계</th>
                <th className="text-left px-2 py-2 font-medium">상태</th>
                <th className="text-right px-2 py-2 font-medium">leads</th>
                <th className="text-right px-2 py-2 font-medium">업데이트</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                  <td className="px-2 py-2.5">
                    <Link href={`/leads/${c.id}`} className="text-slate-900 hover:underline">
                      {c.brief.name}
                    </Link>
                    <div className="text-[11px] text-slate-500 mono">{c.brief.ourProduct.name}</div>
                  </td>
                  <td className="px-2 py-2.5"><Badge variant="slate">{c.stage}</Badge></td>
                  <td className="px-2 py-2.5">
                    <Badge variant={c.status === "completed" ? "emerald" : c.status === "cancelled" ? "rose" : "blue"}>
                      {c.status}
                    </Badge>
                  </td>
                  <td className="px-2 py-2.5 mono text-right">{c.leadIds.length}</td>
                  <td className="px-2 py-2.5 mono text-right text-slate-500">
                    {c.updatedAt.toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody></Card>

      {/* ── recent leads (across all campaigns) ───────────────────────── */}
      <Card><CardBody>
        <SectionLabel className="mb-3">최근 리드 ({recentLeads.length})</SectionLabel>
        {recentLeads.length === 0 ? (
          <div className="text-[13px] text-slate-500 py-6 text-center">
            아직 import 된 리드가 없습니다.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left px-2 py-2 font-medium">회사</th>
                <th className="text-left px-2 py-2 font-medium">country</th>
                <th className="text-left px-2 py-2 font-medium">stage</th>
                <th className="text-left px-2 py-2 font-medium">enrich</th>
                <th className="text-left px-2 py-2 font-medium">research</th>
                <th className="text-right px-2 py-2 font-medium">활동</th>
              </tr>
            </thead>
            <tbody>
              {recentLeads.map((l) => (
                <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                  <td className="px-2 py-2.5">
                    <div className="text-slate-900">{l.companyName}</div>
                    {l.homepageUrl && (
                      <div className="text-[11px] text-slate-500 mono truncate max-w-[260px]">{l.homepageUrl}</div>
                    )}
                  </td>
                  <td className="px-2 py-2.5 mono text-slate-700">{l.country}</td>
                  <td className="px-2 py-2.5"><Badge variant={leadStageVariant(l.stage)}>{l.stage}</Badge></td>
                  <td className="px-2 py-2.5">
                    {l.enrichment ? (
                      <Badge variant="emerald">{l.enrichment.analysis.sales_priority}</Badge>
                    ) : (
                      <span className="text-slate-400 text-[12px]">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5">
                    {l.research ? (
                      <Badge variant="emerald">confidence {l.research.confidence}</Badge>
                    ) : (
                      <span className="text-slate-400 text-[12px]">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 mono text-right text-slate-500">
                    {l.lastActivityAt.toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody></Card>
    </div>
  );
}
