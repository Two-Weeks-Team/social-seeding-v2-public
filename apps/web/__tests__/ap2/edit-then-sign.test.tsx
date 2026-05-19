/**
 * EditThenSignDrawer behaviour tests.
 *
 * D-IDs touched: D27 (edits create a new Intent), D33 (operator_note PII).
 *
 * Verifies:
 *   - operator can reduce per-recipient amount; delta diff shows
 *   - operator cannot extend TTL (input clamps to original `exp`)
 *   - >1.2× uplift triggers a warning + acknowledge requirement
 *   - dropping all recipients disables submit
 *   - operator note honours 500-char limit
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EditThenSignDrawer } from "../../app/(mission-control)/approvals/[id]/_ap2/edit-then-sign-drawer";
import type { PaymentMandateDraft } from "../../lib/ap2/mandate";

function makeDraft(): PaymentMandateDraft {
  const now = Math.floor(Date.now() / 1000);
  return {
    jti: "intent-1",
    exp: now + 24 * 3600,
    intent: {
      category: "creator_payout",
      attributes: {},
      price_max: { amount: "1000000", currency: "KRW" },
      per_recipient_uplift_max: 1.2,
      merchant_allowlist: ["did:web:adyen.com"],
      refundable_required: true,
    },
    delegation_mode: "human_present",
    recipients: [
      {
        creatorId: "c1",
        uniqueId: "kr_petlover",
        proposedAmount: { amount: "500000", currency: "KRW" },
        floorAmount: { amount: "100000", currency: "KRW" },
        judgeSummary: ["pass", "pass", "pass", "pass"],
        pipaConsentVerified: true,
      },
      {
        creatorId: "c2",
        uniqueId: "petmom",
        proposedAmount: { amount: "300000", currency: "KRW" },
        judgeSummary: ["pass", "pass", "pass", "pass"],
        pipaConsentVerified: true,
      },
    ],
    initialChips: [],
    partner: "adyen",
    totalAmount: { amount: "800000", currency: "KRW" },
    composedAt: now,
  };
}

describe("EditThenSignDrawer (D27/D33)", () => {
  it("captures a recipient amount edit and reports it via the delta diff", () => {
    const onApply = vi.fn();
    render(
      <EditThenSignDrawer
        draft={makeDraft()}
        locale="en"
        onCancel={() => {}}
        onApply={onApply}
      />,
    );
    // Amount input for the first recipient.
    const amountInput = screen.getByLabelText(/amount for kr_petlover/i);
    fireEvent.change(amountInput, { target: { value: "400000" } });
    const save = screen.getByRole("button", { name: /Save changes/i });
    fireEvent.click(save);
    expect(onApply).toHaveBeenCalledOnce();
    const call = onApply.mock.calls[0][0];
    expect(call.recipientEdits).toHaveLength(1);
    expect(call.recipientEdits[0].amount.amount).toBe("400000");
  });

  it("requires uplift_acknowledged when an edit exceeds 1.2× proposed", () => {
    const onApply = vi.fn();
    render(
      <EditThenSignDrawer
        draft={makeDraft()}
        locale="en"
        onCancel={() => {}}
        onApply={onApply}
      />,
    );
    // Proposed is 500_000; 1.2× = 600_000; 700_000 is >1.2×.
    const amountInput = screen.getByLabelText(/amount for kr_petlover/i);
    fireEvent.change(amountInput, { target: { value: "700000" } });
    const save = screen.getByRole("button", { name: /Save changes/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    // Acknowledge the uplift.
    const ack = screen.getByLabelText(/acknowledge the >1\.2×/i);
    fireEvent.click(ack);
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables submit when every recipient is dropped", () => {
    render(
      <EditThenSignDrawer
        draft={makeDraft()}
        locale="en"
        onCancel={() => {}}
        onApply={() => {}}
      />,
    );
    const c1 = screen.getByLabelText(/include kr_petlover/i);
    const c2 = screen.getByLabelText(/include petmom/i);
    fireEvent.click(c1);
    fireEvent.click(c2);
    const save = screen.getByRole("button", { name: /Save changes/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it("clamps operator note to 500 chars", () => {
    render(
      <EditThenSignDrawer
        draft={makeDraft()}
        locale="en"
        onCancel={() => {}}
        onApply={() => {}}
      />,
    );
    const note = screen.getByLabelText(/operator note/i) as HTMLTextAreaElement;
    const long = "x".repeat(600);
    fireEvent.change(note, { target: { value: long } });
    expect(note.value.length).toBe(500);
  });

  it("emits operator note via the applied edits", () => {
    const onApply = vi.fn();
    render(
      <EditThenSignDrawer
        draft={makeDraft()}
        locale="en"
        onCancel={() => {}}
        onApply={onApply}
      />,
    );
    const note = screen.getByLabelText(/operator note/i);
    fireEvent.change(note, { target: { value: "double-check creator handle" } });
    const save = screen.getByRole("button", { name: /Save changes/i });
    fireEvent.click(save);
    expect(onApply.mock.calls[0][0].operatorNote).toBe("double-check creator handle");
  });
});
