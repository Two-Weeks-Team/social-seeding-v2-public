"""Curated tools available to ADK agents.

Each tool is a plain Python function with type hints + docstring; ADK
introspects both to build the JSON schema sent to Gemini (ADK-GUIDE.md §2.2).

Phase 2 ships:
    - prompt_guard.guard_payload  — D8 + D21 input sanitizer
    - shared.upsert_intake_form   — D33-respecting Firestore upsert stub

Phase 3 will fill in:
    - tiktok.search, tiktok.user_info, tiktok.user_posts (4 microservices)
    - gmail.send (external_send-gated, requires policy gate per D27)
    - rapidapi.* generic wrappers
"""
from __future__ import annotations

from ss_agents.tools.prompt_guard import guard_payload, scan_text
from ss_agents.tools.shared import upsert_intake_form

__all__ = ["guard_payload", "scan_text", "upsert_intake_form"]
