// Campaign detail = Mission Control timeline + approval inbox for one campaign.
// Replaces v1's 6-step workflow board: the steps still exist as a read-only
// stage indicator, but the body is "what the agents did / what needs you".
// SKELETON — see docs/PHASE-1-PLAN.md tasks W3–W4.
export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: 24 }}>
      <h1>Campaign {id}</h1>
      <section>
        <h2>Stage</h2>
        <p style={{ color: "#666" }}>overview → sourcing → outreach → shipping → content_review → performance (read-only progress)</p>
      </section>
      <section>
        <h2>Activity timeline</h2>
        <p style={{ color: "#666" }}>Reverse-chron feed of agent spans (from V2_AGENT_TRACES): every search, vet, send, reply-classification.</p>
      </section>
      <section>
        <h2>Needs you</h2>
        <p style={{ color: "#666" }}>Open approvals for this campaign with pre-filled recommendations.</p>
      </section>
    </main>
  );
}
