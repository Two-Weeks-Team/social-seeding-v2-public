import { z } from "zod";
import { defineCapability } from "../registry";

/**
 * gmail.send — send (or schedule) an email on the workspace's connected Gmail.
 * scope = "external_send" ⇒ the orchestrator NEVER calls this without first
 * clearing the `approveOutreachSend` / `approveReplyResponse` policy gate.
 * Ports v1 `lib/gmail/*` (OAuth, token-manager auto-refresh) + tracking pixel +
 * unsubscribe token + spam-score pre-check.
 */
export const gmailSend = defineCapability({
  name: "gmail.send",
  description: "Send or schedule an email via the workspace's Gmail. Adds tracking + unsubscribe footer. External action — gated by policy.",
  scope: "external_send",
  idempotent: false,
  rateLimitClass: "gmail_send",
  input: z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    bodyHtml: z.string().min(1),
    threadId: z.string().optional(), // reply into an existing thread
    sendAt: z.coerce.date().optional(), // schedule send (v1 parity)
    idempotencyKey: z.string(), // dedupes retries — required for an external send
  }),
  output: z.object({ messageId: z.string(), threadId: z.string(), scheduled: z.boolean() }),
  async handler(_input, _ctx) {
    // TODO(phase-2, task O3): port v1 `lib/gmail` send path + `email-tracking` + `email-unsubscribe-token`.
    throw new Error("gmail.send not implemented — see docs/PHASE-1-PLAN.md (Phase 2)");
  },
});
