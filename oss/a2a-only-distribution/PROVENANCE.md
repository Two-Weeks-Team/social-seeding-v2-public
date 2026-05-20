<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Social Seeding Inc. -->

# PROVENANCE

## What this is

This directory is a **self-contained, forkable template** for the *A2A-only
distribution path* — how a startup excluded from the Google Cloud Marketplace
payment regions (e.g. a Korean-incorporated entity) still distributes its agent
over the A2A protocol. See `README.md` for the pattern and the fork guide.

## Where it was extracted from

The template is a **generalized, de-domained extraction** of the Social Seeding
**ss-mcp reference implementation** — a production A2A v0.3 agent. The mapping:

| Template file | Extracted / generalized from (in this monorepo) |
|---|---|
| `skeleton/server.py` (`/.well-known/agent.json`, `/.well-known/jwks.json`, `/v1/message:send`, task envelope) | `gcp-research/refactor-mcp/code/agent/src/tiktok_orchestrator/main.py` — the real A2A v0.3 FastAPI server (signed card, JWKS, `message/send` binding) |
| `skeleton/agent.json.template` (card shape) | `gcp-research/refactor-mcp/code/deployment/agent.json` — the real, populated, TikTok-specific agent card |
| `examples/client.py` (discover + `message/send`) | `packages/agents-adk/src/ss_agents/tools/a2a_invoke.py` — the real A2A client capability (SSRF guard, retries, identity token, USD cost ledger) |
| `README.md` rationale + scope | `gcp-research/strategy/KR-GAP.md` + `gcp-research/refactor-mcp/code/docs/KR-GAP-DISCLOSURE.md` (the 5-expert business-panel position paper and its Devpost-facing summary) |
| A2A intents framing | `gcp-research/refactor-mcp/A2A-INTENTS.md` |

**What was removed for reusability:** the TikTok/influencer domain logic, the
Identity Platform OIDC verification, the Model-Armor wrap, the multi-container
Cloud Run wiring, ES256 card signing (needs a crypto dependency), and the
production SSRF/retry/cost machinery. What was **kept** is the load-bearing part
— the exact A2A v0.3 protocol shapes a client discovers and calls.

The reference implementation signs its card and serves a populated JWKS via
`card_signer.py` (`build_jwks` / `load_signing_key` / `sign_card`); this template
serves an empty-but-valid JWKS and documents signing as a production step, so the
skeleton runs with zero crypto dependencies.

## Honest scope (restated)

- The **A2A protocol mechanism is real and runnable** here (`verify.sh` boots the
  skeleton and proves the card + a `message/send` task round-trip).
- **A2A discovery works today** via the card + JWKS — any A2A client with the
  card URL can call the agent.
- A **Gemini Enterprise / Agentspace / Marketplace listing is NOT included and is
  operator + Google gated** (allowlist + payment-region entity). This template
  unblocks distribution; it does not grant a platform listing.

## Publishing this as a standalone repo

An operator can lift this directory out of the monorepo and publish it as its
own public GitHub repository (the long-form rationale in `KR-GAP.md` refers to a
planned `a2a-only-pattern` repo). To do so:

```bash
# from the monorepo root
cp -R oss/a2a-only-distribution /tmp/a2a-only-pattern
cd /tmp/a2a-only-pattern
git init && git add -A && git commit -m "init: A2A-only distribution template"
# then: gh repo create <your-org>/a2a-only-pattern --public --source=. --push
```

Everything needed (`LICENSE`, `README.md`, runnable skeleton, client, verifier)
is in this directory; no monorepo paths are required at runtime.

## License

Apache-2.0 (`LICENSE`), per Social Seeding decision **D9** (Apache-2.0 for the
ancillary / published pattern; the proprietary product core is licensed
separately). Forks and PRs documenting the equivalent payment-region gap for
other non-whitelisted countries (Vietnam, Brazil, Indonesia, Mexico, …) are
explicitly welcome.
