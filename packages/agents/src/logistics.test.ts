import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CampaignBrief, ShipmentProduct } from "@ss/contracts";
import { closeMongo, Collections, getDb } from "@ss/db";
import { memorySink, setObservabilitySink, startTrace } from "@ss/observability";
import {
  setCarrierClientFactory,
  setUsageStore,
  type CarrierClient,
  type UsageStore,
} from "@ss/capabilities";
import {
  runAgent,
  type AgentRunContext,
  type ModelClient,
  type ModelTurn,
} from "./index";
import { logisticsAgent } from "./logistics.agent";

/**
 * P3-C3 — logistics agent. Drives the agent through scripted Haiku
 * responses: one shipment.create tool call (or one escalation), then a
 * final text answer that echoes the tool's Shipment back. The carrier
 * client is faked via setCarrierClientFactory so no real carrier hit.
 */

const memUsageStore: UsageStore = {
  async increment() { return 1; },
  async decrement() {},
  async getOverride() { return null; },
};

const ctx0 = (): AgentRunContext => ({
  capabilityCtx: {
    workspaceId: "ws_log",
    userId: "u".repeat(21),
    campaignId: "camp_log_1",
    rateLimitClass: "default",
  },
  trace: startTrace("camp_log_1"),
});

const brief: CampaignBrief = {
  workspaceId: "ws_log",
  createdBy: "u".repeat(21),
  brandProduct: {
    name: "Hydra Serum",
    category: "skincare/serum",
    description: "수분 세럼",
    keyClaims: ["7-day hydration"],
  },
  targeting: {
    creatorCount: 1,
    minEngagementRate: 0.001,
    languages: ["ko"],
    hashtags: ["스킨케어"],
    excludeBlacklist: true,
  },
  logistics: { shipsSamples: true },
  goals: { targetLivePosts: 1, deadline: new Date("2026-08-01") },
};

const product: ShipmentProduct = {
  sku: "HS-30ML",
  name: "Hydra Serum 30ml",
  valueUsdCents: 2900,
  weightGrams: 80,
};

function fakeCarrier(): CarrierClient {
  let n = 0;
  return {
    async createShipment() {
      n++;
      return { trackingNumber: `YT${String(n).padStart(8, "0")}` };
    },
    async trackShipment() { return { events: [] }; },
  };
}

beforeAll(() => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set — start scripts/dev-mongo first");
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(Collections.V2_SHIPMENTS).deleteMany({});
  setObservabilitySink(memorySink());
  setUsageStore(memUsageStore);
  setCarrierClientFactory(async () => fakeCarrier());
});

afterEach(() => {
  setObservabilitySink(undefined);
  setUsageStore(undefined);
  setCarrierClientFactory(undefined);
});

afterAll(async () => { await closeMongo(); });

/** Scripted Haiku: 1 tool_use (shipment.create) + 1 final text echoing the result. */
function happyScript(parsedAddress: {
  recipientName: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}): ModelClient {
  let step = 0;
  return {
    complete: async ({ messages }) => {
      const at = step++;
      if (at === 0) {
        return {
          kind: "tool_use",
          toolUseId: "ship",
          toolName: "shipment.create",
          toolInput: {
            // Note: campaignId omitted — codex review P2#3 moved it to the
            // trusted ctx so a model can't file under a different campaign.
            creatorTrackId: "camp_log_1:cr_freshly",
            creatorId: "cr_freshly",
            carrier: "yuntrack",
            shippingAddress: parsedAddress,
            products: [product],
            reference: "Hydra/freshly",
            notes: "",
          },
          inputTokens: 80,
          outputTokens: 12,
        } satisfies ModelTurn;
      }
      // Echo the shipment.create result verbatim.
      const last = messages[messages.length - 1];
      const jsonPart = last?.content?.startsWith("Tool result for shipment.create")
        ? last.content.slice(last.content.indexOf("\n") + 1)
        : "{}";
      return {
        kind: "text",
        text: jsonPart,
        inputTokens: 80,
        outputTokens: 220,
      } satisfies ModelTurn;
    },
  };
}

describe("logisticsAgent — unit", () => {
  it("happy path: parses a Korean address, calls shipment.create, returns the Shipment", async () => {
    const ctx = ctx0();
    const parsed = {
      recipientName: "Jiwoo",
      phone: "+82-10-0000-0000",
      line1: "12 Garosu-gil",
      line2: "Apt 301",
      city: "Seoul",
      region: "Gangnam-gu",
      postalCode: "06000",
      countryCode: "KR",
    };
    const out = await runAgent(
      logisticsAgent,
      {
        brief,
        creatorTrackId: "camp_log_1:cr_freshly",
        creatorId: "cr_freshly",
        rawAddress: "서울 강남구 가로수길 12, 301호 우 06000  지우 010-0000-0000",
        products: [product],
      },
      { ...ctx, model: happyScript(parsed) },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.value.status).toBe("shipped");
    expect(out.value.trackingNumber).toBe("YT00000001");
    expect(out.value.shippingAddress.line1).toBe("12 Garosu-gil");
    expect(out.value.shippingAddress.countryCode).toBe("KR");

    // Trace: exactly one shipment.create tool span.
    const tools = ctx.trace.spans.filter((s) => s.name === "tool:shipment.create");
    expect(tools).toHaveLength(1);
  });

  it("escalation: address_unparseable surfaces verbatim from the runtime", async () => {
    const escalator: ModelClient = {
      complete: async () => ({
        kind: "text",
        text: JSON.stringify({ escalate: "address_unparseable: missing postalCode" }),
        inputTokens: 40,
        outputTokens: 12,
      }),
    };
    const out = await runAgent(
      logisticsAgent,
      {
        brief,
        creatorTrackId: "camp_log_1:cr_x",
        creatorId: "cr_x",
        rawAddress: "어딘가에", // junk
        products: [product],
      },
      { ...ctx0(), model: escalator },
    );
    expect(out.kind).toBe("escalate");
    if (out.kind !== "escalate") throw new Error("expected escalate");
    expect(out.reason).toMatch(/address_unparseable/);
  });

  it("agent definition: Haiku, single tool, sub-$0.10 cap", () => {
    expect(logisticsAgent.model).toBe("claude-haiku-4-5");
    expect(logisticsAgent.tools).toEqual(["shipment.create"]);
    expect(logisticsAgent.maxUsd).toBeLessThanOrEqual(0.1);
  });
});
