"""conftest.py — Hypothesis profile configuration for L3 property tests.

Cites: D37 (5-layer TDD). MATRIX §4 (pytest agents — Python ADK).

Profiles:
  - ci      — fast, deterministic, used by per-PR Cloud Build.
  - dev     — interactive shrinking enabled.
  - nightly — exhaustive, runs as part of the L3 nightly mutation sweep.

`HARNESS_PROFILE` selects; default is `ci`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from hypothesis import HealthCheck, Phase, Verbosity, settings

# Make `strategies.py` importable from sibling tests.
HARNESS_ROOT = Path(__file__).resolve().parents[1]
PB_DIR = Path(__file__).resolve().parent
for p in (str(PB_DIR), str(HARNESS_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

# Per MATRIX §4.2 — Hypothesis is the property-test driver.
settings.register_profile(
    "ci",
    max_examples=50,
    deadline=2_000,                # ms; pytest-quick gate
    derandomize=True,              # deterministic per case-id
    suppress_health_check=[HealthCheck.too_slow],
    phases=(Phase.explicit, Phase.reuse, Phase.generate, Phase.target),
    verbosity=Verbosity.normal,
)
settings.register_profile(
    "dev",
    max_examples=200,
    deadline=5_000,
    suppress_health_check=[HealthCheck.too_slow],
    verbosity=Verbosity.verbose,
)
settings.register_profile(
    "nightly",
    max_examples=1_000,
    deadline=10_000,
    suppress_health_check=[HealthCheck.too_slow],
)

settings.load_profile(os.environ.get("HARNESS_PROFILE", "ci"))
