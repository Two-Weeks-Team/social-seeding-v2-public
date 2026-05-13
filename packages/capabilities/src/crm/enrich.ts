import { z } from "zod";
import { defineCapability } from "../registry";

/**
 * crm.enrich — crawl a company website (Modal) + analyze it (Kimi/Moonshot) into
 * structured sales fields. Ports v1 `lib/crm/enrichment-service.ts` +
 * `modal-enrichment/app.py` verbatim. Used by the (Phase 5) Research agent that
 * drives the sales-lead campaign type.
 */
export const crmEnrich = defineCapability({
  name: "crm.enrich",
  description: "Crawl a company website and produce structured sales-analysis fields (summary, products, business type, outreach angle, priority).",
  scope: "read",
  idempotent: true,
  rateLimitClass: "crm_enrich",
  input: z.object({ url: z.string().url(), accountId: z.string().optional() }),
  output: z.object({
    websiteData: z.object({ url: z.string(), title: z.string().optional(), text: z.string() }),
    analysis: z.object({
      company_summary: z.string(),
      main_products: z.string(),
      business_type: z.string(),
      target_market: z.string(),
      recommended_outreach_angle: z.string(),
      sales_priority: z.enum(["high", "medium", "low"]),
      confidence_score: z.number().min(0).max(100),
    }),
  }),
  async handler(_input, _ctx) {
    // TODO(phase-5): port v1 `lib/crm/enrichment-service.ts` (Modal crawl + Kimi analysis).
    throw new Error("crm.enrich not implemented — see docs/ROADMAP.md Phase 5");
  },
});
