"""GT3: Vertex Gen AI Evaluation (GenAI Client).

run_inference (gemini-3.5-flash, global) generates campaign responses; a
custom_function rubric metric scores each via gemini-3.5-flash judged
CLIENT-SIDE on the `global` endpoint (D53: 3.x only — the managed autorater
rejects 3.x and we will NOT fall back to 2.5/pro). Prints summary metrics.
"""
import os
import re

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/ae-key.json"
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"

import pandas as pd
from google import genai
from vertexai import Client, types

client = Client(project="ss-v2-prod", location="global")
_judge = genai.Client(vertexai=True, project="ss-v2-prod", location="global")
JUDGE_MODEL = "gemini-3.5-flash"


def _text_of(content) -> str:
    if not content:
        return ""
    if isinstance(content, str):
        return content
    parts = content.get("parts") if isinstance(content, dict) else None
    if not parts:
        return str(content)
    return " ".join(p.get("text", "") for p in parts if isinstance(p, dict))


_RUBRIC = (
    "You are a strict evaluator of an influencer-campaign assistant. Score the RESPONSE "
    "to the BRIEF on a 1-5 integer scale where 5 = ranked creator shortlist that is "
    "well-structured, actionable, and does NOT fabricate precise platform metrics; "
    "3 = acceptable but one weakness; 1 = poor structure or fabricates specific numbers. "
    "Reply with ONLY a JSON object: {{\"score\": <int 1-5>, \"explanation\": \"<one sentence>\"}}.\n\n"
    "BRIEF:\n{brief}\n\nRESPONSE:\n{resp}\n"
)


def rubric_judge(instance: dict) -> dict:
    brief = _text_of(instance.get("prompt"))
    resp = _text_of(instance.get("response"))
    out = _judge.models.generate_content(
        model=JUDGE_MODEL,
        contents=_RUBRIC.format(brief=brief, resp=resp),
        config={"temperature": 0.0},
    )
    raw = (out.text or "").strip()
    m = re.search(r'"score"\s*:\s*([1-5])', raw)
    score = float(m.group(1)) if m else 1.0
    exp = re.search(r'"explanation"\s*:\s*"([^"]+)"', raw)
    return {"score": score, "explanation": exp.group(1) if exp else raw[:120]}


prompts = pd.DataFrame({
    "prompt": [
        "Source TikTok beauty creators for a cosmetics campaign and return a ranked shortlist with @handle, views and engagement rate.",
        "Find micro-influencers in the skincare niche with strong engagement; give a short ranked list.",
        "I need a creator shortlist for a haircare launch. Rank by engagement rate and include views.",
    ]
})

print("=== run_inference (model=gemini-3.5-flash, global) ===")
inference = client.evals.run_inference(model=JUDGE_MODEL, src=prompts)
print("inference rows:", len(inference.eval_dataset_df))

quality = types.LLMMetric(name="final_response_quality", custom_function=rubric_judge)

print("\n=== evaluate (judge=gemini-3.5-flash, client-side, global) ===")
result = client.evals.evaluate(dataset=inference, metrics=[quality])

print("\n=== SUMMARY METRICS ===")
for m in result.summary_metrics:
    d = m if isinstance(m, dict) else m.model_dump(exclude_none=True)
    print(" ", d)
