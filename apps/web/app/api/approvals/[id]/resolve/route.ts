import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { approvalRepo } from "@ss/db";
import { Events } from "@ss/contracts";
import { inngest } from "@ss/workflows";
import { getSessionOr401 } from "@/lib/auth";

/**
 * W4 — POST /api/approvals/[id]/resolve. The HTTP twin of the server action
 * the drill-in form uses, for external callers / future SDK clients.
 *
 *   POST /api/approvals/<id>/resolve
 *   { decision: "approved" | "edited" | "rejected", editedPayload?: unknown }
 *   → 200 { ok: true } + emits approval/resolved (unblocks the gate)
 */

const Body = z.object({
  decision: z.enum(["approved", "edited", "rejected"]),
  editedPayload: z.unknown().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getSessionOr401(req);
  if (!auth.ok) return auth.response;
  const { session } = auth;
  const { id } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", details: parsed.error.flatten() }, { status: 400 });
  }

  const approval = await approvalRepo.get(id);
  if (!approval || approval.workspaceId !== session.workspaceId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (approval.status !== "pending") {
    return NextResponse.json({ error: "already_resolved", status: approval.status }, { status: 409 });
  }

  const { decision, editedPayload } = parsed.data;
  await approvalRepo.resolve(id, decision, session.userId, editedPayload);
  await inngest.send({
    name: Events.ApprovalResolved,
    data: {
      approvalId: id,
      campaignId: approval.campaignId,
      decision,
      ...(editedPayload !== undefined ? { editedPayload } : {}),
    },
  });

  return NextResponse.json({ ok: true, approvalId: id, decision });
}
