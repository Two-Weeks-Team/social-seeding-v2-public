/**
 * wooriliu-autopilot — runnable proof (goal brief P4-C) that v2 auto-completes
 * the `performanceAnalysis` step the source 우리리우 2차 campaign left `pending`.
 *
 * Self-boots an ephemeral in-memory mongo (no prod, no dev-mongo needed),
 * loads the read-only fixture, runs the autonomous back-half (campaign-autopilot)
 * with the default autonomous policy + a fake operator who approves the 2
 * required HITL gates, then prints the BEFORE (source: pending, 0 reach) vs
 * AFTER (v2: completed, real reach) and writes an AGGREGATE-ONLY artifact for
 * the public report (no PII — no handles, no emails).
 *
 *   pnpm exec tsx scripts/demo/wooriliu-autopilot.ts
 */
import { writeFileSync } from "node:fs";
import process from "node:process";
import { MongoMemoryServer } from "mongodb-memory-server";

async function main(): Promise<void> {
  const server = await MongoMemoryServer.create({ instance: { dbName: "social_seeding" } });
  process.env.MONGODB_URI = server.getUri() + "social_seeding";
  if (!process.env.AUTH_SECRET) process.env.AUTH_SECRET = "wooriliu-demo-secret-0123456789";

  // dynamic imports AFTER env is set so @ss/db connects to the ephemeral mongo.
  // Use relative source paths (root has no @ss/* deps; each package's own
  // node_modules resolves its cross-package @ss imports).
  const { campaignRepo, closeMongo, defaultPolicy } = await import("../../packages/db/src/index.ts");
  const { invokeCapability } = await import("../../packages/capabilities/src/index.ts");
  const { memorySink, setObservabilitySink } = await import("../../packages/observability/src/index.ts");
  const { AnalyticsReportSchema } = await import("../../packages/contracts/src/index.ts");
  const { campaignAutopilotHandler } = await import("../../packages/workflows/src/workflows/campaign-autopilot.ts");
  const { wooriliuCampaignInput } = await import("../../packages/workflows/src/fixtures/wooriliu.ts");

  setObservabilitySink(memorySink());

  const input = wooriliuCampaignInput();
  const campaign = await campaignRepo.create(input);
  const policy = defaultPolicy(campaign.brief.workspaceId);

  // a fake Inngest step: runs side-effects inline; auto-approves every gate that
  // parks for a human (simulating the operator clearing shipment + content).
  const step = {
    async run(_name: string, fn: () => Promise<unknown>) {
      return fn();
    },
    async sendEvent() {
      return { ids: [] };
    },
    async waitForEvent(name: string) {
      const approvalId = name.replace("await-approval:", "");
      return { data: { approvalId, campaignId: campaign.id, decision: "approved" as const } };
    },
  };

  const compile = async (campaignId: string, asOf: Date | undefined, workspaceId: string, userId: string) => {
    const raw = await invokeCapability(
      "analytics.compile",
      { campaignId, ...(asOf ? { asOf } : {}) },
      { workspaceId, userId, rateLimitClass: "default" },
    );
    return AnalyticsReportSchema.parse(raw);
  };

  const before = {
    workflowStep: "performanceAnalysis",
    sourceStatus: "pending",
    reach: { views: 0, engagement: 0, clicks: 0, conversions: 0, revenue: 0 },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await campaignAutopilotHandler({ campaign, policy, step: step as any, asOf: new Date("2025-12-01T00:00:00Z") }, { compile });

  console.log("\n=== 우리리우 2차 — v2 autonomous back-half ===\n");
  console.log("result:", out.kind);
  if (out.kind !== "completed") {
    console.log("halted at:", out.haltedAt, "—", out.reason);
    await closeMongo();
    await server.stop();
    process.exit(1);
  }

  console.log("stagesCompleted:", out.stagesCompleted.join(" → "));
  console.log("\ngate log (autonomous decisions + the 2 required HITL gates):");
  for (const g of out.gateLog) {
    console.log(`  · ${g.stage.padEnd(15)} [${g.kind}] → ${g.decision}${g.timedOut ? " (timeout fallback)" : ""}`);
  }

  const r = out.report;
  console.log("\n--- BEFORE (source instarsearch) ---");
  console.log(`  workflow step '${before.workflowStep}': ${before.sourceStatus}`);
  console.log(`  reach: views=${before.reach.views} engagement=${before.reach.engagement} (uncomputed)`);
  console.log("\n--- AFTER (v2 auto-completed) ---");
  console.log(`  campaign stage: performance / status: completed`);
  console.log(`  verified live posts: ${r.goals.verifiedCount} (target ${r.goals.targetLivePosts}, goalMet=${r.goals.goalMet})`);
  console.log(`  reach: views=${r.reach.verifiedViews} likes=${r.reach.verifiedLikes} comments=${r.reach.verifiedComments} shares=${r.reach.verifiedShares}`);
  const erPct = r.reach.weightedEngagementRate === null ? "n/a" : `${(r.reach.weightedEngagementRate * 100).toFixed(2)}%`;
  console.log(`  weighted engagement rate: ${erPct}`);
  console.log(`  performance score: avg=${r.performance.avgPerformanceScore} median=${r.performance.medianPerformanceScore}`);
  console.log(`  flags: ${r.flags.join(", ") || "(none)"}`);

  const persisted = await campaignRepo.get(campaign.id);
  console.log(`\n  mongo state: stage=${persisted?.stage} status=${persisted?.status}`);

  // ── AGGREGATE-ONLY artifact for the public report (NO PII) ──────────────
  const verified = r.tracks.filter((t) => t.performanceScore !== null);
  const leaderboard = verified
    .sort((a, b) => (b.performanceScore ?? 0) - (a.performanceScore ?? 0))
    .map((t, i) => ({ rank: i + 1, label: `Creator ${String(i + 1).padStart(2, "0")}`, views: t.views ?? 0, performanceScore: t.performanceScore ?? 0 }));
  const aggregate = {
    campaign: "우리리우 2차 (fixture, aggregates only — no PII)",
    generatedAt: r.generatedAt,
    funnel: r.funnel,
    goals: r.goals,
    reach: r.reach,
    // drop topPerformerCreatorId — it's a creator handle (PII). Aggregates only.
    performance: {
      avgPerformanceScore: r.performance.avgPerformanceScore,
      medianPerformanceScore: r.performance.medianPerformanceScore,
    },
    cost: r.cost,
    flags: r.flags,
    leaderboard,
    before,
  };
  // Resolve relative to this script file (robust to the caller's cwd).
  const outPath = new URL("../../claudedocs/wooriliu-report.aggregate.json", import.meta.url);
  writeFileSync(outPath, JSON.stringify(aggregate, null, 2));
  console.log(`\n  aggregate-only artifact (public-safe) → ${outPath.pathname}`);

  setObservabilitySink(undefined);
  await closeMongo();
  await server.stop();
  console.log("\nOK — performanceAnalysis auto-completed by v2.\n");
}

main().catch((err: unknown) => {
  console.error("wooriliu-autopilot failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
