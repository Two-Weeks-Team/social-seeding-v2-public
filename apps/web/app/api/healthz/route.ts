import { NextResponse } from "next/server";

/**
 * Liveness/readiness probe for Cloud Run + Docker HEALTHCHECK.
 *
 * Intentionally dependency-free: no auth, no DB, no @ss/* imports. The
 * container must be able to answer 200 the moment `server.js` is up, before
 * any backend secrets (MONGODB_URI, AUTH_*, OAuth) are wired in. The deploy
 * artifacts (deploy/web/Dockerfile HEALTHCHECK, deploy/web/cloudbuild.yaml
 * smoke test, deploy/web/service.yaml startup/liveness probes) all target
 * this path.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "ss-web",
    revision: process.env.REVISION_TAG ?? process.env.K_REVISION ?? "local",
    commit: process.env.COMMIT_SHA ?? "unknown",
    ts: new Date().toISOString(),
  });
}
