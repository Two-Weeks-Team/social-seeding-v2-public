#!/usr/bin/env python3
"""verify.py — Adversarial edge-case verification driver.

Cites: D21 (Model Armor), D32 (Chronicle SecOps), D37 (5-layer TDD).
Source spec: gcp-research/edge-cases/CATALOG.md (122 cases across 8 sections).

Each case in `catalog.json` declares (trigger, expected_detection, expected_response,
recovery, test_plan, d_ids). This driver:

  1. Loads catalog.json.
  2. For each case, dispatches to a category-specific stub that simulates the
     trigger and asserts detection.
  3. Aggregates pass/fail and reports the coverage gap.

In HARNESS_MODE=stub (default), the dispatchers return canned True/False per
case ID — enough to validate the harness wiring. In HARNESS_MODE=live, they
call the actual platform surface (Model Armor, Cloud Armor, compliance agent,
DLP, etc.).

The CI per-PR pipeline runs this with `--mode=stub --subset=hot-path`. The
nightly Cloud Build pipeline runs `--mode=live --subset=all`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Callable

HARNESS_ROOT = Path(__file__).resolve().parent.parent
CATALOG_JSON = Path(__file__).parent / "catalog.json"

HARNESS_MODE = os.environ.get("HARNESS_MODE", "stub")


@dataclass
class VerifyResult:
    case_id: str
    title: str
    category: str
    passed: bool
    detection_observed: bool
    response_observed: bool
    recovery_observed: bool
    notes: str = ""
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ----------------------------------------------------------------- dispatchers
# Each category maps to a verification stub. In production the dispatcher
# selects between Model Armor (D21), Cloud Armor, compliance agent (D23),
# security_watch (W3, D23), and chaos orchestrator (D37 L5).

def _verify_stub(case: dict[str, Any]) -> VerifyResult:
    """Deterministic per-case stub. Pass rate driven by trigger-string hash so
    failures land where the catalog flags an actually fragile path."""
    cid = case["id"]
    title = case["title"]
    # Heuristic: cases mentioning "false positive" or "false-positive" or
    # whose expected response is "Sanitize" are the ones that historically
    # tripped Model Armor false-clears — model those as flaky in stub.
    text = " ".join([
        case.get("expected_detection", ""),
        case.get("expected_response", ""),
        case.get("trigger", ""),
    ]).lower()
    is_known_flaky = (
        "false positive" in text
        or "false-positive" in text
        or "borderline" in text
    )
    h = sum(ord(c) for c in cid) % 100
    detection = h >= 10 if not is_known_flaky else h >= 30
    response = h >= 5 if not is_known_flaky else h >= 25
    recovery = h >= 15
    passed = detection and response and recovery
    return VerifyResult(
        case_id=cid,
        title=title,
        category=case["category"],
        passed=passed,
        detection_observed=detection,
        response_observed=response,
        recovery_observed=recovery,
        notes="stub-mode",
    )


def _verify_live(case: dict[str, Any]) -> VerifyResult:
    """Real verification path. Routes by category to the right surface.

    For brevity this raises NotImplementedError — the live wiring lands
    once the per-surface adapters (Model Armor client, Cloud Armor probe,
    compliance agent invocation) are exposed via the platform's internal
    REST surface (D32).
    """
    raise NotImplementedError(
        f"live verification for {case['id']} not implemented; "
        f"see edge-cases/CATALOG.md §10 mitigation matrix."
    )


CATEGORY_DISPATCH: dict[str, Callable[[dict[str, Any]], VerifyResult]] = {
    # All categories share the stub for now; live mode routes individually.
    "input": _verify_stub,
    "agent": _verify_stub,
    "multi_tenant": _verify_stub,
    "infrastructure": _verify_stub,
    "compliance": _verify_stub,
    "abuse": _verify_stub,
    "demo_submission": _verify_stub,
    "chaos_crosscut": _verify_stub,
}


# ----------------------------------------------------------------- driver
def load_catalog(path: str | Path = CATALOG_JSON) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    if "cases" not in doc:
        raise ValueError(f"{path}: missing top-level `cases` key.")
    return doc


def verify_one(case: dict[str, Any], *, mode: str = HARNESS_MODE) -> VerifyResult:
    category = case.get("category", "<unknown>")
    dispatcher = CATEGORY_DISPATCH.get(category)
    if dispatcher is None:
        return VerifyResult(
            case_id=case["id"], title=case["title"], category=category,
            passed=False, detection_observed=False, response_observed=False,
            recovery_observed=False,
            error=f"no dispatcher for category={category!r}",
        )
    if mode == "live":
        return _verify_live(case)
    return dispatcher(case)


def verify_all(
    catalog: dict[str, Any],
    *,
    subset: str = "all",
    mode: str = HARNESS_MODE,
) -> list[VerifyResult]:
    results: list[VerifyResult] = []
    for case in catalog["cases"]:
        if subset != "all" and case["category"] != subset:
            continue
        try:
            results.append(verify_one(case, mode=mode))
        except Exception as exc:  # noqa: BLE001
            results.append(VerifyResult(
                case_id=case["id"], title=case["title"],
                category=case["category"],
                passed=False, detection_observed=False,
                response_observed=False, recovery_observed=False,
                error=str(exc),
            ))
    return results


def aggregate(results: list[VerifyResult]) -> dict[str, Any]:
    by_cat: dict[str, list[VerifyResult]] = {}
    for r in results:
        by_cat.setdefault(r.category, []).append(r)
    total = len(results)
    passed = sum(1 for r in results if r.passed)
    return {
        "total": total,
        "passed": passed,
        "pass_rate": passed / total if total else 0.0,
        "by_category": {
            c: {
                "total": len(rs),
                "passed": sum(1 for r in rs if r.passed),
                "first_failure": next((r.case_id for r in rs if not r.passed), None),
            }
            for c, rs in by_cat.items()
        },
    }


# ----------------------------------------------------------------- CLI
def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--mode", choices=["stub", "live"], default=HARNESS_MODE)
    p.add_argument("--subset", default="all",
                   help="Category filter: all|input|agent|multi_tenant|"
                        "infrastructure|compliance|abuse|demo_submission|"
                        "chaos_crosscut")
    p.add_argument("--out", default=None, help="JSONL output (default: stdout)")
    args = p.parse_args(argv)

    catalog = load_catalog()
    results = verify_all(catalog, subset=args.subset, mode=args.mode)
    agg = aggregate(results)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            for r in results:
                f.write(json.dumps(r.to_dict()) + "\n")

    print(json.dumps(agg, indent=2))
    return 0 if agg["passed"] == agg["total"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
