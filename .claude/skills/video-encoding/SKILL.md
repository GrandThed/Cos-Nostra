---
name: video-encoding
description: ffmpeg commands and presets used by Cos Nostra for probing hardware encoders, trimming, encoding clips to AV1 and H.264, thumbnails, loudness normalization and concatenating the yearly compilation. Use when writing or debugging any ffmpeg invocation in the desktop queue or the recap worker.
---

# Video encoding

Targets: one AV1 MP4 with Opus for size, one H.264 MP4 with AAC for Discord attachments and old devices, one JPEG thumbnail. Encoding runs on the player's machine at below-normal priority.

## Probe available hardware AV1 encoders

Try in this order and keep the first that exits 0. Cache the answer in settings.

```
ffmpeg -v error -f lavfi -i testsrc2=size=1280x720:rate=60 -t 2 -c:v av1_nvenc -f null -
ffmpeg -v error -f lavfi -i testsrc2=size=1280x720:rate=60 -t 2 -c:v av1_amf   -f null -
ffmpeg -v error -f lavfi -i testsrc2=size=1280x720:rate=60 -t 2 -c:v av1_qsv   -f null -
```

If all fail, use `libsvtav1`. `ffmpeg -encoders | findstr av1` lists what the build contains. The winget build on the dev machine has all four.

## Where this lives in the app

`apps/desktop/src-tauri/src/ffmpeg.rs` holds every invocation (`probe_encoders`, `probe`, `encode_av1`, `encode_h264`, `thumbnail`); `queue.rs` drives them from the worker thread and `lib.rs::process_clip` chooses output names. `cargo test ffmpeg -- --nocapture` runs a real end-to-end encode on a generated sample and prints the probe result. Measured on the dev machine: probe 1.2 s total (nvenc fails in ~150 ms, amf passes in ~500 ms), a 29 s 1080p60 clip encodes in 7.5 s to AV1 and 6.5 s to H.264 on AMF.

The AV1 preset was retuned on 2026-09-10 after AV1 came out bigger than the H.264 fallback: AMF quantizers run 0-255, so the old `-qp_i 28` was asking for near-lossless. See "Where the AV1 numbers come from" below for the measurements and for why `testsrc2` must never be used to judge a preset.

## Presets

> **Superseded for the desktop clip queue.** These are the raw command shapes and the AMF
> quantizer-scale warning, which still hold. What the app actually runs is chosen by the
> Settings quality level and the CPU/GPU engine picker — see "The presets, and how they were
> chosen" below, which supersedes the single hardware preset this section describes. The recap
> worker in phase 5 still uses the shapes here directly.

Measured on the dev machine (RX 9060 XT, Ryzen 5 5500) on a 28 s 1080p60 clip: `av1_amf` 7 s,
`libsvtav1 -preset 8` 13 s.

**AMF's quantizer scale is 0-255, not 0-51.** This is the single most expensive thing on this
page. `av1_amf -qp_i 28` is not "CRF 28", it is near-lossless, and it made AV1 files about twice
the size of the H.264 fallback on real gameplay. 95 is the measured replacement. NVENC's `-cq`
and QSV's `-global_quality` really are 0-51, so 28 is correct there and stays.

AV1, hardware (AMF shown; NVENC uses `-cq 28 -preset p5`, QSV uses `-global_quality 28`):

```
ffmpeg -y -ss <in> -to <out> -i src.mp4 \
  -c:v av1_amf -quality quality -rc cqp -qp_i 95 -qp_p 95 -g 120 \
  -c:a libopus -b:a 128k -movflags +faststart av1.mp4
```

AV1, software:

```
ffmpeg -y -ss <in> -to <out> -i src.mp4 \
  -c:v libsvtav1 -preset 8 -crf 34 -g 120 -svtav1-params tune=0 \
  -c:a libopus -b:a 128k -movflags +faststart av1.mp4
```

H.264 fallback (hardware where present, else `libx264 -preset veryfast -crf 23`):

```
ffmpeg -y -ss <in> -to <out> -i src.mp4 \
  -c:v h264_amf -quality quality -rc vbr_peak -b:v 8M -maxrate 12M -g 120 \
  -c:a aac -b:a 160k -movflags +faststart h264.mp4
```

Thumbnail at 25 percent of the duration:

```
ffmpeg -y -ss <dur*0.25> -i src.mp4 -frames:v 1 -vf scale=640:-2 -q:v 4 thumb.jpg
```

Put `-ss` and `-to` before `-i` so seeking happens on input and unused footage is never decoded.

## Where the AV1 numbers come from

Measured 2026-09-10 on the dev machine. Source: a 27.3 s 1080p60 capture of real FPS gameplay
(scope, HUD, minimap, camera pans) taken through the app's own replay buffer, 68.9 MB at
20.2 Mbps — the same kind of file the queue actually encodes. Quality is VMAF against that
source (`libvmaf n_threads=6 n_subsample=3`), so it measures the re-encode loss only. **Judge
presets on footage like this, never on `testsrc2`**: the synthetic pattern is pathological and
gave the opposite answer, and a game's own loading or queue screen is nearly static and
flatters AV1 just as badly in the other direction.

| preset | size | bitrate | encode | VMAF |
|---|---|---|---|---|
| `h264_amf` 8M vbr_peak — the fallback, and the bar to beat | 27.2 MB | 7.97 Mbps | 6.7 s | 94.72 |
| `av1_amf -qp_i 28` — what shipped before, on the 0-255 scale | 53.1 MB | 15.55 Mbps | 7.5 s | 97.42 |
| `av1_amf` cqp 85 | 20.3 MB | 5.94 Mbps | 7.1 s | 94.42 |
| `av1_amf` cqp 90 | 19.4 MB | 5.69 Mbps | 9.4 s | 94.16 |
| **`av1_amf` cqp 95 — chosen** | **18.5 MB** | **5.43 Mbps** | **7.1 s** | **93.85** |
| `av1_amf` cqp 100 | 17.1 MB | 5.00 Mbps | 7.5 s | 93.23 |
| `av1_amf` cqp 120 | 13.0 MB | 3.81 Mbps | 7.6 s | 90.74 |
| `av1_amf` cqp 160 | 7.2 MB | 2.10 Mbps | 11.0 s | 81.15 |
| `av1_amf -rc qvbr -qvbr_quality_level 34` | 21.0 MB | 6.14 Mbps | 19.1 s | 93.66 |
| `av1_amf -rc vbr_peak -b:v 5M -maxrate 8M` | 17.4 MB | 5.09 Mbps | 7.0 s | 93.67 |
| `libsvtav1 -preset 8 -crf 34` — the software fallback | 18.7 MB | 5.48 Mbps | 17.9 s | 94.49 |

cqp 95 is **32 percent smaller than the H.264 fallback** with a 0.87 VMAF gap, which is far
below the roughly 6-point just-noticeable difference at this quality. It is also 65 percent
smaller than the old qp 28 output.

Knobs that were measured and rejected, all at cqp 90:

- `-quality high_quality` (18.9 MB, VMAF 94.14, **20.3 s**): three times the encode time to save
  half a megabyte. `-quality quality` stays.
- `-aq_mode caq` (17.3 MB, VMAF 92.81): sits *below* the plain cqp curve — cqp 100 is the same
  size at a higher score. Do not enable it.
- `-preanalysis true` (19.4 MB, VMAF 94.18): identical output, no reason to pay for it.
- `-rc qvbr` at any level: 2.5x slower than cqp and on a worse curve. Note its
  `-qvbr_quality_level` is a *quality* level (higher is better), the opposite direction from a QP.
- `-rc vbr_peak` looks competitive on gameplay but targets a bitrate, so it wastes bits on easy
  footage: on the static clip below it spent 3.0 MB where cqp 95 spent 1.6 MB at a similar score.
  Constant quality is what a clipper wants, because clip content varies wildly.

Two more content types, to show the preset is not tuned to one clip:

| content | `h264_amf` 8M | `av1_amf` cqp 95 | old qp 28 |
|---|---|---|---|
| static game queue screen, 26.1 s | 14.6 MB (VMAF 97.08) | **1.6 MB** (94.51) | 5.4 MB (96.83) |
| desktop and browser, 26.4 s | 8.1 MB (97.23) | **2.5 MB** (95.77) | 4.3 MB (96.97) |

The desktop row is also the end-to-end check: the app's own queue encoded that clip to
2,510,643 bytes of AV1 against 8,136,685 of H.264, and re-running the same source through the
harness with cqp 95 reproduced 2.5 MB while qp 28 gave 4.3 MB — so the app really is using the
new arguments, not just the harness.

**NVENC and QSV were not measured.** This is an AMD machine; `av1_nvenc` and `av1_qsv` keep 28
on their native 0-51 scales, stay behind `probe_encoders`, and want the same treatment on a
machine that has them. Audio is excluded from every size above (the sources here carry AAC that
both branches re-encode); in production add roughly 0.5 MB per 30 s for Opus 128k and 0.6 MB for
AAC 160k.

## The presets, and how they were chosen

Measured 2026-09-11 with `apps/desktop/scripts/bench-encoders.mjs`, which is committed and
resumable — run it on any new machine rather than trusting the numbers below. Corpus: three real
1080p60 captures off this machine's replay buffer, chosen to span difficulty rather than to
flatter anything.

| clip | content | why it is in the corpus |
|---|---|---|
| easy | desktop and a browser, 26.4 s | nearly static; flatters AV1 |
| medium | Wardogs, 29.7 s | ordinary gameplay |
| hard | Wardogs high motion, 28.3 s | the clip that produced a 56 MB AV1 and started this |

Five findings, in the order they change decisions:

1. **`libsvtav1` beats `av1_amf` decisively, and AMD's AV1 barely beats AMD's own H.264.** On
   the hard clip at matched size, `libsvtav1 p6 crf 40` scored **93.43 at 30.6 MB** where
   `h264_amf` scored 88.54 at 30.8 MB and `av1_amf` interpolates to roughly 89.3. Hardware AV1
   is the *fast* option, not the good one. Encoding runs after the game exits, so software is
   the default.
2. **A bitrate ceiling is a terrible way to reach a size.** Clamping crf 34 to 5 Mbps gave 85.21
   at 17.0 MB; simply asking for crf 46 with no clamp at all gave **90.94 at 20.3 MB**. Pick the
   CRF for the quality you want and set `-maxrate` as a safety net that ordinary clips never
   touch. Every shipped level is capped CRF in that spirit.
3. **SVT preset only matters when the ceiling binds.** At a 5 Mbps cap, p8 → p6 → p4 went
   77.90 → 83.13 → 85.21. Where the cap never engages all three land within 0.1 VMAF. Since
   the shipped ceilings are set not to bind, **preset 6** is the choice: p4 would double the
   encode time to buy almost nothing.
4. **AMF's quality-VBR modes are worse than its own plain cqp.** `av1_amf -rc qvbr 28 @5M`
   scored 86.82 at 31.1 MB against cqp 128's 88.22 at 26.9 MB, and `h264_amf -rc qvbr 24 @8M`
   collapsed to 77.26. Do not reach for qvbr on AMF. That is also why the GPU path has no
   ceiling at all: there is no usable capped mode, so choosing the graphics card means giving
   up predictable sizes.
5. **A 5 s GOP is worth about 2 VMAF under a binding cap** (85.55 against 83.13 at 5 Mbps, for
   7 percent more size). Not applied: `-g 120` keeps seeking and phase 6 trimming cheap, and
   the effect disappears once the ceiling stops binding. Worth revisiting if trimming moves to
   stream copy.

What ships, per level, all `libsvtav1 -preset 6` plus `libx264 -preset medium`:

| level | AV1 | H.264 |
|---|---|---|
| Smaller files | `-crf 46 -maxrate 8M` | `-crf 26 -maxrate 8M` |
| Balanced (default) | `-crf 40 -maxrate 12M` | `-crf 22 -maxrate 12M` |
| Best quality | `-crf 34 -maxrate 20M` | `-crf 19 -maxrate 20M` |

Measured at Balanced against what shipped before (`av1_amf` cqp 95 and `h264_amf` 8M vbr_peak):

| clip | AV1 before | AV1 after | H.264 before | H.264 after | total bytes |
|---|---|---|---|---|---|
| easy | 2.4 MB / 95.77 | 2.7 MB / **97.26** | 7.7 MB / 97.23 | **4.1 MB** / 96.21 | −33% |
| medium | 1.2 MB / 94.50 | 5.6 MB / **96.96** | 14.5 MB / 97.11 | **6.8 MB** / 96.50 | −21% |
| hard | 53.2 MB / 94.02 | **25.9 MB** / 91.84 | 30.8 MB / 88.54 | 36.4 MB / **92.81** | −26% |

Storage drops 21-33 percent everywhere. The hard clip's AV1 halves, which was the presenting
problem. The H.264 copy drops by about half on ordinary clips and gains 4.3 VMAF on the hard
one, which matters more than it looks — see below.

**Do not tune the H.264 copy as an afterthought.** `og:video` on the player page points at it,
so Discord's inline player streams H.264 to every viewer in the server and never touches the
AV1 file. Confirmed 2026-09-11 from a live embed object:

```json
"video": { "url": ".../clips/<id>/h264",
           "proxy_url": "https://images-ext-1.discordapp.net/external/.../h264" }
```

So the H.264 copy is the hot path and the AV1 is the archive. The old preset had this backwards:
a bitrate target that wasted bits on easy clips (7.7 MB where AV1 needed 3.1 MB for a better
score) and starved on hard ones.

A related trap: **do not shrink clips to fit Discord's 10 MB attachment limit.** The bare-link
path already gets a native inline player at full quality with no size cap (see the discord-bot
skill), so trading quality for attachability buys nothing.

**NVENC and QSV are still unmeasured.** This is an AMD machine. Their rows in `av1_args` and
`h264_args` carry numbers inferred from their own 0-51 scales and stay behind `probe_encoders`.
They are also only reachable by choosing the graphics card in Settings, which is not the default.

### cqp is constant quality, so AV1 is not always the smaller file

Measured 2026-09-11 on a 28.3 s 1080p60 Wardogs capture, 71.2 MB at 19.9 Mbps, taken through the
app's own replay buffer — the first real clip to go through the phase 4 automatic path.

| encode | size | bitrate | VMAF |
|---|---|---|---|
| `av1_amf` cqp 95 — what ships | 56.2 MB | 15.78 Mbps | **94.02** |
| `h264_amf` 8M vbr_peak — the fallback | 32.9 MB | 9.13 Mbps | 88.54 |
| `av1_amf` cqp 128 | 28.6 MB | 8.00 Mbps | 88.22 |

**The AV1 file came out 71 percent larger than the H.264 fallback**, the opposite of the 32
percent smaller measured in phase 2. That is not a regression: a hand-run of the exact arguments
from `av1_args()` reproduced the app's output byte for byte (56,199,121), so the preset is being
applied. It is content. cqp asks for a quality and pays whatever the footage costs, while
`h264_amf -rc vbr_peak -b:v 8M -maxrate 12M` targets a bitrate and simply starves on hard
footage — which is what its 88.54 against AV1's 94.02 is showing.

Two things follow, and they are worth knowing before re-tuning anything:

- **Do not read "AV1 is the small one" as an invariant.** It holds on the easy-to-medium footage
  phase 2 measured (a 27 s clip at 5.43 Mbps, a queue screen at 1.6 MB) and inverts on high
  motion. Upload time and stored bytes therefore vary far more per clip than the phase 2 table
  suggests.
- **At equal size AV1's win on this footage is small.** cqp 128 lands at 28.6 MB / 88.22 against
  H.264's 32.9 MB / 88.54: 13 percent smaller for a third of a VMAF point less. The generational
  gain that shows up on easy content is mostly gone here.

Left at cqp 95 on purpose. Capping AV1 (a higher qp, or mixing in `-maxrate`) would trade away
the quality that is the reason for keeping an AV1 copy at all, and one clip is not enough to
re-tune a preset that was chosen against a VMAF curve. If large clips start hurting, the knob to
measure is qp, and it should be measured on several clips of *different* difficulty rather than
on one more.

### Reproducing the measurement

The harness is not committed — it is three scratchpad scripts that shell out to ffmpeg
sequentially (never in parallel: the AMF media engine is one shared resource and concurrent
encodes ruin the timings) and score each output with:

```
ffmpeg -hide_banner -v error -y -i encoded.mp4 -i source.mp4 -lavfi \
  "[0:v]setpts=PTS-STARTPTS,format=yuv420p[dist];[1:v]setpts=PTS-STARTPTS,format=yuv420p[ref];[dist][ref]libvmaf=n_threads=6:n_subsample=3:log_fmt=json:log_path=out.json" \
  -f null -
```

Distorted stream first, reference second. On Windows the `log_path` inside `-lavfi` needs its
backslashes turned into forward slashes and its drive colon escaped, or ffmpeg parses the path
as more filter options (`No option name near '/Users/...'`, then `Error parsing filterchain`).
Escaping the colon through a shell is fiddly enough that the reliable move is to `cd` to the
output directory first and pass a **bare filename** — `log_path=vmaf_av1.json` — which has no
colon to escape. The two `-i` paths are ordinary arguments and need none of this. Read
`pooled_metrics.vmaf.mean` out of the JSON. Before trusting any
number, check that the app's own clip queue is idle — its encodes share the same engine.

## Probe a file

```
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate,bit_rate -of default=nw=1 file.mp4
```

Machine readable: add `-of json`.

## Recap compilation

Normalize each clip first, then concat. Normalizing avoids concat failures from mismatched parameters.

```
ffmpeg -y -i clip.mp4 \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1,fps=60,format=yuv420p" \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
  -c:v h264_amf -b:v 12M -c:a aac -b:a 192k -ar 48000 part_001.mp4
```

Title cards come from `drawtext` on a `color=c=black:s=1920x1080:d=2` source. Then:

```
(for %f in (part_*.mp4) do @echo file '%f') > list.txt
ffmpeg -y -f concat -safe 0 -i list.txt -c copy recap_h264.mp4
```

Encode the final AV1 from `recap_h264.mp4` with the AV1 preset above.

## Process priority on Windows

Spawn ffmpeg with the `BELOW_NORMAL_PRIORITY_CLASS` creation flag (Rust: `std::os::windows::process::CommandExt::creation_flags(0x4000)`) and add `-threads` equal to half the logical cores so a game in the foreground keeps its frame rate.
