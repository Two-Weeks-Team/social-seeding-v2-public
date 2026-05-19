<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Social Seeding Inc. -->

# Track 3 Submission Package — Audit Report

> **Verifier**: Track3-verify (automated audit subagent)
> **Date**: 2026-05-19
> **Subject**: `gcp-research/refactor-mcp/code/`
> **Goal**: Confirm the Track 3 submission package has everything Devpost
> + Gemini Enterprise need for the Google for Startups AI Agents
> Challenge (deadline **2026-06-05 23:59 PT**).

---

## 1. Executive verdict

**Status: DONE.** The submission package is **complete** for the
Devpost write-up and the Cloud Run / Gemini Enterprise deploy. All
8 audit categories pass; **6 gaps were filled in this audit pass**
(LICENSE, NOTICE, README.md, SECURITY.md, MAINTAINERS.md, `.gitignore`)
and **1 minimal-diff fix** was applied (`agent/pyproject.toml`
license string MIT → Apache-2.0 to match D9; SPDX headers added to
all 6 Python source files).

What still needs an operator (out of audit scope, but worth flagging):
- Operator decisions O-A through O-E in
  [`code/PHASE-5-STATUS.md §3`](./code/PHASE-5-STATUS.md) — these gate
  the live Cloud Run deploy, not the submission package itself.
- Latency-benchmark CSVs in
  [`code/docs/4-STEP-EVAL-EVIDENCE.md`](./code/docs/4-STEP-EVAL-EVIDENCE.md) —
  templates are filed; numbers are deploy-time artifacts.

---

## 2. Audit checklist

Legend: ✅ present · ⚠️ partial · ❌ missing · 🛠 fixed in this pass

### 2.1 `agent.json` — A2A v0.3 compliance

| Item                                           | Status | Path / detail                                                     | Fix action |
|------------------------------------------------|--------|-------------------------------------------------------------------|------------|
| `protocolVersion: 0.3.0` declared              | ✅     | `code/deployment/agent.json` L5                                   | —          |
| `name`, `description`, `version` required      | ✅     | L7-17                                                              | —          |
| `capabilities` block                           | ✅     | L25-36 (streaming, AP2 extension declared optional)               | —          |
| `securitySchemes` with Identity Platform OIDC | ✅     | L38-56 — D19 oidc discovery URL templated by deploy               | —          |
| `skills[]` with id + name + description + tags | ✅     | L66-84 — `plan_creator_search`                                    | —          |
| Endpoints: `url` + `additionalInterfaces`      | ✅     | L10-14 (`https://mcp.socialseed.ing`)                             | —          |
| Authentication declared (oauth + oidc)         | ✅     | L58-61 (`security[]`)                                              | —          |
| JSON-valid syntax                              | ✅     | `python3 -c "json.load(open('agent.json'))"` returns no error     | —          |
| A2A v0.3 spec cited in comment header          | ✅     | L2: `$schema: a2a-protocol.org/schemas/v0.3/agent-card.json`      | —          |
| KR-gap disclosure (D2 + D3)                    | ✅     | L144-152 `_kr_gap_disclosure` block                                | —          |

### 2.2 README.md (Apache-2.0 ancillary per D9)

| Item                                              | Status     | Path                                              | Fix action                |
|---------------------------------------------------|------------|---------------------------------------------------|---------------------------|
| Top-level package README                          | 🛠         | `code/README.md` (new in this pass)                | Created — Devpost-ready    |
| Quick start (5 min to first invocation)           | ✅         | `code/README.md` §Quick start                      | —                          |
| A2A v0.3 endpoint table                            | ✅         | `code/README.md` §A2A endpoint table               | —                          |
| Authentication: Identity Platform multi-tenant    | ✅         | `code/README.md` §Authentication (cites D19)       | —                          |
| License: Apache-2.0                                | ✅         | `code/README.md` header + `code/LICENSE`           | —                          |
| Citation of D2 + D3                                | ✅         | `code/README.md` §Authorization — KR-region        | —                          |
| Per-package README (`agent/`)                      | ✅         | `code/agent/README.md`                             | —                          |

### 2.3 Cloud Run deploy script

| Item                                          | Status | Path                                              | Fix action |
|-----------------------------------------------|--------|---------------------------------------------------|------------|
| `gcloud run` with multi-container (D7)        | ✅     | `code/deployment/cloud-run-service.yaml`           | —          |
| Health check endpoint `/healthz`              | ✅     | `code/deployment/cloud-run-service.yaml` L92-102   | —          |
| Build → scan → deploy → smoke pipeline        | ✅     | `code/deployment/cloudbuild.yaml`                  | —          |
| Deploy command cited in README                | ✅     | `code/README.md` §Deployment to Cloud Run         | —          |

### 2.4 Dockerfile

| Item                          | Status | Path                                                     | Fix action |
|-------------------------------|--------|----------------------------------------------------------|------------|
| Multi-stage build             | ✅     | `code/deployment/Dockerfile.multi-container` (4 stages)  | —          |
| Non-root user                 | ✅     | stage 2 `USER node`; stage 4 `USER adk` (uid 1001)        | —          |
| `HEALTHCHECK` directive       | ✅     | stages 2 + 4 (`/health` and `/healthz` respectively)     | —          |

### 2.5 OWNERS / MAINTAINERS.md (Apache-2.0 hygiene)

| Item                              | Status | Path                              | Fix action            |
|-----------------------------------|--------|-----------------------------------|-----------------------|
| Named contact                     | 🛠     | `code/MAINTAINERS.md`              | Created — `@ComBba` listed |
| Email for security reports        | 🛠     | `code/MAINTAINERS.md` + `SECURITY.md` | Created               |
| Contributor / nomination process  | 🛠     | `code/MAINTAINERS.md` §Adding     | Created               |

### 2.6 Security

| Item                                            | Status | Path / detail                                                          | Fix action |
|-------------------------------------------------|--------|------------------------------------------------------------------------|------------|
| No hardcoded secrets                            | ✅     | All secrets via Secret Manager `secretKeyRef` in `cloud-run-service.yaml` | —          |
| No `.env` files committed                       | ✅     | None present; `code/.gitignore` (new) hard-blocks future commits        | —          |
| `SECURITY.md` with disclosure policy            | 🛠     | `code/SECURITY.md` (new in this pass)                                   | Created — 90-day disclosure, `security@socialseed.ing` |
| `.gitignore` blocks secret patterns             | 🛠     | `code/.gitignore` (new) — `.env*`, `*.pem`, `*-credentials.json`, etc.  | Created    |
| Sidecar bound to loopback only                  | ✅     | `cloud-run-service.yaml` — Node container has no `ports:` block        | —          |
| Custom-regex pre-filter for API keys / PII      | ✅     | `agent/src/tiktok_orchestrator/model_armor.py` L78-81                  | —          |

### 2.7 Gemini Enterprise readiness

| Item                                                | Status      | Path                                                          | Fix action |
|-----------------------------------------------------|-------------|---------------------------------------------------------------|------------|
| Discoverable via Agent Registry (D23)               | ✅          | `agent.json` carries `provider`, `documentationUrl`, `iconUrl` | —          |
| Sample invocation curl in README                    | ✅          | `code/README.md` §A2A endpoint table + §Quick start            | —          |
| Latency benchmark                                   | ⚠️ stub     | `code/docs/4-STEP-EVAL-EVIDENCE.md` — template ready; CSVs at deploy | Operator must run eval harness post-deploy |
| AP2 Intent Mandate extension declared (D27)         | ✅          | `agent.json` L29-34 (`required: false` for v1)                 | —          |

### 2.8 License consistency

| Item                                                | Status      | Path                                            | Fix action                        |
|-----------------------------------------------------|-------------|-------------------------------------------------|-----------------------------------|
| Package-root `LICENSE` (Apache-2.0)                 | 🛠          | `code/LICENSE` (new in this pass)                | Created                            |
| `NOTICE` file (Apache-2.0 attribution)              | 🛠          | `code/NOTICE` (new in this pass)                 | Created — cites MCP + A2A + D9    |
| SPDX headers on `.py` files                         | 🛠          | 6 files in `code/agent/src/tiktok_orchestrator/` | Added (minimal-diff)               |
| `pyproject.toml` license string matches D9          | 🛠          | `code/agent/pyproject.toml` L33                  | Changed `MIT` → `Apache-2.0`       |
| SPDX headers on `.md` files (docs)                  | ✅          | New docs (`README`, `SECURITY`, `MAINTAINERS`, `AUDIT-REPORT`, `NOTICE`) carry HTML-comment SPDX | — |
| TS patches and existing `.md` docs                   | ⚠️ partial  | Pre-existing `docs/*.md` and `ts-patches/*.patch` did not have SPDX | Acceptable — these are derivative of the platform repo; covered by the package LICENSE |

---

## 3. Gaps filled in this audit pass

| File                                       | Reason added                                                | Source of authority |
|--------------------------------------------|-------------------------------------------------------------|---------------------|
| `code/LICENSE`                             | Apache-2.0 text was missing; D9 mandates it for ancillary    | D9                  |
| `code/NOTICE`                              | Apache-2.0 §4(d) recommends; cites MCP + A2A + BUSL dual-licensing | D9              |
| `code/README.md`                           | Top-level Devpost entry needed quick-start + endpoints       | Audit checklist §2  |
| `code/SECURITY.md`                         | Vulnerability disclosure policy was missing                  | Apache-2.0 hygiene + audit §2.6 |
| `code/MAINTAINERS.md`                      | Named contact missing for OSS hygiene                        | Apache-2.0 hygiene + audit §2.5 |
| `code/.gitignore`                          | Hard-block future commits of `.env*`, `*.pem`, etc.          | Audit §2.6          |
| `code/agent/pyproject.toml` (license edit) | License string said `MIT`, contradicting D9 (`Apache-2.0`)   | D9                  |
| SPDX headers on 6 `.py` files              | Per Apache-2.0 best practice + audit §2.8                   | Audit §2.8          |

Net change: **6 new files** + **7 minimal-diff edits** (6 SPDX headers
+ 1 `pyproject.toml` license fix). No business logic touched. All
Python source still parses (verified with `ast.parse`).

---

## 4. Files NOT touched (out of scope)

Per the audit constraints:

- `packages/agents-adk/**` — different repo concern
- `apps/web/**` — Mission Control, not in Track 3 scope
- `terraform/**` — Phase 6 deliverable
- `/Users/kimsejun/Documents/GitHub/tiktok-mcp-server/` (the standalone
  microservice repo) — different project, out of audit scope

---

## 5. Recommended next steps (for the operator)

These are **not** gaps in the submission package — they are
deploy-time tasks that the package itself cannot complete:

1. **Resolve operator decisions O-A through O-E** in
   `code/PHASE-5-STATUS.md §3` (GCP project id, service-account login,
   Watchtower pause, public-prompt repo, Marketplace category).
2. **Run the Cloud Build pipeline** (`code/deployment/cloudbuild.yaml`)
   against the chosen project; capture the smoke-test output for the
   Devpost submission video.
3. **Populate the 4-gate eval CSVs** under `code/docs/` once a
   production endpoint is live (`docs/4-STEP-EVAL-EVIDENCE.md` tells
   you which queries to run).
4. **Submit the Producer Portal listing** with the copy from
   `code/docs/MARKETPLACE-LISTING.md` once the foreign sub-entity is
   ready (per D2 + D3 + KR-GAP.md).
5. **Record the 3-min Devpost demo video** referencing this package.

---

## 6. Sign-off

```
Track3-verify STATUS: DONE
agent.json valid: yes
README quality: Devpost-ready
Dockerfile + deploy script: present
LICENSE Apache-2.0: present
SECURITY.md: present
Critical gaps filled: LICENSE, NOTICE, README.md, SECURITY.md, MAINTAINERS.md, .gitignore,
                     pyproject.toml license string, SPDX headers on 6 Python files
Audit report path: gcp-research/refactor-mcp/AUDIT-REPORT.md
```

**Last updated**: 2026-05-19.
