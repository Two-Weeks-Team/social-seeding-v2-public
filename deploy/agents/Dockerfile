###############################################################################
# deploy/agents/Dockerfile — ss-agents-adk runtime container
#
# Cites:
#   D7  — Containerized everywhere
#   D13 — Multi-region active-active (US-central + EU-west + APAC-northeast)
#   D17 — Vertex AI Agent Runtime (managed) is the production host for this
#         binary. This Docker image is used as the (a) Cloud Run worker pool
#         per D17 supplementary deployment and (b) the build artifact that
#         `adk deploy agent_engine` packages up.
#   D23 — 22-agent fleet (16 domain + 3 meta + 3 watchdog) — all live here
#   D35 — Hybrid codebase strategy; this image is the "rebuild from zero" half
#
# Build context: repository root (`/Users/kimsejun/Documents/GitHub/social-seeding-v2`)
# Build:
#   docker buildx build --platform=linux/amd64 \
#     -f deploy/agents/Dockerfile -t agents:dev .
#
# Run:
#   docker run --rm -p 8080:8080 \
#     -e PORT=8080 \
#     -e GOOGLE_CLOUD_PROJECT=ss-v2-prod \
#     -e GOOGLE_CLOUD_LOCATION=us-central1 \
#     -e CAPABILITY_LAYER_MODE=stub \
#     agents:dev
#
# Notes:
#   * Python 3.12-slim per pyproject.toml `requires-python = ">=3.12,<3.13"`.
#   * uv (Astral) is the resolver/installer; pinned to the major version we
#     run in CI. Wheel cache mounted between layers to keep rebuilds fast.
#   * `uv pip install -e .` installs ss-agents-adk in editable mode against
#     the copy in `/app/src`. The runtime stage carries the virtualenv from
#     the builder stage, never the build toolchain.
#   * Non-root user (`adk:adk` uid 1001) created in the runtime stage.
#   * HEALTHCHECK pings `/healthz` on the served port.
###############################################################################

# syntax=docker/dockerfile:1.7

###############################################################################
# Stage 1 — builder: install ss-agents-adk into a venv under /opt/venv
###############################################################################
FROM python:3.12-slim AS builder

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1

# Build essentials for the few wheels that don't ship binary wheels for
# musl/glibc combos (e.g. tokenizers, orjson — guarded by uv's resolver).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# uv: pin to a known-good major. Astral cuts releases weekly; treat as a
# regular dependency and bump intentionally.
RUN pip install --no-cache-dir "uv>=0.5,<1"

WORKDIR /build

# Copy only the manifest first to maximize layer caching.
COPY packages/agents-adk/pyproject.toml packages/agents-adk/uv.lock packages/agents-adk/README.md ./
COPY packages/agents-adk/src ./src

# Create the venv and resolve deps from the lock file (reproducible builds).
RUN --mount=type=cache,id=uv-cache,target=/root/.cache/uv \
    uv venv /opt/venv \
 && . /opt/venv/bin/activate \
 && uv pip install --python /opt/venv/bin/python --no-cache -e .

###############################################################################
# Stage 2 — runtime: minimal, non-root, healthcheck
###############################################################################
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONPATH=/app/src \
    PORT=8080 \
    HOST=0.0.0.0

# curl for HEALTHCHECK + tini for clean signal forwarding. Nothing else.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        curl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 adk \
 && useradd --system --uid 1001 --gid adk --shell /usr/sbin/nologin --home-dir /app adk

WORKDIR /app

# Carry the venv + source tree from the builder stage. Editable install means
# Python resolves imports against /app/src, not the venv site-packages copy.
COPY --from=builder --chown=adk:adk /opt/venv /opt/venv
COPY --from=builder --chown=adk:adk /build/src /app/src

USER adk

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

# tini handles PID 1 signal forwarding cleanly under Cloud Run scale-to-zero.
ENTRYPOINT ["/usr/bin/tini", "--"]

# The runtime CLI is exposed as a Python module entrypoint.
# `python -m ss_agents.runtime serve --port=${PORT}` boots the FastAPI surface
# that wraps every Tier-1/2/3 agent and exposes /healthz + /invoke.
CMD ["sh", "-c", "exec python -m ss_agents.runtime serve --port=${PORT} --host=${HOST}"]

###############################################################################
# OCI image labels — SLSA / supply-chain provenance
###############################################################################
LABEL org.opencontainers.image.title="ss-agents-adk" \
      org.opencontainers.image.description="Social Seeding v2 ADK agent runtime — 22 production agents on Vertex AI Agent Runtime (D17/D23)" \
      org.opencontainers.image.source="https://github.com/ComBba/social-seeding-v2" \
      org.opencontainers.image.url="https://github.com/ComBba/social-seeding-v2" \
      org.opencontainers.image.licenses="BUSL-1.1" \
      org.opencontainers.image.vendor="Social Seeding" \
      org.opencontainers.image.documentation="https://github.com/ComBba/social-seeding-v2/blob/main/deploy/README.md"
# org.opencontainers.image.revision is stamped at build time via --label by
# Cloud Build (see deploy/agents/cloudbuild.yaml).
