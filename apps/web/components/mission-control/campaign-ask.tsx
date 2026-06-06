"use client";

import { useState } from "react";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { cn } from "@/lib/cn";

/**
 * 에이전트에게 물어보기 — read-only campaign Q&A (POST /api/campaigns/[id]/ask →
 * campaignAssistantAgent, Gemini 3.5 Flash). The agent answers, never acts; this
 * UI just renders the back-and-forth + source chips. Honest states: loading,
 * 503 (assistant unavailable), generic error.
 */
type Turn = { role: "user" | "assistant"; content: string; citations?: string[] };

const SUGGESTIONS = ["성과 요약해줘", "어떤 크리에이터가 제일 잘했어?", "답장 기다리는 사람 있어?"];

export function CampaignAsk({ campaignId }: { campaignId: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || loading) return;
    setError(null);
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((prev) => [...prev, { role: "user", content: text }]);
    setQ("");
    setLoading(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, history }),
      });
      const data = (await res.json().catch(() => ({}))) as { answer?: string; citations?: string[]; reason?: string; error?: string };
      if (!res.ok) {
        setError(data.reason || data.error || "응답을 가져오지 못했습니다.");
      } else {
        setTurns((prev) => [...prev, { role: "assistant", content: data.answer ?? "", citations: data.citations ?? [] }]);
      }
    } catch {
      setError("네트워크 오류로 응답을 가져오지 못했습니다.");
    }
    setLoading(false);
  }

  return (
    <Card>
      <CardBody>
        <SectionLabel className="mb-3">에이전트에게 물어보기</SectionLabel>
        {turns.length === 0 ? (
          <p className="text-[12.5px] text-ink-2 mb-3">이 캠페인의 성과·크리에이터·진행 상황을 자연어로 물어보세요. <span className="text-ink-3">(읽기 전용 — 에이전트는 답만 하고 실행은 하지 않습니다)</span></p>
        ) : (
          <div className="space-y-3 mb-3">
            {turns.map((t, i) => (
              <div key={i} className={cn(t.role === "user" ? "text-right" : "text-left")}>
                <div className={cn("inline-block max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-left", t.role === "user" ? "bg-brand-soft text-ink" : "bg-surface-2 text-ink")}>
                  {t.content}
                  {t.citations && t.citations.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {t.citations.map((c, j) => (
                        <span key={j} className="text-[10.5px] text-ink-3 border border-line rounded-full px-1.5 py-0.5">{c}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && <div className="text-[12.5px] text-ink-3">에이전트가 확인 중…</div>}
          </div>
        )}

        {error && <div className="text-[12px] text-stop mb-2.5">{error}</div>}

        {turns.length === 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                disabled={loading}
                className="text-[12px] text-ink-2 border border-line rounded-full px-3 py-1 hover:bg-surface-2 transition-colors disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={loading}
            maxLength={500}
            placeholder="이 캠페인에 대해 물어보세요…"
            className="flex-1 bg-surface border border-line rounded-xl px-3.5 py-2 text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-brand-ink/40"
          />
          <button
            type="submit"
            disabled={loading || !q.trim()}
            className="rounded-xl bg-brand text-white text-[13px] font-medium px-4 py-2 disabled:opacity-50 shadow-brand"
          >
            {loading ? "…" : "전송"}
          </button>
        </form>
      </CardBody>
    </Card>
  );
}
