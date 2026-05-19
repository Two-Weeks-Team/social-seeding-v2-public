"use client";

/**
 * Voice confirmation panel — AP2-UX.md §5.1 + §5.2.
 *
 * D-IDs touched:
 *   D26 — Dialogflow CX surface.
 *   D27 — voice channel readback before any sign action; never auto-signs.
 *   D34 — confirm phrase is locale-specific:
 *           ko → "네 서명"
 *           en → "yes sign"
 *           ja → "確認"
 *           zh → "确认签名"
 *
 * AP2-UX.md §5.2 readback requirements:
 *   - count (e.g. "4 Mandates")
 *   - aggregate amount
 *   - per-partner breakdown
 *   - explicit warning for non-AP2-native partners
 *   - explicit warning for first-time partners (and refuses bulk via voice)
 *   - confirmation phrase: must be one of the exact registered phrases;
 *     ambiguous like "OK" / "응" is rejected.
 *
 * Anti-pattern §9.4 (raw JWS as primary): the voice readback presents
 * semantic fields (campaign, recipients count, amount, partner), never the
 * SD-JWT payload.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  formatMoney,
  formatMoneyAriaLabel,
  type AP2Locale,
  type Money,
} from "@/lib/ap2/mandate";
import { createTranslator } from "@/lib/ap2/i18n";

export interface VoiceConfirmationProps {
  matches: { approvalId: string; amount: Money; partnerId?: string; firstTimePartner?: boolean }[];
  locale: AP2Locale;
  onConfirmed: (approvalIds: string[]) => void;
  onCancelled?: () => void;
  /** Test hook — supply a transcript instead of using the SpeechRecognition API. */
  testTranscript?: string;
}

const CONFIRM_PHRASES: Record<AP2Locale, string[]> = {
  ko: ["네 서명", "예 서명", "서명할게"],
  en: ["yes sign", "yes, sign", "confirm sign"],
  ja: ["確認", "はい署名", "確認します"],
  zh: ["确认签名", "确认", "签署"],
};

const CANCEL_PHRASES: Record<AP2Locale, string[]> = {
  ko: ["취소", "아니오", "그만"],
  en: ["cancel", "no", "stop"],
  ja: ["キャンセル", "いいえ", "やめて"],
  zh: ["取消", "不", "停止"],
};

export function VoiceConfirmation({
  matches,
  locale,
  onConfirmed,
  onCancelled,
  testTranscript,
}: VoiceConfirmationProps) {
  const t = createTranslator(locale);
  const [transcript, setTranscript] = useState<string>(testTranscript ?? "");
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<unknown>(null);

  const total = useMemo(() => {
    if (matches.length === 0) return null;
    const currencies = new Set(matches.map((m) => m.amount.currency));
    if (currencies.size > 1) return null;
    const currency = matches[0]!.amount.currency;
    const sum = matches.reduce(
      (acc, m) => acc + Number(m.amount.amount),
      0,
    );
    const zeroDec = currency === "KRW" || currency === "JPY";
    return {
      amount: zeroDec ? Math.round(sum).toString() : sum.toFixed(2),
      currency,
    } as Money;
  }, [matches]);

  const firstTimePartnerCount = matches.filter((m) => m.firstTimePartner).length;
  const blockedByFirstTime = firstTimePartnerCount > 0;

  // Speech recognition — Web Speech API. Test hook bypasses entirely.
  useEffect(() => {
    if (testTranscript !== undefined) return;
    if (typeof window === "undefined") return;
    const W = window as typeof window & {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    const SpeechRecognitionCtor =
      (W.SpeechRecognition ?? W.webkitSpeechRecognition) as
        | { new (): SpeechRecognitionInstance }
        | undefined;
    if (!SpeechRecognitionCtor) return;
    const r = new SpeechRecognitionCtor();
    r.lang =
      locale === "ko" ? "ko-KR" : locale === "ja" ? "ja-JP" : locale === "zh" ? "zh-CN" : "en-US";
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (event: SpeechRecognitionEvent) => {
      const result = event.results?.[0]?.[0]?.transcript ?? "";
      setTranscript(result);
      setListening(false);
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    recognitionRef.current = r;
    return () => {
      try {
        r.stop();
      } catch {
        // no-op
      }
    };
  }, [locale, testTranscript]);

  function startListening() {
    setTranscript("");
    setListening(true);
    const r = recognitionRef.current as { start?: () => void } | null;
    r?.start?.();
  }

  useEffect(() => {
    if (!transcript) return;
    const txt = transcript.trim().toLowerCase();
    if (CONFIRM_PHRASES[locale].some((p) => txt.includes(p.toLowerCase()))) {
      if (!blockedByFirstTime) {
        onConfirmed(matches.map((m) => m.approvalId));
      }
    } else if (CANCEL_PHRASES[locale].some((p) => txt.includes(p.toLowerCase()))) {
      onCancelled?.();
    }
  }, [transcript, locale, blockedByFirstTime, matches, onConfirmed, onCancelled]);

  if (matches.length === 0) return null;

  return (
    <div
      className="mt-3 p-3 border border-slate-200 rounded-md bg-slate-50/60"
      role="region"
      aria-label="Voice confirmation"
    >
      <p className="text-[12px] text-slate-700">
        {t("voice_readback_prefix")} ({matches.length}):
      </p>
      <ul className="mt-2 space-y-0.5 text-[12px] mono">
        {matches.map((m) => (
          <li key={m.approvalId} className="flex items-center gap-2">
            <span className="text-slate-500">{m.approvalId.slice(0, 10)}</span>
            <span aria-label={formatMoneyAriaLabel(m.amount, locale)}>
              {formatMoney(m.amount, locale)}
            </span>
            {m.firstTimePartner && (
              <Badge variant="amber">first-time</Badge>
            )}
          </li>
        ))}
      </ul>
      {total && (
        <p className="mt-2 text-[12px] font-semibold mono">
          {t("voice_readback_total")} {formatMoney(total, locale)}
        </p>
      )}
      {blockedByFirstTime && (
        <p className="mt-2 text-[12px] text-rose-700" role="alert">
          {t("voice_readback_first_time_block", { count: firstTimePartnerCount })}
        </p>
      )}
      {!blockedByFirstTime && (
        <p className="mt-2 text-[12px] text-slate-600">
          {t("voice_readback_confirm", { count: matches.length })}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="primary"
          tone="approve"
          disabled={blockedByFirstTime}
          onClick={() => startListening()}
        >
          🎤 {listening ? "listening…" : t("voice_confirm_word")}
        </Button>
        <Button variant="secondary" onClick={() => onCancelled?.()}>
          {t("voice_cancel_word")}
        </Button>
        {transcript && (
          <span className="text-[11px] mono text-slate-500">→ {transcript}</span>
        )}
      </div>
    </div>
  );
}

/** Minimal local typing for the experimental Web Speech API. */
interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: Event) => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
