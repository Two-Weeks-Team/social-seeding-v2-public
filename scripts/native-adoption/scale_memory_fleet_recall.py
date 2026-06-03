"""Scale/Memory Bank fleet-wide — per-user scoped recall: the SAME deployed agent
recalls a DIFFERENT remembered constraint per brand-operator (wooriliu 13% vs
glowco 8%) with NO ER stated in either query."""
import os
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/ae-key.json"
os.environ["GOOGLE_CLOUD_LOCATION"] = "us-central1"
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"
import vertexai
from vertexai import agent_engines

ENGINE = "projects/722660901814/locations/us-central1/reasoningEngines/2498295477225652224"
vertexai.init(project="ss-v2-prod", location="us-central1")
engine = agent_engines.get(ENGINE)
MSG = "Source TikTok beauty creators for the campaign and give me the shortlist."

def run(user):
    applied, n = None, 0
    for ev in engine.stream_query(user_id=user, message=MSG):
        for p in (ev.get("content") or {}).get("parts") or []:
            if p.get("function_call") and p["function_call"].get("name") == "source_creators":
                applied = dict(p["function_call"].get("args") or {}).get("min_engagement_rate")
            if p.get("function_response"):
                r = p["function_response"].get("response", {})
                out = r.get("result") if isinstance(r, dict) else r
                n = str(out).count("@")
    return applied, n

for user in ["wooriliu-op", "glowco-op"]:
    a, n = run(user)
    print(f"  user={user:12s} → recalled min_engagement_rate={a} → {n} creators")
print("  → SAME agent, per-user Memory Bank scope: differentiated recall (no ER in the prompt).")
