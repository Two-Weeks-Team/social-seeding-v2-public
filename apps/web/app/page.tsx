/**
 * Mission Control home. In v2 this is the primary surface: not a tool dashboard
 * but a control room — campaigns in flight, the approval inbox, what every agent
 * did. The v1 pages (search, campaign board, email center, analytics) survive
 * only as drill-down / manual-override views reachable from here.
 *
 * SKELETON — see docs/PHASE-1-PLAN.md tasks W1–W4.
 */
export default function MissionControlHome() {
  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "48px 24px", lineHeight: 1.6 }}>
      <h1>Social Seeding — Mission Control</h1>
      <p style={{ color: "#555" }}>
        Agent-orchestrated TikTok influencer campaign operator (v2). This is a skeleton — the real
        surface has three regions:
      </p>
      <ul>
        <li>
          <strong>Campaigns in flight</strong> — each with a live timeline of agent activity (sourced 38 →
          vetted → shortlisted 22; sent outreach to @x/@y/@z; @x replied: interested…).
        </li>
        <li>
          <strong>Approval inbox</strong> — batched decisions with the agent&apos;s recommendation
          pre-filled: approve / edit / reject in one click. Configurable per workspace (turn a gate off
          → that step runs autonomously).
        </li>
        <li>
          <strong>Policies</strong> — the autonomy boundaries: which gates are on, budget caps, brand
          voice notes, banned phrases.
        </li>
      </ul>
      <p>
        New campaign → start a brief intake conversation (replaces v1&apos;s 6-tab form), then the
        <code> brand-campaign </code> durable workflow takes over.
      </p>
      <p style={{ fontSize: 14, color: "#888" }}>See <code>docs/ARCHITECTURE.md</code> and <code>docs/ROADMAP.md</code>.</p>
    </main>
  );
}
