# SPDX-License-Identifier: BUSL-1.1
# Copyright 2026 Social Seeding Inc.
###############################################################################
# Cloud Run image for the ss-agents-adk HTTP runtime (Wave 3 / Track 3).
#
# Serves serve.py (FastAPI) — one POST /<agent_id> route per agent the
# brand-campaign Cloud Workflow invokes (coordinator, sourcing, vetting).
# This is what turns the ALREADY-WIRED workflow into an EXECUTABLE one: the
# workflow's `http.post` steps now reach a real endpoint instead of
# https://stub.local/<id>.
#
# Mirrors the proven ss-mcp Dockerfile conventions
# (gcp-research/refactor-mcp/code/Dockerfile):
#   - multi-stage (builder compiles the venv, runtime is slim)
#   - uv for fast, reproducible installs
#   - non-root user (uid 1001)
#   - binds Cloud Run's injected $PORT (default 8080) via uvicorn
#   - curl HEALTHCHECK against /healthz (aliased to "/" — Cloud Run reserves
#     /healthz at its frontend, see serve.py)
#
# Build context = packages/agents-adk/ (this directory):
#   gcloud builds submit packages/agents-adk \
#     --tag REGION-docker.pkg.dev/PROJECT/ss/ss-agents:TAG
# See scripts/deploy/DEPLOY-RUNBOOK.md for the full operator sequence.
###############################################################################

# ── builder ──────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder
WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv

# Install deps first (cache layer), then the package itself.
COPY pyproject.toml README.md ./
COPY src ./src
RUN uv venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
# Editable install of ss-agents-adk plus uvicorn (the ASGI server serve.run uses).
RUN uv pip install --no-cache --python /opt/venv/bin/python -e . uvicorn


# ── runtime ──────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 1001 --shell /usr/sbin/nologin adk

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src:/app \
    PORT=8080 \
    HOST=0.0.0.0 \
    LOG_LEVEL=INFO \
    # ── Agent posture (operator overrides at deploy time, see runbook) ──
    # SS_LIVE=0 → offline stub path (deterministic, zero Vertex cost). The
    # operator sets SS_LIVE=1 + ADC to make the agents call real Gemini.
    SS_LIVE=0 \
    # D47: route reasoning through the Vertex AI Model Garden plane in prod.
    MODEL_GARDEN_ROUTING=true \
    GOOGLE_GENAI_USE_VERTEXAI=TRUE \
    # Per-invocation + per-campaign USD ceilings (cost guard, D39).
    SS_DEFAULT_MAX_USD=0.20 \
    SS_DEFAULT_CAMPAIGN_BUDGET_USD=25.00

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /build/src /app/src
COPY serve.py /app/serve.py
COPY README.md /app/README.md

USER adk
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/healthz" || exit 1

# serve.run() honors $PORT and $HOST.
CMD ["python", "-m", "serve"]
