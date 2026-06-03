import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { StatusTag } from "@/components/ui/status-tag";
import { EmptyState } from "@/components/ui/empty-state";
import { getServerSession } from "@/lib/auth";
import { campaignRepo, messageRepo } from "@ss/db";
import { replyClass } from "@/lib/labels";
import { fmtAgo } from "@/lib/format";
import { resolveCreators } from "@/lib/creators";

/**
 * 캠페인 한정 이메일 스레드 — the same thread list as `/threads`, scoped to one
 * campaign (mirrors the `/campaigns/[id]/{performance,posts,...}` sub-page
 * pattern, so the intuitive `/campaigns/[id]/threads` URL resolves). Rows open the
 * shared `/threads/[id]` detail carrying `?from=[campaignId]` so its back link
 * returns here. Reads v2_messages via messageRepo.threadsByCampaign.
 */
export default async function CampaignThreadsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;

  const campaign = await campaignRepo.get(id);
  if (!campaign || campaign.brief.workspaceId !== session.workspaceId) notFound();

  const threads = await messageRepo.threadsByCampaign(id, session.workspaceId).catch(() => []);
  const profiles = await resolveCreators(threads.map((t) => t.creatorId));

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      <header className="mb-5">
        <Link href={`/campaigns/${id}`} className="text-[12px] text-ink-3 hover:text-ink-2">← {campaign.brief.brandProduct.name}</Link>
        <h1 className="mt-2 text-[24px] font-bold tracking-[-0.01em]">이메일 스레드</h1>
        <p className="mt-1 text-[13.5px] text-ink-2">이 캠페인에서 에이전트가 크리에이터와 주고받은 대화입니다. 행을 누르면 전체 대화가 열립니다.</p>
      </header>

      {threads.length === 0 ? (
        <EmptyState
          icon="✉"
          title="아직 주고받은 메일이 없습니다"
          hint="이 캠페인이 아웃리치 단계로 들어가면 크리에이터와의 대화가 여기에 쌓입니다."
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {threads.map((t) => {
            const p = profiles.get(t.creatorId);
            const display = p?.nickname ?? p?.handle ?? t.creatorId;
            const cls = t.lastClassification ? replyClass(t.lastClassification) : null;
            return (
              <Link
                key={t.threadId}
                href={`/threads/${encodeURIComponent(t.threadId)}?from=${encodeURIComponent(id)}`}
                className="grid grid-cols-[auto_1fr_auto] gap-3.5 items-center bg-surface border border-line rounded-2xl shadow-soft px-5 py-4 transition-transform hover:-translate-y-0.5"
              >
                <Avatar name={display} src={p?.avatar} size="md" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-semibold text-ink truncate">{display}</span>
                    {p?.handle && p.handle !== display && <span className="text-[11.5px] text-ink-3 mono truncate">{p.handle}</span>}
                  </div>
                  <div className="mt-0.5 text-[13px] text-ink-2 truncate">
                    <span className="text-ink-3">{t.lastDirection === "outbound" ? "보냄: " : "받음: "}</span>
                    {t.lastSnippet}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className="text-[11.5px] text-ink-3 mono">{fmtAgo(t.lastAt)}</span>
                  <div className="flex items-center gap-1.5">
                    {cls && <StatusTag tone={cls.tone} size="sm">{cls.label}</StatusTag>}
                    <span className="text-[11px] text-ink-3">{t.messageCount}개</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
