/**
 * wooriliu-seed — insert the 우리리우 2차 fixture campaign (already through the
 * autonomous back-half: stage=performance, status=completed, 16 verified
 * tracks) into the mongo at $MONGODB_URI, so the Mission Control performance
 * page (/campaigns/[id]/performance) can render it. Prints the campaign id.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27027/social_seeding \
 *     pnpm exec tsx scripts/demo/wooriliu-seed.ts
 */
import process from "node:process";

async function main(): Promise<void> {
  if (!process.env.MONGODB_URI) {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27027/social_seeding";
  }
  const { campaignRepo, closeMongo, getDb, Collections } = await import("../../packages/db/src/index.ts");
  const { wooriliuCampaignInput } = await import("../../packages/workflows/src/fixtures/wooriliu.ts");

  // idempotent: clear any prior fixture campaign for this workspace
  const db = await getDb();
  await db.collection(Collections.V2_CAMPAIGNS).deleteMany({ "brief.workspaceId": "ws_wooriliu_2nd" });

  const input = wooriliuCampaignInput();
  const campaign = await campaignRepo.create({ ...input, stage: "performance", status: "completed" });
  console.log("CAMPAIGN_ID=" + campaign.id);
  console.log("WORKSPACE_ID=" + campaign.brief.workspaceId);
  await closeMongo();
}

main().catch((err: unknown) => {
  console.error("wooriliu-seed failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
