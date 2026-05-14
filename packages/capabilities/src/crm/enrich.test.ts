import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CrmEnrichClient } from "@ss/capabilities";
import { setCrmEnrichClientFactory, setUsageStore, type UsageStore } from "@ss/capabilities";
import { closeMongo, Collections, getDb, leadRepo } from "@ss/db";
import { crmEnrich } from "./enrich";

/**
 * P5-C1 — crm.enrich. Pure dispatch onto the CrmEnrichClient seam +
 * optional persistence onto v2_leads.
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

function fakeClient(opts: {
  crawlText?: string;
  emails?: string[];
  socialLinks?: Record<string, string>;
  pagesVisited?: number;
  analysisOverride?: Partial<Awaited<ReturnType<CrmEnrichClient["analyze"]>>>;
  throwOnCrawl?: string;
  throwOnAnalyze?: string;
}): CrmEnrichClient {
  return {
    async crawl(url) {
      if (opts.throwOnCrawl) throw new Error(opts.throwOnCrawl);
      return {
        url,
        normalizedUrl: url.endsWith("/") ? url : `${url}/`,
        pagesVisited: opts.pagesVisited ?? 12,
        text: opts.crawlText ?? "Sample homepage text",
        emails: opts.emails ?? ["hello@example.kr"],
        socialLinks: opts.socialLinks ?? { instagram: "https://instagram.com/x" },
      };
    },
    async analyze({ companyName }) {
      if (opts.throwOnAnalyze) throw new Error(opts.throwOnAnalyze);
      return {
        company_summary: `${companyName} — K-beauty 자체 브랜드`,
        main_products: "수분 세럼 | 토너 패드",
        product_categories: "skincare | serum",
        business_type: "brand",
        target_market: "20-30대 여성",
        global_presence: "yes",
        key_strengths: "히트 단일 제품 + 강한 SNS",
        brand_positioning: "프리미엄 데일리 케어",
        sns_presence: "Instagram + TikTok 활성",
        recommended_outreach_angle: "TikTok Shop + 챌린지로 미국 시장 확장 제안",
        sales_priority: "high",
        sales_priority_reason: "SNS 트래픽 확실, TikTok 미진출",
        confidence_score: 85,
        reasoning_brief: "데이터가 풍부함",
        ...opts.analysisOverride,
      };
    },
  };
}

beforeAll(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
  const db = await getDb();
  // Partial-unique-on-exists index — matches scripts/init-indexes.ts.
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
  setUsageStore(memUsageStore);
});

afterEach(() => {
  setUsageStore(undefined);
  setCrmEnrichClientFactory(undefined);
});

afterAll(async () => { await closeMongo(); });

describe("crm.enrich", () => {
  it("happy path: crawl + analyze, returns enrichment, no persist when leadId omitted", async () => {
    setCrmEnrichClientFactory(async () => fakeClient({}));
    const out = await crmEnrich.handler(
      { url: "https://example.kr", companyName: "EXAMPLE", maxPages: 20 },
      { workspaceId: "ws_p5", userId: "u".repeat(21), rateLimitClass: "crm_enrich" },
    );
    expect(out.persisted).toBe(false);
    expect(out.enrichment.websiteData.url).toBe("https://example.kr");
    expect(out.enrichment.websiteData.pagesVisited).toBe(12);
    expect(out.enrichment.websiteData.emails).toContain("hello@example.kr");
    expect(out.enrichment.analysis.sales_priority).toBe("high");
    expect(out.enrichment.analysis.confidence_score).toBe(85);
    expect(out.enrichment.enrichedAt).toBeInstanceOf(Date);
  });

  it("happy path with leadId: persists enrichment + advances stage to 'enriched'", async () => {
    setCrmEnrichClientFactory(async () => fakeClient({}));
    const lead = await leadRepo.create({
      workspaceId: "ws_p5",
      companyName: "EXAMPLE", country: "KR",
      tags: [], snsLinks: {},
      stage: "imported",
      lastActivityAt: new Date(),
      notes: "",
    });
    const out = await crmEnrich.handler(
      { url: "https://example.kr", companyName: "EXAMPLE", leadId: lead.id, maxPages: 20 },
      { workspaceId: "ws_p5", userId: "u".repeat(21), rateLimitClass: "crm_enrich" },
    );
    expect(out.persisted).toBe(true);
    const after = await leadRepo.get(lead.id);
    expect(after?.stage).toBe("enriched");
    expect(after?.enrichment?.analysis.confidence_score).toBe(85);
    // P5 codex P1#2: first crawled email gets promoted to contactEmail
    // when the lead didn't already have one.
    expect(after?.contactEmail).toBe("hello@example.kr");
  });

  it("P5 codex P1#2: doesn't overwrite an operator-supplied contactEmail with a crawled one", async () => {
    setCrmEnrichClientFactory(async () => fakeClient({ emails: ["scraped@example.kr"] }));
    const lead = await leadRepo.create({
      workspaceId: "ws_p5",
      companyName: "EXAMPLE", country: "KR",
      contactEmail: "operator@chosen.kr",
      tags: [], snsLinks: {},
      stage: "imported",
      lastActivityAt: new Date(),
      notes: "",
    });
    await crmEnrich.handler(
      { url: "https://example.kr", companyName: "EXAMPLE", leadId: lead.id, maxPages: 20 },
      { workspaceId: "ws_p5", userId: "u".repeat(21), rateLimitClass: "crm_enrich" },
    );
    const after = await leadRepo.get(lead.id);
    expect(after?.contactEmail).toBe("operator@chosen.kr");
  });

  it("rejects mid-pipeline crawl failure — exception bubbles to caller (Inngest retries)", async () => {
    setCrmEnrichClientFactory(async () => fakeClient({ throwOnCrawl: "Modal crawl returned 503" }));
    await expect(
      crmEnrich.handler(
        { url: "https://down.kr", companyName: "DOWN", maxPages: 20 },
        { workspaceId: "ws_p5", userId: "u".repeat(21), rateLimitClass: "crm_enrich" },
      ),
    ).rejects.toThrow(/Modal crawl returned 503/);
  });

  it("rejects analysis failure — exception bubbles (Kimi non-2xx, etc.)", async () => {
    setCrmEnrichClientFactory(async () => fakeClient({ throwOnAnalyze: "Kimi returned 429" }));
    await expect(
      crmEnrich.handler(
        { url: "https://busy.kr", companyName: "BUSY", maxPages: 20 },
        { workspaceId: "ws_p5", userId: "u".repeat(21), rateLimitClass: "crm_enrich" },
      ),
    ).rejects.toThrow(/Kimi returned 429/);
  });

  it("coerces lower-confidence analysis fields through the schema (e.g. clamps confidence_score)", async () => {
    setCrmEnrichClientFactory(async () => fakeClient({
      analysisOverride: {
        sales_priority: "low",
        confidence_score: 30,
        recommended_outreach_angle: "낮은 시급도지만 미니 캠페인 가능",
      },
    }));
    const out = await crmEnrich.handler(
      { url: "https://meh.kr", companyName: "MEH", maxPages: 20 },
      { workspaceId: "ws_p5", userId: "u".repeat(21), rateLimitClass: "crm_enrich" },
    );
    expect(out.enrichment.analysis.sales_priority).toBe("low");
    expect(out.enrichment.analysis.confidence_score).toBe(30);
  });

  it("input validation: rejects non-URL `url`, empty companyName, maxPages > 50", () => {
    expect(crmEnrich.input.safeParse({ url: "not-a-url", companyName: "X" }).success).toBe(false);
    expect(crmEnrich.input.safeParse({ url: "https://x", companyName: "" }).success).toBe(false);
    expect(crmEnrich.input.safeParse({ url: "https://x", companyName: "X", maxPages: 999 }).success).toBe(false);
  });
});
