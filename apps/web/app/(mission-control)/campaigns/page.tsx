// Campaign list — replaces v1 `/campaigns`. Server component; reads campaignRepo.
// SKELETON — see docs/PHASE-1-PLAN.md task W2.
export default function CampaignsPage() {
  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: 24 }}>
      <h1>Campaigns</h1>
      <p style={{ color: "#666" }}>List of campaigns with status / stage / # tracks. &quot;New campaign&quot; → brief intake.</p>
    </main>
  );
}
