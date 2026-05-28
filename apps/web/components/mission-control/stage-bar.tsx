import { cn } from "@/lib/cn";
import type { CampaignStage } from "@ss/contracts";

/**
 * 6-stage read-only progress strip. Done = emerald; current = blue with thin
 * ring; pending = slate-light. Names mirror the brand-campaign workflow's
 * stage enum. The shape is *informational* — there are no clickable transitions
 * here, the workflow advances stages itself.
 */

const ORDER: CampaignStage[] = ["overview", "sourcing", "outreach", "shipping", "content_review", "performance"];

// A10 (P1 Sub-1.4) — D34 i18n: stage labels were placeholders mirroring the
// machine enum. The brand-campaign workflow's Korean operator surface should
// show Korean labels per D34's 4-locale spread (the demo uses ko-KR).
const LABEL_KO: Record<CampaignStage, string> = {
  overview: "개요",
  sourcing: "소싱",
  outreach: "아웃리치",
  shipping: "배송",
  content_review: "콘텐츠 검수",
  performance: "성과",
};

export function StageBar({ current, notes }: { current: CampaignStage; notes?: Partial<Record<CampaignStage, string>> }) {
  const idx = ORDER.indexOf(current);
  return (
    <div className="grid grid-cols-6 gap-1">
      {ORDER.map((s, i) => {
        const status: "done" | "current" | "pending" = i < idx ? "done" : i === idx ? "current" : "pending";
        return (
          <div
            key={s}
            className={cn(
              "px-3 py-2.5 rounded-md border text-left",
              status === "done" && "bg-emerald-50/40 border-emerald-200 text-emerald-800",
              status === "current" && "bg-blue-50/40 border-blue-300 text-blue-800 ring-2 ring-blue-100",
              status === "pending" && "bg-slate-50 border-slate-200 text-slate-500",
            )}
          >
            <div className="text-[10px] uppercase tracking-wider opacity-70">{i + 1}</div>
            <div className="text-[12px] font-medium mono">{LABEL_KO[s]}</div>
            {(notes?.[s] ?? null) && <div className="mt-0.5 text-[10px] opacity-80">{notes?.[s]}</div>}
            {!notes?.[s] && status === "done" && <div className="mt-0.5 text-[10px] opacity-70">✓</div>}
            {!notes?.[s] && status === "current" && <div className="mt-0.5 text-[10px] opacity-80">● 진행 중</div>}
          </div>
        );
      })}
    </div>
  );
}
