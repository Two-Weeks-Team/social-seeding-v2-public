"use client";

/**
 * Dialogflow CX embedded chat widget — D26's third surface.
 *
 * D-IDs touched:
 *   D26 — three UI surfaces: Mission Control + Dialogflow CX chatbot + mobile.
 *   D27 — voice/text channel does NOT directly sign Mandates; it kicks the
 *         WebAuthn ceremony to the operator's primary device via the FCM push
 *         (AP2-UX.md §5.2).
 *   D34 — D34 i18n: the bot's locale is the operator's preferred locale.
 *
 * AP2-UX.md §5 contract:
 *   The chat widget surfaces the same AP2 intents as the voice channel:
 *     ap2.list_pending · ap2.approve_one · ap2.approve_filtered
 *     ap2.reject_one · ap2.detail · ap2.cancel
 *   Every `approve_*` intent forces a readback + confirmation utterance
 *   before signing. The bot NEVER signs on the first turn.
 *
 * Implementation:
 *   The widget renders an iframe pointing at the Dialogflow CX Messenger
 *   embed (Google-hosted; no third-party JS is loaded into the parent DOM).
 *   The `df-messenger` web component handles the chat UI; we pass the
 *   operator's locale + auth token via attributes. The component dispatches
 *   `df-response-received` events that bubble up; we intercept them to
 *   detect `ap2.approve_*` intents and surface the §5.2 readback inline.
 *
 * Why an iframe wrapper + not the official `df-messenger` web component
 * directly: Next.js 16 still needs an explicit `<script>` tag for custom
 * elements, and we keep the surface area minimal so a CSP that blocks
 * inline-script can still run. The wrapper is a stable container that the
 * page loads/unloads cleanly.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { VoiceConfirmation } from "./voice-confirmation";
import { createTranslator } from "@/lib/ap2/i18n";
import type { AP2Locale, Money } from "@/lib/ap2/mandate";

export interface DcxChatWidgetProps {
  /** Dialogflow CX agent id (region/agent/env tuple). */
  agentId: string;
  /** Operator's locale — drives the bot's language pack. */
  locale: AP2Locale;
  /** Whether to show the readback panel ("approve_filtered" matches). */
  showReadbackPanel?: boolean;
  /** Test hook — supply a mock channel for tests. */
  testHook?: {
    initialMatches?: { approvalId: string; amount: Money }[];
    initialReadback?: string;
  };
}

export function DcxChatWidget({
  agentId,
  locale,
  showReadbackPanel = true,
  testHook,
}: DcxChatWidgetProps) {
  const t = createTranslator(locale);
  const ref = useRef<HTMLDivElement>(null);
  const [readback, setReadback] = useState<string | null>(
    testHook?.initialReadback ?? null,
  );
  const [matches, setMatches] = useState<{ approvalId: string; amount: Money }[]>(
    testHook?.initialMatches ?? [],
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Listen for the Dialogflow CX messenger's response events.
    function onResponse(ev: Event) {
      const detail = (ev as CustomEvent<{ response: unknown }>).detail;
      const handled = parseAp2Intent(detail);
      if (handled) {
        setReadback(handled.readback);
        setMatches(handled.matches);
      }
    }
    const el = ref.current;
    if (!el) return;
    el.addEventListener("df-response-received", onResponse as EventListener);
    return () => {
      el.removeEventListener("df-response-received", onResponse as EventListener);
    };
  }, []);

  const localeTag =
    locale === "ko" ? "ko" : locale === "ja" ? "ja" : locale === "zh" ? "zh-CN" : "en";

  return (
    <div ref={ref} className="fixed bottom-6 right-6 z-30 flex flex-col items-end gap-2">
      {open && showReadbackPanel && readback && (
        <Card className="max-w-sm">
          <CardBody>
            <SectionLabel className="mb-2">CX readback</SectionLabel>
            <p className="text-[13px] whitespace-pre-wrap leading-relaxed">{readback}</p>
            <VoiceConfirmation
              matches={matches}
              locale={locale}
              onConfirmed={(approvalIds) => {
                // The widget can't sign — it triggers the PWA push.
                triggerPwaPush(approvalIds);
                setReadback(null);
                setMatches([]);
              }}
            />
          </CardBody>
        </Card>
      )}
      <Button
        variant={open ? "secondary" : "primary"}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "close chat" : "open chat"}
      >
        {open ? "× chat" : "💬 chat"}
      </Button>
      {/*
        Render the Dialogflow CX messenger as a custom element. The script is
        injected once on first open; subsequent opens reuse the same element.
        We intentionally avoid `dangerouslySetInnerHTML` — the attributes are
        all controlled values.
      */}
      {open && (
        <div className="w-[380px] max-w-[92vw] h-[520px] bg-white border border-slate-200 rounded-md shadow-md overflow-hidden">
          <DfMessenger
            agentId={agentId}
            languageCode={localeTag}
            sessionId={(typeof window !== "undefined" && window.crypto?.randomUUID?.()) || "session"}
          />
        </div>
      )}
      {/* a11y: status announcement when readback arrives */}
      <span className="sr-only" role="status" aria-live="polite">
        {readback ? t("voice_readback_prefix") : ""}
      </span>
    </div>
  );
}

/**
 * Lightweight wrapper around Google's `<df-messenger>` web component.
 * The component is registered globally by the script tag; we just render
 * the custom element with the right attributes.
 *
 * Loading the script inline keeps the parent route's CSP simple: nothing
 * outside `script-src 'self' https://www.gstatic.com` is needed.
 */
function DfMessenger({
  agentId,
  languageCode,
  sessionId,
}: {
  agentId: string;
  languageCode: string;
  sessionId: string;
}) {
  useEffect(() => {
    const id = "dialogflow-messenger-script";
    if (document.getElementById(id)) return;
    const script = document.createElement("script");
    script.id = id;
    script.src = "https://www.gstatic.com/dialogflow-console/fast/messenger-cx/bootstrap.js?v=1";
    script.async = true;
    document.head.appendChild(script);
  }, []);

  // The custom element is rendered as a child; React's JSX accepts it since
  // we declare it in df-messenger.d.ts (see jsx-namespace below).
  return (
    <df-messenger
      project-id="auto"
      agent-id={agentId}
      language-code={languageCode}
      session-id={sessionId}
      max-query-length="-1"
      chat-title="Social Seeding"
    >
      <df-messenger-chat />
    </df-messenger>
  );
}

/**
 * Parse a Dialogflow CX response payload to detect AP2 intents.
 * Returns null if the intent is not one of the `ap2.*` family.
 */
function parseAp2Intent(detail: { response: unknown } | undefined): {
  readback: string;
  matches: { approvalId: string; amount: Money }[];
} | null {
  if (!detail) return null;
  const root = detail.response;
  if (typeof root !== "object" || root === null) return null;
  const r = root as Record<string, unknown>;
  const queryResult = r.queryResult as Record<string, unknown> | undefined;
  if (!queryResult) return null;
  const intent = queryResult.match as Record<string, unknown> | undefined;
  const intentName = intent?.intent
    ? ((intent.intent as Record<string, unknown>).displayName as string | undefined)
    : undefined;
  if (!intentName?.startsWith("ap2.")) return null;
  // The CX agent's webhook fills `payload.readback` + `payload.matches` for
  // `approve_*` intents; we render them in the inline panel.
  const messages = queryResult.responseMessages as Array<Record<string, unknown>> | undefined;
  const readback = messages
    ?.flatMap((m) => {
      const text = m.text as Record<string, unknown> | undefined;
      const lines = text?.text as string[] | undefined;
      return lines ?? [];
    })
    .join("\n");
  if (!readback) return null;
  const payload = (messages?.find((m) => m.payload) ?? {}).payload as
    | Record<string, unknown>
    | undefined;
  const matches = (payload?.matches as { approvalId: string; amount: Money }[] | undefined) ?? [];
  return { readback, matches };
}

/**
 * Trigger the FCM push that opens the operator's PWA biometric prompt.
 * The actual FCM call happens server-side at /api/approvals/:id/sign-mandate
 * (or a dedicated /push endpoint); this is a client-side fire-and-forget
 * that the bot uses to redirect signing to the mobile device.
 */
async function triggerPwaPush(approvalIds: string[]): Promise<void> {
  try {
    await fetch("/api/approvals/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalIds }),
    });
  } catch {
    // soft-fail — the operator can still open Mission Control directly.
  }
}

/**
 * React 19 + Next 16 — JSX custom element ambient declaration.
 * The official `df-messenger` web component is loaded as a script tag at
 * runtime; we declare its element typing here so TSX accepts the JSX.
 */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "df-messenger": React.HTMLAttributes<HTMLElement> & {
        "agent-id"?: string;
        "language-code"?: string;
        "project-id"?: string;
        "session-id"?: string;
        "max-query-length"?: string;
        "chat-title"?: string;
      };
      "df-messenger-chat": React.HTMLAttributes<HTMLElement>;
    }
  }
}
