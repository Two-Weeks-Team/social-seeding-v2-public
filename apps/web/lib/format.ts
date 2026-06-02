/** Formatting helpers — Korean relative time + compact numbers. */

export function fmtAgo(when: Date | string | number): string {
  const t = when instanceof Date ? when.getTime() : new Date(when).getTime();
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return "방금 전";
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

/** 47210 → "47,210". */
export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

/** Compact Korean unit: 47210 → "47.2천", 1230000 → "123만". For headline KPIs. */
export function fmtCompactKo(n: number): { value: string; unit: string } {
  if (n >= 100_000_000) return { value: (n / 100_000_000).toFixed(1), unit: "억" };
  if (n >= 10_000) return { value: (n / 10_000).toFixed(1), unit: "만" };
  if (n >= 1_000) return { value: (n / 1_000).toFixed(1), unit: "천" };
  return { value: String(n), unit: "" };
}

/** Follower count: 165000 → "16.5만". */
export function fmtFollowers(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}만`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}천`;
  return String(n);
}

/**
 * Creator display — NEVER expose a raw TikTok numeric id or 60-char secUid as the
 * visible identity. Prefer a handle/name carried on the track; fall back to a
 * neutral placeholder, never the opaque token.
 */
export function creatorHandle(input: { handle?: string | null; uniqueId?: string | null } | string | null | undefined): string {
  if (!input) return "크리에이터";
  if (typeof input === "string") {
    // a bare string: treat as handle only if it looks like one (short, no long token)
    const s = input.trim();
    if (!s || s.length > 32 || /^[A-Za-z0-9+/_-]{24,}$/.test(s)) return "크리에이터";
    return s.startsWith("@") ? s : `@${s}`;
  }
  const h = input.handle ?? input.uniqueId;
  if (!h) return "크리에이터";
  return h.startsWith("@") ? h : `@${h}`;
}
