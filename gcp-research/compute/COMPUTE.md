# Google Cloud Compute & Container Services for AI Agent Workloads (May 2026 reference)

> **Audience**: engineers shipping long-running stateful agent workflows on GCP — intermittent LLM calls, inbound webhooks, durable state, occasional GPU inference.
> **Scope**: every GA / Preview compute-class service that can host an "AI agent" workload as of **May 2026**. Each entry lists current status, when to pick it, the latest features, a copy-paste deploy, ops best practices, and official docs.
> **Confidence**: high for GA services (cross-checked against `cloud.google.com` release notes and product pages updated April–May 2026); preview features explicitly flagged.

---

## TL;DR — the 2026 short answer

Most AI agent workloads in 2026 land on **one of three patterns**:

1. **Inbound webhook + intermittent LLM call, < 60 min per run** → Cloud Run services (now with built-in **SSH**, **MCP server**, GPU L4/RTX PRO 6000 Blackwell, instance-based billing, ephemeral disk, Service Bindings).
2. **Long-running stateful agent loop (background, hours–days, queue-driven)** → **Cloud Run worker pools (GA April 14, 2026)** or **Cloud Run instances (Preview)**; for richer isolation/snapshotting → **GKE Agent Sandbox (Preview)**.
3. **Self-hosted LLM serving / fine-tuning** → Compute Engine **A4** (B200) / **A4X / A4X Max** (GB200/GB300) / **A3 Ultra** (H200), or GKE with the same accelerators behind **DRANET (GA)**.

For orchestration, Google's official answer in 2026 is **Workflows** (durable, year-long waits, callbacks) for deterministic flows, plus the new **Gemini Enterprise Agent Platform** for agent-to-agent orchestration. **Eventarc Advanced (GA Aug 2025)** is the event mesh between them.

The decision tree at the bottom of this doc collapses the rest.

---

## 1. Cloud Run (services) — GA, the default for agent webhooks

### What it is
Fully managed serverless container platform. Runs stateless HTTP/HTTPS containers, scales 0 → N on traffic, billed per request or per-instance. The **gen2 execution environment** (Linux 6.1+ namespaced, full filesystem semantics, faster startup) is the default for new services in 2026.

### When to use for AI agents
- Webhook endpoints that receive an event, fan out one or two LLM calls, and return inside the request window.
- LLM proxies / RAG retrievers that need scale-to-zero economics.
- Agent **control planes** that delegate the actual long-running work to a worker pool or Workflow.
- Anywhere you want **per-instance GPU** without managing nodes (L4 24 GB or RTX PRO 6000 Blackwell 96 GB).

### Latest features 2026
- **2026-04-15** — Cloud Run **MCP server GA**: agents and AI apps can deploy/manage Cloud Run via Model Context Protocol.
- **2026-04-13** — **NVIDIA RTX PRO 6000 Blackwell GPU** GA across services, jobs, and worker pools (24 GB → 96 GB jump from L4).
- **2026-04-20** — **Ephemeral disk** Preview: per-instance scratch volume that lives for the instance lifetime.
- **2026-04-16** — **Custom CPU / concurrency scaling targets** Preview (replaces the fixed 60% default).
- **2026-04** (Next ’26) — **SSH support** (Preview) into running containers (`gcloud run services ssh SERVICE`).
- **2026-04** — **Cloud Run Instances** Preview: long-lived primitive for background agents, integrates with Cloud Storage volume mounts.
- **2026-04** — **Cloud Run Sandboxes** (Coming Soon) and **Service Bindings** (Coming Soon): ephemeral isolated exec for agent-generated code; native service-to-service wiring.
- **2026-02-06** — Flexible CUDs extended to Cloud Run (Compute Engine + GKE + Cloud Run unified).
- Runtimes added in 2026: .NET 10 (Feb), Go 1.26 (Mar), Ruby 4.0 (Mar), `osonly24` base image (Feb).

### Minimum working deploy
```bash
# Service with min=1 (no cold start), instance-based billing, L4 GPU,
# Direct VPC egress to a private VPC, IAP-protected.
gcloud run deploy agent-control \
  --image=us-docker.pkg.dev/PROJECT/repo/agent:latest \
  --region=us-central1 \
  --cpu=4 --memory=16Gi \
  --gpu=1 --gpu-type=nvidia-l4 \
  --min-instances=1 --max-instances=20 \
  --no-cpu-throttling \
  --concurrency=10 \
  --no-allow-unauthenticated \
  --iap \
  --network=projects/PROJECT/global/networks/agent-vpc \
  --subnet=projects/PROJECT/regions/us-central1/subnetworks/run-egress \
  --vpc-egress=private-ranges-only \
  --service-account=agent-runner@PROJECT.iam.gserviceaccount.com
```

Terraform equivalent uses `google_cloud_run_v2_service` with `template.scaling.min_instance_count`, `template.containers.resources.limits["nvidia.com/gpu"]`, and `template.node_selector.accelerator = "nvidia-l4"` (provider `google-beta` for GPU fields).

### Best practices
- **Cold start**: keep `min-instances ≥ 1` for any user-facing agent; with GPU the L4 driver alone needs ~5 s to warm and `gemma3:4b` first-token is ~19 s from zero.
- **Billing mode**: switch to **instance-based** billing whenever you have background work in `init()` or long-lived connections (websockets, gRPC streams); request-based billing only charges during the request lifecycle and starves background CPU.
- **Concurrency**: tune `--concurrency` per the model's true tokens/sec rather than HTTP RPS; for GPU services, concurrency 1–4 is typical to avoid VRAM contention.
- **Networking**: prefer **Direct VPC egress (GA)** over the legacy Serverless VPC Connector — ~2× throughput (up to 1 GB/s/instance), no connector to manage, and no compute charge.
- **Auth**: combine `--no-allow-unauthenticated` with `--iap` for zero-trust webhook ingress; for service-to-service, prefer the new **Service Bindings** when GA.
- **Observability**: deploy the **Google-built OpenTelemetry Collector as a sidecar** (or the managed Prometheus sidecar) — agents export to `localhost:4317`, the collector handles batching/retry. Always handle SIGTERM to flush spans on scale-down.
- **Cost**: enable the upcoming **Billing Caps** for hard monthly spend limits; for spiky agent traffic use **flexible CUDs** rather than min-instances.
- **GPU**: pin GPU to one region/zone and accept that GPU services don't multi-region failover automatically — use **traffic splitting** for canaries instead.

### Doc URLs
- https://cloud.google.com/run/docs
- https://cloud.google.com/run/docs/release-notes
- https://cloud.google.com/run/docs/about-instance-autoscaling
- https://cloud.google.com/run/docs/configuring/billing-settings
- https://cloud.google.com/run/docs/configuring/services/gpu
- https://cloud.google.com/run/docs/configuring/vpc-direct-vpc
- https://cloud.google.com/blog/products/serverless/whats-new-for-cloud-run-at-next26

---

## 2. Cloud Run Jobs — GA, the right answer for batch agent runs

### What it is
Run-to-completion containers on the same Cloud Run platform. No HTTP server; the container's entrypoint exits and the task is done. Up to **10 000 parallel tasks**, up to **168 h (7 d)** per task, automatic retry.

### When to use for AI agents
- Nightly batches: re-rank a candidate set, refresh embeddings, summarise yesterday's chats.
- Massively parallel one-shot agent runs (`CLOUD_RUN_TASK_INDEX` shards the input).
- Cost-bounded fine-tuning or evaluation sweeps with GPU.
- Anywhere a Cloud Run service is the wrong shape because there's no HTTP request.

### Latest features 2026
- **2025-06-16** — Jobs gained GPU configuration (Preview), now GA in 2026 (NVIDIA L4 / RTX PRO 6000 Blackwell). GPU jobs are capped at **1-hour task timeout**.
- **2026-04-20** — Ephemeral disk volumes are also available on jobs.
- All worker pool / service improvements in 2026 (CUDs, Direct VPC egress) apply equally.

### Minimum working deploy
```bash
gcloud run jobs create eval-sweep \
  --image=us-docker.pkg.dev/PROJECT/repo/eval:latest \
  --region=us-central1 \
  --tasks=200 \
  --parallelism=20 \
  --max-retries=3 \
  --task-timeout=30m \
  --cpu=2 --memory=8Gi \
  --set-env-vars=DATASET=gs://my-bucket/eval/2026-05 \
  --service-account=eval-runner@PROJECT.iam.gserviceaccount.com \
  --execute-now
```

### Best practices
- **Idempotency is non-negotiable** — every task can run up to `max-retries + 1` times; design writes to be safe under replay (use `CLOUD_RUN_TASK_INDEX` as a partition key).
- **Parallelism vs downstream limits**: cap `--parallelism` to whatever your slowest dependency (DB, vector store, third-party API) can absorb; with 10 k tasks the default "as fast as possible" will DDoS yourself.
- **Checkpoint at task boundaries**, not inside tasks — store intermediate state to GCS / Firestore so a retried task picks up cleanly.
- **Schedule via Cloud Scheduler → Workflows → Jobs**, not Cloud Scheduler → Jobs directly: you get retries-of-retries, callbacks, and visibility.
- **GPU jobs**: the 1-hour wall-clock is a hard cap; chunk long fine-tunes into tasks that resume from a checkpoint blob.
- **Cost**: jobs bill only while the task runs; combine with **flexible CUDs** for steady-state batch volume.
- **Observability**: use job execution names as the trace correlation ID; emit OTLP from inside the task; rely on Cloud Logging's per-execution view for triage.

### Doc URLs
- https://cloud.google.com/run/docs/create-jobs
- https://cloud.google.com/run/docs/configuring/parallelism
- https://cloud.google.com/run/docs/configuring/max-retries
- https://cloud.google.com/run/docs/jobs-retries
- https://cloud.google.com/run/docs/configuring/jobs/gpu

---

## 3. Cloud Run Worker Pools — GA April 14, 2026 (the new long-running agent home)

### What it is
A third Cloud Run resource type alongside services and jobs. Maintains **persistent, long-lived instances** that **pull** work (Pub/Sub, Kafka, Redis, custom queues) instead of being scaled by inbound HTTP. No load-balanced URL, no request-driven autoscaling.

### When to use for AI agents
- The canonical "AI agent that loops forever and consumes work from a queue" pattern.
- Streaming inference (KV-cache held in memory across many requests pulled from a queue).
- Distributed LLM training / fine-tuning fleets that need to stay warm.
- Self-hosted Pub/Sub consumers, Kafka workers, GitHub Actions self-hosted runners.

### Latest features 2026
- **2026-04-14** — **General Availability**. Production SLA, stable API.
- **GPU support at GA** — L4 and **RTX PRO 6000 Blackwell** attachable to pool instances; same `--gpu` / `--gpu-type` flags as services.
- **CREMA (Cloud Run External Metrics Autoscaler)** — Google's open-sourced controller that scales worker pools off Pub/Sub backlog, Kafka lag, or any external metric. Worker pools themselves **do not autoscale by default** — you set instance count, or wire CREMA.
- Cloud Storage and NFS **volume mounts** supported (same as services).

### Minimum working deploy
```bash
# 3 instances continuously draining a Pub/Sub pull subscription.
gcloud run worker-pools deploy agent-workers \
  --image=us-docker.pkg.dev/PROJECT/repo/agent-worker:latest \
  --region=us-central1 \
  --cpu=2 --memory=4Gi \
  --instances=3 \
  --set-env-vars=PUBSUB_SUBSCRIPTION=projects/PROJECT/subscriptions/agent-tasks \
  --service-account=worker@PROJECT.iam.gserviceaccount.com \
  --add-volume=name=state,type=cloud-storage,bucket=agent-state \
  --add-volume-mount=volume=state,mount-path=/var/agent/state
```

### Best practices
- **Pick the scaling story up front**: fixed `--instances=N` is fine for predictable load; for spiky queues, run **CREMA** in the same project and let it scale on backlog.
- **Pull, don't be pushed**: worker pools are explicitly pull-based; if your event source pushes, put a Pub/Sub buffer in front.
- **Graceful drain**: handle SIGTERM to ACK in-flight messages before exit — scale-down kills instances.
- **Stateful but not stateless-storage**: keep the durable state in GCS / Firestore / Memorystore; the instance disk is best-effort. Volume mounts make GCS state ergonomic.
- **One container, many tasks**: design the worker so a single instance can process N messages concurrently — that's where the throughput gain over jobs comes from.
- **Observability**: emit OTLP with a sidecar collector exactly like services; add a custom metric (e.g. `agent_inflight`) and feed it to CREMA.
- **GPU**: stays warm across messages — this is the single biggest reason to pick worker pools over jobs for LLM serving with batched requests.

### Doc URLs
- https://cloud.google.com/run/docs/deploy-worker-pools
- https://cloud.google.com/run/docs/managing/workerpools
- https://cloud.google.com/run/docs/configuring/workerpools/gpu
- https://cloud.google.com/blog/products/serverless/cloud-run-worker-pools-at-estee-lauder-companies

---

## 4. Cloud Run Instances (Preview, 2026-04) — the "one container, one long agent" primitive

### What it is
Brand-new Cloud Run resource (Preview at Next ’26) that exposes the **underlying instance primitive** directly. Unlike a service it does not autoscale on traffic and unlike a worker pool it is not a fleet — it is **one instance**, addressable by URL, designed to host **one long-running background agent** with GCS-backed state.

### When to use for AI agents
- A single Claude / Gemini agent loop that needs its own URL, its own state on GCS, and to stay alive across many user interactions (think: per-user dev sandbox, per-customer assistant).
- The replacement for "I spun up a VM for one agent."
- When you want sandbox-like semantics without the GKE Agent Sandbox commitment.

### Latest features 2026
- **Preview at Next ’26 (April 2026)** to "select customers." Not yet GA.
- Native `--add-volume mount-path=...,type=cloud-storage,bucket=...` for state persistence.
- Companion **Cloud Run Sandboxes** for ephemeral isolated execution of agent-generated code (Coming Soon).

### Minimum working deploy
```bash
# Single long-running background agent, GCS-backed state.
gcloud run instances create my-agent \
  --image alpine/openclaw:latest \
  --region=us-central1 \
  --port=18789 \
  --memory=4Gi \
  --default-url \
  --add-volume mount-path=/home/node/.openclaw,type=cloud-storage,bucket=my-agent-state
```

### Best practices
- **Preview, treat with care**: do not depend on this for SLA-bound workloads yet; expect API and pricing changes before GA.
- **One agent per instance** — by design. For fleets, use worker pools.
- **State on GCS volume mounts** — local FS is not durable, but the bucket mount is.
- **Pair with Sandboxes** for the "agent runs LLM-generated code" subloop; keep the persistent agent in an instance, spawn ephemeral sandboxes for code exec.

### Doc URLs
- https://cloud.google.com/blog/products/serverless/whats-new-for-cloud-run-at-next26
- https://cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts

---

## 5. GKE Standard — GA, when Cloud Run is not enough

### What it is
Managed Kubernetes where Google owns the control plane and you own the nodes (machine types, taints, drivers, daemonsets, CSI drivers). The traditional choice.

### When to use for AI agents
- You need **specific machine types** (A4X Max, custom local SSD layout, Confidential Computing nodes, ARM-only fleets).
- You need **DaemonSets**, host networking, NVIDIA driver pinning, custom kernel modules — Autopilot disallows or limits these.
- You're running a platform with many teams sharing a cluster, with namespace-level cost attribution and resource quotas.
- You need GPU scheduling features (MIG, time-slicing, MPS) that aren't yet exposed in Autopilot.

### Latest features 2026
- **DRANET (Dynamic Resource Allocation Networking) GA** for **A3 Ultra, A4, A4X, A4X Max** plus **TPU v6e, TPU v7x** — proper Kubernetes-native multi-NIC and accelerator topology awareness.
- **A3 Edge (a3-edgegpu-8g) with H100** GA on GKE Standard.
- **Confidential GKE Nodes + A3 High + H100** — supported from GKE 1.32.2-gke.1297000, auto-driver-install 1.33.3-gke.1392000+.
- **N4D machine family** GA on Standard and Autopilot.
- **Image streaming + secondary boot disks** GA on Ubuntu+containerd nodes — measurable agent pod startup win.

### Minimum working deploy
```bash
# Regional cluster with a GPU node pool (H100), release channel = regular.
gcloud container clusters create agent-prod \
  --location=us-central1 \
  --release-channel=regular \
  --num-nodes=2 \
  --machine-type=n2-standard-8 \
  --enable-ip-alias

gcloud container node-pools create gpu-h100 \
  --cluster=agent-prod \
  --location=us-central1 \
  --machine-type=a3-highgpu-8g \
  --accelerator=type=nvidia-h100-80gb,count=8,gpu-driver-version=latest \
  --num-nodes=1 \
  --enable-autoscaling --min-nodes=0 --max-nodes=4 \
  --spot
```

### Best practices
- **Pick a release channel** (rapid / regular / stable) and stick to it; don't pin to a specific minor version unless you have to.
- **Always regional**, never zonal, for any production agent workload — single-zone failure shouldn't take the control plane down.
- **Autoscaler + cluster autoscaler + node autoprovisioning** together — manual node pool sizing is the most common cause of "agent stuck pending" tickets.
- **Run the NVIDIA GPU Operator** for driver/runtime; on H100/B200 use `gpu-driver-version=latest` and let GKE auto-install.
- **Workload Identity** for every pod — no static service-account JSON keys mounted into agents.
- **Spot/preemptible node pools** for batch agent fleets; on-demand for the control-plane-y workloads.
- **Observability**: turn on GKE Managed Prometheus + Cloud Trace; use OpenTelemetry sidecars/daemonsets the same way as Cloud Run.

### Doc URLs
- https://cloud.google.com/kubernetes-engine/docs
- https://cloud.google.com/kubernetes-engine/docs/release-notes-new-features
- https://cloud.google.com/kubernetes-engine/docs/how-to/creating-a-regional-cluster
- https://cloud.google.com/kubernetes-engine/docs/resources/autopilot-standard-feature-comparison

---

## 6. GKE Autopilot — GA, the right Kubernetes for most agent teams

### What it is
GKE mode where Google manages both the control plane **and** the worker nodes. You submit Pods; Google provisions compute. Billed per pod-resource-request second on the container-optimised platform; switches to per-node billing the moment you ask for specialised hardware (GPU, ARM, etc.).

### When to use for AI agents
- You want Kubernetes semantics (StatefulSets, CRDs, Helm) without the node ops.
- Variable / spiky load where paying for idle nodes hurts.
- You need **GKE Agent Sandbox** (Preview) for AI-generated-code isolation.
- Teams without a dedicated platform/SRE crew.

### Latest features 2026
- **Burstable workloads** (GA) — pods can temporarily exceed requested resources without changing the request, billed for what they actually use; pricing as low as ~$2/month for a 50 m CPU / 50 MiB container in us-central1.
- **GPU support** on Autopilot via ComputeClasses (L4, H100, H200, B200 on N-series ComputeClass mappings).
- **DRANET GA** also lands here for A3 Ultra/A4/A4X/A4X Max and TPU v6e/v7x.
- **N4D** GA on Autopilot.
- **GKE Agent Sandbox** (Preview, requires GKE ≥ 1.35.2-gke.1269000) ships through Autopilot easily.

### Minimum working deploy
```bash
gcloud container clusters create-auto agent-autopilot \
  --location=us-central1 \
  --release-channel=regular

# Then just `kubectl apply` your Deployments / StatefulSets.
# For a GPU pod, request the GPU directly:
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata: { name: agent-gpu }
spec:
  replicas: 1
  selector: { matchLabels: { app: agent-gpu } }
  template:
    metadata:
      labels: { app: agent-gpu }
    spec:
      nodeSelector:
        cloud.google.com/gke-accelerator: nvidia-l4
      containers:
      - name: agent
        image: us-docker.pkg.dev/PROJECT/repo/agent:latest
        resources:
          limits:
            nvidia.com/gpu: "1"
            cpu: "4"
            memory: 16Gi
EOF
```

### Best practices
- **Default choice** for new agent teams that want K8s — Standard is now an explicit "I need control" choice, not a default.
- **Autopilot cost rule of thumb**: if your Standard cluster runs >60–70 % utilization, Standard is cheaper; below that, Autopilot wins because you stop paying for idle nodes.
- **Use burstable** for sidecar / collector pods that idle most of the time and spike during flushes.
- **GKE Agent Sandbox** is the right place for "agent executes LLM-generated code" workloads — gVisor isolation, sub-second provisioning from warm pools, default-deny network policy.
- **StatefulSets are supported** with block storage and GPUs — Autopilot is no longer a stateless-only environment.
- **Don't fight the platform**: things Autopilot blocks (privileged pods, host networking, arbitrary DaemonSets) are blocked for good reasons — if you need them, move that workload to Standard.

### Doc URLs
- https://cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview
- https://cloud.google.com/blog/products/containers-kubernetes/introducing-gke-autopilot-burstable-workloads
- https://cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox
- https://cloud.google.com/kubernetes-engine/docs/how-to/autopilot-gpus

---

## 7. GKE + GPU / TPU — the latest accelerators (May 2026)

### What it is
Both Standard and Autopilot expose Google's accelerator-optimised hardware as Kubernetes resources (`nvidia.com/gpu`, `cloud-tpus.google.com/v6e`, etc.).

### When to use for AI agents
- **LLM training or large-scale fine-tune**: A4X Max / A4X (GB200/GB300 Grace-Blackwell, Arm) or A4 (B200) — pick A4X for the highest interconnect bandwidth (NVL72), A4 for x86-friendly stacks.
- **High-throughput inference of 30B–200B models**: A3 Ultra (H200 8-pack, 1.1 TB HBM3e total) or A4.
- **Cost-tuned inference of <30B models**: A3 High / A3 Edge (H100) or, if you don't need 80 GB, L4 nodes.
- **TPU-native training/inference** (Gemini-class workloads, JAX/PyTorch-XLA): Trillium (TPU v6e) GA, Ironwood (TPU v7x) for the largest pods.

### Latest features 2026
- **A4X Max** GA on Compute Engine (us-central1-a) — NVIDIA GB300, 4 GPUs per VM, NVL72 rack.
- **A4X** GA — NVIDIA GB200 Grace-Blackwell, first Arm GPU VM on GCP.
- **A4** GA — B200 8-GPU, foundation-model training and serving.
- **A3 Ultra** + AI Hypercomputer cluster pattern GA — H200 8-pack.
- **A3 Mega / A3 High / A3 Edge** all GA with H100.
- **A2** still GA with A100 for legacy / cost-sensitive workloads.
- **TPU v6e (Trillium)** GA; **TPU v7x (Ironwood)** in limited availability as of May 2026 (not full GA yet).
- **DRANET GA** for all of A3 Ultra+ and TPU v6e+ on GKE.

### Minimum working deploy
```bash
# Add a B200 node pool to an existing GKE Standard cluster.
gcloud container node-pools create gpu-b200 \
  --cluster=agent-prod \
  --location=us-central1 \
  --machine-type=a4-highgpu-8g \
  --accelerator=type=nvidia-b200,count=8,gpu-driver-version=latest \
  --num-nodes=1 \
  --enable-autoscaling --min-nodes=0 --max-nodes=2 \
  --reservation-affinity=specific \
  --reservation=my-a4-reservation
```

### Best practices
- **Reservations or Future Reservations are mandatory** for A4 / A4X / A4X Max — on-demand availability is sparse.
- **Prefer the AI Hypercomputer reference architectures** for any multi-node training — they encode the right NCCL settings, GPUDirect-TCPX/RDMA wiring, and DRANET resources.
- **For inference**, A3 Edge (H100, optimised for serving) is often a better $/throughput than A3 High.
- **TPU vs GPU**: TPU v6e/v7x dominate on $/token for Google-stack inference (JAX, MaxText, TGI-on-TPU); GPUs still win for arbitrary PyTorch with custom kernels.
- **Spot/preemptible A100 / L4** is viable for batch fine-tunes; **never spot the H200/B200/GB200** classes — preemption can kill 100s of GPU-hours of state.

### Doc URLs
- https://cloud.google.com/compute/docs/accelerator-optimized-machines
- https://cloud.google.com/compute/docs/gpus
- https://cloud.google.com/blog/products/compute/whats-new-with-google-clouds-ai-hypercomputer-architecture
- https://cloud.google.com/blog/products/compute/a3-ultra-with-nvidia-h200-gpus-are-ga-on-ai-hypercomputer
- https://cloud.google.com/blog/products/compute/introducing-a4-vms-powered-by-nvidia-b200-gpu-aka-blackwell

---

## 8. Compute Engine — GA, raw VMs for self-hosted LLMs

### What it is
Plain VMs. You pick the machine family, attach disks, install drivers, run anything.

### When to use for AI agents
- **Self-hosted LLM inference with vLLM / SGLang / TGI** where Cloud Run GPU limits (96 GB max VRAM single instance, 1-hour task cap on jobs) don't fit a 70B+ model.
- Large-context / long-running inference where you must keep KV cache pinned across requests.
- Fine-tuning runs that need bare-metal-ish control of drivers, NCCL, kernel.
- Anything CUDA-specific that GKE node pools can't expose cleanly.

### Latest features 2026
- All accelerator-optimised families above (A2 → A4X Max) available as plain VMs.
- **AI Hypercomputer cluster** templates for one-command multi-VM topology.
- **Confidential VMs + A3 H100** supported.
- **Reservations + Future Reservations** are the way to actually get B200/GB200 capacity.

### Minimum working deploy
```bash
# Single A3 Ultra VM (H200 x 8) for vLLM tensor-parallel serving.
gcloud compute instances create vllm-llama405b \
  --zone=us-central1-a \
  --machine-type=a3-ultragpu-8g \
  --image-family=common-cu125-ubuntu-2404 \
  --image-project=deeplearning-platform-release \
  --boot-disk-size=2000GB --boot-disk-type=pd-ssd \
  --maintenance-policy=TERMINATE \
  --reservation=my-a3-ultra-reservation \
  --metadata=startup-script='#!/bin/bash
docker run --gpus all -p 8000:8000 \
  vllm/vllm-openai:latest \
  --model meta-llama/Llama-3.1-405B-Instruct \
  --tensor-parallel-size 8'
```

### Best practices
- **vLLM is the production default** in 2026 for self-hosted inference — paged attention + continuous batching. SGLang is the right second choice for structured-output / agent workloads.
- **Run inside a managed instance group** with a load balancer in front rather than a single VM, even for prototypes — saves a re-architecture later.
- **OS Login + IAP TCP forwarding** instead of public SSH; never give a serving VM a public IP.
- **Image families from Deep Learning VM** save days of CUDA/cuDNN/NCCL setup.
- **Always reservations** for any GPU above L4; spot on H200+ is a recipe for lost work.
- **Observability**: Ops Agent (`google-cloud-ops-agent`) for system metrics + DCGM exporter for GPU metrics → Cloud Monitoring; OTLP for app traces.
- **Networking**: Premium Tier + Cloud NAT for egress; gVNIC for any A3+ family (you must enable it explicitly on older OS images).

### Doc URLs
- https://cloud.google.com/compute/docs
- https://cloud.google.com/compute/docs/release-notes
- https://cloud.google.com/compute/docs/gpus
- https://cloud.google.com/compute/docs/accelerator-optimized-machines

---

## 9. Compute Engine A3 Mega / A3 Ultra / A4 — GA accelerator detail

This is the row of the matrix you actually care about for AI inference / training in 2026:

| Family | GPU | Count/VM | HBM/VM | Interconnect | Status (May 2026) | Best for |
|---|---|---|---|---|---|---|
| **A2** | A100 40/80 GB | 1–16 | up to 1.28 TB | NVLink 3 | GA | Cost-tuned training, legacy code |
| **A3 Edge** | H100 80 GB | 8 | 640 GB HBM3 | NVLink 4 | GA | Inference serving (price-tuned) |
| **A3 High** | H100 80 GB | 1–8 | up to 640 GB | NVLink 4 | GA | General H100, dev clusters |
| **A3 Mega** | H100 80 GB Mega | 8 | 640 GB HBM3 | 2× NVLink BW | GA | Pre-train, fine-tune, inference |
| **A3 Ultra** | H200 141 GB | 8 | 1.128 TB HBM3e | NVLink 4 | GA | 70B–200B inference, pre-train |
| **A4** | B200 | 8 | ~1.5 TB HBM3e | NVLink 5 | GA | B200 LLM training & serving |
| **A4X** | GB200 (Arm) | 4 | rack-scale | NVL72 | GA | Foundation model training |
| **A4X Max** | GB300 (Arm) | 4 | rack-scale | NVL72 | GA (us-central1-a) | Foundation model training, HPC |

### When to use which
- **vLLM Llama-70B / Mistral Large** → single A3 Mega or A3 Ultra VM is enough.
- **vLLM Llama-405B / DeepSeek-V3 / Gemini-class** → A3 Ultra **or** A4 (8× B200) is the practical minimum.
- **Training new foundation models** → A4X / A4X Max in a Hypercompute Cluster — fewer rooms in the world have these.
- **Long-context retrieval-augmented agents** → A3 Ultra (H200) wins on KV cache headroom (141 GB per GPU).

### Doc URLs
- https://cloud.google.com/blog/products/compute/introducing-a4-vms-powered-by-nvidia-b200-gpu-aka-blackwell
- https://cloud.google.com/blog/products/compute/a3-ultra-with-nvidia-h200-gpus-are-ga-on-ai-hypercomputer

---

## 10. App Engine Standard + Flex — GA but not recommended for new work

### What it is
Google's oldest PaaS. Standard runs sandboxed language runtimes (Python 3.x, Java 17/21, Node 20+, Go 1.22+, PHP 8.x, Ruby 3.x); Flex runs containers on managed Compute Engine VMs.

### Status May 2026
- **Both environments are still GA**, no shutdown announced.
- **Google's official guidance** on `cloud.google.com/appengine/docs/the-appengine-environments`: *"For new Google Cloud users, we recommend using Cloud Run as the preferred alternative over App Engine."*
- **Gen 1 legacy runtimes deprecated** as of **January 31, 2026** — Python 2.7, Java 8, Go 1.11, PHP 5.5. Existing apps keep serving traffic but new deployments are blocked unless you have an `appengine.runtimeDeploymentExemption` policy.
- Modern second-gen runtimes (Python 3.x, Java 11+, Go 1.12+) continue receiving updates.

### When to use for AI agents
**Don't, for new builds.** If you already run on App Engine, Google's App Engine Migration Center (`docs.cloud.google.com/appengine/migration-center/run/`) has a one-shot migration to Cloud Run.

### Minimum working deploy (only if you must)
```bash
# Python 3.12 Standard environment
cat > app.yaml <<'EOF'
runtime: python312
instance_class: F2
automatic_scaling:
  min_instances: 0
  max_instances: 10
EOF
gcloud app deploy
```

### Doc URLs
- https://cloud.google.com/appengine/docs/the-appengine-environments
- https://cloud.google.com/appengine/docs/standard/lifecycle/support-schedule
- https://cloud.google.com/appengine/migration-center/run/migrate-app-engine-standard-to-run

---

## 11. Cloud Run functions (formerly Cloud Functions Gen 2) — GA

### What it is
**As of 2024-08-22, Cloud Functions (2nd gen) was renamed to Cloud Run functions** and folded under the Cloud Run umbrella. It is **the same product** as Cloud Run services, just with a function-shaped deployment surface and an event-trigger DX.

Cloud Functions **(1st gen)** still exists, was renamed to **Cloud Run functions (1st gen)**, and is **not deprecated** — but it does not get the gen-2 feature set (Direct VPC egress, GPUs, sidecars, traffic splitting, MCP server, etc.).

### When to use for AI agents
- Event-triggered glue: Pub/Sub → small Python function → write to Firestore.
- Eventarc / Firestore / GCS notification handlers where you want zero scaffolding.
- The "one function per tool" pattern for agent tools — each tool call hits a tiny HTTP function.
- For anything beyond glue, prefer a Cloud Run **service** (same platform, more knobs).

### Latest features 2026
- Inherits **all** 2026 Cloud Run service features: GPU, Direct VPC egress, sidecars, ephemeral disk, MCP server, SSH (Preview).
- `functions.config` API deprecated, decommission **March 2027**. Migrate to env vars / Secret Manager now.

### Minimum working deploy
```bash
# Function-shape deployment, runs on Cloud Run under the hood.
gcloud beta run deploy on-new-tiktok-account \
  --source=. \
  --function=on_event \
  --base-image=python313 \
  --region=us-central1 \
  --trigger-event-filters=type=google.cloud.firestore.document.v1.created \
  --trigger-event-filters=database=(default) \
  --trigger-event-filters-path-pattern=document=accounts_tiktok/{id}
```

### Doc URLs
- https://cloud.google.com/functions/docs/release-notes
- https://cloud.google.com/run/docs/functions/comparison
- https://cloud.google.com/blog/products/serverless/google-cloud-functions-is-now-cloud-run-functions

---

## 12. Cloud Workflows — GA, durable execution for agents

### What it is
Serverless orchestrator. Steps are HTTP calls + control flow expressed as YAML/JSON. State persists between steps; executions can **wait up to a year** via callbacks; built-in retry, parallel branches, error handling. No infrastructure to run.

### When to use for AI agents
- Deterministic, reviewable agent flows — when the business needs an audit trail of "what step happened when."
- Human-in-the-loop: emit a callback URL, page a human, resume on click.
- Long-running orchestration: schedule → call LLM → wait days for a webhook → resume.
- **Glue across managed services** where Inngest / Temporal would be overkill or operationally heavy.
- Alongside agent frameworks for the "outer loop" — the agent reasons inside one Workflows step.

### Latest features 2026
- **Callbacks GA** (`events.create_callback_endpoint`, `events.await_callback`) — documentation last updated 2026-05-15.
- Tight Eventarc Advanced integration (next section).
- Featured in Next ’26 alongside the **Gemini Enterprise Agent Platform** as the durable substrate for compliance-critical agent paths.

### Minimum working deploy
```yaml
# workflow.yaml — wait for a human approval before running the agent.
main:
  steps:
    - create_callback:
        call: events.create_callback_endpoint
        args: { http_callback_method: "POST" }
        result: cb
    - notify_human:
        call: http.post
        args:
          url: https://slack.example/notify
          body: { url: ${cb.url} }
    - await:
        call: events.await_callback
        args: { callback: ${cb}, timeout: 86400 }
        result: approval
    - run_agent:
        call: http.post
        args:
          url: https://agent-control-xxx-uc.a.run.app/run
          auth: { type: OIDC }
          body: ${approval.received_payload}
```
```bash
gcloud workflows deploy human-in-the-loop \
  --source=workflow.yaml \
  --location=us-central1 \
  --service-account=workflows@PROJECT.iam.gserviceaccount.com
```

### Best practices
- **Workflows is not an agent framework** — keep autonomous reasoning inside Cloud Run / GKE agents; let Workflows handle the deterministic envelope.
- **Idempotent step calls** — Workflows retries steps on transient failures.
- **One-year max wait** — for genuinely longer processes, persist external state and re-trigger.
- **Authenticate steps with OIDC** to Cloud Run targets, not API keys.
- **Compare with Inngest / Temporal**: Workflows is serverless and Google-native; Inngest gives you richer fan-out / signal primitives in TypeScript; Temporal gives you in-process determinism with stronger SDK ergonomics. For social-seeding-v2, which already runs Inngest, Workflows is the right tool only for the "long human pause" or "year-long compliance trail" cases that Inngest signals don't model cleanly.

### Doc URLs
- https://cloud.google.com/workflows/docs/overview
- https://cloud.google.com/workflows/docs/creating-callback-endpoints
- https://cloud.google.com/workflows/docs/tutorials/create-wait-for-events-callbacks
- https://cloud.google.com/workflows/docs/best-practice

---

## 13. Eventarc + Eventarc Advanced — GA event mesh for agents

### What it is
- **Eventarc (standard)**: managed triggers from 130+ Google sources (GCS, Pub/Sub, Firestore, audit logs, …) → Cloud Run / Workflows / Functions. CloudEvents on the wire.
- **Eventarc Advanced** (**GA Aug 2025**): a centrally-governed event **bus** (governance, IAM, VPC-SC, CEL filtering) plus per-team **pipelines** that fan out to destinations. Built for org-wide event meshes where many teams produce/consume events.

### When to use for AI agents
- **Standard Eventarc**: "trigger this Cloud Run service whenever a new TikTok account doc lands in Firestore" — the 80 % case.
- **Eventarc Advanced**: an event backbone for an agentic platform — many agent teams subscribing to many event sources, with central audit/governance and content-based access control. Google explicitly markets Advanced as the substrate for "GenAI agents and real-time analytics."

### Latest features 2026
- Advanced GA since 2025-08; documentation maintained through 2026.
- Bus + pipeline + enrollment model is stable.
- Native integration with Cloud Run jobs as destinations.

### Minimum working deploy (Advanced)
```bash
# 1. Central bus
gcloud eventarc message-buses create agents-bus \
  --location=us-central1

# 2. Pipeline that lands events on a Cloud Run agent
gcloud eventarc pipelines create on-new-account \
  --location=us-central1 \
  --destinations=http_endpoint_uri='https://agent-control-xxx-uc.a.run.app/event',google_oidc_authentication_service_account=eventarc@PROJECT.iam.gserviceaccount.com

# 3. Enrollment with a CEL filter routing only "created" events for tiktok accounts
gcloud eventarc enrollments create tiktok-created \
  --location=us-central1 \
  --message-bus=agents-bus \
  --destination-pipeline=on-new-account \
  --cel-match='message.type == "google.cloud.firestore.document.v1.created" && message.subject.contains("accounts_tiktok/")'
```

### Best practices
- **Standard for one trigger, Advanced for a platform**. Don't introduce Advanced until you have multiple teams or multiple-destination fan-out — the bus/pipeline/enrollment model is overkill for one workload.
- **CEL filters at the enrollment** keep noisy events off your agent's plate.
- **Service accounts per pipeline**, not per app — that's how IAP / VPC-SC enforces the governance layer.
- **For Pub/Sub**: prefer **direct Pub/Sub triggers to Cloud Run** for the simplest case; Eventarc Advanced only when you also want central audit.

### Doc URLs
- https://cloud.google.com/eventarc/docs/overview
- https://cloud.google.com/eventarc/advanced/docs/overview
- https://cloud.google.com/eventarc/advanced/docs/publish-events/create-bus
- https://cloud.google.com/blog/products/application-modernization/getting-to-know-eventarc-advanced

---

## Decision tree — "which compute do I pick for my agent?"

```
┌─────────────────────────────────────────────────────────────────────┐
│ Q1: Is the agent triggered by an HTTP request OR finite event?      │
├─────────────────────────────────────────────────────────────────────┤
│   YES → does it complete inside ~60 min and need scale-to-zero?     │
│         YES → does it need a GPU?                                   │
│               YES (model < ~9B) → Cloud Run service + L4 GPU        │
│               YES (model 9B–70B) → Cloud Run service + RTX PRO 6000 │
│                                                                     │
│               NO          → Cloud Run service (CPU-only)            │
│         NO (>60 min / batch) → does it have many independent tasks? │
│               YES → Cloud Run Jobs (parallelism + retry)            │
│               NO  → Workflows (durable, callbacks) → Cloud Run      │
│                                                                     │
│   NO  → see Q2                                                      │
└─────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│ Q2: Is the agent a long-running loop (consumes a queue, holds state)?│
├─────────────────────────────────────────────────────────────────────┤
│   YES → fleet of N workers? → Cloud Run Worker Pools (+ CREMA)      │
│         single dedicated agent w/ URL → Cloud Run Instances (Preview)│
│         needs sandbox for LLM-generated code →                      │
│             GKE Autopilot + Agent Sandbox (Preview)                 │
│                                                                     │
│   NO  → see Q3                                                      │
└─────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│ Q3: Self-hosting a model?                                           │
├─────────────────────────────────────────────────────────────────────┤
│   < 30B params, can fit on one L4/H100 → Cloud Run GPU service      │
│   30B–200B, vLLM/SGLang, needs persistent KV cache →                │
│       Compute Engine A3 Ultra (H200) or A4 (B200), behind a LB      │
│   Training/fine-tuning multi-node →                                 │
│       AI Hypercomputer on A4 / A4X / A4X Max OR GKE Standard +      │
│       A4 node pool + DRANET                                         │
│                                                                     │
│ Q4: Need Kubernetes semantics (CRDs, StatefulSets, sidecars beyond  │
│     2 containers)?                                                  │
│   YES + want low ops      → GKE Autopilot                           │
│   YES + need node control → GKE Standard                            │
│                                                                     │
│ Q5: Pure event glue (Pub/Sub trigger → tiny handler)?               │
│   → Cloud Run functions (event-shaped Cloud Run service)            │
│                                                                     │
│ Q6: Existing on App Engine?                                         │
│   → migrate to Cloud Run via App Engine Migration Center;           │
│     do not start new agents on App Engine.                          │
└─────────────────────────────────────────────────────────────────────┘
```

### One-paragraph synthesis for the social-seeding-v2 stack
Given that v2 already runs **Inngest** as the durable workflow engine and **Vertex / Anthropic** as the LLM layer, the matching GCP compute story is:

- **Mission Control (`apps/web`)** → **Cloud Run service** with `min-instances=1`, instance-based billing, Direct VPC egress, IAP, OTLP sidecar.
- **Workflow runners (Inngest functions)** → another **Cloud Run service** sized for short bursts; if a single agent loop grows into a pull-based long-runner, promote it to a **Cloud Run worker pool** without changing language.
- **Batch evals / nightly recomputes** → **Cloud Run Jobs** with parallelism = 10–20.
- **Self-hosted Llama / Qwen for cost-tuned inference** (only if Anthropic pricing forces it) → **Compute Engine A3 Ultra** running vLLM, behind an internal load balancer, called from the Cloud Run agents.
- **Per-customer long-running agent sandboxes** (future) → **Cloud Run Instances** (when GA) or **GKE Autopilot + Agent Sandbox**.
- **Cross-service event routing** → keep using Inngest events internally; introduce **Eventarc Advanced** only if a second product team needs to consume the same event stream.

---

## Appendix — services explicitly checked for deprecation (May 2026)

| Service | Status | Notes |
|---|---|---|
| Cloud Run services | **GA, recommended** | Next ’26 features rolling out |
| Cloud Run Jobs | **GA, recommended** | GPU jobs now GA |
| Cloud Run Worker Pools | **GA since 2026-04-14** | New primary home for long-running agents |
| Cloud Run Instances | **Preview (2026-04)** | Watch for GA |
| Cloud Run functions | **GA, recommended** | (formerly Cloud Functions Gen 2) |
| Cloud Functions Gen 1 | **GA, not deprecated** | Renamed to "Cloud Run functions (1st gen)"; missing gen-2 features |
| GKE Standard | **GA, recommended** for control-heavy workloads | |
| GKE Autopilot | **GA, recommended default** | |
| GKE Agent Sandbox | **Preview** (req. GKE ≥ 1.35.2-gke.1269000) | |
| Compute Engine (A2 → A4X Max) | **GA** | A4X Max in us-central1-a only |
| TPU v6e (Trillium) | **GA** | |
| TPU v7x (Ironwood) | **Limited availability** | Not yet full GA as of May 2026 |
| App Engine Standard (gen 2) | **GA but not recommended for new builds** | Google recommends Cloud Run instead |
| App Engine Standard (gen 1) | **Deprecated 2026-01-31** | Python 2.7, Java 8, Go 1.11, PHP 5.5 |
| App Engine Flex | **GA but not recommended for new builds** | |
| Workflows | **GA, recommended** | Callbacks GA, 1-year max wait |
| Eventarc (standard) | **GA, recommended** | |
| Eventarc Advanced | **GA since 2025-08** | |

---

## Sources

- [Cloud Run release notes](https://cloud.google.com/run/docs/release-notes)
- [What's new for Cloud Run at Next '26 (Google Cloud Blog, 2026-04-23)](https://cloud.google.com/blog/products/serverless/whats-new-for-cloud-run-at-next26)
- [Cloud Run autoscaling](https://cloud.google.com/run/docs/about-instance-autoscaling)
- [Cloud Run billing settings](https://cloud.google.com/run/docs/configuring/billing-settings)
- [Cloud Run GPU support](https://cloud.google.com/run/docs/configuring/services/gpu)
- [Cloud Run Direct VPC egress](https://cloud.google.com/run/docs/configuring/vpc-direct-vpc)
- [Cloud Run Jobs — create](https://cloud.google.com/run/docs/create-jobs)
- [Cloud Run Jobs — parallelism](https://cloud.google.com/run/docs/configuring/parallelism)
- [Cloud Run Jobs — retries](https://cloud.google.com/run/docs/jobs-retries)
- [Cloud Run Worker Pools — deploy](https://cloud.google.com/run/docs/deploy-worker-pools)
- [Cloud Run Worker Pools at Estee Lauder (Google Cloud Blog)](https://cloud.google.com/blog/products/serverless/cloud-run-worker-pools-at-estee-lauder-companies)
- [Cloud Run Functions release notes](https://cloud.google.com/functions/docs/release-notes)
- [Google Cloud Functions is now Cloud Run functions (Blog, 2024-08-22)](https://cloud.google.com/blog/products/serverless/google-cloud-functions-is-now-cloud-run-functions)
- [GKE release notes](https://cloud.google.com/kubernetes-engine/docs/release-notes-new-features)
- [GKE Autopilot overview](https://cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview)
- [GKE Autopilot burstable workloads (Blog)](https://cloud.google.com/blog/products/containers-kubernetes/introducing-gke-autopilot-burstable-workloads/)
- [GKE Autopilot vs Standard feature comparison](https://cloud.google.com/kubernetes-engine/docs/resources/autopilot-standard-feature-comparison)
- [GKE Agent Sandbox](https://cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox)
- [GKE Autopilot GPU workloads](https://cloud.google.com/kubernetes-engine/docs/how-to/autopilot-gpus)
- [GKE Standard — regional cluster creation](https://cloud.google.com/kubernetes-engine/docs/how-to/creating-a-regional-cluster)
- [Compute Engine release notes](https://cloud.google.com/compute/docs/release-notes)
- [Compute Engine accelerator-optimized machines](https://cloud.google.com/compute/docs/accelerator-optimized-machines)
- [Compute Engine GPU machine types](https://cloud.google.com/compute/docs/gpus)
- [Introducing A4 VMs powered by NVIDIA B200 (Blog)](https://cloud.google.com/blog/products/compute/introducing-a4-vms-powered-by-nvidia-b200-gpu-aka-blackwell)
- [A3 Ultra with NVIDIA H200 GPUs GA (Blog)](https://cloud.google.com/blog/products/compute/a3-ultra-with-nvidia-h200-gpus-are-ga-on-ai-hypercomputer)
- [AI Hypercomputer at Next '26 (Blog)](https://cloud.google.com/blog/products/compute/whats-new-with-google-clouds-ai-hypercomputer-architecture)
- [Trillium TPU GA (Blog)](https://cloud.google.com/blog/products/compute/trillium-tpu-is-ga)
- [App Engine environments overview](https://cloud.google.com/appengine/docs/the-appengine-environments)
- [App Engine runtime support schedule](https://cloud.google.com/appengine/docs/standard/lifecycle/support-schedule)
- [App Engine to Cloud Run migration](https://cloud.google.com/appengine/migration-center/run/migrate-app-engine-standard-to-run)
- [Workflows overview](https://cloud.google.com/workflows/docs/overview)
- [Workflows callbacks](https://cloud.google.com/workflows/docs/creating-callback-endpoints)
- [Workflows callbacks + Eventarc tutorial](https://cloud.google.com/workflows/docs/tutorials/create-wait-for-events-callbacks)
- [Eventarc overview](https://cloud.google.com/eventarc/docs/overview)
- [Eventarc Advanced overview](https://cloud.google.com/eventarc/advanced/docs/overview)
- [Eventarc Advanced — create a bus](https://cloud.google.com/eventarc/advanced/docs/publish-events/create-bus)
- [Getting to know Eventarc Advanced (Blog)](https://cloud.google.com/blog/products/application-modernization/getting-to-know-eventarc-advanced)
- [OpenTelemetry Collector sidecar on Cloud Run](https://cloud.google.com/stackdriver/docs/instrumentation/opentelemetry-collector-cloud-run)
- [Managed Prometheus sidecar on Cloud Run](https://cloud.google.com/stackdriver/docs/managed-prometheus/cloudrun-sidecar)
