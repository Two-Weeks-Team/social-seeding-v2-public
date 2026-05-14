import { Events, type Lead, type LeadCampaignBrief } from "@ss/contracts";
import { leadCampaignRepo, leadRepo } from "@ss/db";
import {
  invokeCapability,
  type GmailClientFactory,
} from "@ss/capabilities";
import {
  researchAgent,
  runAgent,
  type AgentRunContext,
  type ModelClient,
} from "@ss/agents";
import { startTrace } from "@ss/observability";
import { inngest } from "../client";
import type { StepLike } from "../gate";

/**
 * lead-campaign — Phase 5 P5-C3 parent workflow. Mirrors brand-campaign's
 * architecture: orchestrates the front half (import → enrich → research)
 * and fans out one `lead-track` per researched lead for the outreach +
 * reply loop.
 *
 * Pipeline:
 *   1. plan          — load workspace policy; transition stage to 'import'.
 *   2. import-leads  — for each input row, find-or-create v2_leads.
 *                      Skip if sharedAccountId already exists. Persist
 *                      ids on the lead-campaign row.
 *   3. enrich+research — per lead in series (rate-limited by
 *                      `crm_enrich` class): invokeCapability(crm.enrich)
 *                      → leadRepo.patchEnrichment → runAgent(researchAgent)
 *                      → leadRepo.patchResearch. Each step is its own
 *                      step.run so retries are scoped.
 *   4. advance-stage-outreach — patchStage('outreach').
 *   5. fan-out       — step.sendEvent('lead-campaign/lead-track.start')
 *                      one per researched lead. lead-track (sibling
 *                      workflow) handles outreach + reply loop.
 *
 * Why one lead at a time in step 3 (not Promise.all): crm.enrich hits
 * Modal + Kimi which are externally rate-limited; serializing reduces
 * the chance of 429s and keeps the per-step retry boundary tight (one
 * lead's failure doesn't block others — the next workflow tick picks
 * up where this one left off via lead.stage filtering).
 */

export interface LeadCampaignDeps {
  modelClient?: ModelClient;
  /** Unused today but matches brand-campaign's deps shape — placeholder for symmetry. */
  gmailClientFactory?: GmailClientFactory;
}

export interface LeadCampaignArgs {
  event: {
    data: {
      leadCampaignId: string;
      brief: LeadCampaignBrief;
      leadInputs: Array<{
        companyName: string;
        homepageUrl?: string;
        sharedAccountId?: string;
        contactEmail?: string;
      }>;
    };
  };
  step: StepLike;
}

export interface LeadCampaignResult {
  leadCampaignId: string;
  imported: number;
  enriched: number;
  researched: number;
  fannedOut: number;
  failures: Array<{ leadId?: string; companyName?: string; reason: string }>;
}

export async function leadCampaignHandler(
  { event, step }: LeadCampaignArgs,
  deps: LeadCampaignDeps = {},
): Promise<LeadCampaignResult> {
  const { leadCampaignId, brief, leadInputs } = event.data;
  const workspaceId = brief.workspaceId;
  const failures: LeadCampaignResult["failures"] = [];

  // ── 1. plan ──────────────────────────────────────────────────────────────
  await step.run("plan", async () => {
    await leadCampaignRepo.patchStage(leadCampaignId, "import", "running");
  });

  // shared trace + ctx for the research agent (per-lead trace via campaignId)
  const trace = startTrace(leadCampaignId);
  const baseAgentCtx: AgentRunContext = {
    capabilityCtx: {
      workspaceId, userId: brief.createdBy, campaignId: leadCampaignId,
      rateLimitClass: "default",
    },
    trace,
    ...(deps.modelClient ? { model: deps.modelClient } : {}),
  };

  // ── 2. import-leads ──────────────────────────────────────────────────────
  const importedIds: string[] = await step.run("import-leads", async () => {
    const ids: string[] = [];
    for (const inp of leadInputs) {
      try {
        // Dedupe on (workspaceId, sharedAccountId) when present.
        if (inp.sharedAccountId) {
          const existing = await leadRepo.findBySharedAccountId(workspaceId, inp.sharedAccountId);
          if (existing) {
            ids.push(existing.id);
            continue;
          }
        }
        const created = await leadRepo.create({
          workspaceId,
          ...(inp.sharedAccountId ? { sharedAccountId: inp.sharedAccountId } : {}),
          companyName: inp.companyName,
          ...(inp.homepageUrl ? { homepageUrl: inp.homepageUrl } : {}),
          country: brief.targeting.countries[0] ?? "KR",
          ...(inp.contactEmail ? { contactEmail: inp.contactEmail } : {}),
          tags: [], snsLinks: [].length > 0 ? {} : {},
          stage: "imported",
          lastActivityAt: new Date(),
          notes: "",
        });
        ids.push(created.id);
      } catch (err) {
        failures.push({
          companyName: inp.companyName,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (ids.length > 0) {
      await leadCampaignRepo.pushLeadIds(leadCampaignId, ids);
    }
    return ids;
  });
  const imported = importedIds.length;

  // ── 3. enrich+research per lead (each step.run scoped so retries are tight) ──
  let enriched = 0;
  let researched = 0;
  const ready: Lead[] = [];
  for (const leadId of importedIds) {
    const lead = await leadRepo.get(leadId);
    if (!lead) {
      failures.push({ leadId, reason: "lead_disappeared_between_steps" });
      continue;
    }
    if (!lead.homepageUrl) {
      failures.push({ leadId, companyName: lead.companyName, reason: "no_homepage_url" });
      await leadRepo.patchStage(leadId, "flaked");
      continue;
    }

    // 3a — crm.enrich (scope=read, rateLimit=crm_enrich). Persistence
    // happens inside the capability when leadId is set.
    try {
      await step.run(`enrich-${leadId}`, async () =>
        invokeCapability(
          "crm.enrich",
          { url: lead.homepageUrl!, companyName: lead.companyName, leadId, maxPages: 20 },
          { ...baseAgentCtx.capabilityCtx, rateLimitClass: "crm_enrich" },
        ),
      );
    } catch (err) {
      failures.push({ leadId, companyName: lead.companyName, reason: `enrich_failed: ${err instanceof Error ? err.message : err}` });
      await leadRepo.patchStage(leadId, "flaked");
      continue;
    }
    enriched++;

    const enrichedLead = await leadRepo.get(leadId);
    if (!enrichedLead?.enrichment) {
      failures.push({ leadId, companyName: lead.companyName, reason: "enrichment_missing_post_patch" });
      continue;
    }

    // 3b — research agent. Output → patchResearch (advances stage to 'researched').
    const researchOutcome = await step.run(`research-${leadId}`, async () =>
      runAgent(
        researchAgent,
        {
          brief,
          enrichment: enrichedLead.enrichment!,
          lead: {
            companyName: enrichedLead.companyName,
            ...(enrichedLead.companyNameEn ? { companyNameEn: enrichedLead.companyNameEn } : {}),
            country: enrichedLead.country,
            ...(enrichedLead.homepageUrl ? { homepageUrl: enrichedLead.homepageUrl } : {}),
          },
        },
        baseAgentCtx,
      ),
    );
    if (researchOutcome.kind !== "ok") {
      failures.push({
        leadId, companyName: lead.companyName,
        reason: `research_escalated: ${researchOutcome.reason}`,
      });
      await leadRepo.patchStage(leadId, "flaked");
      continue;
    }
    await leadRepo.patchResearch(leadId, {
      ...researchOutcome.value,
      researchedAt: new Date(),
    });
    researched++;

    const finalLead = await leadRepo.get(leadId);
    if (finalLead) ready.push(finalLead);
  }

  // ── 4. stage → outreach ──────────────────────────────────────────────────
  if (ready.length > 0) {
    await step.run("advance-stage-outreach", async () =>
      leadCampaignRepo.patchStage(leadCampaignId, "outreach"),
    );
  }

  // ── 5. fan out lead-track per researched lead ────────────────────────────
  let fannedOut = 0;
  if (ready.length > 0) {
    await step.sendEvent(
      "lead-track-fanout",
      ready.map((l) => ({
        name: Events.LeadTrackStart,
        data: { leadCampaignId, workspaceId, brief, lead: l },
      })),
    );
    fannedOut = ready.length;
  }

  await trace.flush();

  return { leadCampaignId, imported, enriched, researched, fannedOut, failures };
}

export const leadCampaign = inngest.createFunction(
  {
    id: "lead-campaign",
    cancelOn: [{ event: Events.CampaignCancelled, match: "data.campaignId" }],
  },
  { event: Events.LeadCampaignSubmitted },
  ({ event, step }) =>
    leadCampaignHandler({
      event: { data: event.data as LeadCampaignArgs["event"]["data"] },
      step: step as unknown as StepLike,
    }),
);
