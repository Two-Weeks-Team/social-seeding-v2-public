import { defineConfig } from "vitest/config";

/**
 * Capability tests share the dev-mongo `accounts_tiktok` / `influencer_blacklist`
 * collections (the SHARED v1 names — not mockable per-file). Serialize test
 * files so one's `deleteMany({})` doesn't race another's reads.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
