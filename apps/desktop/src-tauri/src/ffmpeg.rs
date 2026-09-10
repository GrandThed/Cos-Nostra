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

/// Video encoder settings from the `video-encoding` skill presets.
///
/// AMF's quantizer scale is 0-255, not the 0-51 that H.264-style encoders use. `-qp_i 28`
/// there was asking for near-lossless AV1, which is why AV1 came out roughly twice the size
/// of the H.264 fallback on real gameplay (53 MB against 27 MB for the same 27 s clip). 95
/// is the measured point that matches the H.264 preset's quality at about a third less size;
/// the numbers and the method are in the skill. NVENC's `-cq` and QSV's `-global_quality`
/// really are 0-51 scales, so 28 is right there and stays; neither could be measured on this
/// AMD dev machine, and both stay behind `probe_encoders`.
fn av1_args(encoder: &str) -> Vec<&'static str> {
    match encoder {
        "av1_amf" => vec!["-quality", "quality", "-rc", "cqp", "-qp_i", "95", "-qp_p", "95"],
        "av1_nvenc" => vec!["-cq", "28", "-preset", "p5"],
        "av1_qsv" => vec!["-global_quality", "28"],
        _ => vec!["-preset", "8", "-crf", "34", "-svtav1-params", "tune=0"],
    }
}

fn h264_args(encoder: &str) -> Vec<&'static str> {
    match encoder {
        "h264_amf" => vec!["-quality", "quality", "-rc", "vbr_peak", "-b:v", "8M", "-maxrate", "12M"],
        "h264_nvenc" => vec!["-preset", "p5", "-rc", "vbr", "-b:v", "8M", "-maxrate", "12M"],
        "h264_qsv" => vec!["-b:v", "8M", "-maxrate", "12M"],
        _ => vec!["-preset", "veryfast", "-crf", "23"],
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

/// AV1 in MP4 with Opus audio. Hardware encoders use constant quality (AMF QP 95 on its
/// 0-255 scale, NVENC/QSV 28 on their 0-51 scales), software uses `libsvtav1 -preset 8
/// -crf 34`. Keyframe every two seconds.
pub fn encode_av1(bins: &Binaries, encoder: &str, src: &Path, dst: &Path, trim: Trim) -> Result<()> {
    encode(
        bins,
        encoder,
        &av1_args(encoder),
        &["-c:a", "libopus", "-b:a", "128k"],
        src,
        dst,
        trim,
    )
}

/// H.264 in MP4 with AAC audio at about 8 Mbps, for Discord attachments and old devices.
pub fn encode_h264(bins: &Binaries, encoder: &str, src: &Path, dst: &Path, trim: Trim) -> Result<()> {
    encode(
        bins,
        encoder,
        &h264_args(encoder),
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
        encode_av1(&bins, &encoders.av1, &src, &av1, trim).unwrap();
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
        encode_h264(&bins, &encoders.h264, &src, &h264, trim).unwrap();
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
        let err = encode_av1(&bins, "no_such_encoder", &src, &bad, Trim::default()).unwrap_err();
        println!("expected failure: {err:#}");
        assert!(!bad.exists() && !part_path(&bad).exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
