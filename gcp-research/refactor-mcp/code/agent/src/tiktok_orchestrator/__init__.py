"""tiktok-orchestrator — ADK orchestration layer.

Wraps the existing Node MCP server (`tiktok-mcp-server`, 4 read-only tools) as
an A2A-listable agent for Gemini Enterprise.

Public surface:
    * ``main.app``           — FastAPI app with /healthz, /chat, /a2a/skills.
    * ``main.run``           — uvicorn entrypoint for ``python -m`` or scripts.
    * ``agent.coordinator``  — top-level ADK SequentialAgent (searcher + ranker).
    * ``mcp_client``         — async MCP HTTP client (talks to sidecar :8100).
    * ``identity_platform``  — Identity Platform OAuth helpers (replaces SQLite).
    * ``model_armor``        — Per-request Model Armor sanitization (D21).

Decisions implemented:
    * D1   Dual submission (Track 3 reference path)
    * D2/D3 KR-gap → A2A-only path is primary; Marketplace listing is secondary
    * D17  Vertex AI Agent Runtime / Cloud Run multi-container (transition path)
    * D19  Identity Platform tenant for OAuth
    * D21  Model Armor + custom regex sanitization on every prompt + response

Reference:
    * REFACTOR-MCP.md §3.3 (Path A code)
    * REFACTOR-MCP.md §4 (Identity Platform migration)
    * ARMOR-GATEWAY.md §1.6 path A (per-request sanitization)
    * PROTOCOLS.md §3 (agent.json schema)
"""

__version__ = "1.0.0"
__all__ = ["__version__"]
