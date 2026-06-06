/**
 * DEMO-ONLY (local): mirror the REAL 37-thread campaign email history onto the
 * demo workspaces so every demo copy of the 우리리우 campaign shows the full
 * conversation — not just the 5 synthetic threads the earlier seed left behind.
 *
 * The authentic two-way history (seeded by seed-threads-from-backend.ts) lives on
 * the ws_wooriliu_2nd copy (campaign 6a1f6ffd6dcae518cfc59ad2). The ws_demo /
 * ws_test copies share the same 37 creators (tracks) but only had 5 threads, so
 * /threads + /campaigns/[id]/threads looked truncated. This clones the source
 * messages onto each target, swapping only workspaceId + campaignId (threadId /
 * messageId stay — they're workspace-scoped at query time; no unique index on
 * v2_messages besides _id, which Mongo regenerates on insert).
 *
 * Idempotent: deletes each target campaign's existing v2_messages first, then
 * re-inserts the full clone. Local-only data; reads/writes the local mongo.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27027/instarsearch \
 *   pnpm exec tsx scripts/demo/clone-threads-to-demo-workspaces.ts
 */
import { MongoClient } from "mongodb";

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27027/instarsearch";
const SOURCE_CAMPAIGN = process.env.SOURCE_CAMPAIGN ?? "6a1f6ffd6dcae518cfc59ad2"; // ws_wooriliu_2nd

// target campaignId → workspaceId (the demo copies of the same campaign)
const TARGETS: Record<string, string> = {
  "6a1f7e5ef12d2222b15284ea": "ws_demo",
  "6a1f7e5ef12d2222b15284ed": "ws_test",
};

async function main() {
  const client = new MongoClient(URI);
  await client.connect();
  const messages = client.db().collection("v2_messages");

  const source = await messages.find({ campaignId: SOURCE_CAMPAIGN }).toArray();
  if (source.length === 0) {
    throw new Error(`source campaign ${SOURCE_CAMPAIGN} has no v2_messages — nothing to clone`);
  }
  const sourceThreads = new Set(source.map((d) => d.threadId)).size;
  console.log(`source ${SOURCE_CAMPAIGN}: ${source.length} messages across ${sourceThreads} threads`);

  for (const [campaignId, workspaceId] of Object.entries(TARGETS)) {
    const removed = await messages.deleteMany({ campaignId });
    const clones = source.map(({ _id, ...rest }) => ({ ...rest, workspaceId, campaignId }));
    await messages.insertMany(clones);
    const threads = (await messages.distinct("threadId", { campaignId })).length;
    console.log(`  → ${workspaceId} / ${campaignId}: removed ${removed.deletedCount}, inserted ${clones.length} (${threads} threads)`);
  }

  await client.close();
  console.log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
