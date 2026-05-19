# litmus-experiments/ — Kubernetes-native chaos CRs

> Cites: D37 (chaos as TDD layer), chaos/SCENARIOS.md §4.1 (Litmus on GKE Autopilot).
> Open issue: MATRIX §11 T6 + chaos/SCENARIOS.md §9 C2 — Autopilot privileged
> container restriction; fall back to GKE Standard pool for the chaos-only nodepool.

LitmusChaos CRs (`ChaosEngine`, `ChaosExperiment`, `ChaosResult`) for the
GKE-hosted Agent Sandbox. Applied via `kubectl apply -f <file>` from the
`chaos-system` namespace by the chaos service account.

The orchestrator.py `executor: litmus` driver reads these manifests at runtime.
