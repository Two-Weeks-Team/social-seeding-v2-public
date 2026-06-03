import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { agentKo } from "@/lib/labels";
import { fmtNum } from "@/lib/format";
import { getServerSession } from "@/lib/auth";
import { Collections, getDb, campaignRepo, workspaceRepo } from "@ss/db";

/**
 * /usage — C2 cost dashboard. Per-workspace operator view of agent spend.
 *
 * Three blocks:
 *   1. KPI strip — month-to-date spend vs budget, last-30-days trend,
 *      active campaigns, and the model carrying most of the budget.
 *   2. Per-agent breakdown — which role (소싱 / 작성 / 검증 …) is consuming
 *      the budget, with its model tier, so the operator can decide where to
 *      economize.
 *   3. Per-campaign breakdown — every campaign + verified count +
 *      cost-per-verified-post, the concrete "is this efficient?" column.
 *
 * Presentation only; all data reads are workspace-filtered + server-side.
 */

interface AgentRow {
  agent: string;
  model: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  spentUsd: number;
}

interface ModelRow {
  model: string;
  spentUsd: number;
  callCount: number;
}

interface CampaignRow {
  campaignId: string;
  name: string;
  category: string;
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
  model: string;
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
  byModel: ModelRow[];
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
  const modelMap = new Map<string, ModelRow>();
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
      agent: e.agent, model: e.model, callCount: 0, inputTokens: 0, outputTokens: 0, spentUsd: 0,
    };
    a.callCount++;
    a.inputTokens += e.inputTokens;
    a.outputTokens += e.outputTokens;
    a.spentUsd += e.usd;
    a.model = e.model; // last-seen model for this agent (agents are pinned to one)
    agentMap.set(e.agent, a);
    const m = modelMap.get(e.model) ?? { model: e.model, spentUsd: 0, callCount: 0 };
    m.spentUsd += e.usd;
    m.callCount++;
    modelMap.set(e.model, m);
    campaignSpent.set(e.campaignId, (campaignSpent.get(e.campaignId) ?? 0) + e.usd);
  }

  const byAgent = [...agentMap.values()].sort((a, b) => b.spentUsd - a.spentUsd);
  const byModel = [...modelMap.values()].sort((a, b) => b.spentUsd - a.spentUsd);

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
        category: c.brief.brandProduct.category,
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
    byModel,
    byCampaign,
    monthlyBudgetUsd: policy.budgets.maxUsdPerWorkspaceMonthly,
  };
}

/** Spend-against-budget ratio → status tone (color + text, never color alone). */
function budgetTone(pct: number): StatusTone {
  if (pct < 0.5) return "ok";
  if (pct < 0.85) return "warn";
  return "stop";
}

/** "gemini-3.5-flash" → "Gemini 3.5 Flash" — operator-readable model name. */
function modelLabel(model: string): string {
  const m = model.replace(/^gemini-/i, "");
  return m
    .split("-")
    .map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ")
    .replace(/^/, "Gemini ");
}

/** Model tier → status tone for the per-agent table chip. */
function modelTone(model: string): StatusTone {
  return /lite/i.test(model) ? "neutral" : "run";
}

export default async function UsagePage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const data = await loadCostRollup(session.workspaceId);
  const budgetPct = data.monthlyBudgetUsd > 0 ? data.spentMtd / data.monthlyBudgetUsd : 0;
  const topModel = data.byModel[0] ?? null;
  const topAgent = data.byAgent[0] ?? null;
  const activeCampaigns = data.byCampaign.filter((c) => c.spentUsd > 0).length;

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-6">
        <h1 className="text-[24px] font-bold tracking-[-0.01em]">사용량 · 비용</h1>
        <p className="mt-1 text-[13.5px] text-ink-2">
          에이전트가 이번 달 쓴 예산을 역할별·캠페인별로 보여줍니다. 어디서 비용이 나가는지 한눈에 확인하세요.
        </p>
      </header>

      {/* ── KPI strip ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-6">
        <Stat
          label="이번 달 사용"
          value={`$${data.spentMtd.toFixed(2)}`}
          hint={
            data.monthlyBudgetUsd > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                예산 ${fmtNum(data.monthlyBudgetUsd)} 대비
                <StatusTag tone={budgetTone(budgetPct)} size="sm">{Math.round(budgetPct * 100)}%</StatusTag>
              </span>
            ) : (
              "예산 미설정"
            )
          }
          tone={data.spentMtd > 0 ? (budgetPct >= 0.85 ? "stop" : "brand") : "muted"}
        />
        <Stat
          label="최근 30일"
          value={`$${data.spent30d.toFixed(2)}`}
          hint={`에이전트 호출 ${fmtNum(data.callCount30d)}회`}
          tone={data.spent30d > 0 ? "default" : "muted"}
        />
        <Stat
          label="활성 캠페인"
          value={activeCampaigns}
          hint="최근 30일 비용 발생"
          tone={activeCampaigns > 0 ? "default" : "muted"}
        />
        <Stat
          label="주력 모델"
          value={<span className="text-[18px]">{topModel ? modelLabel(topModel.model) : "—"}</span>}
          hint={
            topModel
              ? `$${topModel.spentUsd.toFixed(2)} · 호출 ${fmtNum(topModel.callCount)}회`
              : "아직 사용 기록 없음"
          }
          tone={topModel ? "brand" : "muted"}
        />
      </div>

      {/* ── per-agent breakdown ───────────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>역할별 비용</CardTitle>
          <span className="text-[11px] text-ink-3">
            최근 30일{topAgent ? ` · 1위 ${agentKo(topAgent.agent)}` : ""}
          </span>
        </CardHeader>
        <CardBody className="pt-1">
          {data.byAgent.length === 0 ? (
            <EmptyState
              icon="◷"
              title="아직 에이전트 비용 기록이 없습니다."
              hint="캠페인이 돌기 시작하면 역할별 사용량이 여기 쌓입니다."
            />
          ) : (
            <table className="w-full text-[13px]">
              <thead className="text-[10.5px] uppercase tracking-[0.05em] text-ink-3 border-b border-line">
                <tr>
                  <th className="text-left px-2 py-2.5 font-semibold">에이전트</th>
                  <th className="text-left px-2 py-2.5 font-semibold">모델</th>
                  <th className="text-right px-2 py-2.5 font-semibold">호출</th>
                  <th className="text-right px-2 py-2.5 font-semibold">입력 토큰</th>
                  <th className="text-right px-2 py-2.5 font-semibold">출력 토큰</th>
                  <th className="text-right px-2 py-2.5 font-semibold">집행</th>
                  <th className="text-right px-2 py-2.5 font-semibold">호출당</th>
                </tr>
              </thead>
              <tbody>
                {data.byAgent.map((a) => (
                  <tr key={a.agent} className="border-b border-line-2 last:border-0">
                    <td className="px-2 py-2.5 font-medium text-ink">{agentKo(a.agent)}</td>
                    <td className="px-2 py-2.5">
                      <StatusTag tone={modelTone(a.model)} size="sm">{modelLabel(a.model)}</StatusTag>
                    </td>
                    <td className="px-2 py-2.5 mono text-right text-ink-2">{fmtNum(a.callCount)}</td>
                    <td className="px-2 py-2.5 mono text-right text-ink-3">{fmtNum(a.inputTokens)}</td>
                    <td className="px-2 py-2.5 mono text-right text-ink-3">{fmtNum(a.outputTokens)}</td>
                    <td className="px-2 py-2.5 mono text-right font-bold text-ink">${a.spentUsd.toFixed(2)}</td>
                    <td className="px-2 py-2.5 mono text-right text-ink-3">
                      ${(a.spentUsd / Math.max(1, a.callCount)).toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      {/* ── per-campaign breakdown ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>캠페인별 효율</CardTitle>
          <span className="text-[11px] text-ink-3">검증 게시물당 비용</span>
        </CardHeader>
        <CardBody className="pt-1">
          {data.byCampaign.length === 0 ? (
            <EmptyState
              icon="◎"
              title="아직 캠페인이 없습니다."
              hint="브리프를 채우면 에이전트가 소싱부터 시작하고, 비용이 캠페인별로 집계됩니다."
            />
          ) : (
            <table className="w-full text-[13px]">
              <thead className="text-[10.5px] uppercase tracking-[0.05em] text-ink-3 border-b border-line">
                <tr>
                  <th className="text-left px-2 py-2.5 font-semibold">캠페인</th>
                  <th className="text-right px-2 py-2.5 font-semibold">크리에이터</th>
                  <th className="text-right px-2 py-2.5 font-semibold">검증</th>
                  <th className="text-right px-2 py-2.5 font-semibold">집행</th>
                  <th className="text-right px-2 py-2.5 font-semibold">검증당</th>
                  <th className="text-right px-2 py-2.5 font-semibold">예산 대비</th>
                </tr>
              </thead>
              <tbody>
                {data.byCampaign.map((c) => {
                  const budgetPctC = c.budgetUsd && c.budgetUsd > 0 ? c.spentUsd / c.budgetUsd : null;
                  return (
                    <tr key={c.campaignId} className="border-b border-line-2 last:border-0">
                      <td className="px-2 py-2.5">
                        <Link
                          href={`/campaigns/${c.campaignId}`}
                          className="flex items-center gap-2.5 min-w-0 group"
                        >
                          <Avatar name={c.name} size="sm" />
                          <span className="min-w-0">
                            <span className="block text-[13px] font-medium text-ink truncate group-hover:underline underline-offset-2">
                              {c.name}
                            </span>
                            <span className="block text-[11px] text-ink-3 truncate">
                              {c.category} · 크리에이터 {c.trackCount}명
                            </span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-2 py-2.5 mono text-right text-ink-3">{c.trackCount}</td>
                      <td className="px-2 py-2.5 mono text-right">
                        <span className={c.verifiedCount > 0 ? "text-ok font-semibold" : "text-ink-3"}>
                          {c.verifiedCount}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 mono text-right font-bold text-ink">${c.spentUsd.toFixed(2)}</td>
                      <td className="px-2 py-2.5 mono text-right">
                        {c.costPerVerifiedPost !== null ? (
                          `$${c.costPerVerifiedPost.toFixed(2)}`
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        {budgetPctC !== null ? (
                          <StatusTag tone={budgetTone(budgetPctC)} size="sm">
                            {Math.round(budgetPctC * 100)}%
                          </StatusTag>
                        ) : (
                          <span className="text-[12px] text-ink-3">예산 미설정</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
