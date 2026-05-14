import { z } from "zod";
import { LeadEnrichmentSchema } from "@ss/contracts";
import { leadRepo } from "@ss/db";
import { defineCapability } from "../registry";
import { getCrmEnrichClientFactory } from "./client";

/**
 * crm.enrich — Phase 5 P5-C1. Crawl a company website (Modal) +
 * analyze it (Kimi/Moonshot) into the structured sales fields that the
 * research agent (P5-C2) and the lead-campaign workflow (P5-C3) consume.
 *
 * Behavior:
 *   · scope = "read" (we're synthesizing public info — no external_send).
 *   · idempotent = true; rate-limited via `crm_enrich` class (per-workspace).
 *   · Pipeline: crawl → analyze. Both steps run via the injectable
 *     `CrmEnrichClient` seam — production uses Modal + Kimi from env;
 *     tests inject a fake.
 *   · When `leadId` is supplied, the resulting enrichment is persisted
 *     on the v2_leads row via `leadRepo.patchEnrichment`, which also
 *     advances the lead's stage to "enriched". When omitted, the
 *     capability just returns the enrichment (useful for one-off ops
 *     work).
 *   · Errors surface clearly — Modal returning non-success or Kimi
 *     returning non-JSON throws with the original status in the
 *     message. Inngest's retry/backoff handles transient failures.
 */
export const crmEnrich = defineCapability({
  name: "crm.enrich",
  description:
    "Crawl a company website (Modal) and analyze it (Kimi) into structured sales fields. When `leadId` is supplied, persists the enrichment on v2_leads and advances the lead's stage to 'enriched'.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "crm_enrich",
  input: z.object({
    /** Homepage URL — anything reachable via HTTP(S). */
    url: z.string().url(),
    /** Company name — fed to the analysis prompt as context. */
    companyName: z.string().min(1),
    /** Optional v2_leads row id. When set, persist the result. */
    leadId: z.string().optional(),
    /** Max pages the Modal crawler walks. Defaults to v1's 20. */
    maxPages: z.number().int().positive().max(50).default(20),
  }),
  output: z.object({
    enrichment: LeadEnrichmentSchema,
    /** True when leadId was supplied AND the row was patched. */
    persisted: z.boolean(),
  }),
  async handler({ url, companyName, leadId, maxPages }, _ctx) {
    const factory = getCrmEnrichClientFactory();
    const client = await factory();
    const crawl = await client.crawl(url, { maxPages });
    const analysis = await client.analyze({ companyName, homepageUrl: url, crawl });
    const enrichment = LeadEnrichmentSchema.parse({
      websiteData: {
        url: crawl.url,
        normalizedUrl: crawl.normalizedUrl,
        pagesVisited: crawl.pagesVisited,
        extractedTextChars: crawl.text.length,
        emails: crawl.emails,
        socialLinks: crawl.socialLinks,
      },
      analysis,
      enrichedAt: new Date(),
    });
    let persisted = false;
    if (leadId) {
      await leadRepo.patchEnrichment(leadId, enrichment);
      persisted = true;
    }
    return { enrichment, persisted };
  },
});
