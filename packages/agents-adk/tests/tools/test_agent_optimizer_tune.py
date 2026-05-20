"""tests/tools/test_agent_optimizer_tune.py — capability-layer seam tests.

Covers:
  - Stub returns deterministic queued receipt:
      job_id="opt-<agent_id>-001", eta_minutes=30, status="queued",
      config_gcs_uri=None.
  - Stub determinism (same input ⇒ identical JSON).
  - Live mode (Vertex AI Prompt Optimizer, data-driven / VAPO): operator-gated.
      · Missing GCS bucket / project ⇒ RuntimeError naming the operator step.
      · With the SDK mocked, composes the correct data-driven-optimizer config
        envelope + the VAPO optimize() call + returns the Vertex receipt.
  - The config/dataset builders produce the verbatim GA field names.
  - Pydantic input validation (rubric bounds, unknown fields, target_metric).

No live gcloud runs here: the Vertex + Cloud Storage SDKs are stubbed by
monkeypatching `_import_vertex_sdk`.
"""
from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from ss_agents.tools.agent_optimizer_tune import (
    DEFAULT_TARGET_MODEL,
    OPTIMIZATION_MODE,
    USD_COST,
    AgentOptimizerTuneInput,
    AgentOptimizerTuneOutput,
    ObservedFailure,
    _build_labeled_dataset,
    _build_optimization_config,
    agent_optimizer_tune,
)

# ─────────────────────────────────────────────────────────────────────────────
# 1. Stub happy path — deterministic queued receipt
# ─────────────────────────────────────────────────────────────────────────────


def test_stub_deterministic_receipt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
    out = agent_optimizer_tune(
        AgentOptimizerTuneInput(
            agentId="sourcing",
            currentPrompt="You are the sourcing agent. Find creators.",
            observedFailures=[
                ObservedFailure(
                    kind="escalation",
                    sampleCount=5,
                    payload={"reason": "low recall"},
                )
            ],
            targetMetric="routing_accuracy",
        )
    )
    assert isinstance(out, AgentOptimizerTuneOutput)
    assert out.job_id == "opt-sourcing-001"
    assert out.eta_minutes == 30
    assert out.status == "queued"
    # Stub does no GCS round-trip — config URI stays None.
    assert out.config_gcs_uri is None


def test_stub_job_id_format_includes_agent_id() -> None:
    """Different agent ⇒ different job id, both with _001 suffix."""
    out = agent_optimizer_tune(
        AgentOptimizerTuneInput(
            agentId="vetting",
            currentPrompt="p",
            observedFailures=[],
            targetMetric="precision",
        )
    )
    assert out.job_id == "opt-vetting-001"


def test_stub_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
    payload = AgentOptimizerTuneInput(
        agentId="critic",
        currentPrompt="judge",
        observedFailures=[],
        targetMetric="agreement",
    )
    a = agent_optimizer_tune(payload)
    b = agent_optimizer_tune(payload)
    assert a.model_dump_json() == b.model_dump_json()


def test_stub_handles_empty_failures() -> None:
    """observed_failures can be empty (e.g. proactive tune)."""
    out = agent_optimizer_tune(
        AgentOptimizerTuneInput(
            agentId="analyst",
            currentPrompt="p",
            observedFailures=[],
            targetMetric="quality",
        )
    )
    assert out.status == "queued"


# ─────────────────────────────────────────────────────────────────────────────
# 2. Live mode — Vertex AI Prompt Optimizer (data-driven / VAPO), operator-gated
# ─────────────────────────────────────────────────────────────────────────────


def _live_input() -> AgentOptimizerTuneInput:
    return AgentOptimizerTuneInput(
        agentId="conversation-responder",
        currentPrompt="You triage inbound creator replies.",
        observedFailures=[
            ObservedFailure(
                kind="misrouted:rate_signal_on_positive",
                sampleCount=7,
                payload={"classification": "interested", "rate_usd": 800},
            ),
            ObservedFailure(
                kind="misrouted:hard_no",
                sampleCount=4,
                payload={"classification": "declined"},
            ),
        ],
        targetMetric="triage_routing_accuracy",
    )


def test_live_requires_gcs_bucket(monkeypatch: pytest.MonkeyPatch) -> None:
    """Live mode is operator-gated: no bucket ⇒ RuntimeError naming the step."""
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    monkeypatch.delenv("VERTEX_PROMPT_OPTIMIZER_GCS_BUCKET", raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "ss-v2-demo")
    with pytest.raises(RuntimeError, match=r"VERTEX_PROMPT_OPTIMIZER_GCS_BUCKET"):
        agent_optimizer_tune(_live_input())


def test_live_requires_project(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    monkeypatch.setenv("VERTEX_PROMPT_OPTIMIZER_GCS_BUCKET", "gs://ss-v2-opt")
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    with pytest.raises(RuntimeError, match=r"GOOGLE_CLOUD_PROJECT"):
        agent_optimizer_tune(_live_input())


class _FakeBlob:
    def __init__(self, name: str, sink: dict[str, Any]) -> None:
        self._name = name
        self._sink = sink

    def upload_from_string(self, data: str, content_type: str) -> None:
        self._sink[self._name] = {"data": data, "content_type": content_type}


class _FakeBucket:
    def __init__(self, name: str, sink: dict[str, Any]) -> None:
        self.name = name
        self._sink = sink

    def blob(self, blob_name: str) -> _FakeBlob:
        return _FakeBlob(blob_name, self._sink)


class _FakeStorageClient:
    def __init__(self, project: str | None = None) -> None:
        self.project = project
        self.uploads: dict[str, Any] = {}
        self.bucket_names: list[str] = []

    def bucket(self, bucket_name: str) -> _FakeBucket:
        self.bucket_names.append(bucket_name)
        return _FakeBucket(bucket_name, self.uploads)


class _FakeOptimizeResult:
    name = "projects/ss-v2-demo/locations/us-central1/customJobs/9988"


class _FakePromptOptimizer:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def optimize(self, *, method: Any, config: dict[str, Any]) -> _FakeOptimizeResult:
        self.calls.append({"method": method, "config": config})
        return _FakeOptimizeResult()


class _FakeVertexClient:
    last: _FakeVertexClient | None = None

    def __init__(self, project: str | None = None, location: str | None = None) -> None:
        self.project = project
        self.location = location
        self.prompt_optimizer = _FakePromptOptimizer()
        _FakeVertexClient.last = self


class _FakeVapoMethod:
    pass


def _fake_vertex_module() -> Any:
    """A stand-in for the `vertexai` SDK exposing Client + types.PromptOptimizerMethod.VAPO."""
    import types as _t

    mod = _t.SimpleNamespace()
    mod.Client = _FakeVertexClient
    mod.types = _t.SimpleNamespace()
    mod.types.PromptOptimizerMethod = _t.SimpleNamespace(VAPO=_FakeVapoMethod())
    return mod


def _fake_storage_module() -> Any:
    import types as _t

    mod = _t.SimpleNamespace()
    mod.Client = _FakeStorageClient
    return mod


def test_live_composes_vapo_request_and_returns_receipt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With the SDK mocked, the live path uploads config+dataset and submits a
    VAPO job with the verbatim data-driven-optimizer config envelope."""
    import ss_agents.tools.agent_optimizer_tune as mod

    fake_vertex = _fake_vertex_module()
    fake_storage = _fake_storage_module()
    monkeypatch.setattr(mod, "_import_vertex_sdk", lambda: (fake_vertex, fake_storage))

    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    monkeypatch.setenv("VERTEX_PROMPT_OPTIMIZER_GCS_BUCKET", "gs://ss-v2-opt/prompts")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "ss-v2-demo")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")
    monkeypatch.delenv("VERTEX_PROMPT_OPTIMIZER_SERVICE_ACCOUNT", raising=False)
    monkeypatch.delenv("VERTEX_PROMPT_OPTIMIZER_TARGET_MODEL", raising=False)
    monkeypatch.delenv("VERTEX_PROMPT_OPTIMIZER_NUM_STEPS", raising=False)

    out = agent_optimizer_tune(_live_input())

    # Receipt carries the Vertex job id + the uploaded config URI.
    assert out.status == "queued"
    assert out.job_id == _FakeOptimizeResult.name
    assert out.config_gcs_uri == "gs://ss-v2-opt/prompts/opt-conversation-responder/config.json"

    # The VAPO optimize() call shape.
    client = _FakeVertexClient.last
    assert client is not None
    assert client.project == "ss-v2-demo"
    assert client.location == "us-central1"
    assert len(client.prompt_optimizer.calls) == 1
    call = client.prompt_optimizer.calls[0]
    assert call["method"] is fake_vertex.types.PromptOptimizerMethod.VAPO
    assert call["config"] == {
        "config_path": "gs://ss-v2-opt/prompts/opt-conversation-responder/config.json",
        "wait_for_completion": False,
        "service_account": None,
    }


def test_live_uploads_config_and_dataset_blobs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The live path writes the config JSON + the labeled dataset JSONL to GCS,
    under the bucket's nested prefix."""
    import ss_agents.tools.agent_optimizer_tune as mod

    fake_vertex = _fake_vertex_module()
    fake_storage = _fake_storage_module()
    captured: dict[str, Any] = {}

    class _CapturingStorageClient(_FakeStorageClient):
        def __init__(self, project: str | None = None) -> None:
            super().__init__(project)
            captured["client"] = self

    fake_storage.Client = _CapturingStorageClient
    monkeypatch.setattr(mod, "_import_vertex_sdk", lambda: (fake_vertex, fake_storage))

    monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
    monkeypatch.setenv("VERTEX_PROMPT_OPTIMIZER_GCS_BUCKET", "gs://ss-v2-opt/prompts")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "ss-v2-demo")

    agent_optimizer_tune(_live_input())

    storage_client = captured["client"]
    assert storage_client.bucket_names == ["ss-v2-opt"]
    uploads = storage_client.uploads
    cfg_key = "prompts/opt-conversation-responder/config.json"
    ds_key = "prompts/opt-conversation-responder/dataset.jsonl"
    assert cfg_key in uploads
    assert ds_key in uploads
    # Config JSON carries the GA field names + the right values.
    import json as _json

    cfg = _json.loads(uploads[cfg_key]["data"])
    assert cfg["project"] == "ss-v2-demo"
    assert cfg["system_instruction"] == "You triage inbound creator replies."
    assert cfg["eval_metrics_types"] == ["triage_routing_accuracy"]
    assert cfg["optimization_mode"] == OPTIMIZATION_MODE
    assert cfg["target_model"] == DEFAULT_TARGET_MODEL
    assert cfg["input_data_path"].endswith("/opt-conversation-responder/dataset.jsonl")
    assert cfg["output_path"].endswith("/opt-conversation-responder/output/")
    # Dataset is JSONL — one labeled row per observed failure.
    rows = [_json.loads(line) for line in uploads[ds_key]["data"].splitlines()]
    assert len(rows) == 2
    assert {r["failure_kind"] for r in rows} == {
        "misrouted:rate_signal_on_positive",
        "misrouted:hard_no",
    }


# ─────────────────────────────────────────────────────────────────────────────
# 2b. Config / dataset builders — verbatim GA data-driven-optimizer field names
# ─────────────────────────────────────────────────────────────────────────────


def test_build_optimization_config_uses_ga_field_names() -> None:
    cfg = _build_optimization_config(
        _live_input(),
        project="ss-v2-demo",
        output_path="gs://b/opt-x/output/",
        input_data_path="gs://b/opt-x/dataset.jsonl",
    )
    # Verbatim Vertex AI Prompt Optimizer (data-driven) config keys.
    assert set(cfg) == {
        "project",
        "system_instruction",
        "prompt_template",
        "target_model",
        "optimization_mode",
        "eval_metrics_types",
        "eval_metrics_weights",
        "input_data_path",
        "output_path",
        "num_steps",
    }
    assert cfg["optimization_mode"] == "instruction"
    assert cfg["eval_metrics_types"] == ["triage_routing_accuracy"]
    assert cfg["eval_metrics_weights"] == [1.0]
    assert cfg["num_steps"] == 10


def test_build_labeled_dataset_one_row_per_failure() -> None:
    rows = _build_labeled_dataset(_live_input())
    assert len(rows) == 2
    assert rows[0]["failure_kind"] == "misrouted:rate_signal_on_positive"
    assert rows[0]["sample_count"] == 7
    assert rows[0]["target_metric"] == "triage_routing_accuracy"
    # Failure context is a JSON string of the opaque payload.
    assert "rate_usd" in rows[0]["failure_context"]


def test_build_labeled_dataset_empty_when_no_failures() -> None:
    payload = AgentOptimizerTuneInput(
        agentId="analyst",
        currentPrompt="p",
        observedFailures=[],
        targetMetric="quality",
    )
    assert _build_labeled_dataset(payload) == []


# ─────────────────────────────────────────────────────────────────────────────
# 3. Input validation
# ─────────────────────────────────────────────────────────────────────────────


def test_input_rejects_empty_prompt() -> None:
    with pytest.raises(ValidationError):
        AgentOptimizerTuneInput(
            agentId="sourcing",
            currentPrompt="",
            observedFailures=[],
            targetMetric="m",
        )


def test_input_rejects_empty_target_metric() -> None:
    with pytest.raises(ValidationError):
        AgentOptimizerTuneInput(
            agentId="sourcing",
            currentPrompt="p",
            observedFailures=[],
            targetMetric="",
        )


def test_input_caps_observed_failures_at_200() -> None:
    with pytest.raises(ValidationError):
        AgentOptimizerTuneInput(
            agentId="sourcing",
            currentPrompt="p",
            observedFailures=[
                ObservedFailure(kind=f"k{i}", sampleCount=1, payload={})
                for i in range(201)
            ],
            targetMetric="m",
        )


def test_input_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        AgentOptimizerTuneInput.model_validate(
            {
                "agentId": "sourcing",
                "currentPrompt": "p",
                "observedFailures": [],
                "targetMetric": "m",
                "extra": True,
            }
        )


def test_observed_failure_rejects_zero_sample_count() -> None:
    with pytest.raises(ValidationError):
        ObservedFailure(kind="x", sampleCount=0, payload={})


def test_observed_failure_rejects_empty_kind() -> None:
    with pytest.raises(ValidationError):
        ObservedFailure(kind="", sampleCount=1, payload={})


# ─────────────────────────────────────────────────────────────────────────────
# Cost attribute
# ─────────────────────────────────────────────────────────────────────────────


def test_cost_attribute_exposed() -> None:
    assert hasattr(agent_optimizer_tune, "usd_cost")
    assert agent_optimizer_tune.usd_cost == USD_COST  # type: ignore[attr-defined]
    assert isinstance(agent_optimizer_tune.usd_cost, float)  # type: ignore[attr-defined]
