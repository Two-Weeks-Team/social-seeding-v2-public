import { defineConfig } from "vitest/config";

/**
 * Workflow tests share dev-mongo's v2_approvals / v2_campaigns / accounts_tiktok
 * collections (same reason as @ss/capabilities). Serialize files so one's
 * beforeEach deleteMany doesn't race another's reads.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
