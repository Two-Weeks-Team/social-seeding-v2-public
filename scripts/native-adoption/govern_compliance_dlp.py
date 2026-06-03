"""Govern/Agent Compliance — Cloud DLP (Sensitive Data Protection) live PII
inspection on an agent-authored outreach draft, the gate that runs before any
external_send (gmail.send) leaves the fleet."""
import os
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/ae-key.json"
from google.cloud import dlp_v2

PROJECT = "ss-v2-prod"
client = dlp_v2.DlpServiceClient()
parent = f"projects/{PROJECT}/locations/global"

# A realistic agent-authored outreach draft that accidentally embeds PII.
draft = (
    "Hi @_alejandrauve! Loved your latest skincare reel. We'd love to send you the "
    "wooriliu 2nd drop. Reply to maria.ops@2weeks.co or text +1 415 555 0199 and our "
    "lead Maria Gonzalez will coordinate shipping. Payout via Stripe Connect."
)

inspect_config = {
    "info_types": [
        {"name": "EMAIL_ADDRESS"},
        {"name": "PHONE_NUMBER"},
        {"name": "PERSON_NAME"},
    ],
    "include_quote": True,
    "min_likelihood": dlp_v2.Likelihood.POSSIBLE,
}

print("=== GOVERN / Agent Compliance — Cloud DLP inspect_content (live) ===")
print("  draft (agent-authored outreach):")
print("   ", draft[:120], "...")
resp = client.inspect_content(
    request={
        "parent": parent,
        "inspect_config": inspect_config,
        "item": {"value": draft},
    }
)
findings = resp.result.findings
print(f"\n  DLP findings (would block/redact before external_send): {len(findings)}")
for f in findings:
    print(f"   - {f.info_type.name:14s} likelihood={f.likelihood.name:9s} quote={f.quote!r}")
print("\n  → Compliance gate: any finding ≥ POSSIBLE routes the send to redaction/human review (staged autonomy).")
