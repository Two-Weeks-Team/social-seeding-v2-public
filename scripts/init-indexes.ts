/**
 * Create the indexes the v2_* collections rely on. Idempotent — `createIndex`
 * is a no-op when the index already exists, so this is safe to re-run after a
 * deploy or before first use:
 *
 *   pnpm exec tsx scripts/init-indexes.ts          # or: pnpm run init-indexes
 *
 * Connects to MONGODB_URI / MONGODB_DB — the SAME Atlas cluster v1 uses
 * (FREEZE.md §3). v2 owns only the `v2_*` collections; this script never
 * touches v1's. Loads `.env.local` if present (otherwise the ambient env).
 *
 * TTL note: the per-run trace docs (v2_agent_traces) and cost-ledger rows
 * (v2_cost_ledger) get a TTL on a date field — `startedAt` / `at` respectively.
 * MongoDB's TTL monitor only acts when that field is a BSON Date, so the P0-4
 * observability sinks must write those as Dates (not epoch numbers). Compound
 * keys can't carry expireAfterSeconds, hence the standalone single-field TTLs.
 */
import process from "node:process";
import { Collections, closeMongo, getDb } from "@ss/db";

try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local — fall back to whatever's already in the environment
}

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

interface IndexPlan {
  collection: string;
  keys: Record<string, 1 | -1>;
  options?: { unique?: boolean; expireAfterSeconds?: number; name?: string };
}

const PLANS: IndexPlan[] = [
  // v2_campaigns — list a workspace's campaigns newest-first
  { collection: Collections.V2_CAMPAIGNS, keys: { "brief.workspaceId": 1, updatedAt: -1 } },
  // v2_creator_tracks — one creator's track within a campaign
  { collection: Collections.V2_CREATOR_TRACKS, keys: { campaignId: 1, creatorId: 1 } },
  // v2_approvals — the inbox query (open approvals per workspace) + per-campaign
  { collection: Collections.V2_APPROVALS, keys: { workspaceId: 1, status: 1 } },
  { collection: Collections.V2_APPROVALS, keys: { campaignId: 1 } },
  // v2_agent_traces — the activity-timeline query + a 1y TTL
  { collection: Collections.V2_AGENT_TRACES, keys: { campaignId: 1, startedAt: -1 } },
  { collection: Collections.V2_AGENT_TRACES, keys: { startedAt: 1 }, options: { expireAfterSeconds: ONE_YEAR_SECONDS, name: "ttl_startedAt" } },
  // v2_cost_ledger — per-campaign sum (budget checks) + per-workspace monthly rollup + a 1y TTL
  { collection: Collections.V2_COST_LEDGER, keys: { campaignId: 1 } },
  { collection: Collections.V2_COST_LEDGER, keys: { workspaceId: 1, at: -1 } },
  { collection: Collections.V2_COST_LEDGER, keys: { at: 1 }, options: { expireAfterSeconds: ONE_YEAR_SECONDS, name: "ttl_at" } },
  // v2_workspace_policies — at most one policy per workspace (workspaceRepo upserts on this key)
  { collection: Collections.V2_WORKSPACE_POLICIES, keys: { workspaceId: 1 }, options: { unique: true } },
  // v2_outbox — gmail.send idempotency (unique on idempotencyKey) + scheduled-send queue scan
  { collection: Collections.V2_OUTBOX, keys: { idempotencyKey: 1 }, options: { unique: true } },
  { collection: Collections.V2_OUTBOX, keys: { status: 1, sendAt: 1 } },
  // v2_outbox — webhook lookup by Gmail threadId once the send is sealed
  { collection: Collections.V2_OUTBOX, keys: { threadId: 1, status: 1 } },
  // v2_gmail_watches — one row per emailAddress; webhook reads + persists the lastHistoryId
  { collection: Collections.V2_GMAIL_WATCHES, keys: { emailAddress: 1 }, options: { unique: true } },
  // v2_suppression_list — unique key by recipient email; gmail.send checks pre-send
  { collection: Collections.V2_SUPPRESSION_LIST, keys: { email: 1 }, options: { unique: true } },
];

function looksUnconfigured(uri: string | undefined): boolean {
  return !uri || !uri.startsWith("mongodb") || uri.includes("...");
}

async function main(): Promise<void> {
  if (looksUnconfigured(process.env.MONGODB_URI)) {
    throw new Error(
      `MONGODB_URI is not a real connection string (got ${JSON.stringify(process.env.MONGODB_URI)}). ` +
        "Fill it in .env.local (the shared v1 Atlas, or a dev cluster) first.",
    );
  }
  const dbName = process.env.MONGODB_DB ?? "social_seeding";
  const db = await getDb();
  console.log(`Ensuring ${PLANS.length} index(es) on "${dbName}" …`);
  for (const plan of PLANS) {
    const name = await db.collection(plan.collection).createIndex(plan.keys, plan.options ?? {});
    const tags = [
      plan.options?.unique ? "unique" : null,
      plan.options?.expireAfterSeconds ? `TTL ${plan.options.expireAfterSeconds}s` : null,
    ].filter((t): t is string => t !== null);
    console.log(`  ${plan.collection}.${name}${tags.length ? ` (${tags.join(", ")})` : ""}`);
  }
  console.log("✓ done");
  await closeMongo();
}

main().catch((err: unknown) => {
  console.error("init-indexes failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
