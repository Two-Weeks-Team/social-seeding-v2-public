"""brand_campaign_smoke.py — credentials-free end-to-end smoke driver.

Per D43 (DECISIONS.md:132): "End-to-end smoke test is the Phase-3 canary
gating deploy/demo — scripts/smoke-test/run-brand-campaign.sh exercises
brand-brief → 22-agent fleet → … → final report; must exit 0 before any
deploy or demo recording."

What this driver does (D43 + W4 WORK-QUEUE):
  1. Imports each of the 22 `<agent>_agent_def` AgentDefs from
     `ss_agents.agents.*` in the brand-campaign topology order from
     `terraform/modules/integration/workflows/brand-campaign.workflows.yaml`.
  2. Asserts every agent's `tools` is non-empty (W2 wired the full fleet).
  3. For each wired tool, invokes it once in CAPABILITY_LAYER_MODE=stub
     with a minimal valid Pydantic input.
  4. Asserts the returned object validates against the tool's declared
     output schema.
  5. Diffs the deterministic stub outputs against
     `scripts/smoke-test/expected-output.json` (regression detector — if
     a stub drifts, the smoke test fails before deploy).

Constraints (W4 brief):
  - No network — all tools in stub mode (D27 AP2 Intent-only never leaves
    `gate.approve.outreach_send`; D10 Gmail never sends to a real address).
  - No live GCP, no real Gmail, no real RapidAPI.
  - No edits to packages/ — this script consumes the existing fleet read-only.
  - <30 s wall clock on a clean checkout.

Exit codes (W4 brief):
   0 — all 22 agents have ≥1 tool, every tool passes stub invocation,
       and expected-output.json (if present) matches.
   1 — at least one agent has tools=[].
   2 — at least one tool failed stub invocation.
   3 — expected-output.json drift detected (regression).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import pathlib
import sys
import time
import traceback
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Force stub mode BEFORE importing any ss_agents.tools.* module. The
# capability layer dispatch reads this env var lazily per call, but we set it
# at module-load time so even helper imports stay offline. (D41 stub seam.)
# ---------------------------------------------------------------------------
os.environ.setdefault("CAPABILITY_LAYER_MODE", "stub")
os.environ.setdefault("SS_OFFLINE", "1")
# Vertex/genai env-vars: explicitly unset would crash with KeyError elsewhere;
# the runtime only reads them when SS_OFFLINE is 0 (see ss_agents.config).
os.environ.pop("SS_LIVE", None)

logging.basicConfig(
    level=logging.WARNING,
    format="%(levelname)s %(name)s %(message)s",
)
# Mute the noisy capability-layer info logs — the smoke test owns the
# success line itself.
logging.getLogger("ss_agents").setLevel(logging.ERROR)
log = logging.getLogger("smoke")
log.setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Topology — brand-campaign pipeline order per
# terraform/modules/integration/workflows/brand-campaign.workflows.yaml +
# WIRE-NOTES.md §2. All 22 agents (16 Tier-1 + 3 Tier-2 + 3 Tier-3) listed.
# ---------------------------------------------------------------------------

BRAND_CAMPAIGN_PIPELINE: list[str] = [
    # Tier-1 brand-campaign loop
    "intake",
    "sourcing",
    "vetting",
    "outreach_writer",
    "conversation",
    "logistics",
    "content_verify",
    "analyst",
    "research",
    "creative",
    "a11y",
    "payment_mandate",
    "compliance",
    # Tier-2 meta
    "coordinator",
    "critic",
    "optimizer",
    # Tier-3 watchdogs
    "anomaly_watch",
    "cost_watch",
    "security_watch",
    # Tier-1 ancillary used by lead/conversation tracks
    "customer_success",
    "lead_outreach_writer",
    "conversation_responder",
]
assert len(BRAND_CAMPAIGN_PIPELINE) == 22, "topology must list exactly 22 agents"


# ---------------------------------------------------------------------------
# Per-tool minimal valid stub inputs.
#
# Each entry is a callable that returns a dict ready for `*Input.model_validate`.
# The dicts use field names (not aliases) wherever possible; Pydantic v2
# accepts either. Inputs are deliberately deterministic so the golden file
# stays stable.
# ---------------------------------------------------------------------------

_NOW = dt.datetime(2026, 5, 19, 0, 0, 0, tzinfo=dt.UTC)
_TIME_RANGE = (_NOW - dt.timedelta(hours=1), _NOW)
_TIME_RANGE_DATE = (
    (_NOW - dt.timedelta(days=1)).date(),
    _NOW.date(),
)


def _campaign_brief_stub() -> dict[str, Any]:
    """Minimal CampaignBrief payload accepted by forms_upsert."""
    return {
        "workspaceId": "ws_smoke_brand_001",
        "createdBy": "smoke@example.com",
        "brandProduct": {
            "name": "Stub Serum",
            "category": "skincare/serum",
            "description": "A deterministic stub product for the W4 smoke test.",
        },
        "targeting": {
            "creatorCount": 20,
            "minEngagementRate": 0.02,
            "languages": ["ko"],
        },
        "logistics": {"shipsSamples": True},
        "goals": {
            "targetLivePosts": 12,
            "deadline": _NOW + dt.timedelta(days=30),
        },
    }


STUB_INPUTS: dict[str, Callable[[], dict[str, Any]]] = {
    # --- a11y ---------------------------------------------------------------
    "vision_describe": lambda: {
        "gcs_uri_or_https_url": "gs://stub-bucket/sample.jpg",
        "locale": "ko",
    },
    "stt_transcribe": lambda: {
        "audio_gcs_uri": "gs://stub-bucket/sample.wav",
        "source_locale": "ko",
    },
    "tts_synthesize": lambda: {
        "text": "안녕하세요, 스모크 테스트입니다.",
        "locale": "ko",
        "voice_kind": "neutral",
    },
    "translation_translate": lambda: {
        "text": "Hello world.",
        "source_locale": "en",
        "target_locale": "ko",
    },
    # --- analyst ------------------------------------------------------------
    "bigquery_query": lambda: {
        # Must match an allow-listed template — raw SQL is rejected by the
        # stub's injection guardrail. See ss_agents.tools.bigquery_query.
        "query_template_name": "campaign_summary",
        "params": {"campaign_id": "camp_smoke_001"},
    },
    "view_metrics_aggregate": lambda: {
        "campaign_id": "camp_smoke_001",
        "time_range": _TIME_RANGE,
    },
    # --- anomaly_watch ------------------------------------------------------
    "metrics_query": lambda: {
        "metric_type": "agent.invocations",
        "time_range": _TIME_RANGE,
        "aggregation": "p95",
    },
    "runbook_execute": lambda: {
        "runbook_name": "scale_up_v1",
        "dry_run": True,
        "executing_user": "smoke@example.com",
        "runbook_kind": "scale_up",
    },
    # --- compliance ---------------------------------------------------------
    "pipa_check_consent": lambda: {
        "recipientEmail": "creator@example.com",
        "workspaceId": "ws_smoke_brand_001",
        "consentType": "marketing",
    },
    "canspam_check_unsubscribe": lambda: {
        "emailSubject": "Stub outreach",
        "emailBodyHtml": (
            "<p>Hello,</p><p>Stub body.</p>"
            "<p><a href='https://example.com/u'>Unsubscribe</a></p>"
        ),
        "senderAddress": "sender@example.com",
        "physicalAddress": "1 Stub St, Seoul, KR",
    },
    "dlp_inspect": lambda: {
        "text": "Reach out to creator@example.com about our new line.",
    },
    # --- content_verify -----------------------------------------------------
    "vision_brand_logo_detect": lambda: {
        "media_url": "https://stub.local/thumb.jpg",
        "expected_brand_name": "StubBrand",
    },
    # --- conversation -------------------------------------------------------
    "gmail_thread_classify": lambda: {
        "thread_id": "thread_smoke_001",
        "latest_message_body": "Sure, I'm interested. Please send details.",
        "sender_email": "creator@example.com",
    },
    "memory_bank_search": lambda: {
        "workspace_id": "ws_smoke_brand_001",
        "query": "previous outreach to this creator",
        "max_results": 3,
        "max_age_days": 7,
    },
    # --- conversation_responder --------------------------------------------
    "gmail_send_reply": lambda: {
        "thread_id": "thread_smoke_001",
        "reply_subject": "Re: Stub outreach",
        "reply_body": "Thanks for the reply — here are the details.",
        "recipient_email": "app.2weeks@gmail.com",  # D10 operator-owned only
        "dry_run": True,  # D27 AP2 Intent-only; D10 demo never sends live
    },
    # --- coordinator --------------------------------------------------------
    "agent_registry_list": lambda: {},
    "a2a_invoke": lambda: {
        # Stub enforces an endpoint allow-list (`https://stub.local/agent/...`)
        # to prevent the smoke test from accidentally talking to anything real.
        "remoteAgentEndpoint": "https://stub.local/agent/peer",
        "timeoutS": 5,
        "correlationId": "corr_smoke_001",
    },
    # --- cost_watch ---------------------------------------------------------
    "billing_query": lambda: {
        "time_range": _TIME_RANGE_DATE,
        "breakdown": "total",
    },
    "pubsub_alert": lambda: {
        "workspace_id": "ws_smoke_brand_001",
        "current_pct_consumed": 0.5,
        "alert_kind": "budget_50",
        "message_body": "50% of weekly budget consumed (smoke test).",
    },
    # --- creative -----------------------------------------------------------
    "imagen_generate": lambda: {
        "prompt": "minimal still life of a serum bottle on a white background",
        "num_images": 1,
        "aspect_ratio": "1:1",
        "safety_filter_level": "BLOCK_MEDIUM_AND_ABOVE",
    },
    "veo_generate": lambda: {
        "prompt": "slow 6s pan over a serum bottle",
        "duration_seconds": 6,
        "aspect_ratio": "9:16",
        "fps": 24,
    },
    "lyria_generate": lambda: {
        "prompt": "calm ambient pad, 10 seconds, instrumental only",
        "duration_seconds": 10,
        "instrumental_only": True,
    },
    "assets_upload": lambda: {
        "local_path_or_gcs_uri": "gs://stub-bucket/asset.png",
        "workspace_id": "ws_smoke_brand_001",
        "asset_kind": "image",
    },
    # --- critic -------------------------------------------------------------
    "evaluation_score": lambda: {
        "agentId": "outreach-writer",
        "agentOutput": {"subject": "Sample", "body": "Sample body."},
        "evaluationRubric": ["relevance", "tone", "deliverability"],
    },
    "gate_escalate": lambda: {
        "agentId": "outreach-writer",
        "agentOutput": {"draft": "rejected"},
        "escalationReason": "Quality floor breached on smoke test fixture.",
        "severity": "warning",
    },
    # --- customer_success ---------------------------------------------------
    "analytics_funnel": lambda: {
        "workspace_id": "ws_smoke_brand_0001",
        "time_range": _TIME_RANGE,
        "funnel_stages": ["sourced", "approved", "shipped"],
    },
    "intervention_propose": lambda: {
        "workspace_id": "ws_smoke_brand_0001",
        "signal_type": "onboarding_stall",
        "severity": "low",
    },
    # --- intake -------------------------------------------------------------
    "forms_upsert": lambda: {
        "brief_payload": _campaign_brief_stub(),
        "workspace_id": "ws_smoke_brand_001",
        "created_by": "smoke@example.com",
    },
    # --- lead_outreach_writer ----------------------------------------------
    "crm_enrich": lambda: {
        "lead_email": "lead@example.com",
        "lead_name": "Stub Lead",
    },
    # --- logistics ----------------------------------------------------------
    "address_normalize": lambda: {
        "rawAddress": "1 Stub St, Seoul, KR 04524",
        "countryHint": "KR",
    },
    "carrier_create": lambda: {
        "fromAddress": {
            "recipientName": "Stub Sender",
            "addressLine1": "1 Stub Origin",
            "countryIso2": "KR",
        },
        "toAddress": {
            "recipientName": "Stub Recipient",
            "addressLine1": "2 Stub Destination",
            "countryIso2": "KR",
        },
        "parcelDims": {
            "lengthCm": 20.0,
            "widthCm": 15.0,
            "heightCm": 10.0,
            "weightGrams": 500.0,
        },
        "declaredValueUsd": 25.0,
    },
    # --- optimizer ----------------------------------------------------------
    "agent_optimizer_tune": lambda: {
        "agentId": "outreach-writer",
        "currentPrompt": "You are an outreach writer. Be helpful.",
        "targetMetric": "deliverability",
    },
    "prompt_registry_update": lambda: {
        "agentId": "outreach-writer",
        "newPrompt": "You are an outreach writer. Be concise and specific.",
        "versionLabel": "smoke-v1",
        "optimizerJobId": "job_smoke_001",
        "performanceDelta01": 0.05,
    },
    # --- outreach_writer ----------------------------------------------------
    "templates_list": lambda: {
        "locale": "ko",
        "campaignType": "brand",
        "countLimit": 3,
    },
    "outreach_extract_facts": lambda: {
        "creatorId": "tt_001",
        "nickname": "Stub Creator",
        "signature": "Beauty & lifestyle.",
        "recentPostThemes": ["serum review"],
        "topHashtags": ["#skincare"],
        "engagementRate": 0.05,
        "avgViews": 12_000,
        "followerCount": 50_000,
    },
    "outreach_render": lambda: {
        "templateId": "tpl_smoke_001",
        "facts": {"creatorName": "Stub Creator"},
        "brief": {"productName": "Stub Serum"},
        "locale": "ko",
    },
    # --- payment_mandate ----------------------------------------------------
    "ap2_compose_intent_mandate": lambda: {
        "agent_id": "payment_mandate",
        "action_type": "outreach.send",
        "scope": ["external_send"],
        "expires_at": _NOW + dt.timedelta(hours=24),
        "amount_usd_cap": 0.50,
        "beneficiary": "creator@example.com",
        "replay_token": "rt_smoke_001",
    },
    "gate_approveOutreachSend": lambda: {
        "mandate_id": "mandate_smoke_001",
        "action_payload": {"recipient": "app.2weeks@gmail.com"},
        "requester_user_id": "smoke@example.com",
        "locale": "ko",
    },
    # --- research ----------------------------------------------------------
    "web_search": lambda: {
        "query": "Korean skincare serum 2026 trends",
        "locale": "ko",
        "maxResults": 5,
    },
    "vector_search_competitor": lambda: {
        "brandName": "StubBrand",
        "embeddingOrText": "premium hyaluronic acid serum",
        "topK": 5,
    },
    # --- security_watch -----------------------------------------------------
    "model_armor_query_blocks": lambda: {
        "time_range": _TIME_RANGE,
    },
    "chronicle_query": lambda: {
        # Must use an allow-listed UDM template — raw queries are blocked by
        # the stub's injection guardrail.
        "query_template_name": "recent_pi_alerts",
        "time_range": _TIME_RANGE,
    },
    "tenant_quarantine": lambda: {
        "tenant_id": "tenant_smoke_001",
        "reason": "Smoke test quarantine — deterministic stub invocation.",
        "severity": "soft",
        "operator_user_id": "smoke@example.com",
        "ttl_hours": 1,
    },
    # --- sourcing -----------------------------------------------------------
    "rapidapi_tiktok_search": lambda: {
        "query": "skincare serum",
        "mode": "text",
        "limit": 5,
    },
    "rapidapi_instagram_search": lambda: {
        "query": "skincare serum",
        "mode": "text",
        "limit": 5,
    },
    "blacklist_check": lambda: {
        "workspaceId": "ws_smoke_brand_001",
        "creatorIds": ["tt_001", "tt_002"],
    },
    "vector_search_creator": lambda: {
        "queryText": "korean skincare creator",
        "topK": 5,
    },
    # --- vetting ------------------------------------------------------------
    "rapidapi_get_user_info": lambda: {
        "creator_id": "tt_001",
        "platform": "tiktok",
    },
    "ranking_score": lambda: {
        "creator_profile": {
            "creator_id": "tt_001",
            "platform": "tiktok",
            "followers": 50_000,
            "engagement_rate": 0.05,
            "language": "ko",
            "hashtags": ["#skincare"],
        },
        "campaign_brief": {
            "product_category": "skincare/serum",
            "languages": ["ko"],
            "min_engagement_rate": 0.02,
            "target_hashtags": ["#skincare"],
        },
    },
}


# ---------------------------------------------------------------------------
# Result records.
# ---------------------------------------------------------------------------


def _to_jsonable(value: Any) -> Any:
    """Recursive JSON-safe coercion (datetime → ISO; sets → list)."""
    if isinstance(value, dt.datetime):
        return value.astimezone(dt.UTC).isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    if isinstance(value, set):
        return sorted(_to_jsonable(v) for v in value)
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    return value


def _stable_output(model_instance: Any) -> Any:
    """Convert a Pydantic output instance into a JSON-stable dict, stripping
    non-deterministic fields (timestamps, generated ids) so the regression
    diff stays meaningful.

    The strip is recursive — nested dicts inside lists also have their
    wall-clock keys removed. We match by canonical key name (suffixes like
    `_at`, `created_at`, exact id names) rather than by value type so the
    semantics stay explicit. Anything we don't know is a clock value, we
    keep — drift in those is signal worth surfacing.
    """
    raw = model_instance.model_dump(mode="json", by_alias=False)
    return _strip_nondeterministic(raw)


# Canonical drop set. Anything matching exactly OR ending in `_at` is treated
# as wall-clock and pruned from the diff surface. Generated ids (UUIDv7 +
# carrier tracking + asset uploads) are also pruned — stub mode regenerates
# them on every call.
_DROP_KEY_SUFFIXES = ("_at",)
_DROP_KEY_EXACT = frozenset(
    {
        "persisted_at",
        "generated_at",
        "issued_at",
        "expires_at",
        "executed_at",
        "captured_at",
        "started_at",
        "applied_at",
        "registered_at",
        "published_at",
        "deadline_at",
        "sent_at",
        "created_at",
        "asset_id",
        "mandate_id",
        "shipment_id",
        "carrier_tracking_id",
        "label_url",
        "job_id",
        "trace_id",
        "message_id",
    }
)


def _strip_nondeterministic(value: Any) -> Any:
    """Recursive helper for `_stable_output`."""
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if k in _DROP_KEY_EXACT or any(k.endswith(s) for s in _DROP_KEY_SUFFIXES):
                continue
            out[k] = _strip_nondeterministic(v)
        return out
    if isinstance(value, list):
        return [_strip_nondeterministic(v) for v in value]
    return _to_jsonable(value)


# ---------------------------------------------------------------------------
# Core driver.
# ---------------------------------------------------------------------------


def import_agent_def(agent_name: str) -> Any:
    """Import `ss_agents.agents.<name>.<name>_agent_def`."""
    import importlib

    module = importlib.import_module(f"ss_agents.agents.{agent_name}")
    return getattr(module, f"{agent_name}_agent_def")


def invoke_tool_stub(tool_fn: Callable[..., Any]) -> dict[str, Any]:
    """Build a minimal valid input for `tool_fn`, invoke it, validate output."""
    import inspect
    import typing

    tname = tool_fn.__name__
    if tname not in STUB_INPUTS:
        raise KeyError(f"no STUB_INPUTS entry for tool {tname!r}")

    sig = inspect.signature(tool_fn)
    p0 = next(iter(sig.parameters.values()))
    hints = typing.get_type_hints(tool_fn)
    in_cls = hints.get(p0.name, p0.annotation)
    out_cls = hints.get("return", sig.return_annotation)

    raw_input = STUB_INPUTS[tname]()
    # Pydantic v2: model_validate accepts either field name or alias. We use
    # `by_alias` mixing in the dicts above — both styles are tolerated.
    validated_input = in_cls.model_validate(raw_input)

    t0 = time.perf_counter()
    output = tool_fn(validated_input)
    latency_ms = (time.perf_counter() - t0) * 1000.0

    # Validate output against the declared output schema.
    if not isinstance(output, out_cls):
        # Best-effort re-validation. If this raises, the tool's output drifted
        # from its declared schema — caught by exit code 2 upstream.
        output = out_cls.model_validate(output.model_dump() if hasattr(output, "model_dump") else output)

    return {
        "tool_name": tname,
        "output_type": out_cls.__name__,
        "latency_ms": round(latency_ms, 3),
        "succeeded": True,
        "output": _stable_output(output),
    }


def run_smoke() -> tuple[int, dict[str, Any]]:
    """Execute the smoke test. Returns (exit_code, summary_dict)."""
    started_at = time.perf_counter()

    agents_with_zero_tools: list[str] = []
    tool_records: list[dict[str, Any]] = []
    failed_tools: list[dict[str, Any]] = []
    invoked_tool_names: set[str] = set()

    for agent_name in BRAND_CAMPAIGN_PIPELINE:
        try:
            agent_def = import_agent_def(agent_name)
        except Exception as exc:  # noqa: BLE001
            failed_tools.append(
                {
                    "agent_name": agent_name,
                    "tool_name": "<import>",
                    "error": f"could not import {agent_name}_agent_def: {exc!r}",
                    "traceback": traceback.format_exc(),
                }
            )
            continue

        if not agent_def.tools:
            agents_with_zero_tools.append(agent_name)
            continue

        for tool_fn in agent_def.tools:
            # Skip duplicates within this run (memory_bank_search is shared by
            # conversation + conversation_responder, etc.). We still record
            # WHICH agent invoked it for the agent×tool wiring matrix.
            already_invoked = tool_fn.__name__ in invoked_tool_names
            try:
                rec = invoke_tool_stub(tool_fn)
            except Exception as exc:  # noqa: BLE001
                failed_tools.append(
                    {
                        "agent_name": agent_def.id,
                        "tool_name": tool_fn.__name__,
                        "error": repr(exc),
                        "traceback": traceback.format_exc(),
                    }
                )
                continue

            rec["agent_name"] = agent_def.id
            rec["duplicate_invocation"] = already_invoked
            tool_records.append(rec)
            invoked_tool_names.add(tool_fn.__name__)

    elapsed_s = time.perf_counter() - started_at
    total_tools = len(tool_records)
    total_passed = sum(1 for r in tool_records if r["succeeded"])
    total_failed = len(failed_tools)
    summary = {
        "started_at_utc": _NOW.isoformat(),
        "elapsed_s": round(elapsed_s, 3),
        "pipeline_topology": BRAND_CAMPAIGN_PIPELINE,
        "agents_validated": len(BRAND_CAMPAIGN_PIPELINE) - len(agents_with_zero_tools),
        "agents_with_zero_tools": agents_with_zero_tools,
        "total_unique_tools_invoked": len(invoked_tool_names),
        "total_tool_invocations": total_tools,
        "total_passed": total_passed,
        "total_failed": total_failed,
        "failed_tools": failed_tools,
        "records": tool_records,
    }

    if agents_with_zero_tools:
        return 1, summary
    if total_failed > 0:
        return 2, summary
    return 0, summary


# ---------------------------------------------------------------------------
# Golden-file regression diff.
# ---------------------------------------------------------------------------


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
GOLDEN_FILE = REPO_ROOT / "scripts" / "smoke-test" / "expected-output.json"


def golden_signature(summary: dict[str, Any]) -> dict[str, Any]:
    """Reduce the summary to the deterministic surface we pin in the golden.

    We KEEP:
        - the agent×tool wiring matrix (which agent invokes which tools)
        - each unique tool's stable output (datetimes/ids stripped)
    We DROP:
        - latency_ms (machine-dependent)
        - elapsed_s, started_at_utc (clock-dependent)
        - traceback strings
    """
    # tool_name -> stable output (first invocation wins; duplicates are
    # invariants of the stub seam and would be redundant in the golden).
    outputs: dict[str, Any] = {}
    for r in summary["records"]:
        outputs.setdefault(r["tool_name"], {
            "output_type": r["output_type"],
            "output": r["output"],
        })

    wiring: dict[str, list[str]] = {}
    for r in summary["records"]:
        wiring.setdefault(r["agent_name"], []).append(r["tool_name"])
    # Sort tool lists for stability while preserving topology order in keys.
    for k in wiring:
        wiring[k] = sorted(set(wiring[k]))

    return {
        "agents_with_zero_tools": summary["agents_with_zero_tools"],
        "total_unique_tools_invoked": summary["total_unique_tools_invoked"],
        "wiring": wiring,
        "outputs": outputs,
    }


def diff_against_golden(summary: dict[str, Any]) -> list[str]:
    """Return a list of human-readable diff lines. Empty == no drift."""
    sig = golden_signature(summary)
    if not GOLDEN_FILE.exists():
        # First-run: write the golden so subsequent runs have something to
        # diff against. Empty list (no drift) is the right return value here —
        # the operator commits the freshly-written file.
        GOLDEN_FILE.write_text(json.dumps(sig, indent=2, sort_keys=True) + "\n")
        return []
    expected = json.loads(GOLDEN_FILE.read_text())
    drifts: list[str] = []
    if sig.get("agents_with_zero_tools") != expected.get("agents_with_zero_tools"):
        drifts.append(
            f"agents_with_zero_tools drift: got {sig['agents_with_zero_tools']!r}, "
            f"expected {expected['agents_with_zero_tools']!r}"
        )
    if sig.get("total_unique_tools_invoked") != expected.get("total_unique_tools_invoked"):
        drifts.append(
            f"total_unique_tools_invoked drift: got {sig['total_unique_tools_invoked']}, "
            f"expected {expected['total_unique_tools_invoked']}"
        )
    # Wiring + outputs: deep-equal per agent / per tool.
    exp_wiring = expected.get("wiring", {})
    got_wiring = sig.get("wiring", {})
    for agent in sorted(set(exp_wiring) | set(got_wiring)):
        if exp_wiring.get(agent) != got_wiring.get(agent):
            drifts.append(
                f"wiring drift for agent {agent!r}: "
                f"got {got_wiring.get(agent)!r}, expected {exp_wiring.get(agent)!r}"
            )
    exp_outputs = expected.get("outputs", {})
    got_outputs = sig.get("outputs", {})
    for tname in sorted(set(exp_outputs) | set(got_outputs)):
        if exp_outputs.get(tname) != got_outputs.get(tname):
            drifts.append(f"output drift for tool {tname!r}")
    return drifts


# ---------------------------------------------------------------------------
# CLI.
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--update-golden",
        action="store_true",
        help="Overwrite expected-output.json with the current run's signature "
        "(use ONLY when an intentional stub change has been reviewed).",
    )
    parser.add_argument(
        "--json-summary",
        type=pathlib.Path,
        default=None,
        help="Optional path: write the full summary JSON here for debugging.",
    )
    args = parser.parse_args()

    exit_code, summary = run_smoke()

    # Print the human-readable aggregate (always — even on failure).
    print("─" * 64)
    print("W4 brand-campaign smoke test — D43 canary")
    print("─" * 64)
    print(f"  pipeline agents       : {len(summary['pipeline_topology'])}")
    print(f"  agents validated      : {summary['agents_validated']}/22")
    print(f"  agents_with_zero_tools: {len(summary['agents_with_zero_tools'])}")
    if summary["agents_with_zero_tools"]:
        for a in summary["agents_with_zero_tools"]:
            print(f"    - {a}")
    print(f"  unique tools invoked  : {summary['total_unique_tools_invoked']}")
    print(f"  tool invocations      : {summary['total_tool_invocations']}")
    print(f"  invocations passing   : {summary['total_passed']}")
    print(f"  invocations failing   : {summary['total_failed']}")
    if summary["failed_tools"]:
        print("  failed tools:")
        for f in summary["failed_tools"]:
            print(f"    × {f['agent_name']}.{f['tool_name']}: {f['error']}")
    print(f"  wall time             : {summary['elapsed_s']:.2f}s")

    # Regression diff (only runs if invocations all passed — otherwise the
    # output set is incomplete and would produce false-positive drift).
    if exit_code == 0:
        if args.update_golden:
            sig = golden_signature(summary)
            GOLDEN_FILE.write_text(json.dumps(sig, indent=2, sort_keys=True) + "\n")
            print(f"  golden file           : UPDATED → {GOLDEN_FILE.relative_to(REPO_ROOT)}")
        else:
            drifts = diff_against_golden(summary)
            if drifts:
                print("  golden file           : DRIFT")
                for d in drifts:
                    print(f"    × {d}")
                exit_code = 3
            else:
                if GOLDEN_FILE.exists():
                    print(f"  golden file           : MATCH ({GOLDEN_FILE.relative_to(REPO_ROOT)})")
                else:
                    print(f"  golden file           : CREATED ({GOLDEN_FILE.relative_to(REPO_ROOT)})")

    if args.json_summary:
        args.json_summary.write_text(json.dumps(summary, indent=2, default=str))

    print("─" * 64)
    print(f"exit code: {exit_code}  ({['ok', 'zero-tool agent', 'tool stub failure', 'golden drift'][exit_code]})")
    print("─" * 64)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
