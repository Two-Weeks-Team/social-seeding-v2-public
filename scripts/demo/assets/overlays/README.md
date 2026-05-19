# `scripts/demo/assets/overlays/` — Per-beat Mermaid mini-diagrams

> **Purpose**: 12 Mermaid source files (6 beats × 2 tracks) that render to the 540×320 top-right mini-diagram described in [`gcp-research/demo/SCRIPT.md`](../../../../gcp-research/demo/SCRIPT.md) §5 layer 2.

## Files

| File                    | Beat                                            | Track |
|-------------------------|-------------------------------------------------|-------|
| `v2-beat-1.mmd`         | Brief intake + sourcing                          | v2    |
| `v2-beat-2.mmd`         | Vetting fan-out × 12                             | v2    |
| `v2-beat-3.mmd`         | Outreach tournament + approval                   | v2    |
| `v2-beat-4.mmd`         | Gmail send + reply                               | v2    |
| `v2-beat-5.mmd`         | Logistics + verify (+ 5 d durable timer)         | v2    |
| `v2-beat-6.mmd`         | Analyst report + cost ledger                     | v2    |
| `mcp-beat-1.mmd`        | Public MCP endpoint                              | mcp   |
| `mcp-beat-2.mmd`        | ADK orchestration agent                          | mcp   |
| `mcp-beat-3.mmd`        | A2A registration / agent.json                    | mcp   |
| `mcp-beat-4.mmd`        | Model Armor PI / JB block                        | mcp   |
| `mcp-beat-5.mmd`        | KR-gap reframing (Marketplace PENDING)           | mcp   |
| `mcp-beat-6.mmd`        | Multi-region failover                            | mcp   |

Each Mermaid source is intentionally small (≤ 6 nodes) so the 540×320 render is legible at 8× speed playback. The active node in each beat is highlighted with the **Google Yellow `#FFD400`** ring per SCRIPT.md §5 layer 2.

## Beats TSV — fallback overlay copy

`v2-beats.tsv` and `mcp-beats.tsv` carry the row-per-beat copy consumed by [`scripts/demo/post-process/_overlay_fallback.sh`](../../post-process/_overlay_fallback.sh) when `gen-overlay.ts` has not produced the rich PNG sequence. Schema (tab-delimited):

```
beat_index  start_s  end_s  section_label  cost_ticker  agent_tag
```

The fallback generator writes one PNG per source second; editing the TSV here is the safe way to tweak copy without touching code.

## Rendering each beat's Mermaid to PNG

```bash
for f in v2-beat-*.mmd mcp-beat-*.mmd; do
  out="${f%.mmd}.png"
  mmdc -i "$f" -o "$out" -w 540 -H 320 -b transparent --theme dark
done
```

## Authority

Beat copy traces to [`gcp-research/demo/SCRIPT.md`](../../../../gcp-research/demo/SCRIPT.md) §3 (Track 2) and §4 (Track 3). Active-node highlighting + 8-frame pulse rate documented in §5 layer 2 of the same file. Color palette per §5 (Google Blue `#4285F4` for agent nodes, Google Yellow `#FFD400` for the active-node ring).
