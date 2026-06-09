/**
 * simulate-campaign — a JUDGE-RUNNABLE, deterministic, minutes-long demo of the
 * FULL 6-stage brand campaign loop, watchable live in Mission Control.
 *
 * The real campaign loop spans days and external actors (creators reply, samples
 * ship, posts go up) — impossible for a judge to test live. This compresses it:
 *
 *   FRONT HALF (real workflow):  runs the REAL brandCampaignHandler — sourcing →
 *     vetting → shortlist → approveShortlist gate → CreatorTrack selection +
 *     traces. Agent DECISIONS are stubbed over REAL seeded creators (accounts_
 *     tiktok) so it never depends on live-LLM quota/format; pass --live-agents to
 *     use real Vertex instead.
 *
 *   BACK HALF (simulated external events): advances each track through outreach →
 *     reply → agree → ship → deliver → post → verify by writing the SAME records
 *     the creator-track workflow writes (v2_messages, track state transitions,
 *     CreatorTrackContent with a real cached cover), with a delay between stages
 *     so the MC timeline/funnel visibly fills. Then analytics.compile → completed.
 *
 * HONEST: the orchestration + records are real; the influencer replies, carrier
 * updates, and posts are simulated events, and (offline) the agent decisions are
 * canned. Nothing here claims a live external send.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27027/instarsearch \
 *   pnpm exec tsx scripts/demo/simulate-campaign.ts [--speed=1500] [--workspace=ws_demo] [--live-agents]
 *     [--product=glow|hyalu] [--pause-at-gate]
 *
 *   --pause-at-gate: stop AFTER the real front half (sourcing → vetting →
 *     shortlist + traces) and leave the campaign RUNNING at the outreach gate
 *     with one pending `outreach_send` approval — the same record the
 *     creator-track workflow writes before any send. Nothing is "sent": this is
 *     the loop honestly halted where the human gate sits, so the Approvals
 *     inbox + DECISION NEEDED card render exactly the gate moment the demo
 *     video shows. (A read-only judge session gets 403 on Approve — by design.)
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { MongoClient, ObjectId } from "mongodb";
import { brandCampaignHandler } from "../../packages/workflows/src/workflows/brand-campaign.ts";
import type { StepLike } from "../../packages/workflows/src/gate.ts";
import type { ModelClient } from "@ss/agents";
import { approvalRepo, campaignRepo, getDb, closeMongo } from "@ss/db";
import { invokeCapability } from "@ss/capabilities";

process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27027/instarsearch";
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const SPEED = Number(arg("speed", "1500"));
const WORKSPACE_ID = arg("workspace", "ws_demo");
const PRODUCT = arg("product", "glow") as "glow" | "hyalu";
const PAUSE_AT_GATE = process.argv.includes("--pause-at-gate");
const LIVE_AGENTS = process.argv.includes("--live-agents");
const USER_ID = "u".repeat(21);
const COVER_DIR = resolve(process.cwd(), "apps/web/public/demo-covers");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (arr: unknown[], frac: number) => Math.round(arr.length * frac);

async function pickCandidates(client: MongoClient, n: number) {
  const docs = await client
    .db()
    .collection("accounts_tiktok")
    .find({ hashtags: { $in: ["kbeauty", "skincare"] } })
    .limit(n)
    .toArray();
  return docs.map((d) => ({
    h: String(d.uniqueId),
    nickname: String(d.nickname ?? d.uniqueId),
    followers: Number(d.followerCount ?? 50_000),
  }));
}

function candidateShape(c: { h: string; nickname: string; followers: number }): unknown {
  return {
    creator: {
      id: c.h, uniqueId: c.h, nickname: c.nickname, signature: "K-beauty / lifestyle creator",
      hashtags: ["kbeauty", "skincare"], followerCount: c.followers, followingCount: 200,
      videoCount: 120, heartCount: 5_000_000, verified: false, privateAccount: false,
    },
    matchReasons: ["hashtag overlap (kbeauty, skincare)"],
    flags: [],
  };
}

function stubModel(cands: Array<{ h: string; nickname: string; followers: number }>): ModelClient {
  return {
    complete: async ({ system }: { system: string }) => {
      if (system.includes("Sourcing agent")) {
        return {
          kind: "text" as const,
          text: JSON.stringify({
            candidates: cands.map(candidateShape),
            queriesUsed: ["hashtag:kbeauty", "hashtag:skincare"],
            coverageNote: `${cands.length} in-range K-beauty creators found`,
          }),
          inputTokens: 200, outputTokens: 400,
        };
      }
      if (system.includes("Vetting agent")) {
        const c = cands.find((x) => system.includes(x.h)) ?? cands[0]!;
        // deterministic fit by follower rank-ish
        const fit = 0.6 + ((c.followers % 40) / 100);
        return {
          kind: "text" as const,
          text: JSON.stringify({ ...(candidateShape(c) as object), fitScore: Math.min(0.99, fit), vettedAt: new Date().toISOString() }),
          inputTokens: 200, outputTokens: 150,
        };
      }
      throw new Error("stubModel: unexpected agent");
    },
  } as ModelClient;
}

function fakeStep(campaignId: string): StepLike {
  return {
    async run(_n, fn) { return fn(); },
    async sendEvent() { return undefined; },
    async waitForEvent(_n, _o) {
      return { data: { approvalId: "sim", campaignId, decision: "approved" } } as never;
    },
  };
}

async function insertMessage(db: Awaited<ReturnType<typeof getDb>>, m: Record<string, unknown>) {
  await db.collection("v2_messages").insertOne({ classification: null, agentGenerated: true, messageId: null, ...m });
}

async function main(): Promise<void> {
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const db = await getDb();

  const cands = await pickCandidates(client, 12);
  if (cands.length < 4) throw new Error("not enough seeded creators in accounts_tiktok to simulate");

  const deadline = new Date(); deadline.setUTCDate(deadline.getUTCDate() + 30);
  const PRODUCTS = {
    glow: {
      brandProduct: { name: "Live Demo — Glow Serum", category: "skincare/serum", description: "라이브 시뮬레이션 캠페인 (K-beauty 수분 세럼).", keyClaims: ["7일 보습", "무향"] },
      shortName: "Glow Serum", // outreach copy ("our Glow Serum launch") — the full name reads broken mid-sentence
      creatorCount: 8,
    },
    hyalu: {
      brandProduct: { name: "히알루 수분세럼 · 6월", category: "skincare/serum", description: "히알루론산 수분 세럼 — 6월 신규 캠페인. 라이브 시뮬레이션.", keyClaims: ["72시간 보습", "무향"] },
      shortName: "Hyalu Serum",
      creatorCount: 8,
    },
  } as const;
  const product = PRODUCTS[PRODUCT];
  const brief = {
    workspaceId: WORKSPACE_ID, createdBy: USER_ID,
    brandProduct: { ...product.brandProduct },
    targeting: { creatorCount: product.creatorCount, minEngagementRate: 0.01, languages: [] as string[], hashtags: ["kbeauty", "skincare"], excludeBlacklist: true },
    logistics: { shipsSamples: true },
    goals: { targetLivePosts: 6, deadline, budgetUsd: 600 },
  };

  console.log(`\n▶ STAGE 1-2 (실제 워크플로우): 캠페인 생성 → 소싱 → 벳팅 → shortlist → 선정${LIVE_AGENTS ? " [LIVE Vertex]" : " [stub agents over real creators]"}`);
  const campaign = await campaignRepo.create({ brief, status: "running", stage: "overview", tracks: [] });
  const campaignId = campaign.id;
  console.log(`  campaignId=${campaignId} · MC: /campaigns/${campaignId}`);

  await brandCampaignHandler(
    { event: { data: { campaignId, brief } }, step: fakeStep(campaignId) },
    LIVE_AGENTS ? {} : { modelClient: stubModel(cands) },
  );
  let camp = await campaignRepo.get(campaignId);
  const tracks = (camp?.tracks ?? []).filter((t) => t.state === "shortlisted");
  console.log(`  ✓ ${tracks.length} CreatorTracks 선정 (shortlisted) + 후보/벳팅/trace 기록\n`);
  await sleep(SPEED);

  // ── --pause-at-gate: halt the loop where the human gate sits ───────────────
  if (PAUSE_AT_GATE) {
    const top = tracks[0];
    if (!top) throw new Error("pause-at-gate: no shortlisted tracks to draft outreach for");
    const c = cands.find((x) => x.h === top.creatorId);
    const handle = c?.h ?? top.creatorId;
    const nickname = c?.nickname ?? handle;
    const productName = product.shortName;
    const followers = c ? `${Math.round(c.followers / 1000)}K followers on TikTok` : "seeded TikTok creator";

    const draft = {
      subject: `${nickname} — your hydration routine + our ${productName} launch`,
      body:
        `<p>Hi ${nickname},</p>` +
        `<p>Your K-beauty content is exactly the vibe we're launching with. We'd love to send you our new <strong>${productName}</strong> (hyaluronic hydration serum) — no script, just your honest take.</p>` +
        `<p>If it's a fit, we cover the sample + a performance bonus on delivered views. Want me to ship one out?</p>` +
        `<p>— The ${productName} team</p>`,
      angle: "peer_proof",
      spamScore: 2,
      groundedFacts: [
        followers,
        "Posts regularly in K-beauty / skincare",
        "hashtag overlap (kbeauty, skincare) with the brief",
      ],
      // Canned scores, same as every agent decision in this offline sim (see header):
      // the live outreach writer produces these via its judge tournament; the sim
      // pins representative values so the gate UI renders deterministically.
      judgeScores: { brand: 0.92, conversion: 0.81, deliverability: 0.88, skeptic: 0.79 },
    };
    const approval = await approvalRepo.create({
      workspaceId: WORKSPACE_ID,
      campaignId,
      creatorId: top.creatorId,
      kind: "outreach_send",
      recommendation: draft,
      rationale:
        `Top-ranked creator by fit (@${handle}). The peer-proof angle won the writer tournament; ` +
        `spam risk 2/10 and every claim is grounded in the sourced profile. Recommend sending the first outreach.`,
    });
    await campaignRepo.patchStage(campaignId, "outreach");
    await db
      .collection("v2_campaigns")
      .updateOne({ _id: ObjectId.createFromHexString(campaignId) }, { $set: { pendingApprovalId: approval.id } });

    console.log(`⏸  PAUSED AT GATE — outreach_send approval pending (id ${approval.id})`);
    console.log(`   campaign stays running at stage=outreach · NOTHING was sent.`);
    console.log(`   👀 MC: /campaigns/${campaignId} (DECISION NEEDED) · /approvals/${approval.id}`);
    await client.close();
    await closeMongo();
    return;
  }

  const covers = readdirSync(COVER_DIR).filter((f) => f.endsWith(".jpg"));
  const handle = (id: string) => cands.find((c) => c.h === id)?.h ?? id;
  const threadOf = (id: string) => `sim-${campaignId.slice(-6)}-${id}`;
  const now = () => new Date();
  const setTrack = async (creatorId: string, state: string, patch: Record<string, unknown> = {}) => {
    await campaignRepo.upsertTrack(campaignId, {
      creatorId, stage: "outreach", state: state as never, threadId: threadOf(creatorId),
      lastActivityAt: now(), emailsSent: 1, ...patch,
    } as never);
  };

  // ── STAGE 3: outreach (every track) ────────────────────────────────────────
  console.log("▶ STAGE 3: 아웃리치 — 에이전트가 개인화 메일 발송 (시뮬레이션 송신)");
  for (const t of tracks) {
    await insertMessage(db, {
      workspaceId: WORKSPACE_ID, campaignId, creatorId: t.creatorId, threadId: threadOf(t.creatorId),
      direction: "outbound", subject: `${handle(t.creatorId)}님과 함께하고 싶어요 ✨`,
      body: `안녕하세요 ${handle(t.creatorId)}님!\n저희 글로우 세럼을 소개하고 싶어 연락드려요. 7일 보습·무향 포뮬러예요.\n샘플 보내드려도 될까요?`,
      sentAt: now(),
    });
    await setTrack(t.creatorId, "outreach_sent");
  }
  await campaignRepo.patchStage(campaignId, "outreach");
  console.log(`  ✓ ${tracks.length}건 발송 · state=outreach_sent`); await sleep(SPEED);

  // ── STAGE 4: replies (most reply interested; a few drop) ───────────────────
  console.log("▶ STAGE 4: 답장 수신 — 크리에이터 응답 (시뮬레이션 이벤트) → 분류");
  const replied = tracks.slice(0, pct(tracks, 0.85));
  const noResponse = tracks.slice(pct(tracks, 0.85));
  for (const t of replied) {
    await insertMessage(db, {
      workspaceId: WORKSPACE_ID, campaignId, creatorId: t.creatorId, threadId: threadOf(t.creatorId),
      direction: "inbound", agentGenerated: false, classification: "interested",
      subject: `Re: ${handle(t.creatorId)}님과 함께하고 싶어요 ✨`,
      body: "관심 있어요! 제품 받아보고 싶습니다 :) 주소 보내드릴게요.", sentAt: now(),
    });
    await setTrack(t.creatorId, "in_conversation");
  }
  for (const t of noResponse) await setTrack(t.creatorId, "no_response");
  console.log(`  ✓ ${replied.length} 관심(in_conversation) · ${noResponse.length} 무응답`); await sleep(SPEED);

  // ── STAGE 5: agree + ship + deliver ────────────────────────────────────────
  console.log("▶ STAGE 5: 합의 → 주소 수집 → 샘플 발송 → 수령 (시뮬레이션 배송 이벤트)");
  const agreed = replied.slice(0, pct(replied, 0.88));
  for (const t of agreed) await setTrack(t.creatorId, "address_collected");
  await sleep(Math.round(SPEED / 2));
  for (const t of agreed) await setTrack(t.creatorId, "shipped");
  console.log(`  ✓ ${agreed.length} 발송(shipped)`); await sleep(Math.round(SPEED / 2));
  for (const t of agreed) await setTrack(t.creatorId, "delivered");
  console.log(`  ✓ ${agreed.length} 수령(delivered)`); await sleep(SPEED);

  // ── STAGE 6: post detected → content-verify → verified ─────────────────────
  console.log("▶ STAGE 6: 게시물 감지 → 콘텐츠 검증 (에이전트) → 성과 집계");
  const posted = agreed.slice(0, pct(agreed, 0.85));
  for (const t of posted) await setTrack(t.creatorId, "posted");
  await sleep(Math.round(SPEED / 2));
  let i = 0;
  for (const t of posted) {
    const cover = covers[i % covers.length]!;
    const postId = cover.replace(/\.jpg$/, "");
    const views = 12_000 + ((i * 73) % 60) * 900;
    const likes = Math.round(views * (0.06 + (i % 5) * 0.01));
    const score = 55 + ((i * 7) % 40);
    await setTrack(t.creatorId, "verified", {
      content: {
        postId, matches: true, mentionsBrand: true, performanceScore: score, flags: [],
        views, likes, comments: Math.round(likes * 0.04), shares: Math.round(likes * 0.02), detectedAt: now(),
        coverImage: `/demo-covers/${cover}`, postUrl: `https://www.tiktok.com/@${t.creatorId}/video/${postId}`,
        caption: "글로우 세럼 2주 사용 후기 ✨ #kbeauty #스킨케어",
        hashtags: ["kbeauty", "스킨케어", "글로우세럼"],
      },
    });
    i++;
  }
  console.log(`  ✓ ${posted.length} 검증 완료(verified) + 실제 커버/지표 기록`); await sleep(SPEED);

  // ── finalize: performance + analytics ──────────────────────────────────────
  await campaignRepo.patchStage(campaignId, "performance", "completed");
  const report = await invokeCapability("analytics.compile", { campaignId }, { workspaceId: WORKSPACE_ID, userId: USER_ID, rateLimitClass: "default" }).catch((e) => ({ error: String(e) }));
  camp = await campaignRepo.get(campaignId);
  const states: Record<string, number> = {};
  for (const t of camp?.tracks ?? []) states[t.state] = (states[t.state] ?? 0) + 1;
  const msgs = await db.collection("v2_messages").countDocuments({ campaignId });

  console.log(`\n✅ 캠페인 완주: stage=${camp?.stage}/${camp?.status}`);
  console.log(`   funnel(track states): ${JSON.stringify(states)}`);
  console.log(`   v2_messages: ${msgs} · v2_campaigns track count: ${camp?.tracks.length}`);
  if (report && typeof report === "object" && "goals" in report) {
    const r = report as { goals: { verifiedCount: number; targetLivePosts: number }; reach: { verifiedViews: number } };
    console.log(`   analytics.compile: 검증 ${r.goals.verifiedCount}/${r.goals.targetLivePosts} · 총 조회수 ${r.reach.verifiedViews.toLocaleString()}`);
  }
  console.log(`\n   👀 MC에서 보기: /campaigns/${campaignId}  (목록 → ${brief.brandProduct.name})`);
  await client.close();
  await closeMongo();
}

main().catch(async (err) => {
  console.error("\n✗ simulation failed:", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
  await closeMongo().catch(() => {});
  process.exit(1);
});
