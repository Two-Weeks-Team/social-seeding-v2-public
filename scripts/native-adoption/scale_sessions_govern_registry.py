"""Aggressive adoption Batch 1 — Scale/Agent Sessions + Govern/Agent Registry (live)."""
import os
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/ae-key.json"
os.environ["GOOGLE_CLOUD_LOCATION"] = "us-central1"
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"

import vertexai
from vertexai import agent_engines

ENGINE = "projects/722660901814/locations/us-central1/reasoningEngines/2498295477225652224"
USER = "wooriliu-op"
vertexai.init(project="ss-v2-prod", location="us-central1")

print("=== GOVERN / Agent Registry — live read of registered engines ===")
regs = list(agent_engines.list())
for ag in regs:
    rn = getattr(ag, "resource_name", getattr(ag, "name", "?"))
    dn = getattr(ag, "display_name", "?")
    print(f"  registered: {rn.split('/')[-1]}  | {dn}")
print(f"  total discoverable agents in registry: {len(regs)}")

print("\n=== SCALE / Agent Sessions — multi-turn persistence ===")
engine = agent_engines.get(ENGINE)
sess = engine.create_session(user_id=USER)
sid = sess["id"] if isinstance(sess, dict) else getattr(sess, "id", None)
print(f"  created session: {sid}")

def turn(msg):
    txt = []
    for ev in engine.stream_query(user_id=USER, session_id=sid, message=msg):
        for p in (ev.get("content") or {}).get("parts") or []:
            if p.get("text"):
                txt.append(p["text"])
            if p.get("function_call"):
                print(f"    [tool] {p['function_call'].get('name')}({dict(p['function_call'].get('args') or {})})")
    return " ".join(txt)[:200]

print("  turn 1 →", turn("Source beauty creators for the wooriliu campaign."))
print("  turn 2 (same session, refers back) →", turn("How many creators did you just return? Answer from our conversation."))

got = engine.get_session(user_id=USER, session_id=sid)
events = got.get("events") if isinstance(got, dict) else getattr(got, "events", [])
print(f"  get_session → {len(events)} events persisted across the 2 turns (proves Sessions state, not stateless)")
