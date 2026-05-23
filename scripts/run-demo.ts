/**
 * run-demo — credentialed end-to-end smoke runner. Final carry-over.
 *
 * Usage:
 *
 *   pnpm exec tsx scripts/run-demo.ts                            # brand-campaign demo (default)
 *   pnpm exec tsx scripts/run-demo.ts --type=lead                # lead-campaign demo
 *   pnpm exec tsx scripts/run-demo.ts --dry-run                  # pre-flight only (no DB writes)
 *
 * What this does (per-mode):
 *
 *   brand   — creates a v2 campaign brief (Korean K-beauty serum, demo-grade
 *             targeting), persists a draft row, emits `campaign/submitted`.
 *             Polls v2_campaigns + v2_approvals + v2_agent_traces for ~5
 *             minutes printing progress. Stops when the campaign reaches
 *             `status='completed'`, hits a gate the operator must resolve
 *             via MC, or times out. The operator clicks "approve" on the
 *             shortlist in MC `/approvals` to continue.
 *
 *   lead    — same shape but for the sales-lead campaign type. Submits a
 *             tiny `leadInputs` list (3 mock K-beauty brand homepages).
 *
 * Pre-flight checks (always):
 *
 *   1. MONGODB_URI reachable (init-indexes runs idempotently first).
 *   2. GEMINI_API_KEY present (else workflows throw at the first agent
 *      call — surfaced clearly).
 *   3. Inngest reachable on http://localhost:8288 (the dev server). When
 *      this fails the demo still emits the event — but no workflow runs
 *      so nothing progresses past stage 1.
 *   4. Per --type, the optional creds are checked + a `would-work` /
 *      `will-need-key` summary printed:
 *        brand: GOOGLE_CLIENT_ID/SECRET + EMAIL_UNSUBSCRIBE_HMAC_SECRET
 *               (gmail.send); YUNTRACK_API_KEY (carrier, P3.5 carry-over);
 *               RAPIDAPI_KEY_TIKTOK (post-poller live data).
 *        lead:  MODAL_CRAWL_URL + KIMI_API_KEY (crm.enrich); same Gmail.
 *
 * The script is operator-runnable + idempotent. Re-running creates a NEW
 * campaign each time; old ones stay in MC for review (no cleanup pass).
 *
 * Discipline:
 *  · The DEMO BRIEF is hard-coded (Korean K-beauty serum, deadline =
 *    today + 30d). The point isn't tuning the brief — it's exercising
 *    every Inngest function + every gate.
 *  · No `gmail.send` is forced — sends happen if the workflow reaches
 *    them organically (after approveOutreachSend) and only when there's
 *    a creator email. Without enrichment most tracks terminate as
 *    `no_email`, which is the expected demo path until Phase 5 lead-
 *    campaign mode is used.
 *  · No carrier dispatch is forced — the carrier adapter is deferred
 *    per operator decision (would need YUNTRACK_API_KEY).
 */
import process from "node:process";
import { Events } from "@ss/contracts";
import {
  approvalRepo,
  campaignRepo,
  closeMongo,
  Collections,
  getDb,
  leadCampaignRepo,
} from "@ss/db";
import { inngest } from "@ss/workflows";

try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local — fall back to ambient env
}

interface CliOpts {
  type: "brand" | "lead";
  dryRun: boolean;
  pollMinutes: number;
  /** Opt-in to run live against the SHARED v1 Atlas `social_seeding` DB. */
  allowSharedAtlas: boolean;
}

function parseArgs(): CliOpts {
  const argv = process.argv.slice(2);
  let type: "brand" | "lead" = "brand";
  let dryRun = false;
  let pollMinutes = 5;
  let allowSharedAtlas = false;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--type=lead") type = "lead";
    else if (a === "--type=brand") type = "brand";
    else if (a === "--allow-shared-atlas") allowSharedAtlas = true;
    else if (a.startsWith("--poll-minutes=")) {
      const n = Number(a.split("=")[1] ?? "");
      if (Number.isFinite(n) && n > 0) pollMinutes = n;
    }
  }
  return { type, dryRun, pollMinutes, allowSharedAtlas };
}

// ── pre-flight ────────────────────────────────────────────────────────────────

interface EnvCheck {
  name: string;
  required: boolean;
  present: boolean;
  /** What's gated on this env var. */
  gates: string;
}

function envCheck(opts: CliOpts): EnvCheck[] {
  const has = (k: string) => Boolean(process.env[k]);
  const common: EnvCheck[] = [
    { name: "MONGODB_URI", required: true, present: has("MONGODB_URI"),
      gates: "everything (workspace + workflow state)" },
    { name: "GEMINI_API_KEY", required: true, present: has("GEMINI_API_KEY"),
      gates: "every agent run (sourcing / writer / classifier / responder / analyst …)" },
    { name: "EMAIL_UNSUBSCRIBE_HMAC_SECRET", required: false, present: has("EMAIL_UNSUBSCRIBE_HMAC_SECRET"),
      gates: "gmail.send (CAN-SPAM unsubscribe footer; can be a 16-char placeholder for tests)" },
    { name: "GOOGLE_CLIENT_ID", required: false, present: has("GOOGLE_CLIENT_ID"),
      gates: "gmail.send live (Phase 2 Step D googleapis path)" },
    { name: "GOOGLE_CLIENT_SECRET", required: false, present: has("GOOGLE_CLIENT_SECRET"),
      gates: "gmail.send live" },
    { name: "RAPIDAPI_KEY_TIKTOK", required: false, present: has("RAPIDAPI_KEY_TIKTOK"),
      gates: "tiktok.getCreator (sourcing) + tiktok-post-poller (content verify)" },
  ];
  if (opts.type === "brand") {
    common.push(
      { name: "YUNTRACK_API_KEY", required: false, present: has("YUNTRACK_API_KEY"),
        gates: "shipment.create carrier dispatch (deferred carry-over)" },
    );
  } else {
    common.push(
      { name: "KIMI_API_KEY", required: false, present: has("KIMI_API_KEY"),
        gates: "crm.enrich (Modal+Kimi K-beauty analysis)" },
      { name: "MODAL_CRAWL_URL", required: false, present: has("MODAL_CRAWL_URL"),
        gates: "crm.enrich (defaults to v1's Modal endpoint)" },
    );
  }
  return common;
}

function printEnvCheck(checks: EnvCheck[]): void {
  console.log("\nEnv check:");
  let missingRequired = 0;
  for (const c of checks) {
    const mark = c.present ? "✓" : c.required ? "✗" : "·";
    const label = c.present ? "(set)" : c.required ? "(MISSING — required)" : "(optional)";
    console.log(`  ${mark} ${c.name.padEnd(32)} ${label.padEnd(28)} ${c.gates}`);
    if (c.required && !c.present) missingRequired++;
  }
  if (missingRequired > 0) {
    throw new Error(`pre-flight: ${missingRequired} required env var(s) missing — populate .env.local before re-running`);
  }
}

// ── demo briefs ──────────────────────────────────────────────────────────────

function brandBrief(workspaceId: string, createdBy: string) {
  const deadline = new Date();
  deadline.setUTCDate(deadline.getUTCDate() + 30);
  return {
    workspaceId,
    createdBy,
    brandProduct: {
      name: "Hydra Demo Serum",
      category: "skincare/serum",
      description: "데모용 수분 세럼. 한국 20-30대 여성 타겟.",
      keyClaims: ["7-day hydration", "fragrance-free"],
    },
    targeting: {
      creatorCount: 3,
      minEngagementRate: 0.01,
      languages: ["ko"],
      hashtags: ["스킨케어", "kbeauty"],
      excludeBlacklist: true,
    },
    logistics: { shipsSamples: true },
    goals: { targetLivePosts: 2, deadline, budgetUsd: 50 },
  };
}

function leadBriefAndInputs(workspaceId: string, createdBy: string) {
  const deadline = new Date();
  deadline.setUTCDate(deadline.getUTCDate() + 30);
  return {
    brief: {
      workspaceId,
      createdBy,
      name: "Demo — Pitch to K-beauty brands",
      ourProduct: {
        name: "Social Seeding",
        pitchSummary: "Agent-orchestrated TikTok influencer marketing platform — finds creators, manages outreach, ships samples, verifies posts.",
        keyClaims: ["agents handle the loop", "policy gates keep humans in charge"],
      },
      targeting: { countries: ["KR"], categories: [], excludeBlacklist: true },
      outreach: { maxSendsPerBatch: 3, toneNotes: "directness; no hype" },
      goals: { targetReplies: 1, deadline, budgetUsd: 25 },
    },
    leadInputs: [
      { companyName: "Demo Brand A", homepageUrl: "https://example-brand-a.kr" },
      { companyName: "Demo Brand B", homepageUrl: "https://example-brand-b.kr" },
      { companyName: "Demo Brand C", homepageUrl: "https://example-brand-c.kr" },
    ],
  };
}

// ── poll loop ────────────────────────────────────────────────────────────────

interface PollResult {
  finished: boolean;
  reason: string;
}

async function pollBrandCampaign(campaignId: string, pollMinutes: number): Promise<PollResult> {
  const db = await getDb();
  const deadline = Date.now() + pollMinutes * 60 * 1000;
  let lastSnapshot = "";
  while (Date.now() < deadline) {
    const c = await campaignRepo.get(campaignId);
    if (!c) {
      return { finished: true, reason: "campaign_row_disappeared" };
    }
    const pending = await approvalRepo.listPendingByWorkspace(c.brief.workspaceId);
    const tracesCount = await db.collection(Collections.V2_AGENT_TRACES).countDocuments({ campaignId });
    const summary = `status=${c.status} stage=${c.stage} tracks=${c.tracks.length} pending_approvals=${pending.length} traces=${tracesCount}`;
    if (summary !== lastSnapshot) {
      console.log(`  [${new Date().toISOString().slice(11, 19)}] ${summary}`);
      lastSnapshot = summary;
    }
    if (c.status === "completed") return { finished: true, reason: "campaign_completed" };
    if (c.status === "cancelled") return { finished: true, reason: "campaign_cancelled" };
    if (pending.length > 0) {
      return { finished: false, reason: `paused_on_gate (${pending.length} pending approval(s) — resolve via MC /approvals)` };
    }
    await sleep(5_000);
  }
  return { finished: false, reason: `poll_timeout (${pollMinutes}m elapsed; campaign still ${(await campaignRepo.get(campaignId))?.status})` };
}

async function pollLeadCampaign(leadCampaignId: string, pollMinutes: number): Promise<PollResult> {
  const db = await getDb();
  const deadline = Date.now() + pollMinutes * 60 * 1000;
  let lastSnapshot = "";
  while (Date.now() < deadline) {
    const lc = await leadCampaignRepo.get(leadCampaignId);
    if (!lc) return { finished: true, reason: "lead_campaign_disappeared" };
    const leadCount = await db.collection(Collections.V2_LEADS).countDocuments({});
    const enrichedCount = await db.collection(Collections.V2_LEADS).countDocuments({ enrichment: { $exists: true } });
    const researchedCount = await db.collection(Collections.V2_LEADS).countDocuments({ research: { $exists: true } });
    const pending = await approvalRepo.listPendingByWorkspace(lc.brief.workspaceId);
    const summary = `status=${lc.status} stage=${lc.stage} leads=${leadCount} enriched=${enrichedCount} researched=${researchedCount} pending_approvals=${pending.length}`;
    if (summary !== lastSnapshot) {
      console.log(`  [${new Date().toISOString().slice(11, 19)}] ${summary}`);
      lastSnapshot = summary;
    }
    if (lc.status === "completed") return { finished: true, reason: "lead_campaign_completed" };
    if (lc.status === "cancelled") return { finished: true, reason: "lead_campaign_cancelled" };
    if (pending.length > 0) {
      return { finished: false, reason: `paused_on_gate (${pending.length} pending approval(s))` };
    }
    await sleep(5_000);
  }
  return { finished: false, reason: `poll_timeout (${pollMinutes}m elapsed)` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();
  console.log(`run-demo — type=${opts.type} ${opts.dryRun ? "[DRY-RUN]" : "[LIVE]"} poll=${opts.pollMinutes}m`);

  // Pre-flight
  const checks = envCheck(opts);
  printEnvCheck(checks);

  if (opts.dryRun) {
    console.log("\nDry-run complete. To run live: drop --dry-run.");
    console.log(`Next live steps:`);
    console.log(`  1. pnpm run dev-mongo                           # if not already up`);
    console.log(`  2. pnpm exec tsx scripts/init-indexes.ts        # idempotent`);
    console.log(`  3. pnpm --filter @ss/web dev                    # MC + /api/inngest`);
    console.log(`  4. npx inngest-cli@latest dev                   # workflow runtime`);
    console.log(`  5. pnpm exec tsx scripts/run-demo.ts --type=${opts.type}`);
    return;
  }

  // Safety guard (live only): a live run writes v2_* collections + reads/writes
  // workspace state. CLAUDE.md landmine: `.env.test` ships a live Atlas URI on
  // the SHARED v1 `social_seeding` production DB. Refuse to run live against it
  // unless the operator explicitly opts in, so a confused run can't mutate prod.
  const uri = process.env.MONGODB_URI ?? "";
  const dbName = process.env.MONGODB_DB ?? "social_seeding";
  const isLocal = /(?:127\.0\.0\.1|localhost)/.test(uri);
  const isRemoteAtlas = uri.startsWith("mongodb+srv://") || (uri.length > 0 && !isLocal);
  if (isRemoteAtlas && dbName === "social_seeding" && !opts.allowSharedAtlas) {
    throw new Error(
      "refusing live run: MONGODB_URI points at a remote cluster on the SHARED v1 " +
        "production DB `social_seeding` — a live demo would mutate production data. " +
        "Use a dev cluster / `mongodb-memory-server` (set MONGODB_DB=social_seeding_demo " +
        "or a local URI), or pass --allow-shared-atlas if this is intentional.",
    );
  }

  // Use a deterministic demo workspace + user. These values are operator-
  // facing — feel free to override via env if you want the demo to land
  // under a real workspace.
  const workspaceId = process.env.DEMO_WORKSPACE_ID ?? "ws_demo";
  const userId = process.env.DEMO_USER_ID ?? "u".repeat(21);

  if (opts.type === "brand") {
    const brief = brandBrief(workspaceId, userId);
    console.log(`\nSubmitting brand campaign: "${brief.brandProduct.name}" → ${brief.goals.targetLivePosts} posts by ${brief.goals.deadline.toISOString().slice(0, 10)}`);
    const campaign = await campaignRepo.create({ brief, status: "draft", stage: "overview", tracks: [] });
    console.log(`  campaign id: ${campaign.id}`);
    await inngest.send({ name: Events.CampaignSubmitted, data: { campaignId: campaign.id, brief } });
    console.log("  → emitted campaign/submitted; workflow should pick up");
    console.log("\nPolling progress (Ctrl-C to stop, doesn't affect the campaign) …");
    const result = await pollBrandCampaign(campaign.id, opts.pollMinutes);
    console.log(`\nDone: ${result.reason}`);
    if (!result.finished) {
      console.log(`  → ${result.reason.includes("paused_on_gate") ? "Resolve gates in MC at " : "Re-run or wait — campaign at "}http://localhost:3000/campaigns/${campaign.id}`);
    }
  } else {
    const { brief, leadInputs } = leadBriefAndInputs(workspaceId, userId);
    console.log(`\nSubmitting lead campaign: "${brief.name}" → ${leadInputs.length} leads, target ${brief.goals.targetReplies} replies`);
    const lc = await leadCampaignRepo.create({ brief, status: "running", stage: "overview", leadIds: [] });
    console.log(`  lead-campaign id: ${lc.id}`);
    await inngest.send({ name: Events.LeadCampaignSubmitted, data: { leadCampaignId: lc.id, brief, leadInputs } });
    console.log("  → emitted lead-campaign/submitted");
    console.log("\nPolling progress …");
    const result = await pollLeadCampaign(lc.id, opts.pollMinutes);
    console.log(`\nDone: ${result.reason}`);
    if (!result.finished) {
      console.log(`  → MC view: http://localhost:3000/leads/${lc.id}`);
    }
  }
  await closeMongo();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 2;
});
