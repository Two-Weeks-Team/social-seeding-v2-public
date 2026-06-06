import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { StatusTag } from "@/components/ui/status-tag";
import { campaignStatus, stageKo, STAGE_ORDER } from "@/lib/labels";
import type { CreatorView } from "@/lib/creators";

/**
 * Campaign pipeline (kanban) — research-grounded (Refero: Rox "Revenue Agents"
 * opportunities kanban — soft column panels, white cards, pastel stage accents).
 * Columns = the 6 campaign stages; cards = campaigns sitting at that stage. C2
 * tokens; each stage carries a muted, palette-harmonious dot (not new bg tokens).
 */
export interface PipelineItem {
  id: string;
  name: string;
  category: string;
  status: string;
  stage: string;
  creatorIds: string[];
  trackCount: number;
  pending: number;
}

/** Muted, C2-harmonious per-stage dot colors (echoes the Avatar palette). */
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

/** Inline pastel stage chip — used in the list view rows. */
export function StageBadge({ stage }: { stage: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[11.5px] text-ink-2">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: stageDot(stage) }} aria-hidden />
      {stageKo(stage)}
    </span>
  );
}

function FaceStack({ creatorIds, trackCount, profiles }: { creatorIds: string[]; trackCount: number; profiles: Map<string, CreatorView> }) {
  if (trackCount === 0) return <span className="text-[11.5px] text-ink-3">선정 전</span>;
  return (
    <div className="flex items-center">
      <div className="flex">
        {creatorIds.slice(0, 3).map((cid) => {
          const p = profiles.get(cid);
          return <Avatar key={cid} name={p?.nickname ?? p?.handle ?? cid} src={p?.avatar} size="sm" className="-ml-2 first:ml-0 ring-2 ring-surface" />;
        })}
      </div>
      {trackCount > 3 && <span className="ml-1.5 text-[11.5px] text-ink-3 mono">+{trackCount - 3}</span>}
    </div>
  );
}

export function CampaignPipeline({ items, profiles }: { items: PipelineItem[]; profiles: Map<string, CreatorView> }) {
  const byStage = new Map<string, PipelineItem[]>();
  for (const s of STAGE_ORDER) byStage.set(s, []);
  for (const it of items) {
    const key = byStage.has(it.stage) ? it.stage : "overview";
    byStage.get(key)!.push(it);
  }

  return (
    <div className="flex gap-3.5 overflow-x-auto pb-2">
      {STAGE_ORDER.map((stage) => {
        const col = byStage.get(stage) ?? [];
        return (
          <div key={stage} className="w-[230px] shrink-0">
            <div className="flex items-center gap-2 px-1.5 pb-2">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: stageDot(stage) }} aria-hidden />
              <span className="text-[12.5px] font-semibold text-ink">{stageKo(stage)}</span>
              <span className="text-[11.5px] text-ink-3 tabular-nums">{col.length}</span>
            </div>
            <div className="rounded-2xl bg-surface-2/60 border border-line p-2 min-h-[88px] flex flex-col gap-2">
              {col.length === 0 ? (
                <div className="grid place-items-center py-6 text-[11.5px] text-ink-3">—</div>
              ) : (
                col.map((it) => {
                  const st = campaignStatus(it.status);
                  return (
                    <Link
                      key={it.id}
                      href={`/campaigns/${it.id}`}
                      className="block bg-surface border border-line rounded-xl shadow-soft px-3.5 py-3 hover:-translate-y-0.5 transition-transform"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-[13px] font-bold text-ink truncate">{it.name}</div>
                        <StatusTag tone={st.tone} size="sm">{st.label}</StatusTag>
                      </div>
                      <div className="text-[11px] text-ink-3 mt-0.5 truncate">{it.category}</div>
                      <div className="mt-2.5 flex items-center justify-between">
                        <FaceStack creatorIds={it.creatorIds} trackCount={it.trackCount} profiles={profiles} />
                        {it.pending > 0 && <span className="text-[11px] text-warn font-semibold shrink-0">{it.pending}건 대기</span>}
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
