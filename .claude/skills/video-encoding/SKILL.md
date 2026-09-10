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

## Presets

Measured on the dev machine (RX 9060 XT, Ryzen 5 5500) on a 28 s 1080p60 clip: `av1_amf` 7 s, `libsvtav1 -preset 8` 13 s.

AV1, hardware (AMF shown; NVENC uses `-cq 28 -preset p5`, QSV uses `-global_quality 28`):

```
ffmpeg -y -ss <in> -to <out> -i src.mp4 \
  -c:v av1_amf -quality quality -rc cqp -qp_i 28 -qp_p 28 -g 120 \
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
