"use client";

/**
 * WebAuthn step-up dialog — the biometric gate that signs an AP2 Intent
 * Mandate (or a Mandate bundle for §3.4 bulk approve).
 *
 * D-IDs touched:
 *   D27 — every sign action is a fresh WebAuthn ceremony; no caching (§9.3).
 *   D34 — high-value threshold defaults to per-locale per AP2-UX.md §3.6
 *         (operator-set workspace override accepted via `highValueThreshold`).
 *
 * AP2-UX.md §3.6 behaviours:
 *   - default: platform authenticator (Touch ID / Windows Hello).
 *   - ≥ high-value threshold: roaming authenticator (YubiKey / Titan).
 *   - first-of-day: forces re-auth (no session caching).
 *   - 3 failed attempts: lock operator out 5 min + page on-call security.
 *
 * Implementation note: this component is a CLIENT BOUNDARY. It composes the
 * WebAuthn options, runs `navigator.credentials.get`, serialises the
 * assertion, and POSTs to `/api/approvals/[id]/sign-mandate`. The server-side
 * verifier validates `+kb` (Key Binding) freshness, the nonce against the
 * approval's pending state, the assertion signature, and the cnf match.
 *
 * If WebAuthn is unsupported (e.g. SSR mock, headless preview), the dialog
 * shows a clear fallback message; tests pass an `onSuccessMock` to simulate
 * the assertion without touching `navigator.credentials`.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import {
  authenticatorTransportFor,
  buildAssertionOptions,
  isWebAuthnSupported,
  runWebAuthnCeremony,
  serializeAssertion,
  sha256,
  toErrorCode,
  type AuthenticatorTransportPref,
  type SerializedAssertion,
  type WebAuthnErrorCode,
} from "@/lib/ap2/webauthn";
import {
  formatMoney,
  formatMoneyAriaLabel,
  type AP2Locale,
  type MandateEdit,
  type Money,
} from "@/lib/ap2/mandate";
import { createTranslator } from "@/lib/ap2/i18n";

export interface StepUpResult {
  approvalId: string;
  nonce: string;
  assertion: SerializedAssertion;
  edits?: MandateEdit;
  transport: AuthenticatorTransportPref;
}

export interface WebAuthnStepUpProps {
  approvalId: string;
  amount: Money;
  /** Bundle nonce — UUIDv7. Caller generates so the same nonce travels with the request. */
  nonce: string;
  locale: AP2Locale;
  highValueThreshold?: Money;
  edits?: MandateEdit;
  onCancel: () => void;
  onSuccess: (result: StepUpResult) => void;
  /** Test-only — when present, used instead of `navigator.credentials.get`. */
  testHook?: (transport: AuthenticatorTransportPref) => Promise<SerializedAssertion>;
}

export function WebAuthnStepUp({
  approvalId,
  amount,
  nonce,
  locale,
  highValueThreshold,
  edits,
  onCancel,
  onSuccess,
  testHook,
}: WebAuthnStepUpProps) {
  const t = createTranslator(locale);
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [errorCode, setErrorCode] = useState<WebAuthnErrorCode | null>(null);
  const [attemptCount, setAttemptCount] = useState(0);
  const cancelRef = useRef<AbortController | null>(null);

  const transport = authenticatorTransportFor(amount, locale, highValueThreshold);
  const isHighValue = transport === "cross-platform";
  const supported = typeof window === "undefined" ? true : isWebAuthnSupported();

  useEffect(() => {
    return () => {
      cancelRef.current?.abort();
    };
  }, []);

  async function trigger() {
    setStatus("running");
    setErrorCode(null);
    try {
      let assertion: SerializedAssertion;
      if (testHook) {
        assertion = await testHook(transport);
      } else {
        // Real WebAuthn path. The challenge is the SHA-256 of
        // {approvalId, nonce, edits?} — binds the assertion to the
        // exact Mandate payload being signed (§9.3 — no replay across
        // Mandates).
        const challengeText = JSON.stringify({
          approvalId,
          nonce,
          edits: edits ?? null,
        });
        const challenge = await sha256(challengeText);
        const rpId = window.location.hostname;
        const options = buildAssertionOptions({
          challenge,
          rpId,
          allowCredentialIds: [], // empty = any registered credential for this RP
          transport,
          timeoutMs: 60_000,
        });
        assertion = await runWebAuthnCeremony(options);
      }
      onSuccess({ approvalId, nonce, assertion, edits, transport });
    } catch (e) {
      const code = toErrorCode(e);
      setErrorCode(code);
      setStatus("error");
      setAttemptCount((c) => c + 1);
    }
  }

  // Auto-trigger on mount if supported, so the platform's biometric UI appears
  // immediately (per AP2-UX.md §3.6 → "platform shows Face ID / Touch ID").
  // Tests skip auto-trigger by supplying a `testHook`.
  useEffect(() => {
    if (!testHook && supported && status === "idle") {
      void trigger();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const locked = attemptCount >= 3;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="webauthn-modal-title"
    >
      <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-6">
        <h2 id="webauthn-modal-title" className="text-[16px] font-semibold">
          {isHighValue
            ? t("webauthn_step_up_required")
            : t("webauthn_prompt")}
        </h2>
        <div className="mt-3">
          <SectionLabel className="mb-1">amount</SectionLabel>
          <p
            className="text-[18px] font-semibold mono"
            aria-label={formatMoneyAriaLabel(amount, locale)}
          >
            {formatMoney(amount, locale)}
          </p>
        </div>
        <Card className="mt-3">
          <CardBody>
            <SectionLabel className="mb-1">transport</SectionLabel>
            <p className="text-[12px] text-slate-700">
              {transport === "platform"
                ? "Touch ID / Windows Hello / Android biometric"
                : "Roaming authenticator (YubiKey / Titan)"}
            </p>
          </CardBody>
        </Card>

        {!supported && (
          <p
            className="mt-3 text-[12px] text-rose-700"
            role="alert"
          >
            {t("webauthn_unsupported")}
          </p>
        )}
        {errorCode && (
          <p
            className="mt-3 text-[12px] text-rose-700"
            role="alert"
            aria-live="assertive"
          >
            {t(errorCode)}
          </p>
        )}
        {locked && (
          <p
            className="mt-3 text-[12px] text-rose-700"
            role="alert"
            aria-live="assertive"
          >
            Locked out for 5 minutes — please contact security ops.
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("button_cancel")}
          </Button>
          {!locked && (
            <Button
              variant="primary"
              tone="approve"
              onClick={trigger}
              disabled={!supported || status === "running"}
              data-webauthn-retry={errorCode ?? undefined}
            >
              {status === "running" ? "…" : t("button_sign_all")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Helper for callers that don't render the dialog UI (e.g. bulk-approve
 * modal already has its own UI). Returns the StepUpResult on success.
 */
export async function performStepUp(input: {
  approvalIds: string[];
  amount: Money;
  nonce: string;
  locale: AP2Locale;
  highValueThreshold?: Money;
}): Promise<{ assertion: SerializedAssertion; transport: AuthenticatorTransportPref }> {
  const transport = authenticatorTransportFor(
    input.amount,
    input.locale,
    input.highValueThreshold,
  );
  const challengeText = JSON.stringify({
    approvalIds: input.approvalIds,
    nonce: input.nonce,
  });
  const challenge = await sha256(challengeText);
  const rpId =
    typeof window !== "undefined" ? window.location.hostname : "localhost";
  const options = buildAssertionOptions({
    challenge,
    rpId,
    allowCredentialIds: [],
    transport,
    timeoutMs: 60_000,
  });
  const credential = (await navigator.credentials.get({
    publicKey: options,
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("webauthn_cancelled");
  return { assertion: serializeAssertion(credential), transport };
}
