<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Social Seeding Inc. -->

# tiktok-mcp-server — A2A-compliant Influencer Research Agent

> **Track 3 submission** for the Google for Startups AI Agents Challenge
> (deadline 2026-06-05 23:59 PT).
>
> Refactors the existing Node `tiktok-mcp-server` (4 read-only TikTok
> tools) into an [A2A v0.3](https://a2a-protocol.org/) agent listable on
> Gemini Enterprise. Deployed as a multi-container Cloud Run service
> (Python ADK orchestrator + Node MCP sidecar) and discoverable through
> the Agent Registry.

**License**: [Apache-2.0](./LICENSE) (ancillary code per
[`DECISIONS.md` D9](../../decisions/DECISIONS.md)).
**Maintainers**: see [MAINTAINERS.md](./MAINTAINERS.md).
**Security**: see [SECURITY.md](./SECURITY.md).

---

## What this is

A one-paragraph brand brief in → ranked top-10 TikTok creators out, in
~15 seconds. The agent **plans** keyword variants, **sources** candidates
via the 4 MCP tools, **enriches** with engagement metrics, and **ranks**
with reasoning. Powered by Gemini 2.5 Pro + Flash routing on Vertex AI.

| Surface             | URL pattern (production)                     |
|---------------------|----------------------------------------------|
| Public ingress      | `https://mcp.socialseed.ing`                 |
| A2A agent card      | `/.well-known/agent.json`                    |
| OAuth metadata      | `/.well-known/oauth-protected-resource`      |
| Skill invocation    | `POST /v1/message:send` (A2A REST binding)   |
| Health probe        | `GET /healthz`                               |

---

## Quick start (5 minutes to first invocation)

```bash
# 1. Clone and enter the package
git clone https://github.com/SocialSeeding/social-seeding-v2.git
cd social-seeding-v2/gcp-research/refactor-mcp/code/agent

# 2. Install (uv recommended, pip works too)
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"

# 3. Run in stub mode (no MCP container, no Vertex, no Identity Platform)
REQUIRE_AUTH=false \
MCP_BASE_URL= \
IDENTITY_PLATFORM_STUB=1 \
MODEL_ARMOR_STUB=1 \
ADK_DISABLED=1 \
uvicorn tiktok_orchestrator.main:app --reload --port 8200

# 4. Hit the skill (in another terminal)
curl -sS -XPOST http://localhost:8200/a2a/skills/plan_creator_search \
  -H 'content-type: application/json' \
  -d '{"brand_brief":"We are launching a vegan skincare line in Korea targeting Gen-Z women 18-26."}' \
  | jq .

# 5. Verify the A2A card
curl -sS http://localhost:8200/.well-known/agent.json | jq '.skills[0].id'
# → "plan_creator_search"
```

---

## A2A v0.3 endpoint table

| Method | Path                                          | Purpose                                                    | Auth required |
|--------|-----------------------------------------------|------------------------------------------------------------|---------------|
| GET    | `/healthz`                                    | Cloud Run liveness probe                                   | no            |
| GET    | `/readyz`                                     | Readiness (checks MCP sidecar)                             | no            |
| GET    | `/.well-known/agent.json`                     | A2A v0.3 agent card (REFACTOR-MCP §6.1)                   | no            |
| GET    | `/.well-known/agent-card.json`                | Alias (PROTOCOLS.md §1.3)                                  | no            |
| GET    | `/.well-known/oauth-protected-resource`       | Identity Platform OAuth metadata                           | no            |
| POST   | `/a2a/skills/plan_creator_search`             | Invoke the ranking skill (direct binding)                  | yes (D19)     |
| POST   | `/v1/message:send`                            | A2A v0.3 REST binding (PROTOCOLS.md §1.2)                 | yes (D19)     |
| POST   | `/chat`                                       | Conversational alias used by the demo video                | yes (D19)     |

Sample invocation against a deployed Cloud Run service:

```bash
# Get an Identity Platform ID token (one-time; see SECURITY.md)
TOKEN="$(gcloud auth print-identity-token)"   # for demo/dev only

curl -sS -XPOST https://mcp.socialseed.ing/v1/message:send \
  -H "authorization: Bearer ${TOKEN}" \
  -H "content-type: application/json" \
  -d '{
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "Find 10 vegan-skincare TikTok creators in Korea for a Gen-Z launch." }]
    }
  }' \
  | jq .
```

Expected response shape (`#/definitions/RankedCreators` in
[`deployment/agent.json`](./deployment/agent.json)):

```json
{
  "brief": "Find 10 vegan-skincare …",
  "creators": [
    { "unique_id": "…", "follower_count": 87412, "engagement_rate": 0.072, "fit_score": 0.91, "reasoning": "…" }
  ],
  "source_attribution": "Source: Social Seeding — https://socialseed.ing",
  "trace": { "model": "gemini-2.5-pro", "tools": ["tiktok_search", "tiktok_user_info"] }
}
```

---

## Authentication

Per [`DECISIONS.md` D19](../../decisions/DECISIONS.md):

- **Customer surface** → **Identity Platform multi-tenant** (OIDC,
  one tenant per customer workspace).
  - OIDC discovery URL is templated at deploy time:
    `https://securetoken.google.com/${GOOGLE_CLOUD_PROJECT}/.well-known/openid-configuration`
  - Bearer token verification lives in
    [`agent/src/tiktok_orchestrator/identity_platform.py`](./agent/src/tiktok_orchestrator/identity_platform.py).
  - The verifier rejects tokens without a `firebase.tenant` claim,
    enforcing multi-tenant isolation.
- **Staff surface** (admin / ops) → **Workforce Identity Federation**
  (configured outside this package; not in scope here).

There is **no SQLite OAuth store** — that was the v1 design and has
been retired per D19. The TS-side patch that removes the legacy table
is queued in `ts-patches/identity-platform.ts.patch`.

---

## Authorization — KR-region distribution

Per [`DECISIONS.md` D2 + D3](../../decisions/DECISIONS.md):

The legal entity behind this agent is **Korean** and is therefore
outside the 20-country Cloud Marketplace payment-region whitelist. We
**reframe the gap as an innovation**: this repo is the reference
implementation of the **A2A-only distribution pattern** for non-
Marketplace-region startups.

- Agent card carries an `_kr_gap_disclosure` block stating the legal
  position openly (see `deployment/agent.json`).
- Listing on the Cloud Marketplace will be filed when the foreign
  subsidiary completes registration; until then the agent is
  discoverable via the A2A surface and **Gemini Enterprise Agent
  Registry** (D23).
- Full write-up:
  [`docs/KR-GAP-DISCLOSURE.md`](./docs/KR-GAP-DISCLOSURE.md).

---

## Deployment to Cloud Run (multi-container)

Cloud Run multi-container support enables the **ADK ingress (`:8200`)
+ Node MCP sidecar (`:8100` loopback)** topology in a single service
([`DECISIONS.md` D7](../../decisions/DECISIONS.md)). The deploy is
driven by Cloud Build:

```bash
# One-shot deploy (build → scan → render → replace → smoke)
gcloud builds submit . \
  --config=deployment/cloudbuild.yaml \
  --substitutions=_LOCATION=us-central1,_REPO=socialseed-mcp,_SERVICE=tiktok-mcp

# Manual gcloud equivalent (after images are built and pushed):
gcloud run services replace deployment/cloud-run-service.yaml \
  --region=us-central1 \
  --quiet

# Verify
SERVICE_URL="$(gcloud run services describe tiktok-mcp --region=us-central1 --format='value(status.url)')"
curl -fsS "${SERVICE_URL}/healthz"
curl -fsS "${SERVICE_URL}/.well-known/agent.json" | jq '.skills[0].id'
```

See [`deployment/cloudbuild.yaml`](./deployment/cloudbuild.yaml) and
[`deployment/cloud-run-service.yaml`](./deployment/cloud-run-service.yaml)
for the exact pipeline.

The Dockerfile is multi-stage and produces two images
(`runtime-node` + `runtime-adk`) from one source tree, each running as
a **non-root user** (`node` uid 1000 on the sidecar, `adk` uid 1001 on
the orchestrator) with a `HEALTHCHECK` directive — see
[`deployment/Dockerfile.multi-container`](./deployment/Dockerfile.multi-container).

---

## Gemini Enterprise readiness

| Capability                              | Status     | Evidence                                          |
|-----------------------------------------|------------|---------------------------------------------------|
| A2A v0.3 agent card                     | ✅         | `deployment/agent.json`, validated in CI          |
| Discoverable via Agent Registry (D23)   | ✅         | `agent.json` carries `provider` + `documentationUrl` + signed `iconUrl` |
| Sample invocation curl                  | ✅         | This README §Quick start + §A2A endpoint table    |
| Multi-tenant Identity Platform OIDC     | ✅         | `agent/src/tiktok_orchestrator/identity_platform.py` |
| Model Armor pre-filter on every call    | ✅         | `agent/src/tiktok_orchestrator/model_armor.py`    |
| Latency benchmark (target p99 < 15 s)   | 🟡 stub    | `docs/4-STEP-EVAL-EVIDENCE.md` (templates filed; CSVs populated post-deploy) |
| CMEK on all stores + Secret Manager     | ✅         | `deployment/cloud-run-service.yaml` annotation    |
| Vulnerability disclosure policy         | ✅         | [SECURITY.md](./SECURITY.md)                      |

---

## Layout

```
gcp-research/refactor-mcp/code/
├── LICENSE                                  Apache-2.0
├── NOTICE                                   Attribution
├── MAINTAINERS.md                           Named contacts
├── SECURITY.md                              Disclosure policy
├── .gitignore                               Hard-block secrets
├── README.md                                ← you are here
├── PHASE-5-STATUS.md                        Where we are
├── agent/                                   Python ADK orchestrator
│   ├── pyproject.toml                       (Apache-2.0)
│   ├── README.md                            Per-package quick start
│   ├── src/tiktok_orchestrator/             1,580 LOC across 6 modules
│   │   ├── __init__.py
│   │   ├── main.py                          FastAPI surface
│   │   ├── agent.py                         ADK SequentialAgent
│   │   ├── mcp_client.py                    Async MCP client
│   │   ├── identity_platform.py             OIDC verifier
│   │   └── model_armor.py                   Sanitize + custom regex
│   └── tests/                               5 test files, full coverage
├── deployment/
│   ├── agent.json                           A2A v0.3 agent card
│   ├── Dockerfile.multi-container           runtime-node + runtime-adk
│   ├── cloud-run-service.yaml               Multi-container service
│   └── cloudbuild.yaml                      build → scan → deploy → smoke
├── docs/
│   ├── KR-GAP-DISCLOSURE.md                 D2/D3 public framing
│   ├── MARKETPLACE-LISTING.md               Producer Portal copy
│   └── 4-STEP-EVAL-EVIDENCE.md              Eval suite spec
└── ts-patches/                              Patches to apply to the platform repo
    ├── identity-platform.ts.patch
    └── transport-streamable.ts.patch
```

---

## Decisions implemented

| ID  | Decision                                                                  | Where                                          |
|-----|---------------------------------------------------------------------------|------------------------------------------------|
| D1  | Dual submission (Track 3 reference path)                                  | This package                                   |
| D2  | KR-entity → Marketplace payment-region exclusion                          | `docs/KR-GAP-DISCLOSURE.md`                    |
| D3  | Re-frame as A2A-only distribution innovation                              | `deployment/agent.json` `_kr_gap_disclosure`   |
| D7  | Engineering via background-agent automation; multi-container Cloud Run    | `deployment/cloud-run-service.yaml`            |
| D9  | Apache-2.0 for ancillary (this package); BUSL-1.1 for core                | `LICENSE`, `NOTICE`                            |
| D17 | Vertex AI Agent Runtime (transition through Cloud Run multi-container)    | `deployment/cloud-run-service.yaml`            |
| D19 | Identity Platform multi-tenant OIDC                                       | `agent/src/tiktok_orchestrator/identity_platform.py` |
| D21 | Model Armor max policy + custom regex                                     | `agent/src/tiktok_orchestrator/model_armor.py` |
| D23 | Discoverable via Gemini Enterprise Agent Registry                         | `deployment/agent.json` `provider` + URLs      |

---

## References

- Master plan: [`gcp-research/refactor-mcp/REFACTOR-MCP.md`](../REFACTOR-MCP.md)
- A2A v0.3 spec: [a2a-protocol.org/specification/0.3.0](https://a2a-protocol.org/specification/0.3.0)
- All decisions: [`gcp-research/decisions/DECISIONS.md`](../../decisions/DECISIONS.md)
- KR-gap strategy: [`gcp-research/strategy/KR-GAP.md`](../../strategy/KR-GAP.md)
- Audit report: [`../AUDIT-REPORT.md`](../AUDIT-REPORT.md)
- Track 3 playbook: [`gcp-research/submission-playbook/TRACK3-PLAYBOOK.md`](../../submission-playbook/TRACK3-PLAYBOOK.md)

---

**Status**: Track 3 submission package — `1.0.0` (2026-05-19).
**Last updated**: 2026-05-19.
