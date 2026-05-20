import path from "node:path";
import type { NextConfig } from "next";

// Monorepo root (two dirs up from apps/web). Used by Turbopack, and by
// standalone output file tracing so `.next/standalone` bundles the workspace
// node_modules + @ss/* packages rather than just apps/web's local tree.
const monorepoRoot = path.join(import.meta.dirname, "..", "..");

const config: NextConfig = {
  // `output: 'standalone'` is opt-in via NEXT_OUTPUT so the deploy concern
  // (Cloud Run / Docker image) doesn't change local `next dev`/`next start`.
  // The Dockerfile (deploy/web/Dockerfile) sets NEXT_OUTPUT=standalone.
  ...(process.env.NEXT_OUTPUT === "standalone"
    ? { output: "standalone" as const, outputFileTracingRoot: monorepoRoot }
    : {}),
  // monorepo: this app is the workspace root for Turbopack, sources live one dir up
  turbopack: {
    root: monorepoRoot,
  },
  // transpile the workspace packages (JIT internal packages — exports point at src/)
  transpilePackages: [
    "@ss/contracts",
    "@ss/db",
    "@ss/capabilities",
    "@ss/agents",
    "@ss/workflows",
    "@ss/observability",
  ],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default config;
