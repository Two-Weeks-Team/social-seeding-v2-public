import { z } from "zod";
import { ReplyClassSchema } from "./outreach";

/**
 * ThreadMessage — one persisted email in a creator conversation (the v2-owned
 * `v2_messages` collection). Outbound = an outreach / reply the fleet sent;
 * inbound = a creator's reply (resolved from the Gmail pubsub webhook). The
 * operator reads these in the "이메일 스레드" surface + per-creator on the
 * campaign detail. Bodies are plain text (rendered with simple line breaks).
 */
export const ThreadMessageSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  campaignId: z.string(),
  creatorId: z.string(),
  threadId: z.string(),
  direction: z.enum(["outbound", "inbound"]),
  subject: z.string(),
  body: z.string(),
  sentAt: z.coerce.date(),
  /** Set on inbound replies (the responder agent's classification). Outbound rows
   * persist this as null/absent — accept both and normalize to undefined. */
  classification: z.preprocess((v) => (v === null ? undefined : v), ReplyClassSchema.optional()),
  /** Outbound messages drafted by an agent (vs a human edit). */
  agentGenerated: z.boolean().default(false),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;
