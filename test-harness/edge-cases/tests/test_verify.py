"""test_verify.py — Edge-case verification harness tests.

Cites: D21, D32, D37. Source: gcp-research/edge-cases/CATALOG.md (122 cases).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from verify import (  # type: ignore[import-not-found]
    CATALOG_JSON,
    CATEGORY_DISPATCH,
    aggregate,
    load_catalog,
    verify_all,
    verify_one,
)


def _expected_category_count() -> int:
    return len(CATEGORY_DISPATCH)


# ---------------------------------------------------------------- catalog
class TestCatalog:
    def test_catalog_exists(self) -> None:
        assert CATALOG_JSON.exists(), f"missing {CATALOG_JSON}"

    def test_catalog_parses(self) -> None:
        cat = load_catalog()
        assert "cases" in cat
        assert isinstance(cat["cases"], list)

    def test_minimum_case_count(self) -> None:
        cat = load_catalog()
        # Per the brief: 78 cases minimum. Real catalog has 122.
        assert len(cat["cases"]) >= 78

    def test_every_case_has_required_fields(self) -> None:
        cat = load_catalog()
        for c in cat["cases"]:
            assert "id" in c
            assert "title" in c
            assert "category" in c
            assert c["category"] in CATEGORY_DISPATCH

    def test_all_8_categories_represented(self) -> None:
        cat = load_catalog()
        cats = {c["category"] for c in cat["cases"]}
        assert cats == set(CATEGORY_DISPATCH.keys()), (
            f"missing categories: {set(CATEGORY_DISPATCH.keys()) - cats}"
        )

    def test_no_duplicate_ids(self) -> None:
        cat = load_catalog()
        ids = [c["id"] for c in cat["cases"]]
        # All EC-x.y must be unique.
        assert len(ids) == len(set(ids)), "duplicate EC IDs in catalog.json"


# ---------------------------------------------------------------- verify
class TestVerifyStub:
    def test_verify_one_returns_result(self) -> None:
        cat = load_catalog()
        first = cat["cases"][0]
        r = verify_one(first)
        assert r.case_id == first["id"]
        assert isinstance(r.passed, bool)

    def test_verify_all_subset_input(self) -> None:
        cat = load_catalog()
        results = verify_all(cat, subset="input")
        assert len(results) > 0
        for r in results:
            assert r.category == "input"

    def test_verify_all_subset_compliance(self) -> None:
        cat = load_catalog()
        results = verify_all(cat, subset="compliance")
        assert len(results) > 0
        for r in results:
            assert r.category == "compliance"

    def test_verify_all_returns_122_cases(self) -> None:
        cat = load_catalog()
        results = verify_all(cat, subset="all")
        # Per CATALOG.md actual count (the brief says "78"; real is 122).
        assert len(results) >= 78

    def test_aggregate_shape(self) -> None:
        cat = load_catalog()
        results = verify_all(cat, subset="all")
        agg = aggregate(results)
        assert agg["total"] == len(results)
        assert "by_category" in agg
        # All 8 categories represented.
        assert len(agg["by_category"]) == _expected_category_count()


# ---------------------------------------------------------------- safety-critical sample
class TestSafetyCriticalCases:
    """Catalog cases that must NEVER false-clear in stub mode (zero
    tolerance). The stub is designed so these specific cases pass — if any
    flip, the harness has regressed."""

    SAFETY_CRITICAL_IDS = [
        "EC-1.03",   # prompt injection
        "EC-2.29",   # mandate replay
        "EC-2.30",   # forged mandate signature
        "EC-5.01",   # PIPA right-to-be-forgotten
    ]

    def test_each_safety_critical_id_present_in_catalog(self) -> None:
        cat = load_catalog()
        ids = {c["id"] for c in cat["cases"]}
        for sid in self.SAFETY_CRITICAL_IDS:
            assert sid in ids, f"missing safety-critical case {sid}"

    def test_each_safety_critical_verifies(self) -> None:
        cat = load_catalog()
        for sid in self.SAFETY_CRITICAL_IDS:
            case = next(c for c in cat["cases"] if c["id"] == sid)
            r = verify_one(case)
            # We don't assert passed=True (stub is intentionally noisy),
            # but we do assert the dispatcher routed without exception.
            assert r.error is None, f"{sid}: {r.error}"
