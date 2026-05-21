"""agent_optimizer_tune — capability layer per D41.

Request a **Vertex AI Prompt Optimizer (data-driven)** optimization job. Implements
the `agent_optimizer.tune` capability from `optimizer.spec.md §6` for the
Tier-2 M3 optimizer agent (D23, D25 learning loop).

WHAT THE GA PRODUCT ACTUALLY IS (honesty — RULES.md §Professional Honesty):
    There is no clean GA "Agent Optimizer" product. The GA product is the
    **Vertex AI Prompt Optimizer**, specifically its *data-driven optimizer*
    (a.k.a. VAPO — Vertex AI Prompt Optimizer). It is a **batch / asynchronous
    custom-training job**, NOT an instant call: you give it a labeled example
    dataset + one or more target eval metrics + the system instruction to
    improve, it runs an iterative custom job that rewrites the instruction, and
    it writes the optimized instruction back to a Cloud Storage `output_path`.
    Doc: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/prompts/data-driven-optimizer

    The capability name `agent_optimizer.tune` is the spec's internal verb for
    "ask the Prompt Optimizer to improve this agent's prompt"; the symbol names
    (`AgentOptimizerTune*`) are kept for API stability — they map to the
    `agent_optimizer.tune` row in optimizer.spec.md §6, not to any product
    called "Agent Optimizer".

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic queue receipt: `job_id=opt-<agent_id>-001`, `eta_minutes=30`,
    `status="queued"`. Per the task brief, the canonical stub response is
    pinned so the optimizer's downstream "watch for completion" loop can
    exercise its happy path without a live Vertex client.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real **Vertex AI Prompt Optimizer (data-driven / VAPO)** invocation. Composes
    the data-driven-optimizer config (labeled examples derived from the observed
    failures + the target metric + the prompt to improve), uploads it to the
    operator-provided GCS bucket, and submits the optimization job via the
    google-cloud-aiplatform `vertexai.Client.prompt_optimizer.optimize(...)`
    SDK. Returns the Vertex job receipt (job id + config path + status).

    Live run is OPERATOR-GATED. The operator must provide, via env:
        GOOGLE_CLOUD_PROJECT      — the GCP project id.
        GOOGLE_CLOUD_LOCATION     — region (e.g. us-central1). Default us-central1.
        VERTEX_PROMPT_OPTIMIZER_GCS_BUCKET — a writable GCS bucket
                                    (e.g. gs://ss-v2-prompt-optimizer) where the
                                    config + labeled dataset + optimized output land.
    Application Default Credentials (ADC) must be present (gcloud auth
    application-default login, or a service-account key). No live gcloud is run
    from CI — this path only executes when an operator opts in explicitly.

Citations:
    D23 — Tier-2 M3 optimizer.
    D25 — Learning loop (Vertex AI Prompt Optimizer powers the data-driven
          prompt-rewrite half of the loop).
    D41 — Capability-layer ADK FunctionTool stub/live pattern.
    optimizer.spec.md §6 — Tool table row for `agent_optimizer.tune`.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

USD_COST: float = 0.0500
"""Vertex AI Prompt Optimizer (data-driven) list-price proxy (2026 H1): the
data-driven optimizer is a custom training job billed on the target/eval model
calls it makes; ~$0.05 is the per-request budget surfaced for cost accounting
(the optimizer.spec.md §6 USD cap is $5.00 across ≤22 agents). Surfaced via
`agent_optimizer_tune.usd_cost` for `cost_watch` (D41)."""


OptimizerJobStatus = Literal["queued", "running", "done"]
"""Lifecycle of a Vertex AI Prompt Optimizer (data-driven) job:
  - queued  → accepted by Vertex; the custom training job is awaiting a worker.
  - running → worker has started; partial progress observable.
  - done    → terminal; the optimizer agent reads the optimized instruction
              from the job's GCS `output_path` via a follow-up.
"""

# Optimization mode the data-driven optimizer runs in. We optimize the system
# *instruction* (not few-shot demos), matching what the M3 optimizer agent
# proposes (a prompt rewrite). Verbatim from the GA config schema.
OPTIMIZATION_MODE: str = "instruction"

# Default target/eval region + model for the data-driven optimizer job. The
# target_model is the model whose responses the optimizer scores while it
# rewrites the instruction; the optimizer agent (M3) runs Gemini 3.1 Pro, but
# the *Tier-1 agents it tunes* run on the Gemini 3.1 family (D5), so the GA job
# targets gemini-3.1-flash-lite by default (overridable by the operator).
DEFAULT_OPTIMIZER_LOCATION: str = "us-central1"
DEFAULT_TARGET_MODEL: str = "gemini-3.1-flash-lite"


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class ObservedFailure(BaseModel):
    """One observed failure pattern from Agent Observability + Evaluation.

    Free-form `payload` so the optimizer agent stays content-blind — this
    layer treats failures as opaque dicts so contract drift in the upstream
    Observability schema doesn't propagate here.

    In live mode each `ObservedFailure` becomes one or more labeled rows in the
    data-driven optimizer's `input_data_path` dataset (the optimizer needs
    labeled examples to score instruction candidates against the target metric).

    Attributes:
        kind: Failure family tag (e.g. `"timeout"`, `"validation_error"`,
            `"escalation"`). Surfaced as the labeled example's target so the
            optimizer can focus on the failure mode.
        sample_count: Number of traces that exhibited this failure pattern in
            the lookback window (used to weight criticality / replicate rows).
        payload: Free-form failure context (the trace's `Escalation.partial`
            or a redacted output snippet) — used as the example's input text.
    """

    model_config = ConfigDict(extra="forbid")

    kind: str = Field(min_length=1, max_length=64)
    sample_count: int = Field(ge=1, alias="sampleCount")
    payload: dict[str, Any] = Field(default_factory=dict)


class AgentOptimizerTuneInput(BaseModel):
    """Input contract — `agent_optimizer.tune` per optimizer.spec.md §6.

    Attributes:
        agent_id: The agent being tuned. Forms the deterministic stub job id.
        current_prompt: The system instruction to rewrite. Capped at 60_000
            chars (Gemini 3.1 Pro context-window leeway accounting for trace
            data). In live mode this is the data-driven optimizer's
            `system_instruction`.
        observed_failures: List of failure patterns from Agent Observability.
            In live mode these become the labeled examples (`input_data_path`).
        target_metric: The eval metric the data-driven optimizer should optimize
            against (e.g. `"routing_accuracy"`, `"latency_p95_ms"`,
            `"escalation_rate"`). In live mode this maps to
            `eval_metrics_types`.
    """

    model_config = ConfigDict(extra="forbid")

    agent_id: str = Field(min_length=1, max_length=64, alias="agentId")
    current_prompt: str = Field(
        min_length=1,
        max_length=60_000,
        alias="currentPrompt",
    )
    observed_failures: list[ObservedFailure] = Field(
        default_factory=list,
        max_length=200,
        alias="observedFailures",
    )
    target_metric: str = Field(min_length=1, max_length=64, alias="targetMetric")


class AgentOptimizerTuneOutput(BaseModel):
    """Output contract — queued job receipt.

    Attributes:
        job_id: Vertex AI Prompt Optimizer (data-driven) job id. Stub format:
            `opt-<agent_id>-001`. Live mode mints a Vertex-allocated id (the
            custom training job resource id, or a derived handle).
        eta_minutes: Caller-facing ETA for completion (≤ 240 min). Stub always
            returns 30; live mode echoes a coarse queue-depth estimate.
        status: One of queued/running/done (D25 lifecycle).
        config_gcs_uri: Live-only. The `gs://…` URI of the optimization config
            JSON the live path uploaded for the data-driven optimizer. `None`
            in stub mode (no GCS round-trip happens offline).
    """

    model_config = ConfigDict(extra="forbid")

    job_id: str = Field(min_length=1, max_length=80, alias="jobId")
    eta_minutes: int = Field(ge=0, le=240, alias="etaMinutes")
    status: OptimizerJobStatus
    config_gcs_uri: str | None = Field(
        default=None,
        alias="configGcsUri",
        description=(
            "Live-only `gs://…` URI of the data-driven optimizer config JSON. "
            "None in stub mode."
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def agent_optimizer_tune(payload: AgentOptimizerTuneInput) -> AgentOptimizerTuneOutput:
    """Queue a Vertex AI Prompt Optimizer (data-driven) optimization job.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated tuning request.

    Returns:
        `AgentOptimizerTuneOutput` with the queued job id, ETA, and status (and
        in live mode, the GCS URI of the uploaded optimization config).

    Raises:
        RuntimeError: live mode when an operator prerequisite is missing
            (GCS bucket env var, or the google-cloud-aiplatform SDK is not
            installed). The error names the exact operator step.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
agent_optimizer_tune.usd_cost = USD_COST  # type: ignore[attr-defined]


def _stub(payload: AgentOptimizerTuneInput) -> AgentOptimizerTuneOutput:
    """Deterministic queued receipt.

    Per the task brief: job_id=`opt-<agent_id>-001`, eta_minutes=30,
    status="queued". No GCS round-trip — `config_gcs_uri` stays None."""
    job_id = f"opt-{payload.agent_id}-001"
    logger.info(
        "agent_optimizer_tune_stub",
        extra={
            "agent_id": payload.agent_id,
            "job_id": job_id,
            "target_metric": payload.target_metric,
            "failure_samples": sum(f.sample_count for f in payload.observed_failures),
        },
    )
    return AgentOptimizerTuneOutput(
        jobId=job_id,
        etaMinutes=30,
        status="queued",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Live path — real Vertex AI Prompt Optimizer (data-driven / VAPO) submission.
# ─────────────────────────────────────────────────────────────────────────────


def _build_labeled_dataset(payload: AgentOptimizerTuneInput) -> list[dict[str, Any]]:
    """Turn the observed failures into labeled rows for the data-driven
    optimizer's `input_data_path` dataset.

    The data-driven optimizer needs labeled examples (input + target) to score
    instruction candidates against the target metric. Each `ObservedFailure`
    becomes one labeled row: the failure context (`payload`) is the example
    input, and the failure family (`kind`) is the label the rewritten
    instruction should help the model avoid/handle. `sample_count` is carried so
    the optimizer can weight frequent failures more heavily.

    Returns a list of JSONL-ready dicts (one per failure pattern).
    """
    rows: list[dict[str, Any]] = []
    for failure in payload.observed_failures:
        rows.append(
            {
                # The data-driven optimizer reads the configured prompt_template
                # variables from each row; we expose the failure context + the
                # expected handling as the labeled input/target pair.
                "failure_context": json.dumps(failure.payload, sort_keys=True),
                "failure_kind": failure.kind,
                "sample_count": failure.sample_count,
                "target_metric": payload.target_metric,
            }
        )
    return rows


def _build_optimization_config(
    payload: AgentOptimizerTuneInput,
    *,
    project: str,
    output_path: str,
    input_data_path: str,
) -> dict[str, Any]:
    """Compose the GA data-driven-optimizer config envelope.

    Field names are verbatim from the Vertex AI Prompt Optimizer (data-driven)
    config schema:
    https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/prompts/data-driven-optimizer

    The config is uploaded to GCS and referenced by `config_path` when the job
    is submitted via `vertexai.Client.prompt_optimizer.optimize(...)`.
    """
    return {
        "project": project,
        # The system instruction to improve (the agent's current prompt).
        "system_instruction": payload.current_prompt,
        # Template with {variable} placeholders matching the labeled dataset.
        "prompt_template": "{failure_context}",
        # The Google model whose responses the optimizer scores while rewriting.
        "target_model": os.getenv(
            "VERTEX_PROMPT_OPTIMIZER_TARGET_MODEL", DEFAULT_TARGET_MODEL
        ),
        # Optimize the instruction (not few-shot demos).
        "optimization_mode": OPTIMIZATION_MODE,
        # The metric(s) the data-driven optimizer optimizes against.
        "eval_metrics_types": [payload.target_metric],
        "eval_metrics_weights": [1.0],
        # Labeled examples (gs://… JSONL) + where the optimized instruction lands.
        "input_data_path": input_data_path,
        "output_path": output_path,
        # Instruction-optimization iterations (GA range 10-20, default 10).
        "num_steps": int(os.getenv("VERTEX_PROMPT_OPTIMIZER_NUM_STEPS", "10")),
    }


def _import_vertex_sdk() -> tuple[Any, Any]:
    """Import the Vertex AI + Cloud Storage SDKs, mapping ImportError to a
    RuntimeError that names the operator step.

    Factored out so tests can monkeypatch this single seam to inject fake
    `vertexai` + `storage` modules (no live gcloud / no real SDK in CI).

    Returns:
        (vertexai_module, storage_module)
    """
    try:
        import vertexai  # type: ignore[import-not-found]
        from google.cloud import storage  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - import guard.
        raise RuntimeError(
            "agent_optimizer_tune live mode needs google-cloud-aiplatform "
            "(vertexai) and google-cloud-storage. Operator step: "
            "`uv sync` (the deps are declared) then re-run with "
            "CAPABILITY_LAYER_MODE=live."
        ) from exc
    return vertexai, storage


def _live(payload: AgentOptimizerTuneInput) -> AgentOptimizerTuneOutput:
    """Live **Vertex AI Prompt Optimizer (data-driven / VAPO)** invocation.

    Operator-gated (see module docstring). Steps:
      1. Validate the operator prerequisites (GCS bucket + project env vars).
      2. Build the labeled-example dataset from `observed_failures`.
      3. Compose the data-driven-optimizer config envelope (system_instruction +
         target_metric → eval_metrics_types + the GCS input/output paths).
      4. Upload the labeled dataset (JSONL) + the config JSON to the bucket.
      5. Submit the optimization job via
         `vertexai.Client(...).prompt_optimizer.optimize(
             method=vertexai.types.PromptOptimizerMethod.VAPO,
             config={"config_path": <gs://…>, "wait_for_completion": False,
                     "service_account": <sa or None>})`.
      6. Return the Vertex job receipt (job id + the config GCS URI + status).
         The optimizer agent then reads the optimized instruction from the job's
         `output_path` via a follow-up read (`agent_optimizer.get_job`).

    The data-driven optimizer is a batch job, so we submit with
    `wait_for_completion=False` and return `status="queued"`; callers poll for
    completion (the M3 learning loop runs nightly, not inline).
    """
    bucket = os.getenv("VERTEX_PROMPT_OPTIMIZER_GCS_BUCKET")
    if not bucket:
        raise RuntimeError(
            "agent_optimizer_tune live mode requires a writable GCS bucket. "
            "Operator step: set VERTEX_PROMPT_OPTIMIZER_GCS_BUCKET=gs://<bucket> "
            "(and GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, and ADC via "
            "`gcloud auth application-default login`)."
        )
    project = os.getenv("GOOGLE_CLOUD_PROJECT")
    if not project:
        raise RuntimeError(
            "agent_optimizer_tune live mode requires GOOGLE_CLOUD_PROJECT. "
            "Operator step: export GOOGLE_CLOUD_PROJECT=<gcp-project-id>."
        )
    location = os.getenv("GOOGLE_CLOUD_LOCATION", DEFAULT_OPTIMIZER_LOCATION)

    vertexai, storage = _import_vertex_sdk()

    # 2-3. Build the GCS paths, the labeled dataset, and the optimizer config.
    bucket_root = bucket.rstrip("/")
    job_slug = f"opt-{payload.agent_id}"
    input_data_path = f"{bucket_root}/{job_slug}/dataset.jsonl"
    output_path = f"{bucket_root}/{job_slug}/output/"
    config_gcs_uri = f"{bucket_root}/{job_slug}/config.json"

    dataset_rows = _build_labeled_dataset(payload)
    config = _build_optimization_config(
        payload,
        project=project,
        output_path=output_path,
        input_data_path=input_data_path,
    )

    # 4. Upload dataset JSONL + config JSON to the bucket.
    path_after_scheme = bucket_root.removeprefix("gs://").split("/", 1)
    bucket_name = path_after_scheme[0]
    base_prefix = path_after_scheme[1] if len(path_after_scheme) > 1 else ""
    gcs_client = storage.Client(project=project)
    gcs_bucket = gcs_client.bucket(bucket_name)
    dataset_blob_name = "/".join(
        p for p in (base_prefix, job_slug, "dataset.jsonl") if p
    )
    config_blob_name = "/".join(
        p for p in (base_prefix, job_slug, "config.json") if p
    )
    jsonl = "\n".join(json.dumps(r, sort_keys=True) for r in dataset_rows)
    gcs_bucket.blob(dataset_blob_name).upload_from_string(
        jsonl, content_type="application/jsonl"
    )
    gcs_bucket.blob(config_blob_name).upload_from_string(
        json.dumps(config, indent=2), content_type="application/json"
    )

    # 5. Submit the data-driven optimizer (VAPO) job.
    client = vertexai.Client(project=project, location=location)
    result = client.prompt_optimizer.optimize(
        method=vertexai.types.PromptOptimizerMethod.VAPO,
        config={
            "config_path": config_gcs_uri,
            "wait_for_completion": False,
            "service_account": os.getenv("VERTEX_PROMPT_OPTIMIZER_SERVICE_ACCOUNT"),
        },
    )

    # 6. Return the receipt.
    job_id = getattr(result, "name", None) or f"opt-{payload.agent_id}-live"
    logger.info(
        "agent_optimizer_tune_live_submitted",
        extra={
            "agent_id": payload.agent_id,
            "job_id": job_id,
            "config_gcs_uri": config_gcs_uri,
            "target_metric": payload.target_metric,
        },
    )
    return AgentOptimizerTuneOutput(
        jobId=str(job_id)[:80],
        etaMinutes=30,
        status="queued",
        configGcsUri=config_gcs_uri,
    )


__all__ = [
    "USD_COST",
    "AgentOptimizerTuneInput",
    "AgentOptimizerTuneOutput",
    "ObservedFailure",
    "OptimizerJobStatus",
    "agent_optimizer_tune",
]
