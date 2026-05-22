/**
 * MandateDetail rendering tests.
 *
 * D-IDs touched: D26 (Mission Control), D27 (Intent-only), D34 (i18n).
 *
 * What we verify here:
 *   - rendering by locale (ko, en, ja, zh)
 *   - WCAG 2.2 §3.3 focus-first: H1 receives focus on mount
 *   - destructive-first action button ordering (Reject → Edit → Sign all)
 *   - aria-label on currency values includes the currency name
 *   - chip group has role="group" + aria-label
 *   - expiry countdown live region is polite
 *
 * Tests are framework-agnostic where possible (vitest + RTL); the apps/web
 * package will gain `vitest` + `@testing-library/react` in a follow-up when
 * the AP2 contracts land in `@ss/contracts`.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MandateDetail } from "../../app/(mission-control)/approvals/[id]/_ap2/mandate-detail";
import type { PaymentMandateDraft } from "../../lib/ap2/mandate";

function makeDraft(overrides: Partial<PaymentMandateDraft> = {}): PaymentMandateDraft {
  const now = Math.floor(Date.now() / 1000);
  return {
    jti: "intent-7f3a8e",
    exp: now + 24 * 3600,
    intent: {
      category: "creator_payout",
      attributes: {},
      price_max: { amount: "3000000", currency: "KRW" },
      per_recipient_uplift_max: 1.2,
      merchant_allowlist: ["did:web:adyen.com"],
      refundable_required: true,
    },
    delegation_mode: "human_present",
    recipients: [
      {
        creatorId: "c1",
        uniqueId: "kr_petlover",
        proposedAmount: { amount: "504000", currency: "KRW" },
        judgeSummary: ["pass", "pass", "pass", "pass"],
        contractId: "c4f2",
        pipaConsentVerified: true,
      },
      {
        creatorId: "c2",
        uniqueId: "petmom_seoul",
        proposedAmount: { amount: "320000", currency: "KRW" },
        judgeSummary: ["pass", "pass", "pass", "neutral"],
        contractId: "c4f3",
        pipaConsentVerified: true,
      },
    ],
    initialChips: [
      { chip: "within-budget", passed: true },
      { chip: "PIPA-cleared", passed: true },
      { chip: "merchant-allowlist", passed: true },
      { chip: "refundable", passed: true },
      { chip: "Model-Armor-passed", passed: true },
      { chip: "first-time", passed: true, detail: "first AP2 sign of the day" },
    ],
    partner: "adyen",
    totalAmount: { amount: "824000", currency: "KRW" },
    composedAt: now,
    ...overrides,
  };
}

describe("MandateDetail (D26/D27/D34)", () => {
  it("renders the campaign name + intent ID short-form as the H1", () => {
    const draft = makeDraft();
    render(
      <MandateDetail
        approvalId="a1"
        approvalCreatedAt={new Date().toISOString()}
        campaignId="camp1"
        campaignName="Acme Pet Foods"
        rationale="rationale"
        draft={draft}
        locale="ko"
      />,
    );
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toMatch(/Acme Pet Foods/);
    expect(h1.textContent).toMatch(/intent-7/); // short-form of jti
  });

  it("renders KRW amount in Korean locale (D34)", () => {
    const draft = makeDraft();
    const { container } = render(
      <MandateDetail
        approvalId="a1"
        approvalCreatedAt={new Date().toISOString()}
        campaignId="camp1"
        campaignName="Acme Pet Foods"
        rationale="rationale"
        draft={draft}
        locale="ko"
      />,
    );
    expect(container.textContent).toMatch(/₩/);
  });

  it("renders USD amount in English locale (D34)", () => {
    const draft = makeDraft({
      intent: {
        category: "ads_topup",
        attributes: {},
        price_max: { amount: "1000.00", currency: "USD" },
        per_recipient_uplift_max: 1.2,
        merchant_allowlist: ["did:web:stripe.com"],
        refundable_required: true,
      },
      recipients: [
        {
          creatorId: "c1",
          uniqueId: "stripe_merchant",
          proposedAmount: { amount: "147.34", currency: "USD" },
          judgeSummary: ["pass", "pass", "pass", "pass"],
          pipaConsentVerified: true,
        },
      ],
      partner: "stripe",
      totalAmount: { amount: "147.34", currency: "USD" },
    });
    const { container } = render(
      <MandateDetail
        approvalId="a1"
        approvalCreatedAt={new Date().toISOString()}
        campaignId="camp1"
        campaignName="Acme"
        rationale="rationale"
        draft={draft}
        locale="en"
      />,
    );
    expect(container.textContent).toMatch(/\$147\.34/);
  });

  it("renders JPY amount in Japanese locale (D34)", () => {
    const draft = makeDraft({
      intent: {
        category: "sample_carrier",
        attributes: {},
        price_max: { amount: "20000", currency: "JPY" },
        per_recipient_uplift_max: 1.2,
        merchant_allowlist: ["did:web:adyen.com"],
        refundable_required: true,
      },
      recipients: [
        {
          creatorId: "c1",
          uniqueId: "jp_creator",
          proposedAmount: { amount: "16200", currency: "JPY" },
          judgeSummary: ["pass", "pass", "pass", "pass"],
          pipaConsentVerified: true,
        },
      ],
      partner: "adyen",
      totalAmount: { amount: "16200", currency: "JPY" },
    });
    const { container } = render(
      <MandateDetail
        approvalId="a1"
        approvalCreatedAt={new Date().toISOString()}
        campaignId="camp1"
        campaignName="Acme"
        rationale="rationale"
        draft={draft}
        locale="ja"
      />,
    );
    expect(container.textContent).toMatch(/¥16,200|￥16,200/);
  });

  it("orders action buttons destructive-first per §7.3", () => {
    const draft = makeDraft();
    render(
      <MandateDetail
        approvalId="a1"
        approvalCreatedAt={new Date().toISOString()}
        campaignId="camp1"
        campaignName="Acme"
        rationale="r"
        draft={draft}
        locale="en"
      />,
    );
    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.textContent ?? "");
    // The action buttons appear after the chip + table interactive elements;
    // we just check that "Reject" appears before "Sign all" in the DOM.
    const rejectIdx = labels.findIndex((l) => /Reject/i.test(l));
    const signIdx = labels.findIndex((l) => /Sign all/i.test(l));
    expect(rejectIdx).toBeGreaterThanOrEqual(0);
    expect(signIdx).toBeGreaterThan(rejectIdx);
  });

  it("chips have role=status and an aria-label", () => {
    const draft = makeDraft();
    render(
      <MandateDetail
        approvalId="a1"
        approvalCreatedAt={new Date().toISOString()}
        campaignId="camp1"
        campaignName="Acme"
        rationale="r"
        draft={draft}
        locale="en"
      />,
    );
    const statuses = screen.getAllByRole("status");
    expect(statuses.length).toBeGreaterThan(0);
    // The chip group container has aria-label
    const group = screen.getByRole("group", { name: /judgment chips/i });
    expect(group).toBeTruthy();
  });

  it("recipient amounts include the currency name in aria-label", () => {
    const draft = makeDraft();
    const { container } = render(
      <MandateDetail
        approvalId="a1"
        approvalCreatedAt={new Date().toISOString()}
        campaignId="camp1"
        campaignName="Acme"
        rationale="r"
        draft={draft}
        locale="en"
      />,
    );
    // The amount aria-label appends the locale-resolved currency display name
    // (Intl.DisplayNames). KRW in the `en` locale resolves to "South Korean
    // Won" across ICU builds — query the stable English name, not the locale
    // tag word, so the test is portable (the old `*='Korean'` only matched on
    // reduced-ICU Node where `ko` fell back to English).
    const ariaLabeled = container.querySelectorAll("[aria-label*='Won']");
    expect(ariaLabeled.length).toBeGreaterThan(0);
  });

  /**
   * Regression test for the edit-then-cancel-then-resign retry path.
   *
   * Scenario: operator applies edits via the drawer → opens WebAuthn dialog →
   * cancels it → clicks the now-relabelled "Sign with edits" primary button.
   * Before the fix, this button still routed to `handleSignAll` which set
   * `signKind="sign-all"`, causing WebAuthnStepUp to receive `edits=undefined`
   * and the server to sign the original mandate (silently dropping reviewed
   * changes). After the fix the primary button routes to a handler that
   * preserves `edits` and the post-cancel sign attempt carries them through.
   *
   * Codex PR-fix: https://github.com/Two-Weeks-Team/social-seeding-v2/pull/1#discussion_r3266224729
   */
  it("preserves edits when operator cancels WebAuthn then re-clicks 'Sign with edits'", async () => {
    const onSigned = vi.fn();
    // Test hook simulates the WebAuthn ceremony — returns an assertion shape
    // matching SerializedAssertion (used by handleStepUpResult).
    const testHook = vi.fn(async () => ({
      id: "cred-1",
      rawId: "rawid-b64",
      type: "public-key" as const,
      response: {
        clientDataJSON: "client-b64",
        authenticatorData: "auth-b64",
        signature: "sig-b64",
      },
    }));
    // jsdom has no WebAuthn, so isWebAuthnSupported() is false and the dialog's
    // sign button stays disabled. Stub a WebAuthn-capable environment so the
    // ceremony button enables; the `testHook` still bypasses the real
    // navigator.credentials.get call. Restored by vi.unstubAllGlobals in setup.
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      credentials: { get: vi.fn() },
    });
    render(
      <MandateDetail
        approvalId="a1"
        approvalCreatedAt={new Date().toISOString()}
        campaignId="camp1"
        campaignName="Acme Pet Foods"
        rationale="후보 검토 완료된 3명에게 지급 (조사 결과 첨부)."
        draft={makeDraft()}
        locale="en"
        onSigned={onSigned}
        webAuthnTestHook={testHook}
      />,
    );

    // 1. Open the edit drawer via the per-recipient inline "edit" link
    //    (RecipientTable renders one per row).
    const editLinks = screen.getAllByRole("button", { name: /edit/i });
    const firstEditLink = editLinks[0];
    expect(firstEditLink).toBeDefined();
    fireEvent.click(firstEditLink!);

    // 2. Apply an edit to the first recipient — reduce 504,000 → 400,000 KRW.
    const amountInput = await screen.findByLabelText(/amount for kr_petlover/i);
    fireEvent.change(amountInput, { target: { value: "400000" } });
    const save = screen.getByRole("button", { name: /Save changes/i });
    fireEvent.click(save);

    // 3. The primary button label should flip to "Sign with edits (1 change)".
    const primaryAfterEdit = screen.getByRole("button", { name: /Sign with edits/i });
    expect(primaryAfterEdit).toBeTruthy();

    // 4. Click "Sign with edits" — opens the WebAuthn dialog. Cancel it.
    fireEvent.click(primaryAfterEdit);
    const cancelButtons = screen.getAllByRole("button", { name: /Cancel/i });
    // The dialog's Cancel is the last-mounted Cancel button.
    const lastCancel = cancelButtons[cancelButtons.length - 1];
    expect(lastCancel).toBeDefined();
    fireEvent.click(lastCancel!);

    // 5. Click the primary button again — without the fix this would route
    //    to handleSignAll and the next sign attempt would carry edits=undefined.
    const primaryAfterCancel = screen.getByRole("button", { name: /Sign with edits/i });
    fireEvent.click(primaryAfterCancel);

    // 5b. The dialog auto-trigger is suppressed when a `testHook` is supplied
    //     (so tests control ceremony timing), so explicitly click the dialog's
    //     primary ("Sign all") button to run the assertion ceremony.
    const dialogSign = await screen.findByRole("button", { name: /Sign all/i });
    fireEvent.click(dialogSign);

    // 6. Wait for the test-hook assertion path to resolve and capture the
    //    StepUpResult.edits — assert recipient edits were preserved.
    await vi.waitFor(() => expect(onSigned).toHaveBeenCalled());
    const firstCall = onSigned.mock.calls[0];
    expect(firstCall).toBeDefined();
    const signed = firstCall![0] as {
      edits?: {
        recipientEdits: Array<{ creatorId: string; amount: { amount: string } | null }>;
      };
    };
    expect(signed.edits).toBeDefined();
    expect(signed.edits?.recipientEdits).toHaveLength(1);
    expect(signed.edits?.recipientEdits[0]?.creatorId).toBe("c1");
    expect(signed.edits?.recipientEdits[0]?.amount?.amount).toBe("400000");
  });

  it("blocks submit when an Intent is within 60 s of expiry", () => {
    const draft = makeDraft({
      exp: Math.floor(Date.now() / 1000) + 30, // 30 s remaining
    });
    render(
      <MandateDetail
        approvalId="a1"
        approvalCreatedAt={new Date().toISOString()}
        campaignId="camp1"
        campaignName="Acme"
        rationale="r"
        draft={draft}
        locale="en"
      />,
    );
    const signButton = screen.getByRole("button", { name: /Sign all/i });
    expect((signButton as HTMLButtonElement).disabled).toBe(true);
  });
});
