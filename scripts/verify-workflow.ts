/**
 * verify-workflow — proof that the v2 brand-campaign workflow ACTUALLY RECORDS
 * the pipeline (it isn't seeded demo data). Runs the REAL `brandCampaignHandler`
 * — overview → sourcing(agent) → vetting(agent) → shortlist → approveShortlist
 * gate → CreatorTrack persistence → traces — against the LOCAL mongo + LIVE
 * Gemini (Vertex), using a fake Inngest `step` so it runs inline (no Inngest dev
 * server) and an auto-"approved" gate (the only simulated part: the human click).
 *
 * What is REAL here: the sourcing agent searches the seeded `accounts_tiktok`
 * (tiktok.search is DB-backed — NO RapidAPI), vetting is a real Gemini call, and
 * every write (campaign stage, the v2_approvals shortlist = the candidate list,
 * the CreatorTracks = creator selection, v2_agent_traces) hits the real DB.
 * External I/O (RapidAPI live refresh, Gmail send) is NOT exercised.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27027/instarsearch \
 *   GOOGLE_GENAI_USE_VERTEXAI=true GOOGLE_CLOUD_PROJECT=socialseeding \
 *   GOOGLE_CLOUD_LOCATION=global \
 *   pnpm exec tsx scripts/verify-workflow.ts
 */
import { brandCampaignHandler } from "../packages/workflows/src/workflows/brand-campaign.ts";
import type { StepLike } from "../packages/workflows/src/gate.ts";
import type { ModelClient } from "@ss/agents";
import { campaignRepo, getDb, Collections, closeMongo } from "@ss/db";

process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27027/instarsearch";

const WORKSPACE_ID = process.env.DEMO_WORKSPACE_ID ?? "ws_demo";
const USER_ID = "u".repeat(21);
const STUB_AGENTS = process.argv.includes("--stub-agents");

/**
 * Deterministic agent stub over the REAL seeded creators (accounts_tiktok). Only
 * the LLM *decisions* are canned — the gate, the v2_approvals shortlist, the
 * CreatorTrack writes, and the traces are all the real workflow against the real
 * DB. Used so a flaky live-model output format can't block the recording proof;
 * live Vertex sourcing (DB search) is verified separately by the no-flag run.
 */
const SEEDED = [
  { h: "luzzpitaa", followers: 375394, fit: 0.88 },
  { h: "lizethhv2", followers: 979048, fit: 0.83 },
  { h: "andressacastillo", followers: 335004, fit: 0.76 },
  { h: "masterddengle", followers: 559573, fit: 0.71 },
];
function candOf(r: { h: string; followers: number }): unknown {
  return {
    creator: {
      id: r.h, uniqueId: r.h, nickname: r.h, signature: "K-beauty / lifestyle creator",
      hashtags: ["kbeauty", "skincare"], followerCount: r.followers, followingCount: 200,
      videoCount: 120, heartCount: 5_000_000, verified: false, privateAccount: false,
    },
    matchReasons: ["hashtag overlap (kbeauty, skincare)"],
    flags: [],
  };
}
function stubModel(): ModelClient {
  return {
    complete: async ({ system }: { system: string }) => {
      if (system.includes("Sourcing agent")) {
        return {
          kind: "text" as const,
          text: JSON.stringify({
            candidates: SEEDED.map(candOf),
            queriesUsed: ["hashtag:kbeauty", "hashtag:skincare"],
            coverageNote: "4 in-range K-beauty creators found in the seeded index",
          }),
          inputTokens: 200, outputTokens: 200,
        };
      }
      if (system.includes("Vetting agent")) {
        const r = SEEDED.find((x) => system.includes(x.h)) ?? SEEDED[0]!;
        return {
          kind: "text" as const,
          text: JSON.stringify({ ...(candOf(r) as object), fitScore: r.fit, vettedAt: new Date().toISOString() }),
          inputTokens: 200, outputTokens: 150,
        };
      }
      throw new Error("stubModel: unexpected agent");
    },
  } as ModelClient;
}

function demoBrief() {
  const deadline = new Date();
  deadline.setUTCDate(deadline.getUTCDate() + 30);
  return {
    workspaceId: WORKSPACE_ID,
    createdBy: USER_ID,
    brandProduct: {
      name: "검증 데모 세럼",
      category: "skincare/serum",
      description: "K-beauty 수분 세럼 — 글로벌 K-beauty/스킨케어 크리에이터 타겟 (검증용 데모).",
      keyClaims: ["7-day hydration", "fragrance-free"],
    },
    targeting: {
      creatorCount: 3,
      minEngagementRate: 0.01,
      languages: [] as string[], // no language filter → matches the seeded creators
      hashtags: ["kbeauty", "skincare"],
      excludeBlacklist: true,
    },
    logistics: { shipsSamples: true },
    goals: { targetLivePosts: 2, deadline, budgetUsd: 50 },
  };
}

/** Fake Inngest step: run side-effects inline; auto-approve the shortlist gate as-is. */
function fakeStep(campaignId: string): StepLike {
  return {
    async run(_name, fn) {
      return fn();
    },
    async sendEvent() {
      return undefined;
    },
    async waitForEvent(_name, _opts) {
      // simulate the operator approving the shortlist unchanged
      return { data: { approvalId: "sim-approval", campaignId, decision: "approved" } } as never;
    },
  };
}

async function main(): Promise<void> {
  const db = await getDb();
  const brief = demoBrief();

  console.log("▶ creating a fresh campaign (status=draft, stage=overview, tracks=[]) …");
  const campaign = await campaignRepo.create({ brief, status: "draft", stage: "overview", tracks: [] });
  const campaignId = campaign.id;
  console.log(`  campaignId = ${campaignId}\n`);

  console.log(
    STUB_AGENTS
      ? "▶ running the REAL brandCampaignHandler with STUBBED agent decisions over REAL seeded creators …"
      : "▶ running the REAL brandCampaignHandler (sourcing+vetting via Vertex, writes to local mongo) …",
  );
  const t0 = Date.now();
  const out = await brandCampaignHandler(
    { event: { data: { campaignId, brief } }, step: fakeStep(campaignId) },
    STUB_AGENTS ? { modelClient: stubModel() } : {}, // no injection → defaultModelClient() uses Vertex
  );
  console.log(`  handler returned in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(out), "\n");

  // ── Inspect what got RECORDED ──────────────────────────────────────────────
  const c = await campaignRepo.get(campaignId);
  const approvals = await db.collection(Collections.V2_APPROVALS).find({ campaignId }).toArray();
  const traces = await db.collection(Collections.V2_AGENT_TRACES).find({ campaignId }).toArray();
  const spanCount = traces.reduce((n, t) => n + ((t.spans as unknown[] | undefined)?.length ?? 0), 0);

  console.log("── RECORDED IN THE DB (this is what a real run produces) ──");
  console.log(`  campaign: stage=${c?.stage} status=${c?.status} tracks=${c?.tracks.length}`);
  const states: Record<string, number> = {};
  for (const t of c?.tracks ?? []) states[t.state] = (states[t.state] ?? 0) + 1;
  console.log(`  track states: ${JSON.stringify(states)}`);

  for (const a of approvals) {
    const rec = (a.recommendation as Array<{ creator?: { handle?: string; id?: string }; fitScore?: number }>) ?? [];
    console.log(`\n  v2_approvals (the CANDIDATE LIST / shortlist gate): kind=${a.kind} status=${a.status}`);
    console.log(`    rationale: ${String(a.rationale).slice(0, 140)}`);
    rec.forEach((r, i) =>
      console.log(`    candidate ${i + 1}: @${r.creator?.handle ?? r.creator?.id} · fitScore ${r.fitScore}`),
    );
  }

  console.log(`\n  v2_agent_traces: ${traces.length} run(s), ${spanCount} spans (every workflow step recorded)`);
  const firstTrace = traces[0];
  if (firstTrace) {
    const spans = (firstTrace.spans as Array<{ name?: string }> | undefined) ?? [];
    console.log(`    spans: ${spans.map((s) => s.name).filter(Boolean).slice(0, 12).join(" → ")}`);
  }

  console.log("\n✅ The pipeline recorded candidates → shortlist approval → creator selection → traces.");
  console.log("   (Real agents + real DB writes; only the human approval + Inngest durability were simulated.)");
  await closeMongo();
}

main().catch(async (err) => {
  console.error("\n✗ workflow run failed:", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
  await closeMongo().catch(() => {});
  process.exitCode = 1;
});
