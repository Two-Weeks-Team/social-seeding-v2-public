import { afterEach, describe, expect, it } from "vitest";
import { checkAndIncrement, PLAN_LIMITS, RateLimitExceededError, setUsageStore, type UsageStore, usageMonth } from "./usage";

/**
 * P0-6 proof: the rate-limit primitive — no-op on "default", increments
 * workspace + user counters under the cap, throws + rolls back over the FREE
 * cap, and an admin override wins (even when it lowers the cap). Uses an
 * in-memory UsageStore — no database.
 */

function memoryUsageStore(overrides: Record<string, number> = {}): UsageStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const key = (scope: string, id: string, action: string, month: string) => `${scope}|${id}|${action}|${month}`;
  return {
    counts,
    async increment(scope, scopeId, action, month) {
      const k = key(scope, scopeId, action, month);
      const next = (counts.get(k) ?? 0) + 1;
      counts.set(k, next);
      return next;
    },
    async decrement(scope, scopeId, action, month) {
      const k = key(scope, scopeId, action, month);
      counts.set(k, Math.max(0, (counts.get(k) ?? 0) - 1));
    },
    async getOverride(userId, action) {
      return overrides[`${userId}|${action}`] ?? null;
    },
  };
}

afterEach(() => {
  setUsageStore(undefined); // back to the mongo default
});

describe("usage.checkAndIncrement", () => {
  it("is a no-op for the 'default' rate-limit class", async () => {
    const store = memoryUsageStore();
    setUsageStore(store);
    await checkAndIncrement("ws", "u", "default");
    expect(store.counts.size).toBe(0);
  });

  it("increments the workspace and user counters when under the limit", async () => {
    const store = memoryUsageStore();
    setUsageStore(store);
    const month = usageMonth();
    await checkAndIncrement("ws", "u", "tiktok_read");
    await checkAndIncrement("ws", "u", "tiktok_read");
    expect(store.counts.get(`workspace|ws|tiktok_read|${month}`)).toBe(2);
    expect(store.counts.get(`user|u|tiktok_read|${month}`)).toBe(2);
  });

  it("throws RateLimitExceededError and rolls the workspace counter back over the FREE cap", async () => {
    const store = memoryUsageStore();
    setUsageStore(store);
    const month = usageMonth();
    const cap = PLAN_LIMITS.FREE.gmail_send ?? 50;
    for (let i = 0; i < cap; i++) await checkAndIncrement("ws", "u", "gmail_send");
    expect(store.counts.get(`workspace|ws|gmail_send|${month}`)).toBe(cap);
    await expect(checkAndIncrement("ws", "u", "gmail_send")).rejects.toBeInstanceOf(RateLimitExceededError);
    // rolled back — still exactly at the cap, not cap + 1
    expect(store.counts.get(`workspace|ws|gmail_send|${month}`)).toBe(cap);
  });

  it("honors an admin override even when it lowers the cap", async () => {
    const store = memoryUsageStore({ "u|llm": 1 });
    setUsageStore(store);
    await checkAndIncrement("ws", "u", "llm"); // 1st — ok (override cap is 1)
    await expect(checkAndIncrement("ws", "u", "llm")).rejects.toBeInstanceOf(RateLimitExceededError);
  });
});
