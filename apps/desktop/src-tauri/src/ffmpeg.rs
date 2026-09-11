//! ffmpeg and ffprobe invocations: encoder probing, media probing, AV1 and H.264 encodes,
//! thumbnails. Everything runs as a child process at below-normal priority with no console
//! window, and every encode writes to `<dst>.part` first so a crash never leaves a half file
//! that looks finished.
//!
//! The binaries are Tauri sidecars (`bundle.externalBin`), copied next to the app exe as
//! `ffmpeg.exe` / `ffprobe.exe`. `scripts/ensure-ffmpeg.ps1` puts them in place for builds.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::settings::Quality;

/// Resolved ffmpeg and ffprobe executables.
#[derive(Debug, Clone)]
pub struct Binaries {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

/// ffmpeg encoder names chosen by the startup probe, e.g. `av1_amf` / `h264_amf`, or the
/// software fallbacks `libsvtav1` / `libx264`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Encoders {
    pub av1: String,
    pub h264: String,
}

/// What ffprobe reports about a source file.
#[derive(Debug, Clone, Serialize)]
pub struct MediaInfo {
    pub duration_ms: i64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub size: u64,
}

/// Optional cut points in milliseconds. `None` keeps that end of the clip.
#[derive(Debug, Clone, Copy, Default)]
pub struct Trim {
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
}

const SOFTWARE_AV1: &str = "libsvtav1";
const SOFTWARE_H264: &str = "libx264";

/// BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW. A game in the foreground keeps its frame
/// rate and no console flashes up while encoding.
const CREATION_FLAGS: u32 = 0x4000 | 0x0800_0000;

/// Keyframe interval in frames (two seconds at 60 fps) so seeking and trimming stay cheap.
const GOP: &str = "120";

/// Finds the sidecar `ffmpeg.exe` / `ffprobe.exe` next to the running exe, falling back to
/// whatever is on PATH. Errors if neither can be found.
pub fn locate() -> Result<Binaries> {
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        let bins = Binaries {
            ffmpeg: dir.join("ffmpeg.exe"),
            ffprobe: dir.join("ffprobe.exe"),
        };
        if bins.ffmpeg.is_file() && bins.ffprobe.is_file() && works(&bins.ffmpeg) && works(&bins.ffprobe) {
            log::info!("using sidecar ffmpeg in {}", dir.display());
            return Ok(bins);
        }
    }

    let bins = Binaries {
        ffmpeg: PathBuf::from("ffmpeg"),
        ffprobe: PathBuf::from("ffprobe"),
    };
    if works(&bins.ffmpeg) && works(&bins.ffprobe) {
        log::info!("using ffmpeg from PATH");
        return Ok(bins);
    }
    bail!("ffmpeg.exe and ffprobe.exe were found neither next to the app nor on PATH")
}

/// True when `exe -version` can be spawned and exits 0; this is the `where.exe` check that
/// also survives a broken or non-executable file.
fn works(exe: &Path) -> bool {
    command(exe)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// A child process with the priority and window flags every ffmpeg call uses.
fn command(exe: &Path) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(exe);
    cmd.creation_flags(CREATION_FLAGS);
    cmd.stdin(Stdio::null());
    cmd
}

/// Common ffmpeg prefix: quiet, no prompts, overwrite.
fn ffmpeg_command(bins: &Binaries) -> Command {
    let mut cmd = command(&bins.ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-y"]);
    cmd
}

/// Half the logical cores, at least one, for software encoders and decoders.
fn threads() -> String {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    (cores / 2).max(1).to_string()
}

/// Runs the command, returning its output or an error carrying the tail of stderr.
fn run(mut cmd: Command, what: &str) -> Result<Output> {
    log::debug!("{what}: {cmd:?}");
    let output = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("{what}: failed to spawn {:?}", cmd.get_program()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(anyhow!("{}", tail.join("\n")))
            .with_context(|| format!("{what}: ffmpeg exited with {}", output.status));
    }
    Ok(output)
}

/// Runs a two second test encode with each hardware AV1 encoder (nvenc, amf, qsv in that
/// order) and each hardware H.264 encoder, keeping the first that exits 0. Falls back to
/// `libsvtav1` and `libx264`. Slow (several seconds); cache the result in settings.
pub fn probe_encoders(bins: &Binaries) -> Encoders {
    let av1 = first_working(bins, &["av1_nvenc", "av1_amf", "av1_qsv"]).unwrap_or(SOFTWARE_AV1);
    let h264 = first_working(bins, &["h264_nvenc", "h264_amf", "h264_qsv"]).unwrap_or(SOFTWARE_H264);
    log::info!("encoders: av1={av1} h264={h264}");
    Encoders {
        av1: av1.into(),
        h264: h264.into(),
    }
}

/// The encoders to actually use, given what the probe found and which engine the user picked.
///
/// `Gpu` uses the probed hardware encoders; `Cpu` ignores them and encodes in software, which
/// on the measured machine is both smaller and better (see `av1_args`). The replay buffer is
/// unaffected - it has to keep up with a game in real time and is always hardware.
pub fn encoders_for(probed: &Encoders, engine: crate::settings::EncodeEngine) -> Encoders {
    match engine {
        crate::settings::EncodeEngine::Gpu => probed.clone(),
        crate::settings::EncodeEngine::Cpu => Encoders {
            av1: SOFTWARE_AV1.into(),
            h264: SOFTWARE_H264.into(),
        },
    }
}

fn first_working<'a>(bins: &Binaries, candidates: &[&'a str]) -> Option<&'a str> {
    candidates.iter().copied().find(|encoder| {
        let started = Instant::now();
        let mut cmd = ffmpeg_command(bins);
        cmd.args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60", "-t", "2"])
            .args(["-c:v", encoder, "-f", "null", "-"]);
        match run(cmd, &format!("probe {encoder}")) {
            Ok(_) => {
                log::info!("encoder {encoder}: ok ({} ms)", started.elapsed().as_millis());
                true
            }
            Err(e) => {
                log::info!("encoder {encoder}: unavailable ({e:#})");
                false
            }
        }
    })
}

#[derive(Deserialize)]
struct ProbeOutput {
    #[serde(default)]
    format: ProbeFormat,
    #[serde(default)]
    streams: Vec<ProbeStream>,
}

#[derive(Deserialize, Default)]
struct ProbeFormat {
    duration: Option<String>,
    size: Option<String>,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    /// Only the tests assert on codec names; the app trusts the encoder it asked for.
    #[cfg_attr(not(test), allow(dead_code))]
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
}

/// Runs ffprobe and parses its JSON. Shared by the public probe and the tests.
fn probe_raw(bins: &Binaries, src: &Path) -> Result<ProbeOutput> {
    let mut cmd = command(&bins.ffprobe);
    cmd.args(["-v", "error", "-show_entries"])
        .arg("format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate")
        .args(["-of", "json"])
        .arg(src);
    let output = run(cmd, &format!("probe {}", src.display()))?;
    serde_json::from_slice(&output.stdout).with_context(|| format!("probe {}: unparsable ffprobe output", src.display()))
}

/// Duration, dimensions, frame rate and size of a video file through `ffprobe -of json`.
pub fn probe(bins: &Binaries, src: &Path) -> Result<MediaInfo> {
    let parsed = probe_raw(bins, src)?;
    let video = parsed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .with_context(|| format!("probe {}: no video stream", src.display()))?;
    let duration: f64 = parsed
        .format
        .duration
        .as_deref()
        .and_then(|d| d.parse().ok())
        .with_context(|| format!("probe {}: no duration", src.display()))?;
    let size = parsed.format.size.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok(MediaInfo {
        duration_ms: (duration * 1000.0).round() as i64,
        width: video.width.unwrap_or(0),
        height: video.height.unwrap_or(0),
        fps: parse_fraction(video.r_frame_rate.as_deref().unwrap_or("0/1")),
        size,
    })
}

/// `60000/1001` -> 59.94. Also accepts a plain number.
fn parse_fraction(s: &str) -> f64 {
    match s.split_once('/') {
        Some((num, den)) => {
            let num: f64 = num.trim().parse().unwrap_or(0.0);
            let den: f64 = den.trim().parse().unwrap_or(1.0);
            if den == 0.0 {
                0.0
            } else {
                num / den
            }
        }
        None => s.trim().parse().unwrap_or(0.0),
    }
}

fn seconds(ms: i64) -> String {
    format!("{:.3}", ms as f64 / 1000.0)
}

/// Input options: seek before `-i` so unused footage is never decoded.
fn input_args(cmd: &mut Command, src: &Path, trim: Trim) {
    if let Some(start) = trim.start_ms {
        cmd.args(["-ss", &seconds(start)]);
    }
    if let Some(end) = trim.end_ms {
        cmd.args(["-to", &seconds(end)]);
    }
    cmd.arg("-i").arg(src);
}

/// Video encoder settings, measured with `scripts/bench-encoders.mjs`.
///
/// Every software preset here is **capped CRF**: a constant-quality target plus a ceiling the
/// encoder may not exceed. That is not the same as a bitrate target, and the difference is the
/// point. On an ordinary clip the ceiling is never reached, so the file comes out as small as
/// the content allows (a desktop capture lands around 3 MB for 26 s). On high-motion gameplay
/// the ceiling engages and trims the clip instead of letting it balloon to 50 MB. Sizes stay
/// in a band the user can predict without paying for it on every clip.
///
/// Two measured facts drive the numbers, both from a 28 s 1080p60 high-motion capture:
///
/// - **`libsvtav1` is far ahead of `av1_amf`.** At matched size (30.6 MB against 30.8 MB) it
///   scored 93.43 VMAF where AMD's hardware AV1 interpolates to about 89.3 and `h264_amf`
///   managed 88.54. AMD's AV1 is barely better than AMD's own H.264, so hardware AV1 is the
///   fast option, not the good one.
/// - **The ceiling is a safety net, not a size dial.** Clamping is a far worse way to reach a
///   size than simply asking for less quality: at a 5 Mbps cap, crf 34 scored 85.21 at 17.0 MB,
///   while plain crf 46 with no cap at all scored **90.94 at 20.3 MB**. So each level picks its
///   CRF for the quality it wants and sets `-maxrate` high enough that ordinary clips never
///   touch it; only a pathological clip gets clamped.
///
/// Preset 6 is the chosen speed: about 40 s for a 28 s clip. Preset 4 was measured and is
/// worth roughly 2 VMAF *when the ceiling binds* (85.21 against 83.13 at a 5 Mbps cap) and
/// within 0.1 VMAF of preset 6 when it does not. Since the ceilings above are set not to bind,
/// preset 4 would double the encode time to buy almost nothing.
///
/// AMF's quantizer scale is 0-255, not the 0-51 that H.264-style encoders use: `-qp_i 28`
/// there asks for near-lossless, which is how AV1 once came out twice the size of the H.264
/// copy. NVENC's `-cq` and QSV's `-global_quality` really are 0-51. **Neither NVENC nor QSV
/// has ever been measured** - this is an AMD machine - so their rows carry numbers inferred
/// from their own scales and stay behind `probe_encoders`.
fn av1_args(encoder: &str, quality: Quality) -> Vec<&'static str> {
    // (crf, ceiling, buffer) for libsvtav1; the hardware rows carry their own quantizers.
    match encoder {
        "av1_amf" => match quality {
            // Hardware AMF has no usable capped mode: `-rc qvbr` measured *below* the plain
            // cqp curve (86.82 at 31 MB against cqp 128's 88.22 at 27 MB), so this is
            // constant quantizer and genuinely uncapped. Choosing the GPU means giving up the
            // size ceiling, which is why the CPU is the default.
            Quality::Small => vec!["-quality", "quality", "-rc", "cqp", "-qp_i", "128", "-qp_p", "128"],
            Quality::Balanced => vec!["-quality", "quality", "-rc", "cqp", "-qp_i", "110", "-qp_p", "110"],
            Quality::High => vec!["-quality", "quality", "-rc", "cqp", "-qp_i", "95", "-qp_p", "95"],
        },
        "av1_nvenc" => match quality {
            Quality::Small => vec!["-cq", "38", "-preset", "p5", "-maxrate", "6M", "-bufsize", "12M"],
            Quality::Balanced => vec!["-cq", "32", "-preset", "p5", "-maxrate", "10M", "-bufsize", "20M"],
            Quality::High => vec!["-cq", "28", "-preset", "p5", "-maxrate", "16M", "-bufsize", "32M"],
        },
        "av1_qsv" => match quality {
            Quality::Small => vec!["-global_quality", "38", "-maxrate", "6M", "-bufsize", "12M"],
            Quality::Balanced => vec!["-global_quality", "32", "-maxrate", "10M", "-bufsize", "20M"],
            Quality::High => vec!["-global_quality", "28", "-maxrate", "16M", "-bufsize", "32M"],
        },
        // libsvtav1. `-maxrate` is what turns CRF into capped CRF; SVT reports it as
        // "BRC mode: capped CRF". Do not reach for `-svtav1-params mbr=`, which expects kbps
        // and silently clamps a bytes-per-second value to 100 Mbps, leaving the cap off.
        _ => match quality {
            Quality::Small => vec![
                "-preset", "6", "-crf", "46", "-svtav1-params", "tune=0",
                "-maxrate", "8M", "-bufsize", "16M",
            ],
            Quality::Balanced => vec![
                "-preset", "6", "-crf", "40", "-svtav1-params", "tune=0",
                "-maxrate", "12M", "-bufsize", "24M",
            ],
            Quality::High => vec![
                "-preset", "6", "-crf", "34", "-svtav1-params", "tune=0",
                "-maxrate", "20M", "-bufsize", "40M",
            ],
        },
    }
}

/// The H.264 copy is **not** a fallback that nobody watches. `og:video` on the player page
/// points at it, so Discord's inline player streams H.264 to every viewer in the server and
/// never touches the AV1 file - confirmed from a live embed object, which carries
/// `video.url = .../clips/<id>/h264` behind a discordapp.net proxy. It is the hot copy and it
/// gets a real quality target here, not the starved 8 Mbps bitrate cap it used to carry, which
/// wasted bits on easy clips (7.7 MB where AV1 needed 3.1 MB for a better score) and starved
/// on hard ones (88.54 VMAF).
fn h264_args(encoder: &str, quality: Quality) -> Vec<&'static str> {
    match encoder {
        "h264_amf" => match quality {
            Quality::Small => vec!["-quality", "quality", "-rc", "vbr_peak", "-b:v", "4M", "-maxrate", "6M"],
            Quality::Balanced => vec!["-quality", "quality", "-rc", "vbr_peak", "-b:v", "8M", "-maxrate", "12M"],
            Quality::High => vec!["-quality", "quality", "-rc", "vbr_peak", "-b:v", "14M", "-maxrate", "20M"],
        },
        "h264_nvenc" => match quality {
            Quality::Small => vec!["-preset", "p5", "-rc", "vbr", "-cq", "28", "-b:v", "0", "-maxrate", "6M", "-bufsize", "12M"],
            Quality::Balanced => vec!["-preset", "p5", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-maxrate", "12M", "-bufsize", "24M"],
            Quality::High => vec!["-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-maxrate", "20M", "-bufsize", "40M"],
        },
        "h264_qsv" => match quality {
            Quality::Small => vec!["-global_quality", "28", "-maxrate", "6M", "-bufsize", "12M"],
            Quality::Balanced => vec!["-global_quality", "23", "-maxrate", "12M", "-bufsize", "24M"],
            Quality::High => vec!["-global_quality", "19", "-maxrate", "20M", "-bufsize", "40M"],
        },
        // libx264, capped CRF like the AV1 software path. `medium` rather than `veryfast`:
        // encoding runs after the game exits and the extra seconds buy real quality.
        _ => match quality {
            Quality::Small => vec!["-preset", "medium", "-crf", "26", "-maxrate", "8M", "-bufsize", "16M"],
            Quality::Balanced => vec!["-preset", "medium", "-crf", "22", "-maxrate", "12M", "-bufsize", "24M"],
            Quality::High => vec!["-preset", "medium", "-crf", "19", "-maxrate", "20M", "-bufsize", "40M"],
        },
    }
}

fn is_software(encoder: &str) -> bool {
    !(encoder.ends_with("_amf") || encoder.ends_with("_nvenc") || encoder.ends_with("_qsv"))
}

/// Encodes `src` to `dst` through `<dst>.part`, renaming only on success.
fn encode(
    bins: &Binaries,
    encoder: &str,
    video_args: &[&str],
    audio_args: &[&str],
    src: &Path,
    dst: &Path,
    trim: Trim,
) -> Result<()> {
    let part = part_path(dst);
    let _ = fs::remove_file(&part);
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }

    let mut cmd = ffmpeg_command(bins);
    cmd.args(["-v", "error"]);
    if is_software(encoder) {
        cmd.args(["-threads", &threads()]);
    }
    input_args(&mut cmd, src, trim);
    cmd.args(["-c:v", encoder]).args(video_args).args(["-g", GOP]);
    cmd.args(audio_args);
    cmd.args(["-movflags", "+faststart", "-f", "mp4"]).arg(&part);

    let started = Instant::now();
    let result = run(cmd, &format!("encode {encoder} {}", src.display()));
    if let Err(e) = result {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    fs::rename(&part, dst).with_context(|| format!("rename {} to {}", part.display(), dst.display()))?;
    log::info!(
        "encoded {} with {encoder} in {:.1} s",
        dst.display(),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

fn part_path(dst: &Path) -> PathBuf {
    let mut name = dst.as_os_str().to_os_string();
    name.push(".part");
    PathBuf::from(name)
}

/// AV1 in MP4 with Opus audio, at the user's chosen quality. Keyframe every two seconds.
pub fn encode_av1(
    bins: &Binaries,
    encoder: &str,
    quality: Quality,
    src: &Path,
    dst: &Path,
    trim: Trim,
) -> Result<()> {
    encode(
        bins,
        encoder,
        &av1_args(encoder, quality),
        &["-c:a", "libopus", "-b:a", "128k"],
        src,
        dst,
        trim,
    )
}

/// H.264 in MP4 with AAC audio: the copy Discord's inline player actually streams, and the
/// one old devices fall back to. See `h264_args` for why it is not the afterthought its name
/// suggests.
pub fn encode_h264(
    bins: &Binaries,
    encoder: &str,
    quality: Quality,
    src: &Path,
    dst: &Path,
    trim: Trim,
) -> Result<()> {
    encode(
        bins,
        encoder,
        &h264_args(encoder, quality),
        &["-c:a", "aac", "-b:a", "160k"],
        src,
        dst,
        trim,
    )
}

/// Single JPEG frame at `at_ms`, 640 pixels wide.
pub fn thumbnail(bins: &Binaries, src: &Path, dst: &Path, at_ms: i64) -> Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let mut cmd = ffmpeg_command(bins);
    cmd.args(["-v", "error", "-ss", &seconds(at_ms.max(0))])
        .arg("-i")
        .arg(src)
        .args(["-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", "-f", "image2"])
        .arg(dst);
    run(cmd, &format!("thumbnail {}", src.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bins() -> Binaries {
        locate().expect("ffmpeg and ffprobe must be reachable for these tests")
    }

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cos-nostra-ffmpeg-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 3 s 1280x720 60 fps test pattern with a sine tone, encoded with libx264 so any build
    /// can decode it.
    fn sample(bins: &Binaries, dir: &Path) -> PathBuf {
        let src = dir.join("sample.mp4");
        let mut cmd = ffmpeg_command(bins);
        cmd.args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60"])
            .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"])
            .args(["-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"])
            .args(["-c:a", "aac", "-b:a", "96k"])
            .arg(&src);
        run(cmd, "sample").unwrap();
        src
    }

    fn codecs(bins: &Binaries, path: &Path) -> (String, String) {
        let parsed = probe_raw(bins, path).unwrap();
        let by_type = |t: &str| {
            parsed
                .streams
                .iter()
                .find(|s| s.codec_type.as_deref() == Some(t))
                .and_then(|s| s.codec_name.clone())
                .unwrap_or_default()
        };
        (by_type("video"), by_type("audio"))
    }

    #[test]
    fn parses_fractions() {
        assert_eq!(parse_fraction("60/1"), 60.0);
        assert!((parse_fraction("60000/1001") - 59.94).abs() < 0.01);
        assert_eq!(parse_fraction("0/0"), 0.0);
        assert_eq!(parse_fraction("30"), 30.0);
        assert_eq!(seconds(500), "0.500");
        assert_eq!(seconds(2500), "2.500");
        assert_eq!(part_path(Path::new("C:/x/clip.mp4")), PathBuf::from("C:/x/clip.mp4.part"));
    }

    #[test]
    fn end_to_end() {
        let _ = env_logger::builder().is_test(true).try_init();
        let bins = bins();
        println!("binaries: {bins:?}");
        let dir = tmp_dir();
        let src = sample(&bins, &dir);

        let info = probe(&bins, &src).unwrap();
        println!("probe: {info:?}");
        assert!((info.duration_ms - 3000).abs() <= 100, "duration {}", info.duration_ms);
        assert_eq!((info.width, info.height), (1280, 720));
        assert!((info.fps - 60.0).abs() < 0.01);
        assert!(info.size > 0);

        let started = Instant::now();
        let encoders = probe_encoders(&bins);
        println!("probe_encoders: {encoders:?} in {:.1} s", started.elapsed().as_secs_f64());

        let trim = Trim {
            start_ms: Some(500),
            end_ms: Some(2500),
        };

        let av1 = dir.join("out_av1.mp4");
        let started = Instant::now();
        encode_av1(&bins, &encoders.av1, Quality::Balanced, &src, &av1, trim).unwrap();
        let av1_info = probe(&bins, &av1).unwrap();
        println!(
            "av1 ({}): {:.1} s, {} bytes, {:?}",
            encoders.av1,
            started.elapsed().as_secs_f64(),
            av1_info.size,
            av1_info
        );
        assert!(!part_path(&av1).exists());
        assert_eq!(codecs(&bins, &av1), ("av1".to_string(), "opus".to_string()));
        assert!((av1_info.duration_ms - 2000).abs() <= 100, "av1 duration {}", av1_info.duration_ms);
        assert_eq!((av1_info.width, av1_info.height), (1280, 720));

        let h264 = dir.join("out_h264.mp4");
        let started = Instant::now();
        encode_h264(&bins, &encoders.h264, Quality::Balanced, &src, &h264, trim).unwrap();
        let h264_info = probe(&bins, &h264).unwrap();
        println!(
            "h264 ({}): {:.1} s, {} bytes, {:?}",
            encoders.h264,
            started.elapsed().as_secs_f64(),
            h264_info.size,
            h264_info
        );
        assert!(!part_path(&h264).exists());
        assert_eq!(codecs(&bins, &h264), ("h264".to_string(), "aac".to_string()));
        assert!((h264_info.duration_ms - 2000).abs() <= 100, "h264 duration {}", h264_info.duration_ms);

        let thumb = dir.join("thumb.jpg");
        thumbnail(&bins, &src, &thumb, 750).unwrap();
        let thumb_len = fs::metadata(&thumb).unwrap().len();
        println!("thumbnail: {thumb_len} bytes");
        assert!(thumb_len > 1024);

        // A bad encoder name fails cleanly and leaves no .part behind.
        let bad = dir.join("bad.mp4");
        let err = encode_av1(&bins, "no_such_encoder", Quality::Balanced, &src, &bad, Trim::default()).unwrap_err();
        println!("expected failure: {err:#}");
        assert!(!bad.exists() && !part_path(&bad).exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
