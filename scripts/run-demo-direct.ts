/**
 * run-demo-direct — bypass brand-campaign and trigger creator-track directly.
 *
 * Why: the sourcing agent (Opus 4.7) sometimes flakes on schema adherence
 * during the runtime's reviser pass (real LLM behavior — not a code bug;
 * the agent occasionally tries another tool call when asked to revise).
 * For the demo we know the creator already (@sangguen2), so skipping
 * sourcing+vetting+shortlist exercises the more user-visible parts of
 * the loop:
 *   · outreach-writer (Opus 4.7) drafts a real personalized email
 *   · approveOutreachSend gate appears in MC /approvals
 *   · operator approves
 *   · gmail.send throws "Gmail not wired" (expected; no GOOGLE_CLIENT_*)
 *
 * Skipped: sourcing, vetting, shortlist. Walked: writer, gate, send-
 * attempt + the MC approval drill-in.
 *
 * Run AFTER scripts/run-demo.ts has created the campaign row, so the
 * approval surfaces under an existing campaign id you can inspect.
 */
import process from "node:process";
import { Events } from "@ss/contracts";
import { campaignRepo, closeMongo, Collections, creatorRepo, getDb } from "@ss/db";
import { inngest } from "@ss/workflows";

try {
  process.loadEnvFile(".env.local");
} catch { /* fall back to ambient env */ }

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let campaignId = argv.find((a) => a.startsWith("--campaign="))?.split("=")[1];
  const creatorHandle = (argv.find((a) => a.startsWith("--creator="))?.split("=")[1] ?? "sangguen2").replace(/^@/, "");

  // Resolve creator from accounts_tiktok
  const creator = await creatorRepo.getByUniqueId(creatorHandle);
  if (!creator) {
    throw new Error(`creator @${creatorHandle} not found in accounts_tiktok — seed it first`);
  }
  // Email is on the raw doc (additive field — not in the schema)
  const db = await getDb();
  const raw = await db
    .collection<{ contactEmail?: string }>(Collections.SHARED_TIKTOK_ACCOUNTS)
    .findOne({ uniqueId: creatorHandle }, { projection: { contactEmail: 1 } });
  const creatorEmail = raw?.contactEmail;
  if (!creatorEmail) {
    throw new Error(`@${creatorHandle} has no contactEmail in accounts_tiktok`);
  }

  // Find an existing campaign or create one
  if (!campaignId) {
    const c = await campaignRepo.create({
      brief: {
        workspaceId: "ws_demo",
        // Real Google userId of the Gmail-connected sender account
        // (kbeautypeople@gmail.com — token seeded in dev-mongo's
        // user_tokens). gmail.send's tokenManager.getToken matches by
        // userId or email. The 21-char Google id matches v1 parity.
        createdBy: process.env.DEMO_SENDER_USER_ID ?? "110923062954084576905",
        brandProduct: {
          name: "Hydra Demo Serum",
          category: "skincare/serum",
          description: "데모용 수분 세럼. 한국 20-30대 여성 타겟.",
          keyClaims: ["7-day hydration", "fragrance-free"],
        },
        targeting: {
          creatorCount: 1, minEngagementRate: 0.01,
          languages: ["ko"], hashtags: ["스킨케어", "kbeauty"],
          excludeBlacklist: true,
        },
        logistics: { shipsSamples: true },
        goals: {
          targetLivePosts: 1,
          deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          budgetUsd: 25,
        },
      },
      status: "running", stage: "outreach", tracks: [],
    });
    campaignId = c.id;
    console.log(`Created new demo campaign id=${campaignId}`);
  } else {
    console.log(`Using existing campaign id=${campaignId}`);
  }
  const campaign = await campaignRepo.get(campaignId);
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);

  console.log(`Triggering creator-track for @${creatorHandle} (${creatorEmail}) …`);
  await inngest.send({
    name: Events.CreatorTrackStart,
    data: {
      campaignId,
      brief: campaign.brief,
      creator,
      creatorEmail,
      recentPosts: [
        { desc: "겨울 보습 루틴 공유합니다 #스킨케어 #수분세럼", hashtags: ["스킨케어", "수분세럼"] },
        { desc: "신상 토너 패드 후기. 결정 단호 추천.", hashtags: ["토너", "kbeauty"] },
      ],
    },
  });
  console.log("✓ emitted campaign/creator-track.start");
  console.log(`\nWatch in MC: http://localhost:3000/campaigns/${campaignId}`);
  console.log(`Approvals will land at: http://localhost:3000/approvals`);
  console.log(`Inngest Dev runs: http://localhost:8288/runs`);
  await closeMongo();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 2;
});
