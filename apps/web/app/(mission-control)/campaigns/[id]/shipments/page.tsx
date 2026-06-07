import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import { Stat } from "@/components/ui/stat";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { getServerSession } from "@/lib/auth";
import { campaignRepo, shipmentRepo } from "@ss/db";
import type { Shipment, ShipmentStatus } from "@ss/contracts";
import { creatorLabel } from "@/lib/format";

/**
 * /campaigns/[id]/shipments — shipment list view. One row per shipment doc for
 * this campaign, sorted by updatedAt desc (matches shipmentRepo.listByCampaign).
 * The most-recent shipment's tracking timeline expands inline below.
 *
 * Presentation only — data fetching preserved verbatim.
 */

/** ShipmentStatus → operator English label + status tone (color + text + dot). */
const STATUS_KO: Record<ShipmentStatus, { label: string; tone: StatusTone }> = {
  pending: { label: "Pending shipment", tone: "neutral" },
  address_pending: { label: "Waiting for address", tone: "warn" },
  shipped: { label: "Shipped", tone: "run" },
  in_transit: { label: "In transit", tone: "run" },
  out_for_delivery: { label: "Out for delivery", tone: "run" },
  delivered: { label: "Delivered", tone: "ok" },
  failed: { label: "Delivery failed", tone: "stop" },
  returned: { label: "Returned", tone: "stop" },
  cancelled: { label: "Cancelled", tone: "stop" },
};
function shipmentStatus(s: ShipmentStatus): { label: string; tone: StatusTone } {
  return STATUS_KO[s] ?? { label: s, tone: "neutral" };
}

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDateShort(d?: Date): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}

function summarizeProducts(s: Shipment): string {
  if (s.products.length === 0) return "—";
  const first = s.products[0]!;
  if (s.products.length === 1) return first.name;
  return `${first.name} + ${s.products.length - 1} more`;
}

export default async function CampaignShipmentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;
  const campaign = await campaignRepo.get(id);
  if (!campaign || campaign.brief.workspaceId !== session.workspaceId) notFound();
  const shipments = await shipmentRepo.listByCampaign(id).catch(() => []);

  const totalValue = shipments.reduce(
    (sum, s) => sum + s.products.reduce((a, p) => a + p.valueUsdCents, 0),
    0,
  );
  const deliveredCount = shipments.filter((s) => s.status === "delivered").length;
  const inTransitCount = shipments.filter(
    (s) => s.status === "shipped" || s.status === "in_transit" || s.status === "out_for_delivery",
  ).length;
  const issueCount = shipments.filter(
    (s) => s.status === "failed" || s.status === "returned" || s.status === "cancelled",
  ).length;

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-6">
        <Link href={`/campaigns/${id}`} className="text-[12px] text-ink-3 hover:text-ink-2">
          ← {campaign.brief.brandProduct.name}
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.01em]">Shipment status</h1>
            <div className="mt-1 text-[12.5px] text-ink-3">
              {campaign.brief.brandProduct.name} · {shipments.length} shipments
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-6">
        <Stat label="Total shipments" value={shipments.length} tone={shipments.length > 0 ? "brand" : "muted"} />
        <Stat label="In transit" value={inTransitCount} tone={inTransitCount > 0 ? "default" : "muted"} />
        <Stat label="Delivered" value={deliveredCount} tone={deliveredCount > 0 ? "ok" : "muted"} />
        <Stat
          label="Shipping issues"
          value={issueCount}
          tone={issueCount > 0 ? "stop" : "muted"}
          hint={`${fmtUsd(totalValue)} declared value`}
        />
      </div>

      {shipments.length === 0 ? (
        <EmptyState
          title="No samples shipped yet"
          hint="Once creators confirm shipping addresses, samples are shipped automatically and progress appears here."
        />
      ) : (
        <Card>
          <CardBody className="px-0 py-0">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold border-b border-line bg-surface-2">
                  <th className="text-left px-4 py-2.5 font-semibold">Creator</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Status</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Tracking no.</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Items</th>
                  <th className="text-right px-4 py-2.5 font-semibold">Declared value</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Shipped</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Delivered</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Last update</th>
                </tr>
              </thead>
              <tbody>
                {shipments.map((s) => {
                  const valueCents = s.products.reduce((a, p) => a + p.valueUsdCents, 0);
                  const st = shipmentStatus(s.status);
                  const label = creatorLabel(s.creatorId);
                  return (
                    <tr key={s.id} className="border-b border-line-2 last:border-0 hover:bg-surface-2/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={label} size="sm" />
                          <span className="text-ink truncate">{label}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <StatusTag tone={st.tone} size="sm">{st.label}</StatusTag>
                      </td>
                      <td className="px-4 py-3 mono tnum text-ink-2">{s.trackingNumber || "—"}</td>
                      <td className="px-4 py-3 text-ink-2">{summarizeProducts(s)}</td>
                      <td className="px-4 py-3 text-right mono tnum text-ink">{fmtUsd(valueCents)}</td>
                      <td className="px-4 py-3 mono tnum text-ink-3">{fmtDateShort(s.shippedAt)}</td>
                      <td className="px-4 py-3 mono tnum text-ink-3">{fmtDateShort(s.deliveredAt)}</td>
                      <td className="px-4 py-3 mono tnum text-ink-3">
                        {fmtDateShort(s.lastTrackedAt ?? s.updatedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {/* Most-recent shipment's tracking timeline, expanded inline. */}
      {shipments[0] && shipments[0].trackingEvents.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>
              Latest tracking events · {creatorLabel(shipments[0].creatorId)}
            </CardTitle>
            <span className="text-[11px] text-ink-3">{shipments[0].trackingEvents.length} events</span>
          </CardHeader>
          <CardBody>
            <ol className="space-y-2.5">
              {shipments[0].trackingEvents
                .slice()
                .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
                .slice(0, 8)
                .map((e, i) => (
                  <li key={`${e.timestamp.toISOString()}-${i}`} className="flex items-start gap-3 text-[13px]">
                    <span className="mono tnum text-[11px] text-ink-3 w-28 shrink-0">
                      {e.timestamp.toISOString().slice(0, 16).replace("T", " ")}
                    </span>
                    <span className="text-ink-2 flex-1">
                      {e.description || "Status update"}
                      {e.location && <span className="text-ink-3"> · {e.location}</span>}
                    </span>
                  </li>
                ))}
            </ol>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
