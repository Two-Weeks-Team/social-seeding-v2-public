import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LeadCampaignBrief } from "@ss/contracts";
import {
  closeMongo, Collections, getDb,
  leadCampaignRepo, leadRepo,
} from "@ss/db";
import {
  setCrmEnrichClientFactory, setUsageStore,
  type CrmEnrichClient, type UsageStore,
} from "@ss/capabilities";
import { memorySink, setObservabilitySink } from "@ss/observability";
import type { ModelClient } from "@ss/agents";
import type { ApprovalResolvedData, StepLike } from "../gate";
import { leadCampaignHandler } from "./lead-campaign";

/**
 * P5-C3 — lead-campaign parent workflow tests. Pipeline:
 * import-leads → enrich+research per lead → advance-stage-outreach →
 * fan-out lead-track. The actual outreach + reply loop lives in
 * lead-track (separate workflow, separately tested below).
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

interface StepLog {
  runs: string[];
  events: Array<{ name: string; data: unknown }>;
}

function fakeStep(): { step: StepLike; log: StepLog } {
  const log: StepLog = { runs: [], events: [] };
  const step: StepLike = {
    async run(name, fn) {
      log.runs.push(name);
      return fn();
    },
    async sendEvent(_stepName, payload) {
      const arr = Array.isArray(payload) ? payload : [payload];
      for (const p of arr) log.events.push(p);
      return { ids: arr.map((_, i) => `evt_${log.events.length - arr.length + i}`) };
    },
    async waitForEvent<T = ApprovalResolvedData>(): Promise<{ data: T } | null> {
      return null;
    },
  };
  return { step, log };
}

function fakeCrm(opts: { confidence?: number; throwOnUrl?: string } = {}): CrmEnrichClient {
  return {
    async crawl(url) {
      if (opts.throwOnUrl && url === opts.throwOnUrl) throw new Error("crawl_failed_for_url");
      return {
        url, normalizedUrl: url, pagesVisited: 10,
        text: `Sample text for ${url}`, emails: ["hi@x.kr"],
        socialLinks: { instagram: "https://instagram.com/x" },
      };
    },
    async analyze({ companyName }) {
      return {
        company_summary: `${companyName} — 분석`,
        main_products: "수분 세럼", product_categories: "skincare",
        business_type: "brand", target_market: "20-30대 한국",
        global_presence: "yes", key_strengths: "강함",
        brand_positioning: "프리미엄", sns_presence: "Instagram 5만",
        recommended_outreach_angle: "TikTok 확장 제안",
        sales_priority: "high", sales_priority_reason: "근거",
        confidence_score: opts.confidence ?? 80,
        reasoning_brief: "ok",
      };
    },
  };
}

function fakeModelForResearch(escalateOn?: string): ModelClient {
  return {
    complete: async ({ system }) => {
      if (system.includes("Research agent")) {
        if (escalateOn && system.includes(escalateOn)) {
          return {
            kind: "text",
            text: JSON.stringify({ escalate: "enrichment_too_thin: forced for test" }),
            inputTokens: 200, outputTokens: 50,
          };
        }
        return {
          kind: "text",
          text: JSON.stringify({
            pitch: "Strong fit — they have IG audience but no TikTok presence; our seeding maps directly onto that gap.",
            angles: ["Convert IG → TikTok via creator seeding", "Single hit product is TikTok-shape native"],
            groundedFacts: ["Instagram 5만, TikTok 없음", "히트 단일 제품 보유"],
            contactProfile: "Marketing Director",
            confidence: 80,
          }),
          inputTokens: 600, outputTokens: 200,
        };
      }
      throw new Error(`fakeModelForResearch: unhandled prompt: ${system.slice(0, 100)}`);
    },
  };
}

const brief: LeadCampaignBrief = {
  workspaceId: "ws_p5lc",
  createdBy: "u".repeat(21),
  name: "Pitch to K-beauty brands",
  ourProduct: {
    name: "Social Seeding", pitchSummary: "TikTok influencer marketing platform",
    keyClaims: ["finds creators by hashtag fit"],
  },
  targeting: { countries: ["KR"], categories: [], excludeBlacklist: true },
  outreach: { maxSendsPerBatch: 20, toneNotes: "" },
  goals: { targetReplies: 5, deadline: new Date("2026-08-01"), budgetUsd: 100 },
};

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
  const db = await getDb();
  await db.collection(Collections.V2_LEADS)
    .createIndex(
      { workspaceId: 1, sharedAccountId: 1 },
      { unique: true, partialFilterExpression: { sharedAccountId: { $exists: true } } },
    )
    .catch(() => undefined);
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_LEADS).deleteMany({});
  await db.collection(Collections.V2_LEAD_CAMPAIGNS).deleteMany({});
  setObservabilitySink(memorySink());
  setUsageStore(memUsageStore);
});

afterEach(() => {
  setObservabilitySink(undefined);
  setUsageStore(undefined);
  setCrmEnrichClientFactory(undefined);
});

afterAll(async () => { await closeMongo(); });

describe("lead-campaign workflow", () => {
  it("happy path: 2 leads → 2 enriched → 2 researched → 2 fanned out", async () => {
    setCrmEnrichClientFactory(async () => fakeCrm({}));
    const lc = await leadCampaignRepo.create({
      brief, status: "running", stage: "overview", leadIds: [],
    });
    const fake = fakeStep();
    const out = await leadCampaignHandler(
      {
        event: {
          data: {
            leadCampaignId: lc.id, brief,
            leadInputs: [
              { companyName: "Glow Tonic", homepageUrl: "https://glow-tonic.kr" },
              { companyName: "Hydra Co", homepageUrl: "https://hydra.kr" },
            ],
          },
        },
        step: fake.step,
      },
      { modelClient: fakeModelForResearch() },
    );
    expect(out.failures).toEqual([]);
    expect(out.imported).toBe(2);
    expect(out.enriched).toBe(2);
    expect(out.researched).toBe(2);
    expect(out.fannedOut).toBe(2);

    // Pipeline ran in order: plan + import-leads come first, then per-
    // lead enrich-<id> + research-<id> (the ids are non-deterministic
    // so assert by count + ordering of prefixes).
    expect(fake.log.runs[0]).toBe("plan");
    expect(fake.log.runs[1]).toBe("import-leads");
    expect(fake.log.runs.filter((r) => r.startsWith("enrich-"))).toHaveLength(2);
    expect(fake.log.runs.filter((r) => r.startsWith("research-"))).toHaveLength(2);
    expect(fake.log.runs).toContain("advance-stage-outreach");
    // Fan-out event(s) sent
    expect(fake.log.events.filter((e) => e.name === "lead-campaign/lead-track.start")).toHaveLength(2);

    // Leads landed at stage=researched (P5-C2 patchResearch)
    const allLeads = await leadRepo.listByWorkspace(brief.workspaceId);
    expect(allLeads).toHaveLength(2);
    for (const l of allLeads) {
      expect(l.stage).toBe("researched");
      expect(l.enrichment).toBeDefined();
      expect(l.research).toBeDefined();
    }
  });

  it("dedupe: same sharedAccountId imported twice → only one v2_leads row", async () => {
    setCrmEnrichClientFactory(async () => fakeCrm({}));
    const lc = await leadCampaignRepo.create({
      brief, status: "running", stage: "overview", leadIds: [],
    });
    const fake = fakeStep();
    const out = await leadCampaignHandler(
      {
        event: {
          data: {
            leadCampaignId: lc.id, brief,
            leadInputs: [
              { companyName: "Already", homepageUrl: "https://already.kr", sharedAccountId: "shared_xyz" },
              { companyName: "Already Dup", homepageUrl: "https://already.kr", sharedAccountId: "shared_xyz" },
            ],
          },
        },
        step: fake.step,
      },
      { modelClient: fakeModelForResearch() },
    );
    expect(out.imported).toBe(2); // both inputs resolved to a lead id
    const all = await leadRepo.listByWorkspace(brief.workspaceId);
    expect(all).toHaveLength(1); // but only one row was created
  });

  it("lead without homepage URL → flagged as failure, stage='flaked', no enrich attempt", async () => {
    setCrmEnrichClientFactory(async () => fakeCrm({}));
    const lc = await leadCampaignRepo.create({
      brief, status: "running", stage: "overview", leadIds: [],
    });
    const fake = fakeStep();
    const out = await leadCampaignHandler(
      {
        event: {
          data: {
            leadCampaignId: lc.id, brief,
            leadInputs: [{ companyName: "No URL Co" }],
          },
        },
        step: fake.step,
      },
      { modelClient: fakeModelForResearch() },
    );
    expect(out.imported).toBe(1);
    expect(out.enriched).toBe(0);
    expect(out.fannedOut).toBe(0);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]?.reason).toMatch(/no_homepage_url/);
    expect(fake.log.events.filter((e) => e.name === "lead-campaign/lead-track.start")).toHaveLength(0);
    const all = await leadRepo.listByWorkspace(brief.workspaceId);
    expect(all[0]?.stage).toBe("flaked");
  });

  it("enrich failure (Modal returns error) → recorded in failures + lead.stage='flaked', other leads still proceed", async () => {
    setCrmEnrichClientFactory(async () => fakeCrm({ throwOnUrl: "https://down.kr" }));
    const lc = await leadCampaignRepo.create({
      brief, status: "running", stage: "overview", leadIds: [],
    });
    const fake = fakeStep();
    const out = await leadCampaignHandler(
      {
        event: {
          data: {
            leadCampaignId: lc.id, brief,
            leadInputs: [
              { companyName: "Down", homepageUrl: "https://down.kr" },
              { companyName: "Up", homepageUrl: "https://up.kr" },
            ],
          },
        },
        step: fake.step,
      },
      { modelClient: fakeModelForResearch() },
    );
    expect(out.enriched).toBe(1);
    expect(out.researched).toBe(1);
    expect(out.fannedOut).toBe(1);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]?.reason).toMatch(/enrich_failed/);

    const all = await leadRepo.listByWorkspace(brief.workspaceId);
    const down = all.find((l) => l.companyName === "Down");
    const up = all.find((l) => l.companyName === "Up");
    expect(down?.stage).toBe("flaked");
    expect(up?.stage).toBe("researched");
  });
});
