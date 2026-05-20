#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""CLI: sign the A2A v0.3 agent card and emit the matching JWKS.

Implements the A2A v0.3 AgentCard ``signatures[]`` mechanism
(https://a2a-protocol.org/v0.3.0/specification/, §"Signing and Verifying the
AgentCard"): a JCS-canonicalized (RFC 8785) RFC 7515 JWS over the card so any
client can cryptographically verify the card's authorship.

Usage::

    # Sign the on-disk card in place (dev key auto-generated under
    # deployment/keys/ on first run, git-ignored), and write the JWKS:
    python deployment/sign_agent_card.py \
        --card deployment/agent.json \
        --jwks-out deployment/jwks.json

    # Verify a previously-signed card against a JWKS:
    python deployment/sign_agent_card.py --verify \
        --card deployment/agent.json \
        --jwks deployment/jwks.json

Key selection (honest dev-vs-prod split — see AGENT-IDENTITY.md §3/§7):
    * Default: a self-managed **dev** ES256 key under ``deployment/keys/``.
    * Production: set ``AGENT_CARD_SIGNING_KEY_PEM`` (Secret-Manager-provisioned
      PEM) or ``AGENT_CARD_SIGNING_KEY_FILE``; no prod private key is in repo.

This script lives next to ``agent.json`` so the deploy/build step can call it
without importing the running service. It re-uses the same signing core
(``tiktok_orchestrator.card_signer``) that the FastAPI app uses at serve time,
so the offline-signed card and the served card are byte-identical.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Make ``tiktok_orchestrator`` importable when invoked as a bare script from the
# repo (without an editable install).
_AGENT_SRC = Path(__file__).resolve().parent.parent / "agent" / "src"
if _AGENT_SRC.is_dir() and str(_AGENT_SRC) not in sys.path:
    sys.path.insert(0, str(_AGENT_SRC))

from tiktok_orchestrator.card_signer import (  # noqa: E402
    build_jwks,
    load_signing_key,
    sign_card,
    verify_card_with_jwks,
)

_DEFAULT_CARD = Path(__file__).resolve().parent / "agent.json"


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def cmd_sign(args: argparse.Namespace) -> int:
    card_path = Path(args.card)
    card = _read_json(card_path)

    key = load_signing_key(kid=args.kid, jku=args.jku)
    signed = sign_card(card, key)

    if args.out:
        out_path = Path(args.out)
    else:
        out_path = card_path  # in-place
    _write_json(out_path, signed)

    jwks = build_jwks([key])
    if args.jwks_out:
        _write_json(Path(args.jwks_out), jwks)

    entry = signed["signatures"][0]
    print(f"[sign] card     -> {out_path}")
    print(f"[sign] kid      = {key.kid}")
    print(f"[sign] jku      = {key.jku}")
    print("[sign] alg      = ES256 (ECDSA P-256 / SHA-256)")
    print(f"[sign] protected= {entry['protected']}")
    print(f"[sign] signature= {entry['signature'][:24]}… ({len(entry['signature'])} chars)")
    if args.jwks_out:
        print(f"[sign] jwks     -> {args.jwks_out}")

    # Self-check: the freshly-signed card must verify against its own JWKS.
    ok = verify_card_with_jwks(signed, jwks)
    print(f"[sign] self-verify = {'OK' if ok else 'FAILED'}")
    return 0 if ok else 1


def cmd_verify(args: argparse.Namespace) -> int:
    card = _read_json(Path(args.card))
    jwks = _read_json(Path(args.jwks))
    ok = verify_card_with_jwks(card, jwks)
    print(f"[verify] {args.card} against {args.jwks}: {'OK' if ok else 'FAILED'}")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--card", default=str(_DEFAULT_CARD), help="path to agent.json")
    parser.add_argument("--verify", action="store_true", help="verify instead of sign")
    parser.add_argument("--jwks", help="JWKS path (for --verify)")
    parser.add_argument("--out", help="output path for the signed card (default: in place)")
    parser.add_argument("--jwks-out", help="write the JWKS document here")
    parser.add_argument("--kid", help="override the signing-key id")
    parser.add_argument("--jku", help="override the published JWKS URL in the protected header")
    args = parser.parse_args(argv)

    if args.verify:
        if not args.jwks:
            parser.error("--verify requires --jwks")
        return cmd_verify(args)
    return cmd_sign(args)


if __name__ == "__main__":
    raise SystemExit(main())
