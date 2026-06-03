"""Update engine 2498295477225652224 in place with the logging-enabled callbacks."""
import os

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/ae-key.json"
os.environ["GOOGLE_CLOUD_LOCATION"] = "global"
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"

import vertexai
from vertexai import agent_engines
from ae_deploy.agent import root_agent

ENGINE = "projects/722660901814/locations/us-central1/reasoningEngines/2498295477225652224"

vertexai.init(project="ss-v2-prod", location="us-central1",
              staging_bucket="gs://ss-v2-prod-agent-engine")

app = agent_engines.AdkApp(agent=root_agent, enable_tracing=True, app_name="ss-recall")
engine = agent_engines.get(ENGINE)
updated = engine.update(
    agent_engine=app,
    requirements=[
        "google-adk==1.34.1",
        "google-cloud-aiplatform[agent_engines]==1.154.0",
        "google-genai==1.75.0",
    ],
    extra_packages=["ae_deploy"],
    service_account="ss-agent-runtime@ss-v2-prod.iam.gserviceaccount.com",
    env_vars={
        "GOOGLE_CLOUD_LOCATION": "global",
        "GOOGLE_GENAI_USE_VERTEXAI": "True",
        "MEMORY_BANK_ENGINE_ID": "1587442452589969408",
        "MEMORY_APP_NAME": "ss-recall",
        "MEMORY_BANK_LOCATION": "us-central1",
    },
)
print("UPDATED:", updated.resource_name)
