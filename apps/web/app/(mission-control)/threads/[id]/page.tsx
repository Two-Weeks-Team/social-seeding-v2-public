import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { StatusTag } from "@/components/ui/status-tag";
import { getServerSession } from "@/lib/auth";
import { campaignRepo, messageRepo } from "@ss/db";
import { replyClass } from "@/lib/labels";
import { resolveCreators } from "@/lib/creators";
import { cn } from "@/lib/cn";

/**
 * Email thread detail — the full back-and-forth for one creator thread. Outbound
 * (fleet) messages align right on a champagne fill; inbound (creator) align left
 * with the creator's avatar + the responder's classification. Reads v2_messages.
 */
function fmtWhen(d: Date): string {
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${d.toISOString().slice(11, 16)}`;
}

export default async function ThreadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;
  const { from } = await searchParams;
  const threadId = decodeURIComponent(id);

  const messages = await messageRepo.listByThread(threadId, session.workspaceId);
  if (messages.length === 0) notFound();

  const first = messages[0]!;
  const profiles = await resolveCreators([first.creatorId]);
  const p = profiles.get(first.creatorId);
  const display = p?.nickname ?? p?.handle ?? first.creatorId;
  const campaign = await campaignRepo.get(first.campaignId).catch(() => null);
  // Came from a campaign's mail tab → return there; otherwise the global list.
  const fromCampaign = from === first.campaignId;
  const back = fromCampaign
    ? { href: `/campaigns/${first.campaignId}/threads`, label: `← ${campaign?.brief.brandProduct.name ?? "Campaign"} mail` }
    : { href: "/threads", label: "← Email threads" };

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <header className="mb-6">
        <Link href={back.href} className="text-[12px] text-ink-3 hover:text-ink-2">{back.label}</Link>
        <div className="mt-2 flex items-center gap-3">
          <Avatar name={display} src={p?.avatar} size="lg" />
          <div className="min-w-0">
            <h1 className="text-[20px] font-bold tracking-[-0.01em] truncate">{display}</h1>
            <div className="text-[12.5px] text-ink-3 truncate">
              {p?.handle && p.handle !== display ? `${p.handle} · ` : ""}
              {campaign ? campaign.brief.brandProduct.name : "Campaign"}
            </div>
          </div>
        </div>
        <div className="mt-3 text-[13px] text-ink-2">
          <span className="text-ink-3">Subject </span>{first.subject}
        </div>
      </header>

      <div className="flex flex-col gap-4">
        {messages.map((m) => {
          const out = m.direction === "outbound";
          const cls = m.classification ? replyClass(m.classification) : null;
          return (
            <div key={m.id} className={cn("flex", out ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[80%]", out ? "items-end" : "items-start", "flex flex-col gap-1")}>
                <div className="flex items-center gap-2 px-1">
                  <span className="text-[11.5px] font-semibold text-ink-2">{out ? "Us (agent)" : display}</span>
                  {cls && <StatusTag tone={cls.tone} size="sm">{cls.label}</StatusTag>}
                  <span className="text-[11px] text-ink-3 mono">{fmtWhen(m.sentAt)}</span>
                </div>
                <div
                  className={cn(
                    "rounded-2xl border px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap",
                    out ? "bg-brand-soft border-brand-ink/20 text-ink" : "bg-surface border-line text-ink shadow-soft",
                  )}
                >
                  {m.subject && m.subject !== first.subject && (
                    <div className="text-[12px] font-semibold text-ink-2 mb-1">{m.subject}</div>
                  )}
                  {m.body}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
