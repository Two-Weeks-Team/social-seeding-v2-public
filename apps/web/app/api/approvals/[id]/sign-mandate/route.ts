/**
 * POST /api/approvals/[id]/sign-mandate
 *
 * D-IDs touched:
 *   D27 — server enforces "Intent-only, human-signed" — agents cannot call
 *         this endpoint (workspace ID must be the session's; no service-
 *         account bypass).
 *   D33 — operator note (PII) is stored against the resolved approval; the
 *         signed Mandate JWS goes to the AP2 store (financial evidence).
 *
 * Behaviour:
 *   1. Verify session (workspace-scoped per R5 cross-tenant safety).
 *   2. Parse the body against SignMandateRequestSchema.
 *   3. Re-fetch the approval (anti-pattern §9.9 — no client-state trust).
 *   4. Verify the approval is still PENDING (idempotency).
 *   5. Verify the nonce is unused in the rolling 48h window (R1 anti-replay).
 *   6. (NOT here) Hand to the AP2 verifier service to validate the WebAuthn
 *      assertion against the stored credential's public key. The verifier is
 *      out of scope for this UI deliverable; we record the assertion blob
 *      against the approval and emit the workflow event.
 *   7. Resolve the approval with decision "approved" (or "edited" if edits).
 *   8. Emit `Events.ApprovalResolved` — the workflow's `step.waitForEvent`
 *      consumer unblocks and the campaign progresses.
 *
 * Replay-protection store (in-memory placeholder): production should use
 * Spanner unique-constraint on (workspace_id, nonce) per R1. We expose
 * `isNonceUsed` / `markNonceUsed` as the seam for the swap.
 */
import { NextResponse, type NextRequest } from "next/server";
import { Events } from "@ss/contracts";
import { approvalRepo } from "@ss/db";
import { inngest } from "@ss/workflows";
import { denyIfDemo, getSessionOr401 } from "@/lib/auth";
import { SignMandateRequestSchema } from "@/lib/ap2/mandate";

/**
 * Rolling 48 h nonce store. Wire to Memorystore Valkey or Spanner unique
 * constraint per D-services list. This module-local Map keeps tests
 * deterministic and is sufficient for the Phase-6 deliverable.
 */
const NONCE_TTL_MS = 48 * 60 * 60 * 1000;
const usedNonces = new Map<string, number>();

function isNonceUsed(nonce: string): boolean {
  const expiry = usedNonces.get(nonce);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    usedNonces.delete(nonce);
    return false;
  }
  return true;
}
function markNonceUsed(nonce: string): void {
  usedNonces.set(nonce, Date.now() + NONCE_TTL_MS);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await getSessionOr401(req);
  if (!auth.ok) return auth.response;
  const { session } = auth;
  const denied = denyIfDemo(session);
  if (denied) return denied;
  const { id } = await params;

  const raw = await req.json().catch(() => null);
  const parsed = SignMandateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { approvalId, nonce, edits, webAuthnAssertion } = parsed.data;
  if (approvalId !== id) {
    return NextResponse.json(
      { error: "approval_id_mismatch" },
      { status: 400 },
    );
  }

  // EC-2.29 replay protection.
  if (isNonceUsed(nonce)) {
    return NextResponse.json(
      { error: "replay_detected" },
      { status: 409 },
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

  // The AP2 verifier service (out of scope here) would now:
  //   - reconstruct the canonical Mandate JSON from `approval.recommendation`
  //     + `edits`, hash it (SHA-256), and verify the WebAuthn assertion's
  //     clientDataJSON.challenge matches the hash.
  //   - verify the assertion signature against the stored public key for
  //     this operator's WebAuthn credential.
  //   - persist the final SD-JWT (with the +kb JWT bound to the assertion)
  //     to the AP2 store on Spanner.
  // We mark the nonce as consumed and emit the gate-resume event.
  markNonceUsed(nonce);

  const decision = edits && (edits.recipientEdits.length > 0 || edits.operatorNote)
    ? "edited"
    : "approved";
  const editedPayload =
    decision === "edited"
      ? { edits, signedAt: new Date().toISOString(), signedBy: session.userId, transport: "webauthn" }
      : { signedAt: new Date().toISOString(), signedBy: session.userId, transport: "webauthn" };

  // Note: webAuthnAssertion bytes go to the AP2 store via the verifier
  // (out of scope here). We attach the credential id as a fingerprint to the
  // edited payload so the workflow consumer can correlate without logging
  // the raw assertion at info level.
  const editedPayloadWithFingerprint = {
    ...editedPayload,
    webAuthnCredentialId: webAuthnAssertion.id,
  };

  await approvalRepo.resolve(id, decision, session.userId, editedPayloadWithFingerprint);
  await inngest.send({
    name: Events.ApprovalResolved,
    data: {
      approvalId: id,
      campaignId: approval.campaignId,
      decision,
      editedPayload: editedPayloadWithFingerprint,
    },
  });

  return NextResponse.json({
    ok: true,
    approvalId: id,
    decision,
    nextState: "AWAITING_PAYMENT_HUMAN",
  });
}
