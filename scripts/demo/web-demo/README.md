# Web Demo — `scripts/demo/web-demo/`

Self-contained interactive HTML replacement for the ffmpeg 8× recording. Plays
the full **Track 2 (Mission Control + AP2 + Multi-agent)** and **Track 3
(`tiktok-mcp-server`, A2A v0.3 + Gemini Enterprise)** storyboards as a
mouse-driven, time-synchronised walkthrough — same 12+12 scenes, same 4 locales,
same D29 angle attribution as the source storyboards.

## How to view

```bash
# 1. Open the file directly
open scripts/demo/web-demo/index.html              # macOS

# 2. Or serve it (optional — file:// works for everything here)
python3 -m http.server -d scripts/demo/web-demo 8000
# then visit http://localhost:8000/
```

It auto-plays Track 2 / Scene 1 on load. Tailwind is loaded from the Play CDN
(`cdn.tailwindcss.com`); all icons, fonts, JSON, and subtitles are inlined.

## Controls

| Control | Action |
|---|---|
| `▶ Play / ⏸ Pause` (or **Space**) | Toggle playback |
| `⟲ Restart` | Reset elapsed time to 0 and rebuild scenes |
| Track `Track 2 / Track 3` | Switch demo track (resets timeline) |
| Speed `0.5× / 1× / 2× / 4× / 8×` | Multiply playback rate |
| Locale `한국어 / EN / 日本語 / 中文` (or **1-4**) | Switch subtitle language |
| Scene jump `Scene 1..12` | Seek to a specific scene |
| **← / →** | Previous / next scene |

## What's inside

- `index.html` — one file, ~3 800 lines, ~135 KB. Contains:
  - Mocked Mission Control shell (sidebar / header / tab strip / content) for Track 2
  - Mocked GCP Cloud Console + Gemini Enterprise + terminal panes for Track 3
  - Per-scene keyframe timeline (cursor moves, click ripple, typing, modals, toasts)
  - Inline subtitle parser for the 4 `.srt` files
  - Playback engine on `requestAnimationFrame`

## D-ID provenance

- **D27** — AP2 Intent Mandate only; Cart/Payment Mandate stay read-only (Scene 2, Scene 8).
- **D29** — Three differentiation angles shown on every scene's angle badge:
  - `D29-A` Agent-as-function (Scenes 1, 3, 9, 11; Track 3 Scenes 4, 8)
  - `D29-B` KR-region-gap (Scenes 5, 7; Track 3 Scenes 1, 3, 6, 7, 9)
  - `D29-C` Multimodal + AP2 + Multi-agent (Scenes 2, 6, 8, 10; Track 3 Scenes 2, 5, 10, 11)
- **D30** — 8×-compressed real-mouse recording is the replaced artifact; this HTML
  reproduces the same compressed timeline (~3:00 per track) without ffmpeg.
- **D34** — Four locales (`ko / en / ja / zh-CN`) wired to the same subtitle cues
  as `scripts/demo/subtitles/track{2,3}-{ko,en,ja,zh-CN}.srt`.

## Limitations

- Backed by mock data — no live network calls. The on-screen Cloud Run URL,
  `agent.json` JSON-body, USD figures, and TikTok handles are illustrative.
- Designed for **1280 × 720** stage size; smaller windows scroll horizontally.
- Chromium / Safari / Firefox tested at desktop sizes. Mobile not a target.

## Files

```
scripts/demo/web-demo/
├── index.html        self-contained demo (auto-plays Track 2 Scene 1 on load)
├── README.md         this file
└── SCREENS.md        one-line summary of each rendered scene
```
