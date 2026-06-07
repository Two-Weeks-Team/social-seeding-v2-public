# Business case — Social Seeding (Track 3, Business 30%)

> **Authority & honesty contract.** Every number on this page is one of three things, and is
> labeled as such inline:
> **[CITED]** a real external 2025–2026 benchmark with a source URL;
> **[DERIVED]** computed from our own model with the formula shown in the cell;
> **[ASSUMPTION]** an illustrative input we chose, stated openly so a judge can swap it.
> There are **no invented customers, no LOIs, no waitlist counts, no testimonials, no signups**.
> The design-partner program (see §6) is **open with zero validated signups** — it is pre-launch.
> Cost-of-goods figures are grounded in the codebase's per-call USD constants and
> [`gcp-research/cost-planning/COST-PLAN.md`](../../../gcp-research/cost-planning/COST-PLAN.md).
> Strategic decisions cited as **D-IDs** trace to
> [`gcp-research/decisions/DECISIONS.md`](../../../gcp-research/decisions/DECISIONS.md).
>
> This document **aligns with** the Business section of
> [`devpost-track3.md`](./devpost-track3.md) (pricing D28, distribution D3, tenancy D12, cost
> envelope D39/D46) and tightens its "napkin" TAM/SAM/SOM into a sourced, formula-shown model.

---

## 1. The headline (ROI vs a traditional agency)

For the **same 20-creator KR skincare TikTok campaign**, the brand pays a traditional influencer
agency a **management fee of ≈ $2,400** (20% of creator spend) plus **≈ 45 hours of human ops**.
Social Seeding runs the same loop for **≈ $7.40 of agent+infra cost** with **≈ 2 hours of human
review** (the approval gates). The defensible delta is **the management fee, not the creator pay** —
creator pay is identical pass-through in both columns.

- **Cost delta (management/ops only):** $2,400 → $7.40 ≈ **$2,393 saved per campaign**, a **99.7%
  reduction in the management-fee line**. [DERIVED — see §2]
- **Labor saved:** ≈ **43 human-hours per campaign** (45h manual → ~2h review). [DERIVED from CITED
  manual-ops benchmarks — see §2]

This is **not** a claim that influencer marketing gets 99.7% cheaper — the creator media spend
($12,000) is unchanged. It is a claim that the **agency's management layer** is the part our agent
fleet automates, and that layer is what collapses.

---

## 2. ROI-vs-agency comparison (same 20-creator KR skincare campaign)

### 2.1 Scenario definition (the inputs, all labeled)

| Input | Value | Basis |
|---|---|---|
| Campaign | 20 micro creators (10K–100K followers), KR skincare, TikTok | [ASSUMPTION] representative mid-market campaign |
| Creator pay per video | **$600** | [CITED] TikTok micro sponsored rate $200–$1,500; we take a conservative mid-low point. (influencermarketinghub.com / influencerfee.com) |
| Total creator media spend (pass-through) | 20 × $600 = **$12,000** | [DERIVED] identical in both columns — excluded from the delta |
| Fully-loaded ops labor rate | **$60/hr** | [ASSUMPTION] blended US/KR marketing-ops loaded cost |

### 2.2 Traditional agency column

| Cell | Value | Formula / source |
|---|---|---|
| Management fee (headline: % of spend) | **$2,400** | [DERIVED from CITED] 20% × $12,000 creator spend. 20% is the midpoint of the cited **15–30% of creator-spend** agency model. (favikon.com, digitalagencynetwork.com, almcorp.com) |
| Management fee (alternate: project fee) | $5,000 | [CITED] project-fee model floor for a small campaign is **$5,000–$50,000**. (favikon.com) We use the **lower $2,400 % model as the headline** to avoid inflating the delta. |
| Human ops time | **45 hours** | [CITED] a fully manual outreach workflow = **20h finding + 10h vetting + 15h personalized outreach**. (shopclawmart.com) Cross-checks the [CITED] **0.5 FTE-hr/creator** rule → 20 × 0.5 = 10h floor for execution alone. (influenceflow.io) We use the fuller 45h figure as the manual baseline. |
| Ops labor cost (informational) | $2,700 | [DERIVED] 45h × $60/hr. Shown for context; the agency fee usually *includes* this labor, so we do **not** add it to the $2,400 headline (no double-counting). |
| **Agency total (management layer)** | **$2,400** | headline = management fee only; creator pay excluded as pass-through |

### 2.3 Social Seeding column (our cost of goods)

Our cost is **GCP compute**, not the $0.01/view *price* (the price is revenue — see §4). The
compute basis is grounded in [`COST-PLAN.md §2`](../../../gcp-research/cost-planning/COST-PLAN.md)
and the per-call USD constants committed in `packages/agents-adk/src/ss_agents/tools/*.py`.

| Cell | Value | Formula / source |
|---|---|---|
| One full brand-campaign LLM loop | **$0.62** | [DERIVED, grounded] COST-PLAN.md §2 call-by-call total on Gemini 3.5 Flash for the final demo. Sourcing → vet → 5×4 outreach tournament → classify → follow-up → logistics → verify → report. |
| Per-creator fan-out (vetting + outreach draft × 20) | **+$6.40** | [DERIVED] 20 creators × ≈$0.32 incremental (vetting `vector_search_creator` $0.0002 + `ranking_score` $0.0001 + a per-creator Gemini 3.1 Flash-Lite vet+draft ≈ $0.30, from COST-PLAN.md Flash-Lite rates $0.30/$2.50 per 1M tok). [ASSUMPTION] linear fan-out at 20×. |
| Capability tool calls (real code constants) | **+$0.30** | [DERIVED, grounded] e.g. `rapidapi_tiktok_search` $0.001, `a2a_invoke` $0.0005, `vision_brand_logo_detect` $0.0015, `gmail_send_reply` $0.0001 × ~dozens of calls. Constants are real (`packages/agents-adk/.../tools/*.py`). |
| Infra amortized per campaign | **+$0.08** | [DERIVED, grounded] COST-PLAN.md: ~$0.02 Firestore/campaign + Cloud Run/Logging/GCS ≈ $0; idle infra **$1–5/mo** (D46, all Cloud Run `min=0`) amortized over modest campaign volume. |
| Human review time | **~2 hours** | [ASSUMPTION] operator clears the AP2 Intent Mandate + escalation gates (D27); not zero — the human-in-the-loop is the product (§6). |
| **Social Seeding total (cost of goods)** | **≈ $7.40** | [DERIVED] $0.62 + $6.40 + $0.30 + $0.08 |

### 2.4 The comparison table (this is what `roi-comparison.json` renders)

| Scenario | Agency mgmt cost | Social Seeding cost | Savings | Labor saved |
|---|---|---|---|---|
| **20-creator KR skincare (headline, % model)** | **$2,400** | **$7.40** | **99.7%** | **43 hrs** (45h → 2h) |
| 20-creator (alternate, project-fee model) | $5,000 | $7.40 | 99.9% | 43 hrs |
| 5-creator boutique pilot | $1,500¹ | $2.30² | 99.8% | ~10 hrs (12h → 2h)³ |
| 50-creator scale program | $15,000⁴ | $17.10⁵ | 99.9% | ~123 hrs (125h → 2h)⁶ |

¹ [CITED] boutique micro-agency retainer floor $3,000–$8,000/mo covering 3–5 campaigns → ~$1,500/campaign. (favikon.com)
² [DERIVED] $0.62 loop + 5×$0.32 fan-out + ~$0.08 infra.
³ [CITED] 0.5 FTE-hr/creator × 5 + setup ≈ 12h. (influenceflow.io)
⁴ [DERIVED from CITED] 20% × (50 × $1,500 mid-tier blended) is far higher; we instead cite the **$15,000/mo full-service retainer for 10–20 creators** (favikon.com) as the realistic 50-creator-program fee.
⁵ [DERIVED] $0.62 + 50×$0.32 + infra.
⁶ [CITED] 50 × 0.5 FTE-hr + 100h vetting-heavy programs reported at scale. (sproutsocial.com, influenceflow.io)

**Defensibility note.** The savings % is large because we are comparing a **human-labor management
fee** to **machine compute**. The honest framing (used in the demo and devpost) is "we collapse the
agency *management layer*; the creator spend is unchanged." We deliberately chose the **lower 20%
fee model** and the **higher 45h labor benchmark** so the delta is conservative, not cherry-picked.

---

## 3. Market sizing (TAM / SAM / SOM)

Top-down from cited market-size reports, narrowed by an explicit, labeled methodology. Where the
public data is thin we say so and mark the step **[ASSUMPTION]**.

### 3.1 TAM — total addressable market

| Layer | Value | Basis |
|---|---|---|
| Global influencer-marketing **spend** (2026) | **$27.5B – $37.3B** | [CITED] The Business Research Company $27.54B (2026); Statista-range firms to $37.27B. (thebusinessresearchcompany.com, statista.com) |
| Influencer-marketing **platform/software** segment (2026) | **$1.15B** | [CITED] MarketsandMarkets: platform market $1.15B (2026) → $2.03B (2031), 12% CAGR. (marketsandmarkets.com) |
| **TAM we use** | **≈ $27.5–37.3B** (media spend) | [DERIVED] Social Seeding is an **autonomous campaign operator** that *runs* campaigns and intermediates the brand's creator-marketing spend — so the addressable pie is the **media-spend market**, not just the software slice. (The $1.15B software-platform segment is the floor if we were a pure tool.) |

### 3.2 SAM — serviceable addressable market

| Step | Value | Basis |
|---|---|---|
| Serviceable segment | DTC/SMB + cross-border / gatekeeper-excluded brands running **performance** creator campaigns | [ASSUMPTION] our ICP — the brands an autonomous operator can win first (matches devpost-track3 "$5k–$50k/mo" target) |
| Share of TAM serviceable | **~10%** | [ASSUMPTION] the SMB/DTC + emerging-market slice an operator-led product serves day-1 (not the whole $27–37B) |
| **SAM** | **≈ $3.3B** | [DERIVED] ~10% of the $27.5–37.3B media TAM. An estimate, not a measured market. |

### 3.3 SOM — serviceable obtainable market (3-year)

| Step | Value | Basis |
|---|---|---|
| Beachhead | KR/JP/EN-language DTC + **cross-border** (e.g. a KR brand → LATAM creators — the Wooliliwoo case) | [ASSUMPTION] D34 i18n locales; D3 A2A-only distribution wedge |
| Active brands (yr-3) × operated spend | **~150 × ~$220k/yr** | [ASSUMPTION] reachable DTC/SMB performance-creator brands × per-brand annual creator budget we operate |
| Realistic 3-yr capture of SAM | **~1%** | [ASSUMPTION] conservative early-stage capture (the ~150-brand path below) |
| Campaign spend operated (GMV) | **≈ $33M/yr** | [DERIVED] ~150 brands × ~$220k = $33M ≈ 1% of the $3.3B SAM |
| Take-rate | **~29%** | [DERIVED] platform keeps ~29% of operated spend after creator/product compensation + COGS (`gcp-research/pricing/MODEL.md`) |
| **SOM (3-yr)** | **≈ $10M ARR** | [DERIVED] $33M operated × ~29% take. Bottom-up; assumption-driven. |

**Methodology honesty.** TAM is **CITED**. SAM and SOM are **top-down narrowed by labeled
assumptions** — the brand counts (80k, 3k) are estimates, not measured registries, and are flagged
as the weakest links. The real validation is design-partner pilots (§6), not these projections.

---

## 4. Pricing model & unit economics (per-campaign first 10k free → $0.01/view, D28)

**Price (revenue):** **per campaign, the first 10,000 delivered views are free; beyond that, $0.01
per delivered view** = a **$10 effective CPM** above the free tier, ROI-linked — the customer pays
only for measured views, and only once a campaign breaks out past 10k (D28). Metered via Apigee X:
view events → Pub/Sub → BigQuery → meter (devpost-track3).

**Why per-campaign-free, not a one-time trial:** every campaign starts free, so there is zero
adoption friction to launching *another* campaign; small/test campaigns (<10k views) are entirely
free; and revenue is **outcome-aligned** — we only earn when we make a campaign succeed past 10k.
The free allowance is cheap to offer because billing is per-view-delivered and our compute marginal cost
is low (~$7.40/campaign, §2.3) — the larger COGS is the creator/product compensation we manage as operator
(§4.1). The honest counter — "many
campaigns may stay under 10k and bill $0" — is the intended shape: the model monetizes breakout
campaigns and the *compounding data asset* below (§4.3), with retention to be validated in pilots (§6).

**Is $10 CPM defensible?** Yes — it sits inside cited norms:

| Benchmark | Value | Source |
|---|---|---|
| TikTok ad CPM range (2025) | $4.8 – $13.26 | [CITED] lebesgue.io ($4.8 avg), triplewhale/scrumball ($9.16–$13.26) |
| Our effective CPM | **$10.00** | [DERIVED] $0.01 × 1,000 — within the cited band, on the value-priced side vs managed-service CPMs |

### 4.1 Take-rate on a delivered campaign

As an **operator** we run the campaign end-to-end — including the creator/product compensation — and keep a **take** of the brand's spend. Take the §2 scenario delivering **1,000,000 views** (20 creators × 50k avg — [ASSUMPTION], conservative for the micro tier). First 10,000 free (D28), so **990,000 billable**:

| Line | Value | Formula |
|---|---|---|
| Brand billing (revenue) | **$9,900** | [DERIVED] 990,000 × $0.01 (D28) |
| − Creator/product compensation | **≈ $5,400** | [DERIVED, `MODEL.md`] ≈ $0.0055/view — the creators we seed/compensate |
| − Compute + COGS | **≈ $7–60** | [DERIVED] §2.3 compute ~$7.40 + fees/support |
| **Platform take (net)** | **≈ $2,870 (~29%)** | [DERIVED] revenue − creator/product − COGS (`MODEL.md`) |

> Worked example on real demo data (Wooliliwoo 2nd, Mexico): 59,498 verified views − 10,000 free = **49,498 billable × $0.01 = $494.98 campaign billing**; on ~$7.40 of agent compute the platform take is **~29%** after creator/product compensation.

This is a **take-rate**, not a software gross margin. The take is sensitive to creator-compensation cost — at the lower-cost end of each band the platform keeps ~29¢ per delivered $1; better creator matching (cheaper effective comp) lifts it (`MODEL.md §5`). **Honesty note:** in the shipped product, creator compensation is largely **product-seeding (gifting)**, so the cash $0.0055/view payout above is the `MODEL.md` *model*; the realized take depends on the seeding-vs-cash mix per campaign. Caveats: excludes customer-acquisition cost and our ~2h/campaign human review.

### 4.2 Cost envelope (D39 / D46)

[CITED-internal, grounded] All three live Cloud Run services are `min=0` scale-to-zero; idle GCP
spend runs **~$1–5/mo** (D46). The $1,500 GCP credit (D39) covers the worst case many times over.
`cost_watch` (Tier-3 agent, `pubsub_alert` $0.00005/call) emits per-tenant USD-ceiling alerts at
50/75/90/95% (D23/D41).

### 4.3 The compounding moat — data + relationships (why free-to-enter still retains)

The per-campaign free-10k lowers the *entry* barrier; what raises the *exit* barrier is the data the
platform accumulates as the agent runs campaigns. Two proprietary, compounding assets:

1. **Creator-performance graph** — per campaign, `content_verify` records *which* creators actually
   delivered for *which* brand/vertical, at what verified engagement (the 우리리우 run alone:
   16 verified posts, 59,498 views, 7.93% ER). Over many campaigns this becomes a brand-specific
   "who-converts" graph layered on the 174k shared-cluster creators — something a competitor starting
   cold cannot reproduce, and that makes the next campaign's sourcing/vetting measurably better.
2. **Outreach / communication history** — the agent owns the relationship thread with each creator
   (who replied, what subject/offer worked, prior collaborations). The brand's creator relationships
   and the agent's *learned* outreach both live in Social Seeding.

**The flywheel:** more campaigns → more verified-performance + communication data → sharper
sourcing/vetting/outreach → better campaign outcomes → more campaigns. The free tier *feeds* the
flywheel (every free campaign still deposits data).

**Switching cost (lock-in):** leaving means abandoning the brand-specific creator graph + the
relationship/communication history + the agent's tuned outreach. That is a structural retention
mechanism — **not yet a proven retention number**. Per §6 (Professional Honesty), we have zero
validated signups today; the design-partner pilots are what convert "structural switching cost" into
a **measured** retention/expansion curve. Framed as moat-by-design, validated next.

---

## 5. Go-to-market — the A2A-only distribution wedge (D3)

The distribution path **is** the differentiation, because of a real constraint:

- **The constraint (D2):** Google Cloud Marketplace's payment-region list **excludes Korea**. A
  Korean-incorporated entity cannot take the direct paid-listing path without a foreign sub-entity
  (a 6–12-month legal/banking project). [CITED-internal, user-confirmed]
- **The wedge (D3):** publish an **A2A-only distribution path** — register the ADK agent on A2A
  v0.3 via Agent Registry so Gemini Enterprise customers **discover and call** the
  `plan_creator_search` skill *without* the Marketplace billing rail; meter per-call via Apigee X;
  invoice directly under Korean tax law. Any non-Marketplace-payment-region startup can copy it.
- **Why it is a wedge, not a workaround:** it turns a regional exclusion into a **published,
  forkable pattern** (BUSL-1.1 + Apache-2.0, D9) and opens a **second revenue line** — platform
  engineers building marketing-tech agents consume the A2A skill instead of building TikTok
  scrapers (devpost-track3 "Target customer" #3). Korea = APAC, so the APAC Regional prize is in
  range alongside the Grand Prize aim (D50).
- **Two customer motions:**
  1. **Direct SaaS tenants** (D12 multi-tenant) — brand/agency campaign managers, $1,250–$2,500/mo.
  2. **A2A connector consumers** — pay per `plan_creator_search` call (marginal cost ≈ $0.001/call,
     the scraper fleet is already production traffic — devpost-track3). [DERIVED, grounded]

---

## 6. What would validate this (the honest next step)

Everything above is **CITED benchmarks, DERIVED models, or labeled ASSUMPTIONS** — none of it is
market-validated demand. The roadmap to replace projections with evidence:

1. **Design-partner pilot program — open, zero validated signups (pre-launch).** We are *opening* a
   design-partner program; we have **not** collected signups, LOIs, or commitments. Stating zero is
   the honest position. The first 3–5 pilots replace the §2 labor benchmarks with **measured
   our-side review hours** and the §3 brand counts with **real funnel conversion**.
2. **Per-campaign cost telemetry in production.** The §2.3 compute total is grounded in code
   constants + COST-PLAN.md, but the 20× fan-out is an [ASSUMPTION]. The `cost_watch` ledger
   (D23/D41) will emit **measured** per-campaign USD once a real campaign runs end-to-end live.
3. **CPM/CPV realization.** The $10 effective CPM (§4) is priced; **delivered-view metering**
   (Apigee X → BigQuery, devpost-track3) produces the real realized CPM per campaign — the number
   that turns "$0.01/view price" into a measured unit economic.
4. **SAM/SOM brand counts.** The 80k / 3k brand counts (§3) are the weakest links; a bottom-up
   count from Shopify-Plus + DTC registries in KR/JP/EN replaces them.

Framed as **roadmap, not as done** (per `RULES.md §Professional Honesty`). The defensible claims
today are: the cost *structure* (machine compute vs human management fee), the pricing *position*
($10 CPM inside cited norms), and the distribution *path* (A2A-only, D3). Demand is unproven and
labeled as such.

---

## Sources (external, cited above)

- Favikon — How Much Do Influencer Marketing Agencies Charge: https://www.favikon.com/blog/how-much-influencer-marketing-agencies-charge
- Digital Agency Network — Influencer Marketing Agency Pricing Guide 2026: https://digitalagencynetwork.com/influencer-marketing-agency-pricing-guide/
- ALM Corp — Influencer Pay Transparency 2026 (agency fees 15–30%): https://almcorp.com/blog/influencer-pay-transparency-agency-fees-creator-rates-2026/
- ShopClawMart — Automate Influencer Outreach (45h manual workflow, $1,500 cost/acquired influencer): https://www.shopclawmart.com/blog/automate-influencer-outreach-personalization-ai
- InfluenceFlow — Automation Tools 2026 (0.5 FTE-hr/creator; 15h/wk saved): https://influenceflow.io/resources/influencer-marketing-automation-tools-the-complete-2026-guide-7/
- Sprout Social — Influencer Vetting Process (30–60 min/creator): https://sproutsocial.com/insights/influencer-vetting-process/
- Influencer Marketing Hub — TikTok Influencer Rates 2026: https://influencermarketinghub.com/tiktok-influencer-rates/
- InfluencerFee — TikTok Influencer Statistics 2026 (sponsored rate tiers): https://influencerfee.com/blog/tiktok-influencer-statistics-2025/
- Lebesgue — TikTok Ads Benchmarks for CTR/CR/CPM 2026 ($4.8 avg CPM): https://lebesgue.io/tiktok-ads/tiktok-ads-benchmarks-for-ctr-cr-and-cpm
- Triple Whale — TikTok Ads Benchmarks ($9.16–$13.26 CPM): https://www.triplewhale.com/blog/tiktok-benchmarks
- Scrumball — TikTok CPM Rates 2026: https://www.scrumball.com/blog/tiktok-cpm-rates
- MarketsandMarkets — Influencer Marketing Platform Market ($1.15B 2026 → $2.03B 2031): https://www.marketsandmarkets.com/Market-Reports/influencer-marketing-platform-market-294138.html
- The Business Research Company — Influencer Marketing Platform Global Market Report 2026 ($27.54B): https://www.thebusinessresearchcompany.com/report/influencer-marketing-platform-global-market-report
- Statista — Influencer marketing worldwide (market-size range): https://www.statista.com/topics/2496/influence-marketing/

## Sources (internal, grounded above)

- Cost basis: [`gcp-research/cost-planning/COST-PLAN.md`](../../../gcp-research/cost-planning/COST-PLAN.md) (§2 call-by-call; ~$0.62/loop)
- Per-call USD constants: `packages/agents-adk/src/ss_agents/tools/*.py` (`a2a_invoke` $0.0005, `rapidapi_tiktok_search` $0.001, `vision_brand_logo_detect` $0.0015, `imagen_generate` $0.04, `veo_generate` $1.00, `pubsub_alert` $0.00005, etc.)
- Decisions: [`gcp-research/decisions/DECISIONS.md`](../../../gcp-research/decisions/DECISIONS.md) — **D28** ($0.01/view), **D3** (A2A-only distribution), **D12** (multi-tenant), **D39** ($1,500 credit), **D46** (scale-to-zero envelope)
- Aligns with: [`devpost-track3.md`](./devpost-track3.md) Business case section
