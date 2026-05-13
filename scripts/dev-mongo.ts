/**
 * Local mongod for the Phase-0 demos / dev — runs an in-process MongoDB via
 * `mongodb-memory-server` on a fixed port + persistent dbPath so we don't
 * point at the shared v1 Atlas without explicit intent (see SCOPE-DECISIONS.md
 * §C). The same `MONGODB_URI` is used by `scripts/init-indexes.ts`, `apps/web`'s
 * dev server, and Inngest's brand-campaign run, which is why this lives outside
 * any single package.
 *
 *   pnpm run dev-mongo          # long-running; Ctrl-C to stop
 *   → mongodb://127.0.0.1:27027/social_seeding
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { MongoMemoryServer } from "mongodb-memory-server";

const PORT = Number(process.env.DEV_MONGO_PORT ?? 27027);
const DB_NAME = process.env.MONGODB_DB ?? "social_seeding";
const DB_PATH = resolve(".mongo-dev/data");

mkdirSync(DB_PATH, { recursive: true });

async function main(): Promise<void> {
  const server = await MongoMemoryServer.create({
    instance: { port: PORT, dbPath: DB_PATH, storageEngine: "wiredTiger" },
  });

  // scripts/init-indexes.ts and apps/web read MONGODB_URI from the env — keep
  // this URI shape compatible (include the db name in the connection string).
  const uri = `mongodb://127.0.0.1:${PORT}/${DB_NAME}`;
  console.log(`mongod ready: ${uri}`);
  console.log(`pid: ${process.pid}, dbPath: ${DB_PATH}`);
  console.log("press Ctrl-C to stop");

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`\n${sig} → stopping mongod`);
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("dev-mongo failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
