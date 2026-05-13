import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeMongo, Collections, getDb } from "@ss/db";
import { isSuppressed, suppressionAdd, suppressionCheck } from "./check";

/**
 * P2-C7b — suppression list. Round-trips against dev-mongo; verifies the
 * workspace scoping + email normalization + the idempotency of .add.
 */

const ctx = { workspaceId: "ws_supp", userId: "u".repeat(21), rateLimitClass: "default" as const };

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
  // Mirror the production index from scripts/init-indexes.ts so the
  // workspace-scoped uniqueness contract is exercised (codex review P2#8).
  const db = await getDb();
  await db
    .collection(Collections.V2_SUPPRESSION_LIST)
    .createIndex({ workspaceId: 1, email: 1 }, { unique: true })
    .catch(() => undefined);
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_SUPPRESSION_LIST).deleteMany({});
});

afterAll(async () => { await closeMongo(); });

describe("suppression.check + .add", () => {
  it("unknown email → suppressed=false", async () => {
    const out = await suppressionCheck.handler({ email: "anyone@example.com" }, ctx);
    expect(out.suppressed).toBe(false);
  });

  it("add → check round-trip surfaces the reason + addedAt", async () => {
    const added = await suppressionAdd.handler(
      { email: "Creator@Example.com", reason: "unsubscribed", source: "unsubscribe page" },
      ctx,
    );
    expect(added).toEqual({ added: true, email: "creator@example.com" });
    const checked = await suppressionCheck.handler({ email: "creator@EXAMPLE.com" }, ctx);
    expect(checked.suppressed).toBe(true);
    expect(checked.reason).toBe("unsubscribed");
    expect(checked.addedAt).toBeInstanceOf(Date);
  });

  it("idempotent: re-adding does NOT duplicate but updates source/reason", async () => {
    const a1 = await suppressionAdd.handler(
      { email: "x@example.com", reason: "bounced", source: "resend" },
      ctx,
    );
    const a2 = await suppressionAdd.handler(
      { email: "x@example.com", reason: "manual", source: "operator" },
      ctx,
    );
    expect(a1.added).toBe(true);
    expect(a2.added).toBe(false); // already existed
    const db = await getDb();
    const rows = await db.collection(Collections.V2_SUPPRESSION_LIST).find({ email: "x@example.com" }).toArray();
    expect(rows).toHaveLength(1);
    const checked = await suppressionCheck.handler({ email: "x@example.com" }, ctx);
    expect(checked.reason).toBe("manual"); // updated reason
  });

  it("workspace-scoped: ws_A's suppression doesn't leak into ws_B", async () => {
    await suppressionAdd.handler(
      { email: "shared@example.com", reason: "unsubscribed", source: "ws_A" },
      { ...ctx, workspaceId: "ws_A" },
    );
    const inB = await suppressionCheck.handler(
      { email: "shared@example.com" },
      { ...ctx, workspaceId: "ws_B" },
    );
    expect(inB.suppressed).toBe(false);
  });

  it("workspace-scoped: same email can be suppressed in two workspaces without E11000 (codex review P2#8)", async () => {
    await suppressionAdd.handler(
      { email: "dual@example.com", reason: "unsubscribed", source: "ws_A" },
      { ...ctx, workspaceId: "ws_A" },
    );
    // Without the compound unique index this throws E11000 before the second
    // call even returns — the test would surface as 'unhandled rejection' /
    // 'duplicate key' rather than the friendly { added: true } result.
    const second = await suppressionAdd.handler(
      { email: "dual@example.com", reason: "bounced", source: "ws_B-bounce-webhook" },
      { ...ctx, workspaceId: "ws_B" },
    );
    expect(second).toEqual({ added: true, email: "dual@example.com" });

    const inA = await suppressionCheck.handler(
      { email: "dual@example.com" },
      { ...ctx, workspaceId: "ws_A" },
    );
    const inB = await suppressionCheck.handler(
      { email: "dual@example.com" },
      { ...ctx, workspaceId: "ws_B" },
    );
    expect(inA.reason).toBe("unsubscribed");
    expect(inB.reason).toBe("bounced");
  });

  it("isSuppressed helper matches the capability's behavior (used by gmail.send)", async () => {
    await suppressionAdd.handler(
      { email: "blocked@example.com", reason: "unsubscribed", source: "test" },
      ctx,
    );
    const res = await isSuppressed(ctx.workspaceId, "blocked@example.com");
    expect(res.suppressed).toBe(true);
    expect(res.reason).toBe("unsubscribed");
    const missing = await isSuppressed(ctx.workspaceId, "free@example.com");
    expect(missing).toEqual({ suppressed: false });
  });
});
