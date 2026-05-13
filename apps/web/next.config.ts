import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  // monorepo: this app is the workspace root for Turbopack, sources live one dir up
  turbopack: {
    root: path.join(import.meta.dirname, "..", ".."),
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
