import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getServerSession } from "@/lib/auth";
import { Collections, getDb, campaignRepo, workspaceRepo } from "@ss/db";

/**
 * /usage — Phase 4 P4-C6 cost dashboard. Port of v1 /admin/usage-dashboard
 * + token monitor reframed as a per-workspace operator view.
 *
 * Three blocks:
 *   1. Top stat strip — month-to-date spend, budget %, last-30-days
 *      trend (count + total), pending threshold alerts.
 *   2. Per-agent breakdown — which agent (sourcing / writer / conversation
 *      / analyst …) is consuming the budget. Helps the operator decide
 *      whether to swap to Haiku for one of them.
 *   3. Per-campaign breakdown — every campaign + verified-count +
 *      cost-per-verified-post. The cost-per-verified-post column makes
 *      the "is this efficient?" decision concrete.
 *
 * Reads: v2_cost_ledger (workspace-filtered) + v2_campaigns
 * (for the verified-count denominator). All scope=read, all server-side.
 */

interface AgentRow {
  agent: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  spentUsd: number;
}

interface CampaignRow {
  campaignId: string;
  name: string;
  spentUsd: number;
  verifiedCount: number;
  costPerVerifiedPost: number | null;
  trackCount: number;
  budgetUsd: number | null;
}

interface CostEntry {
  campaignId: string;
  workspaceId: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  at: Date | number;
}

async function loadCostRollup(workspaceId: string): Promise<{
  spentMtd: number;
  spent30d: number;
  callCount30d: number;
  byAgent: AgentRow[];
  byCampaign: CampaignRow[];
  monthlyBudgetUsd: number;
}> {
  const db = await getDb();
  const ledger = db.collection<CostEntry>(Collections.V2_COST_LEDGER);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  // P4 codex review P2#4: on the 31st of a month, `thirtyDaysAgo` is
  // already deep into day 2 of the current month — using only that
  // window for MTD drops day-1 spend. Fetch from `min(monthStart,
  // thirtyDaysAgo)` so both windows are honest, then partition in JS.
  const lookbackStart = monthStart < thirtyDaysAgo ? monthStart : thirtyDaysAgo;

  const docs = await ledger.find({
    workspaceId,
    at: { $gte: lookbackStart },
  }).toArray();

  let spentMtd = 0;
  let spent30d = 0;
  let callCount30d = 0;
  const agentMap = new Map<string, AgentRow>();
  const campaignSpent = new Map<string, number>();

  for (const e of docs) {
    const at = e.at instanceof Date ? e.at : new Date(e.at);
    // 30d window is the rolling-30 view; MTD is "since month-start" —
    // independent slices over the same fetched superset.
    const inThirtyDays = at >= thirtyDaysAgo;
    const inMtd = at >= monthStart;
    if (inThirtyDays) {
      spent30d += e.usd;
      callCount30d++;
    }
    if (inMtd) spentMtd += e.usd;
    // Per-agent + per-campaign rollups follow the 30d window — that's
    // what the operator typically reads ("which agent did I spend on
    // recently?"), and matches the "최근 30일" label on those tables.
    if (!inThirtyDays) continue;
    const a = agentMap.get(e.agent) ?? {
      agent: e.agent, callCount: 0, inputTokens: 0, outputTokens: 0, spentUsd: 0,
    };
    a.callCount++;
    a.inputTokens += e.inputTokens;
    a.outputTokens += e.outputTokens;
    a.spentUsd += e.usd;
    agentMap.set(e.agent, a);
    campaignSpent.set(e.campaignId, (campaignSpent.get(e.campaignId) ?? 0) + e.usd);
  }

  const byAgent = [...agentMap.values()].sort((a, b) => b.spentUsd - a.spentUsd);

  // Resolve campaign names + verified counts. Pull all campaigns this
  // workspace owns once; the ledger has the spend.
  const campaigns = await campaignRepo.listByWorkspace(workspaceId);
  const byCampaign: CampaignRow[] = campaigns
    .map((c) => {
      const verified = c.tracks.filter((t) => t.state === "verified").length;
      const spent = campaignSpent.get(c.id) ?? 0;
      return {
        campaignId: c.id,
        name: c.brief.brandProduct.name,
        spentUsd: spent,
        verifiedCount: verified,
        costPerVerifiedPost: verified > 0 ? spent / verified : null,
        trackCount: c.tracks.length,
        budgetUsd: c.brief.goals.budgetUsd ?? null,
      };
    })
    .sort((a, b) => b.spentUsd - a.spentUsd);

  // Monthly budget from policy.
  const policy = await workspaceRepo.getPolicy(workspaceId);

  return {
    spentMtd,
    spent30d,
    callCount30d,
    byAgent,
    byCampaign,
    monthlyBudgetUsd: policy.budgets.maxUsdPerWorkspaceMonthly,
  };
}

function moneyVariant(pct: number): "emerald" | "amber" | "rose" {
  if (pct < 0.5) return "emerald";
  if (pct < 0.85) return "amber";
  return "rose";
}

export default async function UsagePage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const data = await loadCostRollup(session.workspaceId);
  const budgetPct = data.monthlyBudgetUsd > 0 ? data.spentMtd / data.monthlyBudgetUsd : 0;

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-6">
        <SectionLabel>USAGE</SectionLabel>
        <h1 className="mt-1 text-[22px] font-semibold">사용량 + 비용</h1>
        <div className="mt-1 text-[12px] text-slate-500">
          v2_cost_ledger 기반 · 워크스페이스 <span className="mono">{session.workspaceId}</span>
        </div>
      </header>

      {/* ── top stat strip ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
        <Card><CardBody>
          <SectionLabel>이번 달 사용</SectionLabel>
          <div className="mt-1 text-[22px] font-semibold mono">${data.spentMtd.toFixed(2)}</div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            예산 <span className="mono">${data.monthlyBudgetUsd}</span> 대비{" "}
            <Badge variant={moneyVariant(budgetPct)}>{Math.round(budgetPct * 100)}%</Badge>
          </div>
        </CardBody></Card>
        <Card><CardBody>
          <SectionLabel>최근 30일</SectionLabel>
          <div className="mt-1 text-[22px] font-semibold mono">${data.spent30d.toFixed(2)}</div>
          <div className="mt-0.5 text-[11px] text-slate-500">{data.callCount30d.toLocaleString()} agent calls</div>
        </CardBody></Card>
        <Card><CardBody>
          <SectionLabel>활성 캠페인</SectionLabel>
          <div className="mt-1 text-[22px] font-semibold mono">
            {data.byCampaign.filter((c) => c.spentUsd > 0).length}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">최근 30일 동안 비용 발생</div>
        </CardBody></Card>
        <Card><CardBody>
          <SectionLabel>주력 모델</SectionLabel>
          <div className="mt-1 text-[16px] font-semibold mono truncate">
            {data.byAgent[0]?.agent ?? "—"}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            {data.byAgent[0] ? `$${data.byAgent[0].spentUsd.toFixed(2)} · ${data.byAgent[0].callCount} calls` : "no usage yet"}
          </div>
        </CardBody></Card>
      </div>

      {/* ── per-agent breakdown ───────────────────────────────────────── */}
      <Card className="mb-6"><CardBody>
        <SectionLabel className="mb-2">에이전트별 비용 (최근 30일)</SectionLabel>
        {data.byAgent.length === 0 ? (
          <div className="text-[13px] text-slate-500 py-6 text-center">
            아직 LLM 호출 기록이 없습니다.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left px-2 py-2 font-medium">agent</th>
                <th className="text-right px-2 py-2 font-medium">calls</th>
                <th className="text-right px-2 py-2 font-medium">input tokens</th>
                <th className="text-right px-2 py-2 font-medium">output tokens</th>
                <th className="text-right px-2 py-2 font-medium">spend</th>
                <th className="text-right px-2 py-2 font-medium">$/call</th>
              </tr>
            </thead>
            <tbody>
              {data.byAgent.map((a) => (
                <tr key={a.agent} className="border-b border-slate-100">
                  <td className="px-2 py-2 mono">{a.agent}</td>
                  <td className="px-2 py-2 mono text-right">{a.callCount.toLocaleString()}</td>
                  <td className="px-2 py-2 mono text-right text-slate-500">{a.inputTokens.toLocaleString()}</td>
                  <td className="px-2 py-2 mono text-right text-slate-500">{a.outputTokens.toLocaleString()}</td>
                  <td className="px-2 py-2 mono text-right font-medium">${a.spentUsd.toFixed(2)}</td>
                  <td className="px-2 py-2 mono text-right text-slate-500">
                    ${(a.spentUsd / Math.max(1, a.callCount)).toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody></Card>

      {/* ── per-campaign breakdown ────────────────────────────────────── */}
      <Card><CardBody>
        <SectionLabel className="mb-2">캠페인별 효율</SectionLabel>
        {data.byCampaign.length === 0 ? (
          <div className="text-[13px] text-slate-500 py-6 text-center">
            아직 캠페인이 없습니다.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left px-2 py-2 font-medium">campaign</th>
                <th className="text-right px-2 py-2 font-medium">tracks</th>
                <th className="text-right px-2 py-2 font-medium">verified</th>
                <th className="text-right px-2 py-2 font-medium">spend</th>
                <th className="text-right px-2 py-2 font-medium">$/verified</th>
                <th className="text-right px-2 py-2 font-medium">budget %</th>
              </tr>
            </thead>
            <tbody>
              {data.byCampaign.map((c) => {
                const budgetPctC = c.budgetUsd && c.budgetUsd > 0 ? c.spentUsd / c.budgetUsd : null;
                return (
                  <tr key={c.campaignId} className="border-b border-slate-100">
                    <td className="px-2 py-2">
                      <Link
                        href={`/campaigns/${c.campaignId}`}
                        className="text-slate-900 hover:underline underline-offset-2"
                      >
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-2 py-2 mono text-right text-slate-500">{c.trackCount}</td>
                    <td className="px-2 py-2 mono text-right">
                      <span className={c.verifiedCount > 0 ? "text-emerald-700 font-medium" : "text-slate-400"}>
                        {c.verifiedCount}
                      </span>
                    </td>
                    <td className="px-2 py-2 mono text-right font-medium">${c.spentUsd.toFixed(2)}</td>
                    <td className="px-2 py-2 mono text-right">
                      {c.costPerVerifiedPost !== null
                        ? `$${c.costPerVerifiedPost.toFixed(2)}`
                        : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-2 py-2 mono text-right">
                      {budgetPctC !== null
                        ? <Badge variant={moneyVariant(budgetPctC)}>{Math.round(budgetPctC * 100)}%</Badge>
                        : <span className="text-slate-400">no budget</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardBody></Card>
    </div>
  );
}
