import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getServerSession } from "@/lib/auth";
import { campaignRepo, approvalRepo } from "@ss/db";
import type { CampaignStage, CampaignStatusSchema } from "@ss/contracts";
import { type z } from "zod";

/**
 * W2 — Campaigns list. Server component. Reads campaignRepo.listByWorkspace +
 * approvalRepo for pending shortlist hints. The table is dense (matches the
 * mockup) — a single row carries status, stage, track count, budget, and last
 * activity. Click row → /campaigns/[id].
 */

const STAGE_VARIANT: Record<CampaignStage, "violet" | "emerald" | "slate" | "amber"> = {
  overview: "slate",
  sourcing: "violet",
  outreach: "emerald",
  shipping: "emerald",
  content_review: "emerald",
  performance: "emerald",
};

const STATUS_VARIANT: Record<z.infer<typeof CampaignStatusSchema>, "blue" | "amber" | "slate" | "emerald" | "rose"> = {
  draft: "slate",
  running: "blue",
  paused: "amber",
  completed: "emerald",
  cancelled: "rose",
};

function fmtAgo(when: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - when.getTime()) / 1000));
  if (sec < 60) return "방금 전";
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

export default async function CampaignsPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const campaigns = await campaignRepo.listByWorkspace(session.workspaceId);

  // batch pending-approvals: one query per campaign would be expensive; just
  // group the workspace-wide pending list locally
  const allPending = await approvalRepo.listPendingByWorkspace(session.workspaceId).catch(() => []);
  const pendingByCampaign = new Map<string, number>();
  for (const a of allPending) {
    pendingByCampaign.set(a.campaignId, (pendingByCampaign.get(a.campaignId) ?? 0) + 1);
  }

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold">캠페인</h1>
          <p className="mt-1 text-[13px] text-slate-500">에이전트가 운영 중인 캠페인. 행을 클릭하면 활동 타임라인이 열립니다.</p>
        </div>
        <Link href="/campaigns/new">
          <Button variant="primary">+ 새 캠페인</Button>
        </Link>
      </header>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-[13px]">
          <thead className="text-[11px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">캠페인</th>
              <th className="text-left px-4 py-2.5 font-medium">상태</th>
              <th className="text-left px-4 py-2.5 font-medium">현재 단계</th>
              <th className="text-right px-4 py-2.5 font-medium">트랙</th>
              <th className="text-right px-4 py-2.5 font-medium">마지막 활동</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-slate-500 text-[13px]">
                  아직 캠페인이 없습니다.{" "}
                  <Link href="/campaigns/new" className="text-blue-700 hover:underline">새 캠페인 시작 →</Link>
                </td>
              </tr>
            )}
            {campaigns.map((c) => {
              const pending = pendingByCampaign.get(c.id) ?? 0;
              return (
                <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <Link href={`/campaigns/${c.id}`} className="block">
                      <div className="font-medium text-slate-900">{c.brief.brandProduct.name}</div>
                      <div className="text-[11px] mono text-slate-500 mt-0.5">camp_{c.id.slice(0, 12)} · {c.brief.brandProduct.category}</div>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={STATUS_VARIANT[c.status]}>{c.status}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={STAGE_VARIANT[c.stage]}>{ORDER_LABEL[c.stage]}</Badge>
                    {pending > 0 && <Badge variant="amber" className="ml-2">⚠ {pending} 대기</Badge>}
                  </td>
                  <td className="px-4 py-3 text-right mono">{c.tracks.length}</td>
                  <td className="px-4 py-3 text-right text-[12px] text-slate-500">{fmtAgo(c.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const ORDER_LABEL: Record<CampaignStage, string> = {
  overview: "1 · overview",
  sourcing: "2 · sourcing",
  outreach: "3 · outreach",
  shipping: "4 · shipping",
  content_review: "5 · content_review",
  performance: "6 · performance",
};
