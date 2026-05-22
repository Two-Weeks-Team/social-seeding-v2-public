/**
 * Full TS test gate — `pnpm test`.
 *
 * Boots a single ephemeral in-memory MongoDB and runs every workspace package
 * that defines a `test` script, each against its OWN database name
 * (`MONGODB_DB`). The Mongo-backed packages (capabilities/workflows/agents)
 * default to the `social_seeding` db, so running them against one shared mongod
 * cross-contaminates collections (a package's leftover docs break another's
 * setup/teardown). Giving each package a distinct db isolates them while each
 * `vitest run` still shares one db within itself, as those suites expect.
 *
 * Self-contained: no external `pnpm run dev-mongo` needed. Used locally, by the
 * pre-push gate, and in CI (`unit-tests` job) so all three agree.
 *
 * NOTE: package runs use async `spawn`, NOT `spawnSync`. mongodb-memory-server
 * pipes the mongod's stdout to this process; a synchronous spawn freezes this
 * event loop for the child's whole duration, the pipe buffer fills, mongod
 * blocks on write, and connections time out. Async spawn keeps the pipe drained.
 *
 *   pnpm test          # boots mongo, runs all package suites, exits non-zero on any failure
 */
import { spawn } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import process from "node:process";
import { MongoMemoryServer } from "mongodb-memory-server";

interface Pkg {
  name: string;
}

function packagesWithTestScript(): Pkg[] {
  const manifests = globSync(["packages/*/package.json", "apps/*/package.json"]);
  const pkgs: Pkg[] = [];
  for (const file of manifests.sort()) {
    const json = JSON.parse(readFileSync(file, "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    if (json.name && json.scripts?.test) {
      pkgs.push({ name: json.name });
    }
  }
  return pkgs;
}

function runPackageTest(name: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["--filter", name, "test"], {
      stdio: "inherit",
      env,
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main(): Promise<void> {
  const pkgs = packagesWithTestScript();
  if (pkgs.length === 0) {
    console.error("test-all: no workspace package defines a `test` script");
    process.exit(1);
  }

  const server = await MongoMemoryServer.create();
  const uri = server.getUri();
  console.log(`test-all: ephemeral mongod at ${uri}`);
  console.log(`test-all: ${pkgs.length} package suites → ${pkgs.map((p) => p.name).join(", ")}\n`);

  const failed: string[] = [];
  try {
    for (const pkg of pkgs) {
      const dbName = `ss_test_${pkg.name.replace(/[^a-z0-9]+/gi, "_")}`;
      const code = await runPackageTest(pkg.name, {
        ...process.env,
        MONGODB_URI: uri,
        MONGODB_DB: dbName,
      });
      if (code !== 0) failed.push(pkg.name);
    }
  } finally {
    await server.stop();
  }

  if (failed.length > 0) {
    console.error(`\ntest-all: FAILED — ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log("\ntest-all: all package test suites passed");
}

main().catch((err: unknown) => {
  console.error("test-all failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
