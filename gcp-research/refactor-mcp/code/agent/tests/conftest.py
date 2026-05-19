"""Shared pytest fixtures.

The whole test suite runs in stub mode (no MCP container, no Vertex AI, no
Identity Platform). Each module sets the env flags it needs before importing
the package, so we set them here once at session scope.
"""

from __future__ import annotations

import os

# Activate stub modes for every external dependency BEFORE first import.
os.environ.setdefault("MCP_BASE_URL", "")
os.environ.setdefault("IDENTITY_PLATFORM_STUB", "1")
os.environ.setdefault("MODEL_ARMOR_STUB", "1")
os.environ.setdefault("ADK_DISABLED", "1")
os.environ.setdefault("REQUIRE_AUTH", "false")
os.environ.setdefault("ALLOW_ANONYMOUS_DISCOVERY", "true")
