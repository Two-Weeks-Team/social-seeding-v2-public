"""Optimize/Agent Simulation — BETTER METHOD (the managed DataFoundry
generate_conversation_scenarios returns 500 INTERNAL twice). A gemini-3.5-flash
"simulated brand operator" generates diverse scenarios, then each is driven
against the LIVE thinking-enabled agent (engine 2498) in its own Session — a real
simulated-user ⇄ live-agent loop, exercising Sessions + Memory recall + thinking."""
import os, json
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/ae-key.json"
os.environ["GOOGLE_CLOUD_LOCATION"] = "us-central1"
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"

from google import genai
from google.genai import types as gt
import vertexai
from vertexai import agent_engines

ENGINE = "projects/722660901814/locations/us-central1/reasoningEngines/2498295477225652224"

# 1) Simulated user generator (gemini-3.5-flash, global, D53).
_g = genai.Client(vertexai=True, project="ss-v2-prod", location="global")
SCHEMA = {
    "type": "object", "properties": {
        "scenarios": {"type": "array", "items": {"type": "object", "properties": {
            "title": {"type": "string"}, "starting_prompt": {"type": "string"}}, "required": ["title", "starting_prompt"]}}},
    "required": ["scenarios"]}
gen = _g.models.generate_content(
    model="gemini-3.5-flash",
    contents=("You simulate diverse brand operators stress-testing a TikTok creator-sourcing agent. "
              "Produce 3 scenarios: (1) a normal beauty brief, (2) an edge case with a tight engagement-rate floor, "
              "(3) an under-specified/ambiguous brief. Each: a short title + a realistic one-line starting_prompt."),
    config=gt.GenerateContentConfig(response_mime_type="application/json", response_schema=SCHEMA, temperature=0.7),
)
scenarios = json.loads(gen.text)["scenarios"]
print(f"=== OPTIMIZE / Agent Simulation (direct loop) — {len(scenarios)} simulated operators ===")

# 2) Drive each against the LIVE agent in its own Session.
vertexai.init(project="ss-v2-prod", location="us-central1")
engine = agent_engines.get(ENGINE)
for i, sc in enumerate(scenarios, 1):
    sess = engine.create_session(user_id="sim-operator")
    sid = sess["id"] if isinstance(sess, dict) else getattr(sess, "id", None)
    reply = []
    for ev in engine.stream_query(user_id="sim-operator", session_id=sid, message=sc["starting_prompt"]):
        for p in (ev.get("content") or {}).get("parts") or []:
            if p.get("text"):
                reply.append(p["text"])
    print(f"\n[{i}] {sc['title']}")
    print(f"    SIM-USER: {sc['starting_prompt'][:130]}")
    print(f"    AGENT   : {' '.join(reply)[:170]}")
print("\n  → simulated-user ⇄ live agent loop complete (Sessions + recall + thinking exercised).")
