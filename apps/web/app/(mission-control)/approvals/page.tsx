import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { StatusTag } from "@/components/ui/status-tag";
import { EmptyState } from "@/components/ui/empty-state";
import { getServerSession } from "@/lib/auth";
import { approvalRepo, campaignRepo } from "@ss/db";
import { type Approval } from "@ss/contracts";
import { approvalKindKo } from "@/lib/labels";
import { fmtAgo } from "@/lib/format";

/**
 * Approval inbox (C2). Groups pending decisions across the workspace by kind.
 * Shortlist rows link into the candidate table drill-in.
 * When there are zero pending items, render one calm EmptyState instead of per-kind boxes.
 */

// Header display order by approval kind; only kinds with pending items render.
const KIND_ORDER: Approval["kind"][] = [
  "shortlist",
  "outreach_send",
  "reply_response",
  "shipment",
  "content_review",
  "budget",
  "payment_mandate",
  "stage_advance",
];

// Kinds with a drill-in review screen; these show the Review button.
const REVIEWABLE_KINDS = new Set<Approval["kind"]>([
  "shortlist",
  "outreach_send",
  "reply_response",
  "shipment",
  "content_review",
  "budget",
  "payment_mandate",
]);

/** Best-effort subject extraction from an outreach_send recommendation (OutreachDraft). */
function outreachSubject(rec: unknown): string | null {
  if (rec && typeof rec === "object" && !Array.isArray(rec) && "subject" in rec) {
    const s = (rec as { subject: unknown }).subject;
    return typeof s === "string" ? s : null;
  }
  return null;
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams?: Promise<{ demoReadonly?: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  // Set when a judge-demo session attempts to resolve a gate (demoReadonlyGuard
  // bounces the server action here) — surface why "nothing happened".
  const demoReadonly = Boolean((await searchParams)?.demoReadonly);

  const pending = await approvalRepo.listPendingByWorkspace(session.workspaceId);
  // Campaign/brand name map for display.
  const campaigns = await campaignRepo.listByWorkspace(session.workspaceId);
  const byCampaign = new Map(campaigns.map((c) => [c.id, c.brief.brandProduct.name]));

  const grouped = new Map<Approval["kind"], Approval[]>();
  for (const a of pending) grouped.set(a.kind, [...(grouped.get(a.kind) ?? []), a]);

  // Only kinds with pending rows, in the fixed display order.
  const activeKinds = KIND_ORDER.filter((k) => (grouped.get(k)?.length ?? 0) > 0);

  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      {demoReadonly && (
        <div
          role="status"
          className="mb-5 rounded-xl border border-warn/25 bg-warn-bg px-4 py-3 text-[13px] text-ink-2"
        >
          <span className="font-semibold text-ink">Read-only judge demo</span> — gates can&apos;t be resolved
          from this session. The pending approval stays untouched; in a real workspace the operator&apos;s
          decision here is what releases the send.
        </div>
      )}
      <header className="mb-6 flex items-start justify-between gap-5">
        <div>
          <h1 className="text-[24px] font-bold tracking-[-0.01em]">Approval inbox</h1>
          <p className="mt-1 text-[13.5px] text-ink-2">
            Agents have prefilled recommendations. Review one category at a time and make the final call.
          </p>
        </div>
        {pending.length > 0 && (
          <StatusTag tone="warn">{pending.length} pending</StatusTag>
        )}
      </header>

      {pending.length === 0 ? (
        <EmptyState
          icon="✓"
          title="0 pending · all clear"
          hint="When a new decision is needed, agents will place it here with a recommendation."
          action={<Link href="/campaigns"><Button variant="primary">View campaigns</Button></Link>}
        />
      ) : (
        <div className="space-y-6">
          {activeKinds.map((kind) => {
            const rows = grouped.get(kind) ?? [];
            return (
              <section key={kind}>
                <SectionLabel className="mb-2.5">
                  {approvalKindKo(kind)} · {rows.length} items
                </SectionLabel>
                <div className="space-y-2.5">
                  {rows.map((a) => {
                    const subject = kind === "outreach_send" ? outreachSubject(a.recommendation) : null;
                    const candidateCount =
                      kind === "shortlist" && Array.isArray(a.recommendation)
                        ? a.recommendation.length
                        : null;
                    return (
                      <Card key={a.id} hover>
                        <CardBody>
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <div className="text-[15px] font-bold text-ink">
                                {byCampaign.get(a.campaignId) ?? "Unnamed campaign"}
                                {candidateCount != null && (
                                  <span className="ml-2 text-[13px] font-medium text-ink-2">
                                    {candidateCount} candidates
                                  </span>
                                )}
                              </div>
                              {subject && (
                                <div className="mt-1 text-[13px] text-ink-2 truncate">
                                  “{subject.slice(0, 70)}”
                                </div>
                              )}
                              {a.rationale && (
                                <p className="mt-1 text-[12.5px] text-ink-3 leading-relaxed line-clamp-2">
                                  {a.rationale}
                                </p>
                              )}
                            </div>
                            <div className="flex flex-col items-end gap-2 shrink-0">
                              <div className="text-[12px] text-ink-3 mono">{fmtAgo(a.createdAt)}</div>
                              {REVIEWABLE_KINDS.has(kind) && (
                                <Link href={`/approvals/${a.id}`}>
                                  <Button variant="primary" size="sm">Review →</Button>
                                </Link>
                              )}
                            </div>
                          </div>
                        </CardBody>
                      </Card>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
