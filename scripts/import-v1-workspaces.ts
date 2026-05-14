/**
 * import-v1-workspaces — Phase 6 P6-C1 CLI. Thin wrapper around
 * `@ss/db`'s `importV1Workspaces`. Reads the shared `workspaces`
 * collection (v1-owned) and provisions a v2_workspace_policies row
 * for every workspace that doesn't already have one.
 *
 *   pnpm exec tsx scripts/import-v1-workspaces.ts                  # live
 *   pnpm exec tsx scripts/import-v1-workspaces.ts --dry-run        # plan only
 *   pnpm exec tsx scripts/import-v1-workspaces.ts --include-canceled
 *
 * Read-only on the shared collection; additive-only on v2. Idempotent.
 * Full discipline + the per-bucket skip rules are documented at
 * `packages/db/src/imports/v1-workspaces.ts`.
 */
import process from "node:process";
import { closeMongo, importV1Workspaces, type ImporterOpts } from "@ss/db";

try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local — fall back to whatever's already in the environment
}

function parseArgs(): ImporterOpts {
  const argv = new Set(process.argv.slice(2));
  return {
    dryRun: argv.has("--dry-run"),
    includeCanceled: argv.has("--include-canceled"),
  };
}

function looksUnconfigured(uri: string | undefined): boolean {
  return !uri || !uri.startsWith("mongodb") || uri.includes("...");
}

async function main(): Promise<void> {
  const opts = parseArgs();
  if (looksUnconfigured(process.env.MONGODB_URI)) {
    throw new Error(
      `MONGODB_URI must be a real Mongo connection string (got ${JSON.stringify(process.env.MONGODB_URI)}). ` +
        "Set it in .env.local — same Atlas cluster v1 uses (FREEZE.md §3).",
    );
  }
  const dbName = process.env.MONGODB_DB ?? "social_seeding";
  console.log(
    `v1 → v2 workspace importer — db="${dbName}" ${opts.dryRun ? "[DRY-RUN]" : "[LIVE]"}` +
    `${opts.includeCanceled ? " [+canceled]" : ""}`,
  );
  const r = await importV1Workspaces(opts);
  console.log("");
  console.log(`Scanned          ${r.scanned}`);
  console.log(`Created          ${r.created}${opts.dryRun ? " (would)" : ""}`);
  console.log(`Already imported ${r.alreadyImported}`);
  console.log(`Skipped canceled ${r.skippedCanceled}`);
  console.log(`Failures         ${r.failures.length}`);
  if (r.preview.wouldCreate.length > 0) {
    console.log(`\n  ${opts.dryRun ? "would create" : "created"} (first 5):`);
    for (const id of r.preview.wouldCreate) console.log(`    · ${id}`);
  }
  if (r.preview.alreadyImported.length > 0) {
    console.log(`\n  already imported (first 5):`);
    for (const id of r.preview.alreadyImported) console.log(`    · ${id}`);
  }
  if (r.failures.length > 0) {
    console.log(`\n  failures:`);
    for (const f of r.failures.slice(0, 10)) console.log(`    · ${f.workspaceId} — ${f.reason}`);
  }
  await closeMongo();
  process.exitCode = r.failures.length > 0 ? 1 : 0;
}

await main();
