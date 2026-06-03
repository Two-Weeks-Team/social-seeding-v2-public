"""GT4 part 2: retrieval_query against the corpus + grounded answer citing the
source, and attach the ADK VertexAiRagRetrieval tool to an agent."""
import os, time
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/ae-key.json"

import vertexai
from vertexai import rag
from google import genai
from google.adk.tools.retrieval.vertex_ai_rag_retrieval import VertexAiRagRetrieval

CORPUS = "projects/722660901814/locations/us-west1/ragCorpora/6917529027641081856"
QUESTION = "What is the minimum engagement rate and the per-creator payout method for the wooriliu campaign?"

vertexai.init(project="ss-v2-prod", location="us-west1")

# Wait for the file to finish embedding/indexing, then retrieve.
contexts = None
for attempt in range(12):
    resp = rag.retrieval_query(
        text=QUESTION,
        rag_resources=[rag.RagResource(rag_corpus=CORPUS)],
        rag_retrieval_config=rag.RagRetrievalConfig(top_k=3),
    )
    ctxs = list(resp.contexts.contexts)
    if ctxs:
        contexts = ctxs
        break
    time.sleep(15)

print("=== retrieved contexts ===")
src = None
joined = []
for c in (contexts or []):
    src = c.source_display_name or c.source_uri
    print(f"  source={src}  score={getattr(c,'score',None)}")
    print(f"  text={c.text[:200]}")
    joined.append(c.text)

# Grounded answer via gemini-3.5-flash (global, D53) constrained to the context.
_g = genai.Client(vertexai=True, project="ss-v2-prod", location="global")
prompt = (
    "Answer the question USING ONLY the context below. Cite the source file name in your answer. "
    "If the context lacks the answer, say so.\n\n"
    f"SOURCE FILE: {src}\nCONTEXT:\n" + "\n".join(joined) + f"\n\nQUESTION: {QUESTION}"
)
ans = _g.models.generate_content(model="gemini-3.5-flash", contents=prompt, config={"temperature": 0.0})
print("\n=== grounded answer (gemini-3.5-flash, cites corpus) ===")
print(ans.text)

# ADK tool attachment (the VertexAiRagRetrieval tool wired to the corpus).
tool = VertexAiRagRetrieval(
    name="brand_brief_search",
    description="Retrieve grounded facts from the wooriliu brand brief corpus.",
    rag_corpora=[CORPUS],
    similarity_top_k=3,
)
print("\n=== ADK VertexAiRagRetrieval tool attached ===")
print("  tool:", tool.name, "-> corpus:", CORPUS)
