/**
 * debug-writer — direct call to outreachWriterAgent with logging. Lets us
 * see WHY the writer is escalating "insufficient_context" in the live
 * demo. Bypasses Inngest + creator-track.
 */
import process from "node:process";
import type { CampaignBrief } from "@ss/contracts";
import { creatorRepo } from "@ss/db";
import { invokeCapability, setUsageStore, type UsageStore } from "@ss/capabilities";
import type { OutreachFacts } from "@ss/contracts";
import {
  outreachWriterAgent,
  runAgent,
  type AgentRunContext,
} from "@ss/agents";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";

try { process.loadEnvFile(".env.local"); } catch { /* fall back */ }

const sink = memorySink();
setObservabilitySink(sink);
const memUsage: UsageStore = {
  async increment() { return 1; }, async decrement() {}, async getOverride() { return null; },
};
setUsageStore(memUsage);

async function main(): Promise<void> {
  const creator = await creatorRepo.getByUniqueId("sangguen2");
  if (!creator) throw new Error("creator not seeded");
  console.log("Creator signature:", JSON.stringify(creator.signature));
  console.log("Creator hashtags:", creator.hashtags);

  const brief: CampaignBrief = {
    workspaceId: "ws_demo", createdBy: "u".repeat(21),
    brandProduct: {
      name: "Hydra Demo Serum", category: "skincare/serum",
      description: "수분 세럼.", keyClaims: ["7-day hydration", "fragrance-free"],
    },
    targeting: { creatorCount: 1, minEngagementRate: 0.01, languages: ["ko"], hashtags: ["스킨케어"], excludeBlacklist: true },
    logistics: { shipsSamples: true },
    goals: { targetLivePosts: 1, deadline: new Date(Date.now() + 30*24*60*60*1000) },
  };

  const recentPosts = [
    { desc: "겨울 보습 루틴 공유합니다 #스킨케어 #수분세럼", hashtags: ["스킨케어", "수분세럼"] },
    { desc: "신상 토너 패드 후기. 결정 단호 추천.", hashtags: ["토너", "kbeauty"] },
  ];

  const trace = startTrace("debug_writer");
  const ctx: AgentRunContext = {
    capabilityCtx: { workspaceId: "ws_demo", userId: "u".repeat(21), rateLimitClass: "default" },
    trace,
  };

  // Compute facts up-front (mimics creator-track's behavior).
  const facts = (await invokeCapability(
    "outreach.extractFacts",
    { brief, creator, recentPosts },
    ctx.capabilityCtx,
  )) as OutreachFacts;
  console.log("Facts.hasMinimumContext:", facts.hasMinimumContext);
  console.log("Facts.recentPostThemes:", facts.creator.recentPostThemes);

  console.log("\n--- calling outreachWriterAgent ---\n");
  const out = await runAgent(
    outreachWriterAgent,
    { brief, creator, recentPosts, facts, voiceNotes: "", signatureBlock: "", bannedPhrases: [] },
    ctx,
  );
  console.log("\n--- result ---");
  console.log("kind:", out.kind);
  if (out.kind === "ok") {
    console.log("draft subject:", out.value.subject);
    console.log("draft body:\n", out.value.body);
    console.log("usd:", out.usd);
  } else {
    console.log("reason:", out.reason);
    console.log("usd:", out.usd);
    if ("partial" in out && out.partial) console.log("\npartial:\n" + String(out.partial).slice(0, 2000));
  }

  console.log("\n--- spans ---");
  for (const t of sink.traces) {
    for (const s of t.spans) {
      let line = `  · ${s.kind} ${s.name}`;
      if (s.attrs) line += ` attrs=${JSON.stringify(s.attrs).slice(0, 300)}`;
      console.log(line);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(2);
});
