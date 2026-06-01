# Agent-card signing key — Cloud KMS + rotation

The A2A v0.3 agent card's `signatures[]` JWS (ES256) is signed with a **Cloud
KMS asymmetric key** whose private half never leaves KMS. This replaces the
earlier Secret-Manager PEM key (`agent-card-signing-key`).

## Resources

| Thing | Value |
|---|---|
| Key | `projects/ss-mcp-prod/locations/us-central1/keyRings/socialseed-mcp/cryptoKeys/agent-card-signing` |
| Purpose / algorithm | `ASYMMETRIC_SIGN` / `EC_SIGN_P256_SHA256` |
| Runtime SA roles (on the key) | `roles/cloudkms.signerVerifier` (sign + viewPublicKey) + `roles/cloudkms.viewer` (list versions) on `tiktok-mcp-runner@ss-mcp-prod.iam.gserviceaccount.com` |
| Code | `agent/src/tiktok_orchestrator/card_signer.py` → `KmsCardSigner` / `load_card_signer` |
| Service env | `AGENT_CARD_SIGNING_KMS_KEY` (key resource) + `AGENT_CARD_SIGNING_KID` (kid prefix, default `ss-agent-card-prod`) |

`kid` = `<prefix>-v<versionNumber>` (e.g. `ss-agent-card-prod-v1`), so every JWKS
entry maps 1:1 to a KMS key version.

## How it works at runtime

- **Sign**: the agent SHA-256-digests the JWS Signing Input and calls
  `cryptoKeyVersions.asymmetricSign` on the **latest ENABLED version**
  (no pinned version), then converts the DER ECDSA signature to JOSE R||S.
- **JWKS**: `/.well-known/jwks.json` publishes the public key of **every
  ENABLED version** (`getPublicKey`). Publishing all enabled versions is what
  makes a rotation overlap safe — a card signed by an older, not-yet-disabled
  version still verifies while clients refresh.

## Rotation (manual — KMS does NOT auto-rotate asymmetric keys)

Cloud KMS only auto-rotates *symmetric* keys; an asymmetric public key has to be
**distributed before** the new version can be used to sign, so `rotationPeriod`
does not apply.

⚠️ **Publish-before-sign.** The JWKS is served with `Cache-Control: max-age=300`.
If you create a version AND immediately sign with it (the naive one-step), a
client holding a 300 s-stale JWKS won't yet have the new `kid`, so cards signed
by the new version fail verification until its cache expires. So rotate in two
deploys, using the `AGENT_CARD_SIGNING_KMS_KEY_VERSION` pin to hold signing on
the *old* version while the new key's JWK propagates:

```bash
KEY=agent-card-signing; KR=socialseed-mcp; LOC=us-central1; PROJ=ss-mcp-prod
OLD=1   # current signing version

# 1. Create the new version (ENABLED immediately; not yet used to sign).
gcloud kms keys versions create --key "$KEY" --keyring "$KR" \
  --location "$LOC" --project "$PROJ"          # -> version 2

# 2. Deploy A — PUBLISH the new key but keep SIGNING with the old version:
#    pin AGENT_CARD_SIGNING_KMS_KEY_VERSION to .../cryptoKeyVersions/$OLD.
#    The JWKS now lists BOTH -v1 and -v2; cards are still signed by -v1
#    (already in every client's cache). Canary + cut, then WAIT > 300 s so all
#    clients have refreshed the JWKS and hold the new -v2 key.

# 3. Deploy B — SWITCH signing to the new version: clear the pin (latest ENABLED
#    = v2) or pin to .../cryptoKeyVersions/2. Cards are now signed by -v2, which
#    every client already has. Canary + cut.

# 4. After downstream caches of the OLD-signed cards expire, retire the old:
gcloud kms keys versions disable "$OLD" --key "$KEY" --keyring "$KR" \
  --location "$LOC" --project "$PROJ"
#    The JWKS drops the disabled version on the next deploy.
```

Day-1 (single version) uses **no pin** — `load_card_signer` signs with the
latest ENABLED version and the JWKS publishes it. The pin is only needed to
sequence a rotation safely (step 2 above).

## Canary deploy (build → no-traffic → verify → cut)

```bash
cd gcp-research/refactor-mcp/code
OUT=/tmp/ss-mcp-ctx; deployment/assemble-build-context.sh "$OUT"
TAG=kms-$(date +%Y%m%d-%H%M%S)
gcloud builds submit "$OUT" --config "$OUT/deployment/cloudbuild.build-only.yaml" \
  --project ss-mcp-prod --substitutions=_LOCATION=us-central1,_REPO=socialseed-mcp,_TAG=$TAG

# render yaml (substitute tokens + image tag), pin 100% traffic to the CURRENT
# revision, expose the new one as a 0%-traffic tagged canary, then:
gcloud run services replace <rendered.yaml> --region=us-central1 --project=ss-mcp-prod --quiet

# verify the canary against its tagged URL (same 7-check script):
MCP_URL="https://kmscanary---ss-mcp-server-s2le2ic2eq-uc.a.run.app" \
  bash ../../../scripts/demo/submission/verify-live-evidence.sh   # expect signed card kid=…-v1

# cut traffic only after the canary is green:
gcloud run services replace <rendered-100pct.yaml> --region=us-central1 --project=ss-mcp-prod --quiet
```

Rollback: `gcloud run services update-traffic ss-mcp-server --region=us-central1
--project=ss-mcp-prod --to-revisions=ss-mcp-server-00010-j26=100` (the last
PEM-signed revision).
