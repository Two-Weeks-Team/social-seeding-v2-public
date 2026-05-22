import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * AP2 component tests run in JSDOM (we need the WebAuthn-shaped DOM types +
 * React Testing Library's renderer). They are isolated from the server-side
 * Mongo-backed repositories.
 */
export default defineConfig({
  // The .tsx component tests don't `import React` — they rely on the automatic
  // JSX runtime (react/jsx-runtime), same as Next.js. esbuild defaults to the
  // classic runtime (`React.createElement`), which throws "React is not defined"
  // at render. Pin the automatic runtime so vitest matches the app's transform.
  esbuild: { jsx: "automatic" },
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
