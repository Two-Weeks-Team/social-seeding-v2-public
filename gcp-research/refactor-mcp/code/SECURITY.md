# Security Policy

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Social Seeding Inc. -->

This document covers the security model and vulnerability-disclosure
process for the **`tiktok-mcp-server` refactor** (the ADK orchestration
layer + Cloud Run deployment under `gcp-research/refactor-mcp/code/`).

It is the **ancillary** component of the dual-licensed Social Seeding
codebase and is published under **Apache-2.0** per
[`DECISIONS.md` D9](../../decisions/DECISIONS.md).

---

## 1. Supported versions

| Version | Branch / tag        | Status              | Security fixes |
|---------|---------------------|---------------------|----------------|
| 1.0.x   | `gemini-enterprise` | ✅ active (current) | yes            |
| < 1.0   | N/A                 | unreleased          | n/a            |

Only the latest minor version receives security patches. Older revisions
must upgrade.

---

## 2. Reporting a vulnerability

**Please do not file public GitHub issues for security problems.**

| Channel                | Address                                       | Use for                                |
|------------------------|-----------------------------------------------|----------------------------------------|
| Email (preferred)      | **security@socialseed.ing**                   | All vulnerability reports              |
| Backup email           | **app.2weeks@gmail.com**                      | If primary mailbox bounces (≥ 24 h)    |
| PGP key                | Published at `https://socialseed.ing/.well-known/security.txt` | Encrypted reports |
| Coordinated disclosure | We follow a **90-day** disclosure window       | All issues                             |

When you write us, please include:

1. Affected component (e.g. `agent/main.py`, `agent.json`, Cloud Run
   service `tiktok-mcp`).
2. Reproduction steps (curl, screenshot, or PoC repo).
3. Impact assessment (auth bypass, RCE, data exfiltration, etc.).
4. Any suggested mitigation.

We will acknowledge receipt within **2 business days** and provide an
initial triage within **5 business days**.

---

## 3. Scope

### In scope

- **A2A endpoints**: `/.well-known/agent.json`, `/v1/message:send`,
  `/a2a/skills/*`, `/chat`.
- **OAuth metadata**: `/.well-known/oauth-protected-resource`.
- **Identity Platform verifier**: `identity_platform.py` token-validation
  path.
- **Model Armor pre-filter**: `model_armor.py` custom-regex + sanitize
  paths.
- **MCP client → sidecar transport**: `mcp_client.py`.
- **Cloud Run service spec**: `deployment/cloud-run-service.yaml`
  (CMEK, secret refs, ingress).
- **Dockerfiles**: `deployment/Dockerfile.multi-container` (non-root
  user, no secrets baked in).

### Out of scope

- Issues in upstream dependencies (`google-adk`, `firebase-admin`,
  `fastapi`, `uvicorn`, `nodriver`, etc.) — please report to the
  upstream maintainer; we will mirror the patch once published.
- Rate-limit abuse on the free tier (200/200/50/50/day quotas — by
  design; report extreme cases anyway).
- Social-engineering against Social Seeding staff (use
  `support@socialseed.ing`).
- Anything inside the BUSL-1.1-licensed core (`social-seeding-v2/`
  packages) — that has a separate disclosure channel.

---

## 4. Security controls in place

The following controls are referenced in the source so reviewers can
verify them quickly:

| Control                                         | Where it lives                                                          | Decision |
|-------------------------------------------------|-------------------------------------------------------------------------|----------|
| Identity Platform OIDC tenant verification      | `agent/src/tiktok_orchestrator/identity_platform.py`                    | D19      |
| Model Armor sanitize on every prompt + response | `agent/src/tiktok_orchestrator/model_armor.py`                          | D21      |
| Custom-regex pre-filter (API keys, PII)         | `agent/src/tiktok_orchestrator/model_armor.py` (`_CUSTOM_REGEX` tuple)  | D21      |
| Non-root container user (`adk`, uid 1001)       | `deployment/Dockerfile.multi-container` stage 4                         | D20      |
| Secrets via Secret Manager only (no env literals) | `deployment/cloud-run-service.yaml` `secretKeyRef` blocks             | D20      |
| CMEK on Cloud Run + Artifact Registry           | `deployment/cloud-run-service.yaml` annotation                          | D20      |
| HEALTHCHECK on both containers                  | `deployment/Dockerfile.multi-container` stages 2 + 4                    | D31      |
| Container image vulnerability scan (Artifact AR) | `deployment/cloudbuild.yaml` `scan-mcp-*` steps                        | D7       |
| Loopback-only MCP sidecar (no public port)      | `deployment/cloud-run-service.yaml` (sidecar exposes no `ports:`)       | —        |

---

## 5. Threat model (summary)

| Threat                                     | Mitigation                                              |
|--------------------------------------------|---------------------------------------------------------|
| Prompt injection / jailbreak via brand brief | Custom-regex pre-filter (always on) + Model Armor `sanitizeUserPrompt` GA call (deep layer; `MODEL_ARMOR_MODE=live`, operator-provisioned template + ADC) |
| API key leakage in user input              | `_CUSTOM_REGEX` rejects `AIza…`, `BACKEND_DASHBOARD_PASSWORD`, etc. |
| Forged Bearer tokens                       | `verify_id_token` against Identity Platform tenant audience |
| Sidecar exfiltration via public reach      | Sidecar binds to `127.0.0.1:8100`, never to `0.0.0.0`   |
| Supply-chain compromise (Docker layer)     | Artifact Registry scan + CMEK + pinned base images      |
| Secret committed to git                    | No `.env` / `cookies.txt` / `credentials.json` are checked in (see §6). |
| Multi-tenant data crossover                | Identity Platform `tenant_id` is required claim; rejected if missing. |

---

## 6. Secrets hygiene

The following file patterns are **never** committed to this directory:

```
.env                      # all environment variants
.env.local
.env.production
.env.test
*.pem                     # private keys
*.key                     # private keys
*-credentials.json        # service-account JSON
cookies.txt               # browser session captures
```

A `.gitignore` at the repository root enforces this. If you ever
encounter such a file inside `gcp-research/refactor-mcp/code/`, treat
it as **leaked** and report it through §2.

---

## 7. Hall of fame

Security researchers who responsibly report verifiable issues will be
acknowledged here (with permission). The first 10 verified reports
also receive a written thank-you and Social Seeding swag.

---

**Last updated**: 2026-05-19
