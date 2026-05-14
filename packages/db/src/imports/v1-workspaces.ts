import { Collections } from "../collections";
import { getDb } from "../client";
import { defaultPolicy, workspaceRepo } from "../repositories/workspace.repo";

/**
 * v1 → v2 workspace importer — Phase 6 P6-C1. Reads the shared
 * `workspaces` collection (v1-owned; SHARED_WORKSPACES) and provisions
 * a v2_workspace_policies row for each workspace that doesn't already
 * have one. Handler lives here (in @ss/db) so it can be unit-tested;
 * `scripts/import-v1-workspaces.ts` is a thin CLI wrapper.
 *
 * Discipline:
 *  · READ-ONLY on `workspaces` (v1-owned per FREEZE.md §3).
 *  · ADDITIVE-ONLY on `v2_workspace_policies` — `defaultPolicy()` ships
 *    every gate `always_ask` so the operator opts INTO automation, not
 *    out of it. Existing v2 rows are never overwritten (membership
 *    check against the workspaceId index).
 *  · Idempotent — re-running is a no-op for already-imported workspaces.
 *  · `canceledAt != null` workspaces skipped by default; `--include-
 *    canceled` includes them (rare backfill case for historical access).
 *  · `cleanupMutationAt != null` workspaces ALWAYS skipped — v1's
 *    cleanup cron crossed the point-of-no-return on these per v1's
 *    `workspace.ts`; importing them would create a policy row for a
 *    tombstone.
 */

export interface ImporterOpts {
  dryRun: boolean;
  includeCanceled: boolean;
}

export interface ImportResult {
  scanned: number;
  /** When dryRun: how many rows the importer WOULD create. */
  created: number;
  alreadyImported: number;
  skippedCanceled: number;
  failures: Array<{ workspaceId: string; reason: string }>;
  /** Up to 5 ids per bucket — useful in dry-run summary. */
  preview: {
    wouldCreate: string[];
    wouldSkipCanceled: string[];
    alreadyImported: string[];
  };
}

interface V1WorkspaceRow {
  _id: unknown;
  canceledAt?: Date | null;
  cleanupMutationAt?: Date | null;
}

export async function importV1Workspaces(opts: ImporterOpts): Promise<ImportResult> {
  const result: ImportResult = {
    scanned: 0,
    created: 0,
    alreadyImported: 0,
    skippedCanceled: 0,
    failures: [],
    preview: { wouldCreate: [], wouldSkipCanceled: [], alreadyImported: [] },
  };

  const db = await getDb();
  const filter: Record<string, unknown> = {
    cleanupMutationAt: { $in: [null, undefined] },
  };
  if (!opts.includeCanceled) {
    filter.canceledAt = { $in: [null, undefined] };
  }
  const v1Rows = await db
    .collection<V1WorkspaceRow>(Collections.SHARED_WORKSPACES)
    .find(filter)
    .toArray();

  // Pre-fetch existing policies so the per-row check is set-membership.
  const existingPolicies = new Set(
    (await db
      .collection<{ workspaceId: string }>(Collections.V2_WORKSPACE_POLICIES)
      .find({}, { projection: { workspaceId: 1 } })
      .toArray())
      .map((p) => p.workspaceId),
  );

  for (const row of v1Rows) {
    result.scanned++;
    const workspaceId = String(row._id);
    try {
      // Defense in depth: skip canceled even if the Mongo filter let
      // one through (race with v1's cleanup writing canceledAt).
      if (!opts.includeCanceled && row.canceledAt) {
        result.skippedCanceled++;
        if (result.preview.wouldSkipCanceled.length < 5) {
          result.preview.wouldSkipCanceled.push(workspaceId);
        }
        continue;
      }
      if (existingPolicies.has(workspaceId)) {
        result.alreadyImported++;
        if (result.preview.alreadyImported.length < 5) {
          result.preview.alreadyImported.push(workspaceId);
        }
        continue;
      }
      if (opts.dryRun) {
        result.created++;
        if (result.preview.wouldCreate.length < 5) {
          result.preview.wouldCreate.push(workspaceId);
        }
        continue;
      }
      // Insert-only upsert. Codex review P6 P2#3: `savePolicy` uses
      // `$set` + upsert, which would stomp a row created between our
      // snapshot read and this write (operator saving /policies during
      // a long import, or another concurrent importer run). The
      // `$setOnInsert` variant is a no-op when a row exists, preserving
      // the additive-only / never-overwrite guarantee.
      const inserted = await workspaceRepo.createPolicyIfMissing(defaultPolicy(workspaceId));
      if (inserted) {
        result.created++;
        if (result.preview.wouldCreate.length < 5) {
          result.preview.wouldCreate.push(workspaceId);
        }
      } else {
        // Lost the race — a policy row appeared between our snapshot
        // and this write. Treat as alreadyImported for the counters.
        result.alreadyImported++;
      }
    } catch (err) {
      result.failures.push({
        workspaceId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
