# Mission Control — visual specs

Self-contained HTML mockups (Tailwind via CDN, no build). Open in a browser.
These are **design contracts** for `apps/web` — the production code should
converge on what these show, not the other way around.

| File | Paradigm | Phase mapping |
|---|---|---|
| `mission-control-timeline.html` | Sidebar nav · 6-stage indicator · reverse-chron activity timeline (from `v2_agent_traces`) · cross-campaign approval inbox · policy editor · intake conversation | **Phase 1 implementation target** (W1-W5) |
| `mission-control-canvas.html` | Sidebar nav · dotted-grid workflow canvas with typed nodes (brief / agent / tool / gate / wait / fan-out group) · right-side node property panel · bottom natural-language chatbox (workflow-editor agent) | **Phase 2 target** — added as a second view alongside the timeline; chatbox arrives later (Phase 4) |

Both depict the **same campaign in the same state** (the Test Serum sourcing
example used throughout `docs/PHASE-1-PLAN.md`) so they can be compared as
alternative UX shells over the same domain model. The cross-campaign approval
inbox (in the timeline mockup) survives into the canvas era — the canvas is
single-campaign-focused, the inbox is workspace-wide triage.

## Why two

The timeline approach is implementable with HTML lists + the existing scaffold;
the canvas approach needs `@xyflow/react` (React Flow v12) + a workflow-editor
agent for the chatbox. Splitting it phase-wise keeps Phase 1 bounded and gives
us a validated data model (spans, gates, fan-out tracks) before the visual
shell gets richer.

## When the canvas lands (Phase 2+)

The mockup is a **starting frame**, not the finished design. The production
canvas must avoid the look-and-feel of generic AI-generated UI — see the
project memory note on design quality (use the project's design-skill
inventory: `design-taste-frontend`, `frontend-design`, `high-end-visual-design`,
`polish`, `redesign-existing-projects`, plus targeted skills like
`minimalist-ui` / `industrial-brutalist-ui` depending on the aesthetic
direction the owner picks before Phase 2 starts).
