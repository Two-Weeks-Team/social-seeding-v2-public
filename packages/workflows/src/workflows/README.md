# workflows/

Inngest function definitions. One file per durable workflow.

- `brand-campaign.ts` — the 6-stage campaign (the product). Parent.
- `creator-track.ts` — per-creator child workflow (one creator's journey).
- _(Phase 1+)_ scheduled functions ported from v1 cron: `gmail-watch-renew`, `email-followup-tick` (or fold into `creator-track` timers), `billing-recurring`, `workspace-cleanup`, `tiktok-post-poller`.

Rule: workflows are deterministic choreography (`step.run` / `step.sleep` / `step.waitForEvent`). All judgment goes through `runAgent(...)` from `@ss/agents`; all I/O goes through `invokeCapability(...)` from `@ss/capabilities`. Never call an LLM or the network directly here.
