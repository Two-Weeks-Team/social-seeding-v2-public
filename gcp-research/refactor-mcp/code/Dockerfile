# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
###############################################################################
# Single-container Dockerfile for the Track 3 Cloud Run deploy of the
# tiktok-orchestrator ADK agent (A2A v0.3 ingress).
#
# This is the SIMPLE deploy target used by `gcloud run deploy --source=.`
# (build context = gcp-research/refactor-mcp/code/). It ships ONLY the Python
# ADK orchestrator running in stub mode — no Node MCP sidecar, no Vertex, no
# Identity Platform, no Model Armor live calls. Those are gated on operator
# decisions O-A..O-E (see PHASE-5-STATUS.md §3) and the full multi-container
# topology lives in deployment/Dockerfile.multi-container for later.
#
# Two fixes vs the multi-container Dockerfile, required for a single-service
# Cloud Run deploy:
#   1. PORT — Cloud Run injects $PORT (default 8080). uvicorn must bind it.
#   2. agent.json path — main.py computes AGENT_JSON_PATH four parents up from
#      /app/src/tiktok_orchestrator/main.py, i.e. /deployment/agent.json. We
#      copy the real A2A card there so /.well-known/agent.json serves the
#      canonical card (not the fallback stub).
###############################################################################

FROM python:3.13-slim AS builder
WORKDIR /build
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv
COPY agent/pyproject.toml ./pyproject.toml
COPY agent/README.md ./README.md
COPY agent/src ./src
RUN uv venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN uv pip install --no-cache --python /opt/venv/bin/python -e .


FROM python:3.13-slim AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 1001 --shell /usr/sbin/nologin adk

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    PORT=8080 \
    HOST=0.0.0.0 \
    # --- Stub mode (no external GCP services needed for the A2A surface) -----
    REQUIRE_AUTH=false \
    ADK_DISABLED=1 \
    MODEL_ARMOR_STUB=1 \
    IDENTITY_PLATFORM_STUB=1 \
    MCP_BASE_URL= \
    LOG_LEVEL=INFO

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /build/src /app/src
COPY agent/README.md /app/README.md

# main.py reads AGENT_JSON_PATH = <main.py>/../../../../deployment/agent.json,
# which from /app/src/tiktok_orchestrator/main.py resolves to /deployment/agent.json.
COPY deployment/agent.json /deployment/agent.json

USER adk
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/healthz" || exit 1

# Bind to Cloud Run's $PORT via the package's own uvicorn entrypoint
# (tiktok_orchestrator.main:run honors $PORT and $HOST).
CMD ["python", "-m", "tiktok_orchestrator.main"]
