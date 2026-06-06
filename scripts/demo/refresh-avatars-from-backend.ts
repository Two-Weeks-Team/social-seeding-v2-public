/**
 * DEMO-ONLY (local, uncommitted helper): refresh seeded creators' avatar URLs
 * with FRESH TikTok CDN images via the same backend.socialseed.ing pipeline the
 * `tiktok.getCreator` capability uses. Patches ONLY avatarThumb/avatarLarger on
 * the local demo `accounts_tiktok` (seeded nickname/followers/analytics kept so
 * the recorded narrative numbers stay stable). Backend creds are read at runtime
 * from a v1 env file (default ~/social-seeding/.env.local) — never embedded.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27027/instarsearch \
 *   pnpm exec tsx scripts/demo/refresh-avatars-from-backend.ts
 */
import { readFileSync } from "node:fs";
import os from "node:os";

function parseEnvFile(p: string): Record<string, string> {
  const o: Record<string, string> = {};
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] && !line.trimStart().startsWith("#")) o[m[1]] = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* ignore */
  }
  return o;
}

// 1) Pull backend creds from the v1 env (the connection v1 already uses).
const v1EnvPath = process.env.V1_ENV_PATH ?? `${os.homedir()}/social-seeding/.env.local`;
const v1 = parseEnvFile(v1EnvPath);
for (const k of ["BACKEND_DASHBOARD_EMAIL", "BACKEND_DASHBOARD_PASSWORD"]) {
  if (!process.env[k] && v1[k]) process.env[k] = v1[k];
}
process.env.SS_BACKEND_URL ??= (v1.BACKEND_URL || "https://backend.socialseed.ing").replace(/\/+$/, "");
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27027/instarsearch";

if (!process.env.BACKEND_DASHBOARD_EMAIL || !process.env.BACKEND_DASHBOARD_PASSWORD) {
  console.error(`[refresh-avatars] missing backend creds (looked in ${v1EnvPath})`);
  process.exit(1);
}

async function main(): Promise<void> {
  // Import AFTER env is set (the fetcher reads env lazily, the db reads MONGODB_URI on connect).
  // JIT-monorepo relative imports (matches scripts/demo/wooriliu-seed.ts).
  const { getTikTokFetcher } = await import("../../packages/capabilities/src/index.ts");
  const { getDb, Collections, closeMongo } = await import("../../packages/db/src/index.ts");

  const db = await getDb();
  const col = db.collection(Collections.SHARED_TIKTOK_ACCOUNTS);
  const handles: string[] = (await col.distinct("uniqueId")).filter((h): h is string => typeof h === "string" && h.length > 0);
  console.log(`[refresh-avatars] ${handles.length} handles in ${Collections.SHARED_TIKTOK_ACCOUNTS} via ${process.env.SS_BACKEND_URL}`);

  const fetcher = getTikTokFetcher();
  const now = Math.floor(Date.now() / 1000);
  let ok = 0;
  let failed = 0;
  for (const h of handles) {
    try {
      const c = await fetcher.getUserInfo(h);
      const avatarThumb = c.avatarThumb;
      const avatarLarger = c.avatarLarger ?? c.avatarThumb;
      if (!avatarThumb) {
        console.log(`  · ${h}: no avatar in response — skipped`);
        failed++;
        continue;
      }
      await col.updateMany({ uniqueId: h }, { $set: { avatarThumb, avatarLarger, avatarRefreshedAt: new Date() } });
      const exp = avatarThumb.match(/x-expires=(\d+)/)?.[1];
      const validH = exp ? Math.round((Number(exp) - now) / 3600) : null;
      console.log(`  ✓ ${h}: ${new URL(avatarThumb).host}${validH != null ? ` (x-expires +${validH}h)` : ""}`);
      ok++;
    } catch (err) {
      console.log(`  ✗ ${h}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  console.log(`[refresh-avatars] done — ${ok} refreshed, ${failed} skipped/failed`);
  await closeMongo();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
