/**
 * POST /api/approvals/[id]/reject-mandate
 *
 * D-IDs touched:
 *   D27 — operator-initiated reject; the `customer_success` agent observes
 *         the structured reason for retraining signal (anti-pattern §9.8).
 *
 * AP2-UX.md §3.5: rejection emits an Eventarc event for `customer_success`.
 * In v2 day-1 the workflow's existing `approval/resolved` event with
 * `decision: "rejected"` covers the same flow; we map there.
 */
import { NextResponse, type NextRequest } from "next/server";
import { Events } from "@ss/contracts";
import { approvalRepo } from "@ss/db";
import { inngest } from "@ss/workflows";
import { getSessionOr401 } from "@/lib/auth";
import { RejectMandateRequestSchema } from "@/lib/ap2/mandate";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await getSessionOr401(req);
  if (!auth.ok) return auth.response;
  const { session } = auth;
  const { id } = await params;

  const raw = await req.json().catch(() => null);
  const parsed = RejectMandateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (parsed.data.approvalId !== id) {
    return NextResponse.json(
      { error: "approval_id_mismatch" },
      { status: 400 },
    );
  }

  const approval = await approvalRepo.get(id);
  if (!approval || approval.workspaceId !== session.workspaceId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (approval.status !== "pending") {
    return NextResponse.json(
      { error: "already_resolved", status: approval.status },
      { status: 409 },
    );
  }

  const rejectedPayload = {
    reason: parsed.data.reason,
    note: parsed.data.note,
    rejectedAt: new Date().toISOString(),
    rejectedBy: session.userId,
  };

  await approvalRepo.resolve(id, "rejected", session.userId, rejectedPayload);
  await inngest.send({
    name: Events.ApprovalResolved,
    data: {
      approvalId: id,
      campaignId: approval.campaignId,
      decision: "rejected",
      editedPayload: rejectedPayload,
    },
  });

  return NextResponse.json({ ok: true, approvalId: id, decision: "rejected" });
}
