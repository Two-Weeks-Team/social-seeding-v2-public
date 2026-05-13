// Workspace autonomy policy editor — the gates (always_ask / auto / auto_unless),
// budget caps, brand voice notes, banned phrases. This is where "minimize human
// intervention" gets dialed in per workspace. Default: every gate on.
// SKELETON — see docs/PHASE-1-PLAN.md task W5 and packages/contracts/src/policy.ts.
export default function PoliciesPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <h1>Autonomy policy</h1>
      <p style={{ color: "#666" }}>Per-gate mode, per-campaign / monthly USD caps, brand voice, banned phrases.</p>
    </main>
  );
}
