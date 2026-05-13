/**
 * workspace.getPolicy / workspace.getPlan — thin capability wrappers over
 * @ss/db's workspaceRepo so agents and workflows resolve policy + plan through
 * the same invokeCapability path (consistent auth, tracing, rate-limit class).
 * No new logic here — the repo is the source of truth.
 *
 * (workspaceRepo.getPlan is still the FREE stub from P0-6 / docs/SCOPE-DECISIONS.md
 * §C; the real subscriptions / workspace_subscriptions / beauty_verified
 * resolution + 10-min cache lands as its own follow-up.)
 */
import { z } from "zod";
import { WorkspacePolicySchema } from "@ss/contracts";
import { workspaceRepo } from "@ss/db";
import { defineCapability } from "../registry";

const WorkspaceIdInput = z.object({
  /** defaults to ctx.workspaceId when omitted by the caller */
  workspaceId: z.string().min(1).optional(),
});

function resolveWorkspaceId(input: { workspaceId?: string }, ctx: { workspaceId: string }): string {
  return input.workspaceId ?? ctx.workspaceId;
}

export const workspaceGetPolicy = defineCapability({
  name: "workspace.getPolicy",
  description:
    "Read the workspace's autonomy policy (gates, budgets, voice). Returns the defaultPolicy (every gate always_ask, $25/$200 caps, blank voice) when nothing's been saved.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "default",
  input: WorkspaceIdInput,
  output: WorkspacePolicySchema,
  async handler(input, ctx) {
    return workspaceRepo.getPolicy(resolveWorkspaceId(input, ctx));
  },
});

const PlanSchema = z.enum(["FREE", "BEAUTY_VERIFIED", "STARTER", "PRO", "BUSINESS"]);
const WorkspacePlanOutput = z.object({ plan: PlanSchema });

export const workspaceGetPlan = defineCapability({
  name: "workspace.getPlan",
  description:
    "Resolve the workspace's billing plan. (Phase-0/1 stub returns FREE for every workspace — see docs/SCOPE-DECISIONS.md §C.)",
  scope: "read",
  idempotent: true,
  rateLimitClass: "default",
  input: WorkspaceIdInput,
  output: WorkspacePlanOutput,
  async handler(input, ctx) {
    return { plan: await workspaceRepo.getPlan(resolveWorkspaceId(input, ctx)) };
  },
});
