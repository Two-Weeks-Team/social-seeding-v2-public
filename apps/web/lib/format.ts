/** Formatting helpers — English relative time + compact numbers. */

export function fmtAgo(when: Date | string | number): string {
  const t = when instanceof Date ? when.getTime() : new Date(when).getTime();
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** 47210 → "47,210". */
export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

/** Compact unit: 47210 → "47.2K", 1230000 → "1.2M". For headline KPIs. */
export function fmtCompactKo(n: number): { value: string; unit: string } {
  if (n >= 1_000_000_000) return { value: (n / 1_000_000_000).toFixed(1), unit: "B" };
  if (n >= 1_000_000) return { value: (n / 1_000_000).toFixed(1), unit: "M" };
  if (n >= 1_000) return { value: (n / 1_000).toFixed(1), unit: "K" };
  return { value: String(n), unit: "" };
}

/** Follower count: 165000 → "165.0K". */
export function fmtFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Creator display — NEVER expose a raw TikTok numeric id or 60-char secUid as the
 * visible identity. Prefer a handle/name carried on the track; fall back to a
 * neutral placeholder, never the opaque token.
 */
export function creatorHandle(input: { handle?: string | null; uniqueId?: string | null } | string | null | undefined): string {
  if (!input) return "Creator";
  if (typeof input === "string") {
    // a bare string: treat as handle only if it looks like one (short, no long token)
    const s = input.trim();
    if (!s || s.length > 32 || /^[A-Za-z0-9+/_-]{24,}$/.test(s)) return "Creator";
    return s.startsWith("@") ? s : `@${s}`;
  }
  const h = input.handle ?? input.uniqueId;
  if (!h) return "Creator";
  return h.startsWith("@") ? h : `@${h}`;
}

/**
 * Creator label for a track that only carries a raw creatorId (no handle in the
 * data model yet). If the id reads like a handle, show it as @handle; otherwise
 * show a short, distinguishable, human ref — NEVER the raw 60-char secUid token.
 */
export function creatorLabel(creatorId: string | null | undefined): string {
  const id = (creatorId ?? "").trim();
  if (!id) return "Creator";
  if (id.length <= 24 && !/^[A-Za-z0-9+/_-]{24,}$/.test(id) && /[a-z._]/i.test(id)) {
    return id.startsWith("@") ? id : `@${id}`;
  }
  return `Creator ·${id.slice(-4)}`;
}
