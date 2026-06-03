"""GT5: data-driven Prompt Optimizer (GenAI Client, examples_dataframe) on a
reply-triage task. Optimizes a deliberately-vague system instruction from
labeled examples, then measures before/after label accuracy with
gemini-3.5-flash (global, D53)."""
import json, os, re
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/ae-key.json"
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"

import pandas as pd
from google import genai
from vertexai import Client, types

LABELS = ["INTERESTED", "DECLINE", "QUESTION", "NEGOTIATE"]
BASELINE = "Classify the creator's reply message."  # deliberately vague (no label set)

rows = [json.loads(l) for l in open("/tmp/vapo/triage.jsonl")]
_g = genai.Client(vertexai=True, project="ss-v2-prod", location="global")
JUDGE = "gemini-3.5-flash"


def classify(instruction: str, message: str) -> str:
    out = _g.models.generate_content(
        model=JUDGE,
        contents=f"{instruction}\n\nMESSAGE: {message}\n\nReply with ONLY one word.",
        config={"temperature": 0.0},
    )
    t = (out.text or "").upper()
    for lab in LABELS:
        if lab in t:
            return lab
    return t.strip().split()[0] if t.strip() else "?"


# Build examples_dataframe (prompt, model_response=baseline output, target_response=gold).
df_rows = []
for r in rows:
    base_resp = classify(BASELINE, r["input"])
    df_rows.append({"prompt": r["input"], "model_response": base_resp, "target_response": r["target"]})
df = pd.DataFrame(df_rows)
base_acc = sum(df["model_response"] == df["target_response"]) / len(df)
print(f"=== BASELINE instruction: {BASELINE!r}")
print(f"=== baseline accuracy (before): {base_acc:.0%}  ({sum(df['model_response']==df['target_response'])}/{len(df)})")

print("\n=== data-driven optimize_prompt (examples_dataframe) ===")
client = Client(project="ss-v2-prod", location="us-central1")
resp = client.prompts.optimize(
    prompt=BASELINE,
    config=types.OptimizeConfig(
        examples_dataframe=df,
        optimization_target=types.OptimizeTarget.OPTIMIZATION_TARGET_FEW_SHOT_TARGET_RESPONSE,
    ),
)
optimized = (resp.raw_text_response or "").strip()
print("--- OPTIMIZED INSTRUCTION ---")
print(optimized[:1200])

# Measure after-accuracy with the optimized instruction.
after = [classify(optimized, r["input"]) for r in rows]
after_acc = sum(a == r["target"] for a, r in zip(after, rows)) / len(rows)
print(f"\n=== AFTER accuracy (optimized): {after_acc:.0%}  ({sum(a==r['target'] for a,r in zip(after,rows))}/{len(rows)})")
print(f"=== BEFORE/AFTER: {base_acc:.0%} -> {after_acc:.0%}")
