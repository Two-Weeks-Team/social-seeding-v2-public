# Google for Startups AI Agents Challenge — Official Rules

> **Research date**: 2026-05-19 (T-17 days to the June 5 deadline)
> **Research method**: Web research against primary Google Cloud blog posts, the Devpost guest-invite redirect chain, Google Cloud product docs, and the Cloud Run + ADK + Gemini Enterprise reference implementation. The Devpost rules page itself sits behind a Cloudflare-protected, guest-invite-only gate (`devpost.team/hackathon_guest_invites/4fb181b4-...`) — sections marked **GAP** could not be retrieved from the public web and must be confirmed inside the registered Devpost console.
> **Note on contest identity**: The user described this as "Google Cloud AI Agents Challenge." The actual official name is **"Google for Startups AI Agents Challenge"** (announced at Google Cloud Next '26). It is *not* the Google Cloud Rapid Agent Hackathon (`rapid-agent.devpost.com`, six partner-MCP tracks, June 11 deadline) nor the ADK Hackathon (`googlecloudmultiagents.devpost.com`) — those are different competitions running concurrently. Confusion between them is common; rules below are for the Startups challenge only.

---

## 0. At-a-glance summary

| Item | Value | Source |
|---|---|---|
| Official name | **Google for Startups AI Agents Challenge** (at Next '26) | [1] |
| Host | Devpost (guest-invite-gated) | [1][2] |
| Devpost URL | `https://devpost.team/hackathon_guest_invites/4fb181b4-2722-415d-a442-285a57dcaba5` | [1] |
| Short URL announced on YouTube | `https://goo.gle/486nbl4` → redirects to the Devpost URL above | resolved via 302 trace, 2026-05-19 |
| Submission deadline | **June 5, 2026** | [1][3] |
| Duration | "six weeks" from launch at Next '26 (Apr 21–24, 2026) | [1][3] |
| Eligibility | "Open to anyone (not just Next attendees)" | [1][3] |
| Prize pool | **$90,000 USD** total | [1][3] |
| Credits per team | **$500 USD** Google Cloud credits | [1][3] |
| Tracks | **3** — Build / Optimize / Refactor | [1][3] |
| Judging weights | Tech 30 % • Business 30 % • Innovation 20 % • Demo 20 % | [1] |
| Primary tool | **Gemini Enterprise Agent Platform** (formerly Vertex AI Agent Builder) | [1][4] |

---

## 1. Track 1 — **Build** (net-new agent from scratch)

### Exact definition (verbatim)
> "You can build a net-new agent from scratch …" — Google Cloud blog [1]

> "build a net-new agent from scratch" — YouTube video description / Devpost track list [3]

### Eligibility
- Open to anyone globally; no requirement that the agent existed before challenge launch [1].
- "Net-new" implies the codebase / agent must not have been a pre-existing project. (The closest parallel — Devpost's other Google contests — typically requires *projects created during the contest period*, e.g. the Rapid Agent Hackathon enforces "New work only: Projects created during contest period; cannot be modifications of existing work" [6]. **GAP**: The Startups challenge's exact "new work" clause is not in the public blog; confirm in Devpost rules after registering.)
- Team size cap: **GAP** — not stated in the public announcement. Parallel Google contests cap at four members per team [6].

### Required deliverables (challenge-wide; see §6)
- Demo video, hosted public project URL, code repo, written description (inferred from Devpost convention + judging-criteria weights; **GAP** for exact list).

---

## 2. Track 2 — **Optimize** (existing prototype → production reliability)

### Exact definition (verbatim)
> "… optimize an existing prototype for production reliability …" [1]

> "optimize an existing prototype for production" — short-form variant on the Devpost landing [3]

### What counts as "existing agent"?
The public announcement does **not** define "existing prototype" with a hard cut-off (e.g. minimum age, prior public release, or commit-history requirement). Inference and adjacent guidance:

- The companion Google Cloud blog "A dev's guide to production-ready AI agents" frames the prototype → production gap around: session management, persistent memory, tool integration + auth, real-time logging/tracing, evaluation, and safety — i.e. an agent that *works in isolation* but is not yet hardened [5][12].
- The closely related Google Developers Blog post "Production-Ready AI Agents: 5 Lessons from Refactoring a Monolith" describes refactoring an existing monolithic agent into a multi-agent production system [11] — this is the canonical "Optimize" reference architecture pattern.
- Practical read: any agent that the team has working code for prior to the challenge (open source, internal prototype, hackathon entry, etc.) and that they materially improve for production reliability (observability, evals, error handling, latency, cost, scaling) should qualify.
- **GAP**: Exact "existing-prototype" eligibility criteria (e.g. must show baseline commit before May 1, must have demo evidence pre-challenge, etc.) are not in the public web. Confirm in Devpost rules.

### Eligibility
- Same global open-to-anyone rule as Track 1 [1].
- Optimization work must demonstrably improve the prototype on at least one of the judging axes (Technical Implementation = production reliability, observability, evals); the rubric weights tech + business at 60 % combined [1].

---

## 3. Track 3 — **Refactor** (business-ready agent → Marketplace + Gemini Enterprise)

### Exact definition (verbatim)
> "… or refactor a business-ready agent for potential enterprise distribution on Google Cloud Marketplace and the Gemini Enterprise app." [1]

> "refactor a business-ready agent for potential enterprise distribution on Google Cloud Marketplace and the Gemini Enterprise app" [3]

### What does "business-ready" mean?
"Business-ready" is not formally defined in the challenge announcement, but the Google Cloud Marketplace + Gemini Enterprise listing pipeline implies the agent must be sellable to an enterprise buyer. From the partner-agent program documentation [4]:

> Agents must pass a strict four-step evaluation to earn the **"Google Cloud Ready - Gemini Enterprise"** designation:
> 1. **Basic Functionality** — core feature completeness
> 2. **Output Accuracy** — reliable, correct results
> 3. **Autonomous Execution** — true agent capabilities (not just a passive chatbot)
> 4. **Enterprise Standards** — security, governance, compliance

Additional partner-tier requirements [4]:
- Cryptographically secure agent identity
- Clear audit trails via Agent Gateway
- Model Armor integration for data protection
- Compliance with enterprise data-handling standards

### Listing requirements (Marketplace + Gemini Enterprise Agent Gallery)

#### Must the agent be built with ADK?
- **Strongly preferred but not strictly mandatory.** Two registration paths are documented [4][9]:
  - **Path A (ADK-native)**: Register ADK agents hosted on Vertex AI Agent Engine [9].
  - **Path B (A2A protocol)**: Any agent that speaks the open **Agent2Agent (A2A) protocol** can be registered, including non-ADK agents that emit a valid `agent.json` agent card [4][9][13].
- For A2A-compatible agents, the conversion is one line in ADK: `app = to_a2a(root_agent)` [7].
- ADK supports Python and Java [8].

#### Must it use specific GCP services?
- **Gemini Enterprise Agent Platform** — yes, central to all three tracks; the challenge announcement explicitly calls it out as the tool teams receive credits to use [1].
- **Cloud Run** — **NOT mandatory.** It is the canonical reference deployment ("`adk deploy cloud_run --service_name=... --a2a`" [7]) but Vertex AI Agent Engine is an officially supported alternative for production deployment and is referenced in the same docs [7][9].
- **Vertex AI** — ADK agents registered with Gemini Enterprise are typically hosted on Vertex AI Agent Engine [9]; Gemini models on Vertex AI are the default LLM substrate, but the rules do not name a specific model as mandatory.
- **Marketplace listing application** — `https://cloud.google.com/marketplace/sell` is the partner sell-on-Marketplace entry point referenced from the Gemini Enterprise partner program [4].
- The challenge text says "for **potential** enterprise distribution" — i.e. submissions must be *ready to list*, not necessarily *already listed*. Judges score this readiness; final Marketplace approval is a separate Google-internal process [1][4].

### Eligibility
- Same global open-to-anyone rule [1].
- **GAP**: Whether Track 3 requires the team to already be a Google Cloud Partner (or to commit to applying) is not in the public announcement. The Marketplace partner application is a separate intake at `cloud.google.com/marketplace/sell` [4].

---

## 4. Submission deadline + milestones

| Milestone | Date | Source |
|---|---|---|
| Submissions open | At launch at Next '26 (announced day was Apr 22, 2026; blog published same window) | [1] |
| **Final submission deadline** | **June 5, 2026** | [1][3] |
| Winner announcement | **GAP** — not in public announcement | — |
| Judging window | **GAP** — not in public announcement (parallel Rapid Agent Hackathon uses ~3 weeks post-deadline [6]) | — |

No interim milestone deadlines (registration cut-off, intent-to-submit, mid-point check-in) are published.

---

## 5. Judging rubric / scoring weights

Verbatim from the Google Cloud blog [1]:

> "Submissions will be evaluated based on the following weighted criteria: **Technical Implementation (30 %)**, **Business Case (30 %)**, **Innovation and Creativity (20 %)**, and **Demo and Presentation (20 %)**."

| Criterion | Weight | What it likely covers (inferred from adjacent Google contests + Gemini Enterprise validation [4][6]) |
|---|---|---|
| Technical Implementation | 30 % | Code quality, ADK / A2A use, production reliability, observability, evals, security |
| Business Case | 30 % | Market need, ROI, customer/buyer fit, Marketplace viability (especially Track 3) |
| Innovation and Creativity | 20 % | Novelty of agent design, uniqueness vs. existing solutions |
| Demo and Presentation | 20 % | Quality of submitted video + write-up; clarity of architecture |

**GAP**: Per-track rubric variation (e.g. whether Track 3 weights "Marketplace-readiness" inside the Technical 30 %, or whether Track 2 weights "production-reliability evidence" specifically) is not published; the public rubric applies challenge-wide.

---

## 6. Required deliverables

The public announcement does not enumerate the full deliverable list. The **inferred minimum** based on (a) the judging-criteria language ("Demo and Presentation") and (b) Devpost's standard format used in every parallel Google contest [6]:

| Deliverable | Status | Source / Confidence |
|---|---|---|
| Public code repository (GitHub / GitLab / etc.) | **Required** — implied by every comparable Google contest | High confidence by analogy [6] |
| Demo video (typically ≤ 3 min, English or subtitled, YouTube/Vimeo) | **Required** — "Demo and Presentation" = 20 % of score | High confidence; exact length cap is **GAP** [1] |
| Hosted project URL / live agent endpoint | **Required** — judges must test the agent | High confidence by analogy [6] |
| Written description (features, tech, learnings) | **Required** | High confidence by analogy [6] |
| Architecture diagram | **Strongly recommended** — explicitly required in the ADK Hackathon judging [2]; not confirmed required here | **GAP** |
| Open-source license on repo | **GAP** — Rapid Agent Hackathon mandates an OSI-approved license [6]; the Startups challenge's stance is not public |
| Marketplace listing application proof (Track 3) | **GAP** — implied by "potential enterprise distribution" but not explicitly required |

---

## 7. Must-use GCP services

| Service | Status | Source |
|---|---|---|
| **Gemini Enterprise Agent Platform** | **Effectively required** — challenge announcement explicitly says teams get credits "to use" it [1]; it is the central tool referenced for all three tracks | [1] |
| **Agent Development Kit (ADK)** | **Strongly recommended, not provably mandatory** — both ADK-native and A2A-protocol paths register with Gemini Enterprise [4][9]; ADK is the canonical SDK | [4][7][8][9] |
| **Cloud Run** | **Not mandatory** — canonical deployment target but Vertex AI Agent Engine is an officially supported alternative | [7][9] |
| **Vertex AI Agent Engine** | Alternative to Cloud Run for production agent hosting; required when registering ADK agents via Path A | [9] |
| **Gemini models** | Implicitly required (it's "Gemini Enterprise") but no specific model version is named | [1][4] |
| **Model Armor** | Required for Track-3 enterprise designation [4]; not required for Tracks 1–2 | [4] |
| **Agent Gateway** | Required for Track-3 audit-trail compliance [4] | [4] |
| **A2A protocol** | Required if using Path B for Gemini Enterprise registration (Track 3) | [4][7][9] |
| **BigQuery / Cloud Functions / GKE / etc.** | Not mandated by the challenge; teams choose what fits | — |

---

## 8. Prize pool + credit allocation

- **Total prize pool**: **$90,000 USD** [1][3]
- **Per-team credits**: **$500 USD** Google Cloud credits to all participating teams [1][3]
- **Per-track prize breakdown**: **GAP** — the public announcement gives the total pool but does not split it across the three tracks. By analogy with the parallel Rapid Agent Hackathon (six tracks × $10K = $60K split as 5K/3K/2K per track [6]), a plausible structure is roughly $30K per track split among 1st/2nd/3rd places, but **this is unconfirmed**.
- **Additional context (not part of the prize pool itself)**: Google announced a separate **$750 million fund** at Next '26 for "agent development and marketing for our partners" [1][3] — distinct from this challenge's prize pool, oriented at the broader partner program.

---

## 9. Multi-track submission policy

- **GAP** — not in the public announcement.
- Convention from the parallel Rapid Agent Hackathon: "Individuals may submit multiple unique submissions or join different teams with distinct projects" but "Winners can receive maximum one prize per submission" [6].
- Conservative assumption until Devpost rules are read: **one project per submission, but a team / individual may submit separately to multiple tracks if each submission is materially distinct.** The three tracks are explicitly described as different "stages" of the same journey, so the *same* agent cannot reasonably qualify for both "net-new" and "refactor" simultaneously — pick the stage that matches.

---

## 10. Open-source vs private repo policy for judges

- **GAP** — not in the public announcement.
- Strong precedent: the **Rapid Agent Hackathon** (same sponsor, same Devpost host, same week) requires a "Public code repository with open-source license prominently displayed" and that "Non-proprietary aspects … must be licensed under an Open Source Initiative-approved license with no restrictions on commercial use" [6].
- The **ADK Hackathon** (same sponsor) similarly requires public repo access for judging [2].
- Practical assumption: **repo must be readable by judges**. The Startups challenge may permit private repos with judge access granted, or may require fully public OSI-licensed repos; **confirm in Devpost rules.**
- Important nuance for Track 3: Marketplace-listed agents do **not** have to be open-source — they are commercial products. So the repo-visibility rule (for judges) is decoupled from the product's commercial licensing.

---

## 11. Other notable items from primary sources

- **Companion partner agents already live**: 70+ partner agents (Accenture, Adobe, Atlassian, Deloitte, etc.) are already in the Gemini Enterprise Agent Gallery + Marketplace [4][10] — Track 3 submissions are competing for shelf-space in the same gallery.
- **Agent Marketplace direct URL**: `https://console.cloud.google.com/marketplace/browse?filter=category:ai-agent&filter=validations:gemini-enterprise-compatible` [4]
- **Registering an ADK agent with Gemini Enterprise** is documented at `https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-adk-agent` [9].
- **A2A agent registration via Cloud Run** end-to-end is in the Medium walkthrough [7] (the canonical Track 3 reference implementation).

---

## 12. Open gaps that require reading the Devpost rules page directly

After registering at `https://devpost.team/hackathon_guest_invites/4fb181b4-2722-415d-a442-285a57dcaba5` (or via `goo.gle/486nbl4`), confirm these items inside the gated Devpost console:

1. Exact prize split per track + per placement (1st / 2nd / 3rd).
2. Country eligibility blocklist (the parallel Rapid Agent Hackathon excludes 20+ countries [6]; the Startups challenge's list is not public).
3. Maximum team size.
4. Exact "new work" / "existing prototype" cut-off dates (especially for Tracks 1 and 2).
5. Full required-deliverables checklist (demo-video length cap, architecture-diagram requirement, license requirement).
6. Repo visibility policy (public vs judge-granted private).
7. Multi-track / multi-submission rules.
8. Judging timeline (winner-announcement date, judging window).
9. Whether Track 3 requires existing Google Cloud Partner status or commitment to apply.
10. IP / license grant clauses (every parallel Google contest grants Google a "perpetual, irrevocable, worldwide, royalty-free, non-exclusive license" for promotional use of submitted video content [6]; likely identical here).

---

## Sources

1. **Google Cloud Blog — "Startups are building the agentic future with Google Cloud"** (primary announcement, contains verbatim challenge description, deadline, prize pool, judging weights, three-track structure, Devpost link). URL: https://cloud.google.com/blog/topics/startups/startups-are-building-the-agentic-future-with-google-cloud
2. **Agent Development Kit Hackathon with Google Cloud — Devpost rules** (parallel contest, used here for inferred deliverable conventions). URL: https://googlecloudmultiagents.devpost.com/rules
3. **Google Cloud Blog — "The top startup announcement from Next '26"** (corroborates tracks, deadline, prize pool, judging weights; gives short-link `goo.gle/486nbl4`). URL: https://cloud.google.com/blog/topics/startups/the-top-startup-announcement-from-next26
4. **Google Cloud Blog — "Partner-built agents available in Gemini Enterprise"** (Marketplace listing requirements, "Google Cloud Ready - Gemini Enterprise" 4-step evaluation, ADK + A2A protocol requirement, Agent Marketplace URL). URL: https://cloud.google.com/blog/products/ai-machine-learning/partner-built-agents-available-in-gemini-enterprise
5. **Google Cloud Blog — "A dev's guide to production-ready AI agents"** (production-readiness reference for Track 2). URL: https://cloud.google.com/blog/products/ai-machine-learning/a-devs-guide-to-production-ready-ai-agents
6. **Google Cloud Rapid Agent Hackathon — Official rules** (parallel sponsor-run contest used as the closest precedent for Devpost-format conventions: deliverables, repo policy, team size, eligibility countries, IP terms). URL: https://rapid-agent.devpost.com/rules
7. **Medium / Google Cloud Community — "Surprisingly simple A2A agents with ADK, deploy to Cloud Run, and Gemini Enterprise"** (canonical Track 3 reference implementation: `to_a2a()` + `adk deploy cloud_run` + Gemini Enterprise registration). URL: https://medium.com/google-cloud/surprisingly-simple-a2a-agents-with-adk-using-to-a2a-deploy-to-cloud-run-and-gemini-enterprise-e815bdef4a32
8. **Google Cloud Docs — Agent Development Kit** (ADK reference, Python + Java). URL: https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/adk
9. **Google Cloud Docs — "Register and manage ADK agents hosted on Gemini Enterprise Agent Platform"** (Path-A registration for Gemini Enterprise). URL: https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-adk-agent
10. **Google Cloud Docs — "Add and manage A2A agents from Google Cloud Marketplace"** (Path-B / A2A protocol Marketplace pathway, A2A agent card / `agent.json` requirement). URL: https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-marketplace-agents
11. **Google Developers Blog — "Production-Ready AI Agents: 5 Lessons from Refactoring a Monolith"** (Track 2 / Track 3 refactor reference). URL: https://developers.googleblog.com/production-ready-ai-agents-5-lessons-from-refactoring-a-monolith/
12. **Google Cloud Blog — "Five guides to building and scaling production-ready AI agents"** (production-readiness guide bundle). URL: https://cloud.google.com/blog/topics/developers-practitioners/five-guides-to-building-and-scaling-production-ready-ai-agents
13. **Google Cloud Docs — Gemini Enterprise Agent Platform overview** (A2A protocol as an open standard, registration flows). URL: https://docs.cloud.google.com/gemini-enterprise-agent-platform/overview

---

**Methodology note**: The Devpost rules page (`https://devpost.team/hackathon_guest_invites/4fb181b4-...`) returned HTTP 403 behind a Cloudflare challenge to the WebFetch tool on 2026-05-19 04:14 UTC (verified via `curl -sI -L`). It is gated as a "guest invite" page — accessible only after a logged-in Devpost user accepts the invite. All content above is therefore reconstructed from primary Google Cloud blog posts, official Google Cloud product docs, the YouTube launch video metadata + short-URL redirect chain, and the rules of two parallel sister hackathons (Rapid Agent, ADK Hackathon) which share the same sponsor and Devpost host. Items marked **GAP** are explicitly unknown and must be confirmed inside Devpost after registering.
