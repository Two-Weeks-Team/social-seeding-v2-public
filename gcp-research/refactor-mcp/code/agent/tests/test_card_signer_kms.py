# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Social Seeding Inc.
"""Cloud KMS-backed agent-card signer — offline tests (fake KMS client).

Verifies (no network, no GCP) that :class:`KmsCardSigner`:
    * signs a card so the JWS verifies against the JWKS it publishes;
    * sends a SHA-256 digest to ``asymmetricSign`` and converts the returned
      DER ECDSA signature to JOSE R||S correctly (the digest/DER/JOSE seam);
    * signs with the *latest enabled* version and derives a per-version ``kid``;
    * publishes **every enabled** version in the JWKS so a card signed by an
      older (not-yet-destroyed) version still verifies during a rotation
      overlap, while excluding DISABLED versions;
    * is selected by :func:`load_card_signer` when ``AGENT_CARD_SIGNING_KMS_KEY``
      is set.

The fake KMS client is backed by real local ``cryptography`` EC P-256 keys, so
the crypto path exercised is identical to production — only the transport (the
KMS RPC) is stubbed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric import utils as asym_utils
from google.cloud import kms  # declared dep (pyproject) — KMS asymmetricSign path

from tiktok_orchestrator import card_signer
from tiktok_orchestrator.card_signer import (
    KmsCardSigner,
    build_jwks_for_signer,
    generate_dev_key,
    sign_card,
    verify_card_with_jwks,
)

_CRYPTO_KEY = "projects/test/locations/us-central1/keyRings/r/cryptoKeys/agent-card-signing"
_JKU = "https://mcp.socialseed.ing/.well-known/jwks.json"

_ENABLED = kms.CryptoKeyVersion.CryptoKeyVersionState.ENABLED
_DISABLED = kms.CryptoKeyVersion.CryptoKeyVersionState.DISABLED
_EC_P256 = kms.CryptoKeyVersion.CryptoKeyVersionAlgorithm.EC_SIGN_P256_SHA256


# ---------------------------------------------------------------------------
# Fake KMS client (in-memory, real local EC keys)
# ---------------------------------------------------------------------------


@dataclass
class _FakeVersion:
    name: str
    private_key: ec.EllipticCurvePrivateKey
    state: Any = _ENABLED
    algorithm: Any = _EC_P256


class _Resp:
    def __init__(self, **kw: Any) -> None:
        self.__dict__.update(kw)


class _FakeKmsClient:
    """Stand-in for ``KeyManagementServiceClient`` — no network."""

    def __init__(self, crypto_key: str, versions: list[_FakeVersion]) -> None:
        self._crypto_key = crypto_key
        self._versions = {v.name: v for v in versions}

    def list_crypto_key_versions(self, request: dict) -> list[_FakeVersion]:
        assert request["parent"] == self._crypto_key
        return list(self._versions.values())

    def get_public_key(self, request: dict) -> _Resp:
        v = self._versions[request["name"]]
        pem = (
            v.private_key.public_key()
            .public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            .decode("ascii")
        )
        return _Resp(pem=pem)

    def asymmetric_sign(self, request: dict) -> _Resp:
        v = self._versions[request["name"]]
        digest = request["digest"]["sha256"]
        # KMS signs the supplied digest; mirror that with a Prehashed SHA-256.
        der = v.private_key.sign(digest, ec.ECDSA(asym_utils.Prehashed(hashes.SHA256())))
        return _Resp(signature=der)


def _versions(n: int) -> list[_FakeVersion]:
    return [
        _FakeVersion(name=f"{_CRYPTO_KEY}/cryptoKeyVersions/{i}", private_key=generate_dev_key())
        for i in range(1, n + 1)
    ]


def _signer(versions: list[_FakeVersion], signing_version: str | None = None) -> KmsCardSigner:
    return KmsCardSigner(
        crypto_key=_CRYPTO_KEY,
        jku=_JKU,
        signing_version=signing_version,
        client=_FakeKmsClient(_CRYPTO_KEY, versions),
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
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["application/json"],
        "skills": [{"id": "plan_creator_search", "name": "x", "description": "y", "tags": ["t"]}],
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_kms_signer_signs_and_verifies_against_its_jwks(sample_card: dict) -> None:
    signer = _signer(_versions(1))
    assert signer.kid == "ss-agent-card-kms-v1"
    signed = sign_card(sample_card, signer)
    jwks = build_jwks_for_signer(signer)
    assert verify_card_with_jwks(signed, jwks) is True

    # Tamper after signing -> verification fails.
    signed["url"] = "https://evil.example.com"
    assert verify_card_with_jwks(signed, jwks) is False


def test_kms_signer_picks_latest_enabled_version() -> None:
    signer = _signer(_versions(3))
    assert signer.kid == "ss-agent-card-kms-v3"


def test_kms_jwks_publishes_all_enabled_versions_for_rotation(sample_card: dict) -> None:
    versions = _versions(2)
    # Pin signing to the newest version (the rotation target).
    signer = _signer(versions, signing_version=f"{_CRYPTO_KEY}/cryptoKeyVersions/2")
    jwks = build_jwks_for_signer(signer)
    assert sorted(k["kid"] for k in jwks["keys"]) == [
        "ss-agent-card-kms-v1",
        "ss-agent-card-kms-v2",
    ]

    # A card signed by the OLDER v1 still verifies against the multi-version
    # JWKS — this is the rotation-overlap guarantee.
    older = _signer(versions, signing_version=f"{_CRYPTO_KEY}/cryptoKeyVersions/1")
    signed_old = sign_card(sample_card, older)
    assert verify_card_with_jwks(signed_old, jwks) is True


def test_kms_disabled_version_is_excluded(sample_card: dict) -> None:
    versions = _versions(2)
    versions[0].state = _DISABLED  # v1 disabled, v2 enabled
    signer = _signer(versions)
    assert signer.kid == "ss-agent-card-kms-v2"
    jwks = build_jwks_for_signer(signer)
    assert [k["kid"] for k in jwks["keys"]] == ["ss-agent-card-kms-v2"]


def test_kms_no_enabled_version_raises() -> None:
    versions = _versions(1)
    versions[0].state = _DISABLED
    with pytest.raises(RuntimeError, match="no ENABLED"):
        _signer(versions)


def test_load_card_signer_routes_to_kms(monkeypatch: pytest.MonkeyPatch, sample_card: dict) -> None:
    versions = _versions(1)
    monkeypatch.setattr(
        KmsCardSigner,
        "_default_client",
        staticmethod(lambda: _FakeKmsClient(_CRYPTO_KEY, versions)),
    )
    monkeypatch.setenv("AGENT_CARD_SIGNING_KMS_KEY", _CRYPTO_KEY)
    signer = card_signer.load_card_signer()
    assert isinstance(signer, KmsCardSigner)
    signed = sign_card(sample_card, signer)
    assert verify_card_with_jwks(signed, build_jwks_for_signer(signer)) is True


def test_jwks_falls_back_to_signing_version_when_listing_unavailable(sample_card: dict) -> None:
    """If version listing fails (e.g. a list-IAM gap), the JWKS still publishes
    the signing version's key so it is never empty while signing works."""
    versions = _versions(1)
    pinned = f"{_CRYPTO_KEY}/cryptoKeyVersions/1"
    signer = _signer(versions, signing_version=pinned)

    def _boom(request: dict) -> list[_FakeVersion]:
        raise RuntimeError("permission denied: cryptoKeyVersions.list")

    signer._client.list_crypto_key_versions = _boom  # type: ignore[attr-defined]

    jwks = build_jwks_for_signer(signer)
    assert [k["kid"] for k in jwks["keys"]] == ["ss-agent-card-kms-v1"]
    signed = sign_card(sample_card, signer)
    assert verify_card_with_jwks(signed, jwks) is True


def test_kms_jwks_raises_when_signing_version_public_key_unreadable() -> None:
    """If the SIGNING version's public key can't be read, public_jwks must RAISE
    (so the caller serves an honest unsigned card) rather than return a JWKS
    missing the signing kid — which would be a signed-but-unverifiable card."""
    signer = _signer(_versions(1))

    def _boom(request: dict) -> _Resp:
        raise RuntimeError("permission denied: cryptoKeyVersions.viewPublicKey")

    signer._client.get_public_key = _boom  # type: ignore[attr-defined]
    with pytest.raises(RuntimeError, match="viewPublicKey"):
        build_jwks_for_signer(signer)
