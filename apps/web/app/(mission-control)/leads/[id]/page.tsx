import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle, SectionLabel } from "@/components/ui/card";
import { StatusTag } from "@/components/ui/status-tag";
import { Stat } from "@/components/ui/stat";
import { Funnel, type FunnelRow } from "@/components/ui/funnel";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { getServerSession } from "@/lib/auth";
import { leadCampaignRepo, leadRepo } from "@ss/db";
import type { Lead } from "@ss/contracts";
import { campaignStatus, leadStage, leadCampaignStageWithNumber, salesPriority } from "@/lib/labels";
import { fmtAgo } from "@/lib/format";

/**
 * /leads/[id] — lead campaign detail (C2 redesign). Mirrors /campaigns/[id]:
 *   · brief header + status/stage
 *   · KPI strip (registered companies / reply goal progress)
 *   · honest funnel (research -> proposal prep -> cold email -> conversation -> agreed)
 *   · per-lead list with company name · progress state · pitch summary
 *
 * Read-only — workflows and automation own all writes.
 */

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
  const st = campaignStatus(campaign.status);

  // Replies = anything that moved past first contact into a real conversation.
  const repliesCount = leads.filter(
    (l) => l.stage === "in_conversation" || l.stage === "agreed",
  ).length;
  const targetReplies = campaign.brief.goals.targetReplies;

  const funnelRows: FunnelRow[] = [
    { label: "Company analysis", value: funnel.enriched + funnel.researched + funnel.outreach_sent + funnel.in_conversation + funnel.agreed },
    { label: "Proposal prep", value: funnel.researched + funnel.outreach_sent + funnel.in_conversation + funnel.agreed },
    { label: "Cold email", value: funnel.outreach_sent + funnel.in_conversation + funnel.agreed },
    { label: "In conversation", value: funnel.in_conversation + funnel.agreed },
    { label: "Agreed", value: funnel.agreed },
  ];

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-5">
        <Link href="/leads" className="text-[12px] text-ink-3 hover:text-ink-2">← Lead campaigns</Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.01em]">{campaign.brief.name}</h1>
            <div className="mt-1 text-[12.5px] text-ink-3">
              Offer product · {campaign.brief.ourProduct.name} · started {fmtDate(campaign.createdAt)}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <StatusTag tone="neutral">{leadCampaignStageWithNumber(campaign.stage)}</StatusTag>
            <StatusTag tone={st.tone}>{st.label}</StatusTag>
          </div>
        </div>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-6">
        <Stat
          label="Registered companies"
          value={leads.length}
          unit="companies"
          hint={leads.length > 0 ? "Agents process them sequentially" : "Waiting for company import"}
          tone={leads.length > 0 ? "brand" : "muted"}
        />
        <Stat
          label="Replies / goal"
          value={repliesCount}
          unit={`/ ${targetReplies}`}
          hint={repliesCount >= targetReplies ? "Goal met" : `${Math.max(0, targetReplies - repliesCount)} remaining`}
          tone={repliesCount >= targetReplies && repliesCount > 0 ? "ok" : "default"}
        />
        <Stat
          label="Cold emails sent"
          value={funnel.outreach_sent + funnel.in_conversation + funnel.agreed}
          unit="companies"
          hint={`${funnel.in_conversation} in conversation · ${funnel.agreed} agreed`}
        />
        <Stat
          label="Deadline"
          value={fmtDate(campaign.brief.goals.deadline)}
          hint={campaign.brief.goals.budgetUsd !== undefined ? `Budget $${campaign.brief.goals.budgetUsd}` : "No budget set"}
          tone="muted"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_1.5fr] gap-4">
        {/* funnel */}
        <Card>
          <CardHeader>
            <CardTitle>Stage progress</CardTitle>
            <span className="text-[11px] text-ink-3 mono">0 = empty bar</span>
          </CardHeader>
          <CardBody><Funnel rows={funnelRows} /></CardBody>
        </Card>

        {/* per-lead list */}
        <Card>
          <CardHeader>
            <CardTitle>Leads</CardTitle>
            <span className="text-[11px] text-ink-3 mono">{leads.length} companies</span>
          </CardHeader>
          <CardBody className="pt-1.5">
            {leads.length === 0 ? (
              <div className="py-4">
                <EmptyState
                  icon="◎"
                  title="No companies imported yet."
                  hint="Agents may still be importing the company list. Check again shortly."
                  className="shadow-none border-line-2"
                />
              </div>
            ) : (
              <ul className="space-y-0.5">
                {leads.map((l) => {
                  const ls = leadStage(l.stage);
                  const summary = l.research?.pitch ?? l.enrichment?.analysis.company_summary;
                  const priority = l.enrichment ? salesPriority(l.enrichment.analysis.sales_priority) : null;
                  return (
                    <li key={l.id} className="py-3 border-b border-line-2 last:border-0">
                      <div className="flex items-start gap-3">
                        <Avatar name={l.companyName} size="md" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[14px] font-semibold text-ink">{l.companyName}</span>
                            <StatusTag tone={ls.tone} size="sm">{ls.label}</StatusTag>
                            {priority && (
                              <StatusTag tone={priority.tone} size="sm">{priority.label}</StatusTag>
                            )}
                          </div>
                          {l.homepageUrl && (
                            <div className="mt-0.5 text-[11px] text-ink-3 truncate">{l.homepageUrl}</div>
                          )}
                          {summary ? (
                            <p className="mt-2 text-[12.5px] text-ink-2 leading-relaxed line-clamp-3">{summary}</p>
                          ) : (
                            <p className="mt-2 text-[12px] text-ink-3">Research results are being prepared.</p>
                          )}
                        </div>
                        <div className="text-right text-[11px] text-ink-3 shrink-0 mono">
                          {fmtAgo(l.lastActivityAt)}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {/* honest footnote when leads exist but none reached outreach yet */}
      {leads.length > 0 && funnel.outreach_sent + funnel.in_conversation + funnel.agreed === 0 && (
        <div className="mt-4">
          <SectionLabel className="mb-1">Progress note</SectionLabel>
          <p className="text-[12.5px] text-ink-2">
            No cold emails have been sent yet. Agents are researching each company and preparing pitch angles before sending sequentially.
          </p>
        </div>
      )}
    </div>
  );
}
