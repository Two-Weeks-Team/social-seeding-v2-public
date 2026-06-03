import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusTag } from "@/components/ui/status-tag";
import { EmptyState } from "@/components/ui/empty-state";
import { Avatar } from "@/components/ui/avatar";
import { campaignStatus, leadStage, leadCampaignStageWithNumber } from "@/lib/labels";
import { fmtAgo } from "@/lib/format";
import { getServerSession } from "@/lib/auth";
import { leadCampaignRepo, leadRepo } from "@ss/db";

/**
 * /leads — B2B 리드 캠페인 목록 (C2 redesign). Mirrors /campaigns: scannable
 * card-rows for each lead-campaign + a recent-leads panel. Reads only —
 * 워크플로우와 자동화가 모든 쓰기를 담당합니다.
 */

export default async function LeadsPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const [campaigns, recentLeads] = await Promise.all([
    leadCampaignRepo.listByWorkspace(session.workspaceId),
    leadRepo.listByWorkspace(session.workspaceId, 12),
  ]);

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-5 flex items-start justify-between gap-5">
        <div>
          <h1 className="text-[24px] font-bold tracking-[-0.01em]">리드 · B2B</h1>
          <p className="mt-1 text-[13.5px] text-ink-2 max-w-[560px]">
            제안하고 싶은 회사 목록을 올리면 에이전트가 각 회사를 조사하고, 제안 포인트를 정리한 뒤 콜드메일까지 보냅니다.
          </p>
        </div>
        <Link href="/leads/new"><Button variant="primary">＋ 새 리드 캠페인</Button></Link>
      </header>

      {campaigns.length === 0 ? (
        <EmptyState
          icon="◎"
          title="아직 리드 캠페인이 없습니다."
          hint="제안할 회사 목록을 붙여넣으면 에이전트가 회사 조사부터 콜드메일까지 알아서 진행합니다."
          action={<Link href="/leads/new"><Button variant="primary">＋ 새 리드 캠페인</Button></Link>}
        />
      ) : (
        <div className="flex flex-col gap-2.5 mb-7">
          {campaigns.map((c) => {
            const st = campaignStatus(c.status);
            return (
              <Link
                key={c.id}
                href={`/leads/${c.id}`}
                className="grid grid-cols-[1.7fr_130px_1.1fr_88px_96px] gap-4 items-center bg-surface border border-line rounded-2xl shadow-soft px-5 py-4 transition-transform hover:-translate-y-0.5"
              >
                <div className="min-w-0">
                  <div className="text-[15px] font-bold text-ink truncate">{c.brief.name}</div>
                  <div className="text-[12px] text-ink-3 mt-0.5 truncate">
                    제안 제품 · {c.brief.ourProduct.name}
                  </div>
                </div>
                <div>
                  <StatusTag tone={st.tone}>{st.label}</StatusTag>
                </div>
                <div>
                  <div className="text-[10.5px] uppercase tracking-[0.05em] text-ink-3">현재 단계</div>
                  <div className="text-[13px] text-ink-2 mt-0.5">
                    <span className="font-bold text-ink">{leadCampaignStageWithNumber(c.stage)}</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10.5px] uppercase tracking-[0.05em] text-ink-3">회사</div>
                  <div className="text-[13px] text-ink-2 mt-0.5 mono">
                    {c.leadIds.length > 0 ? `${c.leadIds.length}곳` : "등록 전"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10.5px] uppercase tracking-[0.05em] text-ink-3">활동</div>
                  <div className="text-[13px] text-ink-2 mt-0.5 mono">{fmtAgo(c.updatedAt)}</div>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* ── recent leads (across all campaigns) ───────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>최근 리드</CardTitle>
          <span className="text-[11px] text-ink-3 mono">{recentLeads.length}곳</span>
        </CardHeader>
        <CardBody className="pt-1.5">
          {recentLeads.length === 0 ? (
            <div className="text-[12.5px] text-ink-3 py-4">아직 등록된 회사가 없습니다.</div>
          ) : (
            <div className="space-y-0.5">
              {recentLeads.map((l) => {
                const ls = leadStage(l.stage);
                return (
                  <div
                    key={l.id}
                    className="flex items-center gap-3 py-2.5 border-b border-line-2 last:border-0"
                  >
                    <Avatar name={l.companyName} size="sm" />
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink truncate">{l.companyName}</div>
                      {l.homepageUrl && (
                        <div className="text-[11px] text-ink-3 truncate max-w-[300px]">{l.homepageUrl}</div>
                      )}
                    </div>
                    <StatusTag tone={ls.tone} size="sm" className="ml-auto">{ls.label}</StatusTag>
                    <span className="text-[11px] text-ink-3 mono w-16 text-right shrink-0">{fmtAgo(l.lastActivityAt)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
