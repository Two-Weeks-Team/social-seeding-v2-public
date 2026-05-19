# Google Cloud DevOps, Integration, and Edge — 2026 Reference for AI Agent Workloads

> Scope: services an agent platform (ADK, Genkit, Vertex AI Agent Engine, or a Claude-Agent-SDK-on-Cloud-Run stack like ours) will actually touch — from `git push` to "agent serving a customer at the edge". Citations: cloud.google.com only.
> Audience: ours, building `social-seeding-v2` with Inngest + Claude Agent SDK + Next 16 Mission Control, considering future GCP migration paths.
> Last verified: 2026-05-19.

---

## Section A — CI/CD

### A.1 Cloud Build

**1. What it is (2026).** Cloud Build is Google Cloud's fully managed CI service that runs builds as a series of build steps (each step is a container) defined in `cloudbuild.yaml`. Builds can run on the default shared pool or on **private pools** — VPC-attached, dedicated, fully managed worker fleets that scale to zero, with per-second pay-as-you-go pricing, native Cloud Run / GKE / Cloud Functions / Firebase integration, Secret Manager + Pub/Sub hooks, and IAM-controlled triggers.

**2. Agent-pipeline relevance.** For an agent service (LLM-calling Cloud Run service, ADK agent container, or Genkit Node app), Cloud Build is the canonical "git → tested image → Artifact Registry" leg of the pipeline. Private pools matter when your agent must call **internal-only** databases (Mongo Atlas Private Endpoint, internal Vertex AI peering, on-prem vector stores) during integration tests — the shared pool's egress IPs are not VPC-routable.

**3. Latest features 2026.**
- **C3 and N2D machine families** are now GA in private pools (more vCPU / better price-perf for parallel test fan-out, e.g. agent eval suites).
- **`peeredNetworkIpRange`** lets you specify a starting IP and a block as small as **/29** for the peered range — solves the "private pools eat too many private IPs" pain.
- Tight Cloud Run / GKE / Firebase / Cloud Functions deploy targets remain first-class.

**4. Minimum working config.** `cloudbuild.yaml` that builds an agent service with Cloud Native Buildpacks (no Dockerfile needed):

```yaml
# cloudbuild.yaml — builds an agent service, pushes to Artifact Registry
options:
  logging: CLOUD_LOGGING_ONLY
  pool:
    name: projects/$PROJECT_ID/locations/us-central1/workerPools/agent-private-pool
steps:
  - name: gcr.io/k8s-skaffold/pack
    entrypoint: pack
    args:
      - build
      - us-central1-docker.pkg.dev/$PROJECT_ID/agents/orchestrator:$SHORT_SHA
      - --builder=gcr.io/buildpacks/builder:latest
      - --publish
images:
  - us-central1-docker.pkg.dev/$PROJECT_ID/agents/orchestrator:$SHORT_SHA
```

Trigger it from a GitHub push:

```bash
gcloud builds triggers create github \
  --name=agent-main \
  --repo-name=social-seeding-v2 --repo-owner=ComBba \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml
```

**5. Best practices.**
- Use **buildpacks** for first-party agent code (no Dockerfile drift); switch to a Dockerfile only when you need non-default system packages (e.g. Chromium for browser tools).
- Put **eval / golden-set** tests in a dedicated step before the `images:` push — fail the build if agent regression > N%.
- Keep the build USD-capped by using **N1/N2** machines for normal builds and only upgrading to C3 for parallel eval fan-out.
- Use **private pools** the moment your build touches a private network (Mongo Atlas Private Endpoint, internal Vertex peering).
- Pin builder digests (`gcr.io/buildpacks/builder@sha256:...`), don't trust `:latest` for supply-chain reasons — pair with SLSA attestation (see Artifact Registry below).
- Persist build logs to **Cloud Logging only** (`logging: CLOUD_LOGGING_ONLY`) when the default GCS bucket is not configured — avoids "bucket required" errors.
- Inject secrets via **Secret Manager** (`availableSecrets:`) not env vars in YAML.
- Treat `cloudbuild.yaml` as code: PR-review it, run `gcloud builds submit --no-source` for offline lint.

**6. Docs.** https://docs.cloud.google.com/build/docs/private-pools/private-pools-overview · https://docs.cloud.google.com/build/docs/private-pools/create-manage-private-pools · https://docs.cloud.google.com/build/docs/release-notes · https://docs.cloud.google.com/docs/buildpacks/build-application · https://docs.cloud.google.com/build/docs/build-config-file-schema

---

### A.2 Cloud Deploy

**1. What it is (2026).** Cloud Deploy is the managed continuous-delivery service that promotes a single immutable **Release** through ordered **Targets** (e.g. `dev → staging → prod`) with built-in approvals, verification, rollback, and audit trails. Native target types: **Cloud Run**, **GKE**, **GKE Enterprise / multi-cluster**, and **custom targets** (anything you can script).

**2. Agent-pipeline relevance.** Cloud Build only gets you an image; Cloud Deploy is where you encode "20% of traffic to new agent prompt version, watch p95 + tool-error rate for 30 min, then 50%, then 100%". For an LLM service this is where a bad prompt regression gets caught before it hits all users.

**3. Latest features 2026.**
- **Canary strategy** is GA across **GKE, Cloud Run, and GKE Enterprise**, including service-based networking on GKE.
- **Parallel deployment** is GA — fan out a single release to N targets concurrently (e.g. `agent-us`, `agent-eu`, `agent-asia` regional Cloud Run services).
- **Preview**: scheduled auto-promotion across targets at fixed times, automatic retry of failed rollouts with rollback, and **deploy policies** that block rollouts during specified windows (freeze weekends, freeze pre-launch).
- **Security insights** view aggregates SLSA level + vulnerability + VEX status of the image being deployed.

**4. Minimum working config.** Pipeline with canary to a single Cloud Run target:

```yaml
# clouddeploy.yaml
apiVersion: deploy.cloud.google.com/v1
kind: DeliveryPipeline
metadata:
  name: agent-pipeline
serialPipeline:
  stages:
    - targetId: prod-run
      strategy:
        canary:
          runtimeConfig:
            cloudRun:
              automaticTrafficControl: true
          canaryDeployment:
            percentages: [10, 50]
            verify: true
---
apiVersion: deploy.cloud.google.com/v1
kind: Target
metadata:
  name: prod-run
run:
  location: projects/$PROJECT_ID/locations/us-central1
```

Register and ship:

```bash
gcloud deploy apply --file=clouddeploy.yaml --region=us-central1
gcloud deploy releases create rel-$(date +%s) \
  --delivery-pipeline=agent-pipeline --region=us-central1 \
  --images=agent=us-central1-docker.pkg.dev/$PROJECT_ID/agents/orchestrator:$SHORT_SHA
```

**5. Best practices.**
- **Always verify** (`verify: true`) — wire a Cloud Build job that hits `/healthz` + a synthetic agent call, fail the phase if tool-error rate > N%.
- Use **parallel deployment** for multi-region; never sequential per-region for an agent that is geo-shared.
- Bind **deploy policies** to weekends / launch freezes so an absent on-call can't trigger a rollout.
- Force **automatic traffic control** on Cloud Run targets — let Cloud Deploy own traffic splits, don't drift them with `gcloud run deploy`.
- Keep "skaffold.yaml" thin; do the heavy lifting in the verification Cloud Build job.
- One pipeline per agent service; do **not** share pipelines across agent + frontend (different blast radii).
- Promote via **`gcloud deploy releases promote`**, never re-tag the image — releases are meant to be immutable.

**6. Docs.** https://docs.cloud.google.com/deploy/docs/deployment-strategies/canary · https://docs.cloud.google.com/deploy/docs/deployment-strategies/canary/cloud-run · https://docs.cloud.google.com/deploy/docs/release-notes · https://docs.cloud.google.com/deploy/docs/securing/security-insights · https://docs.cloud.google.com/deploy/docs/create-pipeline-targets

---

### A.3 Artifact Registry

**1. What it is (2026).** The successor to Container Registry, a single managed service for **Docker / OCI**, **Maven**, **npm**, **Python (PyPI)**, **Go modules**, **apt** and **yum** packages — plus **remote repositories** (pull-through cache of Docker Hub / PyPI / Maven Central) and **virtual repositories** (one URL fronting multiple backing repos). Integrates with **Artifact Analysis** for CVE scanning, **Binary Authorization** for deploy-time policy, and **SLSA** provenance attached by Cloud Build.

**2. Agent-pipeline relevance.** Every agent container image, every Python LangChain wheel pulled by your worker, every Genkit / ADK npm dep — they all flow through Artifact Registry. The **remote repo** feature is the right way to insulate yourself from npm-registry / PyPI outages (which take agents down by extension).

**3. Latest features 2026.**
- **Artifact Analysis** scans OS packages and language packages (Python, Node.js, Java/Maven, Go) on push and continuously thereafter; results visible alongside **SLSA level, VEX, and SBOM** in the Artifact Registry UI.
- **`aactl`** is the supported tool for importing SLSA Build Provenance generated by SLSA GitHub Generator, plus third-party scanner results (Trivy, Grype, Snyk).
- **SLSA attestation** from Cloud Build is attached automatically; **Binary Authorization** can require it at deploy time.

**4. Minimum working config.** Create a Docker repo and push:

```bash
gcloud services enable artifactregistry.googleapis.com
gcloud artifacts repositories create agents \
  --repository-format=docker \
  --location=us-central1 \
  --description="Agent service images"

gcloud auth configure-docker us-central1-docker.pkg.dev
docker push us-central1-docker.pkg.dev/$PROJECT_ID/agents/orchestrator:v1
```

For npm / Python (most common for an agent stack):

```bash
gcloud artifacts repositories create agent-py \
  --repository-format=python --location=us-central1
gcloud artifacts repositories create agent-npm \
  --repository-format=npm    --location=us-central1
```

**5. Best practices.**
- One repo per **package format**, one per **environment band** (`agents-prod`, `agents-dev`); IAM-isolate prod from dev.
- Use **remote repositories** as the only registry your build pulls from — pin upstream outages out of the critical path.
- Turn on **Artifact Analysis** (it's pay-per-image, but cheap relative to a CVE shipping to prod).
- Require **SLSA Level 3** attestation at the Binary Authorization gate for any Cloud Run / GKE prod target.
- Use **cleanup policies** (`--cleanup-policy`) to auto-prune untagged images after N days — agents accumulate hundreds per week.
- Co-locate the repo region with the Cloud Run region — cross-region image pulls add cold-start latency.
- Avoid `:latest` tags for deployable artifacts; tag with the build commit SHA.
- Use **virtual repositories** when you mix a private internal package with a remote pull-through — single URL for `pip install`.

**6. Docs.** https://docs.cloud.google.com/artifact-registry/docs/analysis · https://docs.cloud.google.com/artifact-registry/docs/docker/store-docker-container-images · https://docs.cloud.google.com/artifact-registry/docs/repositories/create-repos · https://docs.cloud.google.com/artifact-registry/docs/repositories/remote-repo · https://cloud.google.com/artifact-analysis/pricing

---

### A.4 Cloud Source Repositories — STATUS

**Confirmed: End-of-Sale, deprecation in progress.** Cloud Source Repositories went end-of-sale on **June 17, 2024**. Net effect:
- If your org never enabled the API before that date, you **cannot** start using it.
- Existing users keep working until a yet-to-be-announced shutdown date (Google commits to ≥ 12 months' notice).
- Migration targets: **Secure Source Manager** (Google's managed Git) or **GitHub / GitLab / Bitbucket** with Cloud Build's first-class connectors.

**Recommendation for 2026 new builds:** do not adopt Cloud Source Repositories. Use GitHub (most common) or **Secure Source Manager** if you specifically need a Google-hosted, IAM-integrated, VPC-attachable Git server.

**Docs.** https://docs.cloud.google.com/source-repositories/docs/release-notes · https://docs.cloud.google.com/source-repositories/docs/migration-guides · https://docs.cloud.google.com/secure-source-manager/docs/release-notes

---

### A.5 Cloud Workstations

**1. What it is (2026).** Fully managed, container-backed dev VMs that developers connect to via **browser-based Code OSS**, **VS Code (local)**, **JetBrains Gateway** (IntelliJ / PyCharm / Rider / CLion), **Posit Workbench** (R), or SSH. Configurations are templates (machine type, disk, container image, IDE, env vars) — workstations are instances of a config.

**2. Agent-pipeline relevance.** Three big wins for agent teams:
- **No-source-on-laptop policy**: agents often touch sensitive Mongo data, customer PII, or live OAuth tokens; Workstations keep that on Google's VMs inside your VPC.
- **GPU-backed workstations** for local LLM / embedding experiments without buying hardware.
- **Pre-baked container images** mean "new hire is productive in 15 minutes" instead of "fight with `pyenv`, `nvm`, and `gcloud auth` for a day".

**3. Latest features 2026.** Continued: in-VPC deployment, predefined IDE images (Code OSS, JetBrains, Posit), session limits with auto-image-refresh, persistent home disk separable from VM, idle-timeout auto-stop, exfiltration controls (no local code storage).

**4. Minimum working config.**

```bash
gcloud workstations clusters create dev-cluster \
  --region=us-central1 --network=projects/$PROJECT_ID/global/networks/default \
  --subnetwork=projects/$PROJECT_ID/regions/us-central1/subnetworks/default

gcloud workstations configs create agent-dev \
  --cluster=dev-cluster --region=us-central1 \
  --machine-type=e2-standard-8 \
  --boot-disk-size=100 --pd-disk-type=pd-balanced --pd-disk-size=200 \
  --idle-timeout=3600s --running-timeout=36000s \
  --container-predefined-image=codeoss

gcloud workstations create alice \
  --config=agent-dev --cluster=dev-cluster --region=us-central1
```

**5. Best practices.**
- One **config per persona** (frontend vs agent-backend vs data-eng) — different machine types, different containers, different network egress.
- Run inside your **VPC** so workstations can hit private Mongo / Vertex endpoints; **disable public IPs**.
- Set **idle timeout to 1 h, running timeout to 10 h** to control cost.
- Build a **custom container image** layering on `codeoss` with your team's pinned `gcloud`, `pnpm`, `go`, `tsx`, `inngest-cli`, plus `claude-code` if you allow it.
- Pre-grant **service-account impersonation** so developers don't need long-lived JSON keys.
- For agent eval, give the workstation `roles/aiplatform.user` so it can call Vertex AI / Gemini directly.
- Audit: turn on **Cloud Audit Logs** for `workstations.googleapis.com` — track who SSH'd in and when.

**6. Docs.** https://docs.cloud.google.com/workstations/docs/overview · https://docs.cloud.google.com/workstations/docs/architecture · https://cloud.google.com/workstations · https://docs.cloud.google.com/sdk/gcloud/reference/workstations/configs/create · https://docs.cloud.google.com/workstations/docs/create-configuration

---

### A.6 Gemini Code Assist for Cloud Build / Deploy / Workstations

**1. What it is (2026).** Gemini Code Assist comes in three editions — Individual (free), **Standard**, **Enterprise** — inside the Gemini-for-Google-Cloud portfolio. Beyond IDE completions, Standard/Enterprise integrate with Google Cloud surfaces: it can read your **Cloud Build** logs to explain failures, draft `cloudbuild.yaml` / `clouddeploy.yaml`, generate **Application Integration** flows, and run inside **Cloud Workstations** with workspace-level secrets / IAM context.

**2. Agent-pipeline relevance.** Two practical wins:
- **"Why did this build fail?"** — paste the Cloud Build log line, get a diagnosis grounded in your `cloudbuild.yaml`.
- **Generate a delivery-pipeline YAML** from a natural-language prompt and review-diff it. Faster than reading the schema doc the first 3 times.

**3. Latest features 2026.** Gemini Code Assist Enterprise integrates "with additional Google Cloud services for building applications across a broader tech stack"; Application Integration ships a **"Build with Gemini Code Assist"** flow that scaffolds full iPaaS integrations from a prompt. Gemini **Cloud Assist** (a sibling product) is the operations counterpart, presented at Next '26 as the day-2 ops surface.

**4. Minimum working config.** No YAML — just enable per user:

```bash
gcloud services enable cloudaicompanion.googleapis.com
# Then assign roles in IAM:
# roles/cloudaicompanion.user  to each developer
```

In Workstations, the Code OSS image ships with Gemini Code Assist preinstalled; sign in with the Google identity that has the role above.

**5. Best practices.**
- Use **Enterprise** edition if you want Gemini to see your private repo context (with audit).
- Lock down **prompt injection surfaces** — don't paste customer LLM outputs into Code Assist sessions casually.
- Pair Code Assist suggestions with `pnpm run verify-build` — never commit AI-suggested config without it.
- For sensitive code, prefer **Standard** over Individual — Individual may use your code to improve the model; Enterprise/Standard have stricter data-use guarantees.

**6. Docs.** https://docs.cloud.google.com/gemini/docs/codeassist/overview · https://docs.cloud.google.com/gemini/docs/codeassist/release-notes · https://docs.cloud.google.com/cloud-assist · https://docs.cloud.google.com/cloud-assist/overview · https://docs.cloud.google.com/application-integration/docs/build-integrations-gemini

---

## Section B — Task / Schedule / Integration

### B.1 Cloud Scheduler

**1. What it is (2026).** A managed cron service. Each job has a unix-cron-style (or human-readable **`groc`**) schedule, a target (HTTP, Pub/Sub topic, or App Engine), and a timezone (default UTC, tz-database names). Cloud Scheduler is the "kick something off every N minutes" primitive that doesn't require you to run a VM.

**2. Agent-pipeline relevance.** Two textbook uses:
- **Periodic agent jobs** — "every 15 min, run the source-and-vet agent against new TikTok handles".
- **Health pings** — "every minute, hit `/healthz` on the Cloud Run agent service to keep an instance warm".

**3. Latest features 2026.** Continued: Pub/Sub / HTTP / App Engine / Cloud Run / GKE / on-prem targets, OIDC and OAuth auth for HTTP targets, retry config, **unix-cron and `groc`** formats, time-zone aware schedules.

**4. Minimum working config.**

```bash
gcloud scheduler jobs create http hourly-source-agent \
  --location=us-central1 \
  --schedule="0 * * * *" \
  --time-zone="Asia/Seoul" \
  --uri="https://agent-orchestrator-xyz-uc.a.run.app/jobs/source" \
  --http-method=POST \
  --oidc-service-account-email=scheduler-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --oidc-token-audience="https://agent-orchestrator-xyz-uc.a.run.app"
```

**5. Best practices.**
- Always use **OIDC auth** to authenticate the HTTP call to Cloud Run; never make the target public.
- Set **deadline** explicitly (default 3 min); for long agent runs, do not call the agent directly — instead enqueue a **Cloud Task** and return immediately.
- Idempotent targets: re-runs happen on retry — encode an `idempotency-key`.
- Co-locate scheduler region with target region to dodge cross-region latency.
- Avoid sub-minute cadences (the lowest is 1 minute) — use Cloud Tasks scheduled delivery or Inngest for second-level precision.
- Use **`groc`** for legibility on edge cases (`every 2 hours from 09:00 to 18:00`).

**6. Docs.** https://docs.cloud.google.com/scheduler/docs/overview · https://docs.cloud.google.com/scheduler/docs/schedule-run-cron-job · https://docs.cloud.google.com/scheduler/docs/configuring/cron-job-schedules · https://docs.cloud.google.com/scheduler/docs/creating

---

### B.2 Cloud Tasks vs Pub/Sub

**1. What they are (2026).** Both deliver messages. The split:
- **Cloud Tasks**: explicit-invocation queue. The **publisher chooses the exact target endpoint** for each task (HTTP URL or App Engine handler), and gets per-task scheduling, retries with backoff, rate / concurrency control, and queue-level routing override.
- **Pub/Sub**: implicit-invocation event bus. The publisher emits to a **topic**, and any number of subscribers (push or pull) consume independently. Publishers do not know subscribers exist.

**2. Agent-pipeline relevance.** The rule of thumb:
- "Do this specific thing later, with control over when and how often" → **Cloud Tasks** (e.g. retry an LLM call with backoff, throttle outbound email to 1 req/s).
- "This thing happened; whoever cares, react" → **Pub/Sub** (e.g. `agent.run.completed` → analytics + warehouse + Slack notifier).

For an ADK / Claude-Agent-SDK agent, you usually want **both**: Pub/Sub for the event log, Cloud Tasks (or Inngest, which we use) for per-step retry control.

**3. Latest features 2026.** Both remain GA, with Pub/Sub gaining **Pub/Sub-on-Kafka** interop and Eventarc Advanced as a routing layer above it. Cloud Tasks added **HTTP target routing overrides at the queue level** (set the host once, not per task).

**4. Minimum working config.**

Cloud Tasks → Cloud Run:

```bash
gcloud tasks queues create agent-retries \
  --location=us-central1 \
  --max-dispatches-per-second=20 \
  --max-concurrent-dispatches=10 \
  --max-attempts=5 \
  --min-backoff=10s --max-backoff=300s --max-doublings=4

gcloud tasks create-http-task \
  --queue=agent-retries --location=us-central1 \
  --url=https://agent-orchestrator-xyz-uc.a.run.app/retry/abc \
  --method=POST
```

Pub/Sub push to Cloud Run:

```bash
gcloud pubsub topics create agent-events
gcloud pubsub subscriptions create agent-events-to-warehouse \
  --topic=agent-events \
  --push-endpoint=https://warehouse-xyz-uc.a.run.app/ingest \
  --push-auth-service-account=pubsub-sa@$PROJECT_ID.iam.gserviceaccount.com
```

**5. Best practices.**
- Use Cloud Tasks for **outbound** integrations where you must rate-limit (LinkedIn API, Gmail send, SMS) — queue-level `max-dispatches-per-second` is the throttle.
- Use Pub/Sub for **broadcast** (telemetry, audit, fan-out to multiple consumers).
- Set **OIDC auth** on push subscriptions — never public push endpoints.
- Dead-letter queues are non-negotiable (Pub/Sub: `--dead-letter-topic`; Cloud Tasks: `max-attempts` then your code paths it elsewhere).
- Mind **at-least-once** semantics — both can deliver duplicates. Idempotency keys in the message body.
- For an **agent workflow orchestrator** (start, wait, branch, retry, sleep-1-day), Workflows or Inngest is a better fit than building it from Cloud Tasks + state in Mongo.

**6. Docs.** https://docs.cloud.google.com/tasks/docs/comp-pub-sub · https://docs.cloud.google.com/pubsub/docs/choosing-pubsub-or-cloud-tasks · https://docs.cloud.google.com/tasks/docs/creating-queues · https://cloud.google.com/tasks/docs/creating-http-target-tasks · https://docs.cloud.google.com/pubsub/docs/pubsub_overview

---

### B.3 Workflows

**1. What it is (2026).** A **fully managed, durable, stateful orchestrator** that executes a YAML / JSON workflow definition. Steps can call any HTTP API (including Google APIs with built-in auth), branch, retry with exponential backoff, **wait up to a year**, and persist state across waits. Serverless, scales to zero, charged per step.

**2. Agent-pipeline relevance.** This is the GCP-native answer to "durable agent workflow with waits". If you are already on Inngest (we are, per `CLAUDE.md`), Workflows is the **GCP-native alternative** — picking between them is a portability vs. ecosystem call:

| Need | Pick |
|------|------|
| Wait for a Gmail reply for 3 days, then resume | Workflows or Inngest (both fine) |
| Need TypeScript-native step authoring with strong types | **Inngest** |
| Need fully managed, no extra vendor, GCP IAM end-to-end | **Workflows** |
| Need to orchestrate Google service calls with built-in auth | **Workflows** |
| Need fan-out to thousands of parallel agent runs | **Workflows** (parallel branches) or Inngest |

**Workflows vs ADK orchestration**: ADK's `SequentialAgent` / `ParallelAgent` / `LoopAgent` orchestrate **agent-internal** turns (one Vertex call → next Vertex call). Workflows orchestrates **service-level** steps including agents as one step among many. Use ADK for the LLM-tool-LLM loop, Workflows for the "wait for human approval → trigger agent → publish results" outer loop.

**3. Latest features 2026.** Continued: low-latency execution, exception handling with custom error blocks, retries with exponential backoff, parallel branches, support for callbacks ("pause until external HTTP webhook").

**4. Minimum working config.**

```yaml
# wf-vet.yaml
main:
  params: [input]
  steps:
    - call_vet_agent:
        call: http.post
        args:
          url: https://agent-orchestrator-xyz-uc.a.run.app/vet
          auth:
            type: OIDC
          body: ${input}
        result: vetResult
    - decide:
        switch:
          - condition: ${vetResult.body.score > 0.7}
            next: notify_pass
          - condition: true
            next: notify_fail
    - notify_pass:
        return: ${vetResult.body}
    - notify_fail:
        raise: "vetting failed"
```

Deploy:
```bash
gcloud workflows deploy vet-flow --source=wf-vet.yaml --location=us-central1
gcloud workflows execute vet-flow --data='{"handle":"@example"}' --location=us-central1
```

**5. Best practices.**
- Keep each step **idempotent** — retries are automatic.
- Use **callbacks** (`callback.endpoint`) instead of polling for "wait until human approves".
- Cap step retries; uncapped retries against an external API are how you get rate-limited.
- Store the workflow execution ID in your domain DB so you can correlate.
- Compose long flows from **sub-workflows** rather than one mega-YAML.
- For **observability**, every step's HTTP response is in the execution; pipe to BigQuery for SLO dashboards.

**6. Docs.** https://docs.cloud.google.com/workflows/docs/overview · https://docs.cloud.google.com/workflows/docs/best-practice · https://docs.cloud.google.com/workflows/docs/choose-orchestration · https://cloud.google.com/workflows

---

### B.4 Eventarc + Eventarc Advanced

**1. What it is (2026).** **Eventarc Standard** routes events from ~90 Google sources (Cloud Audit Logs, Cloud Storage, Pub/Sub, Firestore, etc.) to destinations (Cloud Run, Cloud Run functions, Workflows). **Eventarc Advanced** (GA since August 2025) adds: a **Publish API** for custom + 3rd-party CloudEvents, a **central message bus** with IAM-content-based access, VPC-SC integration, **content-based routing**, and **payload transformation** before delivery.

**2. Agent-pipeline relevance.** When you want "GCS bucket gets new object → kick off the image-analysis agent", Eventarc is the glue. Eventarc Advanced is the answer to "we have a central event bus across product, marketing, ops, and the agent should react to specific events, not all of them" — without writing a Pub/Sub-to-Pub/Sub router yourself.

**3. Latest features 2026.** Eventarc Advanced GA: central bus, content-based filtering, payload transformation, CloudEvents publish API, VPC-SC support.

**4. Minimum working config.**

```bash
# Service account with the Cloud Run invoker role
gcloud iam service-accounts create eventarc-sa
gcloud run services add-iam-policy-binding agent-image \
  --member=serviceAccount:eventarc-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/run.invoker --region=us-central1

# Trigger: new object in bucket → Cloud Run service
gcloud eventarc triggers create image-uploaded \
  --location=us-central1 \
  --destination-run-service=agent-image \
  --destination-run-region=us-central1 \
  --event-filters="type=google.cloud.storage.object.v1.finalized" \
  --event-filters="bucket=ss-uploads" \
  --service-account=eventarc-sa@$PROJECT_ID.iam.gserviceaccount.com
```

**5. Best practices.**
- Standard for simple "one source → one sink"; **Advanced when you need a bus**.
- Always set **`--service-account`** with `roles/run.invoker` — public Cloud Run for event handlers is a footgun.
- For high-volume sources (Storage on a busy bucket), prefer Pub/Sub + your own subscriber over Eventarc — fewer hops, cheaper.
- Use **content-based filters** in Advanced to keep agent invocations out of high-cost zones unless needed.
- New triggers can take up to **2 minutes** to start filtering — test patience first, then blame your code.
- Tag events with `traceparent` so a single user action traces across Storage → Eventarc → agent → Pub/Sub.

**6. Docs.** https://docs.cloud.google.com/eventarc/docs/overview · https://cloud.google.com/eventarc/advanced/docs/overview · https://docs.cloud.google.com/eventarc/advanced/docs/choose-product-edition · https://docs.cloud.google.com/eventarc/docs/release-notes · https://docs.cloud.google.com/run/docs/triggering/trigger-with-events

---

### B.5 Application Integration

**1. What it is (2026).** Google's **iPaaS** (Integration Platform as a Service). Drag-and-drop integration designer, **90+ pre-built connectors** (Salesforce, MongoDB, MySQL, BigQuery, Pub/Sub, GCS, …), event-driven triggers, low-code data mapping, **Gemini AI assistance** for flow design, serverless and fully managed. Free tier: 400 integration executions, 20 GiB data processed, 2 connection nodes per month.

**2. Agent-pipeline relevance.** When your agent needs to write a row to Salesforce, append to a Google Sheet, fan a notification to Slack — Application Integration replaces "go write five Cloud Functions + token rotation + retry logic" with a flow + connector. For **non-engineering owners** (ops, growth) who need to shape agent outputs into business systems, this is the right primitive.

**3. Latest features 2026.** "Build with Gemini Code Assist" — describe an integration in natural language, get a scaffolded flow with the right connectors pre-wired.

**4. Minimum working config.** No useful YAML snippet — Application Integration is **flow-designer-first**; configs are JSON exported from the console. The bootstrap is:

```bash
gcloud services enable integrations.googleapis.com connectors.googleapis.com
# Then open the Application Integration console, create a region, design a flow.
```

**5. Best practices.**
- Treat integrations as **code**: export the JSON to git, PR-review changes.
- Don't put **agent-loop** logic in Application Integration — it's for I/O orchestration; agent reasoning belongs in ADK / Genkit / Vertex AI Agent Engine.
- Use **Cloud KMS** for connector credentials, never raw strings.
- Watch the **executions metric**: every step is billable, loops can be expensive.
- Have a **fallback path** — if the iPaaS flow fails (Salesforce 503), Cloud Tasks DLQ the work for human review.
- Prefer Application Integration over Workflows when you need **40+ connectors out of the box**; prefer Workflows when you need **code-grade control flow**.

**6. Docs.** https://docs.cloud.google.com/application-integration/docs/overview · https://cloud.google.com/application-integration · https://docs.cloud.google.com/application-integration/docs/build-integrations-gemini

---

### B.6 Apigee X (full API management)

**1. What it is (2026).** Enterprise-grade API management: traffic management, threat protection, OAuth/JWT/API-key auth, transformation/mediation, analytics, **developer portal**, and **monetization** (rate plans, prepaid/postpaid billing, revenue share, banded fees). Available as **Subscription** or **Pay-as-you-go** environments.

**2. Agent-pipeline relevance.** When your agent platform is itself a product API you **sell** — to partners, to enterprise customers, to other internal LOBs — Apigee is where you put **per-tenant rate limits, billing, and a self-serve developer portal**. The 2026 monetization features (AppGroups, banded consumption fees) line up directly with "$ per agent call" or "tiered $/M tokens" pricing.

**3. Latest features 2026.**
- **Monetization supports AppGroups** (Dec 2025) — manage rate-plan subscriptions for all developers in an org-style group at once.
- **Banded consumption-based fees** in rate plans (variable fees by usage band).
- AI solutions on Apigee — Apigee in front of LLM endpoints with cost/quota policies.

**4. Minimum working config.** Apigee is too heavy for a `gcloud` one-liner; the realistic bootstrap is provisioning an **Apigee organization** with `gcloud alpha apigee organizations provision` plus an **environment** plus a **proxy bundle**. For a useful config snippet, ship a proxy YAML from your repo and deploy via `apigeecli` (Apigee's CLI). At scale, Terraform `google_apigee_*` resources are the canonical path.

**5. Best practices.**
- Pick **Pay-as-you-go** for low-volume / variable; **Subscription** for predictable enterprise.
- Don't run Apigee for **internal-only, GCP-native** APIs — that's API Gateway's job.
- Apigee in front of LLM endpoints (Gemini, Anthropic, OpenAI proxied through your account): **quota policies** cap per-tenant token spend; **transformation** redacts PII before logging.
- Use the **developer portal** to publish OpenAPI for your agent API; pair with **API Hub** (next).
- For monetization, model **3 rate plans max** at launch — the matrix explodes faster than you'd think.
- Audit logs to BigQuery, **never** trust Apigee analytics alone for billing.

**6. Docs.** https://cloud.google.com/apigee · https://docs.cloud.google.com/apigee/docs/api-platform/monetization/overview · https://docs.cloud.google.com/apigee/docs/api-platform/monetization/release-notes · https://docs.cloud.google.com/apigee/docs/api-platform/get-started/what-apigee · https://docs.cloud.google.com/apigee/docs/api-platform/reference/pay-as-you-go-environment-types

---

### B.7 Apigee API Hub

**1. What it is (2026).** A **centralized catalog and governance layer** for every API across your org — regardless of whether it's served by Apigee, API Gateway, ingress on GKE, or a Cloud Run service direct. Devs discover APIs, evaluate them (spec, owner, target users, business unit), and consume them.

**2. Agent-pipeline relevance.** When you have 30 internal APIs, the agent (or a human integrating one) needs a discoverability layer. The 2026 **MCP discovery proxy** support is particularly relevant: API Hub can publish a Model Context Protocol endpoint so an LLM agent can **discover and call internal tools through MCP** without hand-wiring each one.

**3. Latest features 2026.**
- **gcloud CLI support** for API Hub.
- **Spec boost** (preview) — Gemini auto-enriches your OpenAPI with better descriptions, examples, error docs.
- **MCP discovery proxies** — turn the catalog into an MCP server an agent can query.
- **Card view** UI for browsing.
- Native bridge from **API Gateway** to API Hub.

**4. Minimum working config.**

```bash
gcloud services enable apihub.googleapis.com
gcloud apigee api-hub apis create order-api \
  --location=us-central1 \
  --display-name="Order API" \
  --owner-email=apis@example.com
gcloud apigee api-hub versions create v1 \
  --api=order-api --location=us-central1 \
  --spec-file=openapi.yaml
```

**5. Best practices.**
- Make API Hub the **single source of truth** for "what APIs exist?" — wire CI to push OpenAPI on merge.
- Use **MCP discovery proxies** for any API an agent might need to call — fewer ad-hoc tool wirings in agent code.
- Tag APIs by **business unit + owner** so deprecations have a real human to ping.
- Pair with Apigee for **enforcement** (rate limits) and API Hub for **discoverability** — these are complementary, not redundant.

**6. Docs.** https://docs.cloud.google.com/apigee/docs/apihub/what-is-api-hub · https://docs.cloud.google.com/apigee/docs/apihub/release-notes · https://docs.cloud.google.com/api-gateway/docs/api-hub-overview

---

### B.8 API Gateway (lightweight alternative)

**1. What it is (2026).** A **fully managed, OpenAPI-driven** gateway that fronts Cloud Run / Cloud Functions / App Engine backends. Pay-per-call, no provisioning. Supports API key + JWT auth, request validation, basic rate limits, CORS. Far simpler than Apigee — no developer portal, no monetization, no advanced traffic shaping.

**2. Agent-pipeline relevance.** The right answer for "we have a Cloud Run agent service; we want **API keys + simple rate limits** in front, integrated with **API Hub** for discovery". Apigee is overkill for a single-team-internal agent API.

**3. Latest features 2026.** Native publishing to **API Hub** (single command), continued OpenAPI 2.0 config model.

**4. Minimum working config.**

```yaml
# openapi.yaml
swagger: "2.0"
info: { title: agent-api, version: 1.0 }
host: agent-api.example.com
schemes: [https]
paths:
  /run:
    post:
      operationId: run
      x-google-backend:
        address: https://agent-orchestrator-xyz-uc.a.run.app
      security:
        - api_key: []
      responses: { "200": { description: ok } }
securityDefinitions:
  api_key:
    type: apiKey
    name: x-api-key
    in: header
```

Deploy:
```bash
gcloud api-gateway api-configs create v1 \
  --api=agent-api --openapi-spec=openapi.yaml --project=$PROJECT_ID
gcloud api-gateway gateways create agent-gw \
  --api=agent-api --api-config=v1 --location=us-central1
```

**5. Best practices.**
- API Gateway → Cloud Run with **internal ingress + IAM** so only the gateway can reach the service.
- Use **JWT auth** for human users, **API keys** for machine-to-machine.
- Publish the same OpenAPI to **API Hub** so it's discoverable.
- If you ever need monetization, partner ecosystem, or fine-grained policy → **migrate to Apigee**; don't try to grow API Gateway into Apigee.
- One config version = one immutable artifact; promote configs the same way you promote container images (Cloud Deploy can drive this).

**6. Docs.** https://cloud.google.com/blog/products/application-modernization/choosing-between-apigee-api-gateway-and-cloud-endpoints · https://docs.cloud.google.com/api-gateway/docs/api-hub-overview

---

## Section C — Firebase (agent-front dashboards)

### C.1 Firebase Hosting + Firebase App Hosting

**1. What it is (2026).** **Firebase Hosting** = the original static + dynamic content CDN (good for static Next export, Hugo, plain SPA). **Firebase App Hosting** = a newer offering, **GA in April 2025**, purpose-built for **Next.js and Angular SSR**. App Hosting runs your SSR app on Cloud Run behind Google Cloud Load Balancer + Cloud CDN, with GitHub integration, secrets, environments, and built-in support for Server Components / streaming / middleware.

**2. Agent-pipeline relevance.** For our **Mission Control** (Next 16, SSR-heavy, real-time agent state), App Hosting is the more ergonomic option vs. raw Cloud Run because:
- Next.js 16.2's **stable Deployment Adapter API** is what App Hosting plugs into → first-class SSR, streaming, partial pre-rendering.
- One `apphosting.yaml` instead of Dockerfile + Cloud Build + Cloud Run + LB + CDN wiring.
- GitHub push-to-deploy, environments, automatic preview URLs per PR.
- `FirebaseServerApp` (Firebase JS SDK variant) for SSR with end-user credentials propagated to Firestore / Storage.

**Does App Hosting beat Cloud Run for SSR?** For a small/medium team with a Next.js SSR app and no other GCP infra: **yes** — fewer moving parts, automatic CDN, automatic LB, automatic SSL, GitHub-native. For a team that already runs 20 services on Cloud Run with its own Terraform: **arguable** — App Hosting is opinionated and abstracts away knobs (e.g. fine-grained CPU/concurrency tuning) that an SRE may want.

**3. Latest features 2026.**
- Next.js 16.2 **Deployment Adapter API** integration (Firebase blog March 2026).
- GA for Next.js + Angular.
- Backend = Cloud Run; fronted by Google Cloud LB + Cloud CDN; logs to Cloud Logging.

**4. Minimum working config.** `apphosting.yaml` at repo root:

```yaml
runConfig:
  cpu: 1
  memory: 512Mi
  minInstances: 0
  maxInstances: 10
  concurrency: 80
env:
  - variable: NEXT_PUBLIC_BACKEND_URL
    value: https://api.example.com
  - variable: ANTHROPIC_API_KEY
    secret: anthropic-api-key
```

Bootstrap:
```bash
firebase init apphosting
firebase apphosting:backends:create --project=$PROJECT_ID \
  --location=us-central1 --service=mission-control
git push  # GitHub-connected backend auto-builds + deploys
```

**5. Best practices.**
- For SSR Next.js dashboards: **start with App Hosting**, fall back to raw Cloud Run only if you need control App Hosting doesn't expose.
- Put **secrets in Secret Manager** (`secret:` not `value:`).
- Use **per-PR preview channels** for design review.
- Lock the **build region** to where your data lives — cross-region SSR fetch adds 30–80 ms p50.
- Pin the **Next.js version** in `package.json` — App Hosting picks the adapter; floating versions can break the adapter contract.
- Use **Firebase App Check** to require an attested client before SSR endpoints — keeps scripted abuse off the agent API.
- Wire **Cloud Logging + Error Reporting** — they're on by default, but configure alerts.

**6. Docs.** https://firebase.google.com/docs/app-hosting · https://firebase.google.com/docs/hosting/frameworks/nextjs · https://firebase.google.com/docs/app-hosting/frameworks-tooling · https://firebase.google.com/docs/hosting · https://docs.cloud.google.com/run/docs/quickstarts/frameworks/deploy-nextjs-service

---

### C.2 Firebase Auth vs Identity Platform

**Confirmed: Identity Platform is the upgrade path; Firebase Auth is not "deprecated" but is the entry-level skin over the same backend.**

**1. What it is (2026).**
- **Firebase Authentication**: client-friendly identity (email/password, Google, Apple, GitHub, anonymous, phone, custom token). Free tier on Spark plan.
- **Firebase Authentication with Identity Platform (FAIP) = Identity Platform**: same SDK, same APIs, **same client code**, but enables **OIDC, SAML, multi-tenancy, Identity-Aware Proxy integration, BAA (HIPAA) coverage, and a 99.95% uptime SLA**. Paid (per-MAU).

**2. Agent-pipeline relevance.** Two scenarios where the upgrade is forced:
- **Multi-tenant agent platform** (each workspace gets its own user pool with its own auth providers) — needs **multi-tenancy**, which is Identity Platform only.
- **Enterprise SSO** (customer wants Okta SAML or Azure AD OIDC) — needs OIDC/SAML, Identity Platform only.

**3. Migration path.** **None of your app code needs to change** when upgrading from Firebase Auth to Identity Platform — same SDK, same APIs, same UIDs. Enable from Console → Identity Platform → Upgrade. The Admin SDK supports bulk import (1000 users per API call) for moves between projects or providers.

**4. Minimum working config (upgrade).**

```bash
gcloud services enable identitytoolkit.googleapis.com
# Upgrade is one click in the Console; CLI path:
gcloud alpha identity-platform tenants create main-tenant --display-name="Main"
```

**5. Best practices.**
- If you might **ever** want enterprise SSO or multi-tenancy → enable Identity Platform from day one (no client code change later).
- Use **custom claims** on the JWT for org / role / plan; don't bake those in your domain DB only.
- **Never** issue Firebase Auth tokens from a backend agent — use **custom tokens** with short TTLs and Cloud Run-injected service accounts.
- For Mission Control's "is this user an admin?" path, validate the JWT **in middleware** (Next.js middleware on Edge) and pass claims to Server Components — avoid round-tripping to Identity Platform per request.
- Audit logs: turn on **Cloud Audit Logs** for `identitytoolkit.googleapis.com`.

**6. Docs.** https://docs.cloud.google.com/identity-platform/docs/product-comparison · https://docs.cloud.google.com/identity-platform/docs/migrating-users · https://docs.cloud.google.com/identity-platform/docs/migrate-users-between-projects-tenants · https://docs.cloud.google.com/identity-platform/docs/multi-tenancy-authentication · https://cloud.google.com/security/products/identity-platform

---

### C.3 Firebase Functions (= Cloud Run functions 2nd gen)

**Confirmed: Cloud Functions (1st gen) is the legacy product. Cloud Functions (2nd gen) was rebranded to "Cloud Run functions" — they are Cloud Run services with the function programming model on top. Firebase Functions deploys through this stack.**

**1. What it is (2026).** Function-as-a-Service. **2nd gen** runs on Cloud Run infrastructure with: more CPU/memory ceilings, concurrent request handling (one instance, multiple requests), up to 1 h max runtime, **90+ Eventarc event sources** (BigQuery, Cloud SQL, Firebase Alerts, Test Lab, Remote Config, Storage, …), and full Terraform support.

**2. Agent-pipeline relevance.** Two natural fits:
- **Glue functions**: "Firestore doc updated → enqueue a Cloud Task → agent processes". Stay short; long-running agent work belongs on Cloud Run services.
- **Webhooks**: receive Stripe / Slack / GitHub webhooks → validate → enqueue work.

For **anything long-running, multi-step, or with sub-agent fan-out** → use Cloud Run services + Workflows / Inngest, not functions.

**3. Latest features 2026.** Terraform support for 2nd gen; Firebase Alerts / Test Lab / Remote Config triggers in Preview.

**4. Minimum working config.** TypeScript Firebase function:

```ts
// functions/src/index.ts
import { onObjectFinalized } from "firebase-functions/v2/storage";
export const onUpload = onObjectFinalized(
  { region: "us-central1", memory: "512MiB", concurrency: 20 },
  async (event) => {
    // enqueue agent task here
  },
);
```

```bash
firebase deploy --only functions
```

**5. Best practices.**
- **Always 2nd gen** for new code; 1st gen for maintenance only.
- Set **`concurrency`** > 1 to amortize cold starts.
- Keep functions **stateless and short** — the moment you need durable waits, switch to Workflows.
- Pin **memory** explicitly; 2nd gen lets you scale up to 32 GB but you pay for what you request.
- Use **secrets** via `defineSecret` (Secret Manager), not env vars in code.
- For event sources that drift the Eventarc schema (Firebase Alerts is Preview), **assert payload shape** in the function — don't trust the typings yet.

**6. Docs.** https://docs.cloud.google.com/functions/docs/release-notes · https://cloud.google.com/blog/products/serverless/cloud-functions-2nd-generation-now-generally-available · https://docs.cloud.google.com/firestore/native/docs/extend-with-functions · https://docs.cloud.google.com/functions/docs/runtime-support

---

### C.4 Firebase Genkit (vs ADK)

**1. What it is (2026).** **Genkit** is Google's open-source AI app framework for **JavaScript/TypeScript (GA, Feb 2025), Go (Beta), Python (Alpha), Dart (Preview)**. It gives you unified `ai.generate()` APIs, structured output, tool calling, **MCP** support, plugin architecture (Vertex AI / Anthropic / OpenAI / Ollama plugins), and a **local dev UI**. You write a "flow" (explicit code) and Genkit runs it.

**2. Genkit vs Agent Development Kit (ADK).** These are **different layers**, not competitors:

| Axis | Genkit | ADK |
|------|--------|-----|
| Layer | Low-level AI framework: models, prompts, tools, MCP | High-level **multi-agent** framework: sessions, memory, evals, runtime |
| Style | You define the workflow; explicit code paths | You define agents + tools; the LLM decides who handles each turn |
| Languages | JS/TS (GA), Go (Beta), Python (Alpha), Dart (Preview) | Python (GA), Java 1.0 (early 2026), Go 1.0 (early 2026), TypeScript (2025) |
| Runtime | Any: Cloud Run, Cloud Functions, Firebase App Hosting, on-prem | Vertex AI **Agent Engine** is the first-class deploy target; also Cloud Run / GKE |
| Best for | Single-flow GenAI features inside an app (Q&A, summarization, retrieval, function calling) | Multi-agent systems where multiple LLM-powered agents collaborate autonomously |

**When to pick what:**
- "Add a 'summarize this' button to my Next.js app" → **Genkit (TS)**.
- "Build a hierarchical orchestrator that delegates to a research agent, a draft agent, a fact-check agent" → **ADK**.
- "I'm already on Vertex AI Agent Engine for managed sessions/memory/evals" → **ADK**.
- "I want one TS codebase, deployed to Cloud Run, no Python" → **Genkit**.

For our `social-seeding-v2`, where the orchestration is **Inngest workflows** invoking agents **as functions** (curated tools, Zod outputs, USD caps), we sit closer to the **Genkit philosophy** (explicit code) than ADK's autonomous-routing philosophy. The Claude Agent SDK fills the role Genkit would play on a Google-first stack.

**3. Latest features 2026.** GA in Node, growing language coverage, MCP support, broader plugin ecosystem, used in production at Google.

**4. Minimum working config.**

```ts
// genkit/agent.ts
import { genkit, z } from "genkit";
import { vertexAI, gemini20Flash } from "@genkit-ai/vertexai";

const ai = genkit({ plugins: [vertexAI({ location: "us-central1" })], model: gemini20Flash });

export const vetFlow = ai.defineFlow(
  { name: "vetFlow", inputSchema: z.object({ handle: z.string() }), outputSchema: z.object({ score: z.number() }) },
  async ({ handle }) => {
    const { text } = await ai.generate({ prompt: `Vet @${handle} on a 0-1 scale; return JSON.` });
    return { score: parseFloat(text) };
  },
);
```

Run locally: `genkit start`; deploy as a Cloud Run function or as part of a Firebase App Hosting backend.

**5. Best practices.**
- Pair Genkit with **Vertex AI** plugin for first-party models; you can also plug Anthropic / OpenAI / Ollama.
- Always define **Zod input/output schemas** on flows — that's your contract.
- Use the **Genkit Dev UI** locally to inspect flow runs before deploying.
- **One flow = one purpose** — chain flows in code, don't build mega-flows.
- For multi-agent **autonomy**, look at ADK or accept that you're hand-rolling it in Genkit.
- Always cap **per-flow token cost** with model parameters + your own counters.

**6. Docs.** https://firebase.google.com/products/genkit · https://firebase.google.com/docs/genkit (Firebase docs) · ADK + Agent Engine: https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale · https://cloud.google.com/products/gemini-enterprise-agent-platform

---

### C.5 Firebase Studio — STATUS: Sunset

**1. What it is (now).** An agentic, browser-based cloud IDE (Code OSS + Gemini + Nix + Android emulators) for prototyping full-stack AI apps via the "App Prototyping agent" or directly in the editor.

**2. Critical 2026 status.** **Firebase Studio is being sunset.** Google announced in **March 2026**:
- **New workspace creation and account registration disabled on June 22, 2026.**
- **Final shutdown: March 22, 2027.**
- Migration: code-first → **Antigravity** (Google's next-gen IDE); browser-based prototyping → **Google AI Studio** (which gained Firestore + Firebase Auth integration in 2026).

**Recommendation for any new project today**: do not adopt Firebase Studio. Use **Cloud Workstations** for managed dev environments or **AI Studio / Antigravity** for prototyping.

**6. Docs.** https://firebase.google.com/docs/studio · https://firebase.google.com/docs/studio/migrating-project · https://firebase.google.com/support/release-notes/firebase-studio

---

### C.6 Firebase Data Connect → SQL Connect

**1. What it is (2026).** Firebase Data Connect, **renamed Firebase SQL Connect** at Cloud Next 2026, is the Firebase-native way to put a **Cloud SQL for PostgreSQL** database behind a typed client SDK with **realtime updates and offline caching**. You can write queries/mutations as **GraphQL or native SQL**; the system generates SDKs and applies row-level security via Firebase rules.

**2. Agent-pipeline relevance.** When your agent has a **structured-data** side (CRM-like tables, lookups, multi-tenant configs) and a Firebase / web client consuming it, SQL Connect skips the "write a REST/GraphQL API + auth + caching layer yourself" step. Postgres extensions (pgvector!) are first-class, so you can co-locate vector + relational data.

**3. Latest features 2026.**
- **Realtime query updates** (push-based change feed).
- **Offline caching** at query and entity level.
- **Native SQL** alongside GraphQL — write CTEs, window functions, use any Postgres extension.
- **Full-text search** via Postgres FTS (no separate search engine).
- **Admin SDK** for bulk ops; **Event Triggers** for server-side workflows.
- **90-day no-cost trial** (no credit card required).

**4. Minimum working config (schema + connector).**

```graphql
# schema.gql
type Lead @table {
  id: UUID!
  email: String!
  score: Float!
  createdAt: Timestamp!
}
```

```bash
firebase init sqlconnect
firebase deploy --only sqlconnect
```

**5. Best practices.**
- Co-locate **pgvector** with your relational tables when the agent does retrieval over the same data — fewer joins across services.
- Use **realtime queries** sparingly — they're easy to over-subscribe and blow up bandwidth.
- Define **row-level security** at the database, not just in the client SDK.
- Use **native SQL** for aggregations / windows; GraphQL for simple CRUD.
- Pair with **Identity Platform** for multi-tenant row isolation.

**6. Docs.** https://firebase.google.com/products/sql-connect · https://firebase.google.com/docs/sql-connect · https://firebase.google.com/docs/sql-connect/quickstart

---

## Section D — Edge / Hybrid

### D.1 Google Distributed Cloud (GDC): Hosted + Air-Gapped

**1. What it is (2026).** Two product lines:
- **GDC Connected (Hosted)**: Google Cloud services running on your premises with a connection back to Google Cloud for control-plane updates.
- **GDC Air-Gapped**: Fully isolated, **no connectivity required to Google Cloud**. Designed for sovereignty / classified / regulated workloads. Plus **GDC Air-Gapped Appliance**: GDC-on-a-ruggedized-portable-box for field/remote ops.

**2. Agent-pipeline relevance.** When data residency / sovereignty / classified-network requirements force "the LLM must run on-premises":
- **Gemini is now available on GDC** (incl. air-gapped) with advanced reasoning and content generation — agents can run end-to-end inside the sovereign environment.
- **Latest Gemini Flash on NVIDIA Blackwell & Blackwell Ultra** is in Preview for GDC connected customers (joining existing air-gapped support).

**3. Latest features 2026.** Gemini on GDC (both connected and air-gapped); Blackwell support; expanding service surface tracked in the GDC Next '26 announcements.

**4. Minimum working config.** GDC is **not** a `gcloud` one-liner — provisioning is a sales + integration engagement with Google. The CLI surface is `gdcloud` (separate from `gcloud`). For evaluation, talk to Google about a GDC Air-Gapped Appliance trial.

**5. Best practices.**
- Pick **GDC only** when sovereignty / classification / connectivity rules force it. If they don't, **public GCP is cheaper, faster-evolving, and easier to operate**.
- Pin the **service catalog you need at the air-gap** before signing — air-gapped GDC trails public GCP in service coverage.
- Plan for **model updates over sneakernet**: in true air-gap, new Gemini versions arrive on physical media.
- Architect agents to be **model-version-agnostic** so on-prem upgrades don't break flows.

**6. Docs.** https://docs.cloud.google.com/distributed-cloud/hosted/docs/latest/gdcag/overview · https://cloud.google.com/distributed-cloud-air-gapped · https://docs.cloud.google.com/distributed-cloud/hosted/docs/latest/appliance/overview · https://cloud.google.com/distributed-cloud · https://cloud.google.com/blog/topics/hybrid-cloud/google-distributed-cloud-at-next26

---

### D.2 Anthos — STATUS: rebranded / absorbed into GKE Enterprise + GDC

**1. What it is (2026).** **Anthos as a standalone brand has largely been absorbed.** The product surface that used to be "Anthos" is now split:
- **GKE Enterprise** — Anthos features (config sync, policy controller, service mesh, multi-cluster management, attached clusters for AWS / Azure / on-prem) are now packaged under the **GKE Enterprise** tier.
- **Google Distributed Cloud (GDC)** — Anthos clusters on bare metal and Anthos on VMware became **GDC software** offerings.

In 2026 docs, you'll see "GKE Enterprise" and "Google Distributed Cloud" rather than fresh "Anthos" content; legacy Anthos URLs redirect into one of those two product trees.

**2. Agent-pipeline relevance.** If you already operate **multi-cluster GKE** (Cloud + on-prem + another cloud) and want consistent agent deployments across all of them, **GKE Enterprise** is the platform. For deeply regulated / sovereign / disconnected → **GDC**.

**3. Best practices.**
- Don't start a new project on the "Anthos" brand — pick GKE Enterprise or GDC explicitly.
- Use **Config Sync + Policy Controller** (the Anthos features under GKE Enterprise) to enforce that your agent CRDs / Cloud Deploy targets stay consistent across clusters.
- For attached AWS / Azure clusters, treat them like first-class **Cloud Deploy targets** alongside GCP-native ones.

**6. Docs.** https://cloud.google.com/anthos (now redirects/branded to GKE) · https://docs.cloud.google.com/kubernetes-engine/enterprise/docs/release-notes · https://docs.cloud.google.com/kubernetes-engine/distributed-cloud/bare-metal/docs

---

## Section E — Critical sub-topics

### E.1 End-to-end CI/CD for an ADK agent

The canonical 2026 pipeline for a Python-based ADK agent destined for **Vertex AI Agent Engine** (with a Cloud Run fallback) looks like this:

```
GitHub push
   │
   ▼
Cloud Build trigger
   ├─ pytest + agent eval (golden set, fail if regression > N%)
   ├─ Cloud Native Buildpack → image
   └─ Push to Artifact Registry (with SLSA Build Provenance + scan)
        │
        ▼
Binary Authorization gate
   └─ Require: SLSA L3 attestation + 0 CRITICAL CVEs
        │
        ▼
Cloud Deploy release
   ├─ Target: agent-dev (Cloud Run, auto-promote on health)
   ├─ Target: agent-staging (Cloud Run, manual approval gate)
   └─ Target: agent-prod (Vertex AI Agent Engine + Cloud Run, CANARY 10→50→100)
        │
        ▼
Verification step (Cloud Build job calling agent with synthetic prompts)
        │
        ▼
Promote / Rollback
```

Concrete bits:

```yaml
# cloudbuild.yaml
steps:
  - name: python:3.12
    entrypoint: bash
    args: ["-c", "pip install -e .[dev] && pytest -q && python -m evals.run --threshold 0.85"]
  - name: gcr.io/k8s-skaffold/pack
    entrypoint: pack
    args:
      - build
      - us-central1-docker.pkg.dev/$PROJECT_ID/agents/sourcer:$SHORT_SHA
      - --builder=gcr.io/buildpacks/builder:latest
      - --publish
images: ["us-central1-docker.pkg.dev/$PROJECT_ID/agents/sourcer:$SHORT_SHA"]
```

```yaml
# clouddeploy.yaml — three serial targets, canary on prod
apiVersion: deploy.cloud.google.com/v1
kind: DeliveryPipeline
metadata: { name: sourcer-pipeline }
serialPipeline:
  stages:
    - { targetId: dev-run }
    - { targetId: staging-run, profiles: [staging] }
    - targetId: prod-run
      strategy:
        canary:
          runtimeConfig: { cloudRun: { automaticTrafficControl: true } }
          canaryDeployment: { percentages: [10, 50], verify: true }
```

Pair with: **Binary Authorization** policy requiring SLSA + scan attestations, **Cloud Deploy verify** step that runs a smoke prompt and checks tool-error rate, and **Cloud Monitoring** SLOs on agent latency + cost-per-run.

Docs: https://docs.cloud.google.com/deploy/docs/deployment-strategies/canary/cloud-run · https://docs.cloud.google.com/build/docs/release-notes · https://docs.cloud.google.com/artifact-registry/docs/analysis · https://docs.cloud.google.com/deploy/docs/securing/security-insights · https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale

---

### E.2 Gemini Code Assist for accelerating agent code

The realistic wins in 2026 (verified across cloud.google.com release notes and product pages):
- **Inside Workstations / VS Code**: in-context suggestions for `cloudbuild.yaml`, `clouddeploy.yaml`, `apphosting.yaml`, Terraform, gcloud commands, Genkit / ADK boilerplate.
- **Application Integration** flows authored from a natural-language description ("when a new lead arrives in Salesforce, score it with Vertex and write to BigQuery").
- **Cloud Build log diagnosis**: paste a failing log line, get a targeted fix grounded in your YAML.
- **Gemini Cloud Assist** (sibling product, Next '26): the operations counterpart — "explain this incident", "draft a postmortem", "why did p95 spike?".

What it does **not** replace: `pnpm run verify-build`, code review, agent eval. Treat Code Assist as a **first-draft** generator.

Docs: https://docs.cloud.google.com/gemini/docs/codeassist/overview · https://docs.cloud.google.com/gemini/docs/codeassist/release-notes · https://docs.cloud.google.com/application-integration/docs/build-integrations-gemini · https://docs.cloud.google.com/cloud-assist/overview · https://cloud.google.com/blog/products/application-development/gemini-cloud-assist-at-next26

---

### E.3 Genkit vs ADK — decision

Already detailed in §C.4. Compressed verdict:

- **Single GenAI feature in a TS/JS app** → **Genkit** (TS GA, fits a Next.js / Cloud Run / Firebase shape).
- **Multi-agent collaboration with delegation, sessions, managed memory, evals** → **ADK** + **Vertex AI Agent Engine**.
- **Already on Inngest + Claude Agent SDK (us)** → keep your current explicit-orchestration model; map to GCP only if you migrate runtime. Genkit and ADK are **alternatives** to that stack, not additions to it.

---

### E.4 Firebase App Hosting for Mission Control — verdict

For our Mission Control (Next 16 SSR, agent-state UI, Better-auth or NextAuth on dashboard side), the calculus:

**Firebase App Hosting wins when:**
- You want a single PR-driven deploy story (GitHub push → preview URL → merge → prod).
- You want CDN + LB + SSL handled for you.
- You want **first-class Next.js 16.2 SSR** via the stable Deployment Adapter API.
- You're OK with Firebase being in the auth / Firestore / Storage path.

**Plain Cloud Run wins when:**
- You already have a Terraform-managed Cloud Run + LB + CDN stack and want consistency.
- You need **fine-grained** CPU/concurrency/min-instances tuning App Hosting abstracts away.
- You're using **non-Firebase** identity (NextAuth + Google OAuth, as our customer frontend does).
- You need to share a service mesh / VPC pattern with non-Next.js services.

**For a fresh greenfield Next.js Mission Control without an SRE team**: **start with App Hosting**. The 2026 Next.js Deployment Adapter API and FirebaseServerApp give it a real edge over hand-rolled Cloud Run for SSR.

**For our project**: given that `web/` (the v1 dashboard) is on Better-auth + Cloud Run pattern and we have working Cloud Run deploy scripts, the migration cost to App Hosting is probably not worth it for the dashboard — but a **new** Mission Control build (v2) is a clean place to try App Hosting and skip ~40% of the platform plumbing.

Docs: https://firebase.google.com/docs/app-hosting · https://firebase.blog/posts/2026/03/nextjs-adapters/ · https://firebase.google.com/docs/hosting/frameworks/nextjs · https://docs.cloud.google.com/run/docs/quickstarts/frameworks/deploy-nextjs-service

---

## Quick reference — pick-the-right-service

| Need | Pick |
|------|------|
| Build container from source | **Cloud Build** (+ Buildpacks for first-party code) |
| Multi-stage deploy with canary | **Cloud Deploy** |
| Container / package registry with CVE scan + SLSA | **Artifact Registry** + **Artifact Analysis** |
| Managed dev VMs in your VPC | **Cloud Workstations** |
| AI assistance in IDE + Cloud surfaces | **Gemini Code Assist** (Standard / Enterprise) |
| Cron / scheduled jobs | **Cloud Scheduler** |
| Rate-limited, per-task retry queue | **Cloud Tasks** |
| Event bus / fan-out | **Pub/Sub** (or **Eventarc Advanced** as a bus) |
| Durable workflow with long waits, GCP-native | **Workflows** |
| Code-first durable workflow, polyglot, TS-native | **Inngest** (third-party) |
| Multi-agent orchestration | **ADK** + Vertex AI Agent Engine |
| TS GenAI library | **Genkit** |
| Low-code iPaaS for ops/growth integrations | **Application Integration** |
| Enterprise API mgmt + monetization | **Apigee X** |
| Internal API catalog + discovery | **Apigee API Hub** |
| Lightweight OpenAPI gateway in front of Cloud Run | **API Gateway** |
| Next.js SSR with GH push-to-deploy | **Firebase App Hosting** |
| Identity with SAML/OIDC/multi-tenant | **Identity Platform** (= Firebase Auth + IP) |
| Postgres-backed app data with realtime + offline | **Firebase SQL Connect** |
| Sovereign / air-gapped agent stack | **GDC Air-Gapped** (+ Gemini on GDC) |
| Multi-cluster GKE across cloud + on-prem | **GKE Enterprise** (formerly Anthos) |

---

## Closing notes for our team

- We are currently **Inngest + Claude Agent SDK** orchestrated; the GCP-native analogue would be **Workflows + ADK on Vertex AI Agent Engine**. There is no immediate pressure to migrate — the current stack is winning on portability and TS-native ergonomics.
- The most attractive GCP services to **opportunistically adopt today**, without a stack rewrite:
  1. **Artifact Registry + Artifact Analysis** for any production image (free wins on supply-chain hygiene).
  2. **Cloud Workstations** as soon as a second developer joins a sensitive feature (no-source-on-laptop policy).
  3. **API Gateway + API Hub** in front of our Cloud Run agent service when external partners arrive.
  4. **Firebase App Hosting** for any **new** Next.js surface (not retrofitting v1 dashboard).
- Things to **avoid adopting** in 2026: Cloud Source Repositories (deprecating), Firebase Studio (sunsetting), bare "Anthos" branding (use GKE Enterprise or GDC explicitly).
- Watch the **deploy-time risks** highlighted in our workspace `CLAUDE.md`: shared Atlas, CORS=*, Watchtower-on-`:latest` for TikTok scrapers. SLSA attestation + Binary Authorization is the GCP-native fix for the Watchtower problem; pin tags + Cloud Deploy is the simpler one.
