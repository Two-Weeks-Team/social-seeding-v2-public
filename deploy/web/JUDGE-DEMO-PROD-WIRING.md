# Judge Demo — prod env contract & operations

## Status: LIVE and verified ✅ (2026-06-11)

The read-only judge demo is **wired and working on prod** (`https://agents.socialseed.ing`).
Verified end-to-end this date:

- `GET /sign-in` → 200, renders the **"Enter as judge — read-only demo"** button (so
  `JUDGE_DEMO_ENABLED=true` in prod), dev test-login block correctly hidden.
- Clicking it → `POST /sign-in` **303** → sets `ss_session` cookie → **`GET /campaigns` 200**,
  lands on the populated `ws_wooriliu_2nd` Mission Control (Live Demo — Glow Serum *running, 1
  pending approval* + Wooliliwoo — K-beauty for Mexico *complete, +34 creators*).
- `GET /api/auth/judge-demo` (no token) → **401** (enabled + token-gated, not 404/500).

> Earlier `DEPLOY-STATUS-web.md` ("authenticated routes … not done") was an I2-phase snapshot;
> the operator has since wired `AUTH_SECRET` / `MONGODB_URI` / `JUDGE_DEMO_*` onto the live
> `ss-v2-web` revision. A `demoError=500 "misconfigured"` only reproduces **locally** when
> `JUDGE_DEMO_TOKEN` is unset.

This file is the **env contract + operational commands** (post-judging kill-switch, re-apply on
a fresh deploy). The same vars are declared in `deploy/web/service.yaml` for the canonical
CMEK/VPC `gcloud run services replace` pipeline.

## Env contract (apps/web)

| Env | Purpose | Kind |
|---|---|---|
| `JUDGE_DEMO_ENABLED=true` | surfaces the "Enter as judge" button + `/api/auth/judge-demo` magic link | plain |
| `JUDGE_DEMO_TOKEN` | HMAC usage-bucket key + magic-link secret (unset → **500**) | **secret** |
| `JUDGE_DEMO_WORKSPACE_ID=ws_wooriliu_2nd` | workspace the minted read-only session lands in | plain |
| `JUDGE_DEMO_EXPIRES_AT` *(optional)* | ISO-8601 time-box (past → 410) | plain |
| `MONGODB_URI` | Atlas connection string (usage counter + `/campaigns` data) | **secret** |
| `MONGODB_DB=instarsearch` | DB name — the URI path is ignored, this wins (`@ss/db`) | plain |
| `AUTH_SECRET` | session JWT signing (≥32 chars) | **secret** |

> The minted session is `demo:true` → every state-mutating route refuses it (`denyIfDemo`); it
> is a read-only tour. The magic-link token goes in Devpost **"Testing access"**, never the
> public video description.

## Post-judging kill-switch

```bash
gcloud run services update ss-v2-web --project=ss-v2-prod --region=us-central1 \
  --update-env-vars="JUDGE_DEMO_ENABLED=false" --quiet   # button + magic link go dark
```

## Re-apply on a fresh service (reference — already applied to the live revision)

```bash
PROJECT=ss-v2-prod
# secrets (one-time) — real values held by the operator; Claude does not touch secrets
printf '%s' "$(openssl rand -hex 24)" | gcloud secrets create web-judge-demo-token --project=$PROJECT --data-file=-
# … web-auth-secret, web-mongodb-uri likewise …
SA=$(gcloud run services describe ss-v2-web --project=$PROJECT --region=us-central1 --format='value(spec.template.spec.serviceAccountName)')
for S in web-auth-secret web-judge-demo-token web-mongodb-uri; do
  gcloud secrets add-iam-policy-binding "$S" --project=$PROJECT \
    --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor" --quiet
done
gcloud run services update ss-v2-web --project=$PROJECT --region=us-central1 \
  --set-secrets="AUTH_SECRET=web-auth-secret:latest,JUDGE_DEMO_TOKEN=web-judge-demo-token:latest,MONGODB_URI=web-mongodb-uri:latest" \
  --update-env-vars="MONGODB_DB=instarsearch,JUDGE_DEMO_ENABLED=true,JUDGE_DEMO_WORKSPACE_ID=ws_wooriliu_2nd" --quiet
```

## Verify

```bash
URL=https://agents.socialseed.ing
curl -s -o /dev/null -w '%{http_code}\n' "$URL/sign-in"                # 200, button renders
curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/auth/judge-demo"    # 401 (enabled, token-gated)
# Browser: click "Enter as judge" → /campaigns (populated MC), no demoError.
```
