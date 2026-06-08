import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import type { SessionClaims } from "@/lib/auth";
import { cn } from "@/lib/cn";

/**
 * Mission Control left nav — C2. Ivory surface · hairline border. Active route is
 * an espresso fill (the brand), not a default-blue pill. "Coming" items show the
 * eventual shape without leaking internal roadmap codes (no "Phase 2"/"P5+").
 * The footer shows the operator's identity WITHOUT the raw Google user id.
 */

interface NavItem {
  href: string;
  label: string;
  soon?: boolean;
}

const PRIMARY: NavItem[] = [
  { href: "/campaigns", label: "Campaigns" },
  { href: "/leads", label: "Leads (B2B)" },
  { href: "/approvals", label: "Approvals" },
  { href: "/threads", label: "Email threads" },
  { href: "/policies", label: "Autonomy policy" },
  { href: "/usage", label: "Usage & cost" },
  { href: "/settings", label: "Gmail connection" },
];

const SECONDARY: NavItem[] = [
  { href: "#", label: "Creator library", soon: true },
];

export function Sidebar({
  session,
  active,
  pendingApprovals = 0,
  monthlySpendUsd = 0,
  monthlyBudgetUsd = 200,
  workspaceName,
}: {
  session: SessionClaims;
  active: string;
  pendingApprovals?: number;
  monthlySpendUsd?: number;
  monthlyBudgetUsd?: number;
  workspaceName?: string;
}) {
  const budget = monthlyBudgetUsd > 0 ? monthlyBudgetUsd : 1;
  const spendPct = Math.max(0, Math.min(100, Math.round((monthlySpendUsd / budget) * 100)));
  const wsLabel = workspaceName ?? session.workspaceId;
  return (
    <aside className="w-60 bg-surface border-r border-line flex flex-col shrink-0">
      {/* Brand */}
      <div className="px-4 py-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-[10px] bg-gradient-to-br from-brand to-brand-2 text-white grid place-items-center text-[12px] font-extrabold shadow-brand">SS</div>
          <div className="leading-tight">
            <div className="text-[14px] font-bold text-ink">Social Seeding</div>
            <div className="text-[10.5px] text-ink-3">Mission Control</div>
          </div>
        </div>
        <button className="mt-3.5 w-full flex items-center justify-between text-[12.5px] text-ink-2 border border-line rounded-[11px] px-3 py-2 hover:bg-surface-2 transition-colors">
          <span className="truncate">{wsLabel}</span>
          <span className="text-ink-3" aria-hidden>⌄</span>
        </button>
      </div>

      {/* Primary nav */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-2 text-[13.5px]">
        {PRIMARY.map((item) => {
          const isActive = active === item.href || (active.startsWith(item.href) && item.href !== "/");
          const showBadge = item.href === "/approvals" && pendingApprovals > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "w-full px-3 py-2 rounded-[11px] flex items-center gap-2.5 mb-0.5 transition-colors",
                isActive ? "bg-brand text-white font-semibold shadow-brand" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
              )}
            >
              <span>{item.label}</span>
              {showBadge && (
                <span
                  className={cn(
                    "ml-auto text-[11px] font-bold rounded-full px-2 py-0.5",
                    isActive ? "bg-white text-brand" : "bg-warn-bg text-warn",
                  )}
                >
                  {pendingApprovals}
                </span>
              )}
            </Link>
          );
        })}

        <div className="pt-4 pb-1.5 px-3 text-[10.5px] uppercase tracking-[0.08em] text-ink-3">More</div>
        {SECONDARY.map((item) => (
          <div key={item.label} className="w-full px-3 py-2 rounded-[11px] flex items-center gap-2.5 text-ink-3 cursor-default" aria-disabled>
            <span>{item.label}</span>
            {item.soon && <span className="ml-auto text-[10px] text-brand-ink bg-brand-soft rounded-full px-2 py-0.5 font-semibold">Soon</span>}
          </div>
        ))}
      </nav>

      {/* Footer — budget meter + user */}
      <div className="border-t border-line px-4 py-3.5 text-[11.5px] text-ink-2">
        <div className="flex items-center justify-between mb-1.5">
          <span>Monthly budget</span>
          <span className="mono text-ink">${monthlySpendUsd.toFixed(2)} / ${monthlyBudgetUsd}</span>
        </div>
        <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
          <div
            className={cn("h-full rounded-full", spendPct < 60 ? "bg-ok" : spendPct < 90 ? "bg-warn" : "bg-stop")}
            style={{ width: `${Math.max(spendPct, 2)}%` }}
          />
        </div>
        <div className="mt-3.5 flex items-center gap-2.5">
          <Avatar name={session.email} size="md" />
          <div className="leading-tight min-w-0">
            <div className="text-[12px] font-semibold text-ink truncate">{session.email}</div>
            <div className="text-[10.5px] text-ink-3 truncate">{wsLabel}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
