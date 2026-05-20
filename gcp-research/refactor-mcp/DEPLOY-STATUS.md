<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Social Seeding Inc. -->

# DEPLOY-STATUS.md — Track 3 Cloud Run live deploy

> Live deployment record for the **tiktok-orchestrator** A2A v0.3 agent
> (Track 3 / Refactor submission core node). Written by the I1 deploy task.
> Date stamp: **2026-05-20**.

## Summary

| Field | Value |
|---|---|
| Status | **DONE** — service live, A2A card served, skill loop verified end-to-end |
| GCP project | `ss-mcp-prod` (project number `1049119860518`, billing `01B677-A6E5C9-B265AF`) |
| Service name | `ss-mcp-server` |
| Region | `us-central1` |
| Service URL | https://ss-mcp-server-1049119860518.us-central1.run.app |
| Alt URL (same service) | https://ss-mcp-server-s2le2ic2eq-uc.a.run.app |
| Active revision | `ss-mcp-server-00003-22m` |
| Deploy method | `gcloud run deploy --source=.` (Cloud Build builds the single-container `./Dockerfile`) |
| Build retries | 1 (build #1 failed; #2 fixed; #3 + #4 redeploys for app/card changes — see below) |
| Run mode | **Stub mode** — Python ADK orchestrator only; no Node MCP sidecar, no Vertex, no Identity Platform, no live Model Armor (those gated on operator decisions O-A..O-E, PHASE-5-STATUS §3) |

## Deploy method & why (not the multi-container path)

The full topology in `deployment/cloud-run-service.yaml` is **multi-container**
(Python ADK ingress + Node MCP sidecar) and requires CMEK, Secret Manager, a
dedicated runner service account, and Identity Platform — all blocked on
operator decisions O-A..O-E. The Node sidecar image (`runtime-node`) also
needs the **platform repo** as build context (it COPYs `package*.json`,
`tsconfig.json`, `src/` that live in
`social-seeding-platform/microservices/tiktok-mcp-server/`, not in this
`code/` tree).

For the Track 3 demo, the **Python ADK orchestrator is the A2A ingress** and
runs standalone in stub mode (heuristic ranker; `agent.py` auto-sets
`ADK_DISABLED` when `GOOGLE_CLOUD_PROJECT` is empty). So this deploy is a
**single-container** build of just that orchestrator via a purpose-built
`code/Dockerfile`. The multi-container Dockerfile + service YAML are untouched
and remain the future full-topology path.

## Verification (revision 00003)

| Endpoint | Result |
|---|---|
| `GET /` | **200** `{"status":"ok","service":"tiktok-orchestrator","version":"1.0.0"}` — reachable liveness |
| `GET /livez` | **200** (health alias) |
| `GET /readyz` | **200** `{"status":"no-mcp"}` — correct for stub mode (no MCP sidecar) |
| `GET /healthz` | **404 (Google edge)** — Cloud Run's HTTP frontend reserves/intercepts the literal `/healthz` path before it reaches the container (proven: `/healthz/` reaches the container and 307-redirects; bare `/healthz` never appears in container logs). Worked around by aliasing health onto `/` and `/livez`. Behind a custom domain / proxy that does not reserve `/healthz` (the planned `mcp.socialseed.ing`) the original path works. |
| `GET /.well-known/agent.json` | **200** — canonical A2A v0.3 card (NOT the fallback stub), all required fields present, `protocolVersion=0.3.0`, `skills[0].id=plan_creator_search`, 4 `mcp_tools`, live Cloud Run interface listed in `additionalInterfaces` |
| `GET /.well-known/agent-card.json` | **200** (alias) |
| `POST /v1/message:send` | **200** — A2A v0.3 `task` envelope, `status.state=completed`, 5 ranked creators (stub heuristic), `source_attribution` present |

One-line verification command:

```bash
URL=https://ss-mcp-server-1049119860518.us-central1.run.app; \
curl -s -o /dev/null -w "/ %{http_code}\n" "$URL/"; \
curl -s "$URL/.well-known/agent.json" | python3 -c "import sys,json;d=json.load(sys.stdin);print('agent.json',d['protocolVersion'],d['skills'][0]['id'])"
# → / 200
# → agent.json 0.3.0 plan_creator_search
```

## Two source bugs fixed to make the deploy work

1. **agent.json path mismatch.** `main.py` computes
   `AGENT_JSON_PATH = <main.py>/../../../../deployment/agent.json`, which from
   `/app/src/tiktok_orchestrator/main.py` resolves to **`/deployment/agent.json`**.
   The multi-container Dockerfile copies the card to `/app/deployment/agent.json`,
   so the well-known endpoint would silently serve the **fallback stub card**.
   The new `code/Dockerfile` copies the card to `/deployment/agent.json` to match.
2. **Port binding.** The multi-container Dockerfile hardcodes `uvicorn --port 8200`;
   Cloud Run injects `$PORT` (8080). The new Dockerfile uses the package's own
   entrypoint (`python -m tiktok_orchestrator.main`, which honors `$PORT`/`$HOST`)
   and sets `PORT=8080`.
3. **(build #1 failure) hatchling readme.** `pyproject.toml` declares
   `readme = "README.md"`; the builder stage did not copy `agent/README.md`,
   so the editable wheel build failed. Fixed by copying it into the build stage
   and root-anchoring the `.gcloudignore` README exclusion so `agent/README.md`
   stays in the upload context.

## Autoscaling & cost (D46 — scale-to-zero)

| Knob | Value |
|---|---|
| `minScale` | **0** (scale-to-zero; idle cost ≈ **$0/mo**) |
| `maxScale` | 10 |
| CPU / memory | 1 vCPU / 512 MiB |
| containerConcurrency | 80 |
| Ingress | all; `allUsers` invoker (unauthenticated, demo) |

**Cost estimate (us-central1, on-demand, May 2026 rates):**

- **Idle: ~$0/mo** — at `minScale=0` there are no always-on instances; you pay
  only while a request is being served.
- **Per request (cold-ish):** a `plan_creator_search` stub call holds 1 vCPU +
  512 MiB for ~the request duration. At ~$0.000024/vCPU-s and ~$0.0000025/GiB-s,
  a ~0.3 s request ≈ **<$0.00001** in compute, plus the first 2M req/mo free.
- **Demo / light traffic (e.g. 1,000 invocations/mo, ~0.3 s each):** well inside
  the free tier (180k vCPU-s, 360k GiB-s, 2M requests) → effectively **$0/mo**.
- Build cost is one-time Cloud Build minutes (E2 default), negligible.

> No risk of the >$20 stop-gate: scale-to-zero + free tier keep this near $0
> for demo/submission traffic.

## Safety attestation

- New project `ss-mcp-prod` only. **Production social-seeding-backend (port 8080)
  and `ss-landing` (ss-shared-infra) were NOT touched.**
- No `.env` files read or modified. Stub-mode env is baked into the Dockerfile
  (no secrets).
- The multi-container deploy YAML, Dockerfile.multi-container, and cloudbuild.yaml
  are unchanged — the future full-topology path is preserved.

## Files changed by this task

- `code/Dockerfile` — **new** single-container build target (ADK orchestrator, stub mode, `$PORT`, fixed agent.json path).
- `code/.gcloudignore` — **new** lean build context (root-anchored exclusions).
- `code/agent/src/tiktok_orchestrator/main.py` — added `/` + `/livez` health aliases (Cloud Run reserves `/healthz`).
- `code/deployment/agent.json` — added the live Cloud Run URL to `additionalInterfaces` (canonical `url` left as the production custom domain).

## Pickup / next steps

- DNS cutover `mcp.socialseed.ing` → this service restores the literal `/healthz`
  path (gated on O-C Watchtower pause).
- Full multi-container deploy (Node MCP sidecar + Vertex + Identity Platform +
  CMEK + Secret Manager) is the follow-up once O-A..O-E are resolved; use
  `deployment/cloudbuild.yaml` + `deployment/cloud-run-service.yaml` then.
