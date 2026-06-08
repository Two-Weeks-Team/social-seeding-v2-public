import { ThreadMessageSchema, type ThreadMessage } from "@ss/contracts";
import { getDb } from "../client";
import { Collections } from "../collections";

/**
 * v2_messages reader — persisted creator email threads. Outbound = outreach /
 * replies the fleet sent; inbound = creator replies (resolved from the Gmail
 * webhook). Powers the "이메일 스레드" surface + the per-creator thread on the
 * campaign detail. Grouping into thread summaries is done in JS (the demo set is
 * small; switch to an aggregate pipeline if volume grows).
 */

export interface ThreadSummary {
  threadId: string;
  campaignId: string;
  creatorId: string;
  subject: string;
  lastSnippet: string;
  lastAt: Date;
  messageCount: number;
  lastDirection: ThreadMessage["direction"];
  lastClassification?: ThreadMessage["classification"];
}

async function col() {
  return (await getDb()).collection(Collections.V2_MESSAGES);
}

function toMessage(doc: Record<string, unknown> & { _id: unknown }): ThreadMessage | null {
  const { _id, ...rest } = doc;
  const parsed = ThreadMessageSchema.safeParse({ ...rest, id: String(_id) });
  return parsed.success ? parsed.data : null;
}

function summarize(messages: ThreadMessage[]): ThreadSummary[] {
  const byThread = new Map<string, ThreadMessage[]>();
  for (const m of messages) {
    const arr = byThread.get(m.threadId) ?? [];
    arr.push(m);
    byThread.set(m.threadId, arr);
  }
  const summaries: ThreadSummary[] = [];
  for (const [threadId, msgs] of byThread) {
    msgs.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    const first = msgs[0]!;
    const last = msgs[msgs.length - 1]!;
    const snippet = last.body.replace(/\s+/g, " ").trim().slice(0, 80);
    summaries.push({
      threadId,
      campaignId: first.campaignId,
      creatorId: first.creatorId,
      subject: first.subject,
      lastSnippet: snippet,
      lastAt: last.sentAt,
      messageCount: msgs.length,
      lastDirection: last.direction,
      lastClassification: last.classification,
    });
  }
  summaries.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
  return summaries;
}

async function fetch(filter: Record<string, unknown>): Promise<ThreadMessage[]> {
  const c = await col();
  const docs = (await c.find(filter).sort({ sentAt: 1 }).toArray()) as Array<Record<string, unknown> & { _id: unknown }>;
  return docs.map(toMessage).filter((m): m is ThreadMessage => m !== null);
}

export const messageRepo = {
  /** Ordered (oldest-first) messages for one thread, scoped to the workspace. */
  async listByThread(threadId: string, workspaceId: string): Promise<ThreadMessage[]> {
    return fetch({ threadId, workspaceId });
  },

  /** Thread summaries across a workspace, newest activity first. */
  async listThreadsByWorkspace(workspaceId: string): Promise<ThreadSummary[]> {
    return summarize(await fetch({ workspaceId }));
  },

  /** Thread summaries for one campaign (powers the per-creator link on detail). */
  async threadsByCampaign(campaignId: string, workspaceId: string): Promise<ThreadSummary[]> {
    return summarize(await fetch({ campaignId, workspaceId }));
  },
};
