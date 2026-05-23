/**
 * CrmEnrichClient — factory seam for the Modal crawl + Gemini analysis
 * pipeline that `crm.enrich` (Phase 5) drives. Same shape as
 * GmailClient / CarrierClient / TikTokFetcher: production binds the real
 * SDK from env vars; tests inject a fake.
 *
 * Two stages, kept separate so tests can simulate "crawl ok, analysis
 * down" / "crawl down, …" failure modes:
 *
 *   1. `crawl(url)`    → fetch the company's homepage + n inner pages,
 *                        return raw text + emails + social links.
 *                        v1 used a Modal app at $MODAL_CRAWL_URL.
 *   2. `analyze(text)` → run the K-beauty sales-analyst prompt on
 *                        `text`, return the structured JSON v1's
 *                        `lib/crm/enrichment-service.ts` did. Now runs on
 *                        `gemini-3.5-flash` via Gemini's OpenAI-compatibility
 *                        endpoint (D53; v1 used Kimi-k2.5, since retired).
 *
 * Default factory throws clear errors when env vars are missing — so
 * tests that always inject a fake stay fast (no SDK load) and prod
 * misconfigurations fail loud at the call site, not silently.
 */

import type { LeadEnrichment } from "@ss/contracts";

export interface CrawlResult {
  url: string;
  /** Carrier-side normalization, may equal `url`. */
  normalizedUrl: string;
  pagesVisited: number;
  /** The concatenated extracted text — fed to `analyze`. */
  text: string;
  emails: string[];
  /** {platform: url} — instagram / facebook / twitter / youtube / tiktok. */
  socialLinks: Record<string, string>;
}

/** Subset of the analysis fields `crm.enrich` returns to callers. */
export type AnalysisResult = LeadEnrichment["analysis"];

export interface AnalyzeInput {
  companyName: string;
  homepageUrl: string;
  crawl: CrawlResult;
}

export interface CrmEnrichClient {
  /** Modal crawl — fetch homepage + crawl up to `maxPages` inner pages. */
  crawl(url: string, opts?: { maxPages?: number }): Promise<CrawlResult>;
  /** Gemini analysis — synthesize the K-beauty-sales JSON from the crawled text. */
  analyze(input: AnalyzeInput): Promise<AnalysisResult>;
}

export type CrmEnrichClientFactory = () => Promise<CrmEnrichClient>;

let factory: CrmEnrichClientFactory | undefined;

export function setCrmEnrichClientFactory(f: CrmEnrichClientFactory | undefined): void {
  factory = f;
}

export function getCrmEnrichClientFactory(): CrmEnrichClientFactory {
  return factory ?? defaultCrmEnrichClientFactory;
}

/**
 * Production factory. Lazy-creates a real client backed by:
 *   · MODAL_CRAWL_URL  — POST { url, max_pages } → { status, website_data,
 *                                                    crawled_text }
 *   · GEMINI_API_KEY   — Bearer auth on Gemini's OpenAI-compatibility endpoint
 *                        (generativelanguage.googleapis.com/v1beta/openai/...).
 *                        D53: the analysis runs on `gemini-3.5-flash` (Gemini
 *                        only; the prior 3P Kimi/Moonshot model was retired).
 *
 * If either env var is missing, every call throws a "X not wired" error
 * — fast-fails Phase-5 paths until ops fills .env.
 */
export const defaultCrmEnrichClientFactory: CrmEnrichClientFactory = async () => {
  const modalUrl = process.env.MODAL_CRAWL_URL ?? "https://sgwannabe--enrichment-service-crawl.modal.run";
  const geminiKey = process.env.GEMINI_API_KEY ?? "";
  const geminiUrl =
    process.env.CRM_ENRICH_API_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  const geminiModel = process.env.CRM_ENRICH_MODEL ?? "gemini-3.5-flash";

  return {
    async crawl(url, opts) {
      if (!modalUrl) {
        throw new Error("crm.enrich crawl not wired — MODAL_CRAWL_URL is not set");
      }
      const res = await fetch(modalUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, max_pages: opts?.maxPages ?? 20 }),
      });
      if (!res.ok) {
        throw new Error(`crm.enrich: Modal crawl returned ${res.status}`);
      }
      const json = (await res.json()) as {
        status: string;
        error?: string;
        website_data?: {
          url: string;
          normalized_url?: string;
          pages_visited?: number;
          emails?: string[];
          social_links?: Record<string, string>;
        };
        crawled_text?: string;
      };
      if (json.status !== "success") {
        throw new Error(`crm.enrich: Modal crawl status=${json.status}${json.error ? ` — ${json.error}` : ""}`);
      }
      const wd = json.website_data ?? { url };
      return {
        url: wd.url,
        normalizedUrl: wd.normalized_url ?? wd.url,
        pagesVisited: wd.pages_visited ?? 0,
        text: json.crawled_text ?? "",
        emails: wd.emails ?? [],
        socialLinks: wd.social_links ?? {},
      };
    },

    async analyze({ companyName, homepageUrl, crawl }) {
      if (!geminiKey) {
        throw new Error("crm.enrich analyze not wired — GEMINI_API_KEY is not set");
      }
      const sns = Object.entries(crawl.socialLinks).map(([k, v]) => `${k}: ${v}`).join(", ") || "없음";
      const emails = crawl.emails.join(", ") || "없음";
      const contextHeader = [
        `Company: ${companyName}`,
        `URL: ${homepageUrl}`,
        `소셜미디어: ${sns}`,
        `이메일: ${emails}`,
        `크롤링 페이지 수: ${crawl.pagesVisited}`,
        "",
      ].join("\n");
      const analysisPrompt = `${contextHeader}${ANALYSIS_PROMPT}${crawl.text.slice(0, 200_000)}`;
      const res = await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${geminiKey}`,
        },
        body: JSON.stringify({
          model: geminiModel,
          messages: [
            { role: "system", content: "K-Beauty 분석가. 한국어만. 중국어 금지. JSON만 반환. 모든 필드에 구체적이고 상세한 내용을 작성할 것." },
            { role: "user", content: `Company: ${companyName}\n\n${analysisPrompt}` },
          ],
          temperature: 1,
          max_tokens: 8000,
          response_format: { type: "json_object" },
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`crm.enrich: Gemini returned ${res.status}${errText ? ` — ${errText.slice(0, 200)}` : ""}`);
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content ?? "";
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content) as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `crm.enrich: Gemini returned non-JSON content (${err instanceof Error ? err.message : "parse error"}): ${content.slice(0, 200)}`,
        );
      }
      return coerceAnalysis(parsed);
    },
  };
};

/**
 * Coerce loose model output → the strict AnalysisResult shape. The model
 * occasionally drops fields or returns "unclear" where we expect an
 * enum; this is the defensive narrowing layer the capability relies on.
 */
function coerceAnalysis(raw: Record<string, unknown>): AnalysisResult {
  const asString = (k: string, fallback = ""): string => {
    const v = raw[k];
    return typeof v === "string" ? v : fallback;
  };
  const priorityRaw = asString("sales_priority", "medium").toLowerCase();
  const sales_priority: AnalysisResult["sales_priority"] =
    priorityRaw === "high" || priorityRaw === "low" ? priorityRaw : "medium";
  const confidence = typeof raw.confidence_score === "number" ? raw.confidence_score : 0;
  return {
    company_summary: asString("company_summary", "(분석 결과 없음)"),
    main_products: asString("main_products"),
    product_categories: asString("product_categories"),
    business_type: asString("business_type", "unclear"),
    target_market: asString("target_market"),
    global_presence: asString("global_presence", "unclear"),
    key_strengths: asString("key_strengths"),
    brand_positioning: asString("brand_positioning"),
    sns_presence: asString("sns_presence"),
    recommended_outreach_angle: asString("recommended_outreach_angle", "(권장 없음)"),
    sales_priority,
    sales_priority_reason: asString("sales_priority_reason"),
    confidence_score: Math.max(0, Math.min(100, confidence)),
    reasoning_brief: asString("reasoning_brief"),
  };
}

/**
 * The K-beauty-sales analysis prompt. Verbatim port of v1's
 * ANALYSIS_PROMPT in `lib/crm/enrichment-service.ts`. Korean per v1's
 * focus; defensive against Chinese characters slipping in.
 */
const ANALYSIS_PROMPT = `You are a sales analyst for Social Seeding, a TikTok influencer marketing platform.
Your job is to analyze K-Beauty company websites to determine if they are potential customers for our platform.

Social Seeding helps brands run TikTok influencer campaigns — finding influencers, managing collaborations, tracking performance, and automating outreach.

Analyze the company website content below and fill in ALL fields.

IMPORTANT RULES:
- ALWAYS write in Korean (한국어). Use English only for proper nouns (brand names, product names, certifications).
- NEVER use Chinese characters (汉字/中文) in any field.
- If information is not available, write "unclear".
- Even when input is long, provide DETAILED and SPECIFIC answers for every field. Do NOT summarize briefly.
- Respond ONLY with valid JSON (no markdown, no code blocks, no explanation):

{
  "company_summary": "1-2문장 회사 설명",
  "main_products": "제품1 | 제품2 | 제품3",
  "product_categories": "카테고리1 | 카테고리2",
  "business_type": "brand | manufacturer | oem | odm | distributor | retailer",
  "target_market": "타겟 고객/시장",
  "global_presence": "yes | no | unclear",
  "key_strengths": "핵심 경쟁력",
  "brand_positioning": "브랜드 포지셔닝",
  "sns_presence": "발견된 소셜미디어 계정과 TikTok 활용 여부 분석",
  "recommended_outreach_angle": "Social Seeding 영업 제안: 이 회사에 TikTok 인플루언서 마케팅을 어떻게 제안할 것인지 구체적으로 작성. 반드시 구체적인 제품명, 타겟 시장(국가명), 제안 전략(TikTok Shop, 챌린지, 숏폼 콘텐츠 등), 현재 SNS 현황 대비 TikTok 확장 방안을 포함할 것. 일반적인 제안 금지.",
  "sales_priority": "high | medium | low",
  "sales_priority_reason": "영업 우선순위 판단 근거",
  "confidence_score": 0-100,
  "reasoning_brief": "분석 근거 요약"
}

--- WEBSITE CONTENT ---
`;
