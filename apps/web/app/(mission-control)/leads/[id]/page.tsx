import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth";
import { leadCampaignRepo, leadRepo } from "@ss/db";
import type { Lead } from "@ss/contracts";

/**
 * /leads/[id] — Phase 5 P5-C4 lead-campaign detail view. Shows:
 *   · brief + stage + status (mirrors /campaigns/[id] header)
 *   · funnel strip: imported / enriched / researched / outreach_sent /
 *     in_conversation / agreed / declined / no_response / flaked
 *   · per-lead leaderboard table (sortable by stage + confidence)
 *   · per-lead expand row shows enrichment summary + research pitch
 *     (no nested route; keep the surface flat for v5 MVP)
 *
 * Read-only — the workflow + cron own all writes.
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

function priorityVariant(p: "high" | "medium" | "low"): BadgeVariant {
  return p === "high" ? "emerald" : p === "medium" ? "amber" : "slate";
}

interface FunnelCounts {
  imported: number;
  enriched: number;
  researched: number;
  outreach_sent: number;
  in_conversation: number;
  agreed: number;
  declined: number;
  no_response: number;
  flaked: number;
}

function funnelOf(leads: Lead[]): FunnelCounts {
  const f: FunnelCounts = {
    imported: 0, enriched: 0, researched: 0, outreach_sent: 0,
    in_conversation: 0, agreed: 0, declined: 0, no_response: 0, flaked: 0,
  };
  for (const l of leads) {
    switch (l.stage) {
      case "imported":
      case "enriching": f.imported++; break;
      case "enriched": f.enriched++; break;
      case "researching":
      case "researched": f.researched++; break;
      case "outreach_sent": f.outreach_sent++; break;
      case "in_conversation": f.in_conversation++; break;
      case "agreed": f.agreed++; break;
      case "declined": f.declined++; break;
      case "no_response": f.no_response++; break;
      case "flaked": f.flaked++; break;
    }
  }
  return f;
}

export default async function LeadCampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;
  const campaign = await leadCampaignRepo.get(id);
  if (!campaign || campaign.brief.workspaceId !== session.workspaceId) notFound();

  // Pull this campaign's leads. listByWorkspace gives us everything;
  // filter to this campaign's leadIds + sort by stage progression.
  const all = await leadRepo.listByWorkspace(session.workspaceId, 1000);
  const idSet = new Set(campaign.leadIds);
  const leads = all.filter((l) => idSet.has(l.id));

  const funnel = funnelOf(leads);

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-6">
        <Link href="/leads" className="text-[11px] text-slate-500 hover:text-slate-900">← 리드 캠페인</Link>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div>
            <SectionLabel>{campaign.brief.ourProduct.name.toUpperCase()}</SectionLabel>
            <h1 className="mt-1 text-[22px] font-semibold">{campaign.brief.name}</h1>
            <div className="mt-1 text-[12px] text-slate-500">
              생성 {campaign.createdAt.toISOString().slice(0, 10)} · 목표 답신 {campaign.brief.goals.targetReplies} · 마감 {campaign.brief.goals.deadline.toISOString().slice(0, 10)}
              {campaign.brief.goals.budgetUsd !== undefined && ` · 예산 $${campaign.brief.goals.budgetUsd}`}
            </div>
          </div>
          <div className="flex gap-2">
            <Badge variant="slate">stage {campaign.stage}</Badge>
            <Badge variant={campaign.status === "completed" ? "emerald" : campaign.status === "cancelled" ? "rose" : "blue"}>
              {campaign.status}
            </Badge>
          </div>
        </div>
      </header>

      {/* funnel strip */}
      <div className="grid grid-cols-3 md:grid-cols-9 gap-2 mb-6">
        {(
          [
            ["imported", funnel.imported],
            ["enriched", funnel.enriched],
            ["researched", funnel.researched],
            ["outreach", funnel.outreach_sent],
            ["in_conv", funnel.in_conversation],
            ["agreed", funnel.agreed],
            ["declined", funnel.declined],
            ["no_resp", funnel.no_response],
            ["flaked", funnel.flaked],
          ] as const
        ).map(([label, count]) => (
          <Card key={label}><CardBody className="!py-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
            <div className="mt-0.5 text-[18px] font-semibold mono">{count}</div>
          </CardBody></Card>
        ))}
      </div>

      {/* leaderboard */}
      <Card><CardBody>
        <SectionLabel className="mb-3">리드 ({leads.length})</SectionLabel>
        {leads.length === 0 ? (
          <div className="text-[13px] text-slate-500 py-8 text-center">
            아직 리드가 없습니다. lead-campaign 워크플로우가 import 중일 수 있습니다.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {leads.map((l) => (
              <li key={l.id} className="py-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-medium text-slate-900">{l.companyName}</span>
                      <Badge variant={leadStageVariant(l.stage)}>{l.stage}</Badge>
                      {l.enrichment && (
                        <Badge variant={priorityVariant(l.enrichment.analysis.sales_priority)}>
                          priority {l.enrichment.analysis.sales_priority}
                        </Badge>
                      )}
                    </div>
                    {l.homepageUrl && (
                      <div className="mt-0.5 text-[11px] text-slate-500 mono truncate">{l.homepageUrl}</div>
                    )}
                    {l.research && (
                      <div className="mt-2 text-[12px] text-slate-700 leading-relaxed">
                        <span className="text-slate-500">pitch:</span> {l.research.pitch}
                      </div>
                    )}
                    {l.enrichment && !l.research && (
                      <div className="mt-2 text-[12px] text-slate-700 leading-relaxed">
                        <span className="text-slate-500">summary:</span> {l.enrichment.analysis.company_summary}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-[11px] text-slate-500 shrink-0 mono">
                    <div>{l.lastActivityAt.toISOString().slice(0, 10)}</div>
                    {l.research && <div>conf {l.research.confidence}</div>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody></Card>
    </div>
  );
}
