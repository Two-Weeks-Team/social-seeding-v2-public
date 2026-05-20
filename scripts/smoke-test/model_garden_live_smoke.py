"""model_garden_live_smoke.py — operator-gated LIVE Model Garden proof (D47).

Track 3 official requirement #3 ("route LLM reasoning through Model Garden",
designed_guide.pdf p.6). This is the ONE-TAKE live counterpart to the offline
wiring proof in `packages/agents-adk/tests/runtime/test_run_with_adk_integration.py`.

It runs a single REAL `intake` invocation through `runtime._run_with_adk` with
`MODEL_GARDEN_ROUTING=true`, so the agent's reasoning is served from the Vertex
AI Model Garden publisher-model plane, and prints:

  * the resolved Model Garden model path (the exact string handed to LlmAgent),
  * the response JSON (an `asking` or `done` outcome),
  * the `usd_spent` for the call (~$0.005-0.01 for one Gemini 2.5 Flash turn).

Honest scoping (RULES.md, GRAND-NARRATIVE-PLAN.md §7): the offline test proves
the WIRING without billing; THIS script is the only place a live Model Garden
200 is observed, and it is operator-run by design — never part of CI.

Hard safety gate: it REFUSES to run unless `SS_LIVE=1` AND
`MODEL_GARDEN_ROUTING=true`, so it can never accidentally bill from a routine
test run. It also requires Application Default Credentials + project/location.

Requirements (set by the operator, never read from `.env`):
    SS_LIVE=1
    MODEL_GARDEN_ROUTING=true
    GOOGLE_GENAI_USE_VERTEXAI=TRUE
    GOOGLE_CLOUD_PROJECT=<project>           e.g. ss-v2-prod
    GOOGLE_CLOUD_LOCATION=<region>           e.g. us-central1
    + `gcloud auth application-default login`

Exit codes:
    0 — live Model Garden call returned a validated outcome (OutcomeOk).
    1 — refused: SS_LIVE!=1 or MODEL_GARDEN_ROUTING!=true (no billing happened).
    2 — refused: missing GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION.
    3 — the live invocation escalated (transport / auth / validation error).
    4 — environment / import error.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

# The cheapest live agent: intake (Gemini 2.5 Flash, one short turn).
_DEMO_USER_TEXT = "Run a Korean skincare campaign with 20 creators."


def _refuse(code: int, message: str) -> int:
    print(f"[model-garden-live] REFUSING ({code}): {message}", file=sys.stderr)
    return code


def _check_gates() -> int | None:
    """Return an exit code if any gate fails, else None to proceed."""
    if os.environ.get("SS_LIVE") != "1":
        return _refuse(
            1,
            "SS_LIVE must equal '1' to run a LIVE Model Garden call. This guard "
            "exists so a routine run never bills. Set SS_LIVE=1 to opt in.",
        )
    if os.environ.get("MODEL_GARDEN_ROUTING", "").lower() not in {"true", "1", "yes"}:
        return _refuse(
            1,
            "MODEL_GARDEN_ROUTING must be true — the whole point is to prove the "
            "Model Garden publisher path serves the call (D47).",
        )
    if not os.environ.get("GOOGLE_CLOUD_PROJECT"):
        return _refuse(2, "GOOGLE_CLOUD_PROJECT is required for the publisher path.")
    if not os.environ.get("GOOGLE_CLOUD_LOCATION"):
        return _refuse(2, "GOOGLE_CLOUD_LOCATION is required for the publisher path.")
    return None


async def _run_live() -> int:
    # Imports are inside the function so a gate refusal never pays the heavy
    # ADK import cost, and so an import failure maps to exit 4.
    from ss_agents.agents.intake import (
        IntakeInput,
        IntakeMessage,
        intake_agent_def,
    )
    from ss_agents.config import (
        get_settings,
        is_offline,
        reset_settings_cache,
        resolve_runtime_model,
    )
    from ss_agents.runtime import OutcomeOk, RunContext, run_agent

    # Ensure the settings singleton reflects the operator's env (the process may
    # have imported config earlier).
    reset_settings_cache()
    settings = get_settings()

    if is_offline():
        # Belt-and-braces: should be impossible after _check_gates, but never
        # bill silently — surface the misconfiguration loudly.
        return _refuse(
            1,
            "is_offline() is True despite the gates — refusing. Check SS_LIVE.",
        )

    resolved_model = resolve_runtime_model(intake_agent_def.model)

    print("[model-garden-live] D47 live proof — routing intake reasoning through Model Garden")
    print(f"[model-garden-live] project        : {settings.google_cloud_project}")
    print(f"[model-garden-live] location       : {settings.google_cloud_location}")
    print(f"[model-garden-live] declared model : {intake_agent_def.model}")
    print(f"[model-garden-live] resolved model : {resolved_model}")
    print("[model-garden-live] invoking live Vertex AI Model Garden (one turn)…")

    payload = IntakeInput(
        messages=[IntakeMessage(role="user", content=_DEMO_USER_TEXT)],
        workspaceId="ws_smoke_modelgarden_01",
        createdBy="operator@social-seeding.test",
        locale="ko",
    )
    ctx = RunContext(
        tenant_id="t_smoke00000000001",
        workspace_id="ws_smoke_modelgarden_01",
        trace_id="trace-model-garden-live-1",
        invoked_by="operator@social-seeding.test",
        # model_client MUST be None so run_agent dispatches to _run_with_adk.
    )
    assert ctx.model_client is None

    outcome = await run_agent(intake_agent_def, payload, ctx)

    print()
    print("=" * 72)
    print("MODEL GARDEN LIVE PROOF (Track 3 req #3 · D47 · D5 Gemini 2.5 Flash)")
    print("=" * 72)
    print(f"  resolved model path : {resolved_model}")
    print(f"  outcome kind        : {outcome.kind}")
    print(f"  usd_spent           : ${outcome.usd_spent:.6f}")
    print("  response JSON       :")
    print(
        json.dumps(
            outcome.model_dump(by_alias=True), indent=2, default=str, ensure_ascii=False
        )
    )
    print("=" * 72)

    if not isinstance(outcome, OutcomeOk):
        print(
            "[model-garden-live] FAIL — invocation escalated: "
            f"{getattr(outcome, 'reason', '?')}",
            file=sys.stderr,
        )
        return 3

    if outcome.usd_spent <= 0.0:
        print(
            "[model-garden-live] WARNING — usd_spent is 0; the call may not have "
            "billed (check usage_metadata).",
            file=sys.stderr,
        )

    print("[model-garden-live] PASS — live Model Garden call returned a valid outcome (exit 0)")
    return 0


def main() -> int:
    gate = _check_gates()
    if gate is not None:
        return gate
    try:
        return asyncio.run(_run_live())
    except ModuleNotFoundError as exc:
        return _refuse(4, f"import error (is the agents-adk venv active?): {exc}")
    except Exception as exc:  # surface any unexpected runtime error as exit 4
        print(
            f"[model-garden-live] ERROR ({type(exc).__name__}): {exc}",
            file=sys.stderr,
        )
        return 4


if __name__ == "__main__":
    sys.exit(main())
