import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth";
import { approvalRepo, campaignRepo } from "@ss/db";
import { inngest } from "@ss/workflows";
import { Events, type Candidate } from "@ss/contracts";

/**
 * W4 — Shortlist approval drill-in. Server component (form) + server action
 * for resolve. For kind="shortlist" only — other kinds get a "Phase 2/3"
 * placeholder so the route is reachable but doesn't pretend to be ready.
 *
 * Three actions: Approve all (button = approveAll) / Approve selected (the
 * form submits the checked-row subset as editedPayload, decision="edited" if
 * fewer than the original count, else "approved") / Reject (decision="rejected").
 * All paths call approvalRepo.resolve + inngest.send("approval/resolved")
 * which unblocks the workflow's gate.
 */

async function resolveAction(formData: FormData): Promise<void> {
  "use server";
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const Form = z.object({
    approvalId: z.string().min(1),
    decision: z.enum(["approveAll", "approveSelected", "reject"]),
    creatorIds: z.array(z.string()).optional(),
  });
  const raw: Record<string, unknown> = {
    approvalId: formData.get("approvalId"),
    decision: formData.get("decision"),
    creatorIds: formData.getAll("creatorId").map(String),
  };
  const parsed = Form.safeParse(raw);
  if (!parsed.success) return;
  const { approvalId, decision, creatorIds = [] } = parsed.data;

  const approval = await approvalRepo.get(approvalId);
  if (!approval || approval.workspaceId !== session.workspaceId) redirect("/approvals");
  if (!approval || approval.status !== "pending") redirect(`/approvals`);

  let resolvedDecision: "approved" | "edited" | "rejected" = "approved";
  let editedPayload: unknown = undefined;
  if (decision === "reject") {
    resolvedDecision = "rejected";
  } else if (decision === "approveAll" || !Array.isArray(approval.recommendation)) {
    resolvedDecision = "approved";
  } else {
    // approveSelected — keep only the candidates whose creator.id is in creatorIds
    const filtered = (approval.recommendation as Candidate[]).filter((c) => creatorIds.includes(c.creator.id));
    if (filtered.length === (approval.recommendation as Candidate[]).length) {
      resolvedDecision = "approved";
    } else {
      resolvedDecision = "edited";
      editedPayload = filtered;
    }
  }

  await approvalRepo.resolve(approvalId, resolvedDecision, session.userId, editedPayload);
  await inngest.send({
    name: Events.ApprovalResolved,
    data: {
      approvalId,
      campaignId: approval.campaignId,
      decision: resolvedDecision,
      ...(editedPayload !== undefined ? { editedPayload } : {}),
    },
  });
  revalidatePath(`/campaigns/${approval.campaignId}`);
  revalidatePath("/approvals");
  redirect(`/campaigns/${approval.campaignId}`);
}

function FitScoreMeter({ score }: { score: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block w-14 h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <span
          className="block h-full"
          style={{ width: `${pct}%`, background: `linear-gradient(90deg, #f59e0b, #10b981)` }}
        />
      </span>
      <span className="mono text-[12px] text-slate-700">{score.toFixed(2)}</span>
    </span>
  );
}

export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;
  const approval = await approvalRepo.get(id);
  if (!approval || approval.workspaceId !== session.workspaceId) notFound();
  const campaign = await campaignRepo.get(approval.campaignId);

  if (approval.kind !== "shortlist") {
    return (
      <div className="max-w-3xl mx-auto px-8 py-8">
        <Link href="/approvals" className="text-[11px] text-slate-500 hover:text-slate-900">← 승인 인박스</Link>
        <h1 className="mt-2 text-[18px] font-semibold">{approval.kind}</h1>
        <p className="mt-1 text-[13px] text-slate-500">이 종류의 승인 검토 화면은 Phase 2/3에서 추가됩니다.</p>
      </div>
    );
  }

  const candidates = Array.isArray(approval.recommendation) ? (approval.recommendation as Candidate[]) : [];

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-4">
        <Link href="/approvals" className="text-[11px] text-slate-500 hover:text-slate-900">← 승인 인박스</Link>
        <div className="mt-2 flex items-end justify-between flex-wrap gap-3">
          <div>
            <SectionLabel>SHORTLIST · approveShortlist</SectionLabel>
            <h1 className="mt-1 text-[22px] font-semibold">
              {campaign?.brief.brandProduct.name ?? "(unknown campaign)"} · {candidates.length}명 후보 검토
            </h1>
            <div className="mt-1 text-[12px] text-slate-500">
              대기 시작 {Math.floor((Date.now() - approval.createdAt.getTime()) / 60000)}분 전 · 캠페인{" "}
              <Link className="underline hover:text-slate-900 mono" href={`/campaigns/${approval.campaignId}`}>
                camp_{approval.campaignId.slice(0, 12)}
              </Link>
            </div>
          </div>
        </div>
      </header>

      <Card className="mb-5">
        <CardBody>
          <SectionLabel className="mb-2">에이전트가 추천한 이유</SectionLabel>
          <p className="text-[13px] text-slate-700 leading-relaxed">{approval.rationale}</p>
        </CardBody>
      </Card>

      <form action={resolveAction}>
        <input type="hidden" name="approvalId" value={approval.id} />

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="w-10 px-3 py-2"></th>
                <th className="text-left px-3 py-2 font-medium">크리에이터</th>
                <th className="text-right px-3 py-2 font-medium">팔로워</th>
                <th className="text-left px-3 py-2 font-medium">fitScore</th>
                <th className="text-left px-3 py-2 font-medium">flags</th>
                <th className="text-left px-3 py-2 font-medium">매칭 사유</th>
              </tr>
            </thead>
            <tbody>
              {candidates.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">후보가 없습니다.</td></tr>
              )}
              {candidates.map((c) => (
                <tr key={c.creator.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                  <td className="px-3 py-2.5">
                    <input type="checkbox" name="creatorId" value={c.creator.id} defaultChecked className="cursor-pointer" />
                  </td>
                  <td className="px-3 py-2.5 mono">{c.creator.uniqueId}</td>
                  <td className="px-3 py-2.5 text-right mono">{c.creator.followerCount.toLocaleString()}</td>
                  <td className="px-3 py-2.5">
                    <FitScoreMeter score={c.fitScore} />
                  </td>
                  <td className="px-3 py-2.5">
                    {c.flags.length === 0 ? (
                      <Badge variant="emerald">clean</Badge>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {c.flags.map((f) => (
                          <Badge
                            key={f}
                            variant={f === "blacklisted" || f === "brand_unsafe" ? "rose" : "amber"}
                          >
                            {f}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-slate-600 text-[12px]">{c.matchReasons[0] ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button type="submit" name="decision" value="reject" tone="reject">거부</Button>
          <Button type="submit" name="decision" value="approveSelected" variant="primary">선택한 행으로 승인</Button>
          <Button type="submit" name="decision" value="approveAll" variant="primary" tone="approve">전체 승인</Button>
        </div>
      </form>
    </div>
  );
}
