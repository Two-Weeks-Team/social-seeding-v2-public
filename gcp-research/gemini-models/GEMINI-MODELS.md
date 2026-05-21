# Gemini Models on Vertex AI — Selection & Tuning Guide for AI Agents

> **As of:** May 2026 (current date 2026-05-19)
> **Audience:** social-seeding-v2 engineers planning a Gemini-on-Vertex AI port of the current Claude Opus 4.7 / Haiku 4.5 agent stack.
> **Status of facts:** all prices, model names, GA/Preview tags, deprecation dates, and announcements below are dated and sourced. Where Vertex AI and the Gemini Developer API diverge in policy (e.g. grounding free tiers, region pricing), the Vertex AI number wins because that is the surface we will deploy on. Sources are listed at the bottom of the document.

---

## 0. TL;DR for the impatient

1. **The product surface formerly called "Vertex AI Generative AI" was rebranded at Google Cloud Next '26 (Apr 22, 2026) to the "Gemini Enterprise Agent Platform"**, which now bundles Agent Runtime, Memory Bank, and a Code Execution Sandbox into a single agent-oriented stack. The model IDs (`gemini-3-pro-preview`, `gemini-2.5-pro`, etc.) and the regional endpoints are unchanged; only the marketing wrapper moved.
2. **There is no "Gemini 3 Ultra" as a generally available product yet.** Google released **Gemini 3 Pro** on 2025-11-18, followed by **Gemini 3.1 Pro** on 2026-02-19 (currently still in Preview on Vertex AI), and then **Gemini 3.1 Ultra** in March 2026 (2 M token context, native multimodal). The "Ultra" tier in the original spec brief should be read as **Gemini 3.1 Ultra**, which is the new flagship.
3. **Production default for v2 is now Gemini 3.1 ONLY — `gemini-3.1-pro` (judgment) and `gemini-3.1-flash-lite` (bulk/routing) — per the operator mandate of 2026-05-21 (DECISIONS.md D53, which supersedes D5).** The 2.5 family is documented below as reference only and is **no longer the v2 production baseline**. (Historical note: the 2.5 family is GA, has stable function-calling semantics, a published rate card, and qualifies for provisioned throughput and supervised fine-tuning; the 3.x non-global rate card locks in **2026-07-01**.)
4. **For the v2 demo loop (1 brand campaign, 4 candidates, 2 shortlisted, full outreach), the all-Gemini-2.5 bill is roughly $0.10–$0.20 per end-to-end run** versus an estimated $1.50–$2.50 on the current Opus + Haiku mix. Detailed line items are in §6.
5. **Two pricing landmines** to flag in any v2 RFC: (a) the **>200k input tokens tier on 2.5 Pro doubles** the input rate (and 1.5× the output rate); (b) **Google Search grounding is billed per search query**, not per token — $35/1k for 2.5 models, $14/1k for 3.x — and it can dominate the bill on a high-volume vetting loop if left on by default. See §3.4 and §6.5.

---

## 1. Family lineup (May 2026)

The table below is the canonical list of models you can call **on Vertex AI** today. "Public preview" means the API endpoint exists, SLA caveats apply, the rate card may still shift, and the model cannot be used as the inference target for supervised fine-tuning. "GA" means the model is on the locked rate card, eligible for provisioned throughput, and supported by SDK long-term-support guarantees.

| Model | Status (May 2026) | Context window | Max output tokens | Multimodal in | FC | Structured out | Code exec | Grounding | Input $/1M | Output $/1M |
|---|---|---|---|---|---|---|---|---|---|---|
| **Gemini 3.1 Ultra** | Preview (since Mar 2026) | **2,000,000** | 65,000 | text, image, video, audio, PDF | yes | yes (incl. JSON Schema draft 2020-12) | yes (with images) | yes | TBD — locks 2026-07-01 | TBD |
| **Gemini 3.1 Pro** | Preview (since 2026-02-19) | 1,000,000 | 65,000 | text, image, video, audio, PDF | yes | yes | yes (with images) | yes | $2.00 | $12.00 |
| **Gemini 3 Pro** | GA (since 2025-11-18) | 1,000,000 | ~32,000 | text, image, video, audio, PDF | yes | yes | yes | yes | $2.00 | $12.00 |
| **Gemini 3 Flash** | Preview | 1,000,000 | ~32,000 | text, image, video, audio, PDF | yes | yes | yes (image-aware) | yes | ~$0.50 (preview) | ~$3.00 (preview) |
| **Gemini 3.1 Flash-Lite** | **GA (Apr 2026)** | 1,000,000 | 65,000 | text, image, video, audio, PDF | yes | yes | yes | yes | **$0.25** | **$1.50** |
| **Gemini 2.5 Pro** | GA | 1,000,000 (effective 2,000,000 via paged) | 65,536 | text, image, video, audio, PDF | yes | yes (OpenAPI 3.0 schema) | yes | yes | **$1.25** (≤200k) / **$2.50** (>200k) | **$10.00** (≤200k) / **$15.00** (>200k) |
| **Gemini 2.5 Flash** | GA | 1,000,000 | 65,536 | text, image, video, audio | yes | yes | yes | yes | **$0.30** | **$2.50** |
| **Gemini 2.5 Flash-Lite** | GA | 1,000,000 | 65,536 | text, image (limited), audio | yes | yes | yes | yes | **$0.10** | **$0.40** |
| **Gemini 2.0 Flash** | **Deprecated 2026-03-06, shutdown 2026-06-01** | 1,000,000 | 8,192 | text, image, video, audio | yes | yes | yes | yes | n/a (closed to new projects) | n/a |
| **Gemini 2.0 Flash-Lite** | **Deprecated, shutdown 2026-06-01** | 1,000,000 | 8,192 | text | yes | yes | no | partial | n/a | n/a |
| **Gemini Nano 4** | Android on-device (no Vertex API) | ~6k effective | n/a | text, image | partial | partial | no | no | n/a (device-resident) | n/a |
| **Gemma 3** | Open weights, deployable via Vertex Model Garden / GKE / Cloud Run | 128k (varies by size) | varies | text, image | yes (vLLM tooling) | via OpenAI-compat layer | no | no | charged on the compute (Spot GPU $) | same |
| **Gemma 4** | Open weights, GA on GCP (announced Apr 2026) | 128k+ (varies) | varies | text, image, modality-extensions in roadmap | yes | yes | no | no | charged on compute | same |
| **Imagen 4 Fast / Standard / Ultra** | GA (Imagen 4 Ultra) / Public Preview (Imagen 4 Fast/Standard variants) | n/a (text-prompt) | n/a (image output) | n/a | n/a | n/a | n/a | n/a | $0.02 / $0.04 / $0.06 per image | same |
| **Veo 3** | Public Preview (allowlisted) | text/image prompt | up to 8s @ 1080p | n/a | n/a | n/a | n/a | n/a | **$0.50/s** (video only) / **$0.75/s** (video + audio) | same |
| **Veo 3.1 Lite** | Public Preview | text/image prompt | up to 8s | n/a | n/a | n/a | n/a | n/a | **$0.10/s** (no audio) | same |
| **Lyria 2** | GA on Vertex AI | text prompt | audio (mins) | n/a | n/a | n/a | n/a | n/a | per-second of audio (see Vertex AI pricing) | same |

**Key inferences from the table**

* "Gemini 3 Pro / Gemini 3 Ultra" in the original RFC brief map to **Gemini 3 Pro (GA)** and **Gemini 3.1 Ultra (Preview)** respectively as of May 2026. The "Ultra" tier was not in the Nov 2025 launch wave; it shipped in March 2026 as part of the 3.1 family.
* **`gemini-2.5-flash-lite` is the unambiguous replacement** for `gemini-2.0-flash-lite` (which goes dark on 2026-06-01) and is what every Haiku-class call in v2 should route to first.
* For an agent that needs to call the Python sandbox **with image inputs**, only Gemini 3 Flash and 3.x Pro variants currently support that combination — 2.5 Flash supports code-exec but not image+code-exec in the same turn.
* **Gemma is not free** when "free" means "no Google bill" — you pay GKE/Compute Engine GPU time. Gemma 3 / 4 are the right answer only when (i) data residency forbids sending text to a hosted Gemini endpoint or (ii) sustained QPS exceeds ~50 RPS on Flash-class workloads, where amortized TPU/GPU rental beats per-token pricing.

---

## 2. Capability deep-dive

### 2.1 Function calling

All current Gemini models (2.5 family, 3.x family, plus the GA Gemma 4 via its OpenAI-compat layer) expose **function calling** with three tool-call modes:

* **`AUTO`** — model decides whether to call a function. This is the default and what most agent loops want.
* **`ANY`** — model **must** call one of the supplied functions on this turn. Use this when you have already committed to a tool round and the only question is which one.
* **`NONE`** — disable tool calling for this turn, even if tools are declared. Useful for "render the final answer" turns inside a multi-step agent.

**Parallel tool calls** are supported on Gemini 2.5 Pro, 2.5 Flash, 3.x Pro, and 3.x Flash. The model may return multiple `functionCall` parts in a single response; the SDK then expects you to return the corresponding `functionResponse` parts together. This is the correct primitive for the v2 vetting fan-out (one prompt, N parallel checks).

Function declarations use a subset of OpenAPI 3.0 Schema. Since the May 2025 blog post on JSON Schema support, the API also accepts JSON Schema draft 2020-12 with implicit property ordering — this is what makes Pydantic v2 and Zod work out-of-the-box without a translation layer. The 2.5 family accepts both formats; the 3.x family accepts both formats **and** preserves additional schema fields (e.g. `pattern`, `format`, `minLength`) that the 2.x family silently dropped.

### 2.2 Structured output (JSON mode + response schema)

There are two related-but-distinct mechanisms:

1. **`generationConfig.responseMimeType = "application/json"`** — the simple "JSON mode" toggle. The model is biased to produce valid JSON but the structure is left to the prompt.
2. **`generationConfig.responseSchema = { … }`** — server-side **constrained decoding** against your schema. The output is guaranteed to parse as the schema. This is the production-grade mode.

The Gemini 3 family extends this with **JSON Schema + tools in the same call** — meaning you can demand a structured final answer **while** the model is using grounding, code execution, or function calling on intermediate turns. The 2.5 family supports either-or in most SDK paths.

Concrete recommendations for v2:

* Replace every `JSON.parse(text)` in current Claude code with `responseSchema` on the Gemini call. Treat the schema as your typed contract (Zod for TS, Pydantic for Python) and generate the API schema from it.
* Keep `responseMimeType=application/json` as a fallback for cases where the schema is dynamic (e.g. user-templated workflows).

### 2.3 Context caching

All GA 2.5 models and all 3.x models support **explicit context caching**. The semantics:

* You create a `CachedContent` resource by submitting a large, stable prefix (system prompt + reference docs + few-shot examples) once.
* On subsequent generations you supply only the new turn plus the cache handle.
* **Reads from cache are billed at 10% of the standard input token rate.** That is the documented Vertex AI ratio for 2.5 Pro: $0.315/M cached vs $1.25/M uncached.
* You also pay **storage** per million cached tokens per hour, prorated to the minute.
* **TTL** is freely configurable with no hard min/max; default is 1 hour. There is no penalty for setting a long TTL — you simply pay the storage charge.
* The break-even crosses roughly at **3–4 reads of the cached prefix within a 60-minute window**.

This is the single biggest lever for the v2 outreach-writer tournament. The system prompt + brand-voice few-shots + the candidate's profile are stable across all N draft attempts in a tournament — caching that prefix once cuts the tournament's input bill by ~85%.

### 2.4 Code execution (Python sandbox)

Code execution is a **built-in tool**, not a function you declare. Enabling it gives the model a stateful Python sandbox with NumPy, Pandas, Matplotlib, SciPy, and a small set of stdlib utilities. The sandbox state persists across turns in a single session.

Recent (2026) updates:

* File input (upload → sandbox `/files/<id>`) is GA for 2.5 and 3.x.
* Matplotlib output is rendered into the response as inline images.
* **Image inputs + code execution in the same turn** is available on Gemini 3 Flash (and 3.x Pro). This is the right tool for "OCR a screenshot of a TikTok dashboard then compute engagement rate".
* In April 2026 the Code Execution Sandbox was promoted into the Gemini Enterprise Agent Platform as a standalone resource, addressable from outside Gemini calls (i.e., your agent code can run code in the same sandbox the model uses).

For v2 the highest-leverage place to use code-exec is the **analyst (final report) agent** — it can compute medians, p-values on the experiment outcome, and write its own charts without you needing a separate Python service.

### 2.5 Grounding

Two grounding sources are available:

* **Grounding with Google Search** — the model issues real-time Google queries during generation and returns `grounding_metadata.search_queries` plus citation URIs.
* **Grounding with Vertex AI Search** — same shape but pointed at a private datastore (your own indexed corpus, e.g. crawled v2 docs).

**Pricing model is per-search-query, not per-token.** As of May 2026:

* Vertex AI: **$35 per 1,000 grounded prompts** for Gemini 2.x models, with **1,500 free requests per day (≈45,000/month) per project**.
* For Gemini 3.x models the price drops to **$14 per 1,000 queries**, with **5,000 free grounded prompts per month**.
* Only requests that actually issue a Google search are billed — if dynamic retrieval decides the question is well-handled by parametric knowledge, no charge.

**The trap:** a single user prompt can fan out into multiple internal search queries, and you pay per query, not per prompt. On the v2 vetting fan-out this is the single biggest unintended cost driver if you naively turn grounding on.

### 2.6 Multimodal inputs

The 2.5 family and the 3.x family share the same multimodal envelope:

* **Image** — PNG/JPEG/WEBP, up to 3,000 images per prompt on Flash, no hard cap on Pro (subject to context window).
* **Video** — MP4/MOV up to several minutes; each second is sampled at ~1 frame. A 60-second video runs you ~~60 image tokens + audio tokens.
* **Audio** — WAV/MP3/FLAC, up to ~9.5 hours on Pro. Audio is sampled and counted toward the token budget; expect ~32 tokens/sec.
* **PDF** — uploaded as a first-class modality on 2.5 and 3.x, with text and images extracted in one shot. Older code that pre-renders PDFs to images can be deleted.

### 2.7 Long context (1M, 2M)

The 1M-token window on 2.5 Pro and the 2M-token window on 3.1 Ultra are real but **not free** — past 200k tokens you cross into the "long-context tier" with a higher per-token price (on 2.5 Pro: input doubles from $1.25 to $2.50, output rises from $10 to $15). Practical tactics:

1. **Cache first, expand second.** Anything stable should be in a `CachedContent` resource so the 200k threshold doesn't bite the variable part of every prompt.
2. **Stream and summarize.** For the agent's "world model" prompt, the v2 capability layer should periodically compact older context (a Haiku-class summarization pass) rather than appending forever.
3. **Don't conflate context window with memory.** The agent's persistent state belongs in Mongo (`v2_*` collections) and is replayed selectively into the prompt — not stored in the prompt.

---

## 3. Vertex AI–specific features

### 3.1 Provisioned Throughput (PT) vs on-demand

**On-demand** is the default — you pay per token at the published rate, share a multi-tenant pool, and have no SLA.

**Provisioned Throughput** reserves a guaranteed tokens-per-minute floor at a flat hourly rate. Vertex AI documents a **20–45% discount vs on-demand at sustained high usage**, with **1-month and 1-year commitment tiers**. As of 2026, PT is available for **Gemini 3 family models, Gemini 2.5 family, Veo 3, Veo 3.1, and Nano Banana** (the high-fidelity image edit model that was promoted from Imagen-internal). For video workloads, the GSU (Generative AI Scale Unit) minimums and incremental limits were removed in 2026 — you can buy exactly the throughput you need.

For v2: do not buy PT in 2026. Demo + early production volume is far below the break-even threshold; on-demand is correct until at least a sustained 200 RPM on Flash-class.

### 3.2 Batch prediction

Batch prediction submits a JSONL file of prompts and gives you back a JSONL file of completions within a **24-hour SLA**. The advantage is a **flat 50% discount** vs on-demand pricing **with no quota limits** — the batch service has its own large shared pool.

For v2, the obvious batch candidate is the **content-verify pass** that runs after a campaign delivers (image+text → "did the creator actually post the required product?"). That is naturally bulk and tolerant of 24-hour latency. Run it through batch and the marginal cost halves.

### 3.3 Tuning (SFT and distillation)

**Supervised fine-tuning** (SFT) is supported on `gemini-2.5-pro`, `gemini-2.5-flash`, and `gemini-2.5-flash-lite`. Pricing:

* Training is billed per **training token** = (tokens in dataset) × epochs.
* Inference on the tuned model is billed **at the base model's rate** — no premium for "tuned".
* The tuned model needs a hosted endpoint; hosting is billed by node-hour.

**Distillation** (large teacher → small student) is available through Vertex AI Pipelines; effectively this is "use 2.5 Pro to label data, then SFT 2.5 Flash on those labels". Pricing follows the same per-training-token + node-hour shape.

**Preference tuning** (DPO-style, ranking data) is available in Preview on the 2.5 family. This is the right tool for the v2 outreach-writer when the operator wants to encode "I always prefer drafts that open with a question" without prompt-stuffing.

### 3.4 Safety filters

Vertex AI exposes per-call safety settings for four categories (`HARM_CATEGORY_HARASSMENT`, `HATE_SPEECH`, `SEXUALLY_EXPLICIT`, `DANGEROUS_CONTENT`) with four thresholds (`BLOCK_NONE`, `BLOCK_ONLY_HIGH`, `BLOCK_MEDIUM_AND_ABOVE`, `BLOCK_LOW_AND_ABOVE`). For an outreach-writing agent talking to creators, `BLOCK_MEDIUM_AND_ABOVE` on all four is the right default. For a security-research agent analyzing scam emails, you may need `BLOCK_ONLY_HIGH` on `DANGEROUS_CONTENT` to avoid false positives.

Project-level **Model Armor** is the policy layer that sits above per-call settings and enforces the same thresholds regardless of caller. v2's `prompt-guard` should be the application-level peer to Model Armor, not a replacement.

### 3.5 Citations

When grounding is enabled, the response includes `candidates[].grounding_metadata` with:

* `groundingChunks[]` — the snippets that were retrieved.
* `groundingSupports[]` — mapping from a span in the response to the chunk it came from.
* `searchEntryPoint.renderedContent` — required HTML/text for displaying the "Google Search" attribution to comply with Google's grounding terms of service.

v2 must render this attribution somewhere visible if grounding is used in the customer-facing dashboard. Failure to do so is a TOS violation.

### 3.6 Logprobs

Top-k token logprobs (k up to 20) are available on 2.5 and 3.x via `generationConfig.responseLogprobs = true` and `logprobs = N`. Useful for:

* **Confidence on the tournament judge** — if the judge picks A over B with logprob delta < 0.5, escalate.
* **Cheap rerankers** — score N candidate completions by their first-token logprob under a fixed "is this a good outreach? Yes/No" classifier prompt.

---

## 4. Decision matrix for v2

Mapping the v2 agent roster to Gemini models. Each pick is justified by **input cost × expected per-run volume × judgment requirement**.

| Role in v2 | Current model | Recommended Gemini | Why |
|---|---|---|---|
| **outreach-writer judge (tournament)** | Opus 4.7 | **Gemini 2.5 Pro** | This is the highest-judgment call in the loop — picking the best of N drafts on tone, brand-fit, and policy. Volume is small (≤8 judgments per campaign). Per-judgment cost is ~$0.01–$0.03 even with thinking tokens. Logprob delta gives a free escalation signal. Do not move to 3.x until GA on the long-context tier. |
| **outreach-writer drafter** | Opus 4.7 | **Gemini 2.5 Pro** (consider 3.1 Pro after GA) | Quality-sensitive but more volume than the judge (N drafts × N candidates). 2.5 Pro at $1.25/M in is ~12× cheaper than Opus on input. Cache the system prompt + brand-voice few-shots and you pay the long-form output price only — for a ~600-token draft, that's ~$0.006/draft on 2.5 Pro vs ~$0.09 on Opus 4.7. |
| **sourcing planner** | Opus 4.7 | **Gemini 2.5 Pro** | One call per campaign, big reasoning load, can use code execution to query the v2 capability layer. The judgment payoff justifies Pro over Flash. ≤1k tokens out, no caching value (each plan is unique). |
| **vetting fan-out × N** | Opus 4.7 | **Gemini 2.5 Flash** | High volume (N=10–50 per campaign), low per-call judgment (apply a checklist to a profile). $0.30/M input is 50× cheaper than Opus. Use parallel function calling to bundle profile-fetch + scoring in one turn. **Do not enable grounding here** — it would dominate the bill. |
| **conversation classifier** | Haiku 4.5 | **Gemini 2.5 Flash-Lite** | Classify reply intent (positive / declined / clarification / scam). Pure pattern match. $0.10/M input — the cheapest you can buy. Use `responseSchema` to force a discriminated-union output. |
| **logistics (address parsing)** | Haiku 4.5 | **Gemini 2.5 Flash** | Slightly above Flash-Lite because of the multilingual + format-variety surface (Korean addresses, US ZIP+4, international post). Flash multimodal also lets you OCR an attached shipping label if the creator sends one. |
| **content-verify (image + text)** | Haiku 4.5 | **Gemini 2.5 Flash** (multimodal) | Needs image input → cannot use Flash-Lite reliably. Flash's multimodal envelope handles "did this Instagram screenshot include the product?" in a single call. Route through **batch prediction** for the 50% discount when latency isn't critical. |
| **analyst (final report)** | Opus 4.7 | **Gemini 2.5 Pro** + code execution | One call per campaign close, high judgment, naturally benefits from the Python sandbox for computing engagement deltas and rendering charts. Total cost ~$0.05–$0.15 per report. Move to 3.x Pro after GA + once it supports tuning. |

**Migration path** — start with **all 2.5 family**, port one role at a time behind a feature flag, keep the Claude versions live as A/B controls until the Gemini eval set (golden replies + tournament outcomes) matches or beats the Claude baseline.

**Don't pick 3.x in production yet.** Reasons:

* Still Preview on Vertex AI; non-global endpoint pricing is not locked until 2026-07-01.
* No SFT support on 3.x as of May 2026.
* SDK behavioral changes (e.g. how thinking tokens are counted in `usageMetadata`) are still settling.

The right time to revisit is the next GA-window for the 3.x family — likely Q3 2026 based on the announced trajectory.

---

## 5. Cost projection — v2 demo run (1 brand × 4 candidates × 2 shortlisted)

This sizing matches the May 14, 2026 live demo (`scripts/run-demo.ts --type=brand`).

### 5.1 Per-step token estimates (one demo run)

| Step | Calls | Input tokens (each) | Output tokens (each) | Notes |
|---|---|---|---|---|
| Sourcing planner | 1 | 4,000 | 1,500 | Includes the brief + capability catalog |
| Vetting fan-out | 4 (one per candidate) | 6,000 | 800 | Profile JSON + checklist out |
| Tournament: drafters | 8 (2 shortlisted × 4 candidate drafts) | 5,000 (3,500 cached + 1,500 fresh) | 700 | After cache warm-up |
| Tournament: judges | 4 (2 shortlisted × 2 rounds) | 6,000 | 600 | A vs B with logprobs |
| Reply classifier | 6 (multi-turn reply thread) | 1,500 | 80 | Flash-Lite |
| Reply drafter | 2 (per shortlisted creator) | 4,000 (cached) | 500 | Pro |
| Logistics (address) | 2 | 1,200 | 200 | Flash |
| Content-verify | 2 (one image + caption per delivery) | 3,000 + 1 image | 250 | Flash multimodal, batch |
| Analyst report | 1 | 12,000 | 3,000 | Pro + code execution |

### 5.2 Cost by line item

**Gemini stack (proposed)**

| Step | Model | Input $/run | Output $/run | Subtotal |
|---|---|---|---|---|
| Sourcing planner | 2.5 Pro | 4,000 × $1.25/M = $0.0050 | 1,500 × $10/M = $0.0150 | $0.0200 |
| Vetting fan-out (×4) | 2.5 Flash | 24,000 × $0.30/M = $0.0072 | 3,200 × $2.50/M = $0.0080 | $0.0152 |
| Drafters (×8, cache warm) | 2.5 Pro | 28,000 cached × $0.315/M + 12,000 fresh × $1.25/M = $0.0088 + $0.0150 = $0.0238 | 5,600 × $10/M = $0.0560 | $0.0798 |
| Judges (×4) | 2.5 Pro | 24,000 × $1.25/M = $0.0300 | 2,400 × $10/M = $0.0240 | $0.0540 |
| Reply classifier (×6) | 2.5 Flash-Lite | 9,000 × $0.10/M = $0.0009 | 480 × $0.40/M = $0.0002 | $0.0011 |
| Reply drafter (×2, cached) | 2.5 Pro | 8,000 cached × $0.315/M = $0.0025 | 1,000 × $10/M = $0.0100 | $0.0125 |
| Logistics (×2) | 2.5 Flash | 2,400 × $0.30/M = $0.0007 | 400 × $2.50/M = $0.0010 | $0.0017 |
| Content-verify (×2, batch) | 2.5 Flash (50% off) | 6,000 × $0.15/M = $0.0009 | 500 × $1.25/M = $0.0006 | $0.0015 |
| Analyst report | 2.5 Pro + code-exec | 12,000 × $1.25/M = $0.0150 | 3,000 × $10/M = $0.0300 | $0.0450 |
| **TOTAL (Gemini)** | | **~$0.062** | **~$0.145** | **≈ $0.21 / demo run** |

If we re-do the math assuming **no caching** (cold start, first demo of the day), the drafters and reply drafter rise from $0.092 → $0.131, pushing the total to **≈ $0.25 / run**.

**Claude stack (current, for comparison)**

Using Opus 4.7 at ~$15/M input / $75/M output and Haiku 4.5 at ~$1/M input / $5/M output (Anthropic public rates as of May 2026):

| Step | Model | Approx cost |
|---|---|---|
| Sourcing planner | Opus 4.7 | $4,000 × $15/M + 1,500 × $75/M = $0.06 + $0.11 = $0.17 |
| Vetting fan-out (×4) | Opus 4.7 | 24,000 × $15/M + 3,200 × $75/M = $0.36 + $0.24 = $0.60 |
| Drafters (×8) | Opus 4.7 | 40,000 × $15/M + 5,600 × $75/M = $0.60 + $0.42 = $1.02 |
| Judges (×4) | Opus 4.7 | 24,000 × $15/M + 2,400 × $75/M = $0.36 + $0.18 = $0.54 |
| Reply classifier (×6) | Haiku 4.5 | 9,000 × $1/M + 480 × $5/M = $0.009 + $0.002 = $0.011 |
| Reply drafter (×2) | Opus 4.7 | 8,000 × $15/M + 1,000 × $75/M = $0.12 + $0.075 = $0.195 |
| Logistics (×2) | Haiku 4.5 | 2,400 × $1/M + 400 × $5/M = $0.0024 + $0.002 = $0.005 |
| Content-verify (×2) | Haiku 4.5 | 6,000 × $1/M + 500 × $5/M = $0.006 + $0.0025 = $0.009 |
| Analyst report | Opus 4.7 | 12,000 × $15/M + 3,000 × $75/M = $0.18 + $0.225 = $0.405 |
| **TOTAL (Claude)** | | **≈ $2.97 / demo run** |

### 5.3 Headline

| Stack | $/demo run | Annualized at 100 runs/day |
|---|---|---|
| Gemini 2.5 mix (proposed) | **~$0.21** | **~$7,700/yr** |
| Claude Opus + Haiku (current) | **~$2.97** | **~$108,000/yr** |

**~14× cost reduction** on the inference bill for the same demo loop, before adding any further optimization (PT, batch on more steps, distilled Flash-Lite for the classifier, etc).

### 5.4 Caveats

1. The 14× number assumes the **quality bar holds**. Until v2 has a golden-set eval run on every agent role, this is a budget projection, not a guarantee.
2. The estimate **excludes grounding charges**. If sourcing or vetting calls Google Search even 5× per run, you add $35/1k × 5 = $0.175/run — almost doubling the bill. Default grounding to OFF and turn it on per-call only when the prompt explicitly needs current information.
3. The estimate **assumes mongo-resident context** (capability layer, not stuffed into the prompt). If the current Claude code is implicitly relying on stuffing 50k+ tokens of context every call, the >200k tier on 2.5 Pro will bite.
4. **Thinking tokens** on 2.5 Pro are billed at input rate and can add 30–100% to the effective input bill on the judge and analyst roles. The numbers above include a ~50% thinking-token allowance baked into the input counts.

---

## 6. Latest 2026 announcements (Next '26 + after)

### 6.1 Google Cloud Next '26 (Apr 22–24, 2026, Las Vegas)

* **Vertex AI rebrand → "Gemini Enterprise Agent Platform".** The product surface combines model serving (Gemini, Gemma, Imagen, Veo, Lyria, plus third-party Anthropic Claude and Meta Llama on Model Garden) with agent infrastructure: Agent Designer, Agent Runtime, Memory Bank, persistent Inbox, Skills, Projects, long-running agents, and the Code Execution Sandbox as a top-level resource.
* **Workspace Intelligence** — a unified real-time signal feed designed to power agentic work across Gmail, Drive, Calendar, Meet. Relevant to v2's customer-frontend if we ever build a "Gemini sees the operator's inbox" feature, but not in scope for the May demo.
* **TPU v8** — eighth-generation TPU with two specialized chips ("Ironwood" inference, "Trillium" training, per the public material). Most relevant for tuning/distillation cost — Vertex SFT prices are expected to drop after v8 capacity rolls in.
* **Agentic Defense** (Google Threat Intelligence + SecOps + Wiz). Mostly a security-product announcement; flagged here only because Model Armor sits in the same governance umbrella.

### 6.2 Gemini 3.x model cadence

* **Gemini 3 Pro** — GA on Vertex AI since 2025-11-18.
* **Gemini 3.1 Pro** — Preview on Vertex AI since 2026-02-19. Highlights: 4-tier thinking system (Minimal / Low / Medium / High), 65k output ceiling, ARC-AGI-2 = 77.1% (more than 2× 3 Pro).
* **Gemini 3.1 Ultra** — Preview since March 2026. 2M context, native video understanding + generation, stronger ARC-AGI-3 / GPQA Diamond / SWE-Bench Pro.
* **Gemini 3.1 Flash-Lite** — **GA in April 2026** at $0.25/$1.50, positioned as Google's "most cost-effective AI model yet".
* **Non-global endpoint rate card for 3.x** locks in **2026-07-01**. Until then, treat the published rates as approximate for regional endpoints.

### 6.3 Other 2026 model news worth tracking

* **Gemma 4** — open weights, GA on Google Cloud (announced April 2026). Hybrid agentic workflows (Gemini 3.1 Pro as orchestrator, Gemma 4 as worker on a dedicated GPU pool) are a real architecture published in Google's own developer-advocate posts.
* **Gemini Nano 4** — on-device, Pixel 10 / Galaxy S26 class hardware. Not relevant to v2 server-side, but if a future v2 mobile app needs offline classifiers, this is the surface.
* **Veo 3.1 Lite** — public preview, $0.10/s without audio. Materially cheaper than Veo 3 ($0.50/s without audio). v2 doesn't need video gen yet, but if the analyst's "campaign recap" ever wants a 6-second highlight reel, this is the cheapest path.
* **Nano Banana** — promoted to a first-class image-editing model with PT support. If v2 ever needs "edit this product photo to match the creator's color palette", this is now the recommended target instead of stitching Imagen 4 + a separate edit model.

---

## 7. Adoption recommendation for v2

1. **Don't migrate in the May 14 demo window.** The current Claude stack is working, eval'd, and the team's mental model is calibrated to it. A two-week-out model swap is gratuitous risk.
2. **Open a parallel `agents-gemini` package** behind a feature flag (`AGENT_PROVIDER=gemini`). Port one role at a time, starting with **reply classifier → Flash-Lite** (cheapest, easiest, smallest blast radius). This is also the easiest role to golden-set test.
3. **Build a thin provider abstraction** in `packages/agents/src/providers/` that hides `@anthropic-ai/sdk` vs `@google-cloud/vertexai`. Both have a tool-calling + structured-output surface that can be unified behind a common `runAgent({ tools, schema, model })` call. This is also what lets you A/B without forking the workflow.
4. **First production targets, in order:** classifier → logistics → content-verify (batch) → vetting fan-out → drafter → judge → planner → analyst. Earlier items have small judgment loads and high volume — they recover the migration cost fastest.
5. **Wait for 3.x GA** before moving the judgment-heavy roles (judge, analyst). The 2.5 family is good enough and stable enough; the upside of 3.1 Pro is marginal vs the risk of preview-tier behavior changes.
6. **Two non-negotiables on day one of a Gemini call path:**
   * `prompt-guard` runs **before** any Gemini call, not after — same rule as for the current stack.
   * Grounding is **off by default** on every agent role. It can be enabled per-call only where the prompt explicitly needs current information, and never inside a fan-out.

---

## Sources

Official Google sources (preferred):

- [Vertex AI / Gemini Enterprise Agent Platform pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- [Gemini Enterprise Agent Platform pricing (alt URL)](https://cloud.google.com/vertex-ai/pricing)
- [Vertex AI generative AI release notes](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/release-notes)
- [Gemini 3.1 Pro model card on Vertex AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-pro)
- [Gemini 2.5 Pro model card on Vertex AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-pro)
- [Gemini 2.5 Flash model card on Vertex AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash)
- [Gemini 2.0 Flash model card on Vertex AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-0-flash)
- [Model versions and lifecycle](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions)
- [Gemini API deprecations](https://ai.google.dev/gemini-api/docs/deprecations)
- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini structured outputs docs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Structured output for open models on Vertex](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/maas/capabilities/structured-output)
- [Function calling for open models on Vertex](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/maas/capabilities/function-calling)
- [JSON Schema + implicit ordering announcement](https://blog.google/technology/developers/gemini-api-structured-outputs/)
- [Gemini code execution docs](https://ai.google.dev/gemini-api/docs/code-execution)
- [Code Execution quickstart on Gemini Enterprise Agent Platform](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/code-execution-quickstart)
- [Gemini context caching blog](https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-context-caching)
- [Gemini generateContent / caching API ref](https://ai.google.dev/gemini-api/docs/caching)
- [Provisioned Throughput on Vertex AI](https://cloud.google.com/blog/products/ai-machine-learning/provisioned-throughput-on-vertex-ai)
- [Use Provisioned Throughput](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/provisioned-throughput/use-provisioned-throughput)
- [Batch predictions on Vertex AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/maas/capabilities/batch-prediction)
- [About supervised fine-tuning for Gemini](https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini-supervised-tuning?hl=en)
- [About preference tuning for Gemini](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini-preference-tuning)
- [Gemma 3 on Vertex AI announcement](https://cloud.google.com/blog/products/ai-machine-learning/announcing-gemma-3-on-vertex-ai/)
- [Gemma 4 on Google Cloud announcement](https://cloud.google.com/blog/products/ai-machine-learning/gemma-4-available-on-google-cloud)
- [Veo 3, Imagen 4, Lyria 2 on Vertex AI announcement](https://cloud.google.com/blog/products/ai-machine-learning/announcing-veo-3-imagen-4-and-lyria-2-on-vertex-ai?hl=en)
- [Gemini 3 launch post](https://blog.google/products/gemini/gemini-3/)
- [Gemini 3.1 Pro post](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-pro/)
- [Gemini 3.1 Flash-Lite GA blog](https://cloud.google.com/blog/products/ai-machine-learning/gemini-3-1-flash-lite-is-now-generally-available)
- [Gemini 3.1 Flash-Lite product blog](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-lite/)
- [Google Cloud Next '26 wrap-up](https://cloud.google.com/blog/topics/google-cloud-next/google-cloud-next-2026-wrap-up)
- [Welcome to Google Cloud Next '26](https://cloud.google.com/blog/topics/google-cloud-next/welcome-to-google-cloud-next26)
- [7 highlights from Google Cloud Next '26](https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/google-cloud-next-26-recap/)
- [Google AI announcements April 2026](https://blog.google/innovation-and-ai/technology/ai/google-ai-updates-april-2026/)

Third-party deep dives (cross-referenced for prices):

- [Vertex AI Pricing complete 2026 guide — CloudZero](https://www.cloudzero.com/blog/google-vertex-ai-pricing/)
- [Gemini Pricing 2026 — Finout](https://www.finout.io/blog/gemini-pricing-in-2026)
- [Gemini 3.1 Pro pricing — Verdent Guides](https://www.verdent.ai/guides/gemini-3-1-pro-pricing)
- [Vertex AI Pricing — nOps](https://www.nops.io/blog/vertex-ai-pricing/)
- [Google Vertex AI pricing 2026 — TokenMix](https://tokenmix.ai/blog/vertex-ai-pricing)
- [Gemini grounding billing — AI Expert Reviewer](https://aiexpertreviewer.com/gemini-grounding-billing-2026/)
- [Imagen 4 pricing — MagicHour](https://magichour.ai/blog/imagen-4-pricing-and-api)
