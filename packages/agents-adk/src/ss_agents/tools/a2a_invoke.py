"""a2a_invoke — capability layer per D41.

Invoke a remote A2A v0.3 agent. Implements the `a2a.invoke` capability from
`coordinator.spec.md §6` (Tier-2 M1 coordinator, D23 + D24).

Stub mode (CAPABILITY_LAYER_MODE=stub, default in dev/CI):
    Deterministic success for endpoints under `https://stub.local/agent/<id>`.
    The stub:
      - Echoes the input task_payload back under `response_payload.echo`.
      - Derives the agent id from the last URL path segment.
      - Records the supplied `correlation_id` so downstream Workflows replay
        matches the in-process path's response shape.
    Other endpoints raise `ValueError` so tests catch typos early.

Live mode (CAPABILITY_LAYER_MODE=live):
    Real outbound A2A v0.3 `message/send` invocation to a deployed remote
    agent (e.g. the Track-3 `tiktok-mcp-server` on Cloud Run). The hop posts
    the A2A v0.3 REST message envelope to `<endpoint>/v1/message:send` and
    parses the returned `task` envelope back into `response_payload`. This is
    the load-bearing cross-component edge for D45 — the single-Track-3 proof
    that the 22-agent ADK fleet and the refactored MCP server are one A2A
    ecosystem (A2A-INTENTS.md §4).

Citations:
    D23 — Tier-2 M1 coordinator picks local-or-remote per task.
    D24 — Phased coordination: 1→100 RemoteA2AAgent fan-out.
    D41 — Capability-layer ADK FunctionTool stub/live pattern.
    D44 — Agent Gateway / Agent Identity (SPIFFE) — the live hop presents a
          workload identity token when one is available (AGENT-IDENTITY.md).
    D45 — coordinator → a2a_invoke → tiktok-mcp-server.plan_creator_search is
          the cross-component proof for the single-Track-3 narrative.
    coordinator.spec.md §6 — Tool table row for `a2a.invoke`.

A2A v0.3 wire format (verified via Context7 `/websites/a2a-protocol` —
"message/send" REST + the live ss-mcp-server response):
    Request:  POST <endpoint>/v1/message:send
              {"message": {"role": "user", "parts": [{"kind":"text","text": "<brief>"}]}}
    Response: a `task` envelope
              {"kind":"task","id","contextId","status":{"state":"completed"},
               "artifacts":[{"artifactId","parts":[{"kind":"data","data":<RankedCreators>}]}]}
"""
from __future__ import annotations

import ipaddress
import logging
import os
import socket
import time
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator

logger = logging.getLogger(__name__)


# A2A v0.3 REST binding for the `message/send` method (verified via Context7
# against the A2A spec + the live ss-mcp-server deploy). The remote endpoint
# is the agent's base URL; the message:send route is appended.
_A2A_MESSAGE_SEND_PATH: str = "v1/message:send"

# Default text part the coordinator's task_payload maps onto when it does not
# already carry an explicit A2A message. The brief lives under one of these
# keys (coordinator hands the capability a content-blind dict per D41).
_BRIEF_KEYS: tuple[str, ...] = ("brand_brief", "brandBrief", "brief", "text", "task_description")

# Bounded retry budget for the live hop. The coordinator retries on its NEXT
# invocation (the runtime is single-turn), so we keep this small + total.
_LIVE_MAX_ATTEMPTS: int = 3
_LIVE_BACKOFF_BASE_S: float = 0.5

USD_COST: float = 0.0005
"""A2A invocation cost is the network hop + Agent Gateway fee (not the remote
agent's own LLM cost — that's billed against the remote tenant's budget).
Surfaced via `a2a_invoke.usd_cost` for `cost_watch` (D41)."""


_STUB_ENDPOINT_PREFIX: str = "https://stub.local/agent/"
"""Endpoints under this prefix MUST succeed deterministically in stub mode.
Anything else raises so tests fail fast on typos."""


# ─────────────────────────────────────────────────────────────────────────────
# SSRF guard for the LIVE hop (D44 Agent Gateway egress control).
#
# `remote_agent_endpoint` ultimately derives from the coordinator's routing
# decision / workspace config (D23). A compromised, mis-configured, or
# *hallucinated* endpoint could point the live POST at the GCP metadata server
# (169.254.169.254), localhost, or an RFC1918 internal host — classic SSRF. We
# validate the host BEFORE the POST: resolve it, and reject any address that
# lands in a blocked range unless the host suffix is explicitly allowlisted.
#
# Per D44, the Agent Gateway is the eventual egress-control plane; until O7
# (Private-Preview allowlist) lands, this in-process allow/deny is the live
# guard. Cite: D44 (Agent Gateway / egress), D23 (coordinator routing source),
# D32 (Chronicle SIEM — a block is an audit-worthy security signal).
# ─────────────────────────────────────────────────────────────────────────────

# Default allowlisted host suffixes. `.run.app` is the Cloud Run A2A surface;
# the explicit ss-mcp Cloud Run host + the prod DNS name are the canonical
# Track-3 endpoints (deployment/agent.json `additionalInterfaces`). Operators
# extend / override via the `A2A_ALLOWED_HOSTS` env var (comma-separated
# suffixes). Matching is case-insensitive suffix matching on the hostname.
_DEFAULT_ALLOWED_HOST_SUFFIXES: tuple[str, ...] = (
    ".run.app",
    "mcp.socialseed.ing",
    "ss-mcp-server-1049119860518.us-central1.run.app",
)


def _allowed_host_suffixes() -> tuple[str, ...]:
    """Resolve the effective allowlist of host suffixes.

    `A2A_ALLOWED_HOSTS` (comma-separated) OVERRIDES the default when set to a
    non-empty value, so an operator can both widen and narrow the surface. An
    unset / blank var falls back to `_DEFAULT_ALLOWED_HOST_SUFFIXES`.
    """
    raw = os.getenv("A2A_ALLOWED_HOSTS", "").strip()
    if not raw:
        return _DEFAULT_ALLOWED_HOST_SUFFIXES
    suffixes = tuple(s.strip().lower() for s in raw.split(",") if s.strip())
    return suffixes or _DEFAULT_ALLOWED_HOST_SUFFIXES


def _host_is_allowlisted(host: str) -> bool:
    """True when `host` ends with an allowlisted suffix (case-insensitive)."""
    h = host.lower().rstrip(".")
    for suffix in _allowed_host_suffixes():
        s = suffix.lower()
        if h == s or h.endswith(s if s.startswith(".") else f".{s}") or h == s.lstrip("."):
            return True
    return False


def _ip_is_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str | None:
    """Return a human reason string when `ip` falls in a blocked range, else None.

    Blocks (SSRF defense): link-local (incl. metadata 169.254.169.254),
    loopback, RFC1918 / unique-local-IPv6 private, unspecified (0.0.0.0 / ::),
    and reserved/multicast. These cover the metadata server + internal-host
    pivots an attacker would aim for.
    """
    if ip.is_link_local:  # 169.254.0.0/16 (incl. metadata), fe80::/10
        return "link_local"
    if ip.is_loopback:  # 127.0.0.0/8, ::1
        return "loopback"
    if ip.is_private:  # 10/8, 172.16/12, 192.168/16, fc00::/7
        return "private"
    if ip.is_unspecified:  # 0.0.0.0, ::
        return "unspecified"
    if ip.is_multicast or ip.is_reserved:
        return "reserved"
    return None


def _validate_live_host(endpoint: HttpUrl) -> str | None:
    """SSRF pre-flight for the live hop. Return a reason string when the
    endpoint must be blocked, else None (safe to proceed).

    Logic (fail-closed):
      1. Extract the hostname. Missing host ⇒ block.
      2. If the host is a raw IP literal: block it UNLESS the host is on the
         allowlist (an operator can opt a specific IP in via A2A_ALLOWED_HOSTS),
         AND the IP itself is not in a blocked range.
      3. For DNS hostnames: the host suffix MUST be on the allowlist (default
         `.run.app` etc.). Then resolve the name and reject if ANY resolved
         address is in a blocked range (defends against DNS-rebinding to the
         extent a single resolution can). Resolution failure ⇒ block (closed).
    """
    host = (endpoint.host or "").strip()
    if not host:
        return "no_host"

    # Bracketed IPv6 literals arrive without brackets via HttpUrl.host.
    parsed_ip: ipaddress.IPv4Address | ipaddress.IPv6Address | None = None
    try:
        parsed_ip = ipaddress.ip_address(host)
    except ValueError:
        parsed_ip = None

    allowlisted = _host_is_allowlisted(host)

    if parsed_ip is not None:
        # Raw-IP host: a dangerous range (metadata/loopback/private/…) is
        # ALWAYS blocked with its specific reason — even an allowlist entry can
        # not opt a metadata IP back in. Otherwise a raw IP is blocked unless
        # the operator explicitly allowlisted it.
        blocked = _ip_is_blocked(parsed_ip)
        if blocked:
            return f"raw_ip_{blocked}"
        if not allowlisted:
            return "raw_ip_not_allowlisted"
        return None

    # DNS hostname: enforce the suffix allowlist first.
    if not allowlisted:
        return "host_not_allowlisted"

    # Resolve and reject if any resolved address is in a blocked range. Fail
    # closed on resolution failure (an unresolvable allowlisted host is more
    # likely a misconfig / rebinding attempt than a legitimate target).
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError as exc:
        logger.warning(
            "a2a_invoke_ssrf_resolution_failed",
            extra={"host": host, "error": str(exc)},
        )
        return "resolution_failed"

    for info in infos:
        sockaddr = info[4]
        addr_str = sockaddr[0]
        try:
            resolved = ipaddress.ip_address(addr_str.split("%", 1)[0])
        except ValueError:
            continue
        blocked = _ip_is_blocked(resolved)
        if blocked:
            return f"resolved_{blocked}"

    return None


# ─────────────────────────────────────────────────────────────────────────────
# Input / Output models — Pydantic, with `extra=forbid` to fail closed.
# ─────────────────────────────────────────────────────────────────────────────


class A2AInvokeInput(BaseModel):
    """Input contract — `a2a.invoke` per coordinator.spec.md §6.

    Attributes:
        remote_agent_endpoint: HTTPS URL of the A2A endpoint. Must use the
            `https` scheme — A2A v0.3 mandates TLS (D44 Agent Gateway).
        task_payload: Free-form task envelope. The coordinator owns the shape;
            this layer is content-blind so contract drifts don't propagate.
        timeout_s: Per-invocation timeout in seconds (1-120). Live mode uses
            this as the HTTP read timeout; stub returns the value in
            `latency_ms` for assertion convenience (multiplied to ms).
        correlation_id: OTel trace correlation. Echoed in `response_payload`
            so the coordinator can pair the response with its original task.
    """

    model_config = ConfigDict(extra="forbid")

    remote_agent_endpoint: HttpUrl = Field(alias="remoteAgentEndpoint")
    task_payload: dict[str, Any] = Field(default_factory=dict, alias="taskPayload")
    timeout_s: int = Field(ge=1, le=120, alias="timeoutS")
    correlation_id: str = Field(
        min_length=1,
        max_length=128,
        alias="correlationId",
    )

    @field_validator("remote_agent_endpoint")
    @classmethod
    def _require_https(cls, v: HttpUrl) -> HttpUrl:
        """A2A v0.3 mandates TLS — reject http:// outright."""
        if v.scheme != "https":
            raise ValueError(
                f"remote_agent_endpoint must use https, got scheme={v.scheme!r}"
            )
        return v


class A2AInvokeOutput(BaseModel):
    """Output contract — invocation outcome.

    Attributes:
        response_payload: Free-form remote response. Stub returns
            `{"echo": <task_payload>, "agent_id": <derived>, "correlation_id": ...}`.
        latency_ms: Round-trip latency (stub returns `timeout_s * 10` ms as a
            stable, deterministic value — the test asserts on the multiplier).
        succeeded: True when the remote returned a 2xx response.
        error: Set ONLY when `succeeded is False`. Stub never sets this; live
            mode populates with the upstream error code/message.
    """

    model_config = ConfigDict(extra="forbid")

    response_payload: dict[str, Any] = Field(default_factory=dict, alias="responsePayload")
    latency_ms: int = Field(ge=0, alias="latencyMs")
    succeeded: bool
    error: str | None = Field(default=None, max_length=500)


# ─────────────────────────────────────────────────────────────────────────────
# Public callable — exposed to ADK as a FunctionTool per ADK-GUIDE.md §2.2.
# ─────────────────────────────────────────────────────────────────────────────


def a2a_invoke(payload: A2AInvokeInput) -> A2AInvokeOutput:
    """Invoke a remote A2A agent.

    Capability-layer dispatch (D41): stub by default, live when
    `CAPABILITY_LAYER_MODE=live`.

    Args:
        payload: Validated invocation request.

    Returns:
        `A2AInvokeOutput` with the remote response payload, latency, and
        success flag. Live transport/HTTP failures are returned as
        `succeeded=False, error=<...>` rather than raised — the coordinator
        treats a failed hop as a routing signal, not a crash.

    Raises:
        ValueError: stub mode, endpoint outside `https://stub.local/agent/`.
    """
    mode = os.getenv("CAPABILITY_LAYER_MODE", "stub")
    if mode == "stub":
        return _stub(payload)
    return _live(payload)


# Per D41: per-tool USD cost surfaced via attribute for `cost_watch`.
a2a_invoke.usd_cost = USD_COST  # type: ignore[attr-defined]


def _stub(payload: A2AInvokeInput) -> A2AInvokeOutput:
    """Deterministic success for `https://stub.local/agent/<id>` endpoints.

    Anything outside the allow-listed prefix raises ValueError — surface typos
    in the test fixtures rather than silently succeeding with a wrong shape.
    """
    endpoint_str = str(payload.remote_agent_endpoint)
    if not endpoint_str.startswith(_STUB_ENDPOINT_PREFIX):
        raise ValueError(
            f"a2a_invoke stub only accepts endpoints under "
            f"{_STUB_ENDPOINT_PREFIX!r}, got {endpoint_str!r}"
        )

    # Derive the agent id from the URL path. urlparse normalises trailing
    # slashes; we slice off the prefix and trim any leftover.
    parsed = urlparse(endpoint_str)
    raw_path = parsed.path.lstrip("/")  # 'agent/<id>'
    parts = [p for p in raw_path.split("/") if p]
    derived_agent_id = parts[-1] if len(parts) >= 2 else "unknown"

    # Stub latency = timeout * 10 (ms). Deterministic + bounded by input.
    latency_ms = payload.timeout_s * 10

    response_payload = {
        "echo": dict(payload.task_payload),
        "agent_id": derived_agent_id,
        "correlation_id": payload.correlation_id,
    }
    logger.debug(
        "a2a_invoke_stub",
        extra={
            "endpoint": endpoint_str,
            "agent_id": derived_agent_id,
            "correlation_id": payload.correlation_id,
            "latency_ms": latency_ms,
        },
    )
    return A2AInvokeOutput(
        responsePayload=response_payload,
        latencyMs=latency_ms,
        succeeded=True,
        error=None,
    )


def _build_a2a_message(payload: A2AInvokeInput) -> dict[str, Any]:
    """Map the coordinator's content-blind `task_payload` onto the A2A v0.3
    `message/send` request envelope.

    A2A v0.3 (verified via Context7 `/websites/a2a-protocol`): the request body
    is `{"message": {"role": "user", "parts": [...]}}`. The skill we target
    (`plan_creator_search`) takes the brief as a single `text` part.

    Two shapes are accepted from the coordinator:
      1. The payload already IS an A2A message envelope — `{"message": {...}}`
         or a bare `{"role","parts"}` — in which case it is forwarded verbatim
         (only normalising the outer `message` wrapper).
      2. The payload carries the brief under one of `_BRIEF_KEYS`; we wrap that
         text into a single `text` part. The `correlation_id` is attached as
         the A2A `messageId` so the remote can echo it for trace pairing.
    """
    raw = payload.task_payload

    # Shape 1a: already wrapped — forward the inner message verbatim.
    if isinstance(raw.get("message"), dict):
        message = dict(raw["message"])
        message.setdefault("role", "user")
        message.setdefault("messageId", payload.correlation_id)
        return {"message": message}

    # Shape 1b: a bare A2A message ({"role","parts"}) — wrap it.
    if "parts" in raw and isinstance(raw["parts"], list):
        message = {
            "role": raw.get("role", "user"),
            "parts": raw["parts"],
            "messageId": payload.correlation_id,
        }
        return {"message": message}

    # Shape 2: derive the brief text from a known key (or, failing that, the
    # first string value present) and wrap it into a single text part.
    text: str | None = None
    for key in _BRIEF_KEYS:
        val = raw.get(key)
        if isinstance(val, str) and val.strip():
            text = val
            break
    if text is None:
        # Last resort: any non-empty string value in the payload.
        text = next(
            (v for v in raw.values() if isinstance(v, str) and v.strip()),
            "",
        )

    return {
        "message": {
            "role": "user",
            "messageId": payload.correlation_id,
            "parts": [{"kind": "text", "text": text}],
        }
    }


def _extract_response_payload(task: dict[str, Any]) -> dict[str, Any]:
    """Pull the structured result out of an A2A v0.3 `task` envelope.

    The remote returns either a `task` (the ss-mcp-server case) or a bare
    `message`. For a task we surface the completion state, the first `data`
    artifact part (the `RankedCreators` payload for `plan_creator_search`),
    and the task ids so the coordinator can correlate. We never raise here —
    a malformed envelope just yields a thinner payload + `succeeded` is decided
    by the caller from the HTTP status + task state.
    """
    out: dict[str, Any] = {"kind": task.get("kind")}

    status = task.get("status")
    if isinstance(status, dict):
        out["state"] = status.get("state")
    out["task_id"] = task.get("id")
    out["context_id"] = task.get("contextId")

    # First data part across all artifacts is the structured result.
    data_part: Any = None
    artifacts = task.get("artifacts")
    if isinstance(artifacts, list):
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                continue
            for part in artifact.get("parts", []) or []:
                if isinstance(part, dict) and part.get("kind") == "data":
                    data_part = part.get("data")
                    break
            if data_part is not None:
                break
    if data_part is not None:
        out["data"] = data_part

    return out


def _live(payload: A2AInvokeInput) -> A2AInvokeOutput:
    """Live A2A v0.3 `message/send` invocation to a deployed remote agent.

    Steps (per the W7-promoted live path, D44 + D45):
      1. Compose the A2A v0.3 request envelope from the coordinator's
         content-blind `task_payload` (`_build_a2a_message`).
      2. Acquire a SPIFFE/Agent-Identity workload token when one is available
         (`_identity_token`). Cloud Run is unauthenticated today (AGENT-IDENTITY
         .md — mTLS is post-O7), so the token is optional and absent is fine.
      3. POST to `<remote_agent_endpoint>/v1/message:send` honoring `timeout_s`
         as the read timeout, with bounded exponential backoff (3 attempts).
      4. Parse the returned `task` envelope into `response_payload`; the
         `correlation_id` is echoed back for trace pairing.
      5. Surface transport / 4xx / 5xx failures as `succeeded=False,
         error="<code>: <msg>"` — never raise (the coordinator treats a failed
         hop as a routing signal).

    SSRF guard (D44 Agent Gateway egress / D32 SIEM signal): before any network
    egress we validate the endpoint host against the allow/deny rules
    (`_validate_live_host`). A blocked endpoint returns
    `succeeded=False, error="ssrf_blocked: <reason>"` — we DO NOT raise, so the
    coordinator sees it as a failed hop / routing signal exactly like a
    transport error (matching the existing failure convention).
    """
    start_guard = time.monotonic()
    ssrf_reason = _validate_live_host(payload.remote_agent_endpoint)
    if ssrf_reason is not None:
        logger.warning(
            "a2a_invoke_ssrf_blocked",
            extra={
                "endpoint": str(payload.remote_agent_endpoint),
                "host": payload.remote_agent_endpoint.host,
                "reason": ssrf_reason,
                "correlation_id": payload.correlation_id,
            },
        )
        return _live_failure(start_guard, f"ssrf_blocked: {ssrf_reason}")

    base = str(payload.remote_agent_endpoint)
    # urljoin needs a trailing slash on the base to append a relative path
    # without clobbering the last segment.
    target = urljoin(base if base.endswith("/") else base + "/", _A2A_MESSAGE_SEND_PATH)

    request_body = _build_a2a_message(payload)
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "A2A-Version": "0.3",
    }
    token = _identity_token(payload.remote_agent_endpoint)
    if token:
        headers["Authorization"] = f"Bearer {token}"

    start = time.monotonic()
    last_error: str = "no attempt made"
    for attempt in range(1, _LIVE_MAX_ATTEMPTS + 1):
        try:
            response = httpx.post(
                target,
                json=request_body,
                headers=headers,
                timeout=httpx.Timeout(float(payload.timeout_s)),
            )
        except httpx.HTTPError as exc:
            last_error = f"transport_error: {type(exc).__name__}: {exc}"
            logger.warning(
                "a2a_invoke_live_transport_error",
                extra={
                    "endpoint": target,
                    "attempt": attempt,
                    "correlation_id": payload.correlation_id,
                    "error": last_error,
                },
            )
            if attempt < _LIVE_MAX_ATTEMPTS:
                time.sleep(_LIVE_BACKOFF_BASE_S * (2 ** (attempt - 1)))
                continue
            return _live_failure(start, last_error)

        latency_ms = int((time.monotonic() - start) * 1000)

        # Retry 5xx (transient); 4xx is terminal (won't fix on retry).
        if response.status_code >= 500:
            last_error = f"{response.status_code}: {response.text[:200]}"
            if attempt < _LIVE_MAX_ATTEMPTS:
                time.sleep(_LIVE_BACKOFF_BASE_S * (2 ** (attempt - 1)))
                continue
            return _live_failure(start, last_error)
        if response.status_code >= 400:
            return A2AInvokeOutput(
                responsePayload={"http_status": response.status_code},
                latencyMs=latency_ms,
                succeeded=False,
                error=f"{response.status_code}: {response.text[:480]}",
            )

        # 2xx — parse the A2A task/message envelope.
        try:
            task = response.json()
        except ValueError as exc:
            return A2AInvokeOutput(
                responsePayload={"http_status": response.status_code},
                latencyMs=latency_ms,
                succeeded=False,
                error=f"invalid_json: {exc}",
            )

        result = _extract_response_payload(task if isinstance(task, dict) else {})
        result["correlation_id"] = payload.correlation_id

        # A completed task is success; any other terminal state is a failure
        # the coordinator should see (it may pick the fallback agent).
        state = result.get("state")
        succeeded = result.get("kind") != "task" or state == "completed"
        error: str | None = None
        if not succeeded:
            error = f"task_state: {state!r}"

        logger.info(
            "a2a_invoke_live_completed",
            extra={
                "endpoint": target,
                "attempt": attempt,
                "correlation_id": payload.correlation_id,
                "latency_ms": latency_ms,
                "state": state,
                "succeeded": succeeded,
            },
        )
        return A2AInvokeOutput(
            responsePayload=result,
            latencyMs=latency_ms,
            succeeded=succeeded,
            error=error,
        )

    # Unreachable — the loop always returns — but keeps mypy happy.
    return _live_failure(start, last_error)  # pragma: no cover


def _live_failure(start: float, error: str) -> A2AInvokeOutput:
    """Build a failed `A2AInvokeOutput` with the elapsed latency."""
    return A2AInvokeOutput(
        responsePayload={},
        latencyMs=int((time.monotonic() - start) * 1000),
        succeeded=False,
        error=error[:480],
    )


def _identity_token(endpoint: HttpUrl) -> str | None:
    """Acquire a workload identity (SPIFFE / Agent Identity) token for the hop.

    Per AGENT-IDENTITY.md (D44): the caller presents its workload identity and
    the callee verifies it at the transport layer. The Cloud Run demo endpoint
    is currently *unauthenticated* (mTLS is the post-O7 step), so this is
    optional — when no token source is configured we return None and the hop
    proceeds without an Authorization header.

    Two sources, in priority order:
      1. `A2A_IDENTITY_TOKEN` env var — an explicitly-provisioned token (test /
         CI / a sidecar that already minted one).
      2. Google ID token for the endpoint audience via the metadata server /
         ADC (`google.oauth2.id_token.fetch_id_token`). Best-effort: any
         failure (no ADC, offline, etc.) degrades to None rather than raising,
         because the demo callee does not require it.
    """
    explicit = os.getenv("A2A_IDENTITY_TOKEN")
    if explicit:
        return explicit

    if os.getenv("A2A_FETCH_ID_TOKEN") != "1":
        # Default: do NOT attempt ADC fetch (the demo endpoint is open and the
        # fetch adds latency + a hard google-auth dependency on the hot path).
        return None

    try:  # pragma: no cover — exercised only when A2A_FETCH_ID_TOKEN=1 + ADC.
        import google.auth.transport.requests as ga_requests
        from google.oauth2 import id_token as ga_id_token

        parsed = urlparse(str(endpoint))
        audience = f"{parsed.scheme}://{parsed.netloc}"
        token: str = ga_id_token.fetch_id_token(ga_requests.Request(), audience)  # type: ignore[no-untyped-call]
        return token
    except Exception as exc:  # pragma: no cover — best-effort, never fatal.
        logger.debug("a2a_invoke_identity_token_unavailable", extra={"error": str(exc)})
        return None


__all__ = [
    "USD_COST",
    "A2AInvokeInput",
    "A2AInvokeOutput",
    "a2a_invoke",
]
