import { creatorRepo } from "@ss/db";
import { creatorLabel } from "./format";

/**
 * Resolve a set of track creatorIds → display profile (handle + nickname +
 * avatar) by joining the shared accounts_tiktok collection. Tracks only store
 * `creatorId`; this is the single place MC views turn that into a face + name.
 * Unknown ids fall back to creatorLabel() (never a raw secUid). One query.
 */
export interface CreatorView {
  handle: string;
  nickname?: string;
  avatar?: string;
  followers?: number;
}

export async function resolveCreators(ids: Array<string | null | undefined>): Promise<Map<string, CreatorView>> {
  const uniq = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const map = new Map<string, CreatorView>();
  let docs: Awaited<ReturnType<typeof creatorRepo.listByIds>> = [];
  try {
    docs = await creatorRepo.listByIds(uniq);
  } catch {
    docs = [];
  }
  const byId = new Map(docs.map((d) => [d.id, d]));
  const byHandle = new Map(docs.map((d) => [d.uniqueId, d]));
  for (const id of uniq) {
    const d = byId.get(id) ?? byHandle.get(id) ?? byHandle.get(id.replace(/^@/, ""));
    if (d) {
      map.set(id, {
        handle: d.uniqueId ? (d.uniqueId.startsWith("@") ? d.uniqueId : `@${d.uniqueId}`) : creatorLabel(id),
        nickname: d.nickname || undefined,
        avatar: d.avatarThumb,
        followers: d.followerCount,
      });
    } else {
      map.set(id, { handle: creatorLabel(id) });
    }
  }
  return map;
}
