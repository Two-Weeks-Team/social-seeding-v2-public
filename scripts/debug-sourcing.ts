/**
 * debug-sourcing — direct sourcingAgent invocation with full output logging.
 */
import process from "node:process";
import type { CampaignBrief } from "@ss/contracts";
import { setUsageStore, type UsageStore } from "@ss/capabilities";
import { runAgent, sourcingAgent, type AgentRunContext } from "@ss/agents";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";

try { process.loadEnvFile(".env.local"); } catch { /* fall back */ }

setObservabilitySink(memorySink());
setUsageStore({
  async increment() { return 1; }, async decrement() {}, async getOverride() { return null; },
} as UsageStore);

async function main(): Promise<void> {
  const brief: CampaignBrief = {
    workspaceId: "ws_demo", createdBy: "110923062954084576905",
    brandProduct: {
      name: "Hydra Demo Serum", category: "skincare/serum",
      description: "데모용 수분 세럼. 한국 20-30대 여성 타겟.",
      keyClaims: ["7-day hydration", "fragrance-free"],
    },
    targeting: {
      creatorCount: 1, minEngagementRate: 0.01,
      languages: ["ko"], hashtags: ["스킨케어", "kbeauty"],
      excludeBlacklist: true,
    },
    logistics: { shipsSamples: true },
    goals: { targetLivePosts: 1, deadline: new Date(Date.now() + 30*24*60*60*1000) },
  };
  const trace = startTrace("debug_sourcing");
  const ctx: AgentRunContext = {
    capabilityCtx: { workspaceId: "ws_demo", userId: brief.createdBy, rateLimitClass: "default" },
    trace,
  };
  console.log("--- calling sourcingAgent ---");
  const out = await runAgent(sourcingAgent, { brief, excludeCreatorIds: [] }, ctx);
  console.log("\nkind:", out.kind);
  if (out.kind === "ok") {
    console.log("candidates:", out.value.candidates.length);
    console.log("queriesUsed:", out.value.queriesUsed);
    console.log("coverageNote:", out.value.coverageNote);
    for (const c of out.value.candidates) {
      console.log(`  · @${c.creator.uniqueId}: ${c.matchReasons.join(" | ")}`);
    }
  } else {
    console.log("reason:", out.reason);
    if ("partial" in out && out.partial) {
      console.log("\npartial (first 3000):");
      console.log(String(out.partial).slice(0, 3000));
    }
  }
  console.log("\nusd:", out.usd);
  process.exit(0);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : String(e)); process.exit(2); });
