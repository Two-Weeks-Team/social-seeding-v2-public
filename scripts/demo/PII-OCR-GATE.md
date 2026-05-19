# PII OCR Gate — pre-upload sanitization for the demo videos

> **Authority**: implements **D10** (Gmail demo: send only to operator-owned test accounts) +
> **D20** (DLP automatic redaction for logs/PII) + **D33** (PII 30 d retention) per
> `gcp-research/decisions/DECISIONS.md`, plus the response-spec for edge case **EC-7.01**
> (`gcp-research/edge-cases/CATALOG.md` — "8× recording captures sensitive PII in passing").
>
> **Audience**: the operator preparing to upload to YouTube, and any future agent that needs
> to extend the gate with new PII regex patterns.
>
> **TL;DR**: before any of the 8 final MP4s (2 tracks × 4 locales) leaves the laptop, the
> PII OCR gate runs Cloud Vision OCR — or local tesseract as a credentials-free fallback —
> over every frame, scans the recognized text against a curated regex set, and **blocks the
> upload** if any frame contains real email addresses, phone numbers, KR RRNs, production
> API keys, or production hostnames. Detection is per-frame with bounding-box output, so
> remediation is either (a) re-record the affected scene or (b) blur-redact the bounding box
> via `pii-redact.sh`.

---

## 1. Why this gate exists

At 8× playback speed, a 0.5 second exposure of a tooltip or autocomplete dropdown is
compressed to 0.0625 seconds — about 4 frames at 60 fps. The human reviewing the take will
miss it. A careful judge **with the YouTube speed-control slider** will not. The
embarrassment surface includes:

- A real email address shown in a Gmail autocomplete dropdown.
- A real phone number rendered inside a tooltip on a "view contact" hover.
- A Korean resident registration number (RRN) shown anywhere — RRNs are PIPA-regulated.
- A production GCP project ID prefix (`ss-prod-` vs the demo-allowed `ss-v2-prod-`).
- A production database hostname or Spanner instance ID.
- An Anthropic / OpenAI / Google API key prefix that leaked into a terminal scrollback.

Per **D10**, the test account `app.2weeks@gmail.com` is **the one address that is allowed
to appear on screen**. Everything else must be either (a) absent, (b) blurred, or (c) the
recording is unshippable.

---

## 2. What the gate does

The gate is a two-stage pipeline:

```
final/track2-en.mp4  ─┐
final/track2-ko.mp4   │
final/track2-ja.mp4   │         ┌── pii-report.json  (frame ts + bbox + matched pattern)
final/track2-zh-CN.mp4│  scan   │
final/track3-en.mp4   │  ──>    ├── exit 0  → green to upload
final/track3-ko.mp4   │         └── exit 1  → human must intervene
final/track3-ja.mp4   │
final/track3-zh-CN.mp4│
                      │  remediate (one of):
                      │   (a) re-record the affected scene from the storyboard
                      │   (b) pii-redact.sh  → blur the bounding box, re-render the locale
                      ▼
                  upload-youtube.sh (gated; refuses to run if pii-report.json is dirty)
```

**Stage 1 — Frame extraction + OCR** (`scripts/demo/post-process/pii-ocr-scan.sh`, already
authored). Uses `ffmpeg` to extract 1 frame per second from each final MP4 (180 frames per
3-minute video × 8 final MP4s = 1,440 frames total), then runs OCR. Two OCR backends:

- **Preferred — Cloud Vision API** (`gcloud ai vision text-detect`, when
  `VISION_API_ENABLED=1`). Uses the project's existing DLP/Vision setup per D20. Best
  accuracy for CJK locales.
- **Fallback — local tesseract** (`tesseract <frame.png> - -l eng+kor+jpn+chi_sim`). No
  cloud dependency; works at recording-day rural-internet speeds. Slightly lower CJK
  accuracy.

The scanner emits `gcp-research/demo/work/${track}-pii-report.json` with this shape:

```json
{
  "track": "v2",
  "scanned_at": "2026-06-01T15:30:00Z",
  "frames_total": 720,
  "matches": [
    {
      "locale_mp4": "submission/v2-final-en.mp4",
      "timestamp_s": 47.5,
      "frame_path": "work/v2-frames/v2-en-00047.png",
      "pattern": "email_real",
      "matched_text": "<redacted in report — see local copy>",
      "bbox": { "x": 1340, "y": 220, "w": 280, "h": 38 }
    }
  ],
  "verdict": "BLOCK"   // or "OK" if matches is empty
}
```

**Stage 2 — Remediation** (`scripts/demo/pii-redact.sh`, this folder). Reads the report,
and for each match either:

- **Re-record** the storyboard scene that contains the timestamp (operator decision).
- **Blur-redact** the bounding box in-place, then re-render that locale's MP4.

The redact path is the fallback; per `gcp-research/edge-cases/CATALOG.md` EC-7.01 the
preferred response is re-record-and-re-render, **not** post-hoc blur. Blur is a tactical
escape valve, not the norm.

---

## 3. The regex set

The scanner reads patterns from `scripts/demo/post-process/.pii_patterns.txt` (one regex per
line) and an allowlist from `scripts/demo/post-process/.pii_allowlist.txt`. Both are
.gitignore'd; the operator maintains them locally.

Default patterns (sourced from `scripts/demo/post-process/pii-ocr-scan.sh` header docstring):

| Pattern key | Regex (Python `re` syntax) | Why |
|---|---|---|
| `email_real` | `[a-zA-Z0-9._%+-]+@(?!gmail\.com.*test.*)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` | Any email not in the allowlist |
| `phone_e164` | `\+\d{6,15}\b` | E.164 phone, 6-15 digits |
| `phone_kr_mobile` | `(?:010|011|016|017|018|019)[-.\s]?\d{3,4}[-.\s]?\d{4}` | KR mobile |
| `rrn_kr` | `\b\d{6}[-]?[1-4]\d{6}\b` | Korean RRN (PIPA-sensitive) |
| `cc_visa_mc` | `\b(?:4\d{3}|5[1-5]\d{2})[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b` | Visa / MasterCard |
| `gcp_project_prod` | `\bss-prod-[a-z0-9-]+\b` | Production project IDs |
| `api_key_anthropic` | `\bsk-ant-[A-Za-z0-9_-]{20,}` | Anthropic key prefix |
| `api_key_openai` | `\bsk-[A-Za-z0-9]{20,}` | OpenAI key prefix |
| `api_key_google` | `\bAIza[0-9A-Za-z_-]{30,}` | Google API key |
| `aws_key` | `\bAKIA[0-9A-Z]{16}\b` | AWS access key |

Allowlist patterns (these will NOT trigger the gate):

| Pattern key | Regex |
|---|---|
| `email_demo` | `app\.2weeks@gmail\.com` |
| `email_creator_persona` | `(?:khaby|charli|addison|james|loren)\..*@gmail\.com` |
| `gcp_project_demo` | `\bss-v2-prod-[a-z0-9-]+\|ss-mcp-prod-[a-z0-9-]+\b` |
| `workspace_demo` | `\bws_42\|demo-(kr\|us\|eu)\b` |

---

## 4. Workflow on a clean scan

```bash
# After ffmpeg-8x.sh finishes both tracks:
bash scripts/demo/post-process/pii-ocr-scan.sh v2
bash scripts/demo/post-process/pii-ocr-scan.sh mcp

# Both exit 0 → upload
bash scripts/demo/youtube-upload.sh 2 en
bash scripts/demo/youtube-upload.sh 3 en
```

---

## 5. Workflow on a dirty scan

```bash
# Scanner returns 1, writes work/v2-pii-report.json
$ bash scripts/demo/post-process/pii-ocr-scan.sh v2
[pii-ocr] 720 frames scanned
[pii-ocr] 3 matches found:
[pii-ocr]   - submission/v2-final-en.mp4 @ 47.5s — pattern=email_real, bbox=(1340,220,280,38)
[pii-ocr]   - submission/v2-final-en.mp4 @ 47.5s — pattern=email_real, bbox=(1342,220,278,38)
[pii-ocr]   - submission/v2-final-ko.mp4 @ 47.5s — pattern=email_real, bbox=(1340,220,280,38)
[pii-ocr] VERDICT: BLOCK — DO NOT UPLOAD
[pii-ocr] report: gcp-research/demo/work/v2-pii-report.json

# Operator inspects work/v2-frames/v2-en-00047.png and decides:
# - Option A: re-record Scene 4 (47.5 s × 8 = 380 s real-time → Scene 4 outreach drafts)
# - Option B: blur-redact in-place

# Option A — re-record from the storyboard. Cleanest, preferred.
#   1. Edit RECORDING-CHECKLIST.md §3 — check that Gmail autocomplete has been cleared.
#   2. Re-shoot Scene 4 in isolation, OR re-shoot the entire 24-min source if multiple
#      scenes leak (cheaper than splicing).
#   3. Re-run scripts/demo/ffmpeg-8x.sh.

# Option B — blur the bounding box and re-render only the affected locale.
bash scripts/demo/pii-redact.sh v2 --apply-report

# Re-scan to confirm clean.
bash scripts/demo/post-process/pii-ocr-scan.sh v2
# verdict: OK → upload
```

---

## 6. The `pii-redact.sh` helper

`scripts/demo/pii-redact.sh` reads `work/${track}-pii-report.json` and, for each match,
applies a `boxblur` ffmpeg filter at the bounding-box coordinates. It uses ffmpeg's
`drawbox` + `boxblur` filter chain so the original pixels are gaussian-averaged inside the
box but the surrounding frame is untouched.

**Filter at a glance** (one per match — chained per locale):

```
[in]crop=W:H:X:Y[redact];[redact]boxblur=20[blurred];[in][blurred]overlay=X:Y[out]
```

The script writes the redacted MP4 to `submission/${track}-final-${locale}.redacted.mp4`,
then moves it over the original on operator confirmation.

**Usage**:

```bash
# Apply every match in the report:
bash scripts/demo/pii-redact.sh v2 --apply-report

# Apply only matches for one locale:
bash scripts/demo/pii-redact.sh v2 --apply-report --locale en

# Manual one-shot — redact a specific box on a specific frame range:
bash scripts/demo/pii-redact.sh v2 --locale en \
  --start-s 47.0 --end-s 48.0 \
  --x 1340 --y 220 --w 280 --h 38
```

---

## 7. Operational invariants

- **Retention** (D33): the dirty MP4 and the PII report stay in `gcp-research/demo/work/`
  for 30 days max. After that the operator must `rm -rf` the work dir. The clean
  submission MP4s stay indefinitely.
- **Audit trail**: every gate run appends a row to `gcp-research/demo/work/.audit/
  pii-scan-${ts}.jsonl` — date, track, verdict, match count, operator. Per D33 audit logs
  retain 90 days.
- **No automatic redact**: `pii-redact.sh` requires `--apply-report` (or the explicit box
  args) — it never edits MP4s based on its own heuristic. This is by design per EC-7.01
  ("sanitize via re-render, never via opaque auto-paint").
- **No PII content in this gate's own logs**: the matched text is stored in
  `${track}-pii-report.json` (local-only); the stdout log redacts it.

---

## 8. Cross-references

- D10 (Gmail demo to test accounts) → `gcp-research/decisions/DECISIONS.md` line 49
- D20 (DLP automatic redaction) → `gcp-research/decisions/DECISIONS.md` line 74
- D33 (data lifecycle 30/90/14 d) → `gcp-research/decisions/DECISIONS.md` line 102
- EC-7.01 (8× recording captures PII) → `gcp-research/edge-cases/CATALOG.md`
- Scanner script → `scripts/demo/post-process/pii-ocr-scan.sh`
- Redact helper → `scripts/demo/pii-redact.sh`
- Quality bar (cannot ship if dirty) → `scripts/demo/README.md` §8

**End of PII-OCR-GATE.md.**
