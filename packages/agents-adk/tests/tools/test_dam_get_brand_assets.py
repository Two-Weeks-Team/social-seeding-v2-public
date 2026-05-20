"""tests/tools/test_dam_get_brand_assets.py — Build Example #2 A2A DAM hop.

`dam_get_brand_assets` is the **consumed half of `designed_guide.pdf` Build
Example #2** (marketing agent → A2A → internal DAM Agent for approved brand
logos, staying on-brand/compliant). It composes an A2A v0.3 task payload and
reaches the DAM over a REAL A2A v0.3 hop via `a2a_invoke` — the same proven
transport as the coordinator → ss-mcp edge.

Covers (all offline — mocks `a2a_invoke` / patches `httpx` so no live network):
  - Stub mode: the call traverses the real `a2a_invoke` capability + we get a
    deterministic on-brand verdict; transport recorded as "a2a".
  - Envelope: the A2A v0.3 message/send body posted to the DAM endpoint carries
    the brand name + post media URI + the `get_brand_assets` skill name.
  - Endpoint config (D42): `DAM_AGENT_ENDPOINT` env is honored in live mode;
    never hard-coded.
  - Live response parse: a real DAM task-artifact `data` part → DamGetBrandAssets
    verdict (brand_assets / on_brand / logo_detected / confidence).
  - Graceful fallback: a failed A2A hop / unparseable shape → NON-on-brand
    fallback (transport="fallback", a2a_succeeded=False) — never raises.
  - Pydantic validation: bad media url / empty brand rejected.
  - Cost attribute surfaced for cost_watch (D41).
"""
from __future__ import annotations

import socket
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

import ss_agents.tools.dam_get_brand_assets as dam_mod
from ss_agents.tools.dam_get_brand_assets import (
    DamGetBrandAssetsInput,
    DamGetBrandAssetsOutput,
    _build_dam_task_payload,
    _dam_endpoint,
    _parse_dam_response,
    dam_get_brand_assets,
)


# ─────────────────────────────────────────────────────────────────────────────
# Shared helpers — a DAM-shaped A2A task envelope + a DNS-quiet fixture.
# ─────────────────────────────────────────────────────────────────────────────


def _dam_task_envelope(*, on_brand: bool = True) -> dict[str, Any]:
    """An A2A v0.3 `task/completed` envelope whose data artifact is a DAM
    `get_brand_assets` verdict — the shape the ss-mcp DAM skill returns."""
    return {
        "kind": "task",
        "id": "task-dam-1",
        "contextId": "ctx-dam-1",
        "status": {"state": "completed", "timestamp": "2026-05-20T00:00:00Z"},
        "artifacts": [
            {
                "artifactId": "task-dam-1-result",
                "parts": [
                    {
                        "kind": "data",
                        "data": {
                            "brand_assets": [
                                {
                                    "asset_id": "logo-001",
                                    "kind": "logo",
                                    "uri": "gs://ss-v2-dam/approved/freshly/logo.png",
                                }
                            ],
                            "logo_detected": True,
                            "confidence_0_1": 0.94,
                            "on_brand": on_brand,
                            "compliance_notes": "Primary logo matched on the post thumbnail.",
                        },
                    }
                ],
            }
        ],
    }


def _addrinfo(ip: str) -> list[tuple[Any, ...]]:
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]


@pytest.fixture(autouse=True)
def _no_live_dns(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Resolve any allowlisted DNS host to a fixed PUBLIC IP so the A2A SSRF
    guard passes WITHOUT hitting the network (mirrors the a2a_invoke suite)."""
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: _addrinfo("34.143.72.2"))
    yield


class _CapturingTransport:
    """Records the request `httpx.post` would have made + returns a scripted
    A2A response — lets us assert the DAM envelope without any network."""

    def __init__(self, *, status_code: int = 200, body: Any = None) -> None:
        self.status_code = status_code
        self._body = _dam_task_envelope() if body is None else body
        self.calls: list[dict[str, Any]] = []

    def __call__(self, url: str, **kwargs: Any) -> httpx.Response:
        self.calls.append({"url": url, **kwargs})
        request = httpx.Request("POST", url)
        if isinstance(self._body, (dict, list)):
            return httpx.Response(self.status_code, json=self._body, request=request)
        return httpx.Response(self.status_code, text=str(self._body), request=request)


def _valid_input() -> DamGetBrandAssetsInput:
    return DamGetBrandAssetsInput(
        expected_brand_name="Freshly",
        post_media_url="gs://ss-v2-media/posts/p1/thumb.jpg",
        correlation_id="trace-dam-001",
    )


# ═════════════════════════════════════════════════════════════════════════════
# 1. Input / output contract
# ═════════════════════════════════════════════════════════════════════════════


class TestContract:
    def test_valid_input(self) -> None:
        i = _valid_input()
        assert i.expected_brand_name == "Freshly"
        assert i.post_media_url.startswith("gs://")
        assert i.correlation_id == "trace-dam-001"

    def test_default_correlation_id(self) -> None:
        i = DamGetBrandAssetsInput(
            expected_brand_name="Freshly",
            post_media_url="https://cdn.example.com/p1.jpg",
        )
        assert i.correlation_id == "dam-cv-001"

    @pytest.mark.parametrize("bad_url", ["/local/path.jpg", "ftp://x/y", "http://x/y"])
    def test_media_url_scheme_rejected(self, bad_url: str) -> None:
        with pytest.raises(ValidationError):
            DamGetBrandAssetsInput(
                expected_brand_name="Freshly", post_media_url=bad_url
            )

    def test_https_media_url_accepted(self) -> None:
        i = DamGetBrandAssetsInput(
            expected_brand_name="Freshly",
            post_media_url="https://cdn.example.com/p1.jpg",
        )
        assert i.post_media_url == "https://cdn.example.com/p1.jpg"

    def test_empty_brand_rejected(self) -> None:
        with pytest.raises(ValidationError):
            DamGetBrandAssetsInput(
                expected_brand_name="   ", post_media_url="gs://b/x.jpg"
            )

    def test_unknown_field_rejected(self) -> None:
        with pytest.raises(ValidationError):
            DamGetBrandAssetsInput.model_validate(
                {
                    "expected_brand_name": "Freshly",
                    "post_media_url": "gs://b/x.jpg",
                    "extra": True,
                }
            )

    def test_output_round_trip(self) -> None:
        out = DamGetBrandAssetsOutput(
            logo_detected=True, confidence_0_1=0.5, on_brand=True
        )
        reborn = DamGetBrandAssetsOutput.model_validate(out.model_dump())
        assert reborn == out

    def test_confidence_range_enforced(self) -> None:
        with pytest.raises(ValidationError):
            DamGetBrandAssetsOutput(confidence_0_1=1.1)


# ═════════════════════════════════════════════════════════════════════════════
# 2. A2A envelope composition (pure function)
# ═════════════════════════════════════════════════════════════════════════════


class TestEnvelope:
    def test_payload_carries_skill_brand_and_media(self) -> None:
        payload = _build_dam_task_payload(_valid_input())
        # A bare A2A message ({"role","parts"}) that a2a_invoke wraps into
        # {"message": {...}}.
        assert payload["role"] == "user"
        kinds = [p["kind"] for p in payload["parts"]]
        assert "text" in kinds and "data" in kinds
        data_part = next(p for p in payload["parts"] if p["kind"] == "data")
        assert data_part["data"]["skill"] == "get_brand_assets"
        assert data_part["data"]["brand_name"] == "Freshly"
        assert data_part["data"]["post_media_url"].startswith("gs://")

    def test_text_part_names_the_brand(self) -> None:
        payload = _build_dam_task_payload(_valid_input())
        text_part = next(p for p in payload["parts"] if p["kind"] == "text")
        assert "Freshly" in text_part["text"]

    def test_parse_dam_response_extracts_verdict(self) -> None:
        parsed = _parse_dam_response({"data": {"on_brand": True, "logo_detected": True}})
        assert parsed is not None and parsed["on_brand"] is True

    def test_parse_dam_response_rejects_non_dam_shape(self) -> None:
        # The stub-echo branch (no DAM-shaped data) yields None.
        assert _parse_dam_response({"echo": {"k": "v"}}) is None
        assert _parse_dam_response({}) is None


# ═════════════════════════════════════════════════════════════════════════════
# 3. Endpoint configuration (D42 — env-configured, never hard-coded)
# ═════════════════════════════════════════════════════════════════════════════


class TestEndpointConfig:
    def test_default_is_stub_endpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("DAM_AGENT_ENDPOINT", raising=False)
        monkeypatch.delenv("CAPABILITY_LAYER_MODE", raising=False)
        assert _dam_endpoint() == "https://stub.local/agent/dam"

    def test_live_mode_honors_env_endpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        monkeypatch.setenv(
            "DAM_AGENT_ENDPOINT", "https://ss-mcp.example.run.app"
        )
        assert _dam_endpoint() == "https://ss-mcp.example.run.app"

    def test_no_hardcoded_live_host_in_module(self) -> None:
        """The only literal endpoint is the stub; live targets come from env."""
        import inspect

        src = inspect.getsource(dam_mod)
        assert "run.app" not in src  # no baked-in Cloud Run host
        assert 'os.getenv("DAM_AGENT_ENDPOINT"' in src


# ═════════════════════════════════════════════════════════════════════════════
# 4. Stub mode — call traverses the real a2a_invoke capability
# ═════════════════════════════════════════════════════════════════════════════


class TestStubMode:
    def test_stub_returns_deterministic_on_brand_verdict(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        monkeypatch.delenv("DAM_AGENT_ENDPOINT", raising=False)
        a = dam_get_brand_assets(_valid_input())
        b = dam_get_brand_assets(_valid_input())
        assert a.model_dump_json() == b.model_dump_json()
        assert a.on_brand is True
        assert a.logo_detected is True
        # Even in stub the call WENT THROUGH the real A2A capability.
        assert a.transport == "a2a"
        assert a.a2a_succeeded is True
        assert a.brand_assets and a.brand_assets[0].kind == "logo"

    def test_stub_invokes_real_a2a_invoke(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The hop is composed + dispatched through the REAL a2a_invoke (not a
        bypass): we spy on the a2a_invoke the module imported and assert it was
        called with the stub DAM endpoint + our composed payload."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "stub")
        monkeypatch.delenv("DAM_AGENT_ENDPOINT", raising=False)
        seen: dict[str, Any] = {}
        real = dam_mod.a2a_invoke

        def _spy(payload: Any) -> Any:
            seen["endpoint"] = str(payload.remote_agent_endpoint)
            seen["task_payload"] = payload.task_payload
            seen["correlation_id"] = payload.correlation_id
            return real(payload)

        monkeypatch.setattr(dam_mod, "a2a_invoke", _spy)
        out = dam_get_brand_assets(_valid_input())
        assert seen["endpoint"].startswith("https://stub.local/agent/dam")
        assert seen["correlation_id"] == "trace-dam-001"
        data_part = next(p for p in seen["task_payload"]["parts"] if p["kind"] == "data")
        assert data_part["data"]["skill"] == "get_brand_assets"
        assert out.a2a_succeeded is True


# ═════════════════════════════════════════════════════════════════════════════
# 5. Live mode — real A2A v0.3 message/send hop (httpx mocked)
# ═════════════════════════════════════════════════════════════════════════════


class TestLiveHop:
    def test_posts_a2a_v03_envelope_to_dam(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        monkeypatch.setenv("DAM_AGENT_ENDPOINT", "https://ss-mcp.example.run.app")
        transport = _CapturingTransport()
        monkeypatch.setattr(httpx, "post", transport)

        out = dam_get_brand_assets(_valid_input())

        # ── Request side: A2A v0.3 message/send to the DAM endpoint ───────────
        assert len(transport.calls) == 1
        call = transport.calls[0]
        assert call["url"] == "https://ss-mcp.example.run.app/v1/message:send"
        assert call["headers"]["A2A-Version"] == "0.3"
        body = call["json"]
        assert body["message"]["role"] == "user"
        assert body["message"]["messageId"] == "trace-dam-001"
        data_part = next(
            p for p in body["message"]["parts"] if p["kind"] == "data"
        )
        assert data_part["data"]["skill"] == "get_brand_assets"
        assert data_part["data"]["brand_name"] == "Freshly"

        # ── Response side: DAM verdict parsed off the task artifact ───────────
        assert out.transport == "a2a"
        assert out.a2a_succeeded is True
        assert out.on_brand is True
        assert out.logo_detected is True
        assert out.confidence_0_1 == pytest.approx(0.94)
        assert len(out.brand_assets) == 1
        assert out.brand_assets[0].asset_id == "logo-001"

    def test_live_off_brand_verdict_parsed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        monkeypatch.setenv("DAM_AGENT_ENDPOINT", "https://ss-mcp.example.run.app")
        transport = _CapturingTransport(body=_dam_task_envelope(on_brand=False))
        monkeypatch.setattr(httpx, "post", transport)
        out = dam_get_brand_assets(_valid_input())
        assert out.a2a_succeeded is True
        assert out.on_brand is False

    def test_live_carries_identity_token(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        monkeypatch.setenv("DAM_AGENT_ENDPOINT", "https://ss-mcp.example.run.app")
        monkeypatch.setenv("A2A_IDENTITY_TOKEN", "spiffe-dam-token")
        transport = _CapturingTransport()
        monkeypatch.setattr(httpx, "post", transport)
        dam_get_brand_assets(_valid_input())
        assert transport.calls[0]["headers"]["Authorization"] == "Bearer spiffe-dam-token"


# ═════════════════════════════════════════════════════════════════════════════
# 6. Graceful fallback — a failed hop is NEVER silently on-brand
# ═════════════════════════════════════════════════════════════════════════════


class TestFallback:
    def test_failed_hop_degrades_not_on_brand(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A 4xx from the DAM ⇒ fallback verdict: on_brand=False, fallback
        transport. content_verify must escalate, not assert compliance."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        monkeypatch.setenv("DAM_AGENT_ENDPOINT", "https://ss-mcp.example.run.app")
        transport = _CapturingTransport(status_code=403, body="forbidden")
        monkeypatch.setattr(httpx, "post", transport)
        out = dam_get_brand_assets(_valid_input())
        assert out.transport == "fallback"
        assert out.a2a_succeeded is False
        assert out.on_brand is False
        assert out.logo_detected is False
        assert "failed" in out.compliance_notes.lower()

    def test_transport_error_degrades_gracefully(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        monkeypatch.setenv("DAM_AGENT_ENDPOINT", "https://ss-mcp.example.run.app")
        monkeypatch.setattr("ss_agents.tools.a2a_invoke.time.sleep", lambda _s: None)

        def _boom(url: str, **kwargs: Any) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        monkeypatch.setattr(httpx, "post", _boom)
        out = dam_get_brand_assets(_valid_input())
        assert out.transport == "fallback"
        assert out.a2a_succeeded is False
        assert out.on_brand is False

    def test_ssrf_blocked_endpoint_degrades(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A mis-configured DAM endpoint pointing at the metadata server is
        SSRF-blocked by a2a_invoke ⇒ fallback (never egresses, never raises)."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        monkeypatch.setenv("DAM_AGENT_ENDPOINT", "https://169.254.169.254")

        def _boom(url: str, **kwargs: Any) -> httpx.Response:  # pragma: no cover
            raise AssertionError("blocked endpoint must NOT egress")

        monkeypatch.setattr(httpx, "post", _boom)
        out = dam_get_brand_assets(_valid_input())
        assert out.transport == "fallback"
        assert out.a2a_succeeded is False

    def test_invoke_raising_is_caught(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """If a2a_invoke itself raises (e.g. a fixture passes a stub-only
        endpoint a live caller can't reach), we degrade rather than crash."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        monkeypatch.setenv("DAM_AGENT_ENDPOINT", "https://ss-mcp.example.run.app")

        def _raise(payload: Any) -> Any:
            raise RuntimeError("boom")

        monkeypatch.setattr(dam_mod, "a2a_invoke", _raise)
        out = dam_get_brand_assets(_valid_input())
        assert out.transport == "fallback"
        assert out.a2a_succeeded is False
        assert "raised" in out.compliance_notes.lower()

    def test_unparseable_live_response_degrades(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A 200 hop whose artifact is not DAM-shaped (in live mode) ⇒ fallback."""
        monkeypatch.setenv("CAPABILITY_LAYER_MODE", "live")
        monkeypatch.setenv("DAM_AGENT_ENDPOINT", "https://ss-mcp.example.run.app")
        # A valid task envelope but with a non-DAM data part.
        weird = {
            "kind": "task",
            "id": "t",
            "contextId": "c",
            "status": {"state": "completed"},
            "artifacts": [
                {"artifactId": "r", "parts": [{"kind": "data", "data": {"unrelated": 1}}]}
            ],
        }
        transport = _CapturingTransport(body=weird)
        monkeypatch.setattr(httpx, "post", transport)
        out = dam_get_brand_assets(_valid_input())
        assert out.transport == "fallback"
        assert out.a2a_succeeded is False


# ═════════════════════════════════════════════════════════════════════════════
# 7. Cost surface (D41)
# ═════════════════════════════════════════════════════════════════════════════


def test_cost_attribute_exposed() -> None:
    assert hasattr(dam_get_brand_assets, "__capability_cost_usd__")
    assert isinstance(dam_get_brand_assets.__capability_cost_usd__, float)  # type: ignore[attr-defined]
    assert dam_get_brand_assets.__capability_cost_usd__ > 0.0  # type: ignore[attr-defined]
