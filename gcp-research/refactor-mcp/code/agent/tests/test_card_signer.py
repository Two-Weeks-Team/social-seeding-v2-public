# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""A2A v0.3 AgentCard ``signatures[]`` JWS — offline sign/verify tests.

Verifies (no network, no GCP):
    * the signer produces a verifiable RFC-7515 JWS over the card;
    * sign-then-verify with the public key passes;
    * tampering with the card OR the signature makes verification fail;
    * the protected header carries alg=ES256 + kid + jku (A2A v0.3 shape);
    * the JCS canonicalizer is deterministic + key-order independent;
    * the published JWKS exposes the matching EC/P-256 public key;
    * the real deployment/agent.json signs + verifies end-to-end and stays
      valid, A2A-v0.3-shaped JSON after signing.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tiktok_orchestrator.card_signer import (
    JWS_ALG,
    SigningKey,
    b64url_decode,
    build_jwks,
    generate_dev_key,
    jcs_canonicalize,
    make_signature_entry,
    public_jwk,
    public_key_from_jwk,
    sign_card,
    verify_card_with_jwks,
    verify_signature_entry,
)

_AGENT_JSON = (
    Path(__file__).resolve().parent.parent.parent / "deployment" / "agent.json"
)


@pytest.fixture()
def dev_key() -> SigningKey:
    return SigningKey(
        private_key=generate_dev_key(),
        kid="test-kid-2026",
        jku="https://mcp.socialseed.ing/.well-known/jwks.json",
    )


@pytest.fixture()
def sample_card() -> dict:
    return {
        "protocolVersion": "0.3.0",
        "name": "Influencer Research Agent (TikTok)",
        "description": "test card",
        "url": "https://mcp.socialseed.ing",
        "version": "1.0.0",
        "capabilities": {"streaming": True, "pushNotifications": False},
        "defaultInputModes": ["text/plain", "application/json"],
        "defaultOutputModes": ["application/json"],
        "skills": [{"id": "plan_creator_search", "name": "x", "description": "y", "tags": ["t"]}],
    }


# --- JCS canonicalization ---------------------------------------------------


def test_jcs_is_key_order_independent() -> None:
    a = {"b": 1, "a": 2, "c": {"y": 3, "x": 4}}
    b = {"c": {"x": 4, "y": 3}, "a": 2, "b": 1}
    assert jcs_canonicalize(a) == jcs_canonicalize(b)


def test_jcs_sorts_keys_and_strips_whitespace() -> None:
    out = jcs_canonicalize({"b": 1, "a": [1, 2]}).decode()
    assert out == '{"a":[1,2],"b":1}'


def test_jcs_collapses_integral_floats() -> None:
    # RFC 8785 number rules: 2.0 renders as "2".
    assert jcs_canonicalize({"n": 2.0}).decode() == '{"n":2}'
    assert jcs_canonicalize({"n": 2.5}).decode() == '{"n":2.5}'


# --- protected header shape (alg / kid / jku) -------------------------------


def test_signature_entry_has_a2a_jws_shape(sample_card: dict, dev_key: SigningKey) -> None:
    entry = make_signature_entry(sample_card, dev_key)
    assert set(entry) >= {"protected", "signature"}

    protected = json.loads(b64url_decode(entry["protected"]))
    assert protected["alg"] == JWS_ALG == "ES256"
    assert protected["kid"] == "test-kid-2026"
    assert protected["jku"].endswith("/.well-known/jwks.json")

    # base64url, no padding (RFC 7515).
    assert "=" not in entry["protected"] and "=" not in entry["signature"]
    # ES256 raw signature is 64 bytes (R||S over P-256).
    assert len(b64url_decode(entry["signature"])) == 64


# --- sign then verify -------------------------------------------------------


def test_sign_then_verify_passes(sample_card: dict, dev_key: SigningKey) -> None:
    entry = make_signature_entry(sample_card, dev_key)
    assert verify_signature_entry(sample_card, entry, dev_key.public_key) is True


def test_verify_fails_with_wrong_key(sample_card: dict, dev_key: SigningKey) -> None:
    entry = make_signature_entry(sample_card, dev_key)
    other = generate_dev_key().public_key()
    assert verify_signature_entry(sample_card, entry, other) is False


# --- tamper detection -------------------------------------------------------


def test_tampered_card_fails_verification(sample_card: dict, dev_key: SigningKey) -> None:
    entry = make_signature_entry(sample_card, dev_key)
    tampered = dict(sample_card)
    tampered["url"] = "https://evil.example.com"  # flip one field
    assert verify_signature_entry(tampered, entry, dev_key.public_key) is False


def test_tampered_signature_fails_verification(sample_card: dict, dev_key: SigningKey) -> None:
    entry = make_signature_entry(sample_card, dev_key)
    raw = bytearray(b64url_decode(entry["signature"]))
    raw[0] ^= 0xFF  # flip a byte in the signature
    from tiktok_orchestrator.card_signer import b64url_encode

    forged = {"protected": entry["protected"], "signature": b64url_encode(bytes(raw))}
    assert verify_signature_entry(sample_card, forged, dev_key.public_key) is False


# --- full card sign + JWKS round-trip ---------------------------------------


def test_sign_card_appends_signatures_and_stays_json(
    sample_card: dict, dev_key: SigningKey
) -> None:
    signed = sign_card(sample_card, dev_key)
    assert isinstance(signed["signatures"], list) and len(signed["signatures"]) == 1
    # Still serializable + still has the original required fields.
    re_parsed = json.loads(json.dumps(signed))
    assert re_parsed["name"] == sample_card["name"]
    assert re_parsed["protocolVersion"] == "0.3.0"


def test_jwks_exposes_matching_public_key(dev_key: SigningKey) -> None:
    jwks = build_jwks([dev_key])
    assert len(jwks["keys"]) == 1
    jwk = jwks["keys"][0]
    assert jwk["kty"] == "EC" and jwk["crv"] == "P-256"
    assert jwk["kid"] == dev_key.kid and jwk["alg"] == "ES256" and jwk["use"] == "sig"

    # The JWK reconstructs to the same public key (verifies a real signature).
    reconstructed = public_key_from_jwk(jwk)
    assert public_jwk(reconstructed, dev_key.kid) == public_jwk(dev_key.public_key, dev_key.kid)


def test_verify_card_with_jwks_round_trip(sample_card: dict, dev_key: SigningKey) -> None:
    signed = sign_card(sample_card, dev_key)
    jwks = build_jwks([dev_key])
    assert verify_card_with_jwks(signed, jwks) is True

    # Tamper after signing -> JWKS verification fails.
    signed["description"] = "mutated"
    assert verify_card_with_jwks(signed, jwks) is False


def test_unsigned_card_does_not_verify(sample_card: dict, dev_key: SigningKey) -> None:
    assert verify_card_with_jwks(sample_card, build_jwks([dev_key])) is False


# --- the real deployment/agent.json -----------------------------------------


def test_real_agent_json_signs_and_verifies(dev_key: SigningKey) -> None:
    card = json.loads(_AGENT_JSON.read_text(encoding="utf-8"))
    # A2A v0.3 shape sanity before signing.
    assert card["protocolVersion"] == "0.3.0"
    for field in ("name", "description", "url", "version", "capabilities", "skills"):
        assert field in card

    signed = sign_card(card, dev_key)
    jwks = build_jwks([dev_key])
    assert verify_card_with_jwks(signed, jwks) is True

    # Signing must not drop any pre-existing field, and must add signatures[].
    assert set(card) - {"signatures"} <= set(signed)
    assert signed["signatures"][0]["protected"]
