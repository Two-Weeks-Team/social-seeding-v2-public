import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Agent status strip — research-grounded (Refero: Rox "Revenue Agents" status
 * rows / activity). A calm cockpit line showing what the fleet is doing right
 * now, computed from real data. Each stat is a dot + number + label; the two
 * "needs me" stats (awaiting reply / pending approval) are warn-toned and link to their surface.
 */
interface Stat {
  label: string;
  value: number;
  tone: "run" | "warn" | "ok" | "neutral";
  href?: string;
  pulse?: boolean;
}

const DOT: Record<Stat["tone"], string> = {
  run: "bg-ok",
  warn: "bg-warn",
  ok: "bg-ok",
  neutral: "bg-ink-3",
};

export function AgentStatusStrip({
  running,
  awaitingReply,
  pendingApprovals,
  completed,
}: {
  running: number;
  awaitingReply: number;
  pendingApprovals: number;
  completed: number;
}) {
  const stats: Stat[] = [
    { label: "Running", value: running, tone: "run", pulse: running > 0 },
    { label: "Awaiting reply", value: awaitingReply, tone: awaitingReply > 0 ? "warn" : "neutral", href: "/threads?tab=needs-reply" },
    { label: "Pending approval", value: pendingApprovals, tone: pendingApprovals > 0 ? "warn" : "neutral", href: "/approvals" },
    { label: "Complete", value: completed, tone: "neutral" },
  ];

  return (
    <div className="mb-5 bg-surface border border-line rounded-2xl shadow-soft px-5 py-3.5">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ok opacity-60" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-ok" />
        </span>
        <span className="text-[11px] uppercase tracking-[0.08em] text-ink-3">Agent status</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-7 gap-y-2.5">
        {stats.map((s) => {
          const body = (
            <span className="flex items-center gap-2">
              <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", DOT[s.tone], s.pulse && "animate-pulse")} aria-hidden />
              <span className="text-[19px] font-bold text-ink tabular-nums leading-none">{s.value}</span>
              <span className={cn("text-[12.5px]", s.tone === "warn" && s.value > 0 ? "text-warn font-medium" : "text-ink-2")}>{s.label}</span>
            </span>
          );
          return s.href ? (
            <Link key={s.label} href={s.href} className="hover:opacity-80 transition-opacity">{body}</Link>
          ) : (
            <span key={s.label}>{body}</span>
          );
        })}
      </div>
    </div>
  );
}
