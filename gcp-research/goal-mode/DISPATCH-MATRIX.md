# DISPATCH-MATRIX.md — Task → Subagent Routing for /goal

> **Purpose**: Decision table for "given task X, which `subagent_type` do I dispatch with what prompt template?". The autonomous `/goal` runner consults this table before every Agent dispatch.
>
> **Last updated**: 2026-05-19

---

## 1. Task type → subagent_type mapping

| Task type | Primary subagent_type | Fallback | Why |
|---|---|---|---|
| Python ADK agent code | `python-expert` | `backend-architect` | Pydantic + ADK + Vertex AI fluency |
| TS/TSX Mission Control code | `frontend-architect` | `general-purpose` | Next.js 16 + shadcn + Tailwind v4 |
| Terraform module | `devops-architect` | `backend-architect` | google + google-beta providers |
| Bash / gcloud pipelines | `devops-architect` | `general-purpose` | shell + CI patterns |
| Security regex / Model Armor / Identity Platform | `security-engineer` | `python-expert` | OWASP + SIEM patterns |
| Test harness / chaos / evals | `quality-engineer` | `python-expert` | pytest + Hypothesis + Litmus |
| Architectural decision write-up | `technical-writer` | `system-architect` | Markdown clarity + D-ID hygiene |
| Devpost / business write-up | `technical-writer` | `business-panel-experts` | Tight prose for judges |
| Demo video / ffmpeg / OBS | `technical-writer` | `devops-architect` | Tooling-heavy but doc-shaped |
| Latest spec lookup (cloud.google.com) | `deep-research-agent` | `general-purpose` | Aggressive WebSearch + cite verification |
| Cross-cutting refactor across multiple files | `refactoring-expert` | `general-purpose` | DRY/KISS focus |
| Root-cause of failing test | `root-cause-analyst` | `quality-engineer` | Hypothesis-driven debug |
| End-to-end smoke / live demo | `quality-engineer` + `python-expert` pair | — | Coverage + impl together |
| Multi-day strategic plan revision | `business-panel-experts` (panel mode) | — | 5-expert panel for high-stakes |

---

## 2. Prompt templates (copy-paste-ready)

### Template A — Python ADK agent (most common)

```
You are [P-X agent #N] working on [task name]. Self-contained brief.

**Mandatory inputs** (read in this order):
1. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/DECISIONS.md
2. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/ARCHITECTURE.md (§3 if agent-specific)
3. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/specs/tier{1,2,3}/<agent>.spec.md
4. /Users/kimsejun/Documents/GitHub/social-seeding-v2/packages/agents-adk/src/ss_agents/agents/intake.py (reference pattern)
5. /Users/kimsejun/Documents/GitHub/social-seeding-v2/packages/agents-adk/BUILD-NOTES.md (esp. BN-9 tripwire)

**Deliverable**: [3 files at exact paths]

**Spec**: [model, USD cap, escalation, eval criteria]

**Conventions**:
- Mirror intake.py style exactly (Pydantic v2, locale suffix, __main__ CLI)
- Korean injection text uses particle-free form per BN-9 tripwire
- Cite D-IDs in module docstring
- Update __init__.py re-exports

Save 3 files via Write tool. Aim N-M Python + K-L test. Run mental pytest; flag failures in BUILD-NOTES.md.
```

### Template B — Terraform module

```
You are TF-Module-N ([category]). Self-contained brief.

**Inputs**:
1. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/DECISIONS.md
2. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/SERVICE-INVENTORY.md §K
3. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/ARCHITECTURE.md §M
4. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/<category>/<spec>.md

**Deliverable**: terraform/modules/<category>/{main.tf, variables.tf, outputs.tf, versions.tf, README.md, examples/basic/}

**Resources to provision**: [list with D-ID anchors]

**Latest-spec adherence**: Use Context7 (mcp__plugin_context7_context7__resolve-library-id + query-docs) to look up the current `hashicorp/google` and `hashicorp/google-beta` provider docs. If a resource is Preview-only, use null_resource + local-exec gcloud fallback and comment the migration path.

**Conventions**:
- for_each = toset(var.regions) for multi-region
- labels = { managed_by = "terraform-<category>", d_id = "D13_..." }
- Comprehensive outputs.tf
- README cites D-IDs + assumptions

Save 5+ files via Write tool. Aim 400-800 HCL lines. Cite D-IDs throughout.
```

### Template C — Test/chaos/eval harness

```
You are Phase-7 / W4 / smoke-test agent. Self-contained brief.

**Inputs**:
1. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/DECISIONS.md (D37 5-layer)
2. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/tests/MATRIX.md
3. /Users/kimsejun/Documents/GitHub/social-seeding-v2/test-harness/ (existing — extend, don't duplicate)

**Deliverable**: [exact paths + contents]

**Conventions**:
- pytest fixtures via conftest.py reuse
- Hypothesis profile per CI cadence
- All chaos scenarios runnable in dry-run mode without GCP creds
- Cite D-IDs in test file headers

Save files via Write tool. Verify with `uv run --extra dev pytest <files> -v`.
```

### Template D — Capability layer / FunctionTool wire

```
You are W2 capability-wire agent for [tool_name]. Self-contained brief.

**Inputs**:
1. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/DECISIONS.md (D41 capability mode)
2. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/specs/tier1/<agent>.spec.md (tool contract)
3. /Users/kimsejun/Documents/GitHub/social-seeding-v2/packages/agents-adk/src/ss_agents/agents/<agent>.py (where the tool plugs in)

**Deliverable**:
- packages/agents-adk/src/ss_agents/tools/<tool_name>.py (ADK FunctionTool + stub + live SDK call gated by env)
- packages/agents-adk/tests/tools/test_<tool_name>.py (stub mode + live mode mocked)
- Update <agent>.py to add the tool to tools=[]
- Update __init__.py exports

**Conventions**:
- FunctionTool signature: `def tool_fn(input: PydanticInputModel) -> PydanticOutputModel`
- Stub mode returns deterministic canned data
- Live mode: env CAPABILITY_LAYER_MODE=live, real SDK call
- Tool exposes its USD cost via attribute for cost_watch

Save files. Aim 200-350 lines per tool + 200-350 lines test.
```

### Template E — Documentation (technical-writer)

```
You are documentation agent for [doc_name]. Self-contained brief.

**Inputs**:
1. /Users/kimsejun/Documents/GitHub/social-seeding-v2/gcp-research/decisions/DECISIONS.md
2. [relevant source docs]
3. [target audience: judges / engineers / operators]

**Deliverable**: [exact path]

**Conventions**:
- Cite D-IDs inline
- No marketing language (per RULES.md §Professional Honesty)
- Mermaid diagrams over ASCII
- Table-heavy for matrix-shaped content

Save via Write tool. Aim N-M words.
```

---

## 3. Parallelism playbook

### When to dispatch in parallel (single message, multiple Agent calls)

- ✅ 16 capability tools (W2) — each tool is independent
- ✅ 5 Terraform modules across different categories (compute / data / networking ≠ each other)
- ✅ Per-locale i18n files (ko / en / ja / zh)
- ✅ Per-agent test rewrites (Tier-1 16 agents ≠ each other)
- ✅ Per-region deploy (us / eu / apac independent regions)

### When to sequentialize (one Agent call, wait, next Agent call)

- ❌ Phase 2 → Phase 3 (Phase 3 depends on Phase 2 scaffold)
- ❌ Phase 3 → Phase 4 (Tier-2/3 meta agents reference Tier-1)
- ❌ Terraform apply → Cloud Run deploy → smoke test
- ❌ Anything that mutates `DECISIONS.md` (lock contention)

### Hard cap

- ≤ **8 parallel agents per single message** (avoid overwhelming the dispatcher)
- ≤ **15 parallel agents in flight at once** (token + cost reasonable)

---

## 4. Recovery patterns

### Subagent socket error mid-stream (cf. P3-A5)

1. Check partial output in result directory (do NOT Read the JSONL transcript)
2. Diff against deliverable spec — identify what's missing
3. Dispatch a **scoped retry** (smaller brief, only the missing piece)
4. Don't re-dispatch the full task

### Subagent returns inconsistent output

1. Re-dispatch with **stricter brief** (more concrete acceptance criteria + sample output)
2. If still inconsistent, escalate to operator with diff

### Background test failure detected during dispatch

1. Note the failure in `BUILD-NOTES.md` (BN-N tripwire)
2. **Don't block** the current dispatch on it
3. Add a follow-up task to `WORK-QUEUE.md` for cleanup

---

## 5. Anti-patterns

| Anti-pattern | Why bad | Do instead |
|---|---|---|
| Dispatching the same agent 3x to "increase reliability" | Wastes tokens, no improvement | One agent + stricter brief |
| Asking subagent to "read everything" | Bloats context, slows execution | Mandatory inputs list (3-7 files max) |
| Subagent prompt referencing "the conversation" | Subagent can't see it | Self-contained: paste relevant context inline |
| Multiple subagents writing to the same file | Last-write-wins race | Coordinator merges; or split file by section |
| Subagent dispatched without acceptance criteria | Can't tell when done | Each prompt has "Acceptance:" block |
| Operator-blocking question buried in subagent prompt | Operator never sees it | Surface to operator-facing turn, then dispatch |

---

## 6. Quick decision flowchart

```
Got a task?
├─ Does it modify code? 
│   ├─ Python ADK → python-expert
│   ├─ TS/TSX → frontend-architect
│   ├─ Terraform → devops-architect
│   └─ Mixed → split into N tasks
├─ Does it modify docs only?
│   └─ technical-writer
├─ Does it modify tests/chaos?
│   └─ quality-engineer
├─ Does it need fresh research?
│   └─ deep-research-agent
├─ Does it need cross-file refactor?
│   └─ refactoring-expert
├─ Is a test failing inexplicably?
│   └─ root-cause-analyst
└─ Don't know?
    └─ general-purpose

Then:
├─ Independent of in-flight work? → parallel single-message
└─ Has dependency? → sequential, wait for notification
```
