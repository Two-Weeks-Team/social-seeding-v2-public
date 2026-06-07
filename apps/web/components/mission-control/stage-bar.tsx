import { cn } from "@/lib/cn";
import type { CampaignStage } from "@ss/contracts";

/**
 * 6-stage progress stepper — C2 (circular bubbles + connecting rail). Read-only;
 * the workflow advances stages itself.
 *
 * `complete` is the SINGLE source of truth fix for the audit's status
 * contradiction: when the campaign is completed, every step renders done — we
 * never show an in-progress state on a stage of a finished campaign.
 */

const ORDER: CampaignStage[] = ["overview", "sourcing", "outreach", "shipping", "content_review", "performance"];

const LABEL_KO: Record<CampaignStage, string> = {
  overview: "Overview",
  sourcing: "Sourcing",
  outreach: "Outreach",
  shipping: "Shipping",
  content_review: "Content review",
  performance: "Performance",
};

export function StageBar({
  current,
  complete = false,
  stopped = false,
  notes,
}: {
  current: CampaignStage;
  complete?: boolean;
  stopped?: boolean;
  notes?: Partial<Record<CampaignStage, string>>;
}) {
  const idx = ORDER.indexOf(current);
  return (
    <div className="flex items-start">
      {ORDER.map((s, i) => {
        const status: "done" | "current" | "pending" =
          complete || i < idx ? "done" : i === idx ? "current" : "pending";
        const isLast = i === ORDER.length - 1;
        const railDone = complete || i < idx;
        return (
          <div key={s} className="flex-1 text-center relative">
            {/* connecting rail to the next step */}
            {!isLast && (
              <span
                aria-hidden
                className={cn(
                  "absolute top-[17px] left-1/2 w-full h-[2px]",
                  railDone ? "bg-brand" : "bg-line",
                )}
              />
            )}
            <span
              className={cn(
                "relative z-10 mx-auto grid place-items-center w-[34px] h-[34px] rounded-full text-[13px] font-bold mono border-2",
                status === "done" && "bg-brand border-brand text-white",
                status === "current" && !stopped && "bg-surface border-run text-run ring-4 ring-run/15",
                status === "current" && stopped && "bg-surface border-stop text-stop",
                status === "pending" && "bg-surface border-line text-ink-3",
              )}
            >
              {status === "done" ? "✓" : i + 1}
            </span>
            <div
              className={cn(
                "mt-2 text-[12.5px]",
                status === "pending" ? "text-ink-3" : "text-ink font-semibold",
              )}
            >
              {LABEL_KO[s]}
            </div>
            {notes?.[s] && <div className="mt-0.5 text-[11px] text-ink-3">{notes[s]}</div>}
          </div>
        );
      })}
    </div>
  );
}
