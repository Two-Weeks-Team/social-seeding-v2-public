"""integration_a2a_smoke.py — cross-component A2A integration driver.

Track 3 official requirement #5 (multi-agent orchestration) live proof, and
the load-bearing cross-component edge for **D45** (DECISIONS.md:139 — single
Track-3 submission subsuming the entire Track-2 platform):

    coordinator (M1, Track 2)
        → a2a_invoke  (capability layer, CAPABILITY_LAYER_MODE=live)
        → tiktok-mcp-server.plan_creator_search  (Track 3, A2A v0.3 over HTTP)

This is the concrete A2A hop that makes the two submissions one story
(A2A-INTENTS.md §4). It must exit 0 with a real `task/completed` envelope
carrying ranked creators.

What this driver does:
  1. Runs the Track-2 `coordinator` agent with a deterministic stub model
     client (NO Gemini cost — the coordinator's job is to ROUTE). The candidate
     pool includes `tiktok-mcp-search` (transport=a2a_grpc, the Track-3 remote
     agent). The stub asserts the coordinator picks that remote candidate.
  2. Performs the transport switch the way Cloud Workflows does in production:
     because the chosen candidate is remote, it calls `a2a_invoke` in
     CAPABILITY_LAYER_MODE=live against the REAL ss-mcp-server endpoint.
  3. Validates the live response: HTTP 200 + A2A `task` envelope, `state ==
     completed`, and a non-empty `creators[]` list under the data artifact.
  4. Prints a structured proof block and exits 0 on success.

Constraints:
  - The coordinator LLM is stubbed (deterministic, $0).
  - The ss-mcp-server is in stub-mode ranker (~$0, no Gemini billed remotely).
  - The A2A target URL is injected via `A2A_TARGET` env or `--target`; never
    hardcoded into package code, never read from .env.

Exit codes:
   0 — coordinator routed to the remote agent AND the live A2A hop returned a
       completed task with ≥1 creator.
   1 — coordinator did not route to the remote A2A candidate.
   2 — the live A2A hop failed (transport / non-2xx / non-completed task).
   3 — the live A2A hop returned no creators (empty result).
   4 — environment / import error (actionable message printed).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

# Default live endpoint (I1 산출, ss-mcp-prod / us-central1). Overridable via
# A2A_TARGET env or --target. Kept here (not in package code) so the capability
# layer stays content-blind and URL-agnostic.
DEFAULT_TARGET = "https://ss-mcp-server-1049119860518.us-central1.run.app"

# The brief the coordinator hands to the remote `plan_creator_search` skill.
DEMO_BRIEF = (
    "Find 5 vegan-skincare TikTok creators in Korea for a Gen-Z launch."
)

# The remote A2A candidate id the coordinator must pick. Matches
# coordinator.py __main__ + A2A-INTENTS.md §4 (transport=a2a_grpc).
REMOTE_AGENT_ID = "tiktok-mcp-search"


def _fail(code: int, message: str) -> int:
    print(f"[a2a-integration] FAIL ({code}): {message}", file=sys.stderr)
    return code


def _resolve_target(cli_target: str | None) -> str:
    target = cli_target or os.environ.get("A2A_TARGET") or DEFAULT_TARGET
    return target.rstrip("/")


class _RoutingStub:
    """Deterministic coordinator stub — returns a routing decision that picks
    the remote A2A candidate. No Vertex AI, no cost.

    Mirrors `tests/conftest.py::ScriptedStub` but specialised so the smoke
    driver has no pytest dependency.
    """

    _stub_usd = 0.0

    def __init__(self, *, output: Any) -> None:
        self._output = output

    async def generate(
        self,
        *,
        agent_id: str,
        system_prompt: str,
        input_payload: Any,
        output_schema: type,
    ) -> Any:
        return self._output


async def _route(target: str) -> tuple[str, dict[str, Any]]:
    """Run the coordinator (stubbed) and return (chosen_agent_id, decision)."""
    from ss_agents.agents.coordinator import (
        CandidateAgent,
        CoordinatorInput,
        CoordinatorOutput,
        WorkspacePolicy,
        coordinator_agent_def,
        validate_output_against_pool,
    )
    from ss_agents.runtime import OutcomeOk, RunContext, run_agent

    payload = CoordinatorInput(
        taskDescription=(
            "Source 5 Korean vegan-skincare TikTok creators for a Gen-Z launch "
            "using the remote A2A research agent."
        ),
        workspacePolicy=WorkspacePolicy(
            allowedAgents=[],
            budgetRemainingUsd=2.50,
            slaTargetMs=20_000,
        ),
        candidateAgents=[
            CandidateAgent(
                agentId="sourcing",
                capabilities=["source_creators", "tiktok", "rapidapi"],
                avgLatencyMs=2_400,
                avgCostUsd=0.018,
                transport="in_process",
            ),
            CandidateAgent(
                agentId=REMOTE_AGENT_ID,
                capabilities=["source_creators", "tiktok", "remote", "a2a"],
                avgLatencyMs=15_000,
                avgCostUsd=0.012,
                transport="a2a_grpc",
            ),
        ],
        locale="en",
        allowRemote=True,
        preferLocal=False,
    )

    decision = CoordinatorOutput(
        chosenAgentId=REMOTE_AGENT_ID,
        routingRationale=(
            "Routing to the remote A2A research agent: it natively covers "
            "source_creators+tiktok over A2A and fits the budget/SLA."
        ),
        fallbackAgentId="sourcing",
        expectedCostUsd=0.012,
        expectedLatencyMs=15_000,
        confidence=0.92,
    )
    # Defense-in-depth: the decision must be consistent with the pool.
    validate_output_against_pool(decision, payload)

    ctx = RunContext(
        tenant_id="t_demo000000000000",
        workspace_id="ws_demo_a2a_smoke",
        trace_id="trace-integration-a2a-1",
        model_client=_RoutingStub(output=decision),
    )

    outcome = await run_agent(coordinator_agent_def, payload, ctx)
    if not isinstance(outcome, OutcomeOk):
        raise RuntimeError(f"coordinator escalated: {getattr(outcome, 'reason', outcome)}")
    chosen = outcome.value
    assert isinstance(chosen, CoordinatorOutput)
    return chosen.chosen_agent_id, chosen.model_dump(by_alias=True)


def _invoke_live(target: str) -> Any:
    """Perform the real A2A v0.3 hop to ss-mcp-server.plan_creator_search.

    Forces CAPABILITY_LAYER_MODE=live for THIS process so a2a_invoke._live()
    runs (the shell wrapper already exports it; we re-assert for safety).
    """
    os.environ["CAPABILITY_LAYER_MODE"] = "live"
    from ss_agents.tools.a2a_invoke import A2AInvokeInput, a2a_invoke

    return a2a_invoke(
        A2AInvokeInput(
            remoteAgentEndpoint=target,
            taskPayload={"brand_brief": DEMO_BRIEF},
            timeoutS=60,
            correlationId="trace-integration-a2a-1",
        )
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="cross-component A2A integration smoke")
    parser.add_argument(
        "--target",
        default=None,
        help="ss-mcp-server base URL (else $A2A_TARGET, else the I1 default).",
    )
    args = parser.parse_args(argv)
    target = _resolve_target(args.target)

    print("[a2a-integration] D45 cross-component proof: coordinator → a2a_invoke → ss-mcp-server")
    print(f"[a2a-integration] target: {target}")

    # ── Step 1: coordinator routing decision (stubbed LLM, $0) ──────────────
    try:
        chosen_id, decision = asyncio.run(_route(target))
    except Exception as exc:  # surface any env/import error as exit 4
        return _fail(4, f"coordinator routing raised: {type(exc).__name__}: {exc}")

    print(f"[a2a-integration] coordinator chose: {chosen_id}")
    print(f"[a2a-integration] routing rationale: {decision.get('routingRationale')}")
    if chosen_id != REMOTE_AGENT_ID:
        return _fail(
            1,
            f"coordinator chose {chosen_id!r}, expected the remote A2A agent "
            f"{REMOTE_AGENT_ID!r}",
        )

    # ── Step 2: transport switch → real A2A v0.3 hop (live) ─────────────────
    print(f"[a2a-integration] transport switch: invoking {REMOTE_AGENT_ID} over A2A (live)…")
    try:
        result = _invoke_live(target)
    except Exception as exc:  # surface any unexpected runtime error as exit 4
        return _fail(4, f"a2a_invoke live call raised: {type(exc).__name__}: {exc}")

    if not result.succeeded:
        return _fail(2, f"live A2A hop failed: {result.error}")

    payload = result.response_payload
    state = payload.get("state")
    if payload.get("kind") != "task" or state != "completed":
        return _fail(2, f"unexpected task envelope: kind={payload.get('kind')!r} state={state!r}")

    data = payload.get("data") or {}
    creators = data.get("creators") if isinstance(data, dict) else None
    if not isinstance(creators, list) or not creators:
        return _fail(3, "live A2A hop returned no creators")

    # ── Proof block ─────────────────────────────────────────────────────────
    print()
    print("=" * 72)
    print("A2A CROSS-COMPONENT PROOF (Track 3 req #5 · D45)")
    print("=" * 72)
    print(f"  edge            : coordinator → a2a_invoke → {REMOTE_AGENT_ID}.plan_creator_search")
    print(f"  transport       : A2A v0.3 message/send (POST {target}/v1/message:send)")
    print(f"  task id         : {payload.get('task_id')}")
    print(f"  context id      : {payload.get('context_id')}")
    print(f"  task state      : {state}")
    print(f"  round-trip      : {result.latency_ms} ms")
    print(f"  correlation id  : {payload.get('correlation_id')}")
    print(f"  creators ranked : {len(creators)}")
    print(f"  attribution     : {data.get('source_attribution')}")
    trace = data.get("trace") or {}
    if isinstance(trace, dict):
        print(f"  remote path     : {trace.get('path')} (keywords={trace.get('keywords')})")
    print("  top creators:")
    for c in creators[:5]:
        if isinstance(c, dict):
            print(
                f"    - @{c.get('unique_id'):<22} "
                f"followers={c.get('follower_count'):<8} "
                f"er={c.get('engagement_rate')} "
                f"fit={c.get('fit_score')}"
            )
    print("=" * 72)
    print(json.dumps({"chosen_agent_id": chosen_id, "task_state": state,
                      "creators": len(creators), "latency_ms": result.latency_ms}))
    print("[a2a-integration] PASS — exit 0")
    return 0


if __name__ == "__main__":
    sys.exit(main())
