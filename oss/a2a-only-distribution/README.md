<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Social Seeding Inc. -->

# A2A-only Distribution — a forkable template

> **Distribute your AI agent through the A2A protocol when your country is
> excluded from the Marketplace payment regions.** A runnable, dependency-light
> A2A v0.3 agent skeleton + card + client, extracted from a real production
> implementation, that any non-Marketplace-region founder can fork.
>
> License: **Apache-2.0** (see `LICENSE`). Provenance: see `PROVENANCE.md`.

---

## 1. The problem

Google Cloud Marketplace can only **disburse payments** to a vendor whose legal
entity is incorporated in one of ~20 whitelisted regions
([Marketplace — receive payments](https://docs.cloud.google.com/marketplace/docs/partners/receive-payments)).
**Korea is not on that list** — and neither are Vietnam, Brazil, Indonesia,
Mexico, the Philippines, Turkey, Nigeria, and ~150 other countries that host
real AI-startup ecosystems.

For a founder in one of those regions, listing a *paid* agent on the Marketplace
means first standing up a foreign sub-entity (e.g. a Delaware C-Corp): a
**6–12 week, ~$3k–8k/yr** corporate-restructuring project before the first
dollar of agent revenue. That tax falls on the founder purely because of a
payment-rail boundary that has nothing to do with the technical quality of the
agent they built.

## 2. The solution: publish over A2A, skip the Marketplace listing

The A2A (Agent-to-Agent) protocol decouples **discovery + invocation** from
**Marketplace billing**. If you publish an A2A-compliant agent — an HTTPS
endpoint that serves an **agent card** at `/.well-known/agent.json`, a **JWKS**
at `/.well-known/jwks.json`, and the **`message/send`** REST binding at
`/v1/message:send` — then **any A2A client** (another agent, a Gemini Enterprise
app, a custom orchestrator) can discover and call it **without you holding a
Marketplace listing**. You bill customers directly through whatever rail your
entity supports (Stripe, Toss, an invoice, or free).

Two separate money flows result, and only the first goes through Google:

- The customer pays **Google** their normal GCP bill (model tokens, their own infra).
- The customer pays **you** directly, on your terms.

This is not a hack. It is a deliberate value-chain *unbundling*: A2A keeps
Google-mediated discovery/identity/audit, and moves only **billing** to the
vendor — which is exactly the activity a non-whitelisted founder cannot route
through Google anyway.

> **A2A spec:** this template implements
> [A2A v0.3](https://a2a-protocol.org/specification/0.3.0) — `AgentCard`,
> signed-card `signatures[]` + JWKS, and the `message/send` REST binding /
> `task` envelope.

## 3. Architecture

```mermaid
flowchart LR
    subgraph Founder["Your agent — any HTTPS host (Cloud Run, GKE, a VPS, on-prem)"]
        card["GET /.well-known/agent.json<br/>(A2A v0.3 Agent Card)"]
        jwks["GET /.well-known/jwks.json<br/>(verify signed card)"]
        send["POST /v1/message:send<br/>(message/send -> task envelope)"]
        skill["your skill logic<br/>(tools / model / capabilities)"]
        send --> skill
    end

    subgraph Client["Any A2A client (Gemini Enterprise app, another agent, custom)"]
        disc["1. discover card"]
        call["2. invoke message/send"]
        verify["(optional) verify card signature via JWKS"]
    end

    disc -->|GET| card
    verify -.->|GET| jwks
    call -->|POST| send
    send -->|A2A task envelope| call

    subgraph Billing["Billing — vendor-controlled, OUTSIDE Marketplace"]
        rail["Stripe / Toss / invoice / free"]
    end
    Client -. pays directly .-> rail

    listing["Marketplace / Agentspace listing<br/>(operator + Google gated, OPTIONAL)"]:::gated
    card -.->|publish later, does NOT block discovery| listing

    classDef gated stroke-dasharray: 5 5;
```

The dashed Marketplace box is **optional and gated** — see "Honest scope" below.

## 4. What's in this template

```
oss/a2a-only-distribution/
├── README.md                     # this file — the pattern + fork guide
├── LICENSE                       # Apache-2.0
├── PROVENANCE.md                 # where this came from + how to publish standalone
├── verify.sh                     # boots the skeleton, proves card + message:send work
├── skeleton/
│   ├── server.py                 # minimal A2A v0.3 server (Python stdlib only)
│   └── agent.json.template       # A2A v0.3 agent card with <PLACEHOLDER>s
└── examples/
    └── client.py                 # A2A client: discover a card, call message/send
```

- **`skeleton/server.py`** — a complete, generic A2A v0.3 server using only the
  Python standard library (`http.server`). Boots with zero config (serves a
  built-in stub card) or serves your own `agent.json`. Exposes the three A2A
  surfaces + `/healthz`. Replace the one `run_skill()` function with your logic.
- **`skeleton/agent.json.template`** — the agent card to fill in. Every field a
  client reads to discover and route to your skills.
- **`examples/client.py`** — the caller side, stdlib-only: fetch the card, POST
  `message/send`, parse the `task` envelope.
- **`verify.sh`** — boots the skeleton and asserts the card, JWKS, and a
  `message/send` round-trip all return valid A2A shapes.

The skeleton is intentionally generic (no domain logic) so it is genuinely
reusable. Production agents add a real web framework, an IdP, and card signing
— the **protocol shape** stays identical.

## 5. Fork this — step by step

1. **Copy this directory** into a new repo (see `PROVENANCE.md` for publishing
   it standalone).
2. **Verify it runs as-is:**
   ```bash
   ./verify.sh
   # -> 5 passed, 0 failed; "A2A-only template verified end to end."
   ```
3. **Write your card.** Copy the template and fill every `<PLACEHOLDER>`:
   ```bash
   cp skeleton/agent.json.template skeleton/agent.json
   # edit: name, description, url, skills[], securitySchemes, provider
   ```
4. **Implement your skill.** In `skeleton/server.py`, replace the body of
   `run_skill(skill_id, text, data)` with calls into your own tools / model /
   capability layer. The dict you return becomes the task artifact's `data` part.
5. **Run it pointed at your card:**
   ```bash
   AGENT_CARD_PATH=skeleton/agent.json PUBLIC_BASE_URL=https://your-host PORT=8080 \
     python3 skeleton/server.py
   ```
6. **Deploy** to any HTTPS host (Cloud Run, GKE, a VPS). A2A v0.3 requires TLS;
   put the agent behind HTTPS. Your card's `url` must be the public HTTPS base.
7. **Harden for production** (beyond this skeleton):
   - Front it with a real framework (FastAPI / Express) if you outgrow stdlib.
   - Add an IdP for caller auth (Identity Platform / Auth0 / Cognito / Okta) and
     flip the card's `securitySchemes` on.
   - **Sign the card** (A2A v0.3 `signatures[]`, ES256 over an RFC 8785 JCS
     canonicalization) and publish the public key at `/.well-known/jwks.json`,
     so clients can cryptographically verify authorship.
8. **Bill directly.** Wire your own rail (Stripe / Toss / invoice). The customer
   pays Google their own GCP bill; they pay you separately.
9. **(Optional, later) list on Marketplace/Agentspace** once a foreign sub-entity
   justifies it. Discovery already works via your card — the listing only *adds*
   a discovery surface.

## 6. Honest scope

This template demonstrates the **real A2A distribution mechanism**: the protocol
is genuine (A2A v0.3 card + JWKS + `message/send` task envelope) and the
skeleton is runnable today (`verify.sh` proves it). What it does **not** claim:

- It does **not** list your agent in Gemini Enterprise / Agentspace. That step
  is **allowlist-gated by Google** (registration via
  `discoveryengine.googleapis.com` requires a customer's GCP project to invite
  your agent, and Marketplace listing requires the payment-region entity).
- **A2A discovery works today** — any A2A client that has your card URL can
  fetch it and call `message/send`. The **Marketplace / Agentspace listing is
  the operator/Google-gated step**, not the discovery itself.
- Card signing is shown as a production step; the stdlib skeleton serves an
  empty-but-valid JWKS (signing needs a crypto dependency the template avoids).

In short: **the distribution mechanism is real and runnable; the platform
listing is the operator's gated, optional follow-on.**

## 7. References

- A2A v0.3 specification — https://a2a-protocol.org/specification/0.3.0
- Gemini Enterprise — register & manage A2A agents —
  https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent
- Marketplace partner — receive payments (the region whitelist) —
  https://docs.cloud.google.com/marketplace/docs/partners/receive-payments
- Cloud Run — deploy A2A agents —
  https://docs.cloud.google.com/run/docs/deploy-a2a-agents
- Provenance + the full long-form rationale: `PROVENANCE.md`

---

*Decisions of record behind this artifact: D2 (KR entity blocker), D3 (reframe
as innovation), D29-B (A2A-only distribution path), D9 (Apache-2.0 for the
published pattern). Published as a public good — forks and friction-report PRs
for other non-Marketplace regions are explicitly invited.*
