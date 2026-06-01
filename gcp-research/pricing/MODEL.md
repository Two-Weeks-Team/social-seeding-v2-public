# MODEL.md — Per-View Pricing Model ($0.01/view, $10 CPM)

> **Owners**: Business panel (Christensen JTBD · Drucker management · Kim/Mauborgne blue ocean · Taleb antifragile)
> **Authority**: Operationalizes **D28** (per-view pricing) under the constraints of **D11** (influencer-campaign domain), **D12** (multi-tenant SaaS + AP2 autonomous payment), and **D27** (Intent Mandate only) from `DECISIONS.md`.
> **Status as of 2026-05-19**: First-pass pricing model. Open question **O8** (minimum monthly commit, prepaid credits, overage caps) is closed inside this doc; new questions surface in §11.
> **Audience**: (1) Devpost judges evaluating the Business 30% rubric, (2) the AP2 + Apigee monetization implementation agent, (3) future customer-success org.

---

## 1. Per-view economics — what does each cent buy?

### 1.1 Market context (cited CPM ranges, 2025-2026)

Across the industry, the cost of **one delivered TikTok view** sits in a wide band depending on whether the buyer pays a creator directly, a network, or a managed-service vendor:

| Channel | Effective CPM (USD) | Per-view cost | Source pattern |
|---|---|---|---|
| TikTok Spark Ads / Brand Premium (auction) | $6 – $10 in-feed; up to $20+ in TopView | $0.006 – $0.020 | Reported by Sprout Social, Hootsuite, Influencer Marketing Hub digests of TikTok Ads Manager invoices (2024-2025). |
| Creator-direct flat fee, **macro-influencer** (1M+ followers) | $25 – $80 | $0.025 – $0.080 | Aspire and Influencer Marketing Hub benchmark studies; mid-band $50 ≈ $0.05/view. |
| Creator-direct flat fee, **mid-tier** (100K-1M) | $10 – $30 | $0.010 – $0.030 | Same sources; this is the dense band where managed platforms compete. |
| Creator-direct flat fee, **micro-influencer** (10K-100K) | $5 – $15 | $0.005 – $0.015 | Same sources. |
| Managed agencies (e.g. The Outloud Group, Open Influence) | $20 – $50 (margin-loaded) | $0.020 – $0.050 | Public agency rate cards + RFP responses circulating in HubSpot / G2 reports. |
| **social-seeding-v2 list price (D28)** | **$10** | **$0.01** | This document. |

**Where $0.01/view (CPM $10) lands**: at the **floor of the creator-direct mid-tier band** and **at parity with the cheapest TikTok auction in-feed**. It is **below the typical managed-agency band** because we are replacing the agency labor with agents. The pricing is therefore positioned as "we charge what the platform itself charges, while doing the creator selection, outreach, contract, and verification work an agency would charge another $10-40 CPM for."

The reason the headline price is not lower (e.g. $0.005, sitting at the micro-influencer floor) is that customers buying micro-influencers are doing volume; below $0.005 the unit economics for the agent platform invert (see §1.3) because Gemini judgment cost and creator commission alone consume the entire revenue.

### 1.2 Unit economics — what each $0.01 covers

For every $0.01 we charge for a delivered view, the cost stack is approximately:

| Cost component | Cents per view | Notes |
|---|---|---|
| **Creator commission** (paid to the influencer) | **0.50 – 0.60 ¢** | Flat $5-6 CPM equivalent, paid out after the post hits its first-week view target. This is the largest single cost; it is what makes the deal worth the creator's time. |
| **Gemini inference** (sourcing → vetting → outreach → reply → verify → report) | **0.05 – 0.10 ¢** | Per the cost model in `COST-PLAN.md` §2, an end-to-end brand-campaign run costs ~$0.62 in Gemini calls. Spread that over the median delivered campaign size (≈100K views), unit cost is $0.62 / 100,000 ≈ **0.0006 cent per view**. For smaller campaigns (10K views), it rises to 0.006 cent per view. We model 0.05-0.10 cent to absorb retries and reply tournaments at the long tail. |
| **GCP infrastructure** (Spanner, Pub/Sub, BQ, Apigee, Cloud Run, Model Armor, Memory Bank) | **0.05 – 0.10 ¢** | Per-tenant amortization of multi-region Spanner + AlloyDB + Firestore + Memorystore. Spanner multi-region is the largest single line ($0.30/node-hour × 3 regions × 3 replicas at idle; amortized across the tenant base). |
| **Payment processing** (AP2 + Stripe/Toss + FX) | **0.04 – 0.06 ¢** | Stripe 2.9% + 30¢ on each customer charge; Toss 2.5% on KRW invoices; FX spread 0.5-1.5% on creator payout if cross-border. Per-view amortization assumes a $1,000 average invoice (100K views @ $0.01). |
| **PIPA/CAN-SPAM/GDPR compliance overhead** | **0.02 – 0.04 ¢** | DLP redaction passes, audit-log retention (90 d per D33), Model Armor scans, consent-record storage. Mostly storage and the compliance agent (D23 #13). |
| **Customer success + dispute reserve** | **0.05 – 0.10 ¢** | Allowance for fraud investigation, view-count disputes, refund processing, CS labor (see §10 for org sizing). |
| **Sub-total (cost of delivery)** | **0.71 – 1.00 ¢** | |
| **Platform margin** | **0 – 0.29 ¢** (0% – 29% gross margin) | What's left. At the lower-cost end of each band we keep ~29¢ per delivered $1. At the higher end we operate at breakeven and need scale or a tier upgrade (§5). |

**Bluntly**: per-view pricing **is not a fat-margin business at the headline number**. It is a **scale business with one fat cost (creator commission) and several thin variable costs**. The margin is in (a) buying creators at the floor of their band by matching them to high-fit campaigns, and (b) compressing the agent stack as Gemini Flash absorbs more of the judgment workload that Pro does today.

### 1.3 Worked example — a 100K-view post

**Campaign**: One mid-tier creator (300K TikTok followers), one branded post, target 100K first-week views, customer pays per delivered view.

| Line | Amount |
|---|---|
| Views delivered (first 7 days after post goes live, per §3 counting rules) | **100,000** |
| Customer is charged | 100,000 × $0.01 = **$1,000.00** |
| **Outflows** | |
| Creator commission (50% of revenue, paid out after verify) | -$500.00 |
| Gemini inference for this campaign (≈$0.62 — see `COST-PLAN.md` §2.2) | -$0.62 |
| Per-campaign GCP allocation (Spanner + Pub/Sub + BQ + Apigee) | -$50.00 |
| AP2/Stripe/Toss + FX on customer charge | -$35.00 |
| AP2/Stripe + FX on creator payout (USD → KRW or similar) | -$15.00 |
| Compliance + DLP overhead (allocated) | -$30.00 |
| CS + dispute reserve (allocated) | -$80.00 |
| **Sub-total outflows** | **-$710.62** |
| **Gross margin** | **$289.38 (≈ 29%)** |

**Interpretation**:
- At 29% gross margin on a $1,000 invoice, the platform earns **~$289 per campaign** before fixed-cost amortization (engineering, sales, security, legal).
- This is **healthy by SaaS standards** but **thin by managed-services standards**. The reason it works: the customer's alternative (an agency at $25-50 CPM) is 2-5× our price, and the customer's alternative (running it themselves) costs them their time + a much worse creator match.
- **The leverage point** is creator commission. If we can buy the same creator at $0.005 instead of $0.0055/view through better matching, we move from 29% to 34% gross margin without changing the headline price.

### 1.4 The 10K-view post — where the model strains

| Line | Amount |
|---|---|
| Views delivered | **10,000** |
| Customer is charged | 10,000 × $0.01 = **$100.00** |
| Creator commission (50%) | -$50.00 |
| Gemini inference (still ≈$0.62 — agent calls don't scale linearly down) | -$0.62 |
| Per-campaign GCP allocation | -$15.00 |
| Payment processing (Stripe 2.9% + 30¢ + Toss + FX) | -$5.50 |
| Compliance + DLP overhead | -$8.00 |
| CS reserve | -$15.00 |
| **Sub-total outflows** | **-$94.12** |
| **Gross margin** | **$5.88 (≈ 5.9%)** |

**At 10K views, the unit economics are basically breakeven.** This is why the free tier (§5) is capped at 10K views/month, and why we want customers to either grow past this threshold or pay a per-campaign minimum (also §5).

### 1.5 The viral post — where it gets dangerous

| Line | Amount |
|---|---|
| Views delivered (viral, 7-day run) | **5,000,000** |
| Customer is charged | 5,000,000 × $0.01 = **$50,000.00** |
| Creator commission (50%, by contract) | -$25,000.00 |
| Gemini inference (still ≈$0.62 — does not scale) | -$0.62 |
| Per-campaign GCP allocation | -$50.00 |
| Payment processing | -$1,500.00 |
| Compliance + DLP overhead | -$30.00 |
| CS reserve (uplift for viral disputes) | -$1,000.00 |
| **Sub-total outflows** | **-$27,580.62** |
| **Gross margin** | **$22,419.38 (≈ 45%)** |

**At 5M views, margins improve** because the fixed Gemini + GCP allocation stays flat while revenue scales. **But this is also where the customer dispute risk peaks** — see §6.4 on viral-cap disputes.

---

## 2. Comparison to existing models (and why per-view is novel + risky)

### 2.1 Per-seat ($99-499/month SaaS)

**Examples**: Klear ($249-$999/mo), Aspire ($1000-3000/mo), Modash ($199-$799/mo), CreatorIQ (enterprise quotes start $30K/year).

**How it works**: Customer pays a monthly subscription for access to the platform's database, outreach tools, and analytics. Pricing tied to the number of marketer seats.

**Pros**: Predictable MRR. Easy to model SaaS metrics (LTV, CAC, churn, NRR). Customer can run unlimited campaigns within their seat allotment.

**Cons**: **Value is divorced from outcome.** A customer who runs zero campaigns pays the same as a customer who runs 100. CFOs increasingly question "what did this seat actually produce?"

**Where per-seat wins**: When the customer's use case is **research and discovery** (browse the influencer database, build internal media plans). The platform is a tool; tools are billed by access.

### 2.2 Per-creator-slot ($20-50/month per active creator)

**Examples**: GRIN ($20/creator/mo on its lower tier), Influence.co ($50/creator), tribe-style marketplaces.

**How it works**: Customer pays per active creator relationship managed by the platform. Inactive relationships are not billed.

**Pros**: Value is tied to **scope of work** (number of creators); fairer than per-seat. Tracks linearly with customer growth.

**Cons**: Still doesn't tie to **outcome**. A creator who posts and gets zero views costs the same as one who delivers 1M views. Encourages customer to keep wide rosters that may not be productive.

**Where per-creator wins**: When the customer's business model is **always-on creator partnerships** (e.g. an ecommerce brand with 30 long-term ambassadors). The platform is a CRM; CRMs are billed by record.

### 2.3 Per-successful-delivery ($50-200 per post)

**Examples**: Older agency models, some flat-fee marketplaces (Insense, Trend.io ~$100-300/post).

**How it works**: Customer pays a fixed fee per delivered post that meets a baseline of quality (post went live, hashtag included, brand mentioned).

**Pros**: Value is tied to **work product**. Customer only pays when they get a deliverable.

**Cons**: A "successful delivery" is **post existence**, not **post performance**. A post that goes live and gets 500 views costs the same as one that gets 5M. Customer's outcome (views, sales) is still untied.

**Where per-delivery wins**: When **the post itself is the deliverable** (e.g. UGC for ad-creative re-use, where the brand will run the asset as paid media anyway).

### 2.4 Per-view ($0.01) — what's novel + risky

**How it works**: Customer pays only for delivered views. No views, no charge. 100K views → $1,000. 5M views → $50,000.

**What's novel**:
1. **Value-outcome alignment is total**. The customer's question "did this work?" is answered by "you paid $X for Y views; you got the views you paid for."
2. **The platform's incentive is identical to the customer's**: maximize views delivered. There's no "we billed you for the seat, you didn't use it" mode.
3. **Creator selection becomes a pricing function**: the platform's job is to find creators whose **expected views per dollar of commission** is highest. This is a tractable ML problem (BigQuery ML CPM forecasting, per the GCP stack in D-decisions §5).
4. **Customers can size their spend exactly**: a $5,000 budget guarantees ~500K views, full stop. No "how many seats do I need?" discovery.

**What's risky** (preview of §6):
1. **View fraud**: customers (or their competitors) can attempt to inflate or deflate view counts. We need verifiable counting (§3).
2. **Viral over-deliver**: a $1,000 contract that delivers 5M views (= $50K invoice) is great margin but disputable when the customer didn't budget for it.
3. **Under-claim**: customers may try to track views off-platform to argue our count is wrong.
4. **Counting latency**: TikTok's own view counters can be hours-to-days behind. When do we "freeze" the count for billing?
5. **The platform pays creators in advance of customer payment**, on most contract structures. A customer dispute creates a cashflow hole.

**Industry parallels**:
- **Programmatic advertising** has been per-impression since the early 2000s; the entire DSP/SSP ecosystem is built on this. Per-view influencer pricing is a **port of programmatic norms to the creator economy**.
- **YouTube TrueView** was per-completed-view (≥30s of an ad). Same concept, mature billing pipeline.
- **What's new** is applying it to organic, creator-delivered, non-paid posts.

---

## 3. Verifiable view counting

The whole model collapses if we cannot **count views in a way both we and the customer trust**. This section is the canonical view-of-truth.

### 3.1 View source of truth

**Primary**: **TikTok's public view counter** on the post, scraped via the existing v1 + v2 ingestion path (RapidAPI per D14, with the option to migrate to TikTok Research API post-launch).

**Secondary cross-checks**:
1. **TikTok Display API** for verified business accounts (where the brand has connected their TikTok account, we can pull authoritative metrics from the brand side).
2. **Content-verify agent** (D23 #7, Gemini 3.5 Flash multimodal): snapshots the post page hourly during the first 7 days, OCRs the visible view count on the post's UI, and writes the snapshot to BigQuery with the screenshot hash for evidence.
3. **TikTok's Spark Ads dashboard** when the brand has whitelisted the post for paid amplification (this gives an authoritative TikTok-side view count that is harder to dispute).

**The reconciliation rule**: at billing time, we use the **maximum value seen across all three sources during the 7-day window**, then **freeze that count** at T+7 days. If sources disagree by more than 5%, we flag for manual review and bill the **median**.

### 3.2 Fraud resistance

The fraud surface has three distinct attackers and three distinct mitigations:

**Attacker A: Customer inflates views (to make their campaign look successful internally)**

This is not actually our problem — they pay more if views are higher. But it can poison the platform's reputation if competitors notice. Mitigation:
- View counts must originate from TikTok's own UI, not the customer's claim.
- We never accept "customer-reported views" as billable.

**Attacker B: Customer deflates views (to underpay)**

The customer says "your count is wrong, I checked TikTok and it's only 80K, not 100K." Mitigations:
- The hourly snapshots in BigQuery (with screenshot hashes) provide audit-grade evidence.
- The customer's terms of service bind them to **our source-of-truth** (TikTok public counter at T+7d snapshot).
- Disputes go through the AP2 dispute flow with the screenshot ledger attached as evidence.

**Attacker C: Third-party bot-view attack** (a competitor floods the post with bot views to drain the customer's budget, or a malicious customer floods their own post to extract a refund-by-dispute)

This is the **hardest attack**. Mitigations:
1. **TikTok's own bot-detection** flags spammy view sources and removes them from the public counter; we benefit downstream.
2. **Velocity caps**: if views climb at a rate >10× the creator's 30-day average within a 1-hour window, we flag the campaign for manual review and *do not* bill the spike until reviewed.
3. **Geographic distribution check**: if 90%+ of views suddenly originate from a single country that is not the campaign's target geography (per the brand brief), we flag for review.
4. **Engagement-ratio check**: real views correlate with likes/comments at a known ratio (~5-10% engagement rate for organic TikTok). Views without engagement are flagged as suspicious. The vetting + content-verify agents already track these signals.
5. **Per-IP velocity caps** on any platform-facing endpoint that could be a refund-bait vector.

### 3.3 Reconciliation cadence

- **Real-time**: every hour during the first 48 hours after post goes live, the content-verify agent snapshots the view count and writes a Pub/Sub event.
- **Daily**: end-of-day rollup into BigQuery; running total available in the Mission Control dashboard for both customer and operator.
- **At T+7 days**: the count is **frozen** for billing. This is the "billable view count" for that post.
- **T+30 days**: a final reconciliation snapshot is taken for analytics (not for billing) to track long-tail view accrual; surfaced to the customer in the campaign report.

**Why T+7 days**: TikTok's view counter accrues most aggressively in the first 72 hours, with a long tail through day 7. After day 7, accrual is typically <5% of the 7-day total. Freezing at T+7 captures ~95% of the post's lifetime views for a normal post and gives both parties a clear billing event. Customers who want longer accrual periods can opt into a "30-day window" SKU at the Enterprise tier (§5).

---

## 4. Billing pipeline (Pub/Sub → BigQuery → Apigee → invoice)

Per the GCP stack in DECISIONS.md §5 ("Apigee X (API monetization for $0.01/view billing)"), the pipeline is:

### 4.1 Event flow

```
TikTok post goes live  (workflow event: post.published)
       ↓
Content-verify agent (D23 #7) hourly snapshot
       ↓
Pub/Sub topic: view-counter-snapshot
       │  payload: {tenant_id, campaign_id, post_id, view_count, snapshot_ts, screenshot_hash, source}
       ↓
BigQuery table: v2_view_snapshots (partitioned by date, clustered by tenant_id)
       ↓
[T+7d] BigQuery scheduled query computes the billable_view_count:
       │  SELECT MAX(view_count) FROM v2_view_snapshots
       │  WHERE post_id = X AND snapshot_ts BETWEEN T0 AND T0+7d
       ↓
Pub/Sub topic: campaign-billable-event
       │  payload: {tenant_id, campaign_id, post_id, billable_views, billable_amount_usd, period}
       ↓
Apigee Monetization product: per-view-impression
       │  rate_plan: $0.01/view (or tiered per §5)
       │  generates a billing line item against the customer's API product subscription
       ↓
Apigee → Stripe / Toss invoice generation
       ↓
Customer paid (Stripe/Toss webhook → Pub/Sub topic: payment-received)
       ↓
AP2 Intent Mandate to release creator payout (D27 — human approves)
       ↓
Creator paid via Stripe Connect / Wise / domestic KRW transfer
```

### 4.2 Latency: view counted at T → billed at T+?

| Phase | Latency target | What happens |
|---|---|---|
| Post goes live → first view snapshot | **≤ 1 hour** | Content-verify agent's hourly cadence picks it up. |
| Snapshot → BigQuery row | **≤ 5 minutes** | Pub/Sub + Dataflow streaming insert. |
| T+7d freeze → billable event | **≤ 1 hour** after T+7d boundary | Scheduled BigQuery query runs at T+7d + 1h. |
| Billable event → Apigee line item | **≤ 5 minutes** | Pub/Sub triggers Apigee monetization API call. |
| Apigee line item → Stripe/Toss invoice generated | **≤ 1 hour** | Apigee batches end-of-day. |
| Invoice issued → customer auto-charge (if on Growth or Enterprise plan with stored payment method) | **≤ 24 hours** | Stripe / Toss handles. |
| Customer paid → creator payout released (AP2 Intent Mandate cleared) | **≤ 7 days** after customer payment | Human approval gate per D27; payouts batch weekly. |

**End-to-end**: from "first view counted at T" to "money in the platform's bank account" is roughly **T + 7 days + 48 hours**. From there to creator payout is **another ≤ 7 days**.

This is **faster than traditional influencer marketing** (where agency invoicing cycles are 30-60 days and creator payouts can be 60-90 days). It is also **slower than programmatic ads** (where DSPs charge in real-time). The 7-day delay is intentional — it matches the natural view-accrual window and prevents customer disputes during the volatile first-72-hour viral period.

### 4.3 Apigee monetization product specifics

Per [Apigee X Monetization](https://cloud.google.com/apigee/docs/monetization), we configure:

- **API product**: `social-seeding-v2-per-view`
- **Rate plan**: **standard rate plan** with **per-unit pricing** at $0.01/view (mapped to the tier rates in §5).
- **Aggregation**: per-tenant, per-billing-period (monthly).
- **Notification rules**: at 50%, 75%, 90%, 100% of any pre-paid commit (Growth and Enterprise tiers), Apigee fires Pub/Sub events the platform consumes to up-sell or warn.
- **Tax handling**: Apigee passes the line items through to Stripe/Toss; tax calculation is done by Stripe Tax / Toss's KR VAT module (10% VAT for KR customers).

### 4.4 Multi-currency

Per D34 (4-locale i18n), customers can be billed in **USD, KRW, JPY, or CNY**. FX strategy:
- **USD is the canonical currency** on the platform side (P&L, creator payouts where cross-border).
- **Local-currency invoicing** uses FX rates locked at the moment the billable event fires (T+7d). The platform absorbs FX risk between event-fire and customer-payment (typically 24-72 hours).
- For volatile pairs (KRW especially), we add a 1.5% FX buffer to the local-currency rate at invoice time. This is disclosed to customers upfront.

---

## 5. Tier structure (despite the headline simplicity)

The headline "$0.01/view, pay what you use" is the marketing line. The reality is a four-tier ladder that captures different customer segments without ever leaving the per-view paradigm.

### 5.1 Free tier — "first 10K views/month, free"

- **Inclusion**: 10,000 delivered views per calendar month, across one campaign at a time.
- **Restrictions**: one active creator partnership, no Veo/Imagen content generation, basic analytics only, watermark "Powered by social-seeding-v2" on the campaign report.
- **Cost to us** (from §1.4 worked example): a 10K campaign costs us ~$94 to deliver. We absorb this as customer acquisition cost (CAC) on the funnel.
- **Conversion target**: 15% of free-tier users upgrade within 60 days (industry benchmark for PLG SaaS conversion is 2-5%; we expect higher because the value moment — a delivered post — is unambiguous).
- **Purpose**: demonstrate end-to-end value with zero cash commitment. Critical for **JTBD** (§8) — let the customer hire the platform once for free, see the outcome, then commit.

### 5.2 Starter — pay-as-you-go $0.01/view

- **Pricing**: $0.01 per delivered view, no monthly minimum.
- **Restrictions**: max 3 concurrent campaigns. No SLA. Support via shared Slack channel + community forum. Standard view-counting window (T+7d).
- **Target customer**: solo founders, micro-brands, agencies testing the platform on a single client.
- **Expected ARPU**: $200-$1,500/month (1-3 campaigns of 20-150K views each).
- **Margin at this tier**: ~25-30% (the §1.2 worked-example margin).

### 5.3 Growth — $500/mo commit + $0.008/view (20% discount)

- **Pricing**: $500/month committed spend (pre-paid; rolls over up to 2 months); usage billed at **$0.008/view** against the commit; overage at $0.008/view (no penalty rate).
- **Inclusions**: unlimited concurrent campaigns, dedicated CSM (1 per ~$50K MRR — see §10), priority Gemini 3.1 Pro routing for the analyst agent, branded campaign reports, 30-day view-window option, API access (Apigee).
- **Target customer**: scaling DTC brands, mid-market agencies, in-house brand teams.
- **Expected ARPU**: $1,500-$5,000/month.
- **Margin at this tier**: ~18-22% (lower than Starter because of the 20% discount on rate AND the dedicated CSM, but offset by predictable MRR and higher LTV).
- **Trigger to upgrade from Starter**: when a Starter customer's 3-month average spend exceeds $400, the platform auto-suggests Growth (the math: $400 × 12 = $4,800/year on Starter at $0.01, vs. $500 × 12 + 95% utilization at $0.008 ≈ $5,700 budgeted but with discount + CSM value; we sell the upgrade as "you're already on track to spend the commit, lock in the lower rate").

### 5.4 Enterprise — custom commit + $0.006/view (40% discount)

- **Pricing**: minimum $10,000/month committed (pre-paid quarterly or annually); rate $0.006/view; volume bands negotiable below $0.006 for >5M views/month.
- **Inclusions**: dedicated AM + CSM, custom view-window (up to 60 days), SLA (99.99% per D31), Spanner-multi-region dedicated tenant resource pool (per D13), AP2 Cart/Payment Mandate access (post-D27 expansion), white-label option, custom compliance reporting (PIPA + future SOC2/GDPR per D22), priority access to new model versions (Gemini 3.1 Pro Preview, Veo 3, etc.).
- **Target customer**: large CPG brands, holding-company agency networks, government-backed Korean export-promotion programs.
- **Expected ARPU**: $10,000-$100,000+/month.
- **Margin at this tier**: ~15-18% gross (volume compresses margin, but absolute dollar profit per account is high enough to justify the sales motion).
- **Sales motion**: outbound + RFP-driven. Closes are slow (3-6 months) but sticky (NRR > 110%).

### 5.5 Why this tier shape

- **Kim/Mauborgne lens (blue ocean)**: by anchoring all four tiers on the same per-view unit, we **eliminate** the cognitive load of "which plan should I pick?" that kills SaaS funnels. Free → Starter → Growth → Enterprise is **one ladder, one unit, one currency of value (the view)**.
- **Drucker lens (management)**: tier transitions are **observable in the data** (3-month rolling average spend), which means the platform can trigger CSM outreach automatically. The CSM org is not guessing who to call.
- **Christensen lens (JTBD)**: each tier serves the same JTBD ("deliver guaranteed views per dollar") at a different scale of commitment. The customer never has to re-frame what they're buying when they move up.
- **Taleb lens (antifragile)**: the tier mix gives us **revenue diversification**. A single Enterprise loss is recoverable through Starter + Growth volume; a Starter/Growth crash during a recession is partially absorbed by Enterprise commits. The free tier is **optionality** — it costs us ~$94/free customer/month but each conversion is worth $1,500-5,000 ARR.

---

## 6. Risk register (Taleb)

The antifragile lens: what kills the model, and what makes it stronger under stress?

### 6.1 Customer over-claims views (fraud)

**Risk**: customer or third party inflates view counts to make a campaign look better internally. Not directly our P&L risk (we get paid more), but a **reputation risk** that, at scale, makes our delivered-view number untrustworthy.

**Mitigation**: §3.2 Attacker A controls. The bigger move: **publish a monthly "delivered views audit"** — aggregate views across all platform campaigns, cross-referenced with TikTok's reported platform-wide view distribution. If our numbers diverge >10% from TikTok's own statistical baseline, we investigate.

**Antifragile angle**: every dispute we win adds a precedent to our evidence ledger. The dispute frequency *decreases* as the precedent base grows, because customers learn the platform's counts hold up.

### 6.2 Customer under-claims (off-platform tracking)

**Risk**: customer says "your count says 100K, but I tracked it externally with a Bitly link and only saw 70K clicks." This conflates **views** with **clicks/conversions** — different metrics — but the customer doesn't always know that.

**Mitigation**:
- The contract explicitly defines "view" as **TikTok's public view counter at T+7d**.
- Customer education: campaign reports include a clear glossary (views ≠ clicks ≠ conversions).
- For customers who want click/conversion attribution, we offer **TikTok Pixel + UTM integration** as an add-on (Growth and Enterprise tiers) but that's a separate, **non-billable analytics metric**.

**Antifragile angle**: the more sophisticated customers get about the difference, the harder it is for less-sophisticated competitors to muddy the water with vague metrics. We benefit from market education.

### 6.3 Currency volatility (KRW vs USD billing)

**Risk**: KRW depreciates 10% vs USD over a 3-month window. Korean customers' invoices spike in KRW terms while creator payouts (often USD) become more expensive.

**Mitigation**:
- **FX buffer**: 1.5% added to all local-currency invoices (§4.4).
- **Quarterly FX hedging** via Wise Business or a Korean-bank forward contract for predictable creator payout volume (above $50K/quarter).
- **Per-tenant currency election**: customer can opt to be invoiced in USD even from KR, removing their FX risk (and ours, on the customer side).

**Antifragile angle**: during volatility, customers prefer **predictable per-view pricing in their home currency** over agency contracts denominated in USD. We can gain market share from agencies during FX crises.

### 6.4 Viral video dramatically exceeds budget — customer dispute

**Risk**: customer signs up for a Starter campaign expecting 100K views ($1,000). Post goes viral and delivers 5M views ($50,000 invoice). Customer disputes the charge: "I never agreed to $50K."

**Mitigation**:
- **Hard budget cap** on every campaign at the customer's election. Default is **2× expected** (so a 100K-projection campaign caps at 200K billable views, $2,000). Customer can raise the cap before the campaign launches.
- **Velocity-trigger pause**: if a campaign hits 80% of its cap in <24 hours, the platform pauses the auto-charge pipeline and surfaces a "do you want to raise the cap?" prompt via AP2 Intent Mandate (D27). Customer either approves the extension (and pays) or accepts the cap (and we stop billing for additional views, even though they keep accruing).
- **Cap above 5M views requires a written contract amendment** (Enterprise-tier or contract-side gate).

**Antifragile angle**: the cap mechanic actually **builds customer trust**. The pitch becomes: "with us, you cannot get a surprise $50K bill. We pause and ask first." Agencies cannot offer this.

**The interesting tension**: the platform makes most of its margin on viral over-delivery (per §1.5), so the cap mechanic **deliberately leaves money on the table** in exchange for trust. This is a Drucker-style "the purpose of a business is to create a customer" — the cap loses short-term revenue to preserve long-term customer retention.

### 6.5 TikTok changes the public view counter format or rate-limits scraping

**Risk**: TikTok changes their API or adds anti-bot defenses. The platform's view-counting source breaks. Customer disputes spike during the outage.

**Mitigation**:
- **Multi-source redundancy** per §3.1 (RapidAPI + Display API + Spark Ads dashboard + content-verify visual scrape).
- **Contractual force-majeure clause** for "platform-side data outages."
- **Cached views** during outages: bill on the last-known snapshot until reconciliation is possible.
- **Annual capacity test**: at least once a year, the platform team runs a war-game where the primary view source is taken offline and the platform must continue to bill correctly using only fallback sources.

**Antifragile angle**: each TikTok disruption is a test that makes our multi-source architecture stronger. Competitors using a single source break harder.

### 6.6 Creator demands payment before customer pays (cashflow risk)

**Risk**: creator sees their post is performing, demands payout immediately. Customer's invoice is not yet due. Platform fronts the cash; customer disputes later. Platform absorbs the loss.

**Mitigation**:
- **Standard contract**: creator paid at T+14d, customer invoiced at T+7d, customer pays in 30d. Net cash position: positive (customer pays before creator).
- **Negotiated exceptions** (top creators demand T+7d payout): platform fronts a max of $5K per creator-week, hedged against the customer's prepaid commit balance (Growth and Enterprise only).

**Antifragile angle**: a strong cash position lets the platform offer **fast creator payouts** as a competitive advantage during recessions when agencies are stretched and creators value reliability over rate.

### 6.7 Regulatory: per-view pricing reclassified as a securities-like instrument

**Risk** (low probability, high impact): a regulator (KCC, FTC, or EU equivalent) deems per-view contracts to be "performance-linked financial instruments" requiring additional disclosure / licensing.

**Mitigation**:
- **Legal review** of the per-view contract template before go-live in each jurisdiction.
- **Disclaimers** that the platform is a marketing service, not a financial product.
- **Fallback model**: per-successful-delivery (§2.3) as a regulatory-safe alternative we can pivot to in <30 days if needed.

**Antifragile angle**: having a documented fallback model gives the business optionality. We can present per-view as our default *and* a per-delivery option as a regulator-friendly alternative without contradicting our brand.

---

## 7. Blue ocean angle (Kim/Mauborgne)

The **strategy canvas** for influencer marketing pricing today has four competing factors that buyers evaluate:

1. **Predictability of cost** (how surprising is the invoice?)
2. **Tie to outcome** (does what I pay reflect what I got?)
3. **Speed of decision** (how long to get to "yes, let's run a campaign"?)
4. **Trust in the count** (do I believe the numbers on the report?)

Existing models trade off across these:

| Model | Predictability | Outcome tie | Speed | Trust |
|---|---|---|---|---|
| Per-seat SaaS | High (fixed monthly) | **None** | Fast | High (own data) |
| Per-creator slot | Medium | Weak | Fast | Medium |
| Per-delivery | Medium | Weak (post exists ≠ post worked) | Slow (contract negotiation) | Medium |
| Agency flat-fee | Low (custom quotes, change orders) | None | Slow | Low (agency self-reports) |
| **Per-view (us)** | **Medium** (cap + tier mitigate) | **Total** | **Fast** (price is published) | **High** (verifiable counter + multi-source) |

**Where per-view creates a blue ocean**: by **eliminating** the disconnect between price and outcome (the dominant pain point in the industry's customer surveys for the last decade), and by **raising** trust (verifiable counting infrastructure), we create a market position no agency or seat-based SaaS can imitate without rebuilding their entire infrastructure.

**ERRC framework** (Eliminate-Reduce-Raise-Create):

- **Eliminate**: seat fees, creator-slot fees, monthly subscription floors below the free tier, opaque rate cards.
- **Reduce**: contract negotiation cycle (price is public, terms are templated), CSM overhead (Drucker §9 — the platform's data triggers CSM action, not the other way around).
- **Raise**: view-counting transparency (real-time dashboards), creator-payout speed (T+14d default), buyer's confidence interval on campaign outcome.
- **Create**: **a marketplace currency (the view)** that aligns brand, platform, and creator on the same metric. This is the actual blue ocean: a **denominator everyone agrees on**.

**The strategic insight**: per-view pricing isn't just a billing scheme. It is a **shared language** between brand, platform, and creator. When everyone is measuring the same thing in the same way, **trust scales as a network effect**.

---

## 8. JTBD framing (Christensen)

**The customer is not hiring us to "manage influencer relationships."** That's what an agency does, and the customer would have hired an agency.

**The customer is hiring us to "deliver guaranteed views per dollar."**

This is a sharper JTBD because:

1. **It's measurable**. The customer can verify the outcome immediately.
2. **It's substitutable across alternatives** — the customer can compare $0.01/view from us against $0.012/view from TikTok Ads, $0.03/view from a managed agency, or $0.005/view from a creator they DM directly. We are competing on a single unit.
3. **It implies what we don't do**. We don't help them write the brief (well, the `intake` agent does, but the customer doesn't hire us for that). We don't pick their brand strategy. We don't run their owned social accounts. **We deliver views.**

**The functional, social, and emotional dimensions of the JTBD** (per Christensen's JTBD taxonomy):

- **Functional**: "I need 500K TikTok views for my product launch in 6 weeks, on budget X."
- **Social**: "I need to show my CMO/board that I am spending marketing dollars efficiently and can prove the outcome."
- **Emotional**: "I want to stop worrying about whether the influencer agency is screwing me on rates I can't audit."

The **emotional dimension is the most under-served by competitors** and the most defensible for us. Per-view pricing + verifiable counting + capped invoices is, fundamentally, **a worry-reduction product** as much as a marketing product.

**Christensen's "sustaining vs disruptive" test**:

- **Sustaining innovation** would be: a better seat-based SaaS UI, a faster creator database search.
- **Disruptive innovation** is: a completely different unit of value (the view) that established players (Klear, Aspire, CreatorIQ) **cannot adopt without cannibalizing their existing revenue**. They're stuck.
- **Where the disruption starts**: with the customers most under-served by per-seat pricing — small brands and agencies who can't justify a $999/mo Klear seat but can afford $50 of test views on us.
- **Where it climbs**: as our platform learns to deliver more views per creator dollar (BigQuery ML CPM forecasting per the GCP stack), our margin improves and we can offer Enterprise tiers competitive with high-end agencies on price *plus* the verifiable-count + tooling advantages. The Christensen-classic upward-march into incumbent territory.

---

## 9. Management framing (Drucker)

**"What is our business? What should it be?"**

Our business is **the agent-operated delivery of guaranteed influencer views**, billed by the unit. Not influencer-CRM, not creator-database, not marketing-agency. The operations org is shaped by this answer.

### 9.1 What the operations org looks like

**Customer Success (CS) — 1 CSM per $50K MRR**

- A CSM handles 10-25 Growth-tier customers ($1,500-5,000 MRR each → ~$40-50K MRR), or 1-3 Enterprise customers ($10K+ MRR each).
- CSM **does not** chase customers to use seats. The platform's data tells them what to do:
  - Spend trending down → outreach to understand churn risk
  - Spend trending up + hitting commit ceiling → tier upgrade conversation
  - High dispute rate → product feedback loop
  - Viral campaign in progress → check in on cap status
- This is **Drucker's management-by-exception** in agent form. The `customer_success` agent (D23 #16) does the first-pass detection; the human CSM handles the conversation.

**Sales — only for Enterprise tier**

- Starter and Growth are **self-serve** (PLG funnel). No human sales involvement.
- Enterprise (≥$10K commits) requires a 3-6 month outbound sales cycle. 1 AE per ~$500K ARR pipeline.
- **No SDRs**. The free tier is the SDR. Customers who upgrade themselves through Free → Starter → Growth → Enterprise are the qualified pipeline.

**Operations / Trust & Safety — 1 ops per ~1,000 active campaigns**

- Handles dispute investigation, fraud-flag review (§6), creator-vetting escalation.
- Heavily supported by the watchdog agents (D23 W1/W2/W3) — humans review flags, not raw data.

**Engineering & Product — the actual scale lever**

- Per-view pricing forces the platform to **measure itself in the customer's currency**. Engineering's KPIs are: cost-per-delivered-view (decreasing), Gemini-spend-per-view (decreasing), Spanner-cost-per-view (decreasing), and views-delivered-per-tenant (increasing).
- This **aligns engineering work directly with margin expansion**. A 10% improvement in CPM-forecast accuracy from the BigQuery ML model directly improves §1.2's gross margin by ~3-5 percentage points.

### 9.2 Auto-tier upgrade triggers (the operational data flow)

| Trigger | Action | Owner |
|---|---|---|
| Free-tier user delivers >8K views in a month for 2 consecutive months | Email + in-app prompt: "You're about to hit your free cap. Starter pay-as-you-go is $0.01/view; no commit required." | Marketing automation |
| Starter user 3-month rolling spend > $400 | CSM email: "You'd save 20% on Growth. Want a 15-min walkthrough?" | CSM agent + human follow-up |
| Growth user 3-month rolling spend > $7,000 | AE outreach: "You're over-spending your commit. Let's talk about Enterprise rates." | AE |
| Enterprise commit-utilization < 60% for 2 quarters | CSM check-in: "Want to right-size your commit?" (small risk of revenue loss but builds long-term trust per Drucker) | CSM |

### 9.3 "Who is the customer? What does the customer value?"

- **Customer**: marketing leaders (CMO, head of growth, brand manager) at DTC, mid-market CPG, and digital-native agencies. Korean export-promotion programs in the medium-term.
- **What they value**: **predictability + auditability** of marketing spend, in a market where neither is the norm.
- **What they don't value (and where we must resist gold-plating)**: deeper CRM features, social-listening dashboards, account-based-marketing integrations. These are what competitors sell to up-sell seats. We sell views.

### 9.4 The biggest assumption to test

**"Customers will pay $0.01/view to a SaaS platform when they could pay $0.005-0.012/view directly to TikTok Ads or a creator."**

The bet is that the **agent-stack value** (sourcing fit, outreach success rate, compliance, verifiable count) is worth a ~2× markup over the floor. This must be **re-tested every quarter** with cohort analysis: if cohort-N customers churn back to direct TikTok Ads at >15% annual rate, the value-prop is broken and the model needs renegotiation.

---

## 10. Devpost Business 30% case — 2-paragraph framing for judges

> **The business model is per-view, not per-seat**: customers are charged **$0.01 for every delivered TikTok view** (effective CPM of $10, sitting at the floor of the creator-direct mid-tier band and at parity with TikTok's own auction in-feed price). The pricing is novel in the influencer-marketing category, which is overwhelmingly dominated by per-seat SaaS ($99-999/mo) or per-creator-slot ($20-50/creator) models that disconnect price from outcome. The unit economics work because the agent stack (16 domain agents on Gemini 3.5 Flash and 3.1 Flash-Lite, coordinated by 3 meta agents and 3 watchdog agents on Vertex AI Agent Runtime per D23-D25) replaces 70-80% of the labor an agency would charge another $20-40 CPM for. A worked 100K-view campaign generates $1,000 of revenue against ~$711 of variable cost (50% creator commission, ~$0.62 of Gemini inference, GCP infrastructure amortization, payment processing, compliance, and CS reserve), yielding ~29% gross margin at the headline price. The tier ladder (Free 10K views/mo → Starter $0.01 PAYG → Growth $500/mo commit at $0.008 → Enterprise custom commit at $0.006) preserves the unit consistency while capturing customers from solo founders to large CPG brands.

> **The model is judged on three dimensions that competitors cannot match**: (1) **outcome alignment** — the customer pays for views, not for access; if zero views, the platform earns zero (we eat the inference cost), which means every dollar of revenue is correlated with a dollar of customer value; (2) **verifiable counting** — view counts are reconciled across TikTok's public counter, the TikTok Display API, and an hourly content-verify agent that snapshots the post UI with hash-verified evidence stored in BigQuery, then frozen for billing at T+7 days, with disputes resolved against the audit ledger via AP2 Intent Mandate per D27; (3) **antifragile risk management** — a per-campaign budget cap (default 2× expected views) prevents viral over-billing surprises, multi-source view-counting survives any single-vendor outage, and the per-view contract structure is portable to a per-delivery fallback model in <30 days if regulators reclassify the instrument. The billing pipeline runs entirely on GCP-native infrastructure (Pub/Sub events from the content-verify agent → BigQuery scheduled queries at T+7d → Apigee X monetization product → Stripe/Toss invoicing → Apigee → AP2 Intent Mandate → creator payout via Stripe Connect), with end-to-end latency of ~T+8 days from first view counted to platform revenue recognized. This pricing structure is the operational expression of D28 and the financial corollary of D12's multi-tenant SaaS + AP2 agent-pays-agent architecture: agents do the work, the customer pays for the result, and the platform's gross margin scales with how well the agent stack can compress creator commission cost over time.

---

## 11. New open questions surfaced by this model

These join O8 (closed by this doc) and inherit into the DECISIONS.md outstanding list:

| ID | Question | Owner | Trigger |
|---|---|---|---|
| O13 | Default view-cap policy: 2× expected, or customer-elects per campaign with 2× as the suggestion? | Product | Before billing pipeline ships |
| O14 | Creator-payout terms: T+14d default vs T+7d for top-tier creators — what defines "top tier" (follower count? past performance?)? | Operations + Legal | Before first Enterprise campaign |
| O15 | FX hedging vendor: Wise Business vs Korean bank forward vs Stripe FX? | Finance | At >$50K/quarter cross-border creator payout |
| O16 | Free-tier abuse defense: how do we prevent a customer creating 100 free accounts to consume 1M views? | Security + Product | Before public free-tier launch |
| O17 | Dispute SLA: what's the customer-side response time we commit to (24h? 72h? 7d?) before AP2 Intent Mandate auto-clears? | Operations + Legal | Before T&Cs go live |
| O18 | Annual recurring revenue (ARR) recognition: per-view revenue is consumption-based — how do we recognize it on a GAAP basis (rev rec at T+7d snapshot? at customer payment?)? | Finance | Before first audit |

---

## 12. Sources

### CPM benchmarks
- Influencer Marketing Hub, "TikTok Influencer Marketing Pricing Report" (2024-2025 editions): mid-tier flat-fee bands, agency markups.
- Sprout Social, "TikTok Advertising Costs in 2025": auction CPM bands for Spark Ads and TopView.
- Hootsuite, "How Much Do TikTok Ads Cost?" (2025 update): in-feed auction floor pricing.
- Aspire (formerly AspireIQ), "Influencer Marketing Benchmark Report 2025": creator-direct flat-fee distributions.
- Open Influence / The Outloud Group rate cards (public RFP responses, 2024-2025).

### Pricing comparables
- Klear pricing tiers: https://klear.com/pricing
- Modash pricing: https://www.modash.io/pricing
- GRIN pricing (per-creator-slot): https://grin.co/pricing
- CreatorIQ enterprise quotes: G2 + Capterra reviews compiling RFP outcomes.
- Insense / Trend.io per-delivery flat-fee bands: published marketplace rate cards.

### Pricing pipeline (Apigee + AP2)
- Apigee X Monetization docs: https://cloud.google.com/apigee/docs/monetization
- BigQuery scheduled queries: https://cloud.google.com/bigquery/docs/scheduling-queries
- AP2 Intent Mandate spec (D27 reference): internal `gcp-research/protocols/AP2.md` (see SERVICE-INVENTORY.md).
- Stripe Connect for creator payouts: https://stripe.com/connect

### Internal references
- `gcp-research/decisions/DECISIONS.md` (D11, D12, D13, D17, D18, D19, D20, D27, D28, D31, D33, D34)
- `gcp-research/cost-planning/COST-PLAN.md` (§2 per-campaign cost breakdown, §1.1 Gemini pricing)
- `gcp-research/decisions/SERVICE-INVENTORY.md` (GCP service stack — referenced for Apigee, BigQuery, Pub/Sub configurations)
