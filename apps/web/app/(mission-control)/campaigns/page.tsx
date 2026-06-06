import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { AgentStatusStrip } from "@/components/mission-control/agent-status-strip";
import { CampaignByStage, CampaignRow, type CampaignItem } from "@/components/mission-control/campaign-by-stage";
import { resolveCreators } from "@/lib/creators";
import { getServerSession } from "@/lib/auth";
import { campaignRepo, approvalRepo, messageRepo } from "@ss/db";
import { cn } from "@/lib/cn";

/**
 * W2 — Campaigns = the operator home. Research-grounded mix (Refero):
 * Mailchimp's clean campaign list (rows + status + search/filter) wrapped in
 * Rox "Revenue Agents" cockpit elements — a live agent-status strip + a
 * 리스트 / 단계별 view toggle. The 단계별 view groups campaigns under vertical
 * stage sections (NOT a draggable kanban: stages are advanced by the agent
 * workflow, so a board would imply an interaction that doesn't exist). C2 tokens.
 */
const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "running", label: "진행 중" },
  { key: "completed", label: "완료" },
  { key: "attention", label: "주의" },
];

type View = "list" | "stages";

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string; view?: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const sp = (await searchParams) ?? {};
  const q = (sp.q ?? "").trim();
  const filter = sp.status ?? "all";
  const view: View = sp.view === "stages" ? "stages" : "list";

  const all = await campaignRepo.listByWorkspace(session.workspaceId);

  const allPending = await approvalRepo.listPendingByWorkspace(session.workspaceId).catch(() => []);
  const pendingByCampaign = new Map<string, number>();
  for (const a of allPending) pendingByCampaign.set(a.campaignId, (pendingByCampaign.get(a.campaignId) ?? 0) + 1);

  // Agent-status strip stats (real data).
  const threads = await messageRepo.listThreadsByWorkspace(session.workspaceId).catch(() => []);
  const awaitingReply = threads.filter((t) => t.lastDirection === "inbound").length;
  const runningCount = all.filter((c) => c.status === "running").length;
  const completedCount = all.filter((c) => c.status === "completed").length;

  const campaigns = all.filter((c) => {
    if (q && !c.brief.brandProduct.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === "running") return c.status === "running";
    if (filter === "completed") return c.status === "completed";
    if (filter === "attention") return (pendingByCampaign.get(c.id) ?? 0) > 0 || c.status === "paused";
    return true;
  });

  const listProfiles = await resolveCreators(campaigns.flatMap((c) => c.tracks.slice(0, 3).map((t) => t.creatorId)));

  const items: CampaignItem[] = campaigns.map((c) => ({
    id: c.id,
    name: c.brief.brandProduct.name,
    category: c.brief.brandProduct.category,
    status: c.status,
    stage: c.stage,
    creatorIds: c.tracks.slice(0, 3).map((t) => t.creatorId),
    trackCount: c.tracks.length,
    pending: pendingByCampaign.get(c.id) ?? 0,
    createdAt: (c as { createdAt?: Date }).createdAt,
    updatedAt: c.updatedAt,
  }));

  const buildHref = (next: { status?: string; view?: string }) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const status = next.status ?? filter;
    if (status && status !== "all") params.set("status", status);
    const v = next.view ?? view;
    if (v && v !== "list") params.set("view", v);
    const s = params.toString();
    return s ? `/campaigns?${s}` : "/campaigns";
  };

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-5 flex items-start justify-between gap-5">
        <div>
          <h1 className="text-[24px] font-bold tracking-[-0.01em]">캠페인</h1>
          <p className="mt-1 text-[13.5px] text-ink-2">에이전트가 운영 중인 캠페인입니다. 행을 누르면 무엇을 했는지 타임라인이 열립니다.</p>
        </div>
        <Link href="/campaigns/new"><Button variant="primary">＋ 새 캠페인</Button></Link>
      </header>

      <AgentStatusStrip running={runningCount} awaitingReply={awaitingReply} pendingApprovals={allPending.length} completed={completedCount} />

      {/* search + filters + view toggle */}
      <div className="mb-4 flex items-center gap-2.5 flex-wrap">
        <form className="flex items-center gap-2.5" action="/campaigns" method="get">
          <div className="flex items-center gap-2 border border-line rounded-xl px-3.5 py-2 bg-surface w-[300px] max-w-full">
            <span className="text-ink-3" aria-hidden>⌕</span>
            <input
              name="q"
              defaultValue={q}
              placeholder="캠페인 검색…"
              className="flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-3 outline-none"
            />
          </div>
          {filter !== "all" && <input type="hidden" name="status" value={filter} />}
          {view !== "list" && <input type="hidden" name="view" value={view} />}
        </form>
        {FILTERS.map((f) => {
          const isActive = filter === f.key || (f.key === "all" && filter === "all");
          return (
            <Link
              key={f.key}
              href={buildHref({ status: f.key })}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-[12.5px] font-medium border transition-colors",
                isActive ? "bg-ink text-white border-ink" : "bg-surface text-ink-2 border-line hover:bg-surface-2",
              )}
            >
              {f.label}
            </Link>
          );
        })}
        <div className="ml-auto inline-flex p-0.5 bg-surface-2 border border-line rounded-xl gap-0.5">
          {([["list", "리스트"], ["stages", "단계별"]] as const).map(([v, label]) => (
            <Link
              key={v}
              href={buildHref({ view: v })}
              className={cn(
                "px-3 py-1.5 text-[12.5px] rounded-[10px] font-medium transition-colors",
                view === v ? "bg-surface shadow-soft text-ink" : "text-ink-3 hover:text-ink",
              )}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>

      {campaigns.length === 0 ? (
        <EmptyState
          icon="◎"
          title={q || filter !== "all" ? "조건에 맞는 캠페인이 없습니다." : "아직 캠페인이 없습니다."}
          hint={q || filter !== "all" ? "검색어나 필터를 바꿔보세요." : "브리프를 채우면 에이전트가 소싱부터 시작합니다."}
          action={<Link href="/campaigns/new"><Button variant="primary">＋ 새 캠페인</Button></Link>}
        />
      ) : view === "stages" ? (
        <CampaignByStage items={items} profiles={listProfiles} />
      ) : (
        <div className="flex flex-col gap-2.5">
          {items.map((it) => (
            <CampaignRow key={it.id} item={it} profiles={listProfiles} showStage />
          ))}
        </div>
      )}
    </div>
  );
}
