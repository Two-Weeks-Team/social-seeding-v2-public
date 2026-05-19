"""Top-level conftest for the entire test-harness/ suite.

Adds every sibling test root to sys.path so per-package `import verify`,
`from chaos.orchestrator import ...`, and `from strategies import ...`
all resolve from the test files.
"""

import os
import sys
from pathlib import Path

HARNESS_ROOT = Path(__file__).resolve().parent
# Bare directories that hold importable modules without an __init__.py
# (the hyphenated `edge-cases/` and the property-based/ root).
EXTRA_PATHS = [
    HARNESS_ROOT,
    HARNESS_ROOT / "edge-cases",
    HARNESS_ROOT / "property-based",
]
for p in EXTRA_PATHS:
    sp = str(p)
    if sp not in sys.path:
        sys.path.insert(0, sp)

os.environ.setdefault("HARNESS_MODE", "stub")
os.environ.setdefault("HARNESS_PROFILE", "ci")
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "ss-v2-stub")

# Make hypothesis profiles available even when only a subset of tests runs.
try:
    from hypothesis import HealthCheck, Phase, Verbosity, settings  # noqa: PLC0415

    if "ci" not in settings._profiles:  # type: ignore[attr-defined]
        settings.register_profile(
            "ci",
            max_examples=50,
            deadline=2_000,
            derandomize=True,
            suppress_health_check=[HealthCheck.too_slow],
            phases=(Phase.explicit, Phase.reuse, Phase.generate, Phase.target),
            verbosity=Verbosity.normal,
        )
    if "dev" not in settings._profiles:  # type: ignore[attr-defined]
        settings.register_profile(
            "dev",
            max_examples=200,
            deadline=5_000,
            suppress_health_check=[HealthCheck.too_slow],
            verbosity=Verbosity.verbose,
        )
    if "nightly" not in settings._profiles:  # type: ignore[attr-defined]
        settings.register_profile(
            "nightly",
            max_examples=1_000,
            deadline=10_000,
            suppress_health_check=[HealthCheck.too_slow],
        )
    settings.load_profile(os.environ.get("HARNESS_PROFILE", "ci"))
except ImportError:  # pragma: no cover
    pass
