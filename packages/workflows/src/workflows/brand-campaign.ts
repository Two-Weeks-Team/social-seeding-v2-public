import type { z } from "zod";
import { type Candidate, CampaignBriefSchema, Events } from "@ss/contracts";
import { campaignRepo, Collections, getDb, workspaceRepo } from "@ss/db";
import { sourcingAgent, vettingAgent, runAgent, type AgentRunContext, type ModelClient } from "@ss/agents";
import { recordCost, startTrace, type RunTrace } from "@ss/observability";
import { gate, type StepLike } from "../gate";
import { inngest } from "../client";

/**
 * brand-campaign — the durable workflow that *is* the product. It encodes
 * the 6 stages v1 made the human click through, and runs them with agents,
 * pausing at policy gates. Phase 1 fills in stages 1-2 (overview → sourcing +
 * vetting fan-out → approveShortlist gate). Phase 2+ adds outreach / shipping
 * / content_review / performance per docs/ROADMAP.md.
 *
 * The handler is exported separately from inngest.createFunction so tests can
 * drive it with a fake step + fake ModelClient without a running Inngest
 * dev server.
 */

type Brief = z.infer<typeof CampaignBriefSchema>;
type CandidateOut = Omit<Candidate, "fitScore" | "vettedAt">;

export interface BrandCampaignDeps {
  /** Injected for tests; default = the Anthropic-backed defaultModelClient. */
  modelClient?: ModelClient;
}

export interface BrandCampaignArgs {
  event: { data: { campaignId: string; brief: Brief } };
  step: StepLike;
}

/**
 * Drop candidates whose flags include any HARD-fail flag (the workflow
 * filters before showing the shortlist; the human still sees flagged but
 * non-hard-fail candidates in the inbox).
 */
const HARD_FAIL_FLAGS = new Set(["blacklisted", "brand_unsafe", "prior_flake"]);

export function pickShortlist(vetted: Candidate[], targetCount: number): Candidate[] {
  const limit = Math.ceil(targetCount * 1.5);
  return vetted
    .filter((c) => !c.flags.some((f) => HARD_FAIL_FLAGS.has(f)))
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, limit);
}

export async function brandCampaignHandler(
  { event, step }: BrandCampaignArgs,
  deps: BrandCampaignDeps = {},
): Promise<{
  campaignId: string;
  stage: "sourcing" | "outreach";
  shortlistCount: number;
  trackCount: number;
  decision: "approved" | "edited" | "rejected";
}> {
  const { campaignId, brief } = event.data;
  const workspaceId = brief.workspaceId;

  // P0-7: trace + $0 cost on the run start.
  await step.run("observability", async () => {
    const t = startTrace(campaignId);
    await t.span("workflow:brand-campaign", "workflow", { campaignId }, async () => undefined);
    await recordCost({
      campaignId,
      workspaceId,
      agent: "brand-campaign",
      model: "none",
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      at: Date.now(),
    });
    await t.flush();
  });

  // ── Stage 1: overview — load policy, persist plan, advance to sourcing ──
  const policy = await step.run("plan", async () => {
    const wp = await workspaceRepo.getPolicy(workspaceId);
    await campaignRepo.patchStage(campaignId, "sourcing", "running");
    return wp;
  });

  // shared trace + ctx for the agents (each runAgent call writes its own spans into this trace)
  const trace: RunTrace = startTrace(campaignId);
  const agentCtx: AgentRunContext = {
    capabilityCtx: { workspaceId, userId: brief.createdBy, rateLimitClass: "default" },
    trace,
    campaignBudgetUsd: policy.budgets.maxUsdPerCampaign,
    ...(deps.modelClient ? { model: deps.modelClient } : {}),
  };

  // ── Stage 2: sourcing — runAgent(sourcingAgent) ───────────────────────────
  const sourcingOutcome = await step.run("source", async () =>
    runAgent(sourcingAgent, { brief, excludeCreatorIds: [] }, agentCtx),
  );
  if (sourcingOutcome.kind !== "ok") {
    throw new Error(`sourcing agent escalated: ${sourcingOutcome.reason}`);
  }
  const candidates: CandidateOut[] = sourcingOutcome.value.candidates;

  // ── Stage 2: vetting fan-out — one step.run per candidate ────────────────
  const vetOutcomes = await Promise.all(
    candidates.map((c, i) =>
      step.run(`vet-${i}`, async () => runAgent(vettingAgent, { brief, candidate: c }, agentCtx)),
    ),
  );
  const vetted: Candidate[] = [];
  for (const o of vetOutcomes) {
    if (o.kind === "ok") vetted.push(o.value);
    // escalated vets are dropped — the workflow has enough margin (3× target) to absorb a few
  }

  // pickShortlist: top ⌈creatorCount × 1.5⌉ by fitScore, drop hard-fail flags
  const shortlist = pickShortlist(vetted, brief.targeting.creatorCount);

  // ── approveShortlist gate (WF2) ─────────────────────────────────────────
  const resolution = await gate(step, policy.gates.approveShortlist, {
    campaignId,
    workspaceId,
    kind: "shortlist",
    recommendation: shortlist,
    rationale: `${vetted.length} candidates vetted; ${shortlist.length} pass hard-fail filter and rank highest by fitScore (avg ${
      shortlist.length > 0 ? (shortlist.reduce((s, c) => s + c.fitScore, 0) / shortlist.length).toFixed(2) : "n/a"
    }).`,
  });

  // ── WF3: persist a CreatorTrack per confirmed creator (approved | edited) ──
  let trackCount = 0;
  let confirmed: Candidate[] = [];
  if (resolution.decision === "approved" || resolution.decision === "edited") {
    confirmed = Array.isArray(resolution.payload) ? (resolution.payload as Candidate[]) : [];
    await step.run("persist-tracks", async () => {
      const now = new Date();
      for (const c of confirmed) {
        await campaignRepo.upsertTrack(campaignId, {
          creatorId: c.creator.id,
          stage: "sourcing",
          state: "shortlisted",
          lastActivityAt: now,
          emailsSent: 0,
        });
      }
    });
    trackCount = confirmed.length;
  }

  await trace.span("decision:approveShortlist", "stage", { decision: resolution.decision, trackCount }, async () => undefined);

  // ── P2-C5: fan out one creator-track child per confirmed creator. ────────
  // Email addresses come from CRM enrichment in Phase 5; for Phase 2 we pass
  // through whatever the candidate carries (currently nothing — many tracks
  // will terminate as `no_email` until enrichment lands). Stage advances to
  // "outreach" so the campaign timeline reflects the handoff.
  if (confirmed.length > 0) {
    await step.run("advance-stage-outreach", async () =>
      campaignRepo.patchStage(campaignId, "outreach"),
    );
    // Resolve `contactEmail` per creator (additive read on accounts_tiktok).
    // The shared collection's schema doesn't define this field — v2 seeds it
    // as part of CRM enrichment OR a demo helper. When absent, creator-track
    // terminates as `no_email` (the documented fallback).
    const emailLookup = await step.run("resolve-creator-emails", async () => {
      const db = await getDb();
      const ids = confirmed.map((c) => c.creator.id);
      const docs = await db
        .collection<{ id?: string; contactEmail?: string }>(Collections.SHARED_TIKTOK_ACCOUNTS)
        .find({ id: { $in: ids } }, { projection: { id: 1, contactEmail: 1 } })
        .toArray();
      const map: Record<string, string> = {};
      for (const d of docs) {
        if (d.id && typeof d.contactEmail === "string" && d.contactEmail.length > 0) {
          map[d.id] = d.contactEmail;
        }
      }
      return map;
    });
    await step.sendEvent(
      "creator-track-fanout",
      confirmed.map((c) => ({
        name: Events.CreatorTrackStart,
        data: {
          campaignId,
          brief,
          creator: c.creator,
          ...(emailLookup[c.creator.id] ? { creatorEmail: emailLookup[c.creator.id] } : {}),
          recentPosts: [],
        },
      })),
    );
  }

  await trace.flush();

  return {
    campaignId,
    stage: confirmed.length > 0 ? "outreach" : "sourcing",
    shortlistCount: Array.isArray(resolution.payload) ? resolution.payload.length : 0,
    decision: resolution.decision,
    trackCount,
  };
}

export const brandCampaign = inngest.createFunction(
  {
    id: "brand-campaign",
    cancelOn: [{ event: Events.CampaignCancelled, match: "data.campaignId" }],
  },
  { event: Events.CampaignSubmitted },
  ({ event, step }) => brandCampaignHandler({ event, step: step as unknown as StepLike }),
);
