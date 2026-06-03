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
 * /leads/[id] — 리드 캠페인 상세 (C2 redesign). Mirrors /campaigns/[id]:
 *   · brief header + 상태/단계
 *   · KPI strip (등록 / 답신 목표·진행)
 *   · honest funnel (조사 → 제안 준비 → 콜드메일 → 대화 → 협의)
 *   · per-lead list with 회사명 · 진행 상태 · 제안 요약
 *
 * Read-only — 워크플로우와 자동화가 모든 쓰기를 담당합니다.
 */

function fmtDate(d: Date): string {
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
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
    { label: "회사 분석", value: funnel.enriched + funnel.researched + funnel.outreach_sent + funnel.in_conversation + funnel.agreed },
    { label: "제안 준비", value: funnel.researched + funnel.outreach_sent + funnel.in_conversation + funnel.agreed },
    { label: "콜드메일", value: funnel.outreach_sent + funnel.in_conversation + funnel.agreed },
    { label: "대화 중", value: funnel.in_conversation + funnel.agreed },
    { label: "협의 완료", value: funnel.agreed },
  ];

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-5">
        <Link href="/leads" className="text-[12px] text-ink-3 hover:text-ink-2">← 리드 목록</Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.01em]">{campaign.brief.name}</h1>
            <div className="mt-1 text-[12.5px] text-ink-3">
              제안 제품 · {campaign.brief.ourProduct.name} · {fmtDate(campaign.createdAt)} 시작
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
          label="등록 회사"
          value={leads.length}
          unit="곳"
          hint={leads.length > 0 ? "에이전트가 순차로 처리합니다" : "회사 등록 대기 중"}
          tone={leads.length > 0 ? "brand" : "muted"}
        />
        <Stat
          label="답신 / 목표"
          value={repliesCount}
          unit={`/ ${targetReplies}`}
          hint={repliesCount >= targetReplies ? "목표 달성" : `목표까지 ${Math.max(0, targetReplies - repliesCount)}곳`}
          tone={repliesCount >= targetReplies && repliesCount > 0 ? "ok" : "default"}
        />
        <Stat
          label="콜드메일 발송"
          value={funnel.outreach_sent + funnel.in_conversation + funnel.agreed}
          unit="곳"
          hint={`대화 중 ${funnel.in_conversation}곳 · 협의 ${funnel.agreed}곳`}
        />
        <Stat
          label="마감"
          value={fmtDate(campaign.brief.goals.deadline)}
          hint={campaign.brief.goals.budgetUsd !== undefined ? `예산 $${campaign.brief.goals.budgetUsd}` : "예산 미설정"}
          tone="muted"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_1.5fr] gap-4">
        {/* funnel */}
        <Card>
          <CardHeader>
            <CardTitle>단계별 진행</CardTitle>
            <span className="text-[11px] text-ink-3 mono">0 = 빈 막대</span>
          </CardHeader>
          <CardBody><Funnel rows={funnelRows} /></CardBody>
        </Card>

        {/* per-lead list */}
        <Card>
          <CardHeader>
            <CardTitle>리드</CardTitle>
            <span className="text-[11px] text-ink-3 mono">{leads.length}곳</span>
          </CardHeader>
          <CardBody className="pt-1.5">
            {leads.length === 0 ? (
              <div className="py-4">
                <EmptyState
                  icon="◎"
                  title="아직 등록된 회사가 없습니다."
                  hint="에이전트가 회사 목록을 등록하는 중일 수 있습니다. 잠시 후 다시 확인해주세요."
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
                            <p className="mt-2 text-[12px] text-ink-3">조사 결과를 준비하고 있습니다.</p>
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
          <SectionLabel className="mb-1">진행 안내</SectionLabel>
          <p className="text-[12.5px] text-ink-2">
            아직 콜드메일이 나가지 않았습니다. 에이전트가 각 회사를 조사하고 제안 포인트를 정리한 뒤 순차로 발송합니다.
          </p>
        </div>
      )}
    </div>
  );
}
