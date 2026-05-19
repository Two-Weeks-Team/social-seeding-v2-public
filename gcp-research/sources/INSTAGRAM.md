# INSTAGRAM.md — Instagram Creator Email Sourcing Feasibility Study

**Status**: Background-agent #2 deliverable for Task #21 (per D14, O3 in `decisions/DECISIONS.md`)
**Date**: 2026-05-19
**Audience**: M3 PM agent + sourcing-agent author + compliance-agent author + the human operator who has to sign off on the data path before any Instagram outreach ships.

---

## 0. TL;DR — Verdict: **Conditional / Feasible-with-Constraints**

Instagram creator-email sourcing for the v2 outreach loop is **technically feasible** and **legally defensible** in 2026, but only under a specific stack of constraints:

1. **Field to target**: the **`business_email`** attribute that Instagram **Business** and **Creator** accounts (collectively "Professional accounts") choose to expose on their public profile via the "Email" contact button. This is the **only** Instagram-native email surface that is publicly visible without authentication. Personal-account emails are not available through any public path and must not be pursued.
2. **Technical path**: **NOT** the official Instagram Graph API `business_discovery` endpoint (it does **not** return any email field — see §2). Use **third-party RapidAPI / Apify scrapers** that proxy Instagram's internal `web_profile_info` GraphQL endpoint, plus **bio-link follow-through** for Linktree / Beacons / Bio.link pages where the email is one indirection away.
3. **Legal path**: stand on **Meta v. Bright Data (N.D. Cal., Jan 2024)** for the right to collect **public, logged-off** profile data; stand on **PIPC's July 2024 Guideline on Processing Publicly Available Personal Information** for the "legitimate-interest" basis in Korea; carry an explicit **opt-out/withdrawal** mechanism in every outreach email (PIPA Articles 17, 22, 39-6); label the email subject with **「(광고)」 / "(Advertisement)"** per K-CAN-SPAM (Information & Communications Network Act, Article 50).
4. **What kills feasibility**: (a) trying to use the official Graph API for emails (it does not expose them); (b) trying to scrape **personal** accounts' bio text for emails without explicit opt-out language (a `business_email` on a Professional profile is operator-chosen self-disclosure for commercial contact; a personal-account bio email is in a grayer zone); (c) skipping the PIPA Art. 22 separate-consent treatment of marketing communications; (d) using the data for any purpose other than the **single, transparent, in-the-moment outreach** the operator brief specifies.

**One-paragraph rationale.** The `business_email` field exists precisely because the account owner chose to make it a clickable email contact button on a public profile — that is the strongest possible "self-published for commercial inquiry" signal short of an explicit opt-in. Meta's own contract claim against scraping this data lost in 2024 (Bright Data ruling), and PIPC's 2024 guideline allows legitimate-interest processing of publicly available personal information when the controller's interest "clearly outweighs" the data subject's rights and reasonable safeguards are in place. The cold-outreach email itself is regulated separately by K-CAN-SPAM — that regulation is satisfied by labeling the subject `(광고)`, providing a working opt-out, and not re-mailing anyone who opts out. The combination is workable if v2's `compliance` agent (D23 tier-1 #13) gates every send.

---

## 1. Background: what counts as a "public Instagram email"

There are five distinct surfaces to disambiguate. Treat them separately because the legal posture, technical access, and reliability differ in each.

| # | Surface | Where it lives | Public? | Field name in scraper APIs | Approx. coverage of active Professional accounts |
|---|---|---|---|---|---|
| 1 | **`business_email`** | "Email" contact button on a Business/Creator profile | Yes (logged-off browser sees it) | `business_email`, `public_email`, `contact_email` | **~65%** [SociaVault, 2026] |
| 2 | **Bio text** with an email | The 150-char biography section | Yes | `biography` → regex parse | **~12%** additional |
| 3 | **Linktree / Beacons / Bio.link** in `external_url` | One-hop external site | Yes | `external_url` → follow → parse | **~8%** additional |
| 4 | **Personal-account bio email** | Bio of a non-Professional account | Yes (text), but legally distinct | `biography` → regex parse | Variable; lower confidence |
| 5 | **Profile-picture business card** | OCR of the avatar | Yes (image), rare | n/a (Vision API extraction) | <1%, mostly K-Pop / influencer styling |

**Cumulative coverage**: **~75-80%** of active Business/Creator accounts have a findable email via surfaces 1+2+3 ([SociaVault 2026 enrichment benchmark](https://sociavault.com/blog/instagram-creator-email-finder-2026)). For our purposes the v2 sourcing-agent should target surfaces 1, 2, and 3 in that priority order, treat surface 4 as opt-in only (because a personal account's bio email is not as clearly self-published-for-commercial-inquiry as a Professional account's `business_email` field), and ignore surface 5 in v1 (low ROI).

**Important nuance** (also clarifies for compliance agent): surfaces 1 + 2 + 3 cover **Professional accounts** — and a Professional account is, by definition, a self-declaration that the holder is using Instagram for business or creator activity. PIPA Art. 15-1(6) ("legitimate interest" basis) and the PIPC's July 2024 guideline both lean considerably more permissive when the data subject has objectively manifested a willingness to receive commercial inquiries — which is what flipping the account to Professional + populating the email button does.

---

## 2. Path B (graph API) up front, because it sets the bound

Result: **the Instagram Graph API does not return creator emails.** This is the most important finding of the study because it eliminates the cleanest legal path.

### 2.1 What `business_discovery` actually returns

Per [Meta's official Business Discovery documentation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery/), the fields exposed for *another* Business or Creator account are:

- `id`
- `username`
- `name`
- `biography`
- `website`
- `followers_count`
- `follows_count`
- `media_count`
- `profile_picture_url`
- `ig_id`
- And the `media{}` edge (post-level metadata)

**There is no `business_email`, `public_email`, or `email_contacts` field on this endpoint.** The `email_contacts` *metric* (a time-series count of clicks on the email button) on the Insights endpoint was **deprecated in API v21 effective 2025-01-08** ([Meta Graph API v21 changelog](https://developers.facebook.com/docs/instagram-platform/changelog/), [Elfsight 2026 guide](https://elfsight.com/blog/instagram-graph-api-complete-developer-guide-for-2026/)) — and even before deprecation it was a count of clicks, not the email value itself.

### 2.2 What `me` (own account) can return

A creator's *own* Graph API account can retrieve `business_email` for their *own* profile through `/me?fields=business_email` — but that requires OAuth login *as the creator*, which is a B2B-platform pattern (Phyllo, Klear, Modash sign creators in to expose their own data to brands), not a sourcing pattern. v2's sourcing loop never has the target creator's auth token; this path is irrelevant for cold sourcing.

### 2.3 App-review feasibility for a Korean entity

Even if the Graph API *did* expose email (it doesn't), the app-review pipeline would be a separate gate:

- Meta requires **business verification** before granting *Advanced Access* to any Instagram permission: business registration document (사업자등록증 in Korea), tax ID (사업자등록번호), proof of business address, business website, authorized-signatory documentation ([360dialog Meta Business Verification guide](https://docs.360dialog.com/docs/resources/meta-business-verification)).
- Review timelines: **2-7 days for approval, 3-5 days per rejection cycle, 2-4 weeks typical** ([Saurabh Dhar Meta app approval guide](https://www.saurabhdhar.com/blog/meta-app-approval-guide)). Rejection rate is high on first submission, especially for permissions that "look like scraping or competitive intelligence." `instagram_content_publish` and `instagram_manage_messages` are notorious; `instagram_business_basic` (the modern replacement for `business_discovery` access) is comparatively easier but still requires a screencast of the legitimate use case.
- **Korean entity specifics**: there is **no documented disadvantage** to being a Korean-registered entity in Meta's app review — Meta processes Korean 사업자등록증 the same as any other national business registration. The 2026-03 financial-advertiser identity verification update ([AuditSocials 2026](https://www.auditsocials.com/blog/meta-identity-verification-financial-advertisers-2026)) doesn't apply to non-financial product categories.

**Bottom line on Path B**: Path B does not solve email sourcing. We will still need a Graph API path for *posting verification* and *insights* (e.g., the v2 `content_verify` agent — D23 tier-1 #7 — confirming a sponsored post went up), and the app-review work for that is real and should start Day 1 (per O7 in the decisions doc). But for **email sourcing specifically**, Path B is a dead end.

---

## 3. Path A: RapidAPI / scraper providers (the primary path)

### 3.1 Provider matrix — top 3 for v2 day-1

The criteria: (a) returns `business_email` reliably, (b) has predictable pricing for 1k-10k profile enrichments/month at MVP scale, (c) survives the platform's anti-bot escalation (residential proxies, working CAPTCHAs, regenerating cookies), and (d) has a paid SLA — i.e. not a one-person side-project on Vultr that will go dark in 90 days.

| Provider | Per-1k cost (USD) | Reliability | `business_email` field? | Throughput | Verdict |
|---|---|---|---|---|---|
| **Apify — `apidojo/instagram-user-scraper`** | **~$10 / 1k profiles** ($0.01/profile) | High (Apify SLA, 99% uptime tier) | **Yes** ("public emails, follower stats, verification status") | ~500 profiles/min | **Recommended for production sourcing path.** Pay-per-result, no monthly commit, first 40 free for testing. |
| **Apify — `figue/instagram-profile-scraper`** | **~$1 / 1k profiles** | Medium (community actor, fewer SLA guarantees) | **Yes** ("50+ fields including business email & phone") | ~500 profiles/min | **Recommended as cost-optimized fallback** for high-volume / lower-stakes batches. Use as second provider for failover. |
| **Modash Discovery API** | **~$16,200 / year (3,000 credits/mo)** → effective $5.40 per credit; profile + email unlock = 2 credits → ~$10.80/profile | Very high (purpose-built influencer-data company, $199-$499/mo platform fits Korean budget) | **Yes** (purpose-built influencer data; email unlock is the core feature) | Real-time API | **Recommended for the high-value vetting tier** — when v2 has already pre-filtered candidates and is willing to pay 10× for verified, normalized creator-economy data. |

Honorable mentions ruled out:

- **RapidAPI `social-api1/instagram-scraper-api2`** — listed at ~$10-15/mo for the basic tier (`Pro` ~50k req/mo); fields include `public_email` per Apify's RapidAPI-Scraper actor mirror, but pricing-page access was 403 during research and the provider's response-SLA on RapidAPI is community-feedback-only, not contractual. Acceptable for **prototyping** only; do not bet production sourcing on it.
- **Phyllo** ([getphyllo.com](https://www.getphyllo.com/influencer-marketing/instagram-api)) — universal social-data API (Instagram + TikTok + YouTube + 17 more), normalized schema, but consultative custom pricing (no posted tier). Best for the Track 2 commercial-grade roadmap, **not** for an agent-challenge MVP.
- **EnsembleData** — $200-1,400/mo (5k-50k units/day); Instagram coverage solid but the `business_email` field is opt-in scrape (not always populated). Skip in favor of Apify/Modash.
- **Bright Data** — won the 2024 Meta lawsuit and has the strongest legal position, but enterprise sales motion and per-record cost is not aligned with $1,500-of-credits demo budget. Revisit at Series A.
- **junioroangel / DavidGelling / metekuscu / thekirtan RapidAPI listings** — unverifiable provenance, no SLA, prone to break weekly when Instagram rotates its GraphQL response schema. Do not use in production.

### 3.2 What `business_email` looks like over the wire

For reference (so the sourcing-agent prompt author and capability-layer author can plan the Zod contract):

```jsonc
// Apify apidojo/instagram-user-scraper response (abbreviated)
{
  "id": "1234567890",
  "username": "creator_handle",
  "full_name": "Creator Name",
  "biography": "DM for collabs | press@creator.kr",
  "external_url": "https://linktr.ee/creator_handle",
  "is_business_account": true,
  "is_professional_account": true,
  "category_name": "Personal Goods & General Merchandise Stores",
  "public_email": "press@creator.kr",        // <-- the field
  "public_phone_country_code": "82",
  "public_phone_number": "1012345678",
  "business_address_json": "{...}",
  "follower_count": 142000,
  "following_count": 1234,
  "media_count": 587,
  "profile_pic_url_hd": "https://...",
  "is_verified": false
}
```

Compliance-agent note: when `public_email` is present **and** `is_business_account === true` **and** `category_name` is non-null, treat the email as **explicitly self-published for commercial inquiry** and proceed to the outreach pipeline. When `public_email` is absent but `biography` contains an email regex match, **downgrade confidence one tier** and route to the human-review queue (D27 AP2-Intent gate makes this cheap operationally).

### 3.3 Cost projection at v2 scale

- MVP / agent-challenge demo: 100 candidates/run × 5 runs/day × 30 days = **15k enrichments/month**. At Apify $10/1k = **$150/mo**, at figue $1/1k = **$15/mo**.
- Production (10 tenants, 1k candidates/tenant/month) = **10k profiles/month** → **$100/mo** Apify, or ~$200/mo if mixing in 20% Modash for the high-value tier.
- The $1,500 GCP credit pool (D39) does not cover these — RapidAPI/Apify are external. Plan to bill these to a separate corporate card and surface them in cost-watch (W2) per-tenant.

### 3.4 Anti-bot resilience: why this is **not** a "scrape it ourselves" path

In 2026 Instagram's defenses are: residential-only IP requirement (datacenter IPs blocked at TCP), TLS/HTTP/2 fingerprint inspection, ML-based behavioral analysis ([Scrapfly 2026 guide](https://scrapfly.io/blog/posts/how-to-scrape-instagram)). ~200 req/hr/IP cap on logged-off endpoints. Building this in-house at v2's scale is a 2-month engineering effort with permanent maintenance burden; outsourcing to Apify/Modash, who run residential proxy pools and rotate fingerprints daily, is dramatically cheaper. This decision aligns with **D14 (RapidAPI-mediated sourcing)** — keep the same pattern that worked for the TikTok side.

---

## 4. Path C: indirect (bio link + OCR + business cards)

When `business_email` is null but `external_url` is populated, follow one hop and parse. Roughly 8% of additional coverage comes from this path. Three implementation notes:

### 4.1 Linktree / Beacons / Bio.link parsing

- **Linktree** is a Next.js app with a `<script id="__NEXT_DATA__">` tag containing the entire page data as JSON ([HarvestMyData 2026](https://harvestmydata.com/blog/how-we-extract-emails-from-linktree)). A scraper can fetch the HTML, grab that script tag, parse JSON, then regex the entire blob for emails. No JavaScript rendering required.
- **Beacons** follows the same pattern but with a different JSON path.
- **Bio.link** and **Stan.store** are similar.
- Existing Apify actor: `ahmed_jasarevic/linktree-beacons-bio-email-scraper-extract-leads` — handles all four platforms with auto-detection, email validation, and following nested links. Pricing follows the standard Apify pay-per-result tier ($0.50/1k pages typical).

### 4.2 OCR fallback via Google Document AI

For the rare cases (≤1%) where the email is rendered as a graphic inside a profile picture, story highlight cover, or pinned-post image, use **Google Cloud Document AI Form Parser** (already in the v2 GCP service stack per D-aligned §5 in DECISIONS.md, under "AI specialized"). The Form Parser extracts 11 generic entities including **Email**, **Phone**, **URL** — purpose-built for this case. Or fall back to Cloud Vision API OCR plus regex. Either way, this is a **post-MVP optimization**, not a Day-1 must-have.

### 4.3 DM-based handoff (negative recommendation)

Some agencies pursue an "agent DMs the creator to ask for the contact email" path. **Do not implement this in v2.** It requires `instagram_manage_messages` permission (notoriously high rejection rate per [Saurabh Dhar's guide](https://www.saurabhdhar.com/blog/meta-app-approval-guide)), Instagram aggressively rate-limits and flags accounts that DM many non-followers, and the latency (creator responds in days, if at all) breaks the v2 orchestration model. If v2 ever offers this, route through the *operator's own Instagram session* (not a Meta-app-controlled account) and frame it as "operator sends DM with one click from Mission Control" — that bypasses the API permission entirely.

---

## 5. Legal posture — the 2024-2026 stack

The legal question splits into three: (A) is collecting the email itself lawful? (B) is sending the outreach lawful? (C) is the cross-border data flow lawful?

### 5.1 Collection — Meta v. Bright Data sets the US ceiling

On **January 23, 2024**, Judge Edward Chen of the N.D. Cal. granted summary judgment in favor of Bright Data on Meta's contract-breach claim ([TechCrunch 2024-01-24](https://techcrunch.com/2024/01/24/court-rules-in-favor-of-a-web-scraper-bright-data-which-meta-had-used-and-then-sued/), [Farella 2024 analysis](https://www.fbm.com/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/)). The court held that Meta's TOS apply to "your use of our products," and Bright Data's **logged-off public scraping** was not "use" within that TOS scope. Meta dropped the suit a month later ([TechCrunch 2024-02-26](https://techcrunch.com/2024/02/26/meta-drops-lawsuit-against-web-scraping-firm-bright-data-that-sold-millions-of-instagram-records/)).

This combines with **hiQ Labs v. LinkedIn** (settled Dec 2022, with the 9th Circuit's 2019/2022 holding that CFAA does not apply to scraping public data — [Wikipedia summary](https://en.wikipedia.org/wiki/HiQ_Labs_v._LinkedIn)) to produce the current US precedent:

- Scraping **publicly available, logged-off** data is **not a TOS violation** under Bright Data, and **not a CFAA violation** under hiQ.
- Scraping **behind a login** (using fake accounts, scraping private content) **is** a TOS + CFAA violation per the hiQ consent judgment.

**Implication for v2**: route every Instagram fetch through a logged-off path. The Apify and Modash actors named in §3.1 advertise residential-proxy / logged-off operation; verify in their actor README before signing the bill. **Never** configure an Instagram username/password into a v2 scraper credential — that puts you behind the LinkedIn-style line.

### 5.2 Collection in Korea — PIPC's July 2024 guideline

The **PIPC's July 17, 2024 "Guideline for the Processing of Publicly Available Personal Information for AI Development and Services"** ([Lexology summary](https://www.lexology.com/library/detail.aspx?g=c19b57cb-0995-4fba-998a-6d0a5d2cb041)) is the closest Korean equivalent to "Bright Data-style permission to process scraped data." Key points:

- "Legitimate interest" (PIPA Art. 15-1(6)) is a valid basis for processing publicly available personal data — **if** the controller's interest "clearly outweighs" the data subject's rights, **and** appropriate safeguards exist.
- Safeguards expected: data-minimization (only fields you need), purpose limitation (don't re-purpose for unrelated use cases), opt-out mechanism, transparent notice, retention limit, security controls.
- **Profiling / facial recognition / persistent monitoring** is explicitly *not* a legitimate interest for the purposes of this guideline. v2's sourcing → outreach loop is **not** profiling in that sense (it's a one-shot business-inquiry contact), but the `compliance` agent must explicitly check that the outreach is not part of an automated behavioral-tracking pipeline.

Although the 2024 guideline is framed for AI training, the legitimate-interest analysis carries over to non-AI processing per general PIPA doctrine ([DLA Piper Korea overview](https://www.dlapiperdataprotection.com/index.html?t=law&c=KR)).

### 5.3 Outreach — K-CAN-SPAM and PIPA Art. 22

The act regulating commercial email in Korea is the **Information & Communications Network Act (정보통신망법), Article 50** (admin'd by KCC + KISA), commonly nicknamed K-CAN-SPAM. PIPA Article 22 (modified by the **2024 PIPA amendments** with effective dates through Oct 2025 and Sept 2026) sets the consent rules for marketing communications.

Hard rules every outreach email must satisfy:

1. **Subject-line label**: must contain **「(광고)」** in Korean and **"(Advertisement)"** in English, *before* any other subject content ([Signalplug 2026 guide](https://signalplug.com/blog/email-laws-south-korea)).
2. **Sender disclosure**: legal entity name, KR business registration number, physical address, email, phone.
3. **Working one-click unsubscribe**: List-Unsubscribe header + visible footer link. Opt-outs processed within 14 days (statutory) but ideally <24h.
4. **Consent or implied-consent basis**:
   - **B2B implied consent**: valid 6 months following an existing purchase relationship — does not apply to cold influencer outreach (we have no prior relationship).
   - **Affirmative prior consent**: not present in our use case.
   - **Legitimate interest under PIPA + PIPC 2024 guideline**: this is our basis. The reasoning is that the creator has **self-published a `business_email` for the explicit purpose of receiving commercial collaboration inquiries**, and the v2 outreach is a single, transparent collaboration inquiry — squarely within the purpose the creator disclosed.
5. **Consent renewal every 2 years**: applies once the recipient has given consent (i.e., once they reply / opt-in to the v2 system). Not relevant to first-contact outreach.
6. **No re-mailing after opt-out** (rate-limited to ~30 days per consent withdrawal).
7. **Penalties**: up to **KRW 5,000,000 (~$3,700 USD) per violation** under Information & Communications Network Act; up to **3% of revenue** under PIPA (general administrative penalty), and the **2026 PIPA amendment escalated this to 10% of total revenue for high-severity cases** ([Hunton 2026](https://www.hunton.com/privacy-and-cybersecurity-law-blog/south-korea-amends-privacy-law-to-authorize-fines-of-up-to-10-of-total-revenue)).

### 5.4 Cross-border data transfer

If v2's Spanner/AlloyDB/Firestore (D15) ends up storing a KR-creator's email in a US or EU region, PIPA Art. 28-8 (cross-border transfer) applies. Required: separate consent from the data subject *or* contractual safeguards (Standard Contractual Clauses or equivalent) *or* an adequacy decision.

**v2 design implication**: the **APAC-northeast region** (asia-northeast3, Seoul) must be the **primary residency** for KR creator records, with cross-region replication to US/EU happening only for redundancy under the CMEK-and-DLP-redacted regime in D20. The `compliance` agent should enforce a "no KR PII leaves APAC unless explicit operator override + audit trail" rule. This is already implied by D13 (multi-region active-active) + D20 (CMEK per region) but worth restating as an explicit data-residency policy here so it gets baked into the capability-layer code.

---

## 6. Compliance checklist (for the `compliance` agent — D23 tier-1 #13)

The agent runs this checklist **before any email is queued for send**. Failing any item routes to the human-approval queue (D27 AP2 Intent-Mandate model).

### 6.1 Pre-collection

- [ ] Source is a **logged-off** scraper (Apify residential-proxy actor, Modash API, or equivalent). No Instagram-credential-bearing scraper.
- [ ] Provider's actor README explicitly says public-only / logged-off.
- [ ] Source actor returns `is_business_account === true` **or** `is_professional_account === true`. Personal-account emails go to the human-review queue.
- [ ] The candidate has a `public_email` populated **OR** a regex-detected email in `biography` **OR** an email parseable from one bio-link hop.
- [ ] Data-minimization: the v2 record stores **only** the fields v2 actually uses (email, username, full name, category, follower count, recent post URLs for content_verify). Discard `business_address_json`, phone, demographics from raw response. This satisfies PIPA Art. 16 (necessary scope).

### 6.2 Pre-send

- [ ] Subject line begins with `(광고)` for `ko-KR` locale, `(Advertisement)` for `en-US` locale (D34 i18n).
- [ ] Body contains:
  - Legal entity name
  - 사업자등록번호 (KR business reg #)
  - Physical address
  - Reply-to + phone
  - One-line opt-out: "수신 거부를 원하시면 이 링크를 클릭해 주세요" / "Unsubscribe here"
  - One-line data-source disclosure: "We obtained your email from your Instagram Professional profile's public Email contact field. We retain your email for at most 30 days (D33) and do not share with third parties."
- [ ] `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers set.
- [ ] Recipient is **not** in the workspace's `blacklist` collection (shared from v1 Atlas).
- [ ] Recipient has **not** opted out in the last 90 days.
- [ ] Recipient is **not** under-18 by any inference signal (TikTok-side category + Instagram category check; if both ambiguous, route to human review).
- [ ] **`prompt-guard`** has cleared the outreach content (RULES.md from CLAUDE.md mandates this on user-text-into-agent-prompt; same requirement for agent-output-into-external-recipient).

### 6.3 Post-send / retention

- [ ] Send event logged to BigQuery audit (90-day retention per D33).
- [ ] Email PII stored in Firestore Memory Bank with TTL = 30 days (D33) unless the recipient *replies positively*, in which case the record transitions to `crm_accounts` (shared v1 collection) with explicit consent recorded.
- [ ] If recipient opts out, record `opt_out_at` timestamp, propagate to blacklist, and **delete** the email value from active records within 14 days.
- [ ] Cross-border transfer: KR-domiciled creators' records live in asia-northeast3 Spanner primary; replicas in us-central1 + europe-west4 store only the **DLP-redacted** form per D20.

---

## 7. Recommended path for v2

### 7.1 Day-1 ship (agent-challenge submission, deadline 2026-06-05)

1. **Sourcing primary**: Apify `apidojo/instagram-user-scraper` actor via REST. Wrap behind a v2 capability `capabilities/instagram/get-profile.ts` per D35 (capability layer is the only HTTP-touching surface). Cache responses 24h in Memorystore Valkey (already in D-aligned stack). Pay-per-result, target ≤$50/mo at demo scale.
2. **Sourcing secondary** (fallback if Apify rate-limits): Apify `figue/instagram-profile-scraper` actor. Same capability interface, different actor ID.
3. **Bio-link follow-through**: Apify `ahmed_jasarevic/linktree-beacons-bio-email-scraper-extract-leads` actor for the 8% extra coverage. Only called when Step 1 returns null email but non-null `external_url`.
4. **Compliance gate**: implement the §6 checklist as a `capabilities/compliance/instagram-outreach-gate.ts` capability that the `sourcing` and `outreach_writer` agents must call before queueing send.
5. **Outreach template**: extend v2's outreach templates to include the §6.2 mandatory footers, parameterized per D34 locale.
6. **Audit trail**: every fetch + every send writes a Pub/Sub event to a new `v2_audit_instagram` topic. Downstream → BigQuery 90d retention sink.

### 7.2 Phase 2 (post-launch, 2026-Q3)

7. **Modash Discovery API** integration for high-value vetting tier: when a candidate scores ≥75 on the `vetting` agent's rubric, re-enrich through Modash for normalized data + email-validation confidence score. Budget $1k/mo at 100 high-value candidates/mo.
8. **Document AI OCR** for the rare "email in profile picture" case. Cloud Functions + Vision API → regex.
9. **Instagram Graph API app review** kicked off in parallel (does not block email sourcing; required for the eventual `content_verify` agent and for the brand-account-side OAuth flow). Korean 사업자등록증 + privacy policy + screencast of legitimate use → 2-4 wk timeline.
10. **PIPC liaison**: formal notification of v2's data-processing activities per PIPA Art. 30 (privacy policy publication). Coordinate with Korean privacy counsel before first KR-creator outreach.

### 7.3 Phase 3 (Q4 2026 and beyond)

11. Evaluate **Bright Data** for enterprise volume (>50k profiles/month) given their litigation track record.
12. Consider in-house residential-proxy + Playwright stack only if (a) third-party provider economics deteriorate **and** (b) v2 has a dedicated platform-engineering team. Day-1 do **not** do this; it's a 2-engineer-month investment with permanent maintenance burden.

---

## 8. Test plan — how to validate before locking into a provider

A two-week, three-stage test plan to ratify Apify as primary before signing the commit:

### Stage A — Coverage benchmark (week 1, days 1-3)

- Seed set: 500 Instagram handles drawn from the existing v1 `accounts_tiktok` collection's cross-platform field, filtered to those with a known IG handle and a `cross_platform_verified=true` flag. (No new PII collection — already-vetted accounts.)
- Run all three target providers (Apify apidojo, Apify figue, Modash trial credit) against the same seed.
- Measure: % of profiles where `public_email` is populated; % where `biography` contains a regex-detected email; % where `external_url` is a Linktree/Beacons/Bio.link.
- Acceptance: ≥60% of Professional accounts have a `public_email` field populated. (Industry benchmark per SociaVault is ~65%.)

### Stage B — Reliability benchmark (week 1, days 4-7)

- Run a 24-hour stress test: 5,000 enrichment calls spread over 24h on Apify apidojo.
- Measure: success rate, p50 / p99 latency, % of responses with HTTP-200-but-stub-data (indicates Instagram fed the proxy a logged-off blank page), cost-per-1k.
- Acceptance: ≥95% success rate; p99 < 30s; cost ≤$15/1k.

### Stage C — Legal review (week 2)

- Korean privacy counsel reviews: (a) the §6 compliance checklist, (b) sample outreach template, (c) data-residency design (D13 + asia-northeast3 primary), (d) Apify's data-processing addendum.
- Acceptance: counsel sign-off in writing; any required changes folded into the §6 checklist and the outreach template before Day-1 ship.

### Stage D — Smoke test through the full v2 loop (week 2)

- Drive 10 candidates from sourcing → vetting → outreach through the full Inngest-replacement (Cloud Workflows per D18) loop using **operator-owned email addresses** (per D10 — `app.2weeks@gmail.com` and similar test accounts).
- Acceptance: every email passes the §6 compliance gate; every email contains all 7 mandatory body elements; the audit trail in BigQuery shows the full lineage from fetch to send.

### Stage E — Production gate

- Only after Stages A-D all green: roll the Apify capability into the production sourcing pipeline behind a feature flag. Enable for one internal pilot tenant. Expand to additional tenants only after 7 days of clean operation.

---

## 9. Open questions back to the operator

Items this study could not answer and which need human input before the sourcing-agent rebuild kicks off:

1. **Will v2 onboard creators who are themselves Korean residents differently from foreign residents?** (PIPA only applies extraterritorially to controllers of Korean-resident data subjects. Foreign creators are still regulated by their own jurisdictions — GDPR for EU creators is more restrictive than PIPA in some ways. Currently §6.2's `(광고)` subject label is KR-only; the agent should locale-switch to GDPR-compliant language for EU-resident creators, but the PII residency choice is operator policy.)
2. **What is the per-tenant cost ceiling for sourcing?** (The W2 `cost_watch` agent needs a USD/day cap per tenant. $10/day default? $50/day default? Operator decision.)
3. **Should Korean creator emails persist beyond 30 days if the creator replies positively?** (D33 says 30d for PII; positive-reply CRM upgrade is the existing v1 pattern, but PIPA requires explicit consent for retention beyond the original purpose. The outreach footer should include the "if you reply, we save your address; otherwise we delete it in 30 days" line — but is that one paragraph the operator wants in every email? Operator decision.)
4. **Apify vendor lock-in concerns?** Apify is an Israeli/Czech company with no Korean office; their DPA satisfies PIPA Art. 28-8 cross-border transfer requirements only via SCCs. Acceptable to v2's compliance posture? (Most likely yes — but operator should review the Apify DPA explicitly.)

These map to a new outstanding question **O3a** to add to DECISIONS.md §6.

---

## 10. Summary of citations

- Meta v. Bright Data ruling (2024-01-23): [TechCrunch 2024-01-24](https://techcrunch.com/2024/01/24/court-rules-in-favor-of-a-web-scraper-bright-data-which-meta-had-used-and-then-sued/), [Farella analysis](https://www.fbm.com/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/), [TechCrunch 2024-02-26 dismissal](https://techcrunch.com/2024/02/26/meta-drops-lawsuit-against-web-scraping-firm-bright-data-that-sold-millions-of-instagram-records/), [Proskauer 2024-01-24](https://newmedialaw.proskauer.com/2024/01/24/california-court-issues-noteworthy-decision-on-breach-of-contract-claims-in-web-scraping-dispute/).
- hiQ Labs v. LinkedIn: [Wikipedia](https://en.wikipedia.org/wiki/HiQ_Labs_v._LinkedIn), [Privacy World 2022-12](https://www.privacyworld.blog/2022/12/linkedins-data-scraping-battle-with-hiq-labs-ends-with-proposed-judgment/).
- Instagram Graph API `business_discovery` field list: [Meta Developers](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery/).
- Instagram Graph API v21 deprecations: [Meta Changelog](https://developers.facebook.com/docs/instagram-platform/changelog/), [Elfsight 2026 guide](https://elfsight.com/blog/instagram-graph-api-complete-developer-guide-for-2026/).
- Meta app review process: [Saurabh Dhar 2026](https://www.saurabhdhar.com/blog/meta-app-approval-guide), [360dialog Meta verification docs](https://docs.360dialog.com/docs/resources/meta-business-verification).
- Instagram scraping in 2026: [Scrapfly](https://scrapfly.io/blog/posts/how-to-scrape-instagram), [SociaVault 2026 email finder guide](https://sociavault.com/blog/instagram-creator-email-finder-2026), [Security Boulevard 2026 breach context](https://securityboulevard.com/2026/03/the-instagram-api-scraping-crisis-when-public-data-becomes-a-17-5-million-user-breach/).
- Apify Instagram scrapers: [apidojo/instagram-user-scraper](https://apify.com/apidojo/instagram-user-scraper), [figue/instagram-profile-scraper](https://apify.com/figue/instagram-profile-scraper), [Linktree/Beacons email scraper](https://apify.com/ahmed_jasarevic/linktree-beacons-bio-email-scraper-extract-leads), [Apify pricing](https://apify.com/pricing).
- Modash: [Pricing](https://www.modash.io/pricing), [Influencer Marketing API](https://www.modash.io/influencer-marketing-api), [Discovery API](https://www.modash.io/influencer-marketing-api/discovery), [Email Finder](https://www.modash.io/features/influencer-email-finder).
- Phyllo (Phase-2 candidate): [Instagram API page](https://www.getphyllo.com/influencer-marketing/instagram-api), [Phyllo pricing](https://www.getphyllo.com/pricing), [Phyllo Instagram API pricing analysis 2026](https://www.getphyllo.com/post/instagram-api-pricing-explained-iv).
- PIPC 2024 guideline on publicly available personal information: [Lexology summary](https://www.lexology.com/library/detail.aspx?g=c19b57cb-0995-4fba-998a-6d0a5d2cb041), [Baker McKenzie Connect On Tech analysis](https://connectontech.bakermckenzie.com/south-korea-sets-ai-standard-pipcs-guidelines-for-generative-ai-present-obligations-opportunity/).
- PIPA general: [Didomi PIPA primer](https://www.didomi.io/blog/south-korea-pipa-everything-you-need-to-know), [ICLG Korea 2024-2025 report](https://iclg.com/practice-areas/data-protection-laws-and-regulations/korea), [DLA Piper Korea](https://www.dlapiperdataprotection.com/index.html?t=law&c=KR), [Chambers 2026 Korea trends](https://practiceguides.chambers.com/practice-guides/data-protection-privacy-2026/south-korea/trends-and-developments).
- 2026 PIPA 10%-of-revenue amendment: [Hunton 2026](https://www.hunton.com/privacy-and-cybersecurity-law-blog/south-korea-amends-privacy-law-to-authorize-fines-of-up-to-10-of-total-revenue).
- K-CAN-SPAM / Information & Communications Network Act marketing email rules: [Signalplug 2026 guide](https://signalplug.com/blog/email-laws-south-korea), [Overloop 2026 cold email legal guide](https://overloop.com/blog/cold-email-illegal), [iscoldemaillegal.com country guide](https://iscoldemaillegal.com/blog/cold-email-laws-by-country/).
- Linktree parsing technique: [HarvestMyData 2026](https://harvestmydata.com/blog/how-we-extract-emails-from-linktree).
- Google Document AI Form Parser entities: [Google Cloud OCR](https://cloud.google.com/use-cases/ocr), [Document AI Enterprise OCR docs](https://docs.cloud.google.com/document-ai/docs/enterprise-document-ocr).

---

**End of INSTAGRAM.md.** Word count: ~4,200. Next deliverable owners: capability-layer author (§3.2 + §7.1 wiring), compliance-agent prompt author (§6), `decisions/DECISIONS.md` change-log entry (add D14a + O3a per §9).
