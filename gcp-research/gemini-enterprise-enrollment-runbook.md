# Gemini Enterprise enrollment — operator runbook (long-lead, start early)

> **⚠️ SUPERSEDED 2026-05-22 — the org route below was NOT needed.** Registration succeeded on the
> consumer-Gmail / no-org `ss-mcp-prod` via the Gemini Enterprise console **"Create app" (30-day free
> trial)** + the Discovery Engine agents REST endpoint. Our A2A agent is live + `ENABLED` in the app
> `social-seeding-agents` (see `gemini-enterprise-api-status.md`). Keep this runbook only for a
> **future standing/paid enrollment** (when the free trial expires) — it is not required for the
> current submission.

> Recorded 2026-05-22. Goal: unblock `agents-cli publish gemini-enterprise` (items 6+7).
> **Verified prerequisite state**: `gcloud organizations list` → **0 orgs**; active account
> **`app.2weeks@gmail.com` (consumer Gmail)**; `ss-mcp-prod` has **no parent** (consumer project).
>
> **Why this is all operator work:** every step below is domain/DNS/account/billing — Claude
> cannot create a Cloud Identity org, verify domain ownership, migrate a project, or submit an
> allowlist request tied to your identity. Claude CAN do the final `agents-cli publish` once an
> Agentspace app exists.

## The dependency chain (why 6 and 7 can't start independently)
A consumer Gmail account cannot own a GCP organization. Gemini Enterprise / Agentspace **requires
an organization**. So: **org first → then Gemini Enterprise → then publish.** Item 7 (allowlist)
has no meaning until item 6 (org) exists.

## Step 1 — Cloud Identity Free → creates the org  (you, ~1–3 days incl. DNS propagation)
You own `socialseed.ing` (the agent card domain) — use it.
1. Sign up for **Cloud Identity Free**: https://workspace.google.com/signup/gcpidentity (choose Free).
2. Use domain **`socialseed.ing`**; create a super-admin (e.g. `admin@socialseed.ing`).
3. **Verify domain ownership** via the DNS TXT record Google gives you (add it at your `socialseed.ing` DNS host).
4. On verification, a GCP **Organization node** for `socialseed.ing` is created automatically.
   - Verify: `gcloud organizations list` (signed in as the new admin) now shows the org + its ID.

## Step 2 — get the agent under the org  (you — DECISION, has risk)
Two options:
- **(A, recommended — low risk) Fresh project under the org.** Create a NEW project inside the
  `socialseed.ing` org, enable `aiplatform`+`discoveryengine`+`geminienterprise` (once allowlisted),
  and deploy/register the agent there. Leaves the live demo untouched.
- **(B, higher risk) Migrate `ss-mcp-prod` into the org** (`gcloud beta projects move ss-mcp-prod
  --organization <ORG_ID>`). ⚠️ **Do NOT do this during the judging window** — `ss-mcp-prod` serves
  the live A2A endpoint used in the demo; migration can disrupt IAM/billing/URLs. Migrate only
  AFTER submission, or use option A.

## Step 3 — request Gemini Enterprise access (item 7)  (you)
With the org in place, in the Cloud console **Agent Platform / Gemini Enterprise** page, follow the
"request access / enable" flow (it now has an org to attach to). `geminienterprise.googleapis.com`
enablement should stop returning 220002 once the org + allowlist clear (Google's ~1–2 week window).

## Step 4 — create an Agentspace app + publish  (Claude can do this part)
Once an org-backed project has Gemini Enterprise enabled:
1. Create a Gemini Enterprise/Agentspace **app** (engine) in that project.
2. `agents-cli publish gemini-enterprise --registration-type a2a --agent-card-url <run.app card URL>
   --gemini-enterprise-app-id <engine resource>` → registers our live A2A agent.
   (Claude runs this once the app exists.)

## Honest timeline / recommendation
- Steps 1+3 are the long-lead bits (DNS verify + Google allowlist, ~days to ~2 weeks) — **fine to
  start now in parallel**; they are harmless and don't touch the live demo.
- Step 2B (migrating the live project) and the publish are **NOT pre-submission priorities** —
  Gemini Enterprise enrollment is **not required for judging** (the A2A card + JWKS already make the
  agent discoverable). Treat enrollment as a post-submission upgrade unless it clears early.
