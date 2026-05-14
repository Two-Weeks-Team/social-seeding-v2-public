import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { SessionClaims } from "@/lib/auth";
import { cn } from "@/lib/cn";

/**
 * Mission Control left nav. Light surface · single-pixel right border. Active
 * route is slate-100 fill + medium weight (no big blue pill — that's an
 * AI-slop pattern). Forward-Phase items are present-but-disabled so the user
 * sees the eventual shape without thinking they're broken.
 */

interface NavItem {
  href: string;
  label: string;
  badge?: { count: number; tone: "amber" | "slate" };
  disabled?: boolean;
  hint?: string; // shown when disabled (e.g. "Phase 2")
}

const PRIMARY: NavItem[] = [
  { href: "/campaigns", label: "캠페인" },
  { href: "/approvals", label: "승인 인박스" },
  { href: "/policies", label: "자율성 정책" },
  { href: "/usage", label: "사용량 + 비용" },
];

const SECONDARY: NavItem[] = [
  { href: "#", label: "크리에이터 라이브러리", disabled: true, hint: "Phase 2" },
  { href: "#", label: "이메일 스레드", disabled: true, hint: "Phase 2" },
  { href: "#", label: "관리자", disabled: true, hint: "P5+" },
];

export function Sidebar({
  session,
  active,
  pendingApprovals = 0,
  monthlySpendUsd = 0,
  monthlyBudgetUsd = 200,
}: {
  session: SessionClaims;
  active: string;
  pendingApprovals?: number;
  monthlySpendUsd?: number;
  monthlyBudgetUsd?: number;
}) {
  const spendPct = Math.max(0, Math.min(100, Math.round((monthlySpendUsd / monthlyBudgetUsd) * 100)));
  return (
    <aside className="w-60 bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
      {/* Brand */}
      <div className="px-4 py-4 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-slate-900 text-white grid place-items-center text-[11px] font-bold">SS</div>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold">Social Seeding</div>
            <div className="text-[10px] text-slate-500">Mission Control</div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between text-[11px] text-slate-600 border border-slate-200 rounded-md px-2 py-1.5">
          <span className="truncate">{session.workspaceId}</span>
          <span className="text-slate-400">⌄</span>
        </div>
      </div>

      {/* Primary nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 text-[13px] space-y-0.5">
        {PRIMARY.map((item) => {
          const isActive = active === item.href || (active.startsWith(item.href) && item.href !== "/");
          const badge = item.label === "승인 인박스" && pendingApprovals > 0
            ? <Badge variant="amber" className="ml-auto !text-[10px] !py-0">{pendingApprovals}</Badge>
            : null;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "w-full text-left px-3 py-1.5 rounded-md flex items-center gap-2 hover:bg-slate-50 transition-colors",
                isActive && "bg-slate-100 text-slate-900 font-medium",
              )}
            >
              <span>{item.label}</span>
              {badge}
            </Link>
          );
        })}

        <div className="pt-3 pb-1 px-3 text-[10px] uppercase tracking-wider text-slate-400">Drill-down</div>
        {SECONDARY.map((item) => (
          <div
            key={item.label}
            className={cn(
              "w-full text-left px-3 py-1.5 rounded-md flex items-center gap-2 text-slate-400 cursor-not-allowed",
            )}
            aria-disabled
          >
            <span>{item.label}</span>
            {item.hint && <span className="ml-auto text-[10px] text-slate-400">{item.hint}</span>}
          </div>
        ))}
      </nav>

      {/* Footer — budget meter + user chip */}
      <div className="border-t border-slate-200 px-3 py-3 text-[11px] text-slate-600">
        <div className="flex items-center justify-between mb-1">
          <span>이번 달 예산</span>
          <span className="mono">${monthlySpendUsd.toFixed(2)} / ${monthlyBudgetUsd}</span>
        </div>
        <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
          <div
            className={cn(
              "h-full",
              spendPct < 60 ? "bg-emerald-500" : spendPct < 90 ? "bg-amber-500" : "bg-rose-500",
            )}
            style={{ width: `${spendPct}%` }}
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-slate-100 grid place-items-center text-[10px] font-semibold mono">
            {(session.email[0] ?? "?").toUpperCase()}
          </div>
          <div className="leading-tight min-w-0">
            <div className="text-[11px] font-medium truncate">{session.email}</div>
            <div className="text-[10px] text-slate-500 mono truncate">{session.userId}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
