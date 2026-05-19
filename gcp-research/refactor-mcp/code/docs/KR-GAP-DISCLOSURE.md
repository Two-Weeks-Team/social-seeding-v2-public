# KR-Gap Disclosure — Devpost-facing

> Honest, Devpost-facing summary of why the Korean entity behind this
> submission is publishing under the **A2A-only distribution pattern** rather
> than the standard Google Cloud Marketplace listing track. Cite this file
> directly from the Devpost write-up's Innovation section.
>
> Primary source: `gcp-research/strategy/KR-GAP.md` (long-form 5-expert
> business-panel analysis). Decisions of record: **D2** + **D3** + **D29**
> in `gcp-research/decisions/DECISIONS.md`. This document is the **public**
> projection of those internal documents and is published under Apache-2.0.

## 1. The blocker, in one sentence

> Google Cloud Marketplace cannot accept a Korean-incorporated entity as a
> paid AI-agent vendor as of 2026-05-19, because Korea is not one of the 20
> Marketplace payment regions
> ([receive-payments](https://docs.cloud.google.com/marketplace/docs/partners/receive-payments)),
> and no public roadmap commits to adding it.

This is the verbatim opening of `KR-GAP.md §1`. We restate it here so a
Devpost judge or partner reviewer reading **only** this disclosure document
gets the full picture without having to follow internal links.

## 2. What we did about it

We split the deliverable into two halves so neither half blocks the other:

| | Path A — A2A-only listing | Path B — Marketplace listing |
|---|---|---|
| **What we ship for Devpost** | Working A2A v0.3 agent registered to Gemini Enterprise via `discoveryengine.googleapis.com`, billed direct via Stripe Korea + Toss Payments test mode | Producer Portal submission in **`PENDING_REVIEW`** state, blocked at the Payments step pending DE C-Corp formation |
| **Why it works as the primary** | Gemini Enterprise registration is decoupled from Marketplace billing (KR-GAP.md §3.2 Facts 1-4) | Free-tier listing is open even without payments; once foreign-sub completes we promote to paid pricing |
| **What the Korean founder loses** | Procurement consolidation, Marketplace promotional placement, Google's centralized usage metering | None — A2A path stays live; Marketplace adds discovery, doesn't replace |
| **What they gain** | Toss Payments (KRW), KakaoPay, NaverPay rails day 1; no $50k/yr foreign-sub overhead; faster time-to-customer | An additional discovery surface once foreign-sub is operational |

This is the **dual-listing hybrid** Porter's value-chain analysis prescribes
(KR-GAP.md §4.3). Either path independently meets the Track 3 deliverable;
together they show the strategic positioning.

## 3. Why this is an Innovation (Devpost 20% rubric)

Quoting `KR-GAP.md §9.1-9.4`:

1. **Concrete code** — working A2A v0.3 HTTP layer over an existing MCP
   server, multi-container Cloud Run deployment, Identity Platform OAuth
   replacement, Model Armor wired with `FAIL_CLOSED`. Reviewers can fork
   `github.com/SocialSeeding/a2a-only-pattern` (Apache-2.0).
2. **Concrete write-up** — `KR-GAP.md` itself, plus this disclosure, plus
   the Devpost Innovation section pointing at both.
3. **Concrete proof** — a Korean-incorporated agent registered to a Gemini
   Enterprise app, working install-link flow, Cloud Run service hosted in
   `asia-northeast3` (Seoul) reachable from global Gemini Enterprise.
4. **A reusable pattern** — the BUSL-1.1 + Apache-2.0 dual licence (per
   **D9**) gives us protected core IP **and** an Apache-2.0 reference repo
   any non-Marketplace-region founder can fork. KR-GAP.md §10 details the
   community call.

The Innovation contribution is therefore not *"a clever workaround we
invented"* — it is *"a reference pattern we built, validated, and gave to
the community."*

## 4. What's in this repo vs. what's in the pattern repo

| Artifact | This refactor (`code/`) | Pattern repo (`SocialSeeding/a2a-only-pattern`) |
|---|---|---|
| Working A2A agent (TikTok-specific) | yes | no |
| MCP server (4 tools) | yes (existing platform code) | template only |
| Identity Platform OAuth integration | yes (TS + Python) | reference snippet (TS + Python + Go) |
| Model Armor wrap (D21) | yes (Python) | reference templates (D21 + SDP) |
| Cloud Run multi-container deploy | yes | reference Dockerfile + Cloud Run YAML |
| `agent.json` (this product) | yes (`deployment/agent.json`) | template (`agent.json.template`) |
| Install-link generator | follows | yes (the OSS deliverable) |
| Security whitepaper | follows | yes (template + filled example) |
| Pricing-page template | no | yes (Stripe Korea + Toss + Apigee X) |
| `MARKETPLACE-DECOUPLED.md` | no | yes (5-command install flow doc) |

A reviewer who wants to validate the pattern itself reads the pattern repo.
A reviewer who wants to validate **this** agent's compliance with the
pattern reads this directory's `MARKETPLACE-LISTING.md` + the source code.

## 5. Honest limitations we surface

Three things this disclosure makes explicit so a Devpost judge does not
have to discover them by reading the production traces:

1. **A2A-only loses the Marketplace centralized invoicing.** A Fortune 500
   customer that demands "one Google invoice" cannot buy on Path A.
   That's by design — KR-GAP.md §3.4 documents the full lost-capabilities
   list. We add Marketplace at month-3+ when foreign-sub is justified by
   inbound demand, not before.
2. **Marketplace listing is `PENDING_REVIEW`, not `LIVE`.** Track 3 Phase 6
   §6.6 documents this is acceptable for the deadline. We've filed the
   Producer Portal submission and screenshotted it; the foreign-sub
   formation is the gating step, not the listing fitness.
3. **Per-user quota migration is dual-write for the first 7 days.**
   REFACTOR-MCP.md §9.4 documents the rollback path: `USAGE_BACKEND=memory`
   falls back to in-memory counter if Firestore errors persist. Memory
   mode is safe-degraded because Cloud Run cold-start (~hourly) self-limits
   abuse. The TS patch at `ts-patches/identity-platform.ts.patch` ships this
   toggle.

## 6. Reference

Internal:
- `gcp-research/strategy/KR-GAP.md` (long-form analysis)
- `gcp-research/decisions/DECISIONS.md` D2, D3, D9, D29
- `gcp-research/refactor-mcp/REFACTOR-MCP.md` §6.6 + §9.2

Primary external sources cited by KR-GAP.md (verified as of 2026-05-19):
- [Cloud Marketplace partner — Receive Payments (the 20-region whitelist)](https://docs.cloud.google.com/marketplace/docs/partners/receive-payments)
- [Gemini Enterprise — Register and manage A2A agents](https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent)
- [Identity Platform — Multi-tenancy quickstart](https://docs.cloud.google.com/identity-platform/docs/multi-tenancy-quickstart)
- [Cloud Run — Deploy A2A agents](https://docs.cloud.google.com/run/docs/deploy-a2a-agents)
- [Google Cloud Blog — Startups are building the agentic future with Google Cloud](https://cloud.google.com/blog/topics/startups/startups-are-building-the-agentic-future-with-google-cloud)

Real Korean-AI-startup precedents (KR-GAP.md §2.3):
- Lunit (KOSDAQ-listed, Lunit USA Inc.)
- Upstage AI (Solar-LLM, Upstage AI Inc. Delaware)
- Rebellions (post-merger with Sapeon, US commercial presence on growth path)

---

*This file is published under Apache-2.0 alongside the wider
`a2a-only-pattern` reference repo (D9). Forks welcome; PRs that document
the equivalent gap for Vietnamese, Brazilian, Indonesian, Mexican, etc.
founders are explicitly invited.*
