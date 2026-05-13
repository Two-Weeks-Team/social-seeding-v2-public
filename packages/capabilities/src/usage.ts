/**
 * Rate-limit primitive — port of v1 `lib/usage-limiter.ts`. `invokeCapability`
 * calls `checkAndIncrement` before any capability whose `rateLimitClass !==
 * "default"`: atomically bump the workspace's monthly per-action counter,
 * compare to the plan's PLAN_LIMITS (an admin override wins outright), roll back
 * + throw `RateLimitExceededError` if it would exceed, then bump the per-user
 * counter for visibility. The DB ops sit behind an injectable `UsageStore`, so
 * this is unit-testable with no connection.
 *
 * Out of scope (see docs/SCOPE-DECISIONS.md): the full plan-resolution cache
 * (workspaceRepo.getPlan currently returns FREE) and the guest IP+UA bucket
 * (no public landing trial day-one).
 */
import { Collections, getDb, type PlanName, workspaceRepo } from "@ss/db";
import type { CapabilityContext } from "./registry";

export type RateLimitClass = CapabilityContext["rateLimitClass"];
type CountedClass = Exclude<RateLimitClass, "default">;

/** Monthly caps per plan × action. A missing entry ⇒ unlimited for that pair. ("default" is never checked.) */
export const PLAN_LIMITS: Record<PlanName, Partial<Record<CountedClass, number>>> = {
  FREE: { tiktok_read: 200, gmail_send: 50, llm: 200, shipment: 10, crm_enrich: 20 },
  STARTER: { tiktok_read: 2_000, gmail_send: 1_000, llm: 2_000, shipment: 200, crm_enrich: 500 },
  PRO: { tiktok_read: 5_000, gmail_send: 2_000, llm: 5_000, shipment: 500, crm_enrich: 1_000 },
  BEAUTY_VERIFIED: { tiktok_read: 5_000, gmail_send: 2_000, llm: 5_000, shipment: 500, crm_enrich: 1_000 },
  BUSINESS: { tiktok_read: 20_000, gmail_send: 10_000, llm: 20_000, shipment: 2_000, crm_enrich: 5_000 },
};

export class RateLimitExceededError extends Error {
  constructor(
    readonly action: RateLimitClass,
    readonly limit: number,
    readonly scope: "user" | "workspace",
    readonly scopeId: string,
  ) {
    super(`rate limit for "${action}" exceeded: ${limit}/month (${scope} ${scopeId})`);
    this.name = "RateLimitExceededError";
  }
}

export interface UsageStore {
  /** atomically $inc the (scope, scopeId, action, month) counter by 1; return the new value */
  increment(scope: "user" | "workspace", scopeId: string, action: RateLimitClass, month: string): Promise<number>;
  /** roll back one increment */
  decrement(scope: "user" | "workspace", scopeId: string, action: RateLimitClass, month: string): Promise<void>;
  /** active (not tombstoned, not expired) admin-override count for (userId, action), or null */
  getOverride(userId: string, action: RateLimitClass): Promise<number | null>;
}

/** "YYYY-MM" in UTC — the monthly bucket key (v1 parity). */
export function usageMonth(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const COUNTER_TTL_MS = 3 * 31 * 24 * 60 * 60 * 1000; // ~3 months — v1 parity

export function mongoUsageStore(): UsageStore {
  const colFor = (scope: "user" | "workspace") =>
    scope === "user" ? Collections.SHARED_USER_USAGE : Collections.SHARED_WORKSPACE_USAGE;
  return {
    async increment(scope, scopeId, action, month) {
      const db = await getDb();
      const res = (await db.collection(colFor(scope)).findOneAndUpdate(
        { scopeId, action, month },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + COUNTER_TTL_MS) } },
        { upsert: true, returnDocument: "after" },
      )) as { count?: number } | null;
      return res?.count ?? 1;
    },
    async decrement(scope, scopeId, action, month) {
      const db = await getDb();
      await db.collection(colFor(scope)).updateOne({ scopeId, action, month }, { $inc: { count: -1 } });
    },
    async getOverride(userId, action) {
      const db = await getDb();
      const doc = (await db
        .collection(Collections.SHARED_USAGE_LIMIT_OVERRIDES)
        .findOne({ userId, action, tombstoned: { $ne: true } })) as { limit?: number; expiresAt?: Date } | null;
      if (!doc || typeof doc.limit !== "number") return null;
      if (doc.expiresAt && new Date(doc.expiresAt).getTime() < Date.now()) return null;
      return doc.limit;
    },
  };
}

let _store: UsageStore | undefined;
export function getUsageStore(): UsageStore {
  return (_store ??= mongoUsageStore());
}
/** Pass `undefined` to reset to the default (mongo) store. */
export function setUsageStore(store: UsageStore | undefined): void {
  _store = store;
}

/**
 * Charge one capability invocation against the workspace's monthly quota for
 * `action`. No-op for "default". Throws `RateLimitExceededError` (after rolling
 * back the workspace counter) if it would exceed; otherwise also bumps the
 * per-user counter.
 */
export async function checkAndIncrement(workspaceId: string, userId: string, action: RateLimitClass): Promise<void> {
  if (action === "default") return;
  const store = getUsageStore();
  const month = usageMonth();
  const plan = await workspaceRepo.getPlan(workspaceId);
  const planLimit = (PLAN_LIMITS[plan] as Partial<Record<RateLimitClass, number>>)[action] ?? null;
  const override = await store.getOverride(userId, action);
  const limit = override ?? planLimit; // an admin override wins outright (even one that lowers the cap)
  if (limit === null) return; // unlimited for this (plan, action)

  const wsCount = await store.increment("workspace", workspaceId, action, month);
  if (wsCount > limit) {
    await store.decrement("workspace", workspaceId, action, month);
    throw new RateLimitExceededError(action, limit, "workspace", workspaceId);
  }
  await store.increment("user", userId, action, month);
}
