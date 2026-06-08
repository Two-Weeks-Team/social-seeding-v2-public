import Link from "next/link";
import { redirect } from "next/navigation";
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
 * Email threads — every creator email conversation in the workspace (outbound
 * outreach/replies + inbound creator replies), newest activity first. Each row
 * opens the full thread. Reads v2_messages via messageRepo.
 */
export default async function ThreadsPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const threads = await messageRepo.listThreadsByWorkspace(session.workspaceId);
  const profiles = await resolveCreators(threads.map((t) => t.creatorId));
  const campaigns = await campaignRepo.listByWorkspace(session.workspaceId).catch(() => []);
  const campaignName = new Map(campaigns.map((c) => [c.id, c.brief.brandProduct.name]));

  // Inbox triage: a thread whose last message is the creator's reply is awaiting
  // our follow-up. Surface those first — the operator's real job is "who's waiting
  // on me", not just "newest". (Array.sort is stable, so within each group the
  // repo's newest-activity-first order is preserved.)
  const awaitsReply = (t: (typeof threads)[number]) => t.lastDirection === "inbound";
  const ordered = [...threads].sort((a, b) => Number(awaitsReply(b)) - Number(awaitsReply(a)));
  const awaitingCount = threads.filter(awaitsReply).length;

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      <header className="mb-5">
        <h1 className="text-[24px] font-bold tracking-[-0.01em]">Email threads</h1>
        <p className="mt-1 text-[13.5px] text-ink-2">
          Outreach and reply conversations the agents exchanged with creators.
          {awaitingCount > 0 && (
            <> <span className="text-warn font-semibold">{awaitingCount}</span> waiting for a reply.</>
          )}
        </p>
      </header>

      {threads.length === 0 ? (
        <EmptyState
          icon="✉"
          title="No email yet"
          hint="When campaigns enter outreach, creator conversations will appear here."
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
                href={`/threads/${encodeURIComponent(t.threadId)}`}
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
                    <span className="text-[11.5px] text-ink-3 truncate">· {campaignName.get(t.campaignId) ?? "Campaign"}</span>
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
