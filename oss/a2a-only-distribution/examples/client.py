# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""Minimal A2A v0.3 client — discover a card, then call `message/send`.

Dependency-light (Python stdlib ``urllib`` only). This is the caller side of
the A2A-only distribution pattern: it shows what a Gemini-Enterprise app (or
any A2A client) does to discover and invoke an agent that is published WITHOUT
a Marketplace listing — fetch the card, then POST a message to the
`message/send` REST binding and parse the returned task envelope.

It mirrors the real ``a2a_invoke`` capability from the Social Seeding reference
implementation (SSRF guard, retries, identity token, USD cost ledger) but
strips those production concerns to the bare protocol so the template stays
readable. See PROVENANCE.md for the full version.

Spec: https://a2a-protocol.org/specification/0.3.0 (message/send REST binding).

Usage:
    python3 client.py                       # talks to http://localhost:8080
    python3 client.py http://localhost:9999 "Find vegan-skincare creators"
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urljoin


def discover(base_url: str, timeout: float = 10.0) -> dict[str, Any]:
    """Fetch the agent's A2A v0.3 card from ``/.well-known/agent.json``."""
    card_url = urljoin(base_url.rstrip("/") + "/", ".well-known/agent.json")
    with urllib.request.urlopen(card_url, timeout=timeout) as resp:  # noqa: S310 (trusted base)
        return json.loads(resp.read().decode("utf-8"))


def message_send(base_url: str, text: str, timeout: float = 30.0) -> dict[str, Any]:
    """POST an A2A v0.3 ``message/send`` request and return the task envelope.

    Request body (A2A v0.3):
        {"message": {"role":"user","parts":[{"kind":"text","text": <text>}]}}
    """
    target = urljoin(base_url.rstrip("/") + "/", "v1/message:send")
    body = json.dumps(
        {
            "message": {
                "role": "user",
                "messageId": "client-demo-1",
                "parts": [{"kind": "text", "text": text}],
            }
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        target,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "A2A-Version": "0.3",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (trusted base)
        return json.loads(resp.read().decode("utf-8"))


def extract_result(task: dict[str, Any]) -> dict[str, Any] | None:
    """Pull the first ``data`` artifact part out of an A2A task envelope."""
    for artifact in task.get("artifacts", []) or []:
        for part in artifact.get("parts", []) or []:
            if isinstance(part, dict) and part.get("kind") == "data":
                return part.get("data")
    return None


def main() -> int:
    base_url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
    text = sys.argv[2] if len(sys.argv) > 2 else "Hello from the A2A client example."

    try:
        card = discover(base_url)
    except (urllib.error.URLError, TimeoutError) as exc:
        print(f"discovery failed against {base_url}: {exc}", file=sys.stderr)
        return 1

    print(f"discovered agent: {card.get('name')} (A2A v{card.get('protocolVersion')})")
    skills = [s.get("id") for s in card.get("skills", []) if isinstance(s, dict)]
    print(f"  skills: {skills}")

    try:
        task = message_send(base_url, text)
    except (urllib.error.URLError, TimeoutError) as exc:
        print(f"message:send failed: {exc}", file=sys.stderr)
        return 1

    state = (task.get("status") or {}).get("state")
    print(f"task {task.get('id')} -> state={state!r}")
    result = extract_result(task)
    print("result:")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
