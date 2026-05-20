###############################################################################
# deploy/web/Dockerfile — Mission Control (Next.js 16) on Cloud Run
#
# Cites:
#   D7  — Containerized everywhere; engineering via background-agent automation
#   D13 — Multi-region active-active (this image must run in US/EU/APAC)
#   D17 — Vertex AI Agent Runtime is the agent host; this is the OPERATOR UI
#         (Mission Control) that *talks to* Agent Runtime + Cloud Workflows
#   D26 — Mission Control surface (Next.js 16) of the three-surface UI
#
# Build context: repository root (`/Users/kimsejun/Documents/GitHub/social-seeding-v2`)
# Build:
#   docker buildx build --platform=linux/amd64 \
#     -f deploy/web/Dockerfile -t web:dev .
#
# Run:
#   docker run --rm -p 8080:8080 -e PORT=8080 web:dev
#
# Notes:
#   * Next.js standalone output keeps the runtime image small; we copy only
#     `.next/standalone/`, `.next/static/`, and `public/`.
#   * Internal workspace packages (`packages/*`) are JIT-transpiled by Next via
#     `transpilePackages` — the build stage MUST see the whole monorepo.
#   * Non-root user (`nextjs:nextjs`) is created in the runtime stage.
#   * HEALTHCHECK pings `/api/healthz` (Cloud Run uses its own startup probe,
#     but Docker HEALTHCHECK helps local + Compose flows).
#   * No secrets baked into the image — Cloud Run env + Secret Manager only.
###############################################################################

# syntax=docker/dockerfile:1.7

###############################################################################
# Stage 1 — deps: cache pnpm fetch with full workspace lockfile
###############################################################################
FROM node:24-alpine AS deps
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate
WORKDIR /repo

# Copy the lockfile + workspace manifests first so the dependency layer
# caches independently of source edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/agents/package.json packages/agents/
COPY packages/capabilities/package.json packages/capabilities/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/observability/package.json packages/observability/
COPY packages/workflows/package.json packages/workflows/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

###############################################################################
# Stage 2 — builder: compile Next.js standalone
###############################################################################
FROM node:24-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate
WORKDIR /repo

# Bring the warm pnpm store/root node_modules forward, then copy the full
# monorepo. We re-run `pnpm install` so EVERY workspace package gets its own
# `packages/*/node_modules` (pnpm symlinks into the virtual store). Without
# this, Next's `transpilePackages` cannot resolve the @ss/* packages' own deps
# (zod, etc.) and the build fails with module-not-found. The store is reused
# from the cache mount so this is a fast relink, not a fresh download.
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# Next.js needs `output: 'standalone'` to produce `.next/standalone`.
# We patch the next.config.ts via env var so the source file stays untouched
# (the deploy concern shouldn't leak into the frontend repo).
ENV NEXT_OUTPUT=standalone

WORKDIR /repo/apps/web
RUN pnpm exec next build

###############################################################################
# Stage 3 — runner: minimal runtime, non-root, healthcheck
###############################################################################
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0

# wget for the HEALTHCHECK only; everything else stays out of the runtime
# layer so the attack surface is minimal.
RUN apk add --no-cache wget tini ca-certificates \
    && addgroup --system --gid 1001 nextjs \
    && adduser --system --uid 1001 --ingroup nextjs nextjs

# Standalone output: server.js + minimal node_modules + workspace JIT bundle.
COPY --from=builder --chown=nextjs:nextjs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nextjs /repo/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 8080

# Cloud Run injects PORT; we keep HEALTHCHECK using ${PORT} for compose parity.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/healthz" || exit 1

# tini handles PID 1 signal forwarding cleanly under Cloud Run scale-to-zero.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]

###############################################################################
# OCI image labels — SLSA / supply-chain provenance
###############################################################################
LABEL org.opencontainers.image.title="ss-web" \
      org.opencontainers.image.description="Social Seeding v2 Mission Control (Next.js 16) — operator UI for the 22-agent fleet (D17/D23/D26)" \
      org.opencontainers.image.source="https://github.com/ComBba/social-seeding-v2" \
      org.opencontainers.image.url="https://github.com/ComBba/social-seeding-v2" \
      org.opencontainers.image.licenses="BUSL-1.1" \
      org.opencontainers.image.vendor="Social Seeding" \
      org.opencontainers.image.documentation="https://github.com/ComBba/social-seeding-v2/blob/main/deploy/README.md"
# org.opencontainers.image.revision is stamped at build time via --label by
# Cloud Build (see deploy/web/cloudbuild.yaml).
