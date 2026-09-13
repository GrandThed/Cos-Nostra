# Handoff: Cos Nostra desktop clipper UI

## Overview
Full UI/UX redesign of Cos Nostra, a Windows 11 system-tray game clipper for one Discord community. Replaces the old 480×360 four-tab window with a resizable app (default 1120×720, min 720×520): a by-game clip library, an in-app player that doubles as the clip-detail view, Storage, Settings, a live capture-status pill + panel, and a three-step first run.

## About the Design Files
The file in this bundle (`Cos Nostra UI.dc.html`) is a **design reference created in HTML** — a canvas of annotated screen mockups, not production code. The task is to **recreate these screens in the target codebase**: a Tauri 2 / WebView2 app built with plain HTML/CSS/TypeScript, **no React**. Every component here was drawn to be hand-buildable (one element + a class each).

## Fidelity
**High-fidelity.** Colors, type, spacing, radii and copy are final. Recreate pixel-perfectly, but implement light/dark as one token set switched by `prefers-color-scheme` (the mock shows both).

## Navigation model
- Three tabs in a segmented pill: **Library · Storage · Settings**.
- **Capture status is not a tab**: a live pill in the toolbar (● Recording · <game>) always visible; clicking opens a status popover (board 1h). Errors (recorder failed / hotkey taken / ffmpeg missing) also stack as banners under the toolbar on every tab.
- The **player is a detail view inside Library** (board 1e), with Prev/Next within the current game/filter.
- Window: default 1120×720, min 720×520. Clip grid `repeat(auto-fill, minmax(196px,1fr))`; below ~840px the game sidebar folds into an "All games ▾" dropdown and cards become rows (board 1j).

## Screens (board ids in the HTML file)
- **1a** Rationale text board (context only).
- **1b** Library by game, dark, 1120×720: 224px sidebar (search, "Recent — all games", game list with counts, dashed "Unknown game · fix" item, storage footer link), main = game header (name, count · size, "Rename / merge game… NEW" chip, sort, filter chips: Not uploaded / Failed / On the site only / Still on this PC) + 4-col card grid showing every pipeline state.
- **1c** Same screen, light, at 880px (3-col grid proves resize).
- **1d** Recent cross-game view: day-grouped grid (Tonight / Yesterday), game name as card title, search matches game name or original window title.
- **1e** Player/detail, dark: video area (streaming banner variant for released clips), scrubber with hover thumbnail, controls (play, time, frame step, volume, speed, Loop, fullscreen), keyboard hint row (Space, ←/→ 5s, J/K/L, ,/. frame, M, F), dashed **FUTURE trim strip** with in/out handles; right rail 300px = editable game name, original window title, status badge, metadata grid (recorded, length, resolution/fps, sizes), Copy link (primary), Open folder (disabled for released), Delete everywhere.
- **1f** Storage, dark: headline (used GB · clip count · free space · Open folder), stacked per-game bar (top 7 + "N more games" + "Other files") with legend, 5 file-kind stat cards, "Where clips live" bar (On the site vs Only on this PC), three Free-up-space cards (normal / armed-confirm amber / disabled "Nothing to free") + result line, Keep-it-in-check card (delete-original checkbox, GB cap input, over-limit warning, Save + Saved).
- **1g** Settings, light, 2×2 card grid: Capture (hotkey capture shown mid-press "Ctrl+Shift+…", buffer length 5–300s, clip folder + Browse), Behaviour (4 toggles incl. encode-while-gaming with tradeoff copy), Encoding (quality radio cards with size hints, Processor/GPU radio cards, Advanced: bitrate 2000–60000, backend URL), Account & uploads (Discord identity, Log out, auto-upload toggle, save feedback states).
- **1h** Status panel popover: 3 stacked error banners + conflict warning, key/value rows (buffer, capturing, encoders + Probe again, hotkey/buffer, folder, account "(uploads off)"), Save clip now + last result, "refreshes every 5s".
- **1i** First launch, 3 centered cards: runtime download progress → encoder probe checklist → Discord device code (large mono code, waiting spinner, 10-min timeout, fallback URL, Cancel / Skip).
- **1j** 760×540 compact mode.
- **1k** Component inventory: buttons (Primary/Quiet/Danger/Disabled), confirm-on-second-click (Delete → solid red "Confirm delete", re-arms after 3s), inline rename (dashed underline + ✎ → bordered input, Enter/Esc, empty = Unknown game), empty library state, all 9 status badges, hotkey-capture states (idle/listening/needs-modifier/taken), Windows toasts (saved / not saved / uploaded / first-close tray hint), tray menu (Save clip / Open / Quit).
- **1l** Traceability map: every legacy function → its new home.

## Status badges (pill, 11px 600, colored text on --panel2)
Saved (mut) · Waiting "encodes when you stop playing" (mut) · Encoding ·N% (warn) · Ready (ink; terminal when uploads off) · Uploading ·N% (info) · Retrying ·n/5 (warn, hover shows attempt error) · On the site (ok) · Failed / Upload failed (err, + Retry) · On the site only (rel; released — no Open folder, keeps Copy link, player streams from site).

## Design tokens
Fonts: **Bricolage Grotesque** 500–700 (headings, game names), **Rubik** 400–600 (UI), **JetBrains Mono** 400/600 (times, sizes, paths, hotkeys). Base UI size 13px; radii 8–10px cards, 999px pills; toolbar 54px; titlebar 38px.

Light: --bg #f5f0e5 · --panel #fdfaf2 · --panel2 #ebe3cf · --ink #2b241a · --mut #6f6553 · --line #ddd3bd · --acc #b04a28 · --accInk #fff8f0 · --ok #237a4b · --warn #8a6210 · --info #3763a8 · --err #b23a28 · --rel #655399

Dark: --bg #16130f · --panel #1e1a15 · --panel2 #292217 · --ink #f1eadb · --mut #b0a48d · --line #37301f · --acc #e2794f · --accInk #231204 · --ok #5fc98b · --warn #e6b656 · --info #84abe8 · --err #ee7f66 · --rel #b9a7e8

Storage bar palette (theme-independent): #c96a3f #8f9a54 #4f8a96 #9a6f9a #b8963f #6f7fb8 #7a9a6f #8a7f6f #5a5248.

## Interactions & behavior
- Recording dot pulses (opacity 1→0.3, 1.8s loop). Status refresh: 5s poll + push events (status-changed, clip-saved, clips-changed).
- Destructive actions: two-click confirm, second state solid err/warn, re-arms after 3s.
- Hotkey capture: focusable, Enter starts listening, shows held modifiers live, requires modifier or F-key, Esc cancels; save re-registers and reports conflicts.
- Player keys: Space, ←/→ 5s, J/K/L, ,/. frame step, M mute, F theatre. Prefer local H.264; stream from site for released clips (show banner); play original before encode finishes.
- Close hides to tray (one-time toast explains); Quit only in tray menu; single instance focuses existing window.
- Trim strip is FUTURE scope — build the reserved space only.

## Assets
Clip thumbnails in the mock are gradient placeholders — real ones are 640px 16:9 JPEGs from the backend. Mascot: hand-drawn smiley blob (existing app icon); mock approximates it with a CSS blob.

## Files
- `Cos Nostra UI.dc.html` — all boards (open in a browser; ids 1a–1l anchor each board).
