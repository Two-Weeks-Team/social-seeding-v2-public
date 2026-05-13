import { z } from "zod";

/**
 * Workspace autonomy policy — the thing that makes automation *safe*.
 * "Based on user context" lives here: per-workspace boundaries the
 * orchestrator consults at every checkpoint to decide auto vs. ask-human.
 *
 * Default (FREEZE.md §3): every gate ON (checkpointed). Owners relax gates
 * one at a time as trust accumulates.
 */
export const AutonomyLevelSchema = z.enum([
  "copilot", // agents only propose; a human clicks every action
  "checkpointed", // agents act, but each stage has an approval gate (DEFAULT)
  "autonomous", // agents act end-to-end; escalate only on policy-defined exceptions
]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

/** A single configurable gate. `auto` predicates are evaluated against run context. */
export const GateConfigSchema = z.object({
  mode: z.enum(["always_ask", "auto", "auto_unless"]),
  // for "auto_unless": ask the human only if any predicate matches
  escalateIf: z
    .object({
      spamScoreGte: z.number().optional(),
      followerCountGte: z.number().optional(),
      proposedRateUsdGte: z.number().optional(),
      fitScoreLt: z.number().optional(),
      replyClassIn: z.array(z.string()).optional(),
    })
    .partial()
    .optional(),
});
export type GateConfig = z.infer<typeof GateConfigSchema>;

export const WorkspacePolicySchema = z.object({
  workspaceId: z.string(),
  level: AutonomyLevelSchema.default("checkpointed"),
  gates: z.object({
    approveShortlist: GateConfigSchema, // after sourcing+vetting
    approveOutreachSend: GateConfigSchema, // before sending each batch
    approveReplyResponse: GateConfigSchema, // before sending a drafted reply
    approveShipment: GateConfigSchema, // before creating a shipment
    approveStageAdvance: GateConfigSchema, // moving the whole campaign to the next stage
  }),
  budgets: z.object({
    maxUsdPerCampaign: z.number().positive().default(25),
    maxUsdPerWorkspaceMonthly: z.number().positive().default(200),
  }),
  voice: z.object({
    // carried into the Outreach Writer agent's prompt
    toneNotes: z.string().default(""),
    signatureBlock: z.string().default(""),
    bannedPhrases: z.array(z.string()).default([]),
  }),
  updatedAt: z.coerce.date(),
});
export type WorkspacePolicy = z.infer<typeof WorkspacePolicySchema>;

/** A checkpoint surfaced to the human in Mission Control's approval inbox. */
export const ApprovalSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  campaignId: z.string(),
  creatorId: z.string().optional(),
  kind: z.enum(["shortlist", "outreach_send", "reply_response", "shipment", "stage_advance"]),
  recommendation: z.unknown(), // the agent's pre-filled answer (shape depends on kind)
  rationale: z.string(),
  status: z.enum(["pending", "approved", "edited", "rejected", "expired"]).default("pending"),
  resolvedBy: z.string().optional(),
  resolvedAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
