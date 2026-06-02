import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { approvalRepo } from "@ss/db";
import { Events } from "@ss/contracts";
import { inngest } from "@ss/workflows";
import { denyIfDemo, getSessionOr401 } from "@/lib/auth";
import { promptGuard, PromptGuardError } from "@/lib/prompt-guard";

/**
 * W4 — POST /api/approvals/[id]/resolve. The HTTP twin of the server action
 * the drill-in form uses, for external callers / future SDK clients.
 *
 *   POST /api/approvals/<id>/resolve
 *   { decision: "approved" | "edited" | "rejected", editedPayload?: unknown }
 *   → 200 { ok: true } + emits approval/resolved (unblocks the gate)
 *
 * A3 (P1 Sub-1.2): editedPayload is forwarded to the next agent step (see
 * `packages/workflows/src/gate.ts:173`). A signed-in operator could otherwise
 * smuggle prompt-injection patterns through this trust boundary into
 * `conversation_responder`, `logistics`, etc. Walk the payload recursively
 * and apply `promptGuard` to every string. Reject the whole request with 400
 * on the first hit so the operator gets an actionable error.
 */

const Body = z.object({
  decision: z.enum(["approved", "edited", "rejected"]),
  editedPayload: z.unknown().optional(),
});

/** Max recursion depth — a deeply-nested payload from a compromised operator
 * must not blow the call stack (DoS). 20 is far beyond any real approval shape. */
const MAX_SANITIZE_DEPTH = 20;

/**
 * Recursively walk an arbitrary structure and call promptGuard on every string
 * leaf. Returns the same shape on success, throws PromptGuardError on the first
 * pattern hit. `path` accumulates a dotted/indexed locator so the 400 response
 * tells the operator which field tripped the guard. `depth` caps recursion so a
 * pathologically nested payload throws instead of overflowing the stack.
 */
export function sanitizePayloadStrings(payload: unknown, path = "editedPayload", depth = 0): unknown {
  if (depth > MAX_SANITIZE_DEPTH) {
    throw new Error(`payload nested too deeply at ${path} (>${MAX_SANITIZE_DEPTH})`);
  }
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === "string") {
    promptGuard(payload, path);
    return payload;
  }
  if (typeof payload === "number" || typeof payload === "boolean") return payload;
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => sanitizePayloadStrings(item, `${path}[${i}]`, depth + 1));
    return payload;
  }
  if (typeof payload === "object") {
    for (const [k, v] of Object.entries(payload)) {
      sanitizePayloadStrings(v, `${path}.${k}`, depth + 1);
    }
    return payload;
  }
  return payload;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getSessionOr401(req);
  if (!auth.ok) return auth.response;
  const { session } = auth;
  const denied = denyIfDemo(session);
  if (denied) return denied;
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

  // A3 — sanitize before any downstream side-effect (DB write + Inngest emit).
  if (editedPayload !== undefined) {
    try {
      sanitizePayloadStrings(editedPayload);
    } catch (err) {
      if (err instanceof PromptGuardError) {
        return NextResponse.json(
          { error: "prompt_guard_rejected", reason: err.reason },
          { status: 400 },
        );
      }
      throw err;
    }
  }

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
