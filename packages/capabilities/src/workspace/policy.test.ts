import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, getDb } from "@ss/db";
import { workspaceGetPlan, workspaceGetPolicy } from "./policy";

/**
 * W0 — workspace.getPolicy / workspace.getPlan. Hits real Mongo for getPolicy
 * (to round-trip "no doc → defaultPolicy" against a real collection); getPlan
 * is the FREE stub and doesn't touch DB.
 *
 * Requires `pnpm run dev-mongo` to be up and MONGODB_URI to point at it.
 */

const ctx = { workspaceId: "ws_w0_test", userId: "u".repeat(21), rateLimitClass: "default" as const };

beforeAll(async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set — start scripts/dev-mongo + source .mongo-dev/dev-env before running tests");
  }
  // ensure no leftover policy doc would interfere with the "default when absent" assertion
  const db = await getDb();
  await db.collection("v2_workspace_policies").deleteMany({ workspaceId: ctx.workspaceId });
});

afterAll(async () => {
  await closeMongo();
});

describe("workspace.getPolicy", () => {
  it("returns defaultPolicy (every gate always_ask, $25/$200 caps) when no doc is saved", async () => {
    const policy = await workspaceGetPolicy.handler({}, ctx);
    expect(policy.workspaceId).toBe(ctx.workspaceId);
    expect(policy.level).toBe("checkpointed");
    expect(policy.gates.approveShortlist.mode).toBe("always_ask");
    expect(policy.gates.approveOutreachSend.mode).toBe("always_ask");
    expect(policy.gates.approveReplyResponse.mode).toBe("always_ask");
    expect(policy.gates.approveShipment.mode).toBe("always_ask");
    expect(policy.gates.approveStageAdvance.mode).toBe("always_ask");
    expect(policy.budgets.maxUsdPerCampaign).toBe(25);
    expect(policy.budgets.maxUsdPerWorkspaceMonthly).toBe(200);
  });

  it("rejects an empty workspaceId override at the input layer", () => {
    const r = workspaceGetPolicy.input.safeParse({ workspaceId: "" });
    expect(r.success).toBe(false);
  });
});

describe("workspace.getPlan", () => {
  it("happy path: returns { plan: FREE } from the P0-6 stub (no DB touch)", async () => {
    const out = await workspaceGetPlan.handler({}, ctx);
    expect(out.plan).toBe("FREE");
  });

  it("output validates against the PlanSchema (one of the 5 plan names)", () => {
    const r = workspaceGetPlan.output.safeParse({ plan: "TOTALLY_FAKE" });
    expect(r.success).toBe(false);
  });
});
