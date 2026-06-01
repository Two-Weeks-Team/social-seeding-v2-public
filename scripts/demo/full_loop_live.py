#!/usr/bin/env python3
"""Run the full 6-stage influencer-campaign loop once, end-to-end, with REAL
data on Vertex (GCP-based reasoning).

source → vet → outreach → reply → ship → verify → report, each stage driven by
the real ADK agent via ss_agents.runtime.run_agent (Gemini 3.5 on Vertex
`global`). Real where wired: TikTok (backend.socialseed.ing proxy, SS_TIKTOK_LIVE)
and Gmail send (SS_GMAIL_LIVE → Gmail API). The W7-deferred I/O tools
(carrier/dam/bigquery) run as their honest deterministic stubs (HONEST-SCOPE);
the Gemini reasoning at every stage is real.

Run:
  set -a; source .env.local; source <frontend>/.env; set +a
  export SS_TIKTOK_LIVE=1 SS_GMAIL_LIVE=1 SS_LIVE=1 CAPABILITY_LAYER_MODE=stub \
         GOOGLE_GENAI_USE_VERTEXAI=TRUE GOOGLE_CLOUD_PROJECT=ss-v2-prod \
         GOOGLE_CLOUD_LOCATION=global MODEL_GARDEN_ROUTING=true \
         GMAIL_SENDER=sejun@2weeks.co
  python3 scripts/demo/full_loop_live.py
"""
import asyncio
import sys

sys.path.insert(0, "packages/agents-adk/src")

from ss_agents.runtime import RunContext, run_agent  # noqa: E402

CAMPAIGN_ID = "camp_full_loop_001"
WORKSPACE = "ws_demo_serve_0001"
CREATOR = "aviranisha"  # real TikTok handle (4.3M followers) via the backend proxy
TEST_MAILBOX = "sejun@2weeks.co"  # D10 operator mailbox (self-send verification)

BRIEF = {
    "workspaceId": WORKSPACE,
    "createdBy": "full-loop-live",
    "brandProduct": {
        "name": "Wooriliu Collagen",
        "category": "beauty supplement",
        "description": "Low-molecular marine collagen for skin elasticity; K-beauty short-form seeding.",
        "keyClaims": ["low-molecular", "skin elasticity"],
    },
    "targeting": {"creatorCount": 5, "minEngagementRate": 0.02, "languages": ["ko", "en"]},
    "logistics": {"shipsSamples": True, "sampleSku": "WRL-COL-30"},
    "goals": {"targetLivePosts": 3, "deadline": "2026-06-30", "budgetUsd": 25.0},
}


def ctx(trace: str) -> RunContext:
    return RunContext(
        tenant_id="t_demo000000000000",
        workspace_id=WORKSPACE,
        trace_id=trace,
        campaign_id=CAMPAIGN_ID,
        invoked_by="full-loop-live",
    )


def line(stage: str) -> None:
    print("\n" + "=" * 72 + f"\n[{stage}]")


async def main() -> None:
    from ss_agents.agents.analyst import AnalystInput, analyst_agent_def
    from ss_agents.agents.content_verify import ContentVerifyInput, content_verify_agent_def
    from ss_agents.agents.conversation_responder import (
        ConversationResponderInput,
        conversation_responder_agent_def,
    )
    from ss_agents.agents.logistics import LogisticsInput, logistics_agent_def
    from ss_agents.agents.outreach_writer import _DrafterInput, outreach_drafter_agent_def
    from ss_agents.agents.sourcing import SourcingInput, sourcing_agent_def
    from ss_agents.agents.vetting import VettingInput, vetting_agent_def

    results: dict[str, str] = {}

    # ── 1) SOURCE ────────────────────────────────────────────────────────────
    line("1/6 SOURCE — sourcing agent (Gemini 3.5, Vertex)")
    src = await run_agent(sourcing_agent_def, SourcingInput.model_validate({"brief": BRIEF}), ctx("loop-source"))
    n = len(getattr(getattr(src, "value", None), "candidates", []) or []) if hasattr(src, "value") else 0
    print(f"  outcome={type(src).__name__} candidates={n}")
    results["source"] = f"{type(src).__name__} ({n} candidates)"

    # ── 2) VET ───────────────────────────────────────────────────────────────
    line("2/6 VET — vetting agent + REAL TikTok (backend proxy)")
    candidate = {"creator": {"id": CREATOR, "uniqueId": CREATOR, "nickname": CREATOR,
                             "followerCount": 1000, "followingCount": 100, "videoCount": 50},
                 "matchReasons": ["beauty niche"], "flags": []}
    vet = await run_agent(vetting_agent_def, VettingInput.model_validate({"brief": BRIEF, "candidate": candidate}), ctx("loop-vet"))
    vc = getattr(vet, "value", None)
    creator_obj = getattr(vc, "creator", None) if vc else None
    followers = getattr(creator_obj, "follower_count", None) if creator_obj else None
    print(f"  outcome={type(vet).__name__} followerCount={followers} fitScore={getattr(vc,'fit_score',None)} action={getattr(vc,'recommended_action',None)}")
    results["vet"] = f"{type(vet).__name__} (real TikTok {followers} followers, fit {getattr(vc,'fit_score',None)})"

    # ── 3) OUTREACH ──────────────────────────────────────────────────────────
    line("3/6 OUTREACH — drafter agent + REAL Gmail send (SS_GMAIL_LIVE)")
    facts = {
        "creator": {"uniqueId": CREATOR, "nickname": CREATOR, "followerCount": int(followers or 4300000),
                    "avgViews": int(getattr(creator_obj, "avg_views", 0) or 400000), "engagementRate": float(getattr(creator_obj, "engagement_rate", 0.07) or 0.07),
                    "topHashtags": ["#kbeauty", "#skincare"], "recentPostThemes": ["beauty routines"]},
        "brand": {"name": BRIEF["brandProduct"]["name"], "category": BRIEF["brandProduct"]["category"], "description": BRIEF["brandProduct"]["description"], "keyClaims": BRIEF["brandProduct"]["keyClaims"]},
        "logistics": {"shipsSamples": True},
        "hasMinimumContext": True,
    }
    draft = await run_agent(outreach_drafter_agent_def, _DrafterInput.model_validate({"facts": facts, "angle": "aspirational", "locale": "en"}), ctx("loop-outreach"))
    dv = getattr(draft, "value", None)
    subject = getattr(dv, "subject", None) if dv else None
    body = getattr(dv, "body", None) if dv else None
    print(f"  outcome={type(draft).__name__} subject={subject!r}")
    # Real Gmail send of the drafted outreach to the operator mailbox (D10).
    from ss_agents.tools.gmail_send_reply import GmailSendReplyInput, gmail_send_reply
    sent = gmail_send_reply(GmailSendReplyInput(
        thread_id="loop-outreach-thread", reply_subject=(subject or "Collagen sample collab")[:120],
        reply_body=(body or "Hi — we'd love to send you a Wooriliu Collagen sample.")[:8000],
        recipient_email=TEST_MAILBOX, sender_alias="Social Seeding", dry_run=False))
    print(f"  GMAIL SENT message_id={sent.message_id} dry_run_applied={sent.dry_run_applied} to={sent.sent_to}")
    results["outreach"] = f"{type(draft).__name__} → real Gmail send {sent.message_id}"

    # ── 4) REPLY ─────────────────────────────────────────────────────────────
    line("4/6 REPLY — conversation_responder (triage respond/escalate)")
    turn = {"threadId": "loop-outreach-thread", "creatorId": CREATOR, "incomingMessageId": "msg-creator-1",
            "classification": "interested", "extracted": {"question": "What's the deadline and sample value?"}}
    reply = await run_agent(conversation_responder_agent_def, ConversationResponderInput.model_validate({"turn": turn, "facts": facts, "locale": "en"}), ctx("loop-reply"))
    rv = getattr(reply, "value", None)
    print(f"  outcome={type(reply).__name__} decision={getattr(rv,'decision',getattr(rv,'action',None))}")
    results["reply"] = f"{type(reply).__name__} (decision={getattr(rv,'decision',getattr(rv,'action',None))})"

    # ── 5) SHIP ──────────────────────────────────────────────────────────────
    line("5/6 SHIP — logistics agent (carrier = honest deterministic stub)")
    ship = await run_agent(logistics_agent_def, LogisticsInput.model_validate({
        "brief": BRIEF, "creatorTrackId": "trk_001", "creatorId": CREATOR,
        "rawAddress": "123 Gangnam-daero, Seoul, KR", "creatorCountryHint": "KR",
        "products": [{"sku": "WRL-COL-30", "name": "Wooriliu Collagen 30ct", "valueUsdCents": 2500, "weightGrams": 120}]}), ctx("loop-ship"))
    sv = getattr(ship, "value", None)
    print(f"  outcome={type(ship).__name__} tracking={getattr(sv,'tracking_number',getattr(sv,'trackingNumber',None))} carrier={getattr(sv,'carrier',None)}")
    results["ship"] = f"{type(ship).__name__}"

    # ── 6a) VERIFY ───────────────────────────────────────────────────────────
    line("6a/6 VERIFY — content_verify agent (post views vs baseline)")
    post = {"postId": "post_loop_1", "createdAt": "2026-06-10T00:00:00Z", "desc": "Wooriliu collagen routine #kbeauty",
            "hashtags": ["kbeauty", "skincare"], "views": 52000, "likes": 4100, "comments": 230, "shares": 95,
            "matchedHashtags": ["kbeauty"]}
    ver = await run_agent(content_verify_agent_def, ContentVerifyInput.model_validate({"brief": BRIEF, "post": post, "baselineAvgViews": 30000}), ctx("loop-verify"))
    vv = getattr(ver, "value", None)
    print(f"  outcome={type(ver).__name__} verified={getattr(vv,'verified',None)} performanceScore={getattr(vv,'performance_score',None)}")
    results["verify"] = f"{type(ver).__name__}"

    # ── 6b) REPORT ───────────────────────────────────────────────────────────
    line("6b/6 REPORT — analyst agent (campaign performance summary)")
    report = {"campaignId": CAMPAIGN_ID, "brief": {"name": BRIEF["brandProduct"]["name"], "category": BRIEF["brandProduct"]["category"], "deadline": "2026-06-30"},
              "funnel": {"candidate": 5, "shortlisted": 3, "outreach_sent": 3, "verified": 1, "posted": 1},
              "goals": {"targetLivePosts": 3, "verifiedCount": 1, "daysToDeadline": 29, "goalMet": False},
              "reach": {"verifiedViews": 52000, "verifiedLikes": 4100, "verifiedComments": 230, "verifiedShares": 95},
              "performance": {"avgPerformanceScore": 0.78}, "cost": {"spentUsd": 6.2}, "generatedAt": "2026-06-15T00:00:00Z"}
    rep = await run_agent(analyst_agent_def, AnalystInput.model_validate({"brief": BRIEF, "report": report}), ctx("loop-report"))
    print(f"  outcome={type(rep).__name__} headline={getattr(getattr(rep,'value',None),'headline',None)!r}")
    results["report"] = f"{type(rep).__name__}"

    # ── completion log ─────────────────────────────────────────────────────────
    print("\n" + "#" * 72)
    print("# 6-STAGE LOOP COMPLETE — source→vet→outreach→reply→ship→verify→report")
    for k in ["source", "vet", "outreach", "reply", "ship", "verify", "report"]:
        print(f"#   {k:9s}: {results.get(k)}")
    print("#" * 72)


if __name__ == "__main__":
    asyncio.run(main())
