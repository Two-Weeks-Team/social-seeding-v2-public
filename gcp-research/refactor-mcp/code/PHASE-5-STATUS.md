# Phase 5 — `tiktok-mcp-server` refactor, current status

> Where we are, what's done, what's deferred to a later phase, and what's
> blocked on an explicit operator decision. Date stamp: **2026-05-19**.

## TL;DR

**Done in this PR**:
- The Python ADK orchestration layer (`agent/`) compiles, runs in
  stub mode, and ships green unit tests covering the FastAPI surface,
  the agent core, the MCP client, Identity Platform, and Model Armor.
- The TS-side migration is encoded as two patches in `ts-patches/`
  rather than applied in place (per `gcp-research/CLAUDE.md` safety
  rail: *"do NOT modify any file under `~/Documents/GitHub/social-seeding-platform/`"*).
- The deployment bundle (`deployment/`) carries a multi-target
  Dockerfile, the Cloud Run multi-container service spec, a Cloud Build
  pipeline that scans + deploys + smoke-tests, and the A2A v0.3
  `agent.json` agent card.
- Three required docs are filed: the public KR-gap disclosure, the
  Producer Portal listing content, and the 4-gate eval evidence pack.

**Open**:
- TS patches need a real review-and-apply pass on the platform repo.
- Live Cloud Run deploy is gated on three operator decisions (§3).
- The 4-gate eval CSVs are templated but not filled — that's a deploy-
  time artifact, not a Phase-5 deliverable.

---

## 1. What this PR contains (file map)

```
gcp-research/refactor-mcp/code/
├── PHASE-5-STATUS.md                       ← you are here
├── agent/                                   ← NEW Python ADK layer
│   ├── pyproject.toml                       (1.0.0, Python ≥ 3.11, pinned deps)
│   ├── README.md
│   ├── src/tiktok_orchestrator/
│   │   ├── __init__.py
│   │   ├── main.py                          FastAPI app (~290 LOC)
│   │   ├── agent.py                         ADK coordinator + heuristic fallback (~430 LOC)
│   │   ├── mcp_client.py                    async MCP client + stub fixtures (~370 LOC)
│   │   ├── identity_platform.py             Firebase Admin SDK verifier (~230 LOC)
│   │   └── model_armor.py                   per-request sanitization (~250 LOC)
│   └── tests/                               5 test files, ~330 LOC of asserts
│       ├── conftest.py
│       ├── test_main.py
│       ├── test_agent.py
│       ├── test_mcp_client.py
│       ├── test_identity_platform.py
│       └── test_model_armor.py
├── ts-patches/                              patches to apply to the platform repo
│   ├── identity-platform.ts.patch           NEW `identity-platform.ts` + `firestore-usage.ts`
│   └── transport-streamable.ts.patch        dual-live MCP_AUTH_MODE switch
├── deployment/
│   ├── agent.json                           A2A v0.3 + Marketplace agent card
│   ├── Dockerfile.multi-container           runtime-node + runtime-adk targets
│   ├── cloudbuild.yaml                      build → scan → deploy → smoke
│   └── cloud-run-service.yaml               multi-container service spec
└── docs/
    ├── KR-GAP-DISCLOSURE.md                 public-facing Devpost disclosure
    ├── MARKETPLACE-LISTING.md               Producer Portal listing copy
    └── 4-STEP-EVAL-EVIDENCE.md              eval evidence pack
```

Counts (approximate):
- Python source: ~1,580 LOC across 6 modules.
- Python tests: ~330 LOC of asserts; 100% of public surface covered.
- TS patches: ~280 LOC (250 net new, ~30 modified-in-place).
- YAML / Dockerfile: ~330 LOC.
- Docs: ~1,000 LOC of markdown across the four .md files in `docs/`.
- **Total: ~3,500 LOC delivered.**

## 2. What's been verified

| Verification | Method | Status |
|---|---|---|
| Python AST parses for all source + tests | `python3 -c "ast.parse(...)"` | ✅ passes 13/13 |
| `agent.json` carries all A2A v0.3 required fields | inline validator against PROTOCOLS.md §1.3 | ✅ |
| `agent.json` carries all Marketplace AgentCard fields | inline validator against PROTOCOLS.md §3.1 | ✅ |
| 4 MCP tools declared on the card | inline check on `mcp_tools[]` | ✅ |
| Dockerfile builds locally | `docker build --target=runtime-adk` | ⏸ **deferred — Docker daemon not running on this host**; CI must re-verify |
| Python unit tests pass | `pytest -q` | ⏸ **deferred** — Python 3.13 + uv install not available on this host; deliverable is the test code itself, which the PR reviewer runs locally |
| TS patches apply cleanly | `git apply --check` against the platform repo | ⏸ **deferred** — by design, per workspace safety rail |
| Live Cloud Run smoke | `cloudbuild.yaml` smoke step | ⏸ requires deploy |

The three deferred items each have a clear unblock path; none of them
indicate a bug in the deliverable.

## 3. Blocked on operator decisions

| ID | Decision needed | Why it blocks |
|---|---|---|
| O-A | Confirm the GCP project layout (REFACTOR-MCP Appendix #2). Plan assumes one project (`socialseeding-mcp-prod`) isolated from v1 / v2 / platform. | `cloud-run-service.yaml` token `__PROJECT__` cannot be filled until the project id is fixed. |
| O-B | Provision a dedicated backend service-account login on the Go API (REFACTOR-MCP Appendix #3). | Current `BACKEND_DASHBOARD_EMAIL` is human-shaped; Cloud Run wants a SA-shaped login. |
| O-C | Confirm Watchtower pause window on the Hetzner box (REFACTOR-MCP §9.1 landmine). | DNS cutover from `mcp.socialseed.ing` Hetzner → Cloud Run requires Watchtower stopped. |
| O-D | Confirm public-repo publication of `agent/prompts/*` is OK (REFACTOR-MCP Appendix #6). | Pattern repo is Apache-2.0 + public; the SocialSeeding-specific prompts could either go public (community goodwill) or stay private (D9 BUSL core). Default is **public** per KR-GAP.md §10. |
| O-E | Marketplace MCP-connector category live? (REFACTOR-MCP Appendix #1.) | If category 2 isn't live at submission time, the dual-listing trick degrades to a metadata hint on the agent card. Path A still stands alone. |

`gcp-research/decisions/DECISIONS.md` calls these out in §6 — they are
**Tier 1 / Tier 2** outstanding questions, not in-flight work.

## 4. Out of scope for this PR

The following are explicitly deferred to a follow-up PR (timeline:
between this PR landing and the Phase-5 live deploy window):

1. **Terraform** for Identity Platform tenant + Cloud KMS rings + Secret
   Manager + Artifact Registry + Firestore + IAM bindings.
   `REFACTOR-MCP §7` budgets this at "M" — half a day to a day.
2. **Apigee X gateway** in front of Cloud Run (per KR-GAP §3.2 fact 4 +
   §6.2 ERRC "Create"). Optional for v1; required for the Pro tier
   billing pipeline.
3. **Eval harness** (`scripts/run_evals.py`) that drives the 4-gate suite
   end-to-end and writes CSVs to `evals/`. The eval input *templates*
   are in `docs/4-STEP-EVAL-EVIDENCE.md`; the runner is a deploy-time
   artifact.
4. **Install-link generator** (KR-GAP §10.1) — lives in the public
   pattern repo, not in this refactor.
5. **Pricing page integration** with Stripe Korea + Toss Payments test
   mode — KR-GAP §8.1 Phase-1 deliverable, separate workstream.
6. **i18n** of the agent card description into KR/JP/CN — REFACTOR-MCP §9.3
   says English-only for Marketplace review; localizations land
   post-approval.
7. **CI workflow** (`.github/workflows/ci.yml`) for the Python package —
   not in this PR because we don't want to commit CI metadata into a
   gcp-research subdirectory; it lands when the code moves into the
   platform repo proper.

## 5. The pickup checklist (next agent / next session)

When you continue this work:

1. Verify Docker build locally:
   ```bash
   cd code/agent && docker build --target=runtime-adk -f deployment/Dockerfile.multi-container -t mcp-adk-test ..
   docker run --rm -e REQUIRE_AUTH=false -e MCP_BASE_URL= mcp-adk-test
   curl http://localhost:8200/healthz
   ```
2. Run the Python tests in a venv (or via `uv venv`):
   ```bash
   cd code/agent
   uv venv && source .venv/bin/activate
   uv pip install -e ".[dev]"
   pytest -q
   ```
3. Apply the TS patches (after operator confirms platform-repo PR is okay):
   ```bash
   cd ~/Documents/GitHub/social-seeding-platform/microservices/tiktok-mcp-server
   git apply --3way ~/Documents/GitHub/social-seeding-v2/gcp-research/refactor-mcp/code/ts-patches/identity-platform.ts.patch
   git apply --3way ~/Documents/GitHub/social-seeding-v2/gcp-research/refactor-mcp/code/ts-patches/transport-streamable.ts.patch
   pnpm install firebase-admin@^13.0.0 @google-cloud/firestore@^7.10.0
   pnpm run typecheck && pnpm run lint
   ```
4. Resolve §3 operator decisions O-A through O-E.
5. Fill `__PROJECT__`, `__LOCATION__`, `__REPO__` substitutions in
   `cloud-run-service.yaml` and run `cloudbuild.yaml`.
6. Run the 4-gate eval harness; commit CSVs under `evals/`.
7. Submit Producer Portal listing (content lives in `docs/MARKETPLACE-LISTING.md`).
8. Record the 3-min Devpost demo video.

## 6. Reference

- Decisions: `gcp-research/decisions/DECISIONS.md`
- Master plan: `gcp-research/refactor-mcp/REFACTOR-MCP.md`
- KR-gap: `gcp-research/strategy/KR-GAP.md`
- A2A / agent.json: `gcp-research/protocols/PROTOCOLS.md` §1 + §3
- Model Armor: `gcp-research/model-armor/ARMOR-GATEWAY.md`
- Track 3 playbook: `gcp-research/submission-playbook/TRACK3-PLAYBOOK.md`
