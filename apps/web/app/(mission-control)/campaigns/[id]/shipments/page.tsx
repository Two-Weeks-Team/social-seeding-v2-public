import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Card, CardBody, SectionLabel } from "@/components/ui/card";
import { getServerSession } from "@/lib/auth";
import { campaignRepo, shipmentRepo } from "@ss/db";
import type { Shipment, ShipmentStatus } from "@ss/contracts";

/**
 * /campaigns/[id]/shipments — Phase 3 shipment list view. One row per
 * v2_shipments doc for this campaign, sorted by updatedAt desc (matches
 * shipmentRepo.listByCampaign). Each row links to the per-shipment thread
 * (creator-track timeline view) when that lands; for now it just expands
 * the tracking-event timeline inline.
 *
 * CSV export is a 'Phase 3.5' nice-to-have; the demo path is the table.
 */

const STATUS_VARIANT: Record<ShipmentStatus, BadgeVariant> = {
  pending: "slate",
  address_pending: "amber",
  shipped: "blue",
  in_transit: "blue",
  out_for_delivery: "blue",
  delivered: "emerald",
  failed: "rose",
  returned: "rose",
  cancelled: "rose",
};

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
  return `${first.name} + ${s.products.length - 1}`;
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
  const byStatus = shipments.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <header className="mb-4">
        <Link
          href={`/campaigns/${id}`}
          className="text-[11px] text-slate-500 hover:text-slate-900"
        >
          ← {campaign.brief.brandProduct.name}
        </Link>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div>
            <SectionLabel>SHIPMENTS · {shipments.length} 건</SectionLabel>
            <h1 className="mt-1 text-[22px] font-semibold">{campaign.brief.brandProduct.name} 발송 현황</h1>
            <div className="mt-1 text-[12px] text-slate-500">
              총 신고가 {fmtUsd(totalValue)} · campaign id{" "}
              <span className="mono">{id.slice(0, 12)}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {(Object.entries(byStatus) as [ShipmentStatus, number][]).map(([s, n]) => (
              <Badge key={s} variant={STATUS_VARIANT[s] ?? "slate"}>
                {s} · {n}
              </Badge>
            ))}
          </div>
        </div>
      </header>

      {shipments.length === 0 ? (
        <Card>
          <CardBody className="text-[13px] text-slate-500 text-center py-12">
            아직 발송된 샘플이 없습니다. 트랙이 <span className="mono">address_collected</span> 단계에 들어가면 logistics 에이전트가 자동으로 carrier 에 핸드오프합니다.
          </CardBody>
        </Card>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="text-left px-3 py-2 font-medium">creator</th>
                <th className="text-left px-3 py-2 font-medium">상태</th>
                <th className="text-left px-3 py-2 font-medium">tracking</th>
                <th className="text-left px-3 py-2 font-medium">품목</th>
                <th className="text-right px-3 py-2 font-medium">신고가</th>
                <th className="text-left px-3 py-2 font-medium">출발</th>
                <th className="text-left px-3 py-2 font-medium">도착</th>
                <th className="text-left px-3 py-2 font-medium">최근 업데이트</th>
              </tr>
            </thead>
            <tbody>
              {shipments.map((s) => {
                const valueCents = s.products.reduce((a, p) => a + p.valueUsdCents, 0);
                return (
                  <tr key={s.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                    <td className="px-3 py-2.5 mono">{s.creatorId}</td>
                    <td className="px-3 py-2.5">
                      <Badge variant={STATUS_VARIANT[s.status] ?? "slate"}>{s.status}</Badge>
                    </td>
                    <td className="px-3 py-2.5 mono text-slate-700">{s.trackingNumber || "—"}</td>
                    <td className="px-3 py-2.5 text-slate-700">{summarizeProducts(s)}</td>
                    <td className="px-3 py-2.5 text-right mono">{fmtUsd(valueCents)}</td>
                    <td className="px-3 py-2.5 mono text-slate-600">{fmtDateShort(s.shippedAt)}</td>
                    <td className="px-3 py-2.5 mono text-slate-600">{fmtDateShort(s.deliveredAt)}</td>
                    <td className="px-3 py-2.5 mono text-slate-600">
                      {fmtDateShort(s.lastTrackedAt ?? s.updatedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Timeline expansion: show the most-recent shipment's event timeline.
          The full per-shipment view (/shipments/[id]) is a Phase-3.5 polish. */}
      {shipments[0] && shipments[0].trackingEvents.length > 0 && (
        <Card className="mt-6">
          <CardBody>
            <SectionLabel className="mb-2">
              최근 추적 이벤트 · {shipments[0].creatorId} · {shipments[0].trackingEvents.length} 건
            </SectionLabel>
            <ol className="text-[13px] space-y-2">
              {shipments[0].trackingEvents
                .slice()
                .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
                .slice(0, 8)
                .map((e, i) => (
                  <li key={`${e.timestamp.toISOString()}-${i}`} className="flex items-start gap-3">
                    <span className="mono text-[11px] text-slate-500 w-24 shrink-0">
                      {e.timestamp.toISOString().slice(0, 16).replace("T", " ")}
                    </span>
                    <span className="mono text-[11px] text-slate-500 w-20 shrink-0">{e.statusCode || "—"}</span>
                    <span className="text-slate-700 flex-1">
                      {e.description || "(no description)"}
                      {e.location && <span className="text-slate-400"> · {e.location}</span>}
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
