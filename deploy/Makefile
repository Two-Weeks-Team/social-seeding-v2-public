###############################################################################
# deploy/Makefile — convenience targets for the social-seeding-v2 deploy
#
# Cites:
#   D7  — Containerized everywhere
#   D13 — 3 regions (us-central1, europe-west1, asia-northeast1)
#   D17 — Vertex AI Agent Runtime (managed)
#   D43 — `make smoke-test-prod` IS the Phase-3 canary; must exit 0
#
# Usage:
#   make build-web              # docker build the Mission Control image
#   make build-agents           # docker build the ss-agents-adk image
#   make build-all              # both
#   make deploy-web             # Cloud Build pipeline -> Cloud Run
#   make deploy-agents          # Cloud Build pipeline -> Cloud Run + Agent Runtime
#   make deploy-all             # both (web first, then agents)
#   make smoke-test-prod        # curl /healthz on deployed services
#   make rollback-web TAG=stable
#   make rollback-agents TAG=stable
#
# Environment (set before `make`):
#   PROJECT_ID    — GCP project ID                       (default: ss-v2-prod)
#   REGION        — Region                                (default: us-central1)
#   REVISION_TAG  — Traffic-targeting tag                 (default: stable)
###############################################################################

# Use bash for proper -euo pipefail behavior in recipes.
SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

# Repository root resolved from this Makefile's location.
DEPLOY_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
REPO_ROOT  := $(abspath $(DEPLOY_DIR)/..)

PROJECT_ID   ?= ss-v2-prod
REGION       ?= us-central1
REVISION_TAG ?= stable

# Resolve current commit SHA (short). Falls back to "local" outside a checkout.
SHORT_SHA := $(shell git -C $(REPO_ROOT) rev-parse --short HEAD 2>/dev/null || echo local)

WEB_IMAGE    := $(REGION)-docker.pkg.dev/$(PROJECT_ID)/ss-web/web:$(SHORT_SHA)
AGENTS_IMAGE := $(REGION)-docker.pkg.dev/$(PROJECT_ID)/ss-agents/agents:$(SHORT_SHA)

.DEFAULT_GOAL := help

# -----------------------------------------------------------------------------
# Help
# -----------------------------------------------------------------------------
.PHONY: help
help:
	@echo "social-seeding-v2 deploy Makefile"
	@echo "PROJECT_ID   = $(PROJECT_ID)"
	@echo "REGION       = $(REGION)"
	@echo "REVISION_TAG = $(REVISION_TAG)"
	@echo "SHORT_SHA    = $(SHORT_SHA)"
	@echo ""
	@echo "Targets:"
	@echo "  build-web              Build the Mission Control Docker image"
	@echo "  build-agents           Build the ss-agents-adk Docker image"
	@echo "  build-all              Both build-web + build-agents"
	@echo "  deploy-web             Cloud Build pipeline -> Cloud Run (web)"
	@echo "  deploy-agents          Cloud Build pipeline -> Cloud Run + Agent Runtime"
	@echo "  deploy-all             deploy-web + deploy-agents (web first)"
	@echo "  smoke-test-prod        D43: curl /healthz on the deployed services"
	@echo "  rollback-web TAG=...   Pin web traffic to a prior tag"
	@echo "  rollback-agents TAG=.. Pin agents traffic to a prior tag"
	@echo "  lint                   Hadolint + yamllint where available"
	@echo "  clean                  Remove rendered manifests + tfvars"

# -----------------------------------------------------------------------------
# Guards — fail fast with actionable messages.
# -----------------------------------------------------------------------------
.PHONY: _check-env
_check-env:
	@if [ -z "$(PROJECT_ID)" ]; then echo "ERROR: set \$$PROJECT_ID"; exit 1; fi
	@if [ -z "$(REGION)" ];     then echo "ERROR: set \$$REGION";     exit 1; fi

.PHONY: _check-docker
_check-docker:
	@command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not on PATH"; exit 1; }

.PHONY: _check-gcloud
_check-gcloud:
	@command -v gcloud >/dev/null 2>&1 || { echo "ERROR: gcloud not on PATH; install Cloud SDK"; exit 1; }
	@gcloud auth print-access-token >/dev/null 2>&1 || { echo "ERROR: gcloud not authenticated; run 'gcloud auth login'"; exit 1; }

# -----------------------------------------------------------------------------
# Local docker builds (parity check before pushing to Cloud Build).
# -----------------------------------------------------------------------------
.PHONY: build-web
build-web: _check-docker
	@echo "--- building $(WEB_IMAGE) ---"
	cd $(REPO_ROOT) && docker buildx build \
	  --platform=linux/amd64 \
	  --file=deploy/web/Dockerfile \
	  --tag=$(WEB_IMAGE) \
	  --tag=$(REGION)-docker.pkg.dev/$(PROJECT_ID)/ss-web/web:$(REVISION_TAG) \
	  --label=org.opencontainers.image.revision=$(SHORT_SHA) \
	  --load \
	  .

.PHONY: build-agents
build-agents: _check-docker
	@echo "--- building $(AGENTS_IMAGE) ---"
	cd $(REPO_ROOT) && docker buildx build \
	  --platform=linux/amd64 \
	  --file=deploy/agents/Dockerfile \
	  --tag=$(AGENTS_IMAGE) \
	  --tag=$(REGION)-docker.pkg.dev/$(PROJECT_ID)/ss-agents/agents:$(REVISION_TAG) \
	  --label=org.opencontainers.image.revision=$(SHORT_SHA) \
	  --load \
	  .

.PHONY: build-all
build-all: build-web build-agents

# -----------------------------------------------------------------------------
# Cloud Build pipelines (the real deploy path).
# -----------------------------------------------------------------------------
.PHONY: deploy-web
deploy-web: _check-env _check-gcloud
	@echo "--- triggering deploy/web/cloudbuild.yaml ---"
	cd $(REPO_ROOT) && gcloud builds submit \
	  --config=deploy/web/cloudbuild.yaml \
	  --substitutions=_PROJECT_ID=$(PROJECT_ID),_REGION=$(REGION),_REVISION_TAG=$(REVISION_TAG),_BUILD_TIMESTAMP=$$(date -u +%FT%TZ) \
	  --project=$(PROJECT_ID) \
	  --region=$(REGION)

.PHONY: deploy-agents
deploy-agents: _check-env _check-gcloud
	@echo "--- triggering deploy/agents/cloudbuild.yaml ---"
	cd $(REPO_ROOT) && gcloud builds submit \
	  --config=deploy/agents/cloudbuild.yaml \
	  --substitutions=_PROJECT_ID=$(PROJECT_ID),_REGION=$(REGION),_REVISION_TAG=$(REVISION_TAG),_BUILD_TIMESTAMP=$$(date -u +%FT%TZ) \
	  --project=$(PROJECT_ID) \
	  --region=$(REGION)

.PHONY: deploy-all
deploy-all: deploy-web deploy-agents

# -----------------------------------------------------------------------------
# Smoke test (D43): hits /healthz on the deployed services. Exit 0 = green.
# -----------------------------------------------------------------------------
.PHONY: smoke-test-prod
smoke-test-prod: _check-env _check-gcloud
	@set -euo pipefail; \
	echo "--- smoke-test-prod (D43 gating canary) ---"; \
	WEB_URL=$$(gcloud run services describe ss-web \
	    --region=$(REGION) --project=$(PROJECT_ID) \
	    --format='value(status.url)' 2>/dev/null); \
	AGENTS_URL=$$(gcloud run services describe ss-agents \
	    --region=$(REGION) --project=$(PROJECT_ID) \
	    --format='value(status.url)' 2>/dev/null); \
	if [ -z "$$WEB_URL" ] || [ -z "$$AGENTS_URL" ]; then \
	  echo "ERROR: could not resolve service URLs (web='$$WEB_URL', agents='$$AGENTS_URL')"; exit 1; \
	fi; \
	echo "web    -> $$WEB_URL"; \
	echo "agents -> $$AGENTS_URL"; \
	echo "[1/2] curl $$WEB_URL/api/healthz"; \
	curl -fsS --max-time 10 "$$WEB_URL/api/healthz" | head -c 200; echo; \
	echo "[2/2] curl $$AGENTS_URL/healthz"; \
	curl -fsS --max-time 10 "$$AGENTS_URL/healthz" | head -c 200; echo; \
	echo "smoke-test-prod: PASS"

# -----------------------------------------------------------------------------
# Rollback (Cloud Run traffic split — instant, no rebuild).
# -----------------------------------------------------------------------------
.PHONY: rollback-web
rollback-web: _check-env _check-gcloud
	@if [ -z "$(TAG)" ]; then echo "ERROR: set TAG=<revision-tag>"; exit 1; fi
	gcloud run services update-traffic ss-web \
	  --region=$(REGION) --project=$(PROJECT_ID) \
	  --to-tags=$(TAG)=100

.PHONY: rollback-agents
rollback-agents: _check-env _check-gcloud
	@if [ -z "$(TAG)" ]; then echo "ERROR: set TAG=<revision-tag>"; exit 1; fi
	gcloud run services update-traffic ss-agents \
	  --region=$(REGION) --project=$(PROJECT_ID) \
	  --to-tags=$(TAG)=100

# -----------------------------------------------------------------------------
# Lint (best effort — silent skip when tool missing).
# -----------------------------------------------------------------------------
.PHONY: lint
lint:
	@set -euo pipefail; \
	if command -v hadolint >/dev/null 2>&1; then \
	  echo "--- hadolint ---"; \
	  hadolint deploy/web/Dockerfile deploy/agents/Dockerfile || true; \
	else echo "hadolint not installed; skipping Dockerfile lint"; fi; \
	if command -v yamllint >/dev/null 2>&1; then \
	  echo "--- yamllint ---"; \
	  yamllint deploy/web/service.yaml deploy/agents/service.yaml \
	           deploy/web/cloudbuild.yaml deploy/agents/cloudbuild.yaml || true; \
	else echo "yamllint not installed; skipping YAML lint"; fi; \
	python3 -c "import yaml; \
	  yaml.safe_load(open('deploy/web/service.yaml')); \
	  yaml.safe_load(open('deploy/agents/service.yaml')); \
	  yaml.safe_load(open('deploy/web/cloudbuild.yaml')); \
	  yaml.safe_load(open('deploy/agents/cloudbuild.yaml')); \
	  print('YAML parse OK for all 4 manifests')"

# -----------------------------------------------------------------------------
# Clean
# -----------------------------------------------------------------------------
.PHONY: clean
clean:
	rm -f $(DEPLOY_DIR)/*.rendered.yaml $(DEPLOY_DIR)/agent-urls.auto.tfvars
