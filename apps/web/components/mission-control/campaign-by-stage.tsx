import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { StatusTag } from "@/components/ui/status-tag";
import { campaignStatus, stageKo, STAGE_ORDER } from "@/lib/labels";
import { fmtAgo } from "@/lib/format";
import type { CreatorView } from "@/lib/creators";
import { cn } from "@/lib/cn";

/**
 * Campaign "by stage" view + the shared campaign row.
 *
 * NOT a kanban: our campaign stages are advanced automatically by the agent
 * workflow (read-only for the operator), so a draggable board would imply an
 * interaction that doesn't (and shouldn't) exist. Instead this groups campaigns
 * under vertical stage sections — same scannable rows as the list view, no
 * horizontal scroll, no drag affordance. C2 tokens; per-stage muted dot.
 */
export interface CampaignItem {
  id: string;
  name: string;
  category: string;
  status: string;
  stage: string;
  creatorIds: string[];
  trackCount: number;
  pending: number;
  createdAt?: Date | string | number;
  updatedAt?: Date | string | number;
}

const STAGE_DOT: Record<string, string> = {
  overview: "#8a8275",
  sourcing: "#5a7d8c",
  outreach: "#8a6c2e",
  shipping: "#7a5c46",
  content_review: "#7d6a9c",
  performance: "#3f6b4a",
};
export function stageDot(stage: string): string {
  return STAGE_DOT[stage] ?? "#8a8275";
}

/** Inline pastel stage chip — used in the flat list view rows. */
export function StageBadge({ stage }: { stage: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[11.5px] text-ink-2">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: stageDot(stage) }} aria-hidden />
      {stageKo(stage)}
    </span>
  );
}

function fmtStart(d: CampaignItem["createdAt"]): string {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : `${dt.getMonth() + 1}월 ${dt.getDate()}일 시작`;
}

function FaceStack({ item, profiles }: { item: CampaignItem; profiles: Map<string, CreatorView> }) {
  if (item.trackCount === 0) return <div className="text-[13px] text-ink-3 mt-0.5">선정 전</div>;
  return (
    <div className="mt-1 flex items-center">
      <div className="flex">
        {item.creatorIds.slice(0, 3).map((cid) => {
          const p = profiles.get(cid);
          return <Avatar key={cid} name={p?.nickname ?? p?.handle ?? cid} src={p?.avatar} size="sm" className="-ml-2 first:ml-0 ring-2 ring-surface" />;
        })}
      </div>
      {item.trackCount > 3 && <span className="ml-1.5 text-[12px] text-ink-3 mono">+{item.trackCount - 3}</span>}
    </div>
  );
}

/** One campaign row — shared by the flat list (showStage) and the by-stage view. */
export function CampaignRow({ item, profiles, showStage }: { item: CampaignItem; profiles: Map<string, CreatorView>; showStage: boolean }) {
  const st = campaignStatus(item.status);
  return (
    <Link
      href={`/campaigns/${item.id}`}
      className={cn(
        "grid gap-4 items-center bg-surface border border-line rounded-2xl shadow-soft px-5 py-4 transition-transform hover:-translate-y-0.5",
        showStage ? "grid-cols-[1.7fr_120px_1fr_100px_88px]" : "grid-cols-[1.7fr_120px_100px_88px]",
      )}
    >
      <div className="min-w-0">
        <div className="text-[15px] font-bold text-ink truncate">{item.name}</div>
        <div className="text-[12px] text-ink-3 mt-0.5 truncate">
          {item.category}{item.createdAt ? ` · ${fmtStart(item.createdAt)}` : ""}
        </div>
      </div>
      <div>
        <StatusTag tone={st.tone}>{st.label}</StatusTag>
      </div>
      {showStage && (
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.05em] text-ink-3 mb-1">단계</div>
          <div className="flex items-center gap-1.5">
            <StageBadge stage={item.stage} />
            {item.pending > 0 && <span className="text-[11.5px] text-warn font-semibold">· {item.pending}건</span>}
          </div>
        </div>
      )}
      <div>
        <div className="text-[10.5px] uppercase tracking-[0.05em] text-ink-3">크리에이터</div>
        <FaceStack item={item} profiles={profiles} />
      </div>
      <div className="text-right">
        <div className="text-[10.5px] uppercase tracking-[0.05em] text-ink-3">활동</div>
        <div className="text-[13px] text-ink-2 mt-0.5 mono">{item.updatedAt ? fmtAgo(item.updatedAt instanceof Date ? item.updatedAt : new Date(item.updatedAt)) : "—"}</div>
      </div>
    </Link>
  );
}

export function CampaignByStage({ items, profiles }: { items: CampaignItem[]; profiles: Map<string, CreatorView> }) {
  const byStage = new Map<string, CampaignItem[]>();
  for (const it of items) {
    const key = STAGE_ORDER.includes(it.stage as never) ? it.stage : "overview";
    (byStage.get(key) ?? byStage.set(key, []).get(key)!).push(it);
  }
  // Only stages that actually have campaigns, in lifecycle order.
  const stages = STAGE_ORDER.filter((s) => (byStage.get(s)?.length ?? 0) > 0);

  return (
    <div className="flex flex-col gap-7">
      {stages.map((stage) => {
        const group = byStage.get(stage)!;
        const pending = group.reduce((n, it) => n + it.pending, 0);
        return (
          <section key={stage}>
            <div className="flex items-center gap-2 mb-2.5 px-1">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: stageDot(stage) }} aria-hidden />
              <h2 className="text-[13.5px] font-bold text-ink">{stageKo(stage)}</h2>
              <span className="text-[12px] text-ink-3 tabular-nums">{group.length}</span>
              {pending > 0 && <span className="text-[11.5px] text-warn font-semibold">· {pending}건 대기</span>}
            </div>
            <div className="flex flex-col gap-2.5">
              {group.map((it) => (
                <CampaignRow key={it.id} item={it} profiles={profiles} showStage={false} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
