# Recording Checklist — pre-OBS rig sanity

> **Audience**: the human operator who will press Record. Get the rig into the correct shape,
> then follow `STORYBOARD-track2.md` / `STORYBOARD-track3.md` mouse-click-by-mouse-click.
>
> **Authority**: implements **D30** (no slides, no narration overdub — every screen pixel must
> be the live system) + **D34** (CJK font fallbacks must be present at record time so subtitle
> burn-in lands cleanly). Companion to the existing `scripts/demo/record/pre-record-checklist.sh`
> (automated checks) and `scripts/demo/record/start-recording.sh` (OBS WebSocket trigger).
>
> **What this file adds** on top of the existing `pre-record-checklist.sh`: the human steps
> the script cannot verify — closing leak-prone apps, clearing browser PII, signing into the
> demo account, staging the smoke-test command in the right terminal pane, muting system
> sounds. Run this list **immediately before** running `pre-record-checklist.sh`.
>
> **Total time budget**: 30 minutes of human prep + 5 minutes of `pre-record-checklist.sh` =
> 35 minutes per recording day.

---

## 0. The day-of timeline

| Time | Action | Owner |
|---|---|---|
| T - 60 m | Reboot the recording Mac, log into the **fresh** OS user `demo-record` | human |
| T - 50 m | Walk through this RECORDING-CHECKLIST.md from §1 down | human |
| T - 20 m | `bash scripts/demo/record/pre-record-checklist.sh` (automated rig sanity) | human + script |
| T - 10 m | Open OBS, load profile `scripts/demo/obs/profile.json`, load scene `scene-track{2|3}.json` | human |
| T - 5 m | `bash scripts/demo/record/start-recording.sh` | human |
| T - 0 | Press Record in OBS (the WebSocket trigger above also works) | human |
| T → T + 16 m | Execute storyboard scenes 1-12 (target 15:30, hard cap 24:00) | human |
| T + 16 m | `bash scripts/demo/record/stop-recording.sh` | human |
| T + 16 m | `bash scripts/demo/record/post-record-checklist.sh` (automated) | script |

---

## 1. OS-level prep

- [ ] **Reboot.** Cold-boot the Mac. Background daemons (Slack autostart, Docker, Watchtower)
      should not fight for CPU mid-record.
- [ ] **Use the `demo-record` user account**, not your main one. This account has no Slack,
      no personal Chrome profiles, no Anthropic / OpenAI logins, no production GCP credentials.
- [ ] **Watchtower disabled**: ssh to `tiktok-mcp-staging` (or whatever runs Watchtower locally)
      and `docker stop watchtower`. Per the user's repo-root CLAUDE.md landmines list, an
      auto-pull-and-redeploy during a recording is a disaster. Restart Watchtower after the
      record is in the can.
- [ ] **Disable macOS Notifications** (System Settings → Notifications → "Do Not Disturb" on
      until 23:59 today). Calendar pings, Slack DMs, iMessage banners — all of these can ruin a
      take 14 minutes in.
- [ ] **Disable macOS dock auto-hide animations** (System Settings → Desktop & Dock → "Hide
      and show the Dock automatically" → OFF). The animation at 8× looks like a flicker.
- [ ] **Hide desktop icons** — `defaults write com.apple.finder CreateDesktop false &&
      killall Finder`. (Restore with `true` after.)
- [ ] **Set wallpaper to solid mid-grey** (`#3A3A3A`) so accidental window margins don't show
      personal photos.
- [ ] **Mute system sounds** — System Settings → Sound → Output volume → 0. OBS will capture
      audio from the chosen input device, not the system mix, but a stray UI ding still leaks
      if the input device sees it.
- [ ] **Plug in power.** A 24-minute screen-recording session can drain a laptop battery
      enough to trigger a low-power-mode framerate dip mid-take.

---

## 2. Display + cursor

- [ ] **Canvas: 2560×1440 @ 60fps**. Set Display settings → Resolution → Scaled → 2560×1440.
      OBS profile in `obs/profile.json` already targets 1920×1080 *output*, but the source
      capture at 2560×1440 gives ffmpeg room to crop without artifacts.
- [ ] **One external monitor only** (or laptop screen only). Multi-monitor breaks OBS scene
      framing — disconnect the second display.
- [ ] **Brightness: 75%** (not max — saves the eyes of judges watching in dark rooms).
- [ ] **True Tone: OFF** (the warming filter shifts the demo's red/green chips and confuses
      subtitle contrast detection).
- [ ] **Cursor highlight**: launch `mouseposé` (or `Cursor Highlighter`) with the settings
      called out in `scripts/demo/README.md` §2.2 — 40 px halo, `#FFD400` at 70% opacity, 0.3 s
      click flash. Confirm the highlight is visible by waving the cursor in front of OBS preview.
- [ ] **Keystroke overlay enabled**: bottom-center, 28 pt mono. The overlay should display the
      keys you press so subtitle-burn can sync to typing events.

---

## 3. Browser prep (Chrome `demo-record` profile)

- [ ] **Launch Chrome with a clean `demo-record` profile.** Not your main profile. Not Incognito
      (Incognito does not retain login between tab opens).
- [ ] **Clear browsing data** (Cmd+Shift+Del → All time → All checkboxes). Belt + suspenders;
      the fresh profile should already be empty.
- [ ] **Sign into the test account `app.2weeks@gmail.com`** (per D10 — operator-owned test
      account). Confirm by visiting `https://gmail.com` and seeing the inbox.
- [ ] **Sign into Mission Control** at `http://localhost:3000` using the same account. The
      dev sign-in button (`feat(sign-in): one-click dev login button` per the most recent
      commit at `8002692`) sets this up in one click.
- [ ] **Pre-stage the four tabs in the exact left-to-right order** specified in
      `STORYBOARD-track2.md` §0 (or `STORYBOARD-track3.md` §0).
- [ ] **Browser zoom 100%** on every tab — Cmd+0 to reset on each. The OBS canvas was sized for
      100% zoom; 90% creates whitespace, 110% chops off the right edge.
- [ ] **Disable Chrome extensions** in the `demo-record` profile — even the password manager.
      Extension toolbar icons sneak into screencaps and tend to leak email addresses.
- [ ] **Hide the bookmarks bar** (Cmd+Shift+B).
- [ ] **Hide the Chrome status bar** by hovering off all links before recording.

---

## 4. Terminal prep

- [ ] **Open iTerm2 (or Terminal.app), full-screen on the secondary scene**.
- [ ] **Use the `Solarized Dark` color scheme** — high contrast survives 8× compression best.
- [ ] **Font: SF Mono 18 pt** — large enough to read at 8×.
- [ ] **Window opacity: 100%** — no transparency. A blurred desktop behind the terminal is
      distracting at 8×.
- [ ] **For Track 2** — open two panes (left + right):
  - Left pane: `cd ~/Documents/GitHub/social-seeding-v2 && pnpm exec tsx scripts/run-demo.ts
    --type=brand` (do not press Enter yet — leave the command staged).
  - Right pane: `cd ~/Documents/GitHub/social-seeding-v2 && python
    scripts/smoke-test/brand_campaign_smoke.py` (staged but not run; Scene 12 presses Enter).
- [ ] **For Track 3** — open three panes (A/B/C per `STORYBOARD-track3.md` §0):
  - Pane A: `uv run mcp dev gcp-research/refactor-mcp/code/agent/src/tiktok_orchestrator/main.py`
    (Enter — leave the REPL running and idle).
  - Pane B: `gcloud run services logs tail tiktok-mcp-server --region=us-central1 --format
    'value(textPayload)'` (Enter — leave streaming).
  - Pane C: idle prompt, ready for the A2A client commands.
- [ ] **Clear scrollback** in every pane (Cmd+K). Old command history can leak production
      hostnames.
- [ ] **Stage the smoke test command** for Track 2 Scene 12: hit `python` then ↑ a few times
      so the command is in shell history and recallable with one ↑ press.
- [ ] **Pre-copy the long A2A client command** for Track 3 Scene 5 into clipboard if you don't
      trust ↑-recall. (Operator preference — typing is more authentic but slower; recall is
      faster and cleaner.)
- [ ] **Confirm the brief paragraph for Track 2 Scene 1 is on the clipboard** via `pbcopy <
      scripts/demo/assets/track2-scene1-brief.txt`. (If that file doesn't exist yet, create it
      with the brief from STORYBOARD-track2.md Scene 1 narrative — one paragraph.)

---

## 5. Local services (the live system must be live)

- [ ] **Mission Control dev server up** — `pnpm --filter @ss/web dev` in a separate persistent
      terminal (NOT one of the OBS-visible panes — keep it offscreen). Confirm `curl -fsS
      http://localhost:3000/api/healthz` returns 200.
- [ ] **MongoDB memory server up** — `pnpm run dev-mongo`. Stays in background.
- [ ] **Inngest dev server up** — `npx inngest-cli@latest dev`. Confirm
      `http://localhost:8288` loads.
- [ ] **Indexes provisioned** — `pnpm exec tsx scripts/init-indexes.ts` (idempotent).
- [ ] **For Track 3** — confirm Cloud Run service is healthy:
      `curl -fsS https://tiktok-mcp-server-<hash>-uc.a.run.app/healthz`. If it returns non-200,
      stop — `gcloud run deploy` first.
- [ ] **For Track 3** — confirm Gemini Enterprise tenant is set up with the demo workspace, and
      the agent isn't already registered (so Scene 3's "Register" click is real and not a
      re-registration toast).

---

## 6. OBS prep

- [ ] **Launch OBS Studio** with the recording profile loaded:
      `open -na OBS\ Studio --args --profile demo --collection track2` (or `track3`).
- [ ] **Verify scenes loaded**: Scene A (Full screen browser), Scene B (Mission Control
      zoomed), Scene C (Terminal split for Track 2 / Terminal × 3 for Track 3).
- [ ] **Verify output settings**: 1920×1080, 60 fps, x264 CRF 18, MKV container (per
      `obs/profile.json`).
- [ ] **Verify the cursor-highlight Lua plugin loaded**: Tools → Scripts → check for
      `cursor-highlight.lua`. If not listed, re-add via the Scripts dialog.
- [ ] **Audio**: per D30 we are **not narrating** during the record. Set the OBS audio mixer
      mic level to -∞ (mute) on the input device. The post-process pipeline will not emit
      audio at all; the final video is silent except for ambient UI sounds.
- [ ] **(D30 silent recording note)**: ambient UI sounds (button clicks, notification dings)
      that leak through system audio are also unwanted. Set "Desktop audio" to muted on the
      OBS mixer.
- [ ] **Confirm the WebSocket plugin is enabled** (Tools → WebSocket Server Settings →
      Enabled). Password matches `OBS_WEBSOCKET_PASSWORD` env var.
- [ ] **Save the OBS profile.json + scene-track{2|3}.json into the OBS config directory** if
      you haven't already (one-time per workstation):
      `cp scripts/demo/obs/*.json ~/Library/Application\ Support/obs-studio/basic/`.

---

## 7. Run the automated checklist

After every box above is checked:

```bash
bash scripts/demo/record/pre-record-checklist.sh
```

Read every `[NN] ok` line. If you see `[NN] FAIL`, stop and remediate before pressing Record.
A `[NN] warn` is acceptable but the operator must consciously decide to proceed.

---

## 8. Press Record

```bash
bash scripts/demo/record/start-recording.sh
```

Open the storyboard side-by-side with the browser. Execute Scenes 1 through 12 in order. Do not
go back. Do not re-shoot a single scene — if you flub, **stop the take, run `stop-recording.sh`,
delete the MKV, and start fresh**. The 8× compression cannot hide a backtrack; a clean run is
shorter than a patched one.

Pacing: each scene's "Real-time duration" in the storyboard is the wall-clock budget for that
scene. If you are >10 s slow on Scene 3, you will be 80 s slow by Scene 12.

---

## 9. Stop + post-record verify

```bash
bash scripts/demo/record/stop-recording.sh
bash scripts/demo/record/post-record-checklist.sh
```

If post-record checklist exits 0, the MKV is good. Hand it to the post-process pipeline:

```bash
bash scripts/demo/ffmpeg-8x.sh recording-track2-source.mov v2
# (or the longer path: scripts/demo/post-process/speed-8x.sh; ffmpeg-8x.sh
#  is the new operator-friendly one-shot wrapper that runs speed-8x +
#  overlay-burn + subtitle-burn for one locale in sequence)
```

---

## 10. Cleanup after the record

- [ ] **Re-enable Watchtower**: `docker start watchtower` on the host that runs it.
- [ ] **Re-enable macOS Notifications**.
- [ ] **Restore Desktop icons** (`defaults write com.apple.finder CreateDesktop true && killall
      Finder`).
- [ ] **Confirm the raw MKV is at `gcp-research/demo/raw/track{2|3}-source.mkv`** (the path
      the post-process scripts expect).
- [ ] **Make a backup copy** before running `ffmpeg-8x.sh` — `cp track{2|3}-source.mkv
      track{2|3}-source.backup.mkv`. Post-process scripts are idempotent but raw MKVs are
      irreplaceable.

---

## 11. Common failure modes (saw these once, don't repeat)

| Symptom | Cause | Fix |
|---|---|---|
| Cursor invisible at 8× | mouseposé didn't launch | Re-launch + redo §2 |
| Subtitles render boxes instead of CJK | Missing font in OBS render pipeline | `brew install --cask font-noto-sans-cjk-kr` + restart OBS |
| Mission Control returns 401 mid-record | Better-auth cookie expired | Sign in again to `app.2weeks@gmail.com`, retake |
| Gmail send Scene 4 → "Rate limited" | Test account hit Gmail send-per-day cap | Wait 24h or switch to staged-fake Gmail iframe |
| Cloud Run logs lag 30s during Scene 5 | Cold-start latency | Warm with a dummy call 60s before Scene 5 begins |
| OBS dropped 8 frames on Scene 6 | Multi-region replication kicked in during typing | Re-shoot; OBS-frame-drop > 4 is a re-shoot threshold per quality bar |
| Final video runtime is 3:18 instead of 3:00 | Real time exceeded 24:00 | `DEMO_SPEED=4` fallback OR trim Scene 4 hover dwell from 4 s to 2 s and retake |
| PII OCR scan flags a frame | Real email/phone visible in a hovered tooltip | Re-shoot with the tooltip not hovered |

**End of RECORDING-CHECKLIST.md.**
