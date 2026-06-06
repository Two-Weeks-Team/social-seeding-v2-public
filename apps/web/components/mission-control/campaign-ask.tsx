"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * 에이전트에게 물어보기 — a header trigger (✨ pill) that opens a right slide-over
 * chat panel, so it reads unmistakably as a conversation (not another data card).
 * Read-only Q&A (POST /api/campaigns/[id]/ask → campaignAssistantAgent). The agent
 * answers, never acts. Honest states: loading, 503 (assistant unavailable), error.
 */
type Turn = { role: "user" | "assistant"; content: string; citations?: string[] };

const SUGGESTIONS = ["성과 요약해줘", "어떤 크리에이터가 제일 잘했어?", "답장 기다리는 사람 있어?"];

export function CampaignAsk({ campaignId }: { campaignId: string }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-xl border border-brand-ink/25 bg-brand-soft px-3.5 py-2 text-[12.5px] font-medium text-brand-ink hover:bg-brand-soft/70 transition-colors"
      >
        <span aria-hidden>✨</span> 에이전트에게 물어보기
      </button>

      {open && (
        <>
      {/* backdrop */}
      <div className="fixed inset-0 bg-ink/20 z-40 ss-fade-in" onClick={() => setOpen(false)} aria-hidden />

      {/* slide-over panel */}
      <aside
        role="dialog"
        aria-label="에이전트에게 물어보기"
        className="fixed right-0 top-0 bottom-0 w-full max-w-[400px] bg-surface border-l border-line z-50 shadow-2xl flex flex-col ss-slide-in-right"
      >
        <header className="flex items-center gap-2.5 px-5 py-4 border-b border-line shrink-0">
          <span className="w-7 h-7 rounded-full bg-gradient-to-br from-brand to-brand-2 text-white grid place-items-center text-[13px] shrink-0" aria-hidden>✨</span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-bold text-ink leading-tight">에이전트에게 물어보기</div>
            <div className="text-[11px] text-ink-3">이 캠페인 · 읽기 전용 (답만, 실행은 안 함)</div>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="text-ink-3 hover:text-ink text-[16px] leading-none px-1" aria-label="닫기">✕</button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col">
          {turns.length === 0 ? (
            <div className="m-auto w-full max-w-[300px] text-center">
              <div className="mx-auto w-11 h-11 rounded-full bg-gradient-to-br from-brand to-brand-2 text-white grid place-items-center text-[18px] mb-3" aria-hidden>✨</div>
              <p className="text-[13px] text-ink-2">이 캠페인의 성과·크리에이터·진행 상황을<br />자연어로 물어보세요.</p>
              <div className="mt-3.5 flex flex-col gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => ask(s)}
                    disabled={loading}
                    className="text-[12.5px] text-ink-2 border border-line rounded-xl px-3 py-2 hover:bg-surface-2 transition-colors disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {turns.map((t, i) => (
                <div key={i} className={cn(t.role === "user" ? "text-right" : "text-left")}>
                  <div className={cn("inline-block max-w-[88%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-left", t.role === "user" ? "bg-brand-soft text-ink" : "bg-surface-2 text-ink")}>
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
        </div>

        {error && <div className="px-5 pb-1 text-[12px] text-stop shrink-0">{error}</div>}

        <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="border-t border-line p-3 flex items-center gap-2 shrink-0">
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
            className="rounded-xl bg-brand text-white text-[13px] font-medium px-4 py-2 disabled:opacity-50 shadow-brand shrink-0"
          >
            {loading ? "…" : "전송"}
          </button>
        </form>
      </aside>
        </>
      )}
    </>
  );
}
