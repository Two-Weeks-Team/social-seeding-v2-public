import { z } from "zod";
import { CampaignBriefSchema } from "@ss/contracts";
import { defineAgent } from "./runtime";

/**
 * Intake agent. A bounded conversational agent (no tools) that fills a
 * CampaignBrief over ≤ ~6 short exchanges with the user. Replaces v1's
 * 6-tab campaign-creation form. Each invocation is ONE deliberation step —
 * the caller (apps/web's POST /api/campaigns/intake SSE route, landing in
 * Chunk 4) maintains the conversation history and re-invokes after each user
 * reply until status === "done".
 *
 * Asks only for what it can't reasonably infer from prior turns; confirms the
 * assembled brief before returning it; escalates if the answers can't produce
 * a valid brief.
 */

export const IntakeMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});

export const intakeAgent = defineAgent({
  id: "intake",
  description: "Conversational agent that assembles a CampaignBrief from a short user conversation.",
  tools: [], // pure conversational — no I/O
  model: "gemini-3.1-pro",
  maxUsd: 0.2, // bounded conversation
  input: z.object({
    messages: z.array(IntakeMessageSchema).min(1).max(20),
    workspaceId: z.string().min(1),
    createdBy: z.string().min(1),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("asking"), question: z.string().min(1).max(400) }),
    z.object({ status: z.literal("done"), brief: CampaignBriefSchema }),
  ]),
  systemPrompt: ({ messages, workspaceId, createdBy }) =>
    [
      "You are the campaign intake agent for Social Seeding, an agent-orchestrated TikTok seeding operator. Your only job is to assemble a CampaignBrief from a short conversation with the user.",
      "",
      "A CampaignBrief has these required fields:",
      "  · brandProduct: { name, category (e.g. 'skincare/serum'), description, keyClaims[] (optional) }",
      "  · targeting: { creatorCount (int>0), followerRange[min,max] (optional), minEngagementRate (0-1, default 0.02), languages (ISO-639-1, default ['ko']), hashtags[] (optional) }",
      "  · logistics: { shipsSamples (bool) }",
      "  · goals: { targetLivePosts (int>0), deadline (ISO date), budgetUsd (optional) }",
      `  · workspaceId = "${workspaceId}", createdBy = "${createdBy}" (the caller pre-fills these — include them as-is in the brief).`,
      "",
      "Procedure (one decision per invocation — the caller re-invokes you after each user reply):",
      "1) Read the conversation so far. Identify the most important field still missing or ambiguous.",
      "2) If you have enough to produce a valid CampaignBrief (every required field filled with a reasonable value), respond with {status:\"done\", brief:{…full brief…}}.",
      "3) Otherwise respond with {status:\"asking\", question:\"…\"} — ONE focused question, in the user's language, ≤2 sentences. Don't restate what the user already said.",
      `4) If after ${Math.max(1, messages.length)} turn(s) the answers contradict each other or you genuinely can't produce a valid brief, return {escalate:"<reason>"}.`,
      "",
      "Bias: ship the brief as soon as it's complete enough. Don't ask about budget unless the user volunteers it (defaults exist downstream). Don't ask about creatorCount more than once.",
    ].join("\n"),
});
