import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth";
import { approvalRepo, campaignRepo } from "@ss/db";
import { type Approval } from "@ss/contracts";

/**
 * W4 — Approval inbox. Workspace-wide pending approvals grouped by kind.
 * For kind="shortlist", click → /approvals/[id] (the drill-in with the
 * candidate table). Phase 2+ kinds (outreach_send / reply_response /
 * shipment / stage_advance) render in a "coming soon" form so the user
 * sees the inventory.
 */

const KIND_LABEL: Record<Approval["kind"], string> = {
  shortlist: "SHORTLIST",
  outreach_send: "OUTREACH_SEND",
  reply_response: "REPLY_RESPONSE",
  shipment: "SHIPMENT",
  stage_advance: "STAGE_ADVANCE",
};

const KIND_PHASE: Record<Approval["kind"], string | null> = {
  shortlist: null,
  outreach_send: null, // P2-C6a: drill-in live
  reply_response: null, // P2-C6b: drill-in live
  shipment: "Phase 3",
  stage_advance: null,
};

const REVIEWABLE_KINDS = new Set<Approval["kind"]>(["shortlist", "outreach_send", "reply_response"]);

/** Best-effort subject extraction from an outreach_send recommendation (which is OutreachDraft). */
function outreachSubject(rec: unknown): string | null {
  if (rec && typeof rec === "object" && !Array.isArray(rec) && "subject" in rec) {
    const s = (rec as { subject: unknown }).subject;
    return typeof s === "string" ? s : null;
  }
  return null;
}

function fmtAgo(when: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - when.getTime()) / 1000));
  if (sec < 60) return `${sec}s 경과`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m 경과`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m 경과`;
  return `${Math.floor(sec / 86400)}d 경과`;
}

export default async function ApprovalsPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");

  const pending = await approvalRepo.listPendingByWorkspace(session.workspaceId);
  // attach the campaign brand name for display
  const campaigns = await campaignRepo.listByWorkspace(session.workspaceId);
  const byCampaign = new Map(campaigns.map((c) => [c.id, c.brief.brandProduct.name]));

  const grouped = new Map<Approval["kind"], Approval[]>();
  for (const a of pending) grouped.set(a.kind, [...(grouped.get(a.kind) ?? []), a]);

  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <header className="mb-6">
        <h1 className="text-[22px] font-semibold">
          승인 인박스{" "}
          <span className="text-slate-400 font-normal text-[14px]">· {pending.length} pending</span>
        </h1>
        <p className="mt-1 text-[13px] text-slate-500">
          에이전트가 추천을 미리 채워뒀습니다. 한 종류씩 처리해보세요.
        </p>
      </header>

      <div className="space-y-5">
        {(["shortlist", "outreach_send", "reply_response", "shipment", "stage_advance"] as Approval["kind"][]).map((kind) => {
          const rows = grouped.get(kind) ?? [];
          const phase = KIND_PHASE[kind];
          return (
            <section key={kind}>
              <SectionLabel className="mb-2">
                {KIND_LABEL[kind]} · {rows.length}
                {phase && <Badge variant="slate" className="ml-2 !text-[10px]">{phase}</Badge>}
              </SectionLabel>
              {rows.length === 0 ? (
                <Card>
                  <CardBody className="text-[12px] text-slate-500">
                    {phase ? `${phase}부터 생성됩니다.` : "대기 중인 항목 없음."}
                  </CardBody>
                </Card>
              ) : (
                rows.map((a) => (
                  <Card key={a.id} className="mb-2" hover>
                    <CardBody>
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="text-[14px] font-medium text-slate-900">
                            {byCampaign.get(a.campaignId) ?? "(unknown campaign)"}
                            {kind === "shortlist" && (
                              <>
                                {" — "}
                                <span className="mono text-slate-600">
                                  {Array.isArray(a.recommendation) ? `${a.recommendation.length}명 후보` : "candidates"}
                                </span>
                              </>
                            )}
                            {kind === "outreach_send" && outreachSubject(a.recommendation) && (
                              <>
                                {" — "}
                                <span className="text-slate-600 truncate">
                                  “{outreachSubject(a.recommendation)?.slice(0, 60)}”
                                </span>
                              </>
                            )}
                          </div>
                          <div className="mt-0.5 text-[12px] text-slate-500">{a.rationale}</div>
                          <div className="mt-1 text-[11px] mono text-slate-400">
                            approval_{a.id.slice(0, 12)} · camp_{a.campaignId.slice(0, 12)}
                          </div>
                        </div>
                        <div className="flex-shrink-0 text-right">
                          <div className="text-[11px] text-slate-400 mono">{fmtAgo(a.createdAt)}</div>
                          {REVIEWABLE_KINDS.has(kind) && (
                            <Link href={`/approvals/${a.id}`} className="mt-1.5 inline-block">
                              <Button variant="primary">검토 →</Button>
                            </Link>
                          )}
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                ))
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
