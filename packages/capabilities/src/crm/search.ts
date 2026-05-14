import { z } from "zod";
import { Collections, getDb, leadRepo } from "@ss/db";
import type { Lead } from "@ss/contracts";
import { defineCapability } from "../registry";

/**
 * crm.search — Phase 5 P5-C1. Read-only search across v2_leads (our
 * overlay) + the shared `crm_accounts` collection (v1-owned data we
 * import from). Used by:
 *
 *   · The lead-campaign workflow's import step — given a list of
 *     names/URLs, find which already exist in shared so we can skip
 *     re-enrichment.
 *   · MC's `/leads` search box (Phase 5 P5-C4).
 *
 * Search dimensions (any/all optional, AND-combined):
 *   · `query`        — substring match on companyName or companyNameEn
 *                      (case-insensitive).
 *   · `countries`    — ISO 3166-1 alpha-2 list.
 *   · `excludeIds`   — v2_leads ids to skip (already-imported guard).
 *
 * Returns a unioned list, deduped on `sharedAccountId` (the v2 row
 * wins when both exist). Capped at 50 results to bound the read.
 */
export const crmSearch = defineCapability({
  name: "crm.search",
  description:
    "Search v2_leads + shared crm_accounts for leads matching the query. Read-only; useful for the lead-campaign import path and MC's /leads search.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "default",
  input: z.object({
    workspaceId: z.string().min(1),
    query: z.string().optional(),
    countries: z.array(z.string().length(2)).optional(),
    excludeIds: z.array(z.string()).default([]),
    limit: z.number().int().positive().max(100).default(50),
  }),
  output: z.object({
    /** From v2_leads. Includes enrichment / research / stage when present. */
    leads: z.array(z.object({
      id: z.string(),
      sharedAccountId: z.string().optional(),
      companyName: z.string(),
      country: z.string().optional(),
      stage: z.string(),
    })),
    /** From shared crm_accounts (v1 data) that aren't yet in v2_leads. */
    sharedCandidates: z.array(z.object({
      sharedAccountId: z.string(),
      companyName: z.string(),
      companyNameEn: z.string().optional(),
      country: z.string().optional(),
      homepageUrl: z.string().optional(),
    })),
  }),
  async handler({ workspaceId, query, countries, excludeIds, limit }, _ctx) {
    // 1. v2_leads matching the filters
    const all = await leadRepo.listByWorkspace(workspaceId, 1000);
    const lowercaseQ = query?.toLowerCase().trim();
    const countrySet = countries && countries.length > 0 ? new Set(countries) : null;
    const excludeSet = new Set(excludeIds);
    const v2 = all
      .filter((l: Lead) => {
        if (excludeSet.has(l.id)) return false;
        if (countrySet && !countrySet.has(l.country)) return false;
        if (lowercaseQ) {
          const hay = `${l.companyName} ${l.companyNameEn ?? ""}`.toLowerCase();
          if (!hay.includes(lowercaseQ)) return false;
        }
        return true;
      })
      .slice(0, limit);

    // 2. Shared crm_accounts NOT already in v2_leads. Read freely; never write.
    const importedSharedIds = new Set(
      all.filter((l) => l.sharedAccountId).map((l) => l.sharedAccountId!),
    );
    const db = await getDb();
    const sharedFilter: Record<string, unknown> = {
      deletedAt: { $in: [null, undefined] },
    };
    if (countrySet) sharedFilter.country = { $in: [...countrySet] };
    if (lowercaseQ) {
      // v1's collection has companyName + companyNameEn; both substring,
      // case-insensitive. MongoDB's $regex is case-insensitive with the
      // `i` flag. P5 codex review P2#4: escape regex special chars so a
      // company name containing `[`, `(`, or `.` is treated as literal
      // text instead of a regex pattern (or, worse, an invalid pattern
      // that throws at query time).
      const escaped = lowercaseQ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = { $regex: escaped, $options: "i" };
      sharedFilter.$or = [{ companyName: rx }, { companyNameEn: rx }];
    }
    const sharedDocs = await db
      .collection<{
        _id: unknown;
        companyName?: string;
        companyNameEn?: string | null;
        country?: string;
        homepageUrl?: string | null;
      }>(Collections.SHARED_CRM_ACCOUNTS)
      .find(sharedFilter)
      .limit(limit + importedSharedIds.size) // overfetch to absorb dedupes
      .toArray();
    const sharedCandidates = sharedDocs
      .map((d) => {
        const sharedAccountId = String(d._id);
        const homepageUrl = typeof d.homepageUrl === "string" ? d.homepageUrl : undefined;
        return {
          sharedAccountId,
          companyName: d.companyName ?? "(unknown)",
          ...(typeof d.companyNameEn === "string" ? { companyNameEn: d.companyNameEn } : {}),
          ...(d.country ? { country: d.country } : {}),
          ...(homepageUrl ? { homepageUrl } : {}),
        };
      })
      .filter((c) => !importedSharedIds.has(c.sharedAccountId))
      .slice(0, limit);

    return {
      leads: v2.map((l) => ({
        id: l.id,
        ...(l.sharedAccountId ? { sharedAccountId: l.sharedAccountId } : {}),
        companyName: l.companyName,
        ...(l.country ? { country: l.country } : {}),
        stage: l.stage,
      })),
      sharedCandidates,
    };
  },
});
