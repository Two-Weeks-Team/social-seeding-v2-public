/**
 * Port of v1 `lib/security/prompt-guard.ts` — sanitize user-supplied text
 * BEFORE it reaches any agent prompt. Conservative: trims length, rejects
 * obvious prompt-injection patterns. Surfaces a clear error rather than
 * silently dropping content, so the API can return a 400 with a reason.
 */

const MAX_LEN = 4_000;

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?previous\s+(?:instructions|messages|prompts|system\s+messages?)/i,
  /\bsystem\s*:\s*you\s+are\b/i,
  /<\s*\/?\s*system\s*>/i,
  /you\s+are\s+now\s+(?:in\s+)?(?:dan|developer|admin|root)\s+mode/i,
  /disregard\s+(?:your|the|all)\s+(?:guidelines|rules|instructions|prompts)/i,
  /reveal\s+(?:your|the)\s+system\s+prompt/i,
];

export class PromptGuardError extends Error {
  constructor(readonly reason: string) {
    super(`prompt-guard: ${reason}`);
    this.name = "PromptGuardError";
  }
}

/** Returns the text untouched if it passes; throws PromptGuardError otherwise. */
export function promptGuard(text: string, fieldName = "input"): string {
  if (text.length > MAX_LEN) throw new PromptGuardError(`${fieldName} exceeds ${MAX_LEN} characters`);
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) throw new PromptGuardError(`${fieldName} contains a prompt-injection pattern`);
  }
  return text;
}
