import { z } from "zod";

/**
 * Lead contract — Phase 5 P5-C1. A B2B sales lead (a company we want to
 * cold-pitch). v1's `lib/crm` had a much richer 30+-field shape; v2 keeps
 * what the lead-campaign workflow + the research agent + the outreach
 * writer actually consume, leaving v1's bookkeeping fields (assignedTo,
 * crmStage, verified, etc.) on the shared `crm_accounts` collection for
 * v1 to own.
 *
 * v2 stores its own rollup on `v2_leads` (additive — keyed by
 * `sharedAccountId` when the lead was imported from the v1 collection;
 * standalone when imported directly into v2). Reads merge.
 */

/** v2 lifecycle states — narrower than v1's crmStage. */
export const LeadStageSchema = z.enum([
  "imported", // raw row from import
  "enriching", // crm.enrich in flight
  "enriched", // Modal+Kimi analysis attached
  "researching", // research agent running
  "researched", // research summary attached, ready for outreach
  "outreach_sent",
  "in_conversation",
  "agreed",
  "declined",
  "no_response",
  "flaked",
]);
export type LeadStage = z.infer<typeof LeadStageSchema>;

/**
 * Output of `crm.enrich` — Modal crawl + Kimi analysis. Faithful port of
 * the v1 `lib/crm/enrichment-service.ts` shape, trimmed to what we
 * actually use downstream. Korean text per v1's K-beauty focus.
 */
export const LeadEnrichmentSchema = z.object({
  /** Raw inputs from the crawl. */
  websiteData: z.object({
    url: z.string(),
    normalizedUrl: z.string().optional(),
    pagesVisited: z.number().int().nonnegative().default(0),
    extractedTextChars: z.number().int().nonnegative().default(0),
    emails: z.array(z.string()).default([]),
    socialLinks: z.record(z.string(), z.string()).default({}),
  }),
  /** Kimi analysis — verbatim v1 field names + ranges. */
  analysis: z.object({
    company_summary: z.string(),
    main_products: z.string().default(""),
    product_categories: z.string().default(""),
    business_type: z.string().default("unclear"),
    target_market: z.string().default(""),
    global_presence: z.string().default("unclear"),
    key_strengths: z.string().default(""),
    brand_positioning: z.string().default(""),
    sns_presence: z.string().default(""),
    recommended_outreach_angle: z.string(),
    sales_priority: z.enum(["high", "medium", "low"]).default("medium"),
    sales_priority_reason: z.string().default(""),
    confidence_score: z.number().min(0).max(100).default(0),
    reasoning_brief: z.string().default(""),
  }),
  enrichedAt: z.coerce.date(),
});
export type LeadEnrichment = z.infer<typeof LeadEnrichmentSchema>;

/**
 * Output of the research agent (P5-C2) — distilled brief that the
 * outreach-writer + conversation agents (reused from Phase 2) can read
 * just like a Phase-2 `CampaignBrief`. The lead-campaign workflow
 * constructs an *ephemeral* brief from this; we don't persist a
 * full Phase-2 brief per lead (would be redundant with `enrichment` +
 * the lead-campaign config).
 */
export const LeadResearchSchema = z.object({
  /** Short narrative the writer's prompt anchors on. */
  pitch: z.string().min(20).max(800),
  /** Specific outreach angles the writer chooses among. */
  angles: z.array(z.string().min(10).max(280)).min(1).max(5),
  /** Concrete facts to ground the cold email (no inventions). */
  groundedFacts: z.array(z.string().min(5).max(280)).default([]),
  /** Recommended decision-maker contact (title/role). */
  contactProfile: z.string().default(""),
  /** Confidence in the research (0-100). */
  confidence: z.number().min(0).max(100).default(50),
  researchedAt: z.coerce.date(),
});
export type LeadResearch = z.infer<typeof LeadResearchSchema>;

export const LeadSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /** If imported from the v1 shared collection, this is the source row id. */
  sharedAccountId: z.string().optional(),
  companyName: z.string().min(1),
  companyNameEn: z.string().optional(),
  homepageUrl: z.string().url().optional(),
  country: z.string().length(2).default("KR"),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().optional(),
  snsLinks: z.record(z.string(), z.string()).default({}),
  tags: z.array(z.string()).default([]),
  stage: LeadStageSchema,
  /** Phase-5 P5-C1 — populated when crm.enrich runs. */
  enrichment: LeadEnrichmentSchema.optional(),
  /** Phase-5 P5-C2 — populated when the research agent runs. */
  research: LeadResearchSchema.optional(),
  /** Gmail thread once outreach starts (mirrors CreatorTrack.threadId). */
  threadId: z.string().optional(),
  /** Last time anything moved on this lead. */
  lastActivityAt: z.coerce.date(),
  /** Optional operator note. */
  notes: z.string().default(""),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Lead = z.infer<typeof LeadSchema>;

/**
 * Lead-campaign brief — the operator's intent. A list of company names /
 * URLs becomes a campaign that imports → enriches → researches → outreach
 * → conversation loop → on interest, optionally hands off to a
 * brand-campaign (the sales-funnel handoff that's the original "we run
 * our own GTM" loop from v1's STATUS.md).
 */
export const LeadCampaignBriefSchema = z.object({
  workspaceId: z.string(),
  createdBy: z.string(),
  /** "Pitch to K-beauty brands" / "Pitch to D2C cosmetics in Korea" — the brief in one line. */
  name: z.string().min(2).max(120),
  /** What we're selling — anchors the writer + research. */
  ourProduct: z.object({
    name: z.string().min(1), // "Social Seeding"
    pitchSummary: z.string().min(10), // "TikTok influencer marketing platform"
    keyClaims: z.array(z.string()).default([]),
  }),
  targeting: z.object({
    /** Country codes (ISO-3166-1 alpha-2) we filter on. */
    countries: z.array(z.string().length(2)).default(["KR"]),
    /** Optional category filter (v1's `lib/crm/constants.ts` enum values). */
    categories: z.array(z.string()).default([]),
    /** Skip leads on the v1 shared blacklist (port of brand-campaign's flag). */
    excludeBlacklist: z.boolean().default(true),
  }),
  outreach: z.object({
    /** Hard cap on cold sends per cron tick — protects deliverability + bill. */
    maxSendsPerBatch: z.number().int().positive().default(20),
    /** Sender voice — fed to the outreach-writer's prompt. */
    toneNotes: z.string().default(""),
  }),
  goals: z.object({
    /** Number of qualified replies (state >= in_conversation) before we declare success. */
    targetReplies: z.number().int().positive(),
    deadline: z.coerce.date(),
    budgetUsd: z.number().nonnegative().optional(),
  }),
});
export type LeadCampaignBrief = z.infer<typeof LeadCampaignBriefSchema>;

export const LeadCampaignSchema = z.object({
  id: z.string(),
  brief: LeadCampaignBriefSchema,
  status: z.enum(["draft", "running", "paused", "completed", "cancelled"]),
  /** v2 lifecycle stages for a lead campaign — narrower than brand-campaign's 6 stages. */
  stage: z.enum(["overview", "import", "research", "outreach", "performance"]),
  /** Lead ids in this campaign. */
  leadIds: z.array(z.string()).default([]),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type LeadCampaign = z.infer<typeof LeadCampaignSchema>;
