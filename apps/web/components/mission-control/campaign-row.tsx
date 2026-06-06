import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { StatusTag } from "@/components/ui/status-tag";
import { campaignStatus, stageKo, STAGE_ORDER } from "@/lib/labels";
import { fmtAgo } from "@/lib/format";
import type { CreatorView } from "@/lib/creators";
import { cn } from "@/lib/cn";

/**
 * Campaign row for the operator home list. Each row carries a compact, read-only
 * stage-progress stepper (B안) — campaign stages are advanced by the agent
 * workflow, so this shows "어디까지 왔나" inline without implying a draggable board.
 * C2 tokens; the current stage gets a muted, palette-harmonious accent.
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
function stageDot(stage: string): string {
  return STAGE_DOT[stage] ?? "#8a8275";
}

/** Compact read-only stepper: done segments filled, current accented, rest faint. */
export function StageProgress({ stage }: { stage: string }) {
  const idx = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
  const cur = idx < 0 ? 0 : idx;
  return (
    <div>
      <div className="flex items-center gap-1" role="img" aria-label={`단계 ${cur + 1}/${STAGE_ORDER.length}: ${stageKo(stage)}`}>
        {STAGE_ORDER.map((s, i) => (
          <span
            key={s}
            className={cn("h-1.5 rounded-full", i === cur ? "w-4" : "w-2.5", i < cur ? "bg-ink-3" : i > cur ? "bg-surface-2" : "")}
            style={i === cur ? { background: stageDot(s) } : undefined}
            aria-hidden
          />
        ))}
      </div>
      <div className="mt-1 text-[12px] text-ink-2">
        <span className="text-[10.5px] text-ink-3 mono">{cur + 1}/{STAGE_ORDER.length}</span> {stageKo(stage)}
      </div>
    </div>
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

export function CampaignRow({ item, profiles }: { item: CampaignItem; profiles: Map<string, CreatorView> }) {
  const st = campaignStatus(item.status);
  return (
    <Link
      href={`/campaigns/${item.id}`}
      className="grid grid-cols-[1.7fr_120px_1.2fr_100px_88px] gap-4 items-center bg-surface border border-line rounded-2xl shadow-soft px-5 py-4 transition-transform hover:-translate-y-0.5"
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
      <div>
        <div className="text-[10.5px] uppercase tracking-[0.05em] text-ink-3 mb-1.5">단계</div>
        <StageProgress stage={item.stage} />
        {item.pending > 0 && <div className="text-[11px] text-warn font-semibold mt-1">{item.pending}건 대기</div>}
      </div>
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
