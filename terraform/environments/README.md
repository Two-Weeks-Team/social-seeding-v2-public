# terraform/environments — per-env root configs (D44)

Each `<env>/` here is a Terraform root that calls every shared module under
`../../modules/` with environment-specific variables. **Modules are never
applied directly.** Decision anchor: **D44** (root config lives in
`environments/<env>/`, not in module dirs).

## Layout

```
terraform/
├── modules/                  # 8 reusable modules (owned by per-domain authors)
│   ├── ai/  compute/  data/  devops/  integration/  networking/  observability/  security/
└── environments/
    ├── dev/                  # single-region us-central1; cost-tuned; no CMEK on Vector Search
    │   ├── backend.tf        # GCS state bucket: ss-v2-tf-state-dev
    │   ├── providers.tf      # google + google-beta pinned ~> 6.20
    │   ├── variables.tf      # operator inputs (project ids, org, IAP support email)
    │   ├── terraform.tfvars.example
    │   └── main.tf           # `module "compute" { source = "../../modules/compute" ... }` × 8
    ├── prod/                 # 3-region active-active (D13: us-central1 + europe-west4 + asia-northeast3); CMEK ON; D31 SLO
    │   └── … (same shape as dev/)
    └── README.md             # this file
```

## Bootstrap (chicken-and-egg)

Terraform cannot create its own state bucket. The bucket names referenced in
each `backend.tf` (`ss-v2-tf-state-dev`, `ss-v2-tf-state-prod`) MUST be
pre-created — operator runs `_scripts/day-1-setup.sh` (W5) **once per env**:

```bash
# Per env, one-time bootstrap:
./_scripts/day-1-setup.sh \
  --project ss-v2-dev-us \
  --env dev \
  --tf-state-bucket ss-v2-tf-state-dev
```

Day-1-setup also enables the GCP APIs Terraform itself needs (storage, iam,
cloudresourcemanager, serviceusage) so the very first `terraform init` does
not fail on a missing API.

## Plan & apply cycle

```bash
cd terraform/environments/dev               # or prod
cp terraform.tfvars.example terraform.tfvars  # then edit
terraform init                              # downloads providers + reads remote state
terraform plan -out=tfplan                  # ALWAYS plan before apply
terraform apply tfplan                      # operator-gated
```

**Production gating** (D44 + G2 dual approval): never `terraform apply` in
`prod/` without a reviewed plan artifact and a second operator's eyes. CI
publishes the plan as a PR comment; humans approve via the G2 gate before the
apply job is allowed to run.

## Dev → prod promotion flow

1. Land changes in `terraform/modules/<name>/` (owned by domain authors).
2. Update `dev/main.tf` if the module exposes a new variable; `terraform plan`
   in `dev/` and confirm diff matches intent.
3. `terraform apply` in `dev/`. Run smoke tests against the dev project.
4. Mirror the same call shape into `prod/main.tf` (often with different
   feature flags / capacity / CMEK toggles).
5. `terraform plan` in `prod/`; open a PR with the plan output attached.
6. After G2 dual approval, run `terraform apply tfplan` in `prod/`.

## Why not workspaces?

Terraform workspaces share a single state file with a prefix. D44 explicitly
chose per-env **root configs** so that:

* Backend bucket isolation is enforced (a dev `apply` cannot touch prod state).
* Provider versions can diverge per env during a major upgrade.
* Module call shapes can differ (dev disables `apigee` + `gke_autopilot`; prod
  enables both) without conditional spaghetti in module code.

## Verification

* `terraform fmt -recursive terraform/environments/` — formatter check.
* `terraform init -backend=false && terraform validate` per env — pre-PR gate.
* `terraform plan` against a real (dev) project — full validation.
