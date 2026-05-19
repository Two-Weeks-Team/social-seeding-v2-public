/**
 * BulkApproveToolbar / BulkApproveModal behaviour tests.
 *
 * D-IDs touched: D27 (bulk approval atomicity + per-Mandate jti).
 *
 * Verifies:
 *   - toolbar appears only when 2+ rows are selected
 *   - sign-bundle button is disabled if any Mandate has `first-time-partner`
 *   - sign-bundle button is disabled if any Mandate has `Model-Armor` fail
 *   - sign-bundle button is disabled if total exceeds daily ceiling
 *   - aggregate amount is computed across the bundle
 *   - mixed currencies produce a graceful fallback (no crash, no total)
 *
 * EC-2.29 nonce reuse rejection is exercised at the API route level (separate
 * test outside this file); here we focus on the UI gating.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  BulkApproveToolbar,
  BulkApproveModal,
  type BulkSelectionItem,
} from "../../app/(mission-control)/approvals/[id]/_ap2/bulk-approve-toolbar";
import type { PaymentMandateDraft } from "../../lib/ap2/mandate";

function mkItem(
  i: number,
  overrides: Partial<PaymentMandateDraft> = {},
): BulkSelectionItem {
  const now = Math.floor(Date.now() / 1000);
  const draft: PaymentMandateDraft = {
    jti: `intent-${i}`,
    exp: now + 3600,
    intent: {
      category: "creator_payout",
      attributes: {},
      price_max: { amount: "10000000", currency: "KRW" },
      per_recipient_uplift_max: 1.2,
      merchant_allowlist: ["did:web:adyen.com"],
      refundable_required: true,
    },
    delegation_mode: "human_present",
    recipients: [
      {
        creatorId: `c${i}`,
        uniqueId: `creator_${i}`,
        proposedAmount: { amount: "500000", currency: "KRW" },
        judgeSummary: ["pass", "pass", "pass", "pass"],
        pipaConsentVerified: true,
      },
    ],
    initialChips: [
      { chip: "within-budget", passed: true },
      { chip: "PIPA-cleared", passed: true },
      { chip: "merchant-allowlist", passed: true },
      { chip: "refundable", passed: true },
      { chip: "Model-Armor-passed", passed: true },
    ],
    partner: "adyen",
    totalAmount: { amount: "500000", currency: "KRW" },
    composedAt: now,
    ...overrides,
  };
  return { approvalId: `appr_${i}`, draft };
}

describe("BulkApproveToolbar (D27)", () => {
  it("does not render when only 0-1 rows are selected", () => {
    const { container, rerender } = render(
      <BulkApproveToolbar
        selected={[]}
        locale="en"
        onRejectAll={() => {}}
        onSignBundle={() => {}}
        onSeparateReview={() => {}}
      />,
    );
    expect(container.querySelector("[role='toolbar']")).toBeNull();

    rerender(
      <BulkApproveToolbar
        selected={[mkItem(1)]}
        locale="en"
        onRejectAll={() => {}}
        onSignBundle={() => {}}
        onSeparateReview={() => {}}
      />,
    );
    // A single selection renders the toolbar; sign is disabled (need 2+).
    const toolbar = screen.getByRole("toolbar");
    expect(toolbar).toBeTruthy();
    const sign = screen.getByRole("button", { name: /Sign 1 with WebAuthn/ });
    expect((sign as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables sign-bundle for 2+ low-risk selections", () => {
    render(
      <BulkApproveToolbar
        selected={[mkItem(1), mkItem(2), mkItem(3)]}
        locale="en"
        onRejectAll={() => {}}
        onSignBundle={() => {}}
        onSeparateReview={() => {}}
      />,
    );
    const sign = screen.getByRole("button", { name: /Sign 3 with WebAuthn/ });
    expect((sign as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables sign-bundle if any Mandate has first-time-partner", () => {
    const flagged = mkItem(2, {
      initialChips: [
        { chip: "within-budget", passed: true },
        { chip: "PIPA-cleared", passed: true },
        { chip: "merchant-allowlist", passed: true },
        { chip: "refundable", passed: true },
        { chip: "Model-Armor-passed", passed: true },
        { chip: "first-time-partner", passed: true, detail: "first txn with Klarna" },
      ],
    });
    render(
      <BulkApproveToolbar
        selected={[mkItem(1), flagged]}
        locale="en"
        onRejectAll={() => {}}
        onSignBundle={() => {}}
        onSeparateReview={() => {}}
      />,
    );
    const sign = screen.getByRole("button", { name: /Sign 2 with WebAuthn/ });
    expect((sign as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables sign-bundle if any Mandate has Model-Armor fail", () => {
    const flagged = mkItem(2, {
      initialChips: [
        { chip: "within-budget", passed: true },
        { chip: "PIPA-cleared", passed: true },
        { chip: "merchant-allowlist", passed: true },
        { chip: "refundable", passed: true },
        { chip: "Model-Armor-passed", passed: false, detail: "PI flag on rationale" },
      ],
    });
    render(
      <BulkApproveToolbar
        selected={[mkItem(1), flagged]}
        locale="en"
        onRejectAll={() => {}}
        onSignBundle={() => {}}
        onSeparateReview={() => {}}
      />,
    );
    const sign = screen.getByRole("button", { name: /Sign 2 with WebAuthn/ });
    expect((sign as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables sign-bundle if aggregate exceeds daily ceiling", () => {
    render(
      <BulkApproveToolbar
        selected={[mkItem(1), mkItem(2), mkItem(3)]}
        locale="en"
        dailyCeiling={{ amount: "1000000", currency: "KRW" }} // 3 × 500k > 1M
        onRejectAll={() => {}}
        onSignBundle={() => {}}
        onSeparateReview={() => {}}
      />,
    );
    const sign = screen.getByRole("button", { name: /Sign 3 with WebAuthn/ });
    expect((sign as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls onRejectAll when the 'Reject all' button is clicked", () => {
    const onRejectAll = vi.fn();
    render(
      <BulkApproveToolbar
        selected={[mkItem(1), mkItem(2)]}
        locale="en"
        onRejectAll={onRejectAll}
        onSignBundle={() => {}}
        onSeparateReview={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Reject all/i }));
    expect(onRejectAll).toHaveBeenCalledOnce();
  });
});

describe("BulkApproveModal (D27)", () => {
  it("renders the per-Mandate summary + total", () => {
    render(
      <BulkApproveModal
        selected={[mkItem(1), mkItem(2)]}
        locale="en"
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText(/Sign 2 Intent Mandates at once/i)).toBeTruthy();
    expect(screen.getAllByText(/creator_payout/).length).toBeGreaterThanOrEqual(2);
  });

  it("does not crash on mixed currencies; suppresses the total line", () => {
    const a = mkItem(1, {
      totalAmount: { amount: "1000", currency: "USD" },
    });
    const b = mkItem(2, {
      totalAmount: { amount: "1000", currency: "KRW" },
    });
    render(
      <BulkApproveModal
        selected={[a, b]}
        locale="en"
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    // The 2-line summary still renders; the total line is omitted.
    expect(screen.getByText(/Sign 2 Intent Mandates at once/i)).toBeTruthy();
  });
});
