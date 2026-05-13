import type { NextConfig } from "next";

const config: NextConfig = {
  // monorepo: transpile the workspace packages
  transpilePackages: ["@ss/contracts", "@ss/db", "@ss/capabilities", "@ss/workflows", "@ss/agents", "@ss/observability"],
  experimental: {
    // Mission Control is server-component heavy; keep server actions on.
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default config;
