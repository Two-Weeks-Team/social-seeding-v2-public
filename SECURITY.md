# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a vulnerability.

- Preferred: open a [GitHub private security advisory](https://github.com/Two-Weeks-Team/social-seeding-v2-public/security/advisories/new).
- Or email **app.2weeks@gmail.com** with `[SECURITY]` in the subject.

Include: affected component/endpoint, reproduction steps, and impact. We aim to acknowledge within a few business days. Please give us reasonable time to remediate before any public disclosure.

## Scope

In scope: the deployed surfaces and this codebase —

- `agents.socialseed.ing` (Mission Control, Cloud Run) and its API/auth routes.
- `ss-agents`, `ss-mcp-server` (A2A v0.3 node), `ss-landing` on Cloud Run.
- The self-hosted Inngest engine VM and the orchestration/agent code.

Out of scope: third-party platforms we integrate with (Google Cloud, MongoDB, the v1 backend `backend.socialseed.ing`), and denial-of-service / volumetric testing.

## Security posture

- **Auth** — Google OAuth (Mission Control login) → signed `ss_session` (HS256, httpOnly). Service-to-service calls use **OIDC** (Cloud Run invoker / Cloud Workflows). The A2A node enforces auth (`REQUIRE_AUTH`; unauthenticated `message:send` → `401`) and ships a **signed agent card** (JWS ES256, RFC 7515 over JCS) with a public JWKS; card-signing keys live in **Cloud KMS** (private key never leaves KMS).
- **Secrets** — all credentials live in **Secret Manager** (or local `.env.local`, gitignored). No secrets are committed; CI runs secret scanning. Report any leaked secret immediately so it can be rotated.
- **Network** — the Inngest engine is reached **privately** from Cloud Run via Direct VPC egress; its admin port is firewalled to the internal subnet (not public). SSRF guards + host allowlists gate outbound A2A calls.
- **Model / prompt safety** — `prompt-guard` sanitizes user text before it reaches any agent prompt; operator-edited payloads are recursively guarded; Model Armor (PI/JB/PII) is applied on the A2A model path. `external_send`-scoped capabilities (`gmail.send`) never fire without a cleared policy gate, and Gmail sending is restricted to an operator allow-list (D10).
- **Data** — v2 reads shared v1 Mongo collections and writes only its own `v2_*` collections (additive); it never removes or retypes shared data.

## Supported versions

This is an active hackathon-submission repository; security fixes target the `main` branch. There are no long-term-support release branches.
