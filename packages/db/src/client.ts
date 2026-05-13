import { MongoClient, type Db } from "mongodb";

/**
 * MongoDB singleton. Points at the SAME Atlas cluster v1 uses (FREEZE.md §3),
 * so creator data / campaign history / CRM carry over with zero migration.
 *
 * Caches the client across hot reloads (dev) and across serverless invocations
 * (prod) the same way v1's `lib/mongodb.ts` does.
 */
declare global {
  // eslint-disable-next-line no-var
  var __ssMongo: { client: MongoClient; promise: Promise<MongoClient> } | undefined;
}

function uri(): string {
  const u = process.env.MONGODB_URI;
  if (!u) throw new Error("MONGODB_URI is not set");
  return u;
}

export async function getMongoClient(): Promise<MongoClient> {
  if (globalThis.__ssMongo) return globalThis.__ssMongo.promise;
  const client = new MongoClient(uri(), { maxPoolSize: 10 });
  const promise = client.connect();
  globalThis.__ssMongo = { client, promise };
  return promise;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(process.env.MONGODB_DB ?? "social_seeding");
}

export async function closeMongo(): Promise<void> {
  if (!globalThis.__ssMongo) return;
  await globalThis.__ssMongo.client.close();
  globalThis.__ssMongo = undefined;
}
