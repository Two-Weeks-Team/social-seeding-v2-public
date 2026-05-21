"""web_search_grounding_smoke.py — operator-gated LIVE Google Search grounding proof (D53).

Runs the `web.search` capability in live mode (`CAPABILITY_LAYER_MODE=live`), which calls
`gemini-3.5-flash` with the built-in `GoogleSearch` grounding tool and lifts cited sources
out of `grounding_metadata`. Prints the grounded sources + URLs so an operator can see this
is REAL web grounding, not a chat completion.

Exit codes: 0 = grounded sources returned; 3 = zero sources; 4 = env/import error.
"""
from __future__ import annotations

import os
import sys


def main() -> int:
    if os.environ.get("CAPABILITY_LAYER_MODE") != "live":
        print("[web-grounding] REFUSING: set CAPABILITY_LAYER_MODE=live", file=sys.stderr)
        return 4
    try:
        from ss_agents.tools.web_search import WebSearchInput, web_search
    except ModuleNotFoundError as exc:
        print(f"[web-grounding] import error (agents-adk venv?): {exc}", file=sys.stderr)
        return 4

    query = sys.argv[1] if len(sys.argv) > 1 else "Korean vegan skincare TikTok creators 2026 trends"
    out = web_search(WebSearchInput(query=query, maxResults=5))

    print("=" * 72)
    print("WEB SEARCH GROUNDING PROOF (D53 · gemini-3.5-flash · GoogleSearch tool)")
    print("=" * 72)
    print(f"  query           : {query}")
    print(f"  grounded sources: {len(out.results)}")
    for r in out.results:
        print(f"  - {r.title[:60]}")
        print(f"      url    : {r.url[:80]}")
        print(f"      snippet: {r.snippet[:100]}")
    print("=" * 72)
    if not out.results:
        print("[web-grounding] FAIL — no grounded sources returned", file=sys.stderr)
        return 3
    print("[web-grounding] PASS — real Google Search grounding returned cited sources (exit 0)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
