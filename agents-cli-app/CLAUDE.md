# agents-cli-app — agent guidance

This is the Google Agents CLI (`agents-cli`) wrapper around Social Seeding v2's
real `ss_agents` fleet. The orchestrator (`app/agent.py` `root_agent`) is the
agents-cli/ADK discovery surface for `playground` / `eval` / `deploy`.

## Hard rules

- **Models: Gemini 3.x ONLY.** `gemini-3.5-flash` for orchestration + the eval
  rubric judge. NO Gemini 2.5, NO Claude, NO `*-pro`.
- **Endpoint: Vertex `global`.** Gemini 3.x is served on `global`; `agent.py`
  forces `GOOGLE_CLOUD_LOCATION=global` and `GOOGLE_GENAI_USE_VERTEXAI=True`.
- **Do not fork `ss_agents`.** Import the real capabilities from
  `../packages/agents-adk/src/ss_agents`; never copy/reimplement their logic.
  The path dependency is editable on purpose.
- **Grounding is real.** `google_search` (ADK built-in) and `research_brand`
  (→ `ss_agents.tools.web_search`) ground against the live web. Cite sources;
  never state grounded facts from memory.
- **Capability mode.** `CAPABILITY_LAYER_MODE=stub` (default) is offline +
  deterministic for dev/CI; `live` enables real Google Search grounding and the
  live ss-mcp A2A creator search. Unit tests mock the capabilities and stay
  network-free regardless.

## The loop

Social Seeding campaigns run: **source → vet → outreach → verify**. The
orchestrator grounds market claims (`research_brand` / `google_search`), sources
creators (`search_creators` → ss-mcp A2A `plan_creator_search`, RapidAPI
fallback), and reasons about the next step in that loop.

## Editing

- Add tools by writing more `str -> str` wrappers in `app/agent.py` that delegate
  to `ss_agents.tools.*` and return a formatted string (never raise — return an
  error string so a flaky hop degrades to a routing signal).
- Add eval cases under `tests/eval/evalsets/*.evalset.json`; the judge config is
  `tests/eval/eval_config.json` (gemini-3.5-flash).
- Keep `tests/unit` offline (mock the ss_agents calls).
