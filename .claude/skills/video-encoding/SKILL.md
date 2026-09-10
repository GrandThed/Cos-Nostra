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
as more filter options. Read `pooled_metrics.vmaf.mean` out of the JSON. Before trusting any
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
