/**
 * seed-demo-campaigns — (re)create the 9 demo campaigns with their STABLE ids so
 * the seeded v2_messages / covers re-link. Three products × three workspaces:
 *   · 우리리우        — fixture-backed (37 tracks, 16 verified) · performance/completed
 *   · 히알루 수분세럼·6월 — empty shell · sourcing/running
 *   · 리페어 나이트크림·5월 — empty shell · performance/completed
 *
 * The ids are fixed (the v2_messages collection references them by campaignId),
 * so this is the reproducible seed for the demo workspaces. IDEMPOTENT and SAFE:
 * it deletes ONLY these specific _ids, never deleteMany({}).
 *
 * After running, re-run scripts/demo/refresh-post-covers.ts to re-patch the
 * 우리리우 tracks' cover images.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27027/instarsearch \
 *   pnpm exec tsx scripts/demo/seed-demo-campaigns.ts
 */
import { MongoClient, ObjectId } from "mongodb";

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27027/instarsearch";

type Kind = "wooriliu" | "hyalu" | "repair";
interface Spec {
  id: string;
  ws: string;
  kind: Kind;
  stage: string;
  status: string;
  createdAt: string;
}
const SPECS: Spec[] = [
  { id: "6a1f6ffd6dcae518cfc59ad2", ws: "ws_wooriliu_2nd", kind: "wooriliu", stage: "performance", status: "completed", createdAt: "2026-06-03T00:06:21.062Z" },
  { id: "6a1f6ffd6dcae518cfc59ad3", ws: "ws_wooriliu_2nd", kind: "hyalu", stage: "sourcing", status: "running", createdAt: "2026-06-03T00:06:21.087Z" },
  { id: "6a1f6ffd6dcae518cfc59ad4", ws: "ws_wooriliu_2nd", kind: "repair", stage: "performance", status: "completed", createdAt: "2026-06-03T00:06:21.088Z" },
  { id: "6a1f7e5ef12d2222b15284ea", ws: "ws_demo", kind: "wooriliu", stage: "performance", status: "completed", createdAt: "2026-06-03T01:07:42.778Z" },
  { id: "6a1f7e5ef12d2222b15284eb", ws: "ws_demo", kind: "hyalu", stage: "sourcing", status: "running", createdAt: "2026-06-03T01:07:42.779Z" },
  { id: "6a1f7e5ef12d2222b15284ec", ws: "ws_demo", kind: "repair", stage: "performance", status: "completed", createdAt: "2026-06-03T01:07:42.780Z" },
  { id: "6a1f7e5ef12d2222b15284ed", ws: "ws_test", kind: "wooriliu", stage: "performance", status: "completed", createdAt: "2026-06-03T01:07:42.781Z" },
  { id: "6a1f7e5ef12d2222b15284ee", ws: "ws_test", kind: "hyalu", stage: "sourcing", status: "running", createdAt: "2026-06-03T01:07:42.782Z" },
  { id: "6a1f7e5ef12d2222b15284ef", ws: "ws_test", kind: "repair", stage: "performance", status: "completed", createdAt: "2026-06-03T01:07:42.783Z" },
];

function shellBrief(ws: string, kind: "hyalu" | "repair") {
  const common = {
    workspaceId: ws,
    createdBy: "f".repeat(21),
    targeting: { creatorCount: kind === "hyalu" ? 8 : 6, minEngagementRate: 0.02, languages: ["ko"], hashtags: ["스킨케어", "kbeauty"], excludeBlacklist: true },
    logistics: { shipsSamples: true },
  };
  if (kind === "hyalu") {
    return {
      ...common,
      brandProduct: { name: "히알루 수분세럼 · 6월", category: "skincare/serum", description: "히알루론산 수분 세럼 — 6월 신규 캠페인. 현재 크리에이터 소싱 단계.", keyClaims: ["72시간 보습", "무향"] },
      goals: { targetLivePosts: 6, deadline: new Date("2026-06-30T00:00:00Z"), budgetUsd: 600 },
    };
  }
  return {
    ...common,
    brandProduct: { name: "리페어 나이트크림 · 5월", category: "skincare/cream", description: "밤사이 장벽 리페어 나이트크림 — 5월 캠페인.", keyClaims: ["overnight repair", "민감성 적합"] },
    goals: { targetLivePosts: 6, deadline: new Date("2026-05-31T00:00:00Z"), budgetUsd: 500 },
  };
}

async function main(): Promise<void> {
  const { wooriliuBrief, wooriliuTracks } = await import("../../packages/workflows/src/fixtures/wooriliu.ts");
  const client = new MongoClient(URI);
  await client.connect();
  const col = client.db().collection("v2_campaigns");

  const ids = SPECS.map((s) => ObjectId.createFromHexString(s.id));
  const removed = await col.deleteMany({ _id: { $in: ids } }); // targeted only — never deleteMany({})
  console.log(`[seed-demo] cleared ${removed.deletedCount} existing (by id)`);

  const docs = SPECS.map((s) => {
    const createdAt = new Date(s.createdAt);
    const brief =
      s.kind === "wooriliu" ? { ...wooriliuBrief(), workspaceId: s.ws } : shellBrief(s.ws, s.kind);
    const tracks = s.kind === "wooriliu" ? wooriliuTracks() : [];
    return { _id: ObjectId.createFromHexString(s.id), brief, status: s.status, stage: s.stage, tracks, createdAt, updatedAt: createdAt };
  });
  await col.insertMany(docs as never[]);

  const byWs: Record<string, number> = {};
  for (const s of SPECS) byWs[s.ws] = (byWs[s.ws] ?? 0) + 1;
  console.log(`[seed-demo] inserted ${docs.length} campaigns:`, JSON.stringify(byWs));
  for (const d of docs) {
    const trackCount = (d.tracks as unknown[]).length;
    console.log(`  ${d._id.toHexString()} · ${(d.brief as { brandProduct: { name: string } }).brandProduct.name} · ${d.stage}/${d.status} · tracks ${trackCount}`);
  }
  await client.close();
  console.log("done. → now run scripts/demo/refresh-post-covers.ts to restore covers.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
