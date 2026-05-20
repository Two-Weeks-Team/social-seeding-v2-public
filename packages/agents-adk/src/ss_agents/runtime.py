"""runtime.py — the one place an LLM is called.

Python-Pydantic mirror of v2's TypeScript `AgentDef<I,O>` interface at
`packages/agents/src/runtime.ts:28-40`. This module enforces the four
non-negotiables for every agent in the fleet:

1. **Typed I/O** — input is a Pydantic model, output is a Pydantic model.
   Unparseable model output → escalation, NOT a retry loop.
2. **USD cap** — absolute per-invocation ceiling; exceeding it raises
   `BudgetExceeded` *before* the next LLM call (`before_model_callback`).
3. **Escalation** — `EscalateToHuman` is a typed Python exception caught by
   `run_agent` and returned as an `Escalation` outcome to the caller.
4. **Prompt-guard** — user-controlled fields in the input are sanitized for
   obvious prompt-injection patterns before the system prompt is composed.
   Model Armor (D21) does the deep work at the Vertex layer; this is the
   in-process belt-and-braces.

ADK-GUIDE.md citations (line refs by section heading):

- §2.1 — `LlmAgent` is the workhorse class. We always instantiate one.
- §2.2 — Plain Python functions ⇒ tools. We accept callables in `tools=`.
- §2.4 — Callbacks: `before_model_callback` enforces the USD cap;
         `after_model_callback` records cost into ADK session state.
- §3   — 2.0 Beta `Workflow(BaseNode)` graph runtime is *not* used here;
         we target the 1.x stable API surface per pyproject.toml pin.

PORTING-V2.md §5 citations:

- The cost_guard / cost_record callback pair is lifted from the
  outreach_writer template (lines 417-453). We generalize it to read per-model
  pricing from `ss_agents.config.MODEL_PRICING`.
- The `make_*_agent` factory pattern (lines 534-567) is preserved so each
  invocation gets a fresh LlmAgent (system prompt is parameterized by input).
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import time
from collections.abc import Awaitable, Callable
from typing import (
    Any,
    Generic,
    Literal,
    Protocol,
    TypeVar,
    runtime_checkable,
)

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ss_agents.config import (
    get_settings,
    is_offline,
    model_pricing,
    resolve_runtime_model,
)
from ss_agents.observability import agent_span, llm_child_span, record_outcome

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Typed exceptions — caught + converted into AgentOutcome.escalate.
# ─────────────────────────────────────────────────────────────────────────────


class BudgetExceeded(Exception):
    """Raised by the runtime when the agent's USD cap would be exceeded.

    Carries the spent + projected costs so the operator can audit and so the
    Pub/Sub event downstream has the full picture.
    """

    def __init__(self, *, agent_id: str, max_usd: float, spent_usd: float, projected_usd: float):
        self.agent_id = agent_id
        self.max_usd = max_usd
        self.spent_usd = spent_usd
        self.projected_usd = projected_usd
        super().__init__(
            f"Agent {agent_id!r} exceeded USD cap ${max_usd:.4f}: "
            f"spent=${spent_usd:.4f}, projected next=${projected_usd:.4f}"
        )


class EscalateToHuman(Exception):
    """Raised by the agent body or a tool when human intervention is required.

    The runtime catches this and produces an `Escalation` outcome. Callers (the
    workflow) inspect `outcome.kind == "escalate"` to gate downstream steps —
    mirrors v2's `AgentOutcome<O>.kind === "escalate"` pattern at
    `packages/agents/src/runtime.ts:51-53`.
    """

    def __init__(self, reason: str, *, partial: dict[str, Any] | None = None):
        self.reason = reason
        self.partial = partial or {}
        super().__init__(reason)


class PromptGuardBlocked(EscalateToHuman):
    """Specialization of EscalateToHuman for prompt-injection blocks.

    Distinct exception class so dashboards/SIEM can filter on it (D32 Chronicle
    feeds prompt_injection_attempt as a discrete signal type).
    """


# ─────────────────────────────────────────────────────────────────────────────
# Outcome envelope — mirrors specs/_common/shared.schema.json#/$defs/Outcome.
# ─────────────────────────────────────────────────────────────────────────────


class OutcomeOk(BaseModel):
    """Successful agent invocation. `value` is the validated agent output."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["ok"] = "ok"
    value: BaseModel
    """The validated Pydantic output model instance."""

    usd_spent: float = Field(ge=0.0, alias="usdSpent")
    """USD consumed by this invocation, summed across all LLM turns + tool calls."""


class Escalation(BaseModel):
    """Agent could not produce a valid output. Caller routes to human queue."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["escalate"] = "escalate"
    reason: str = Field(min_length=1, max_length=500)
    partial: dict[str, Any] = Field(default_factory=dict)
    """Best-effort partial output the agent had assembled before the escalation.
    Free-form; the dashboard renders it as JSON for the operator."""

    usd_spent: float = Field(ge=0.0, alias="usdSpent")


# Discriminated union, in TS terms `OutcomeOk | Escalation`. Mirrors
# `AgentOutcome<O>` at packages/agents/src/runtime.ts:51-53.
AgentOutcome = OutcomeOk | Escalation


# ─────────────────────────────────────────────────────────────────────────────
# Agent definition + run context — Pydantic mirrors of the v2 TS interfaces.
# ─────────────────────────────────────────────────────────────────────────────


I = TypeVar("I", bound=BaseModel)
O = TypeVar("O", bound=BaseModel)


SystemPromptBuilder = Callable[[BaseModel], str]
"""Builds the system prompt from the validated input. Sync only — no I/O."""


class AgentDef(BaseModel, Generic[I, O]):
    """Pydantic mirror of v2 `AgentDef<I, O>` (runtime.ts:28-40).

    Differences from the TS shape:

    - `tools` is a list of Python callables (plain functions per ADK §2.2) not
      dotted capability names. The capability layer is wrapped earlier — by
      Phase 3 each callable will close over the capability registry.
    - `model` is a plain string (validated against the ModelId enum at
      `specs/_common/shared.schema.json#/$defs/ModelId`); the ADK-side model
      string need not exactly match the enum (e.g. `gemini-flash-latest` for
      "always-latest" channel — see ADK-GUIDE.md §2.1 example).
    - `system_prompt` is a *function* of input → string. v2 had the same
      signature `(input) => string` (runtime.ts:39).
    """

    # Pydantic v2 reserves the `model_` prefix for its internals. We disable
    # the protected-namespace check so the field name `model` (which mirrors v2
    # AgentDef.model at runtime.ts:35) doesn't trigger a warning.
    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        frozen=True,
        protected_namespaces=(),
    )

    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_-]*$")
    """Stable agent identifier. Lowercase + dashes/underscores. Used as OTel
    span name + Pub/Sub topic suffix + ADK app_name."""

    description: str = Field(min_length=1, max_length=500)
    """Human-readable + LLM-readable. Per ADK-GUIDE.md §4 the description on
    sub-agents is part of the routing context — write it as a routing hint."""

    model: str = Field(min_length=1)
    """Gemini model id. Validated against MODEL_PRICING at runtime."""

    max_usd: float = Field(gt=0.0, le=100.0)
    """Per-invocation absolute USD cap. Raises BudgetExceeded when exceeded."""

    input_schema: type[I]
    """Pydantic class used to validate the input dict before the system prompt
    is composed. Equivalent to v2's `input: z.ZodTypeAny`."""

    output_schema: type[O]
    """Pydantic class used to validate the LLM's final response. Passed to
    ADK as `output_schema=` so Gemini's responseSchema enforces it natively
    (see PORTING-V2.md §5 lines 559-567)."""

    system_prompt: SystemPromptBuilder
    """Function input → str. Must be deterministic + side-effect-free."""

    tools: list[Callable[..., Any]] = Field(default_factory=list)
    """Plain Python functions, each docstring-documented per ADK §2.2."""

    max_turns: int = Field(default=8, ge=1, le=20)
    """Hard cap on LLM turns inside a single invocation (carry-over from v2
    runtime.ts:55 `MAX_MODEL_TURNS = 8`)."""


class RunContext(BaseModel):
    """Per-invocation context. Mirrors v2 `AgentRunContext` (runtime.ts:42-49).

    Required fields:
        tenant_id    — Identity Platform tenant id (D12).
        workspace_id — v2 workspace id, carried as-is.
        trace_id     — OTel trace id; binds this invocation to a campaign run.

    Optional fields:
        campaign_id        — campaign correlation, when applicable.
        autonomy_level     — copilot/checkpointed/autonomous (v2 policy.ts).
        campaign_budget_usd — per-campaign daily ceiling. When set, the runtime
                              consults the cost ledger before the first LLM call.
        model_client       — injected stub for tests. When None, the real ADK
                              Runner is used.
        invoked_by         — operator email or system id; recorded in OTel.
    """

    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        frozen=False,
        protected_namespaces=(),
    )

    tenant_id: str = Field(pattern=r"^t_[a-z0-9]{16}$")
    """Per shared.schema.json#/$defs/TenantId."""

    workspace_id: str = Field(pattern=r"^ws_[A-Za-z0-9_-]{8,40}$")
    """Per shared.schema.json#/$defs/WorkspaceId."""

    trace_id: str = Field(min_length=1)

    campaign_id: str | None = Field(default=None)
    autonomy_level: Literal["copilot", "checkpointed", "autonomous"] = "checkpointed"
    campaign_budget_usd: float | None = Field(default=None, ge=0.0)
    invoked_by: str | None = Field(default=None)

    # Injected stub: when not None, run_agent uses this instead of LlmAgent.
    # Typed as Any to keep Pydantic out of Protocol-validation territory; the
    # runtime checks the contract via duck typing (it just calls `.generate(...)`).
    model_client: Any = Field(default=None, exclude=True)


# ─────────────────────────────────────────────────────────────────────────────
# Stub model client — what tests inject in place of the live ADK Runner.
# ─────────────────────────────────────────────────────────────────────────────


@runtime_checkable
class StubModelClient(Protocol):
    """Test stand-in for the ADK LlmAgent + Vertex AI call.

    A stub returns the output Pydantic model directly. The runtime still
    enforces validation, USD bookkeeping, and the prompt-guard hook.
    """

    async def generate(
        self,
        *,
        agent_id: str,
        system_prompt: str,
        input_payload: BaseModel,
        output_schema: type[BaseModel],
    ) -> BaseModel: ...


# ─────────────────────────────────────────────────────────────────────────────
# run_agent — the public entry point.
# ─────────────────────────────────────────────────────────────────────────────


async def run_agent(
    agent_def: AgentDef[I, O],
    input_payload: I | dict[str, Any],
    ctx: RunContext,
) -> AgentOutcome:
    """Invoke `agent_def` with `input_payload`. Mirrors v2 runtime.ts:58-... .

    Returns:
        OutcomeOk when the LLM produced a valid output within the USD cap.
        Escalation when:
          - The input failed Pydantic validation.
          - The prompt-guard tripped on user-supplied text.
          - The LLM exceeded the USD cap before producing a final answer.
          - The LLM's final output failed Pydantic validation.
          - A tool / sub-agent raised EscalateToHuman.

    Never raises — all errors are converted to Escalation outcomes. This is
    deliberate: the calling Cloud Workflow expects a structured result so it
    can route to the human queue without try/catch in every step.
    """
    start = time.monotonic()
    settings = get_settings()

    # 1. Coerce dict → Pydantic input. Failure → Escalation (not BadRequest:
    #    the caller already proved the JSON parses; this is *semantic* invalid).
    try:
        validated_input: I = (
            input_payload
            if isinstance(input_payload, agent_def.input_schema)
            else agent_def.input_schema.model_validate(input_payload)
        )
    except ValidationError as exc:
        return Escalation(
            reason=f"input validation failed: {_first_validation_message(exc)}",
            partial={"raw_input": _safe_dump(input_payload)},
            usdSpent=0.0,
        )

    # 2. Prompt-guard on the validated input. Import here to avoid circular
    #    import (prompt_guard imports nothing from runtime, but we keep the
    #    runtime → tools direction clean).
    from ss_agents.tools.prompt_guard import guard_payload

    try:
        guard_payload(validated_input)
    except PromptGuardBlocked as exc:
        logger.warning(
            "prompt_guard_blocked",
            extra={
                "agent_id": agent_def.id,
                "tenant_id": ctx.tenant_id,
                "trace_id": ctx.trace_id,
                "reason": exc.reason,
            },
        )
        return Escalation(
            reason=f"prompt_guard: {exc.reason}",
            partial=exc.partial,
            usdSpent=0.0,
        )

    # 3. Per-campaign budget check (cheap — single Redis/Firestore read in
    #    production; skipped entirely when no budget is set).
    if ctx.campaign_budget_usd is not None and ctx.campaign_budget_usd <= 0.0:
        return Escalation(
            reason=(
                f"campaign budget exhausted: ${ctx.campaign_budget_usd:.4f} remaining"
            ),
            partial={},
            usdSpent=0.0,
        )

    # 4-6. Build the system prompt, dispatch to the model, validate the output —
    #       all inside one OTel span (`agent:{id}`) so every invocation is
    #       Cloud-Trace-exportable per D31 (SLO) + D32 (Cloud Monitoring +
    #       Chronicle SIEM). `agent_span` yields None when SS_OTEL_ENABLED=false
    #       (the test/dev default), so the no-op path adds zero overhead and
    #       `record_outcome(None, ...)` is a no-op. Live export happens only when
    #       the operator flips SS_OTEL_ENABLED=true with ADC present (see
    #       observability.py + README.md "Capturing a LIVE trace").
    usd_spent = 0.0
    with agent_span(
        agent_id=agent_def.id,
        tenant_id=ctx.tenant_id,
        workspace_id=ctx.workspace_id,
        trace_id=ctx.trace_id,
        model=agent_def.model,
    ) as span:
        # 4. Build the system prompt.
        try:
            system_prompt = agent_def.system_prompt(validated_input)
        except Exception as exc:  # pragma: no cover — only happens on programmer error
            record_outcome(span, kind="escalate", usd_spent=0.0)
            return Escalation(
                reason=f"system_prompt builder raised: {type(exc).__name__}: {exc}",
                partial={},
                usdSpent=0.0,
            )

        # 5. Dispatch to either the stub (tests) or the live ADK Runner. Both
        #    paths emit child spans (`llm:{model}` / `tool:{name}`) into the
        #    active `agent:{id}` span — the stub via `_record_llm_child_span`,
        #    the live path via ADK's own callback-driven instrumentation that
        #    inherits this provider's context.
        try:
            if ctx.model_client is not None or is_offline():
                output, usd_spent = await _run_with_stub(
                    agent_def=agent_def,
                    input_payload=validated_input,
                    system_prompt=system_prompt,
                    ctx=ctx,
                )
            else:
                output, usd_spent = await _run_with_adk(
                    agent_def=agent_def,
                    input_payload=validated_input,
                    system_prompt=system_prompt,
                    ctx=ctx,
                )
        except BudgetExceeded as exc:
            record_outcome(span, kind="escalate", usd_spent=exc.spent_usd)
            return Escalation(
                reason=str(exc),
                partial={"max_usd": exc.max_usd},
                usdSpent=exc.spent_usd,
            )
        except EscalateToHuman as exc:
            record_outcome(span, kind="escalate", usd_spent=usd_spent)
            return Escalation(
                reason=exc.reason,
                partial=exc.partial,
                usdSpent=usd_spent,
            )
        except ValidationError as exc:
            record_outcome(span, kind="escalate", usd_spent=usd_spent)
            return Escalation(
                reason=f"output validation failed: {_first_validation_message(exc)}",
                partial={},
                usdSpent=usd_spent,
            )
        except Exception as exc:  # pragma: no cover — defense in depth
            logger.exception(
                "agent_runtime_unexpected",
                extra={"agent_id": agent_def.id, "trace_id": ctx.trace_id},
            )
            record_outcome(span, kind="escalate", usd_spent=usd_spent)
            return Escalation(
                reason=f"unexpected runtime error: {type(exc).__name__}: {exc}",
                partial={},
                usdSpent=usd_spent,
            )

        # 6. Success — stamp the outcome onto the span before it closes.
        record_outcome(span, kind="ok", usd_spent=usd_spent)

    elapsed_ms = int((time.monotonic() - start) * 1000)
    logger.info(
        "agent_completed",
        extra={
            "agent_id": agent_def.id,
            "trace_id": ctx.trace_id,
            "tenant_id": ctx.tenant_id,
            "usd_spent": usd_spent,
            "elapsed_ms": elapsed_ms,
        },
    )
    return OutcomeOk(value=output, usdSpent=usd_spent)


# ─────────────────────────────────────────────────────────────────────────────
# Dispatchers — stub vs ADK. Both produce (validated_output, usd_spent).
# ─────────────────────────────────────────────────────────────────────────────


async def _run_with_stub(
    *,
    agent_def: AgentDef[I, O],
    input_payload: I,
    system_prompt: str,
    ctx: RunContext,
) -> tuple[O, float]:
    """Stub path used by tests AND by the offline fallback.

    The stub returns the output object directly; we still apply USD-cap +
    validation gates so tests cover the same code paths as production.
    """
    assert ctx.model_client is not None, "stub path entered with no model_client"
    # Wrap the (stubbed) model call in a child `llm:{model}` span so the offline
    # path produces the same minimal span tree the live ADK path does. No-op
    # when tracing is disabled.
    with llm_child_span(model=agent_def.model, agent_id=agent_def.id):
        output_obj = await ctx.model_client.generate(
            agent_id=agent_def.id,
            system_prompt=system_prompt,
            input_payload=input_payload,
            output_schema=agent_def.output_schema,
        )

    # Cost: stubs declare their own cost via a `_stub_usd` attribute (test
    # fixture sets this), defaulting to 0 for free runs.
    usd_spent: float = float(getattr(ctx.model_client, "_stub_usd", 0.0))

    if usd_spent > agent_def.max_usd:
        raise BudgetExceeded(
            agent_id=agent_def.id,
            max_usd=agent_def.max_usd,
            spent_usd=usd_spent,
            projected_usd=usd_spent,
        )

    if not isinstance(output_obj, agent_def.output_schema):
        # Re-validate from a dict (stubs sometimes return raw dicts).
        output_obj = agent_def.output_schema.model_validate(
            output_obj.model_dump() if isinstance(output_obj, BaseModel) else output_obj
        )

    return output_obj, usd_spent  # type: ignore[return-value]


async def _run_with_adk(
    *,
    agent_def: AgentDef[I, O],
    input_payload: I,
    system_prompt: str,
    ctx: RunContext,
) -> tuple[O, float]:
    """Live ADK path. Lazy-imports google.adk so tests don't need it installed
    (it's a heavy import; pyproject keeps it as a hard dep, but unit tests run
    purely offline).

    Mirrors PORTING-V2.md §5 lines 583-617 (the FastAPI wrapper) but inlined
    here so callers do not need to spin up a runner per agent.

    D47 (Track 3 designed_guide.pdf req #3): the model handed to `LlmAgent` is
    passed through `resolve_runtime_model`, which — when
    `MODEL_GARDEN_ROUTING=true` — rewrites the short Gemini id into the Vertex
    AI Model Garden publisher-model path. Reasoning is then served from the
    Model Garden plane, the plane the "strict data security" controls (VPC-SC
    perimeter, CMEK, data residency per D13/D20) are enforced on. Pricing/cost
    accounting still keys off the agent's declared short id (`agent_def.model`),
    so the budget guard is unchanged by the rewrite.
    """
    try:
        from google.adk.agents import LlmAgent
        from google.adk.agents.callback_context import CallbackContext
        from google.adk.models import LlmRequest, LlmResponse
        from google.adk.runners import InMemoryRunner
        from google.genai import types as genai_types
    except ImportError as exc:  # pragma: no cover — ADK is a hard dep
        raise RuntimeError(
            "google-adk not installed. Run: uv pip install -e '.[dev]'"
        ) from exc

    # Cost accounting keys off the declared short id; the model string actually
    # sent to Vertex may be a Model Garden publisher path (D47) — see below.
    in_price, out_price = model_pricing(agent_def.model)
    runtime_model = resolve_runtime_model(agent_def.model)

    def cost_guard(
        callback_context: CallbackContext, llm_request: LlmRequest
    ) -> LlmResponse | None:
        """before_model_callback — abort if next call would exceed cap.

        Pattern lifted from PORTING-V2.md §5 lines 417-438.
        """
        spent = float(callback_context.state.get("agent_usd_spent", 0.0))
        if spent >= agent_def.max_usd:
            raise BudgetExceeded(
                agent_id=agent_def.id,
                max_usd=agent_def.max_usd,
                spent_usd=spent,
                projected_usd=spent,
            )
        return None

    def cost_record(
        callback_context: CallbackContext, llm_response: LlmResponse
    ) -> LlmResponse | None:
        """after_model_callback — tally usage from Vertex usage_metadata.

        Pattern lifted from PORTING-V2.md §5 lines 441-454.
        """
        usage = getattr(llm_response, "usage_metadata", None)
        if usage is None:
            return None
        cost = (
            (getattr(usage, "prompt_token_count", 0) or 0) * in_price
            + (getattr(usage, "candidates_token_count", 0) or 0) * out_price
        )
        callback_context.state["agent_usd_spent"] = (
            float(callback_context.state.get("agent_usd_spent", 0.0)) + cost
        )
        callback_context.state["last_call_usd"] = cost
        return None

    # Build a fresh LlmAgent per invocation — system prompt is parameterized
    # by input. Same pattern as PORTING-V2.md §5 lines 534-567.
    agent = LlmAgent(
        name=agent_def.id,
        model=runtime_model,  # D47: Model Garden publisher path when routing is on
        description=agent_def.description,
        instruction=system_prompt,
        output_schema=agent_def.output_schema,
        tools=list(agent_def.tools),
        before_model_callback=cost_guard,
        after_model_callback=cost_record,
    )

    runner = InMemoryRunner(agent=agent, app_name=f"ss-{agent_def.id}")
    session = await runner.session_service.create_session(
        app_name=f"ss-{agent_def.id}",
        user_id=ctx.campaign_id or ctx.workspace_id,
    )

    # Feed the validated input as a single "user" message — same as the v2
    # pattern. The system prompt is owned by the LlmAgent.
    final_text: str | None = None
    user_message = genai_types.Content(
        role="user",
        parts=[genai_types.Part(text=input_payload.model_dump_json())],
    )
    async for event in runner.run_async(
        user_id=ctx.campaign_id or ctx.workspace_id,
        session_id=session.id,
        new_message=user_message,
    ):
        if event.is_final_response() and event.content:
            # Last text-typed part is the structured response.
            parts = list(event.content.parts or [])
            if parts and getattr(parts[0], "text", None):
                final_text = parts[0].text

    usd_spent = float(session.state.get("agent_usd_spent", 0.0))

    if final_text is None:
        raise EscalateToHuman(
            "ADK agent produced no final response",
            partial={"session_state": dict(session.state)},
        )

    # responseSchema enforcement may have already validated this on Vertex's
    # side, but we re-validate for defense in depth (same as PORTING-V2.md §5
    # line 612 `OutreachDraft.model_validate_json(final_text)`).
    output_obj = agent_def.output_schema.model_validate_json(final_text)
    return output_obj, usd_spent  # type: ignore[return-value]


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _first_validation_message(exc: ValidationError) -> str:
    """Return the first human-readable Pydantic error message."""
    errors = exc.errors()
    if not errors:
        return str(exc)
    first = errors[0]
    loc = ".".join(str(p) for p in first.get("loc", []))
    msg = first.get("msg", "validation error")
    return f"{loc}: {msg}" if loc else msg


def _safe_dump(value: Any) -> dict[str, Any]:
    """Best-effort dict conversion that never raises."""
    if isinstance(value, BaseModel):
        return value.model_dump()
    if isinstance(value, dict):
        return value
    return {"_repr": repr(value)[:500]}


# ─────────────────────────────────────────────────────────────────────────────
# Sync convenience wrapper — for scripts that don't want to manage asyncio.
# ─────────────────────────────────────────────────────────────────────────────


def run_agent_sync(
    agent_def: AgentDef[I, O],
    input_payload: I | dict[str, Any],
    ctx: RunContext,
) -> AgentOutcome:
    """Synchronous wrapper around run_agent. Useful for CLI scripts + REPL.

    Raises RuntimeError if called inside an existing event loop (in that case
    the caller should `await run_agent(...)` directly).
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(run_agent(agent_def, input_payload, ctx))
    raise RuntimeError(
        "run_agent_sync called inside an event loop. "
        "Use `await run_agent(...)` instead."
    )


__all__ = [
    "AgentDef",
    "AgentOutcome",
    "BudgetExceeded",
    "EscalateToHuman",
    "Escalation",
    "OutcomeOk",
    "PromptGuardBlocked",
    "RunContext",
    "StubModelClient",
    "run_agent",
    "run_agent_sync",
]


# Touch the inspect module so static checkers don't drop the import — we
# carry it forward for Phase 3 (sig-driven tool schema generation).
_ = inspect
_ = Awaitable
