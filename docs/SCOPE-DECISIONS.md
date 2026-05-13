# Scope decisions — v2 day-one

> P0-8 (`docs/PHASE-1-PLAN.md`). Which of the `docs/CAPABILITIES.md` rows marked
> *conditional* / *defer* are in v2 **day-one**, and a few implementation calls
> made while building Phase 0. Kept deliberately tight.
>
> Anchoring principle (`docs/ROADMAP.md`): **dogfood on our own GTM cold-outreach
> before onboarding anyone.** Day-one v2 has no external/public users — so every
> "public funnel / public-trial / gating" feature is **out of day-one scope** and
> revisited only when v2 opens up. Items below marked **⚠️ owner** are genuine
> product calls the owner should ratify before they're built; everything else
> follows directly from the principle above + `docs/ARCHITECTURE.md` §6.

## A. Conditional rows from CAPABILITIES.md

| # | Feature (v1) | v2 day-one? | Rationale |
|---|---|---|---|
| 1 | **Guest IP+UA rate-limit / public landing trial** (Domain I, `lib/guest-rate-limit.ts`) | **No** | No public landing trial day-one (dogfood-first). The member-side rate limiter (`usage.checkAndIncrement`, P0-6) *is* in scope; the guest bucket is only needed if/when there's a public unauth surface. Re-add the same IP+UA mechanism then. |
| 2 | **Beta invite codes** (Domain J, `lib/invitation-code.ts`, `/beta-request`, `/invite`) | **No** | Access day-one is the existing workspace/Google-OAuth + the Progressive-Permission allowlist (which *is* in scope, P0-5). Invite codes are a growth-gating mechanism — not needed until external onboarding. **⚠️ owner**: if v2 launches invite-only, this comes back. |
| 3 | **Waitlist approval** (Domain J, `/waitlist`, `api/waitlist`) | **No** (one exception) | Same reasoning as #2. *Exception:* the Progressive-Permission flow still 403s a non-allowlisted Gmail-connect attempt toward a "request access" affordance — but that's a static page, not the full waitlist+admin-approval pipeline. **⚠️ owner**: confirm. |
| 4 | **i18n (ko/en, auto-translate pipeline)** (Domain K, `lib/i18n/*`, `api/translate`) | **No** (deferred) | Already "not core" per ARCHITECTURE.md §6. Mission Control ships in one language (Korean — `<html lang="ko">`, matching the team). `next-intl` can be layered later with no architectural change; the auto-translate pipeline is explicitly not carried. |
| 5 | **Newsletter / profile / share / help / legal pages** (Domain K) | **Partial** | Day-one: `/privacy`, `/terms`, `/refund` as static pages (low effort, sometimes legally needed) — *deferred until first external exposure, not blocking Phase 0/1*. `/share` is reframed (share a campaign report, Phase 4), not day-one. `/newsletter` and `/profile` (marketing/account-management pages) are **out** day-one. |
| 6 | **Landing v2 (cinematic video bg)** (Domain K, `components/landing-v2`) | **No** (deferred) | The product day-one *is* Mission Control (app surface, light mode). The marketing landing (dark) is ported when v2 has something to market externally — not Phase 0/1. **⚠️ owner**: timing. |

**Net:** Phase 0/1 ships exactly the authenticated app (Google OAuth + Progressive-Permission allowlist + the E2E test-login bypass) and the member-side rate limiter. No public funnel, no i18n pipeline, no marketing site.

## B. Implementation calls (Phase 0)

| Topic | Decision | Rationale |
|---|---|---|
| **LLM SDK for agents** (P0-3) | Use the raw `@anthropic-ai/sdk` Messages API behind an injectable `ModelClient` seam (`packages/agents/src/model.ts`), **not** `@anthropic-ai/claude-agent-sdk`. | Campaign agents are bounded functions over the capability layer — they don't need Claude Code's filesystem/bash tools, which is what the Agent SDK adds. The raw SDK is lighter, and the injectable seam is what lets `runAgent` tests run with no API key. The runtime's prior comment ("falls back to the raw Anthropic SDK") becomes the primary path. If a future agent genuinely needs the Agent SDK's affordances, add it then behind the same seam. |
| **`ModelClient` shape** (P0-3) | Text-only conversation turns; tool calls and tool results are threaded back as text user/assistant turns rather than structured `tool_use` / `tool_result` blocks. | Keeps the provider seam tiny and the agent tests trivial. Adequate for Phase 0; if a tool-heavy agent needs richer fidelity (parallel tool calls, structured results), widen `ModelMessage` then. |
| **Per-model pricing** (P0-3/P0-4) | `MODEL_PRICING` in `model.ts` holds approximate $/MTok (Opus 4.7 ≈ 15/75, Haiku 4.5 ≈ 1/5). | Needed for the per-invocation USD cap and the cost ledger. **⚠️ owner**: verify against current Anthropic pricing before relying on hard budget enforcement in production. |
| **`webhook_events` idempotency store** (NicePay webhook) | v2-owned (`v2_webhook_events`), not the shared v1 `webhook_events`. | v1 is frozen; two writers on one idempotency table is a hazard. v1 and v2 receive webhooks at different URLs, so separate stores are correct. |
| **TikTok creator schema vs. real `accounts_tiktok` docs** (P0-2) | `TikTokCreatorSchema` stays as-drafted until validated against real docs from the shared Atlas; the validation + any field loosening is finished when `MONGODB_URI` is available (Phase 0 close-out). | Can't inspect real docs without the connection string; guessing at the shape risks a contract that doesn't match v1's ingestion output. The repo code (`creatorRepo.getByUniqueId`) is in place; only the schema-vs-reality check is pending. |

## C. Still open (need the owner / a real connection)

- **Which Mongo cluster `MONGODB_URI` points at** — the shared production v1 Atlas vs. a dedicated dev cluster. `scripts/init-indexes.ts` (P0-2) is additive (creates only `v2_*` collections + indexes), but pointing at production should be a deliberate choice. Until a `MONGODB_URI` is provided, the live-DB parts of Phase 0 (`init-indexes.ts` run, `POST /api/campaigns` → 201, the Inngest end-to-end demo) can't be exercised.
- **`AUTH_SECRET`, `AUTH_TEST_LOGIN_SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `ANTHROPIC_API_KEY`** — required to actually boot `apps/web` with auth and to run real agents; the code is written against them.
