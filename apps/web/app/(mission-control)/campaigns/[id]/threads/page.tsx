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
import { cn } from "@/lib/cn";

/**
 * Campaign-scoped email threads — the same thread list as `/threads`, scoped to one
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

  // Inbox triage: surface threads awaiting our follow-up (last message inbound) first.
  const awaitsReply = (t: (typeof threads)[number]) => t.lastDirection === "inbound";
  const ordered = [...threads].sort((a, b) => Number(awaitsReply(b)) - Number(awaitsReply(a)));
  const awaitingCount = threads.filter(awaitsReply).length;

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      <header className="mb-5">
        <Link href={`/campaigns/${id}`} className="text-[12px] text-ink-3 hover:text-ink-2">← {campaign.brief.brandProduct.name}</Link>
        <h1 className="mt-2 text-[24px] font-bold tracking-[-0.01em]">Email threads</h1>
        <p className="mt-1 text-[13.5px] text-ink-2">
          Conversations the agents exchanged with creators for this campaign.
          {awaitingCount > 0 && (
            <> <span className="text-warn font-semibold">{awaitingCount}</span> waiting for a reply.</>
          )}
        </p>
      </header>

      {threads.length === 0 ? (
        <EmptyState
          icon="✉"
          title="No email yet"
          hint="When this campaign enters outreach, creator conversations will appear here."
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {ordered.map((t) => {
            const p = profiles.get(t.creatorId);
            const display = p?.nickname ?? p?.handle ?? t.creatorId;
            const cls = t.lastClassification ? replyClass(t.lastClassification) : null;
            const reply = awaitsReply(t);
            return (
              <Link
                key={t.threadId}
                href={`/threads/${encodeURIComponent(t.threadId)}?from=${encodeURIComponent(id)}`}
                className={cn(
                  "grid grid-cols-[auto_1fr_auto] gap-3.5 items-center bg-surface border rounded-2xl shadow-soft px-5 py-4 transition-transform hover:-translate-y-0.5",
                  reply ? "border-warn/40 border-l-[3px] border-l-warn" : "border-line",
                )}
              >
                <Avatar name={display} src={p?.avatar} size="md" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn("text-[14px] truncate", reply ? "font-bold text-ink" : "font-semibold text-ink")}>{display}</span>
                    {p?.handle && p.handle !== display && <span className="text-[11.5px] text-ink-3 mono truncate">{p.handle}</span>}
                  </div>
                  <div className="mt-0.5 text-[13px] text-ink-2 truncate">
                    <span className="text-ink-3">{t.lastDirection === "outbound" ? "Sent: " : "Received: "}</span>
                    {t.lastSnippet}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className="text-[11.5px] text-ink-3 mono">{fmtAgo(t.lastAt)}</span>
                  <div className="flex items-center gap-1.5">
                    {reply ? (
                      <StatusTag tone="warn" size="sm">Reply needed</StatusTag>
                    ) : (
                      cls && <StatusTag tone={cls.tone} size="sm">{cls.label}</StatusTag>
                    )}
                    <span className="text-[11px] text-ink-3">{t.messageCount} messages</span>
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
