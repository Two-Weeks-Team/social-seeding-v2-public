# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""Minimal, dependency-light A2A v0.3 agent skeleton (Python stdlib only).

This is the smallest server that makes an agent **discoverable and callable**
over the A2A protocol WITHOUT a Marketplace listing. It exposes the three
surfaces an A2A client (e.g. a Gemini Enterprise app) needs:

    GET  /.well-known/agent.json   -> the A2A v0.3 Agent Card (discovery)
    GET  /.well-known/jwks.json    -> public keys for verifying a signed card
    POST /v1/message:send          -> the A2A v0.3 `message/send` REST binding
    GET  /healthz                  -> liveness

It uses ONLY the Python standard library (``http.server``) so it runs anywhere
Python 3.9+ is installed — no pip install, no framework. Production agents will
want FastAPI/Express + a real IdP + card signing (see the README "fork this"
guide and the references to the Social Seeding reference implementation in
PROVENANCE.md), but the *protocol shape* below is exactly what those richer
servers serve.

Spec: https://a2a-protocol.org/specification/0.3.0
      AgentCard, message/send REST binding, task envelope.

Run:
    python3 server.py            # serves on :8080 by default
    PORT=9999 python3 server.py  # override port

Env:
    PORT                 listen port (default 8080)
    AGENT_CARD_PATH      path to the agent card JSON (default: ./agent.json,
                         falling back to a built-in generic stub)
    PUBLIC_BASE_URL      base URL advertised in the card's `url` (default
                         http://localhost:<PORT>)
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

PORT = int(os.environ.get("PORT", "8080"))
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", f"http://localhost:{PORT}")
AGENT_CARD_PATH = Path(os.environ.get("AGENT_CARD_PATH", "agent.json"))


# ---------------------------------------------------------------------------
# Agent card — load from disk, or fall back to a generic built-in stub.
# ---------------------------------------------------------------------------


def _builtin_stub_card() -> dict[str, Any]:
    """A generic, runnable A2A v0.3 card so the skeleton boots with zero config.

    Fork-step: drop a real ``agent.json`` (see ``agent.json.template``) next to
    this file and it is served verbatim instead of this stub.
    """
    return {
        "$schema": "https://a2a-protocol.org/schemas/v0.3/agent-card.json",
        "protocolVersion": "0.3.0",
        "name": "Example A2A-only Agent",
        "description": (
            "A generic A2A v0.3 agent skeleton. Replace this card with your own "
            "agent.json. Discoverable via this card without a Marketplace listing."
        ),
        "url": PUBLIC_BASE_URL,
        "preferredTransport": "HTTP+JSON",
        "additionalInterfaces": [
            {"url": f"{PUBLIC_BASE_URL}/v1", "transport": "HTTP+JSON"}
        ],
        "version": "1.0.0",
        "provider": {"organization": "Your Org", "url": "https://example.com"},
        "capabilities": {
            "streaming": False,
            "pushNotifications": False,
            "stateTransitionHistory": False,
        },
        "defaultInputModes": ["text/plain", "application/json"],
        "defaultOutputModes": ["application/json"],
        "skills": [
            {
                "id": "echo",
                "name": "Echo skill (placeholder)",
                "description": (
                    "Echoes the caller's text back inside a valid A2A task "
                    "envelope. Replace with your real skill."
                ),
                "tags": ["example", "echo"],
                "examples": ["Hello, agent.", "Summarize this brief: ..."],
                "inputModes": ["text/plain", "application/json"],
                "outputModes": ["application/json"],
            }
        ],
        "supportsAuthenticatedExtendedCard": False,
        "_distribution": {
            "path": "a2a-only",
            "marketplace_listing_status": "not-listed",
            "_comment": (
                "Discovery works via this card today; a Marketplace/Agentspace "
                "listing is an operator/Google-gated step that does not block "
                "A2A discovery."
            ),
        },
    }


def load_card() -> dict[str, Any]:
    """Read the on-disk card, or return the built-in generic stub."""
    if AGENT_CARD_PATH.exists():
        return json.loads(AGENT_CARD_PATH.read_text(encoding="utf-8"))
    return _builtin_stub_card()


# ---------------------------------------------------------------------------
# Skill dispatch — REPLACE `run_skill` with your agent's real logic.
# ---------------------------------------------------------------------------


def run_skill(skill_id: str, text: str, data: dict[str, Any] | None) -> dict[str, Any]:
    """Execute a skill and return its structured result blob.

    The skeleton ships ONE placeholder skill, ``echo``, which returns the
    caller's input. Replace the body with calls into your own tools / model /
    capability layer. The return value becomes the ``data`` part of the A2A
    task artifact (see ``_task_envelope``).

    Args:
        skill_id: the resolved skill id (from the data part's ``skill`` key, or
            the card's first skill when only text was sent).
        text: the first ``text`` part of the inbound A2A message, if any.
        data: the first ``data`` part of the inbound A2A message, if any.

    Returns:
        A JSON-serializable dict — your skill's output contract.
    """
    if skill_id == "echo":
        return {
            "skill": "echo",
            "echo_text": text,
            "echo_data": data or {},
            "source_attribution": "Source: A2A-only distribution template",
        }
    # Unknown skill — return a structured, honest error blob (still a valid
    # task; the caller decides how to handle a non-fatal skill miss).
    return {
        "error": "unknown_skill",
        "skill": skill_id,
        "message": f"This agent does not implement skill {skill_id!r}.",
    }


# ---------------------------------------------------------------------------
# A2A v0.3 task envelope helpers.
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _task_envelope(task_id: str, context_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """Wrap a skill result in an A2A v0.3 ``task`` envelope.

    Shape (A2A v0.3 message/send response):
        {"kind":"task","id","contextId",
         "status":{"state":"completed","timestamp"},
         "artifacts":[{"artifactId","parts":[{"kind":"data","data": <result>}]}]}
    """
    return {
        "kind": "task",
        "id": task_id,
        "contextId": context_id,
        "status": {"state": "completed", "timestamp": _now_iso()},
        "artifacts": [
            {
                "artifactId": f"{task_id}-result",
                "parts": [{"kind": "data", "data": result}],
            }
        ],
    }


def handle_message_send(body: dict[str, Any], card: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """Implement the A2A v0.3 ``message/send`` REST binding.

    Request body: ``{"message": {"role":"user","parts":[...]}}``.
    Each part is ``{"kind":"text","text": "..."}`` or
    ``{"kind":"data","data": {...}}``.

    Returns ``(http_status, response_body)``. A malformed request yields a 400
    with a JSON error; a valid request yields a 200 with a task envelope.
    """
    message = body.get("message")
    if not isinstance(message, dict):
        return 400, {"error": "bad_request", "message": "missing `message` object"}

    parts = message.get("parts")
    if not isinstance(parts, list) or not parts:
        return 400, {"error": "bad_request", "message": "`message.parts` must be a non-empty list"}

    text = ""
    data_part: dict[str, Any] | None = None
    for part in parts:
        if not isinstance(part, dict):
            continue
        if part.get("kind") == "text" and isinstance(part.get("text"), str) and not text:
            text = part["text"]
        if part.get("kind") == "data" and isinstance(part.get("data"), dict) and data_part is None:
            data_part = part["data"]

    if not text and data_part is None:
        return 400, {"error": "bad_request", "message": "message must carry a text or data part"}

    # Skill routing: explicit `data.skill`, else the card's first skill id.
    skills = card.get("skills") or []
    default_skill = skills[0].get("id") if skills and isinstance(skills[0], dict) else "echo"
    skill_id = (data_part or {}).get("skill") or default_skill

    now_ms = int(time.time() * 1000)
    task_id = message.get("messageId") or f"task-{now_ms}"
    context_id = message.get("contextId") or f"ctx-{now_ms}"

    result = run_skill(skill_id, text, data_part)
    return 200, _task_envelope(task_id, context_id, result)


# ---------------------------------------------------------------------------
# HTTP handler.
# ---------------------------------------------------------------------------


class A2AHandler(BaseHTTPRequestHandler):
    server_version = "a2a-only-skeleton/1.0"

    def _send_json(self, status: int, payload: dict[str, Any], cache: str | None = None) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        if cache:
            self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path in ("/.well-known/agent.json", "/.well-known/agent-card.json"):
            self._send_json(200, load_card())
            return
        if self.path == "/.well-known/jwks.json":
            # The stdlib skeleton does not sign the card (signing needs a crypto
            # dependency). It serves an empty-but-valid JWKS so the discovery
            # surface never hard-fails. The Social Seeding reference impl signs
            # the card with ES256 and publishes the public half here — see
            # PROVENANCE.md `card_signer.py`.
            self._send_json(200, {"keys": []}, cache="max-age=300, public")
            return
        if self.path in ("/", "/healthz", "/livez"):
            self._send_json(200, {"status": "ok", "service": "a2a-only-skeleton"})
            return
        self._send_json(404, {"error": "not_found", "path": self.path})

    def do_POST(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path not in ("/v1/message:send", "/v1/message%3Asend"):
            self._send_json(404, {"error": "not_found", "path": self.path})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError) as exc:
            self._send_json(400, {"error": "invalid_json", "message": str(exc)})
            return
        status, payload = handle_message_send(body, load_card())
        self._send_json(status, payload)

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter logs
        if os.environ.get("A2A_VERBOSE"):
            super().log_message(fmt, *args)


def main() -> None:
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), A2AHandler)
    print(f"A2A-only skeleton listening on http://0.0.0.0:{PORT}")
    print(f"  card:        GET  http://localhost:{PORT}/.well-known/agent.json")
    print(f"  jwks:        GET  http://localhost:{PORT}/.well-known/jwks.json")
    print(f"  message:send POST http://localhost:{PORT}/v1/message:send")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        httpd.shutdown()


if __name__ == "__main__":
    main()
