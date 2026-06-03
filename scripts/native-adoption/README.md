# Native-Adoption proofs (GT1–GT6)

Reproduction scripts for `docs/NATIVE-ADOPTION-CHECKLIST.md` §A — every item runs
live on **ss-v2-prod** with Gemini 3.5/3.1 only (D53), Vertex `global` for models.

Auth: `GOOGLE_APPLICATION_CREDENTIALS=/tmp/ae-key.json` (deployer SA) or an owner
`gcloud auth print-access-token`. Run from this dir with `PYTHONPATH` set where noted.

| GT | Script | What it proves |
|----|--------|----------------|
| GT1 Cloud Trace | `gt1_gt2_deploy_trace_memory.py` | Deploys reasoningEngine `2498295477225652224` with `enable_tracing=True` + SA `ss-agent-runtime` (needs `roles/cloudtrace.agent`). A live query emits a 7-span trace (`invocation→invoke_agent→call_llm→generate_content gemini-3.5-flash→execute_tool source_creators→…`). |
| GT2 Memory auto-recall | `gt2_query_recall.py` | Query with NO engagement rate stated → `before_agent_callback` recalls the "min ER 13%" memory (env-pinned scope, `location=us-central1`) → agent calls `source_creators(min_engagement_rate=13)` → only `@_alejandrauve`. |
| GT3 GenAI Evaluation | `gt3_genai_evaluation.py` | `Client.evals.run_inference` + `evaluate` with a rubric metric judged client-side by gemini-3.5-flash (managed autorater rejects 3.x; D53 forbids 2.5/pro). Prints `final_response_quality` summary metrics. |
| GT4 RAG Engine | `gt4_rag_retrieval.py` | `rag.retrieval_query` against corpus `…/us-west1/ragCorpora/6917529027641081856` (brand brief) → gemini-3.5-flash grounded answer citing `wooriliu-brand-brief.txt`; ADK `VertexAiRagRetrieval` tool attached. |
| GT5 Prompt Optimizer | `gt5_prompt_optimizer.py` | Data-driven `client.prompts.optimize` (examples_dataframe) on `fixtures/triage.jsonl` → optimized instruction; measured triage accuracy **50% → 90%**. |
| GT6 AP2 chain wiring | (TS) `apps/web/lib/ap2/chain-guard.ts` + `__tests__/ap2/chain-guard.test.ts` | `verifyMandateChain` wired into the `sign-mandate` route (HTTP 422 on a tampered/over-ceiling chain). `vitest __tests__/ap2/` green; `verify-build` green. |

The deployed memory store is reasoningEngine `1587442452589969408` (Memory Bank,
scope `app_name=ss-recall`). RAG corpus is in `us-west1` because new projects are
allowlist-restricted from Spanner-mode RAG in us-central1/us-east1/us-east4.
