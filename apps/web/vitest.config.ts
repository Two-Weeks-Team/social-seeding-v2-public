import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * AP2 component tests run in JSDOM (we need the WebAuthn-shaped DOM types +
 * React Testing Library's renderer). They are isolated from the server-side
 * Mongo-backed repositories.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["__tests__/**/*.test.{ts,tsx}"],
    globals: false,
    setupFiles: ["__tests__/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
});
