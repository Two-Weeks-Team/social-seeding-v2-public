"""GT2 query-only: hit the deployed engine with NO ER stated; the cloud
before_agent_callback recalls 13% → expect exactly @_alejandrauve."""
import os

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/ae-key.json"
os.environ["GOOGLE_CLOUD_LOCATION"] = "us-central1"  # control-plane for .get()
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"

import vertexai
from vertexai import agent_engines

ENGINE = "projects/722660901814/locations/us-central1/reasoningEngines/2498295477225652224"
USER_ID = "wooriliu-op"

vertexai.init(project="ss-v2-prod", location="us-central1")
engine = agent_engines.get(ENGINE)
msg = "Source TikTok beauty creators for the wooriliu campaign and give me the shortlist."
print(f"QUERY (no ER stated): {msg}\n--- agent response ---")
final = []
for event in engine.stream_query(user_id=USER_ID, message=msg):
    parts = (event.get("content") or {}).get("parts") or []
    for p in parts:
        if p.get("text"):
            final.append(p["text"])
        if p.get("function_call"):
            fc = p["function_call"]
            print(f"  [tool_call] {fc.get('name')}({dict(fc.get('args') or {})})")
        if p.get("function_response"):
            fr = p["function_response"]
            resp = fr.get("response", {})
            out = resp.get("result") if isinstance(resp, dict) else resp
            print(f"  [tool_result] {str(out)[:160]}")
print("--- final text ---")
print("".join(final))
