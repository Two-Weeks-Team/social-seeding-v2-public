# SPDX-License-Identifier: BUSL-1.1
# Copyright 2026 Social Seeding Inc.
"""deploy_agent.py — agent runtime deploy shim (Wave 3 / Track 3).

`terraform/modules/ai/main.tf` §8 (`null_resource.agent_runtime_deploy`)
invokes this module via `python -m packages.agents.deploy.deploy_agent ...` to
deploy each Tier-1/Tier-2 agent. Until Wave 3 this module did not exist — the
Reasoning-Engine (Vertex AI Agent Engine) path it implies is a Preview API with
no first-class Terraform resource (see terraform/modules/ai/README.md).

Wave 3 makes the wired brand-campaign Cloud Workflow EXECUTABLE by serving the
agents over HTTP on **Cloud Run** (packages/agents-adk/serve.py + Dockerfile)
instead of as Reasoning Engines. That is the canonical, GA, demonstrable path
and is what `scripts/deploy/DEPLOY-RUNBOOK.md` walks through with raw `gcloud`.

This shim therefore does ONE honest thing by default: it resolves the Cloud Run
URL for the already-deployed `ss-agents` service and writes the per-agent
runtime marker that `terraform/modules/ai/outputs.tf` (`reasoning_engine_marker
_prefix`) and the integration module's `agent_urls` consume. It does NOT create
a Reasoning Engine (that Preview path is operator-gated). Run the actual image
build + `gcloud run deploy` from the runbook FIRST; this shim then records where
the agent is reachable.

Modes:
    --mode=cloud-run (default)
        Resolve the `ss-agents` Cloud Run service URL (via `gcloud run services
        describe`) and write gs://<staging>/runtime-markers/<agent>.json =
        {"agent_id","url","transport":"http","mode":"cloud-run"}. Idempotent.
    --mode=print
        Print the marker JSON to stdout and exit 0 — no GCP calls, no ADC
        needed. Used by CI / the runbook dry-run and by the offline unit test.

Exit non-zero only on a genuine failure (missing required arg, gcloud error in
cloud-run mode). Never deploys anything irreversible — the image build and
`gcloud run deploy` are explicit operator steps in the runbook (D-gated).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class AgentMarker:
    """The per-agent runtime marker terraform + the integration module read."""

    agent_id: str
    url: str
    transport: str = "http"
    mode: str = "cloud-run"

    def to_json(self) -> str:
        return json.dumps(
            {
                "agent_id": self.agent_id,
                "url": self.url,
                "transport": self.transport,
                "mode": self.mode,
            },
            indent=2,
            sort_keys=True,
        )


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="deploy_agent",
        description="Record where an ss-agents-adk agent is reachable (Cloud Run).",
    )
    p.add_argument("--agent-id", required=True, help="Stable agent id (e.g. coordinator).")
    p.add_argument("--project", required=True, help="GCP project id (ss-v2-prod).")
    p.add_argument("--region", default="us-central1", help="Cloud Run region.")
    p.add_argument(
        "--service",
        default="ss-agents",
        help="Cloud Run service that hosts serve.py (default: ss-agents).",
    )
    p.add_argument(
        "--staging-bucket",
        default="",
        help="gs:// bucket the runtime marker is written to (cloud-run mode).",
    )
    p.add_argument(
        "--mode",
        choices=["cloud-run", "print"],
        default="cloud-run",
        help="cloud-run: resolve URL + write marker. print: emit marker JSON, no GCP.",
    )
    # Accepted-and-ignored args so the terraform invocation line stays valid.
    p.add_argument("--model", default="")
    p.add_argument("--service-account", default="")
    p.add_argument("--agent-gateway", default="")
    p.add_argument("--enable-agent-identity", action="store_true")
    # The terraform line appends a `${preview_guard_suffix}` (e.g. `|| true`) at
    # the shell level, not as an argv token, so nothing extra to parse here.
    return p.parse_args(argv)


def _resolve_service_url(*, project: str, region: str, service: str) -> str:
    """Return the Cloud Run service URL via `gcloud run services describe`.

    Raises CalledProcessError when gcloud fails (service not deployed yet, or no
    ADC) — the caller (terraform/operator) should run the runbook's
    `gcloud run deploy ss-agents` step first.
    """
    out = subprocess.run(
        [
            "gcloud",
            "run",
            "services",
            "describe",
            service,
            "--project",
            project,
            "--region",
            region,
            "--format",
            "value(status.url)",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    url = out.stdout.strip()
    if not url:
        raise RuntimeError(
            f"Cloud Run service {service!r} has no URL — deploy it first "
            "(see scripts/deploy/DEPLOY-RUNBOOK.md)."
        )
    # Each agent is one route on the shared service: <service-url>/<agent-id>.
    return url


def _write_marker(marker: AgentMarker, *, staging_bucket: str) -> None:
    """Write the marker JSON to gs://<staging>/runtime-markers/<agent>.json."""
    if not staging_bucket:
        raise RuntimeError("--staging-bucket is required in cloud-run mode.")
    dest = f"{staging_bucket.rstrip('/')}/runtime-markers/{marker.agent_id}.json"
    subprocess.run(
        ["gcloud", "storage", "cp", "-", dest],
        check=True,
        input=marker.to_json(),
        text=True,
    )
    print(f"wrote marker → {dest}")


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(list(sys.argv[1:] if argv is None else argv))

    if args.mode == "print":
        # Offline: the per-agent URL is <service-url>/<agent-id>. In print mode
        # we don't know the live service URL, so emit a placeholder the operator
        # / test can recognize. This path makes NO gcloud calls.
        marker = AgentMarker(
            agent_id=args.agent_id,
            url=f"https://{args.service}-<hash>-{args.region}.run.app/{args.agent_id}",
        )
        print(marker.to_json())
        return 0

    # cloud-run mode: resolve the live service URL + write the marker.
    service_url = _resolve_service_url(
        project=args.project, region=args.region, service=args.service
    )
    marker = AgentMarker(
        agent_id=args.agent_id,
        url=f"{service_url.rstrip('/')}/{args.agent_id}",
    )
    _write_marker(marker, staging_bucket=args.staging_bucket)
    return 0


if __name__ == "__main__":  # pragma: no cover — invoked via `python -m`
    raise SystemExit(main())
