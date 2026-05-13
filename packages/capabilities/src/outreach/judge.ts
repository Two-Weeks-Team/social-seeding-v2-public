import { z } from "zod";
import {
  JudgeKeySchema,
  JudgeScoreCardSchema,
  OutreachFactsSchema,
  type OutreachFacts,
} from "@ss/contracts";
import { defineCapability } from "../registry";
import { calculateSpamScore } from "../gmail/spam-score";

/**
 * outreach.judge — port of v1's 4-judge cold-mail tournament
 * (~/social-seeding/src/lib/cold-mail/judges.ts), adapted to the v2 single-
 * agent shape: each judge is a deterministic capability the Writer agent
 * calls as a tool, scores a draft against a closed fact set, and returns a
 * scorecard. The agent picks the angle with the best weighted sum
 * (JUDGE_WEIGHTS lives in @ss/contracts).
 *
 * v1's three "LLM-as-judge" judges (brand / conversion / skeptic) are
 * implemented here as RULE-BASED heuristics so the runtime stays
 * credential-free in tests; an LLM-backed variant is a Phase-2 follow-up
 * (the seam: each judge's `score()` is a pure function the upgrade can
 * wrap). The deliverability judge wraps the existing spam-score engine —
 * directly equivalent to v1's deterministic-with-LLM-veto design.
 *
 *   brand        : tone alignment + banned-phrases + brand-name mention
 *   conversion   : single CTA, specificity (cites the closed fact set),
 *                  length sanity (subject ≤ 80, body 200–1500), hook
 *   deliverability: spam-score(subject, body) inverted to [0,1]
 *   skeptic_recipient: 1st-person heuristic — penalize generic greetings,
 *                  vague flattery; reward concrete @mentions of the
 *                  creator's content (@handle, a recentPostTheme word,
 *                  or a real hashtag from the facts).
 *
 * The "facts" input is the OutreachFacts shape from `outreach.extractFacts`;
 * every audit check ("does the draft cite a real fact?") asks against THIS
 * input — the agent is never trusted to introspect itself.
 */

export const OutreachJudgeInputSchema = z.object({
  judge: JudgeKeySchema,
  draft: z.object({
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
  }),
  facts: OutreachFactsSchema,
  /** Optional per-workspace banned phrases (port of v1 voiceNotes deny-list). */
  bannedPhrases: z.array(z.string()).default([]),
});

/** Helpers — exported for tests + future LLM-backed wrappers. */
export const judgeHelpers = {
  /** count of "?" outside URLs (one CTA per email = sweet spot). */
  countQuestions(s: string): number {
    const stripped = s.replace(/https?:\/\/\S+/g, "");
    return (stripped.match(/\?/g) ?? []).length;
  },
  /** strip HTML tags + collapse whitespace; for length checks. */
  visibleText(html: string): string {
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  },
  /** does `text` cite anything that's actually in the closed fact set? */
  citesAnyFact(text: string, facts: OutreachFacts): boolean {
    const lower = text.toLowerCase();
    if (lower.includes(facts.creator.uniqueId.toLowerCase())) return true;
    if (lower.includes(facts.creator.nickname.toLowerCase())) return true;
    for (const tag of facts.creator.topHashtags) {
      if (lower.includes(tag.toLowerCase())) return true;
    }
    for (const theme of facts.creator.recentPostThemes) {
      // require at least 3 chars of the theme to overlap — avoid "the"-style
      // false positives from over-short themes.
      const t = theme.toLowerCase();
      if (t.length >= 3 && lower.includes(t.slice(0, Math.max(3, Math.floor(t.length * 0.6))))) {
        return true;
      }
    }
    if (facts.creator.signature && lower.includes(facts.creator.signature.toLowerCase())) return true;
    return false;
  },
};

function judgeBrand(args: {
  draft: { subject: string; body: string };
  facts: OutreachFacts;
  bannedPhrases: string[];
}): { score: number; rationale: string; flags: string[] } {
  const text = `${args.draft.subject}\n${args.draft.body}`.toLowerCase();
  const flags: string[] = [];
  let score = 1.0;

  if (!text.includes(args.facts.brand.name.toLowerCase())) {
    flags.push("brand_name_missing");
    score -= 0.4;
  }

  const hits = args.bannedPhrases.filter((p) => p && text.includes(p.toLowerCase()));
  if (hits.length > 0) {
    flags.push("banned_phrase_used");
    score -= Math.min(0.6, 0.2 * hits.length);
  }

  // sample-policy alignment: if shipsSamples is true, the draft should mention
  // sending / sample / sharing; if false, it should NOT mention free samples.
  const mentionsSample = /sample|sending|보내|샘플|선물/i.test(text);
  if (args.facts.logistics.shipsSamples && !mentionsSample) {
    flags.push("sample_offer_missing");
    score -= 0.1;
  } else if (!args.facts.logistics.shipsSamples && /free sample|무료 샘플/i.test(text)) {
    flags.push("sample_promised_against_policy");
    score -= 0.4;
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    rationale:
      flags.length === 0
        ? `Brand name '${args.facts.brand.name}' present, no banned phrases, sample policy aligned.`
        : `Brand-tone issues: ${flags.join(", ")}.`,
    flags,
  };
}

function judgeConversion(args: {
  draft: { subject: string; body: string };
  facts: OutreachFacts;
}): { score: number; rationale: string; flags: string[] } {
  const flags: string[] = [];
  let score = 1.0;
  const subject = args.draft.subject;
  const bodyText = judgeHelpers.visibleText(args.draft.body);

  if (subject.length === 0 || subject.length > 80) {
    flags.push("subject_length_out_of_band");
    score -= 0.2;
  }
  if (bodyText.length < 200) {
    flags.push("body_too_short");
    score -= 0.25;
  } else if (bodyText.length > 1500) {
    flags.push("body_too_long");
    score -= 0.2;
  }

  const qs = judgeHelpers.countQuestions(args.draft.body);
  if (qs === 0) {
    flags.push("no_cta");
    score -= 0.3;
  } else if (qs > 2) {
    flags.push("too_many_ctas");
    score -= 0.1;
  }

  if (!judgeHelpers.citesAnyFact(bodyText, args.facts)) {
    flags.push("no_specific_fact_cited");
    score -= 0.3;
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    rationale:
      flags.length === 0
        ? `Subject ≤80, body 200–1500 chars, one clear CTA, cites a fact from the closed set.`
        : `Conversion issues: ${flags.join(", ")}.`,
    flags,
  };
}

function judgeDeliverability(args: {
  draft: { subject: string; body: string };
}): { score: number; rationale: string; flags: string[] } {
  const spam = calculateSpamScore(args.draft.subject, args.draft.body, "");
  // map spam score [0,10] → judge score [1,0] inversely
  const score = Math.max(0, 1 - spam.score / 10);
  return {
    score,
    rationale: `Spam score ${spam.score}/10 (${spam.risk}). ${
      spam.triggered.length === 0
        ? "No rules fired."
        : `Rules fired: ${spam.triggered.map((h) => h.ruleId).join(", ")}.`
    }`,
    flags: spam.triggered.map((h) => `spam:${h.ruleId}`),
  };
}

function judgeSkeptic(args: {
  draft: { subject: string; body: string };
  facts: OutreachFacts;
}): { score: number; rationale: string; flags: string[] } {
  const flags: string[] = [];
  let score = 1.0;
  const text = `${args.draft.subject}\n${args.draft.body}`;
  const lower = text.toLowerCase();

  // generic greetings: a recipient sees these as "could be sent to anyone"
  const generics = ["dear creator", "dear influencer", "to whom it may concern", "안녕하세요 크리에이터님"];
  if (generics.some((g) => lower.includes(g))) {
    flags.push("generic_greeting");
    score -= 0.25;
  }

  // vague flattery: "great content", "love your videos" — without an @mention or theme cite
  const vagueFlattery = /(love (your )?content|great (videos|content)|amazing posts|big fan)/i;
  if (vagueFlattery.test(text) && !judgeHelpers.citesAnyFact(text, args.facts)) {
    flags.push("vague_flattery");
    score -= 0.3;
  }

  // concrete cite reward (cap the negative; can't go above 1)
  if (judgeHelpers.citesAnyFact(text, args.facts)) {
    score += 0.1;
  } else {
    flags.push("no_concrete_reference");
    score -= 0.35;
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    rationale:
      flags.length === 0
        ? `Reads like it was written FOR this creator: cites a real handle / theme / hashtag, no generic flattery.`
        : `Skeptic issues: ${flags.join(", ")}.`,
    flags,
  };
}

export const outreachJudge = defineCapability({
  name: "outreach.judge",
  description:
    "Score one outreach draft on a single dimension (brand / conversion / deliverability / skeptic_recipient). Deterministic heuristics; the agent calls all 4 and picks the weighted-best tournament winner.",
  scope: "read",
  idempotent: true,
  rateLimitClass: "default",
  input: OutreachJudgeInputSchema,
  output: JudgeScoreCardSchema,
  async handler({ judge, draft, facts, bannedPhrases }, _ctx) {
    switch (judge) {
      case "brand":
        return { judge: "brand" as const, ...judgeBrand({ draft, facts, bannedPhrases }) };
      case "conversion":
        return { judge: "conversion" as const, ...judgeConversion({ draft, facts }) };
      case "deliverability":
        return { judge: "deliverability" as const, ...judgeDeliverability({ draft }) };
      case "skeptic":
        return { judge: "skeptic" as const, ...judgeSkeptic({ draft, facts }) };
    }
  },
});
