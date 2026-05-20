# DEPLOY-STATUS-web.md — Mission Control (apps/web) on Cloud Run

**Task**: I2 — deploy Track 2 Mission Control (Next.js 16) to GCP Cloud Run.
**Date**: 2026-05-20
**Operator**: app.2weeks@gmail.com
**Project**: `ss-v2-prod` (new, isolated — production `social-seeding-backend` :8080 and `ss-landing`/`ss-shared-infra` untouched)

---

## Status

| Field | Value |
|---|---|
| **I2 STATUS** | **DONE** |
| Build context | repository root (`.`) — required by the monorepo Dockerfile |
| standalone output | **yes** (gated on `NEXT_OUTPUT=standalone`, with `outputFileTracingRoot` = repo root) |
| Service name | `ss-v2-web` |
| Service URL | https://ss-v2-web-722660901814.us-central1.run.app |
| Alt URL | https://ss-v2-web-p7qelej4vq-uc.a.run.app (same service) |
| Region | us-central1 |
| Health check | **200** at `/api/healthz` |
| Image | `us-central1-docker.pkg.dev/ss-v2-prod/ss-web/web:bce1a7d` (+`:latest`) |
| Revision | `ss-v2-web-00001-s7g` (100% traffic) |
| Build retries | 1 (first build failed on workspace dep resolution — fixed; see below) |
| Scale | min=0 (scale-to-zero, D46), max=10 |
| Resources | 1 vCPU / 1Gi memory |
| Auth | `--allow-unauthenticated` |

---

## Verification (run 2026-05-20)

```
curl -sI https://ss-v2-web-722660901814.us-central1.run.app/api/healthz
→ HTTP 200  {"ok":true,"service":"ss-web","revision":"bce1a7d","commit":"bce1a7d","ts":"..."}

curl /            → 307  (redirect to /sign-in; root requires auth — expected)
curl /sign-in     → 200  (static shell renders with NO backend secrets)
```

The container boots and serves the static shell + health endpoint **without** `MONGODB_URI`,
`AUTH_*`, or OAuth secrets — so the deploy is real, not image-only. Authenticated routes
(`/`, `/campaigns`, …) will 5xx until secrets are wired (see "Next steps").

---

## Cost estimate

- **min-instances=0** → scales to zero when idle → **~$0/mo at rest** (D46).
- Per-request: 1 vCPU + 1Gi billed only while serving. A demo-level load (a few hundred
  requests/day, sub-second SSR) is well under **$1/mo**. No always-on instance, no LB, no
  VPC connector, no CMEK in this minimal footprint.
- Artifact Registry: one `ss-web` image (~150–250 MB compressed) → < $0.10/mo storage.
- **Total at demo scale: < $1/mo.** (No $20 threshold breach.)

---

## What was fixed to make this build (3 real defects in the P1-W7prep artifacts)

These were genuine bugs in the deploy artifacts, not drive-by changes. Each blocked the build/boot:

1. **`apps/web/next.config.ts` never emitted standalone.**
   The Dockerfile sets `ENV NEXT_OUTPUT=standalone` and comments "we patch next.config via env var",
   but the config did not read `NEXT_OUTPUT` and had no `output: 'standalone'`. Result: no
   `.next/standalone/` → the runner-stage `COPY .../.next/standalone` would fail.
   **Fix**: config now adds `output: 'standalone'` + `outputFileTracingRoot` (repo root, required
   for monorepo per Next.js docs) **only when `NEXT_OUTPUT=standalone`** — local `next dev`/`next start`
   unchanged.

2. **`/api/healthz` route did not exist.**
   The Dockerfile HEALTHCHECK, `cloudbuild.yaml` smoke test, and `service.yaml` startup/liveness
   probes all target `/api/healthz`, but the route was absent → every probe would fail.
   **Fix**: added `apps/web/app/api/healthz/route.ts` — dependency-free (no auth, no DB, no `@ss/*`),
   returns 200 the moment `server.js` is up.

3. **Docker builder stage dropped workspace `node_modules`.**
   The builder only copied `/repo/node_modules` + `/repo/apps/web/node_modules`, omitting every
   `packages/*/node_modules`. pnpm puts each workspace package's deps (zod, etc.) in its own
   `node_modules`; without them, Next `transpilePackages` failed with module-not-found on all
   `@ss/*` internals (this was the **build-retry-1** failure).
   **Fix**: builder now re-runs `pnpm install --frozen-lockfile --prefer-offline` after `COPY . .`
   (pnpm store reused from the cache mount → fast relink). Materializes all workspace `node_modules`.

4. **`apps/web/public/` was missing** (the Dockerfile `COPY .../public` would 404).
   **Fix**: added `apps/web/public/.gitkeep`.

---

## How it was deployed (reproducible)

The canonical `deploy/web/cloudbuild.yaml` + `service.yaml` were **not** used here because that
pipeline `gcloud run services replace`s `service.yaml`, which references infra not provisioned in
this minimal `ss-v2-prod`: CMEK KMS keyring `ss-web`, Serverless VPC connector `ss-vpc-conn`,
`web-runner@` service account, four Secret Manager secrets, and `minScale=1`. Those are owned by
`terraform/environments/<env>/` per `deploy/README.md` §9 and are out of scope for I2.

Instead:

```bash
# 1. AR repo (one-time)
gcloud artifacts repositories create ss-web \
  --repository-format=docker --location=us-central1 --project=ss-v2-prod

# 2. Build + push (root context, deploy/web/Dockerfile) — build-only config, no scan/replace
SHA=$(git rev-parse --short HEAD)
gcloud builds submit . --project=ss-v2-prod --region=us-central1 \
  --config=deploy/web/cloudbuild.build-only.yaml --substitutions="_TAG=$SHA"

# 3. Deploy (scale-to-zero, D46)
gcloud run deploy ss-v2-web \
  --image="us-central1-docker.pkg.dev/ss-v2-prod/ss-web/web:$SHA" \
  --project=ss-v2-prod --region=us-central1 \
  --allow-unauthenticated --port=8080 \
  --memory=1Gi --cpu=1 --min-instances=0 --max-instances=10 \
  --set-env-vars="NODE_ENV=production,NEXT_TELEMETRY_DISABLED=1,REVISION_TAG=$SHA,COMMIT_SHA=$SHA" \
  --quiet
```

New helper artifact added: `deploy/web/cloudbuild.build-only.yaml` (build+push only; keeps the
canonical enterprise pipeline intact for when terraform has provisioned the rest).

---

## Next steps to make authenticated routes work (not done — needs operator decisions)

- Provision Secret Manager secrets (`web-auth-secret`, OAuth client id/secret) + `MONGODB_URI`
  and wire them in via `gcloud run services update --set-secrets / --set-env-vars`. Per workspace
  safety rules I did **not** read or copy any `.env`; only build-time/runtime-safe non-secret
  env was set.
- Decide MongoDB target: a **dev/test** Atlas DB, not the shared v1 production cluster.
- When CMEK/VPC/`web-runner` SA exist, switch to the canonical `deploy/web/cloudbuild.yaml`
  + `service.yaml` path for the enterprise footprint (min=1, CMEK, VPC egress).
