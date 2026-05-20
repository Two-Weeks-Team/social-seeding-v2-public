#!/usr/bin/env python3
"""One-shot REAL Imagen 4 generation for the I9 demo (D49 (a)).

Generates ONE brand image via Vertex AI Imagen 4 on `ss-v2-prod` and writes it
to `scripts/demo/web-demo/assets/generated-sample.png`. Run exactly once
(~$0.04). If the API call fails (IAM / quota / region), it exits non-zero and
leaves no file, so the caller can fall back to an honest SVG placeholder.

API format verified via Context7 (/googleapis/python-genai):
    client.models.generate_images(model="imagen-4.0-generate-001", ...)

Citations: D49(a) one real multimodal generation; D39 ($1,500 credits unlock
Imagen 4); matches packages/agents-adk .../tools/imagen_generate.py contract
(aspect 1:1, BLOCK_MEDIUM_AND_ABOVE, $0.04/image).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from google import genai
from google.genai import types

PROJECT = os.environ.get("IMAGEN_PROJECT", "ss-v2-prod")
LOCATION = os.environ.get("IMAGEN_LOCATION", "us-central1")
MODEL = os.environ.get("IMAGEN_MODEL", "imagen-4.0-generate-001")
OUT = Path(__file__).resolve().parent / "web-demo" / "assets" / "generated-sample.png"

PROMPT = (
    "minimalist Korean skincare serum bottle, soft beige background, "
    "premium beauty product photography, studio lighting, high detail, "
    "clean composition, no text, no logo"
)


def _client() -> genai.Client:
    """Build a Vertex AI genai client.

    Prefers Application Default Credentials. If none are present, falls back to
    an explicit OAuth token passed via the `GOOGLE_OAUTH_ACCESS_TOKEN` env var
    (populated from `gcloud auth print-access-token`) so a one-shot run works
    without writing an ADC file or touching gcloud config.
    """
    token = os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN", "").strip()
    if token:
        from google.oauth2.credentials import Credentials

        creds = Credentials(token=token)
        return genai.Client(
            vertexai=True, project=PROJECT, location=LOCATION, credentials=creds
        )
    return genai.Client(vertexai=True, project=PROJECT, location=LOCATION)


def main() -> int:
    print(f"[imagen] project={PROJECT} location={LOCATION} model={MODEL}")
    client = _client()
    resp = client.models.generate_images(
        model=MODEL,
        prompt=PROMPT,
        config=types.GenerateImagesConfig(
            number_of_images=1,
            aspect_ratio="1:1",
            include_rai_reason=True,
            output_mime_type="image/png",
            safety_filter_level="BLOCK_MEDIUM_AND_ABOVE",
        ),
    )
    if not resp.generated_images:
        print("[imagen] FAIL: no images returned (likely RAI block)", file=sys.stderr)
        for gi in (resp.generated_images or []):
            print(f"  rai_reason={getattr(gi, 'rai_filtered_reason', None)}", file=sys.stderr)
        return 2
    img = resp.generated_images[0].image
    data = img.image_bytes
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(data)
    print(f"[imagen] OK wrote {len(data)} bytes to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
